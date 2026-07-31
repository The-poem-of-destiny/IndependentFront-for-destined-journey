/**
 * combat-stress-test.ts — 战斗系统真机压力测试（DeepSeek 驱动）
 *
 * 用法:
 *   DEEPSEEK_API_KEY=sk-xxx npx tsx scripts/combat-stress-test.ts [并发数] [场景过滤前缀]
 *
 * 设计:
 *  - 全真链路: runCombat → executeCombatToolCall → resolveAttackPipeline（不 mock 任何引擎代码）
 *  - 唯一替换点: CombatClient 直连 DeepSeek /chat/completions（AgentClient 走浏览器 BFF 代理，Node 不可用；
 *    runner 的 CombatClient 本就是为此抽象的注入点）
 *  - 每场战斗输出 tmp/stress/<ts>/combat-<id>.json（完整事件流+工具调用史+指标+不变量检查）
 *  - 密钥只从环境变量读取，不落盘
 *
 * 指标: LLM 调用数/时延/token、工具调用分布、工具错误（行动经济拦截/寻址失败/未知工具）、
 *      回合数、胜负、摘要有无、引擎不变量（delta_hp≤0 / HP∈[0,max] / 骰值∈[1,20]）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runCombat } from '../src/sillytavern/combat-runner';
import type {
  CombatClient,
  CombatClientResult,
  CombatRunDeps,
  CombatEvent,
} from '../src/sillytavern/combat-runner';
import { EventBus } from '../src/sillytavern/game-event';
import { COMBAT_MOD_EVENTS } from '../src/sillytavern/modifier-collector';
import type {
  ApiEndpoint,
  AgentConfig,
  AgentContext,
  CharacterState,
  StatePatch,
  CombatTriggerMarker,
} from '../src/sillytavern/types';
import { calcResources } from '../src/sillytavern/tier-constants';

// ═══════════════════ 配置 ═══════════════════

const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
const CONCURRENCY = Number(process.argv[2] ?? 3);
const SCENARIO_FILTER = process.argv[3] ?? '';
/** 场景集: base=S01-S10 主矩阵 / directed=S11-S16 定向机制场景(§6.4) */
const SCENARIO_SET = process.env.STRESS_SET ?? 'base';
/** 场景矩阵重复次数（规模压测用: STRESS_REPEAT=3 → 10 场景 ×3 = 30 场,每份独立角色对象） */
const REPEAT = Math.max(1, Number(process.env.STRESS_REPEAT ?? 1));

/** 单场战斗预算（防失控烧钱/挂死） */
const MAX_LLM_CALLS_PER_COMBAT = 120;
const MAX_WALL_MS_PER_COMBAT = 12 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 150_000;

if (!API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY 环境变量');
  process.exit(1);
}

const OUT_DIR = path.join('tmp', 'stress', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(OUT_DIR, { recursive: true });

// ═══════════════════ DeepSeek 直连 CombatClient ═══════════════════

interface ClientMetrics {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens: number;
  latenciesMs: number[];
  retries: number;
  httpErrors: string[];
  toolHistory: Array<{
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }>;
  budgetExceeded: boolean;
}

class BudgetExceededError extends Error {}

function makeDeepSeekClient(metrics: ClientMetrics, combatStartMs: number): CombatClient {
  async function callApi(body: Record<string, unknown>): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        metrics.retries++;
        await new Promise((r) => setTimeout(r, [2000, 5000, 12000][attempt - 1] ?? 12000));
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        clearTimeout(timer);
        if (res.status === 429 || res.status >= 500) {
          const text = await res.text();
          metrics.httpErrors.push(`HTTP ${res.status}: ${text.slice(0, 200)}`);
          lastErr = new Error(`HTTP ${res.status}`);
          continue; // 重试
        }
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        const json = await res.json();
        metrics.latenciesMs.push(Date.now() - t0); // 含响应体下载的完整时延
        return json;
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof Error && e.name === 'AbortError') {
          metrics.httpErrors.push(`timeout@${REQUEST_TIMEOUT_MS}ms`);
          lastErr = e;
          continue; // 超时重试
        }
        // undici 网络层错误（TypeError: terminated / fetch failed / ECONNRESET）同样可重试
        // —— 2026-07-31 复跑 S01 因 "TypeError: terminated" 绕过重试直接死场，此为修复
        if (e instanceof TypeError) {
          metrics.httpErrors.push(
            `network: ${e.message}${(e as { cause?: unknown }).cause ? ` (${String((e as { cause?: { message?: string } }).cause?.message ?? (e as { cause?: unknown }).cause)})` : ''}`,
          );
          lastErr = e;
          continue; // 网络错误重试
        }
        throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  const chatWithTools: NonNullable<CombatClient['chatWithTools']> = async (
    request,
    toolExecutor,
    options,
  ) => {
    const maxRounds = options?.maxRounds ?? 5;
    const conversation: Array<Record<string, unknown>> = request.messages.map((m) => ({ ...m }));
    const t0 = Date.now();
    let totalTokens = 0;

    for (let round = 0; round < maxRounds; round++) {
      // 预算护栏
      if (metrics.llmCalls >= MAX_LLM_CALLS_PER_COMBAT) {
        metrics.budgetExceeded = true;
        throw new BudgetExceededError(`LLM 调用数超过 ${MAX_LLM_CALLS_PER_COMBAT}`);
      }
      if (Date.now() - combatStartMs > MAX_WALL_MS_PER_COMBAT) {
        metrics.budgetExceeded = true;
        throw new BudgetExceededError(`单场战斗超过 ${MAX_WALL_MS_PER_COMBAT / 1000}s`);
      }

      metrics.llmCalls++;
      const data = await callApi({
        model: MODEL,
        messages: conversation,
        tools: request.tools,
        tool_choice: request.tool_choice ?? 'auto',
        temperature: 0.7,
        max_tokens: 2400,
      });

      const usage = data.usage ?? {};
      totalTokens += usage.total_tokens ?? 0;
      metrics.promptTokens += usage.prompt_tokens ?? 0;
      metrics.completionTokens += usage.completion_tokens ?? 0;
      metrics.reasoningTokens += usage.completion_tokens_details?.reasoning_tokens ?? 0;
      metrics.cacheHitTokens += usage.prompt_cache_hit_tokens ?? 0;

      const msg = data.choices?.[0]?.message ?? {};
      const toolCalls: any[] = msg.tool_calls ?? [];

      if (toolCalls.length > 0) {
        conversation.push({
          role: 'assistant',
          content: msg.content ?? '',
          tool_calls: toolCalls.map((tc: any) => ({
            id: tc.id,
            type: tc.type ?? 'function',
            function: { name: tc.function?.name, arguments: tc.function?.arguments },
          })),
        });
        for (const tc of toolCalls) {
          const funcName = tc.function?.name ?? '';
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function?.arguments ?? '{}');
          } catch {
            metrics.toolHistory.push({ name: funcName, args: {}, error: 'ARGS_JSON_PARSE_FAIL' });
          }
          let result: unknown;
          let toolError: string | undefined;
          try {
            result = await toolExecutor(funcName, args);
          } catch (e) {
            if (e instanceof BudgetExceededError) throw e;
            toolError = e instanceof Error ? e.message : String(e);
            result = null;
          }
          // executeCombatToolCall 把错误包在 result.error 里
          const wrappedError = (result as { error?: string } | null)?.error;
          // 审计闭环: 记录工具返回值（roll_* 的骰面 / combat_attack 的结算含 checkValue），超长截断
          let storedResult: unknown;
          try {
            const s = JSON.stringify(result);
            storedResult = s && s.length > 4000 ? { truncated: s.slice(0, 4000) } : result;
          } catch {
            storedResult = String(result);
          }
          metrics.toolHistory.push({
            name: funcName,
            args,
            ...(storedResult !== undefined && storedResult !== null
              ? { result: storedResult }
              : {}),
            ...(toolError || wrappedError ? { error: toolError ?? wrappedError } : {}),
          });
          conversation.push({
            role: 'tool',
            tool_call_id: tc.id ?? '',
            content: JSON.stringify(toolError ? { error: toolError } : result),
          });
        }
        continue;
      }

      // 最终文本
      return {
        output: msg.content ?? '',
        rawResponse: msg.content ?? '',
        tokensUsed: totalTokens,
        cacheHit: (usage.prompt_cache_hit_tokens ?? 0) > 0,
        duration: Date.now() - t0,
      } satisfies CombatClientResult;
    }
    return {
      output: '',
      rawResponse: '',
      tokensUsed: totalTokens,
      cacheHit: false,
      duration: Date.now() - t0,
      error: `超过最大工具轮数 ${maxRounds}`,
    } satisfies CombatClientResult;
  };

  return {
    chatWithTools,
    chat: async (messages) => {
      const data = await callApi({ model: MODEL, messages, max_tokens: 1500 });
      const msg = data.choices?.[0]?.message ?? {};
      return {
        output: msg.content ?? '',
        rawResponse: msg.content ?? '',
        tokensUsed: data.usage?.total_tokens ?? 0,
        cacheHit: false,
        duration: 0,
      };
    },
  };
}

