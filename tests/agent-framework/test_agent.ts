/**
 * Agent 测试工具 Level 1 — 调提示词 (Phase 10 适配)
 *
 * 用法:
 *   npx tsx tests/agent-framework/test_agent.ts --agent vars_update --save fixtures/test_save_progressive.json --dry-run
 *   npx tsx tests/agent-framework/test_agent.ts --agent story --save fixtures/test_save_progressive.json -v --api-url https://... --api-key sk-xxx --model deepseek-chat
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { buildAgentMessages } from '../../src/sillytavern/agent-templates.js';
import { AgentClient, type ChatRequest } from '../../src/sillytavern/agent-client.js';
import { getToolsForAgent, executeToolCall } from '../../src/sillytavern/agent-tools.js';
import { getDefaultTemplate } from '../../src/sillytavern/placeholder-registry.js';
import type { AgentContext, AgentConfig, AgentPreset, ToolExecutionContext, CharacterState } from '../../src/sillytavern/types.js';

// ═══════════════════════════════════════
// CLI 参数
// ═══════════════════════════════════════
const { values: args } = parseArgs({
  options: {
    agent:    { type: 'string', short: 'a' },
    save:     { type: 'string', short: 's' },
    'api-url':  { type: 'string' },
    'api-key':  { type: 'string' },
    model:    { type: 'string', short: 'm' },
    'endpoint-id': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    verbose:  { type: 'boolean', short: 'v', default: false },
    upstream: { type: 'boolean', default: false },
    output:   { type: 'string', short: 'o' },
    'help':   { type: 'boolean', short: 'h' },
  },
});

if (args.help || !args.agent || !args.save) {
  console.log(`
Agent 测试工具 — 加载测试存档, 构建上下文, 调用 LLM, 校验输出格式

用法:
  npx tsx test_agent.ts --agent <id> --save <path> [options]

必填:
  --agent, -a     Agent ID (story|vars_update|char_update|memory_summary|craft_gen|char_gen|item_gen)
  --save, -s      测试存档 JSON 文件

API 配置 (按优先级 CLI > 本地文件 > 默认值):
  --api-url       LLM API 地址
  --api-key       API Key
  --model, -m     模型名
  --endpoint-id   从存档 apiEndpoints 取第 N 个 (0-based), 与上述三个互斥
  本地文件: tests/agent-framework/.api-config.json (不会被 git 提交)

模式:
  --dry-run       只构建并打印 prompt, 不调 LLM
  --verbose, -v   打印工具调用追踪和详细输出
  --upstream      先跑 upstream agent 再跑目标 agent (如 vars_update 依赖 story)
  --output, -o    保存结果到 JSON 文件

示例:
  npx tsx test_agent.ts -a vars_update -s fixtures/test_save_progressive.json --dry-run
  npx tsx test_agent.ts -a story -s fixtures/test_save_progressive.json -v --api-url https://api.deepseek.com/v1 --api-key sk-xxx -m deepseek-chat
  npx tsx test_agent.ts -a vars_update --upstream -s fixtures/test_save_progressive.json -v
`);
  process.exit(0);
}

const API_URL = args['api-url'] || 'http://localhost:1234/v1';
const API_KEY = args['api-key'] || 'not-needed';
const MODEL = args.model || 'gpt-3.5-turbo';
const SAVE_PATH = args.save;
const AGENT_ID = args.agent;
const DRY_RUN = args['dry-run'];
const VERBOSE = args.verbose;
const DO_UPSTREAM = args.upstream;
const OUTPUT_PATH = args.output;

// 自动加载本地 API 配置（不会被 git 提交），CLI 参数优先级更高
// 路径以运行目录为准 (npx tsx 在 tests/agent-framework/ 下运行)
const CONFIG_PATH = '.api-config.json';
let localApiConfig: { apiUrl?: string; apiKey?: string; model?: string } = {};
try {
  const configPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : 'tests/agent-framework/.api-config.json';
  if (fs.existsSync(configPath)) localApiConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch {}
const API_URL_FINAL = args['api-url'] || localApiConfig.apiUrl || 'http://localhost:1234/v1';
const API_KEY_FINAL = args['api-key'] || localApiConfig.apiKey || 'not-needed';
const MODEL_FINAL = args.model || localApiConfig.model || 'gpt-3.5-turbo';

// ═══════════════════════════════════════
// 校验函数（内联，纯正则/JSON）
// ═══════════════════════════════════════
interface ValidationResult { valid: boolean; errors: string[]; warnings: string[] }

function validateOutput(agentId: string, output: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = output.trim();

  switch (agentId) {
    case 'vars_update': {
      try {
        const d = JSON.parse(text);
        if (d.replace && !Array.isArray(d.replace)) errors.push('replace 应为数组');
        if (d.delta && !Array.isArray(d.delta)) errors.push('delta 应为数组');
        if (d.insert && !Array.isArray(d.insert)) errors.push('insert 应为数组');
        if (d.delta_time !== undefined && typeof d.delta_time !== 'number') warnings.push('delta_time 不是数字');
      } catch { errors.push('JSON 解析失败'); }
      break;
    }
    case 'char_update': {
      try {
        const d = JSON.parse(text);
        if (!d.characters || !Array.isArray(d.characters)) errors.push('缺少 characters 数组');
        else d.characters.forEach((c: any, i: number) => {
          if (!c.id) errors.push(`characters[${i}] 缺 id`);
          if (!c.changes || typeof c.changes !== 'object') errors.push(`characters[${i}] 缺 changes`);
        });
      } catch { errors.push('JSON 解析失败'); }
      break;
    }
    case 'memory_summary': {
      try {
        const d = JSON.parse(text);
        if (!d.content) errors.push('缺 content');
        else if (d.content.length < 200) warnings.push(`content 长度 ${d.content.length} < 200 字`);
        if (!d.hiddenLine) errors.push('缺 hiddenLine');
        if (!Array.isArray(d.keywords)) errors.push('keywords 应为数组');
        if (d.importance !== undefined && (d.importance < 1 || d.importance > 10)) warnings.push('importance 不在 1-10');
        if (!d.timeRangeStart) warnings.push('缺 timeRangeStart');
        if (!d.timeRangeEnd) warnings.push('缺 timeRangeEnd');
      } catch { errors.push('JSON 解析失败'); }
      break;
    }
    case 'story':
      for (const tag of ['maintext', 'option', 'sum']) {
        if (!text.includes(`<${tag}>`)) errors.push(`缺 <${tag}> 标签`);
      }
      break;
    case 'craft_gen':
      if (!/<craft_result>/.test(text)) errors.push('未找到 <craft_result>');
      else for (const tag of ['success', 'product_name', 'quality', 'rating', 'check_summary', 'narrative', 'craft_params']) {
        if (!new RegExp(`<${tag}>`).test(text)) errors.push(`缺 <${tag}> 标签`);
      }
      // 成功时应该有 <item_requests>（替代旧版 <creative_effects>）
      if (/<success>true<\/success>/.test(text) && !/<item_requests>/.test(text)) {
        errors.push('成功但缺 <item_requests> 标签（Phase 9b: 已取代 <creative_effects>）');
      }
      // 失败时不应有 <item_requests>
      if (/<success>false<\/success>/.test(text) && /<item_requests>/.test(text)) {
        errors.push('失败时不应有 <item_requests> 标签');
      }
      break;
    case 'char_gen':
      if (!/<char_result>/.test(text)) errors.push('未找到 <char_result>');
      else for (const tag of ['name', 'race', 'gender', 'tier', 'attributes', 'background', 'appearance', 'clothing', 'personality', 'likes']) {
        if (!new RegExp(`<${tag}[^>]*>`).test(text)) errors.push(`缺 <${tag}> 标签`);
      }
      break;
    case 'item_gen':
      if (!/<item_result>/.test(text)) errors.push('未找到 <item_result>');
      else for (const tag of ['skills', 'equipment', 'inventory']) {
        if (!new RegExp(`<${tag}>`).test(text)) errors.push(`缺 <${tag}> 标签`);
      }
      break;
    default:
      warnings.push(`未知 agent: ${agentId}, 跳过校验`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

// ═══════════════════════════════════════
// 文件路径解析 — 兼容 项目根目录 和 tests/agent-framework/ 两种 cwd
// ═══════════════════════════════════════
function resolveProjectPath(relativePath: string): string {
  // 先试当前 cwd 的相对路径
  if (fs.existsSync(relativePath)) return relativePath;

  // 如果 cwd 是 tests/agent-framework/，往上两级找
  const parts = relativePath.split('/');
  const fromRoot = '../../' + relativePath;
  if (fs.existsSync(fromRoot)) return fromRoot;

  // 如果 cwd 就是项目根 (如 npx tsx tests/agent-framework/test_agent.ts ...)
  if (fs.existsSync(relativePath)) return relativePath;

  // 都不存在也返回原路径（让调用方处理错误）
  return relativePath;
}

// ═══════════════════════════════════════
// Phase 10: localParams 提取 (链式 Agent 数据注入)
// ═══════════════════════════════════════
/**
 * 从上下文/上游输出中提取链式 Agent 所需的 localParams。
 * - craft_gen: 从 story 输出提取 <craft_request>
 * - char_gen:  从 story 输出提取 <char_detect>
 * - item_gen:  从 char_gen/craft_gen 输出提取 CHAR_GEN_RESULT/CRAFT_RESULT/ITEM_REQUEST
 */