// ═══════════════════ 角色工厂 ═══════════════════

let charSeq = 0;
/** hpRatio: 初始 HP 占 maxHp 比例（受伤入场场景用）。资源一律用引擎公式 calcResources 推演。 */
function makeCharacter(p: Partial<CharacterState> & { name: string }, hpRatio = 1): CharacterState {
  charSeq++;
  const tier = p.tier ?? 2;
  const attrs = p.attributes ?? { str: 12, dex: 12, con: 12, int: 10, spi: 10 };
  const res = calcResources(tier, attrs);
  return {
    id: `stress_char_${charSeq}`,
    saveId: 'stress_save',
    type: 'npc',
    race: '智人种',
    identity: [],
    occupation: ['战士'],
    tierName: '中坚',
    level: 8,
    totalExp: 0,
    expToNext: 100,
    freeAttrPoints: 0,
    ascension: {
      enabled: false,
      elements: [],
      authority: [],
      law: [],
      deityPosition: '',
      divineKingdom: { name: '', description: '' },
    },
    skills: [],
    inventory: [],
    statusEffects: [],
    money: 100,
    location: '压测竞技场',
    ...p,
    tier,
    attributes: attrs,
    hp: Math.floor(res.maxHp * hpRatio),
    maxHp: res.maxHp,
    mp: res.maxMp,
    maxMp: res.maxMp,
    sp: res.maxSp,
    maxSp: res.maxSp,
  } as CharacterState;
}

function weapon(name: string, atk: number, hit = 2, penetration = 0) {
  return {
    name,
    quantity: 1,
    type: '武器',
    rarity: '优良',
    description: '压测武器',
    equippedSlot: '武器',
    stats: { atk, hit, penetration },
  } as CharacterState['inventory'][number];
}
function armor(name: string, defense: number, dodge = 1, dr = 0) {
  return {
    name,
    quantity: 1,
    type: '防具',
    rarity: '优良',
    description: '压测防具',
    equippedSlot: '身体',
    stats: { defense, dodge, dr },
  } as CharacterState['inventory'][number];
}

// ═══════════════════ 场景矩阵 ═══════════════════

interface Scenario {
  id: string;
  combatType: string;
  environment: string;
  body: string;
  characters: CharacterState[];
  allies: string[];
  enemies: string[];
  /** 定向场景: 玩家指令脚本 —— 提供时 harness 注册 registerSubmitter,awaiting_player_input 时依次提交(耗尽后循环最后一条) */
  playerScript?: string[];
  /** 定向场景: 战斗开始前注入(登神 modifier 的 subscribeChain 声明 / clusterCount 标记等) */
  preRun?: (bus: EventBus, characters: CharacterState[]) => void;
}