function extractLocalParams(agentId: string, ctx: AgentContext, upstreamOutput?: string): Record<string, string> {
  const storyOut = upstreamOutput || ctx.agentOutputs?.get('story') || '';

  if (agentId === 'craft_gen') {
    const m = storyOut.match(/<craft_request[^>]*>([\s\S]*?)<\/craft_request>/);
    if (m) return { CRAFT_REQUEST: m[1].trim() };
  }

  if (agentId === 'char_gen') {
    const m = storyOut.match(/<char_detect[^>]*>([\s\S]*?)<\/char_detect>/);
    if (m) return { CHAR_DETECT: m[1].trim() };
  }

  if (agentId === 'item_gen') {
    const params: Record<string, string> = {};
    const charGenOut = ctx.agentOutputs?.get('char_gen') || '';
    const craftGenOut = ctx.agentOutputs?.get('craft_gen') || '';
    if (charGenOut) params.CHAR_GEN_RESULT = charGenOut;
    if (craftGenOut) params.CRAFT_RESULT = craftGenOut;
    const combined = charGenOut + craftGenOut;
    const reqM = combined.match(/<item_requests>([\s\S]*?)<\/item_requests>/);
    if (reqM) params.ITEM_REQUEST = reqM[1].trim();
    return params;
  }

  return {};
}