function buildScenarios(): Scenario[] {
  return [
    {
      id: 'S01-标准1v1均势',
      combatType: '标准',
      environment: '荒野驿道',
      body: '游侠罗兰遭遇拦路的佣兵刀疤，双方拔刃对峙。',
      characters: [
        makeCharacter({
          name: '罗兰',
          type: 'player',
          tier: 2,
          level: 9,
          hp: 320,
          maxHp: 320,
          attributes: { str: 14, dex: 13, con: 12, int: 10, spi: 10 },
          inventory: [weapon('精钢长剑', 40), armor('皮甲', 120, 2)],
        }),
        makeCharacter({
          name: '刀疤',
          tier: 2,
          level: 8,
          hp: 300,
          maxHp: 300,
          attributes: { str: 13, dex: 12, con: 13, int: 8, spi: 8 },
          inventory: [weapon('弯刀', 35), armor('链甲', 150, 1)],
        }),
      ],
      allies: ['罗兰'],
      enemies: ['刀疤'],
    },
    {
      id: 'S02-死斗低阈值战意',
      combatType: '死斗',
      environment: '地下角斗场',
      body: '角斗士卡恩与亡命徒黑牙的生死斗，不死不休。',
      characters: [
        makeCharacter({
          name: '卡恩',
          type: 'player',
          tier: 3,
          level: 12,
          hp: 500,
          maxHp: 500,
          attributes: { str: 16, dex: 12, con: 15, int: 9, spi: 11 },
          inventory: [weapon('巨剑', 60, 3), armor('板甲', 300, 0, 0.1)],
        }),
        makeCharacter({
          name: '黑牙',
          tier: 2,
          level: 10,
          hp: 350,
          maxHp: 350,
          attributes: { str: 14, dex: 14, con: 12, int: 9, spi: 8 },
          inventory: [weapon('双匕首', 30, 4), armor('轻甲', 100, 3)],
        }),
      ],
      allies: ['卡恩'],
      enemies: ['黑牙'],
    },
    {
      id: 'S03-切磋非致死',
      combatType: '切磋',
      environment: '骑士团演武场',
      body: '见习骑士艾拉与教官塞巴斯的切磋考核，点到为止，务必活捉式收场不得杀伤。',
      characters: [
        makeCharacter({
          name: '艾拉',
          type: 'player',
          tier: 1,
          level: 5,
          hp: 200,
          maxHp: 200,
          attributes: { str: 11, dex: 12, con: 10, int: 10, spi: 10 },
          inventory: [weapon('训练剑', 20), armor('训练甲', 80, 2)],
        }),
        makeCharacter({
          name: '塞巴斯',
          tier: 2,
          level: 10,
          hp: 350,
          maxHp: 350,
          attributes: { str: 14, dex: 13, con: 13, int: 12, spi: 12 },
          inventory: [weapon('骑士剑', 35, 3), armor('骑士铠', 200, 2, 0.05)],
        }),
      ],
      allies: ['艾拉'],
      enemies: ['塞巴斯'],
    },
    {
      id: 'S04-压制跨层级优势',
      combatType: '压制',
      environment: '废弃教堂',
      body: '高阶猎魔人薇拉压制性讨伐两只低阶食尸鬼，层级差悬殊。',
      characters: [
        makeCharacter({
          name: '薇拉',
          type: 'player',
          tier: 4,
          level: 16,
          hp: 800,
          maxHp: 800,
          attributes: { str: 17, dex: 16, con: 15, int: 13, spi: 14 },
          inventory: [weapon('银月大剑', 90, 5, 0.2), armor('猎魔皮铠', 350, 3, 0.15)],
        }),
        makeCharacter({
          name: '食尸鬼甲',
          tier: 1,
          level: 4,
          hp: 150,
          maxHp: 150,
          attributes: { str: 10, dex: 9, con: 8, int: 3, spi: 3 },
          inventory: [weapon('利爪', 15)],
        }),
        makeCharacter({
          name: '食尸鬼乙',
          tier: 1,
          level: 4,
          hp: 150,
          maxHp: 150,
          attributes: { str: 10, dex: 9, con: 8, int: 3, spi: 3 },
          inventory: [weapon('利爪', 15)],
        }),
      ],
      allies: ['薇拉'],
      enemies: ['食尸鬼甲', '食尸鬼乙'],
    },
    {
      id: 'S05-标准2v2法系',
      combatType: '标准',
      environment: '雪原隘口',
      body: '火法师琳与剑士杜克，对阵冰霜女巫萨莎与雇佣兵岩石。琳的火焰术走能量伤害，萨莎精神攻击。',
      characters: [
        makeCharacter({
          name: '琳',
          type: 'player',
          tier: 3,
          level: 12,
          hp: 380,
          maxHp: 380,
          mp: 300,
          maxMp: 300,
          attributes: { str: 8, dex: 11, con: 10, int: 17, spi: 14 },
          occupation: ['法师'],
          inventory: [weapon('火焰法杖', 50, 2), armor('法袍', 90, 2)],
        }),
        makeCharacter({
          name: '杜克',
          tier: 2,
          level: 10,
          hp: 400,
          maxHp: 400,
          attributes: { str: 15, dex: 12, con: 14, int: 9, spi: 9 },
          inventory: [weapon('阔剑', 45, 2), armor('半身板甲', 220, 1, 0.08)],
        }),
        makeCharacter({
          name: '萨莎',
          tier: 3,
          level: 11,
          hp: 360,
          maxHp: 360,
          mp: 280,
          maxMp: 280,
          attributes: { str: 8, dex: 12, con: 10, int: 15, spi: 16 },
          occupation: ['女巫'],
          inventory: [weapon('冰晶杖', 45, 2), armor('霜纹袍', 100, 2)],
        }),
        makeCharacter({
          name: '岩石',
          tier: 2,
          level: 9,
          hp: 450,
          maxHp: 450,
          attributes: { str: 16, dex: 9, con: 16, int: 7, spi: 7 },
          inventory: [weapon('战锤', 50), armor('重甲', 280, 0, 0.1)],
        }),
      ],
      allies: ['琳', '杜克'],
      enemies: ['萨莎', '岩石'],
    },
    {
      id: 'S06-守卫劣势逃跑',
      combatType: '守卫',
      environment: '商队营地',
      body: '受伤的斥候皮特守卫营地，遭遇两名强悍的掠夺者，实力悬殊，活下去比获胜更重要。',
      characters: [
        makeCharacter(
          {
            name: '皮特',
            type: 'player',
            tier: 1,
            level: 6,
            attributes: { str: 10, dex: 14, con: 9, int: 11, spi: 10 },
            inventory: [weapon('短弓', 22, 3), armor('布甲', 60, 3)],
          },
          0.4,
        ),
        makeCharacter({
          name: '掠夺者头目',
          tier: 3,
          level: 12,
          hp: 520,
          maxHp: 520,
          attributes: { str: 16, dex: 12, con: 15, int: 9, spi: 8 },
          inventory: [weapon('斩马刀', 65, 3), armor('拼接重甲', 260, 1, 0.1)],
        }),
        makeCharacter({
          name: '掠夺者打手',
          tier: 2,
          level: 9,
          hp: 380,
          maxHp: 380,
          attributes: { str: 14, dex: 11, con: 13, int: 7, spi: 7 },
          inventory: [weapon('钉锤', 40), armor('皮甲', 110, 2)],
        }),
      ],
      allies: ['皮特'],
      enemies: ['掠夺者头目', '掠夺者打手'],
    },
    {
      id: 'S07-竞技高阈值战意',
      combatType: '竞技',
      environment: '王都竞技场',
      body: '竞技场排位赛：决斗家赛琳娜对阵斗兽人格罗姆，胜负分明即止。',
      characters: [
        makeCharacter({
          name: '赛琳娜',
          type: 'player',
          tier: 3,
          level: 13,
          hp: 420,
          maxHp: 420,
          attributes: { str: 13, dex: 17, con: 12, int: 12, spi: 13 },
          inventory: [weapon('细剑', 48, 5, 0.1), armor('决斗服', 130, 4)],
        }),
        makeCharacter({
          name: '格罗姆',
          tier: 3,
          level: 12,
          hp: 550,
          maxHp: 550,
          attributes: { str: 17, dex: 10, con: 16, int: 7, spi: 8 },
          inventory: [weapon('双头斧', 70, 1), armor('兽皮重铠', 240, 0, 0.12)],
        }),
      ],
      allies: ['赛琳娜'],
      enemies: ['格罗姆'],
    },
    {
      id: 'S08-标准2v3小怪群',
      combatType: '标准',
      environment: '林间小径',
      body: '冒险者双人组（重装战士布鲁诺 + 牧师米拉）遭遇三只哥布林伏击。',
      characters: [
        makeCharacter({
          name: '布鲁诺',
          type: 'player',
          tier: 2,
          level: 10,
          hp: 450,
          maxHp: 450,
          attributes: { str: 15, dex: 10, con: 15, int: 8, spi: 9 },
          inventory: [weapon('塔盾剑', 42), armor('全身板甲', 320, 0, 0.12)],
        }),
        makeCharacter({
          name: '米拉',
          tier: 2,
          level: 9,
          hp: 280,
          maxHp: 280,
          mp: 250,
          maxMp: 250,
          attributes: { str: 8, dex: 10, con: 9, int: 13, spi: 16 },
          occupation: ['牧师'],
          inventory: [weapon('祝福权杖', 30, 2), armor('圣职袍', 80, 2)],
        }),
        makeCharacter({
          name: '哥布林斥候',
          tier: 1,
          level: 3,
          hp: 100,
          maxHp: 100,
          attributes: { str: 8, dex: 12, con: 7, int: 5, spi: 4 },
          inventory: [weapon('石矛', 12, 2)],
        }),
        makeCharacter({
          name: '哥布林战士',
          tier: 1,
          level: 4,
          hp: 130,
          maxHp: 130,
          attributes: { str: 10, dex: 9, con: 9, int: 4, spi: 4 },
          inventory: [weapon('缺口弯刀', 15), armor('破皮甲', 40)],
        }),
        makeCharacter({
          name: '哥布林萨满',
          tier: 1,
          level: 5,
          hp: 110,
          maxHp: 110,
          mp: 120,
          maxMp: 120,
          attributes: { str: 6, dex: 8, con: 7, int: 11, spi: 12 },
          inventory: [weapon('骨杖', 18)],
        }),
      ],
      allies: ['布鲁诺', '米拉'],
      enemies: ['哥布林斥候', '哥布林战士', '哥布林萨满'],
    },
    {
      id: 'S09-死斗跨层级劣势',
      combatType: '死斗',
      environment: '龙巢边缘',
      body: '孤胆猎人格雷戈误入幼龙领地，被迫与远超自身层级的幼龙血牙死战。',
      characters: [
        makeCharacter({
          name: '格雷戈',
          type: 'player',
          tier: 2,
          level: 10,
          hp: 380,
          maxHp: 380,
          attributes: { str: 13, dex: 14, con: 13, int: 11, spi: 10 },
          inventory: [weapon('猎龙矛', 48, 3, 0.15), armor('鳞甲', 180, 2, 0.05)],
        }),
        makeCharacter({
          name: '血牙',
          race: '巨龙',
          type: 'monster',
          tier: 4,
          level: 15,
          hp: 900,
          maxHp: 900,
          attributes: { str: 18, dex: 13, con: 18, int: 9, spi: 10 },
          inventory: [weapon('龙爪龙息', 85, 3), armor('龙鳞', 400, 1, 0.2)],
        }),
      ],
      allies: ['格雷戈'],
      enemies: ['血牙'],
    },
    {
      id: 'S10-标准活捉任务',
      combatType: '标准',
      environment: '港口仓库',
      body: '赏金猎人露娜奉命活捉走私头目维托——委托方明确要求：打晕带回，留活口，绝不能杀死他。',
      characters: [
        makeCharacter({
          name: '露娜',
          type: 'player',
          tier: 3,
          level: 12,
          hp: 430,
          maxHp: 430,
          attributes: { str: 12, dex: 16, con: 12, int: 13, spi: 12 },
          inventory: [weapon('镇压警棍', 45, 4), armor('潜行皮衣', 140, 4)],
        }),
        makeCharacter({
          name: '维托',
          tier: 2,
          level: 9,
          hp: 300,
          maxHp: 300,
          attributes: { str: 12, dex: 12, con: 11, int: 13, spi: 9 },
          inventory: [weapon('袖剑', 28, 3), armor('绸衫软甲', 90, 2)],
        }),
      ],
      allies: ['露娜'],
      enemies: ['维托'],
    },
  ];
}

// ═══════════════════ 定向场景矩阵(§6.4: 上轮未覆盖机制) ═══════════════════

function buildDirectedScenarios(): Scenario[] {
  return [
    {
      // DoT 流: 上轮 status_apply 0 次调用 —— body 强引导毒/流血状态施加
      id: 'S11-DoT淬毒暗杀',
      combatType: '标准',
      environment: '雨夜小巷',
      body: '毒刃刺客薇诺娜伏击佣兵队长布洛克。薇诺娜的双短刃淬有蚀骨蛇毒——她的战斗流派是:每次命中后必须用 status_apply 为目标施加「中毒」减益状态(sourceKey=淬毒短刃,持续 3 回合),割裂伤口则追加「流血」状态;她靠毒性积累拖垮重甲对手,而非硬拼伤害。',
      characters: [
        makeCharacter({
          name: '薇诺娜',
          type: 'player',
          tier: 3,
          level: 12,
          attributes: { str: 10, dex: 16, con: 11, int: 13, spi: 12 },
          occupation: ['刺客'],
          inventory: [weapon('淬毒短刃', 38, 5), armor('夜行衣', 100, 5)],
        }),
        makeCharacter({
          name: '布洛克',
          tier: 3,
          level: 12,
          attributes: { str: 15, dex: 10, con: 16, int: 9, spi: 10 },
          inventory: [weapon('制式长刀', 50, 2), armor('佣兵重甲', 280, 0, 0.12)],
        }),
      ],
      allies: ['薇诺娜'],
      enemies: ['布洛克'],
    },
    {
      // 集群: clusterCount≥3 的 ×1.5 承伤 + EXP 衰减(结算)
      id: 'S12-集群清剿',
      combatType: '标准',
      environment: '荒废墓园',
      body: '战士布琳与火法师奥托清剿墓园:「骷髅集群」是 8 具骷髅抱团组成的集群单位(范围法术对其格外有效),另有一名骷髅兵长单独压阵。',
      characters: [
        makeCharacter({
          name: '布琳',
          type: 'player',
          tier: 3,
          level: 12,
          attributes: { str: 16, dex: 11, con: 14, int: 9, spi: 10 },
          inventory: [weapon('斩骨大剑', 55, 2), armor('板甲', 300, 0, 0.1)],
        }),
        makeCharacter({
          name: '奥托',
          tier: 3,
          level: 11,
          attributes: { str: 8, dex: 10, con: 10, int: 17, spi: 13 },
          occupation: ['法师'],
          inventory: [weapon('烈焰法杖', 48, 2), armor('法袍', 90, 2)],
        }),
        makeCharacter({
          name: '骷髅集群',
          race: '不死者',
          type: 'monster',
          tier: 2,
          level: 8,
          attributes: { str: 12, dex: 8, con: 14, int: 2, spi: 2 },
          inventory: [weapon('锈刃丛', 35), armor('碎骨盾墙', 120, 0)],
        }),
        makeCharacter({
          name: '骷髅兵长',
          race: '不死者',
          type: 'monster',
          tier: 2,
          level: 10,
          attributes: { str: 14, dex: 10, con: 12, int: 5, spi: 4 },
          inventory: [weapon('古剑', 42, 2), armor('残破胸甲', 150, 1)],
        }),
      ],
      allies: ['布琳', '奥托'],
      enemies: ['骷髅集群', '骷髅兵长'],
      preRun: (_bus, characters) => {
        const cluster = characters.find((c) => c.name === '骷髅集群');
        if (cluster) (cluster as unknown as { clusterCount: number }).clusterCount = 8;
      },
    },
    {
      // 多段攻击: multiHitCount>1 的伤害分段与消毒(上轮 0 次)
      id: 'S13-多段连击',
      combatType: '竞技',
      environment: '樱落道场',
      body: '双刀武士雾切与重甲决斗者康拉德的道场比试。雾切的「燕返连斩」流派每次出手都是 2-3 段连击——她调 combat_attack 时总以 multiHitCount 2 或 3 声明连击段数,以多段浅伤撕开重甲防线。',
      characters: [
        makeCharacter({
          name: '雾切',
          type: 'player',
          tier: 3,
          level: 13,
          attributes: { str: 12, dex: 17, con: 11, int: 12, spi: 12 },
          occupation: ['武士'],
          inventory: [weapon('双打刀', 36, 5), armor('轻武士甲', 140, 4)],
        }),
        makeCharacter({
          name: '康拉德',
          tier: 3,
          level: 12,
          attributes: { str: 15, dex: 9, con: 16, int: 10, spi: 9 },
          inventory: [weapon('巨型链锤', 62, 1), armor('决斗重铠', 320, 0, 0.15)],
        }),
      ],
      allies: ['雾切'],
      enemies: ['康拉德'],
    },
    {
      // 登神压制: divinity modifier → resolveDivinityConflict → 穿透+削 DR
      id: 'S14-登神压制',
      combatType: '压制',
      environment: '陨神战场',
      body: '半神候选者阿斯忒里亚降临陨神战场,圣殿骑士长加雷斯率凡人之躯阻拦。阿斯忒里亚的神焰之剑携登神位格,凡铁甲胄在神威压制下形同虚设。',
      characters: [
        makeCharacter({
          name: '阿斯忒里亚',
          type: 'player',
          tier: 5,
          level: 20,
          attributes: { str: 16, dex: 14, con: 15, int: 14, spi: 16 },
          occupation: ['半神候选'],
          ascension: {
            enabled: true,
            elements: ['圣焰'],
            authority: ['焚灭'],
            law: [],
            deityPosition: '火之神选',
            divineKingdom: { name: '', description: '' },
          },
          inventory: [weapon('神焰之剑', 120, 4, 0.1), armor('圣辉铠', 500, 2, 0.2)],
        }),
        makeCharacter({
          name: '加雷斯',
          tier: 4,
          level: 16,
          attributes: { str: 16, dex: 11, con: 16, int: 12, spi: 13 },
          inventory: [weapon('圣殿巨剑', 85, 2), armor('圣殿全铠', 450, 0, 0.25)],
        }),
      ],
      allies: ['阿斯忒里亚'],
      enemies: ['加雷斯'],
      preRun: (bus, characters) => {
        const deity = characters.find((c) => c.name === '阿斯忒里亚');
        if (!deity) return;
        // 装备脚本声明链路: 神焰之剑在 collect_attacker_mods 链上声明 divinity=3 固伤 modifier
        // → foldModsToPipelineModifiers: resolveDivinityConflict(3,0)=0.6 → 穿透+0.6 / 守方 DR-0.6
        bus.subscribeChain({
          type: COMBAT_MOD_EVENTS.ATTACKER_MODS,
          owner: deity.id,
          handler: (params: { attack: { attackerId: string }; mods: unknown[] }) => {
            if (params.attack.attackerId === deity.id) {
              params.mods.push({ category: '固伤', amount: 60, source: '神焰之剑', divinity: 3 });
            }
            return params;
          },
        });
      },
    },
    {
      // 玩家输入通道: registerSubmitter → awaiting_player_input 暂停/恢复(上轮走的是"代打"降级)
      id: 'S15-玩家亲征',
      combatType: '标准',
      environment: '林道关卡',
      body: '领主罗德里克亲征剿匪,侍从艾米随行,对阵匪首铁钩与刀客瘦猴。罗德里克与艾米均由玩家逐回合下达指令行动(等待玩家输入)。',
      characters: [
        makeCharacter({
          name: '罗德里克',
          type: 'player',
          tier: 3,
          level: 13,
          attributes: { str: 15, dex: 12, con: 14, int: 12, spi: 11 },
          inventory: [weapon('家传长剑', 52, 3), armor('领主铠甲', 280, 1, 0.1)],
        }),
        makeCharacter({
          name: '艾米',
          tier: 2,
          level: 9,
          attributes: { str: 11, dex: 14, con: 10, int: 12, spi: 11 },
          inventory: [weapon('轻弩', 30, 4), armor('侍从皮甲', 100, 3)],
        }),
        makeCharacter({
          name: '铁钩',
          tier: 3,
          level: 11,
          attributes: { str: 15, dex: 11, con: 13, int: 9, spi: 8 },
          inventory: [weapon('铁钩双爪', 45, 3), armor('拼皮甲', 160, 2)],
        }),
        makeCharacter({
          name: '瘦猴',
          tier: 2,
          level: 8,
          attributes: { str: 10, dex: 15, con: 9, int: 10, spi: 7 },
          inventory: [weapon('弯刃短刀', 28, 4), armor('布衣', 50, 4)],
        }),
      ],
      allies: ['罗德里克', '艾米'],
      enemies: ['铁钩', '瘦猴'],
      playerScript: [
        '举盾稳步逼近,先观察匪首铁钩的路数,不要冒进',
        '全力猛攻铁钩,瞄准他持钩的右手',
        '不给铁钩喘息之机,连续压制,把他逼到崖边',
        '速战速决,用最稳妥的方式终结战斗',
      ],
    },
    {
      // 预算极限: 双高防低攻 2v2 → 逼 MAX_TURNS=10 / 120 次 LLM 调用预算(budget_exceeded 路径)
      id: 'S16-铁壁消耗战',
      combatType: '标准',
      environment: '要塞城门',
      body: '两对重装铁卫在城门绞肉:双方都是极端防御流,甲厚盾重攻弱,谁都啃不动谁,注定是一场漫长的消耗战。',
      characters: [
        makeCharacter({
          name: '铁卫甲',
          type: 'player',
          tier: 4,
          level: 15,
          attributes: { str: 11, dex: 8, con: 17, int: 9, spi: 10 },
          inventory: [weapon('制式短匕', 10, 1), armor('要塞重铠', 500, 0, 0.3)],
        }),
        makeCharacter({
          name: '铁卫乙',
          tier: 4,
          level: 15,
          attributes: { str: 10, dex: 8, con: 17, int: 9, spi: 10 },
          inventory: [weapon('盾缘击', 8, 1), armor('塔盾壁垒', 550, 0, 0.3)],
        }),
        makeCharacter({
          name: '攻城卫甲',
          tier: 4,
          level: 15,
          attributes: { str: 11, dex: 8, con: 17, int: 9, spi: 10 },
          inventory: [weapon('破城锥柄', 10, 1), armor('攻城重铠', 500, 0, 0.3)],
        }),
        makeCharacter({
          name: '攻城卫乙',
          tier: 4,
          level: 15,
          attributes: { str: 10, dex: 8, con: 16, int: 9, spi: 10 },
          inventory: [weapon('铁拳套', 8, 1), armor('铁壁大盾', 550, 0, 0.28)],
        }),
      ],
      allies: ['铁卫甲', '铁卫乙'],
      enemies: ['攻城卫甲', '攻城卫乙'],
    },
  ];
}