/**
 * 从 data/defaults/agent-config.json 加载完整 agent 配置。
 * 返回: { worldBookIds, model, presetId, systemPrompt, template, temperature, maxTokens, preset }
 */
function loadAgentConfigJson(): Record<string, any> {
  try {
    const path = resolveProjectPath('data/defaults/agent-config.json');
    const ac = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return (ac.agents || {}) as Record<string, any>;
  } catch { return {}; }
}

/**
 * 从 data/worldbooks/<id>.json 加载世界书条目
 */
function loadWorldBookFile(wbId: string): any {
  const wbPath = resolveProjectPath('data/worldbooks/' + wbId + '.json');
  if (!fs.existsSync(wbPath)) return null;
  try {
    const wb = JSON.parse(fs.readFileSync(wbPath, 'utf-8'));
    return { id: wbId, name: wbId, entries: Array.isArray(wb) ? wb : (wb.entries || []) };
  } catch { return null; }
}

/**
 * 构建 buildAgentMessages() 所需的 AgentConfig
 */
function buildAgentConfig(agentId: string, agents: Record<string, any>): AgentConfig {
  const ag = agents[agentId] || {} as any;
  const cfg: AgentConfig = {
    agentId,
    enabled: true,
    apiEndpointId: '',
    model: ag.model || '',
    temperature: ag.temperature ?? 0.7,
    maxTokens: ag.maxTokens ?? 4096,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: false,
    timeout: 0,
    userId: '',
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
    worldBookIds: ag.worldBookIds || [],
    presetId: ag.presetId || '',
  };
  // Phase 9: inject systemPrompt
  if (ag.systemPrompt) cfg.systemPrompt = ag.systemPrompt;
  // Phase 10: inject template
  if (ag.template) cfg.template = ag.template;
  return cfg;
}