// ═══════════════════ 配置装配 ═══════════════════

function loadAgentConfigs(): AgentConfig[] {
  const raw = JSON.parse(fs.readFileSync('data/defaults/agent-config.json', 'utf-8'));
  return Object.entries(raw.agents as Record<string, Record<string, unknown>>).map(
    ([agentId, v]) => ({ agentId, enabled: true, ...v }) as unknown as AgentConfig,
  );
}

function makeContext(characters: CharacterState[]): AgentContext {
  return {
    userInput: '',
    history: [],
    lorebookMatches: [],
    worldBooks: [],
    characters,
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
  };
}

const ENDPOINT: ApiEndpoint = {
  id: 'stress-deepseek',
  name: 'DeepSeek压测',
  provider: 'deepseek',
  baseUrl: BASE_URL,
  apiKey: '(env)',
  defaultModel: MODEL,
  models: [MODEL],
  timeout: REQUEST_TIMEOUT_MS,
};

// ═══════════════════ 不变量检查 ═══════════════════

interface Invariants {
  positiveDeltaHp: string[];
  hpOutOfRange: string[];
  invalidDiceArgs: string[];
  economyRejections: number;
  addressingErrors: number;
  unknownToolErrors: number;
  argsParseFailures: number;
}

function checkInvariants(
  patches: StatePatch[],
  events: CombatEvent[],
  metrics: ClientMetrics,
): Invariants {
  const inv: Invariants = {
    positiveDeltaHp: [],
    hpOutOfRange: [],
    invalidDiceArgs: [],
    economyRejections: 0,
    addressingErrors: 0,
    unknownToolErrors: 0,
    argsParseFailures: 0,
  };
  for (const p of patches) {
    if (p.op === 'delta_hp' && typeof p.amount === 'number' && p.amount > 0) {
      const src = (p.metadata as Record<string, unknown> | undefined)?.source ?? '';
      if (String(src).startsWith('combat')) {
        inv.positiveDeltaHp.push(`${p.target} +${p.amount} (${src})`);
      }
    }
  }
  for (const e of events) {
    if (e.type === 'combat_started' || e.type === 'combat_ended') continue;
    if (e.type === 'action_resolved' && e.toolName === 'combat_attack') {
      const r = e.result as { finalHp?: number; maxHp?: number };
      if (typeof r.finalHp === 'number' && typeof r.maxHp === 'number') {
        if (r.finalHp < 0 || r.finalHp > r.maxHp) {
          inv.hpOutOfRange.push(`finalHp=${r.finalHp}/max=${r.maxHp}`);
        }
      }
    }
  }
  for (const t of metrics.toolHistory) {
    if (t.name === 'combat_attack') {
      for (const key of ['d20Attack', 'd20Attack2', 'd20Intention', 'd20IntentionDefender']) {
        const v = t.args[key];
        if (v !== undefined && (typeof v !== 'number' || v < 1 || v > 20)) {
          inv.invalidDiceArgs.push(`${key}=${JSON.stringify(v)}`);
        }
      }
    }
    if (t.error) {
      if (t.error.includes('行动经济') || t.error.includes('初始化阶段')) inv.economyRejections++;
      else if (
        t.error.includes('按名寻址') ||
        t.error.includes('未找到') ||
        t.error.includes('不在当前战斗')
      )
        inv.addressingErrors++;
      else if (t.error.includes('白名单') || t.error.includes('未知')) inv.unknownToolErrors++;
      else if (t.error === 'ARGS_JSON_PARSE_FAIL') inv.argsParseFailures++;
    }
  }
  return inv;
}