/**
 * 从 agent-config.json 提取 presets (story Agent 用)
 */
function extractPresets(agents: Record<string, any>): AgentPreset[] {
  const storyAg = agents['story'];
  if (storyAg?.preset) {
    // Ensure the preset has the id field set (sometimes it's only nested)
    const p = storyAg.preset;
    if (!p.id) p.id = storyAg.presetId || 'story-preset';
    return [p as AgentPreset];
  }
  return [];
}

/**
 * Phase 10: 资产来源描述 (供 dry-run 输出)
 */
interface TemplateSourceInfo {
  templateSource: 'agent-config.json' | 'placeholder-registry default' | 'legacy fallback';
  sysPromptSource: 'preset' | 'systemPrompt' | 'fixedSystem fallback';
  localParamsKeys: string[];
  unresolvedPlaceholders: string[];
}

function analyzeTemplate(
  agentId: string, cfg: AgentConfig, agents: Record<string, any>, content: string, localParams?: Record<string, string>
): TemplateSourceInfo {
  const hasConfigTemplate = !!(agents[agentId]?.template);
  const hasDefaultTemplate = getDefaultTemplate(agentId) !== '';
  const templateSource = cfg.template ? 'agent-config.json'
    : hasDefaultTemplate ? 'placeholder-registry default' : 'legacy fallback';

  const sysPromptSource = agentId === 'story' && agents['story']?.preset ? 'preset'
    : cfg.systemPrompt ? 'systemPrompt' : 'fixedSystem fallback';

  const localParamsKeys = localParams ? Object.keys(localParams).filter(k => localParams[k]) : [];

  const unresolved = content.match(/\{\{[A-Z][A-Z_.]*(?::[^}]*)?\}\}/g);
  const unresolvedPlaceholders = unresolved ? [...new Set(unresolved)] : [];

  return { templateSource, sysPromptSource, localParamsKeys, unresolvedPlaceholders };
}

// ═══════════════════════════════════════
// 上下文构建
// ═══════════════════════════════════════
function buildContextFromSave(backup: any, overrideUserInput?: string): AgentContext {
  const chat = backup.chats?.[0];
  if (!chat) throw new Error('存档中没有 ChatSession');

  const messages = chat.messages || [];
  // 最后一条 user 消息作为当前输入，其余为历史
  const lastUserIdx = [...messages].reverse().findIndex((m: any) => m.role === 'user');
  const lastUserMsg = lastUserIdx >= 0 ? messages[messages.length - 1 - lastUserIdx] : null;
  const userInput = overrideUserInput || (lastUserMsg?.content || '');
  const history = lastUserMsg
    ? messages.slice(0, messages.indexOf(lastUserMsg))
    : messages.slice(0, -1);

  // Phase 10: 支持多种上游注入数据
  const agentOutputs = new Map<string, string>();
  if (backup.injectedCharGenOutput) {
    agentOutputs.set('char_gen', backup.injectedCharGenOutput);
  }
  if (backup.injectedCraftGenOutput) {
    agentOutputs.set('craft_gen', backup.injectedCraftGenOutput);
  }
  if (backup.injectedItemGenOutput) {
    agentOutputs.set('item_gen', backup.injectedItemGenOutput);
  }
  // 自动注入: 最后一条 assistant 消息作为 story 输出
  if (!agentOutputs.has('story')) {
    const lastAsst = [...messages].reverse().find((x: any) => x.role === 'assistant');
    if (lastAsst) agentOutputs.set('story', lastAsst.content);
  }

  return {
    userInput,
    history: history.map((m: any) => ({ role: m.role, content: m.content })),
    lorebookMatches: [],
    worldBooks: [],
    characters: (backup.characters || []) as CharacterState[],
    variables: chat.variables || {},
    plotEvents: backup.plotEvents || [],
    memories: backup.memories || [],
    agentOutputs,
    saveId: backup.saves?.[0]?.id || 'test-save',
  };
}