// ═══════════════════ 单场执行 ═══════════════════

interface CombatReport {
  scenario: string;
  ok: boolean;
  failReason?: string;
  outcome?: string;
  rounds?: number;
  summaryPresent?: boolean;
  narrativeSummary?: string;
  exp?: number;
  patchCount?: number;
  durationMs: number;
  metrics: ClientMetrics;
  toolCallCounts: Record<string, number>;
  toolErrorSamples: string[];
  invariants?: Invariants;
  eventTimeline: string[];
  /** 引擎链式事件日志（§6.2 观测补强: combat.dice.roll / morale.check / morale.result） */
  engineEvents?: Array<{ t: string; params: unknown }>;
  /** 定向场景: 实际提交的玩家指令序列 */
  playerSubmits?: string[];
}

async function runScenario(sc: Scenario, configs: AgentConfig[]): Promise<CombatReport> {
  const combatStart = Date.now();
  const metrics: ClientMetrics = {
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheHitTokens: 0,
    latenciesMs: [],
    retries: 0,
    httpErrors: [],
    toolHistory: [],
    budgetExceeded: false,
  };
  const events: CombatEvent[] = [];
  const committed: StatePatch[] = [];

  // §6.2 观测补强: 引擎侧掷骰/战意事件入日志(passthrough 订阅,priority 9999 排在所有真实订阅之后,不改变参数)
  const engineEvents: Array<{ t: string; params: unknown }> = [];
  const eventBus = new EventBus({ maxHistory: 500 });
  for (const t of ['combat.dice.roll', 'combat.morale.check', 'combat.morale.result']) {
    eventBus.subscribeChain({
      type: t,
      priority: 9999,
      handler: (params) => {
        if (engineEvents.length < 800) {
          try {
            engineEvents.push({ t, params: JSON.parse(JSON.stringify(params)) });
          } catch {
            engineEvents.push({ t, params: String(params) });
          }
        }
        return params;
      },
    });
  }

  const marker: CombatTriggerMarker = {
    combatType: sc.combatType,
    environment: sc.environment,
    bodyText: sc.body,
    rawContent: sc.body,
  } as CombatTriggerMarker;

  // 定向场景注入(登神 modifier / clusterCount 等)
  sc.preRun?.(eventBus, sc.characters);

  // 定向场景: 玩家指令通道(registerSubmitter 提供 → runner 在我方回合暂停等文本)
  let submitFn: ((text: string) => void) | null = null;
  let scriptIdx = 0;
  const playerSubmits: string[] = [];

  const deps: CombatRunDeps = {
    clientFactory: () => makeDeepSeekClient(metrics, combatStart),
    eventBus,
    characters: sc.characters,
    variables: {},
    stateManager: {
      commitChatState: async (patches) => {
        committed.push(...patches);
      },
    },
    // playerScript 给定时提供 registerSubmitter(玩家输入通道真机验证);缺省保持"agent 代打"降级路径
    ...(sc.playerScript
      ? {
          registerSubmitter: (submit: (text: string) => void) => {
            submitFn = submit;
          },
        }
      : {}),
  };

  let report: CombatReport;
  try {
    const summary = await runCombat(
      {
        saveId: 'stress_save',
        marker,
        storyOutput: sc.body,
        context: makeContext(sc.characters),
        endpoint: ENDPOINT,
        configs,
      },
      deps,
      (evt) => {
        events.push(evt);
        const label =
          evt.type === 'action_resolved'
            ? `action:${evt.toolName}`
            : evt.type === 'turn_started'
              ? `turn:${evt.unit}@R${evt.round}`
              : evt.type === 'round_started'
                ? `round:${evt.round}`
                : evt.type;
        console.log(`  [${sc.id}] ${label}`);
        // 玩家指令脚本: 暂停事件 → 300ms 后提交下一条(耗尽后循环最后一条,绝不让战斗挂死)
        if (evt.type === 'awaiting_player_input' && sc.playerScript?.length) {
          const script = sc.playerScript;
          const cmd = script[Math.min(scriptIdx++, script.length - 1)];
          setTimeout(() => {
            if (submitFn) {
              playerSubmits.push(cmd);
              console.log(`  [${sc.id}] 玩家指令→ ${cmd}`);
              submitFn(cmd);
            }
          }, 300);
        }
      },
    );
    report = {
      scenario: sc.id,
      ok: true,
      outcome: summary.outcome,
      rounds: summary.rounds,
      summaryPresent: !summary.narrativeSummary.includes('未生成摘要'),
      narrativeSummary: summary.narrativeSummary.slice(0, 400),
      exp: summary.totalExp,
      patchCount: summary.patches.length,
      durationMs: Date.now() - combatStart,
      metrics,
      toolCallCounts: {},
      toolErrorSamples: [],
      invariants: checkInvariants(summary.patches, events, metrics),
      eventTimeline: [],
    };
  } catch (e) {
    report = {
      scenario: sc.id,
      ok: false,
      failReason: e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e),
      durationMs: Date.now() - combatStart,
      metrics,
      toolCallCounts: {},
      toolErrorSamples: [],
      eventTimeline: [],
    };
  }

  for (const t of metrics.toolHistory) {
    report.toolCallCounts[t.name] = (report.toolCallCounts[t.name] ?? 0) + 1;
  }
  report.engineEvents = engineEvents;
  if (playerSubmits.length) report.playerSubmits = playerSubmits;
  report.toolErrorSamples = metrics.toolHistory
    .filter((t) => t.error)
    .slice(0, 10)
    .map((t) => `${t.name}: ${t.error}`);
  report.eventTimeline = events.map((e) =>
    e.type === 'action_resolved'
      ? `action:${e.toolName}`
      : e.type === 'turn_started'
        ? `turn:${e.unit}@R${e.round}`
        : e.type,
  );

  const file = path.join(OUT_DIR, `${sc.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...report, committedPatches: committed }, null, 2));
  return report;
}

// ═══════════════════ 主流程（有限并发） ═══════════════════

async function main() {
  const configs = loadAgentConfigs();
  // REPEAT>1 时每份重新 buildScenarios() —— 角色对象独立,避免并发场次共享可变状态
  const scenarios: ReturnType<typeof buildScenarios> = [];
  for (let r = 1; r <= REPEAT; r++) {
    let batch = SCENARIO_SET === 'directed' ? buildDirectedScenarios() : buildScenarios();
    if (SCENARIO_FILTER) batch = batch.filter((s) => s.id.startsWith(SCENARIO_FILTER));
    if (r > 1) batch = batch.map((s) => ({ ...s, id: `${s.id}#${r}` }));
    scenarios.push(...batch);
  }

  console.log(`压测开始: ${scenarios.length} 场景 | 并发 ${CONCURRENCY} | 模型 ${MODEL}`);
  console.log(`输出目录: ${OUT_DIR}`);

  const reports: CombatReport[] = [];
  let idx = 0;
  async function worker(wid: number) {
    while (idx < scenarios.length) {
      const sc = scenarios[idx++];
      console.log(`[worker${wid}] ▶ ${sc.id}`);
      const r = await runScenario(sc, configs);
      reports.push(r);
      console.log(
        `[worker${wid}] ■ ${sc.id} → ${r.ok ? r.outcome : 'FAIL:' + r.failReason} | ` +
          `${(r.durationMs / 1000).toFixed(0)}s | LLM×${r.metrics.llmCalls} | ` +
          `tok ${r.metrics.promptTokens}+${r.metrics.completionTokens}`,
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

  // 汇总
  const sum = {
    combats: reports.length,
    succeeded: reports.filter((r) => r.ok).length,
    outcomes: reports.reduce<Record<string, number>>((m, r) => {
      const k = r.ok ? (r.outcome ?? '?') : 'ERROR';
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {}),
    totalLlmCalls: reports.reduce((s, r) => s + r.metrics.llmCalls, 0),
    totalPromptTokens: reports.reduce((s, r) => s + r.metrics.promptTokens, 0),
    totalCompletionTokens: reports.reduce((s, r) => s + r.metrics.completionTokens, 0),
    totalReasoningTokens: reports.reduce((s, r) => s + r.metrics.reasoningTokens, 0),
    totalRetries: reports.reduce((s, r) => s + r.metrics.retries, 0),
    httpErrors: reports.flatMap((r) => r.metrics.httpErrors).slice(0, 20),
    latency: (() => {
      const all = reports.flatMap((r) => r.metrics.latenciesMs).sort((a, b) => a - b);
      const q = (p: number) => all[Math.min(all.length - 1, Math.floor(all.length * p))] ?? 0;
      return {
        count: all.length,
        p50: q(0.5),
        p90: q(0.9),
        p99: q(0.99),
        max: all[all.length - 1] ?? 0,
      };
    })(),
    invariantViolations: reports
      .filter(
        (r) =>
          r.invariants &&
          (r.invariants.positiveDeltaHp.length ||
            r.invariants.hpOutOfRange.length ||
            r.invariants.invalidDiceArgs.length),
      )
      .map((r) => ({ scenario: r.scenario, ...r.invariants })),
    economyRejections: reports.reduce((s, r) => s + (r.invariants?.economyRejections ?? 0), 0),
    addressingErrors: reports.reduce((s, r) => s + (r.invariants?.addressingErrors ?? 0), 0),
    toolCallTotals: reports.reduce<Record<string, number>>((m, r) => {
      for (const [k, v] of Object.entries(r.toolCallCounts)) m[k] = (m[k] ?? 0) + v;
      return m;
    }, {}),
  };
  fs.writeFileSync(path.join(OUT_DIR, '_summary.json'), JSON.stringify({ sum, reports }, null, 2));
  console.log('\n════════ 压测汇总 ════════');
  console.log(JSON.stringify(sum, null, 2));
  console.log(`\n明细: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error('压测崩溃:', e);
  process.exit(1);
});