function log(verbose: boolean, msg: string) {
  if (verbose) console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
}

// ═══════════════════════════════════════
// 主流程
// ═══════════════════════════════════════
async function main() {
  // 1. 加载存档
  log(VERBOSE, `Loading save: ${SAVE_PATH}`);
  const backup = JSON.parse(fs.readFileSync(SAVE_PATH, 'utf-8'));
  let ctx = buildContextFromSave(backup);

  log(VERBOSE, `Context: ${ctx.characters.length} chars, ${ctx.memories.length} memories, ${ctx.plotEvents.length} plot events, ${backup.chats?.length || 0} chats`);

  // 2. 如果 --endpoint-id，从存档取 API 配置；否则用本地配置/CLI 参数
  let apiUrl = API_URL_FINAL;
  let apiKey = API_KEY_FINAL;
  let model = MODEL_FINAL;
  if (args['endpoint-id'] !== undefined) {
    const idx = parseInt(args['endpoint-id']);
    const ep = backup.apiEndpoints?.[idx];
    if (ep) {
      apiUrl = ep.baseUrl; apiKey = ep.apiKey; model = ep.defaultModel || model;
      log(VERBOSE, `Using endpoint[${idx}]: ${ep.name || apiUrl}`);
    } else {
      console.error(`apiEndpoints[${idx}] 不存在, 使用 CLI 默认值`);
    }
  }

  // 3. 加载 agent 配置和世界书（Phase 10: 统一使用 helper 函数）
  const allAgents = loadAgentConfigJson();
  const agentConfig = buildAgentConfig(AGENT_ID, allAgents);
  const presets = extractPresets(allAgents);

  const worldBooks: any[] = [];
  for (const wbId of agentConfig.worldBookIds) {
    const wb = loadWorldBookFile(wbId);
    if (wb) worldBooks.push(wb);
  }

  if (DRY_RUN) {
    // 4a. 干跑模式：构建并打印
    const localParams = extractLocalParams(AGENT_ID, ctx);
    if (VERBOSE && Object.keys(localParams).length > 0) {
      log(VERBOSE, `localParams: ${Object.keys(localParams).join(', ')}`);
    }
    const msgs = buildAgentMessages(AGENT_ID, ctx, [agentConfig], worldBooks, presets, localParams);
    if (!msgs) { console.error(`未知 Agent: ${AGENT_ID}`); process.exit(1); }

    // Phase 10: 分析模板来源
    const info = analyzeTemplate(AGENT_ID, agentConfig, allAgents, msgs[0].content, localParams);
    console.log(`\n=== RESOLVED TEMPLATE (${AGENT_ID} | ${msgs.length} message(s)) ===`);
    console.log(`Template source: ${info.templateSource}`);
    console.log(`SYS_PROMPT source: ${info.sysPromptSource}`);
    if (info.localParamsKeys.length > 0) console.log(`localParams injected: ${info.localParamsKeys.join(', ')}`);
    if (info.unresolvedPlaceholders.length > 0) {
      console.log(`⚠ Unresolved placeholders: ${info.unresolvedPlaceholders.join(', ')}`);
    }

    for (const m of msgs) {
      console.log(`\n--- ${m.role.toUpperCase()} (${m.content.length} chars) ---`);
      console.log(m.content.substring(0, 4000));
      if (m.content.length > 4000) console.log(`... [截断, 总长 ${m.content.length} chars]`);
    }
    // 也打印工具（如果是 Agentic agent）
    const tools = getToolsForAgent(AGENT_ID);
    if (tools.length > 0) console.log(`\n=== TOOLS (${tools.length}) ===\n${tools.map(t => t.function.name).join(', ')}`);
    return;
  }

  // note: upstream moved below detectProvider

  // 5. 构建目标 Agent 的消息
  log(VERBOSE, `Agent: ${AGENT_ID} | API: ${model} @ ${apiUrl}`);

  // Phase 10: 构建 localParams + 调用 buildAgentMessages (6 参数)
  const localParams = extractLocalParams(AGENT_ID, ctx);
  if (VERBOSE && Object.keys(localParams).length > 0) {
    log(VERBOSE, `localParams: ${Object.keys(localParams).join(', ')}`);
  }
  const msgs = buildAgentMessages(AGENT_ID, ctx, [agentConfig], worldBooks, presets, localParams);
  if (!msgs) { console.error(`未知 Agent: ${AGENT_ID}`); process.exit(1); }
  log(VERBOSE, `System prompt: ${msgs[0]?.content.length || 0} chars`);
  if (msgs.length > 1) log(VERBOSE, `User message: ${msgs[1]?.content.length || 0} chars`);

  // 6. 创建 client 并调用
  const detectProvider = (url: string) => url.includes('deepseek.com') ? 'deepseek' : url.includes('openai.com') ? 'openai' : 'custom';

  // Move upstream block here, after detectProvider is defined
  if (DO_UPSTREAM) {
    const upstreamId = AGENT_ID === 'vars_update' || AGENT_ID === 'char_update' || AGENT_ID === 'memory_summary' ? 'story'
      : AGENT_ID === 'item_gen' ? 'char_gen' : null;
    if (upstreamId) {
      log(VERBOSE, `[upstream] Running ${upstreamId} first...`);
      const upCfg = buildAgentConfig(upstreamId, allAgents);
      upCfg.toolsEnabled = true;

      const upWbs: any[] = [];
      for (const wbId of upCfg.worldBookIds) {
        const wb = loadWorldBookFile(wbId);
        if (wb) upWbs.push(wb);
      }

      // Phase 10: 上游也需要 localParams (如 char_gen 需要 CHAR_DETECT from story)
      const upLocalParams = extractLocalParams(upstreamId, ctx);
      const upPresets = upstreamId === 'story' ? presets : undefined;
      const upMsgs = buildAgentMessages(upstreamId, ctx, [upCfg], upWbs, upPresets, upLocalParams);
      if (upMsgs) {
        const upClient = new AgentClient({ endpoint: { baseUrl: apiUrl, apiKey, defaultModel: model, id: 'up', name: 'up', provider: detectProvider(apiUrl), models: [model], timeout: 120 }, agentId: upstreamId, saveId: ctx.saveId || 'test' });
        // 上游用 Agentic 模式（如果有工具）
        const upTools = getToolsForAgent(upstreamId);
        let upResult: any;
        if (upTools.length > 0 && upClient.chatWithTools) {
          const upToolCtx: ToolExecutionContext = { characters: ctx.characters, variables: ctx.variables, saveId: ctx.saveId || 'test-save' };
          upResult = await upClient.chatWithTools(
            { messages: upMsgs, tools: upTools, tool_choice: 'auto' },
            async (name: string, nargs: Record<string, any>) => {
              const tr = await executeToolCall(name, nargs, upToolCtx);
              return tr;
            },
            { maxRounds: 10 },
          );
        } else {
          upResult = await upClient.chat({ messages: upMsgs, temperature: 0.7, maxTokens: 16384 });
        }
        if (upResult?.output) {
          ctx.agentOutputs!.set(upstreamId, upResult.output);
          log(VERBOSE, `[upstream] ${upstreamId}: tokens=${upResult.tokensUsed} cache=${upResult.cacheHit} duration=${upResult.duration}ms`);
          if (VERBOSE) console.log(`[upstream output, ${upResult.output.length} chars]:\n${upResult.output.substring(0, 500)}\n...`);

          // Phase 10: 上游完成后重新提取下游 localParams (story→craft_gen/char_gen, char_gen→item_gen)
          const updatedLocalParams = extractLocalParams(AGENT_ID, ctx, upstreamId === 'story' ? upResult.output : undefined);
          if (Object.keys(updatedLocalParams).length > 0) {
            // Rebuild msgs with updated localParams from upstream output
            Object.assign(localParams, updatedLocalParams);
            const rebuiltMsgs = buildAgentMessages(AGENT_ID, ctx, [agentConfig], worldBooks, presets, localParams);
            if (rebuiltMsgs) {
              msgs.length = 0;
              msgs.push(...rebuiltMsgs);
              log(VERBOSE, `[upstream] Rebuilt messages with localParams: ${Object.keys(updatedLocalParams).join(', ')}`);
            }
          }
        }
      }
    }
  }
  const client = new AgentClient({
    endpoint: { id: 'test', name: 'test', baseUrl: apiUrl, apiKey, defaultModel: model, provider: detectProvider(apiUrl), models: [model], timeout: 120 },
    agentId: AGENT_ID,
    saveId: ctx.saveId || 'test',
  });

  const tools = getToolsForAgent(AGENT_ID);
  const isAgentic = tools.length > 0;
  if (isAgentic) log(VERBOSE, `Agentic mode: ${tools.length} tools (${tools.map(t => t.function.name).join(', ')})`);

  const result = isAgentic
    ? await (async () => {
        const toolCtx: ToolExecutionContext = { characters: ctx.characters, variables: ctx.variables, saveId: ctx.saveId || 'test-save' };
        const req: ChatRequest = { messages: msgs, temperature: 0.7, maxTokens: 16384, tools, reasoning: true };
        return client.chatWithTools(req, (name, nargs) => {
          const r = executeToolCall(name, nargs, toolCtx);
          if (VERBOSE) {
            const a = JSON.stringify(nargs).substring(0, 120);
            const res = JSON.stringify(r).substring(0, 200);
            log(VERBOSE, `  [TOOL] ${name}(${a}) → ${res}`);
          }
          return Promise.resolve(r);
        }, { maxRounds: 15 });
      })()
    : await (async () => {
        const req: ChatRequest = { messages: msgs, temperature: 0.7, maxTokens: 16384, reasoning: true };
        return client.chat(req);
      })();

  // 7. 校验 + 打印结果
  const validation = validateOutput(AGENT_ID, result.output || '');
  const status = validation.valid ? '✅' : '❌';
  if (VERBOSE) {
    if (result.reasoning) {
      console.log(`\n--- Reasoning (${result.reasoning.length} chars) ---`);
      console.log(result.reasoning.substring(0, 3000));
      if (result.reasoning.length > 3000) console.log('... [truncated]');
    }
    console.log(`\n--- LLM Response (${(result.output || '').length} chars) ---`);
    console.log(result.output);
  }
  if (VERBOSE) {
    console.log(`\n--- Validation ---`);
    console.log(`${status} ${AGENT_ID}: valid=${validation.valid}`);
    for (const e of validation.errors) console.log(`  ❌ ${e}`);
    for (const w of validation.warnings) console.log(`  ⚠️ ${w}`);
  }
  console.log(`${status} ${AGENT_ID}: tokens=${result.tokensUsed} cache=${result.cacheHit} duration=${(result.duration / 1000).toFixed(1)}s errors=${validation.errors.length} warnings=${validation.warnings.length}`);
  if (result.error) console.log(`  Error: ${result.error}`);

  // 8. 保存输出 (Phase 10: 增加 template metadata)
  if (OUTPUT_PATH) {
    const info = analyzeTemplate(AGENT_ID, agentConfig, allAgents, msgs[0]?.content || '', localParams);
    const outputData = {
      agentId: AGENT_ID, saveFile: SAVE_PATH, model,
      templateMetadata: {
        templateSource: info.templateSource,
        sysPromptSource: info.sysPromptSource,
        localParamsKeys: info.localParamsKeys,
        unresolvedPlaceholders: info.unresolvedPlaceholders,
      },
      messages: msgs,
      response: { output: result.output, rawResponse: result.rawResponse, reasoning: result.reasoning, tokensUsed: result.tokensUsed, cacheHit: result.cacheHit, duration: result.duration, error: result.error },
      validation,
      toolCalls: result.toolCalls || [],
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outputData, null, 2), 'utf-8');
    log(VERBOSE, `Output saved: ${OUTPUT_PATH}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
