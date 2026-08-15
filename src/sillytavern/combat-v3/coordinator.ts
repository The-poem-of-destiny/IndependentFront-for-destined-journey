/**
 * combat-v3/coordinator.ts — CombatSessionCoordinator（M2）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §十四 14.3/14.4/14.7
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §4.2/§4.3（四路由）/§4.10
 *
 * 职责（架构 §十四 14.3）：
 *   - runCombatV3(opts)：从 openCombat 驱动完整战斗循环直到结束
 *   - routeRequiredInput(req)：RequiredInput 路由（A2-3，穷尽 switch，never 兜底）
 *   - 终局：Dispatch RequestSettlement → 翻译 DomainEvent → StatePatch[] → 一次 commitChatState
 *     （T10 §2.6：合并单位资源/状态覆写回写，战斗后角色伤势持久化）
 *   - 终局摘要（T11 §2.2）：write_summary 不再返回占位 Choose —— AI 调 write_summary(text)
 *     时 text 收集进 combatSession.summary，终局经 narrativeSummary 回注正文（game-pipeline
 *     的 【战斗摘要】assistant 消息）；无摘要时兜底「战斗结束（reason）」
 *   - abandon()：丢弃 session、FP 不落库、解除 isGenerating（C4 修复）
 *
 * 内核不存 Promise，所有异步性在 coordinator 侧（架构 §十四 14.2）。
 *
 * 四路由（plan §4.3）：
 *   - PlayerCommand（玩家方）→ deps.submitCommand + waitForCommand（game-store）
 *   - PlayerCommand（敌方）→ 战斗 Agent（deps.clientFactory → chatWithTools）→ toolCallToCommand
 *   - EffectChoice → M2 throw UnsupportedInM2
 *   - BeginOutput → 调 deps.drawDice 取 60 颗 → SupplyDice
 *   - BoundedAdjudication / CharGenRequest → M2 throw UnsupportedInM2
 *
 * 验收断言：
 *   A2-1  第 09 场 fixture 端到端跑通，最终一次 commitChatState
 *   A2-3  RequiredInput 路由穷尽（漏一路编译不过）
 *   A2-4  abandon 后 session 丢弃、isGenerating 解除、FP 不落库
 *   A2-5  战斗摘要以【战斗摘要】assistant 消息回注 Story
 *
 * 铁律（plan §1.3）：本文件**零 Math.random / new Function / eval**——Command id
 * 用确定性序号（revision + 局部计数器），禁止随机。no-nondeterminism.test.ts 会扫描。
 */

import { openCombat } from './index';
import { projectToAgent } from './projection-agent';
import { projectToUi } from './projection-ui';
import { lookupSummon } from './summon-pool';
import { runCharGenForCombat } from '../char-gen-agent';
import { getToolsForAgent, executeToolCall } from '../agent-tools';
import { resolveTemplateWithGlobals } from '../template-resolver';
import { getDefaultTemplate } from '../placeholder-registry';
import type {
  CombatCommand,
  CombatDefinitionBundle,
  CombatSession,
  CombatUnitView,
  DomainEvent,
  ProposedAdjudication,
  RequiredInput,
  SummonedUnitDefinition,
} from './types';
import type { CombatClient, CombatEvent } from '../combat-v2-types';
import type {
  ApiEndpoint,
  AgentContext,
  AgentConfig,
  ChatMessage,
  CombatParticipant,
  IntentionLevel,
  StatePatch,
  ToolResult,
  WorldBook,
} from '../types';
import { getCombatCoefficient } from '../tier-constants';

// ──────────────────────────────────────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────────────────────────────────────

/** M2 尚不支持的外部输入 → 显式可控异常 */
export class UnsupportedInM2 extends Error {
  constructor(inputKind: string) {
    super(`[combat-v3/coordinator] M2 尚不支持 RequiredInput「${inputKind}」（M3/M3.5 实现）`);
    this.name = 'UnsupportedInM2';
  }
}

/** runCombatV3 的结果（终局摘要 + 落库 patches） */
export interface CombatV3Result {
  narrativeSummary: string;
  patches: StatePatch[];
  totalExp: number;
  totalFp: number;
  loot: unknown[];
  rounds: number;
  outcome: 'ally_win' | 'enemy_win' | 'fled' | 'draw';
  /**
   * 战斗被放弃（C4 abandon / 中途取消）：patches 为空、终局未落库。
   * 消费方（game-pipeline）据此不把放弃的战斗记入「最近已结算战斗」——
   * 放弃的战斗没有发生过，下一轮 dispatcher 仍可对正文战况正常触发。
   */
  aborted?: boolean;
}

/** runCombatV3 的依赖注入（全部可 mock，测试友好） */
export interface RunCombatV3Opts {
  saveId: string;
  bundle: CombatDefinitionBundle;
  deps: {
    clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => CombatClient;
    endpoint: ApiEndpoint;
    stateManager?: { commitChatState: (patches: StatePatch[]) => Promise<void> };
    characters: Array<Record<string, unknown>>;
    variables?: Record<string, unknown>;
    context: AgentContext;
    // Agent 配置（agent-config.json 经 game-pipeline 透传）。routeEnemyCommand 用它读
    // combat_v3.systemPrompt（设计 2026-08-09 §2.7）；routeCharGenRequest 也用它喂
    // runCharGenForCombat 的 base.configs（M3.5 召唤链）。
    configs?: AgentConfig[];
    // T2（2026-08-10）：Phase 10 模板系统上下文 —— 开局第一条 user 消息（情境快照）
    // 的数据源，经 localParams 注入 combat_v3.template 的链占位符（COMBAT_BRIEF /
    // USER_INPUT / AGENT.STORY / NARRATIVE / LORE_BOOK_STATIC）。全部可选：缺省时
    // routeEnemyCommand 回退改造前的硬编码行为（「轮到敌方X行动+面板」，逐字不变）。
    worldBooks?: WorldBook[]; // 已过滤：world_setting + race + system_core 分区
    combatBrief?: string; // 从 <combat_trigger> marker 组装的战斗指令文本
    combatRoster?: string; // 参战单位清单（我方/敌方名单，由 game-pipeline 从 marker 的 allies/enemies 组装）
    userInput?: string; // 本轮玩家输入
    storyOutput?: string; // 触发战斗的正文
    history?: unknown[]; // 最近对话（ChatMessage[] 或等价形状）
    // 叙事通道（设计 2026-08-09 §2.5 声明/结算演绎）：runCombatV3 注入 emitNarration，
    // 经 RouteCtx.onNarration 转发声明演绎（assistant content）与结算结果句，以
    // v3_narrative 投进 combatLog（game-store 已消费该事件）。测试可注入捕获；
    // 省略时 routeEnemyCommand 不产生叙事事件（直捣路由的测试可不管叙事）。
    onNarration?: (text: string) => void;
    // 玩家输入等待事件通道（T16，设计 2026-08-09 §3.1）：路由到玩家单位需要输入时，
    // 经 RouteCtx.onCombatEvent emit v3_awaiting_player_input，game-store 的
    // v3_awaiting_player_input case 据此置 combatAwaitingInput（UI 显示「等待玩家输入」）。
    // 仅 player 阵营 emit；敌方走 routeEnemyCommand 不 emit。runCombatV3 把顶层
    // opts.onCombatEvent 注入 routingDeps，省略时路由不产生等待事件（直捣路由测试可不管）。
    onCombatEvent?: (evt: CombatEvent) => void;
    // 玩家 Command 路由 → game-store
    submitCommand: (cmd: CombatCommand) => Promise<void>;
    waitForCommand: () => Promise<CombatCommand>;
    // 🆕 2026-08-12（主持人/DM 模式）：玩家意图文本桥。生产由 game-pipeline 提供
    // （前端提交文本 → coordinator 收到 → 主持人会话解析 → Command）；测试缺省时
    // coordinator 回退 submitCommand/waitForCommand（直捣路由测试不改动）。
    submitPlayerIntent?: (text: string) => Promise<void>;
    waitForPlayerIntent?: () => Promise<string>;
    // 放弃战斗（C4）
    abandon: () => void;
    // BeginOutput 注骰（必填依赖）：coordinator 每次续杯会调它取 60 颗 d20。
    // 生产由 game-pipeline 注入真实随机源（dice.ts 的 rollDice），测试注入确定性向量。
    drawDice: () => { outputId: string; dice: number[] };
  };
  /** 前端事件流回调（投影 A 输出，供 game-store） */
  onCombatEvent?: (evt: CombatEvent) => void;
}

/** 单次 dispatch 熔断上限（防死循环，对应 coordinator 级别） */
const MAX_DISPATCH_STEPS = 500;
/** 敌方 Agent 工具调用预算（一次工具调用 = 一个 Command，单位内最多攻击+动作+pass） */
const MAX_TOOL_ROUNDS = 8;

/**
 * 战斗 Agent 的 system prompt 兜底（2026-08-09 改造后仅 configs 缺失时使用）：
 * 主来源是 agent-config.json 的 `agents.combat_v3.systemPrompt`（经 ctx.configs 传入，
 * 由 game-pipeline 的 chainData.agentConfigs 透传）。取不到时回退到这段历史文本，
 * 保证无配置环境下仍有防御性提示（行为与改造前逐字一致）。
 */
const FALLBACK_COMBAT_SYSTEM_PROMPT =
  '你是战斗决策 Agent。根据战斗面板为敌方单位决定动作。一次只提交一个 Command 对应的工具（declare_attack / declare_action / pass_slot / flee / write_summary），禁止传骰值。';

// 局部确定性 id 计数器（避免 Math.random，铁律 1）
let _idSeq = 0;
function nextCmdId(prefix: string): string {
  _idSeq += 1;
  return `${prefix}-${_idSeq}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 运行一场 v3 战斗，直到终局 settlement，返回摘要 + 落库 patches。
 *
 * 协调循环（plan §3.2）：
 *   1. openCombat 建 session
 *   2. 首个 SupplyDice 喂 60 颗骰（deps.drawDice 提供）
 *   3. 循环 dispatch：无 requiredInput 且未终局则自动推进；有 requiredInput 则 route；到 Terminal dispatch RequestSettlement
 *   4. 终局：翻译 DomainEvent → StatePatch[]（含 T10 §2.6 单位资源/状态覆写回写）→ 一次 commitChatState → 摘要回注
 */
export async function runCombatV3(opts: RunCombatV3Opts): Promise<CombatV3Result> {
  const { deps } = opts;
  const session = openCombat({ kind: 'new', bundle: opts.bundle });

  // ── F1（2026-08-10 面板不弹死锁根治）────────────────────────────────────────
  // 开局事件**抢在首个 dispatch 之前**立即 emit。背景：首个 dispatch 是 SupplyDice，
  // reduceSupplyDice 保持 phase 不变、不产 CombatOpened —— CombatOpened 要等下一个
  // Command 进 runDispatch 才发。玩家单位先动 → decideForUnit 走 waitForCommand()
  // 永久 pending（等玩家输入）→ v3_combat_started 永不落地 → 面板不弹 → 玩家看不到
  // 面板无法输入 → 死锁。这里直接发两条（形状照 projection-ui.ts mapEvent 的
  // CombatOpened 分支与 v3_units_snapshot），面板先弹、玩家能输入。
  // 幂等说明：后续 dispatch 流若再遇 CombatOpened，emitEvents 会重复发
  // v3_combat_started + v3_units_snapshot —— game-store 的 v3ActiveCombat 整份覆盖
  // 与 units 覆盖均无害（可接受重复，不额外去重）。
  // ──────────────────────────────────────────────────────────────────────────────
  if (opts.onCombatEvent) {
    const openView = session.snapshot();
    opts.onCombatEvent({
      type: 'v3_combat_started',
      combatId: openView.combatId,
      round: 1,
      unitNames: Object.keys(openView.units),
    });
    opts.onCombatEvent({ type: 'v3_units_snapshot', units: { ...openView.units } });
  }

  // 骰子供应（必填依赖 drawDice；BeginOutput 走 getDice 续杯）
  const getDice = (): { outputId: string; dice: number[] } => deps.drawDice();

  // 持久会话句柄（设计 2026-08-09 §2.1 决策 1A）：整场战斗一个 client + 消息累积，
  // 前缀稳定 → LLM 前缀缓存命中。routeEnemyCommand 经 ctx.combatSession 读/写它；
  // summary 字段是终局摘要收集变量（T11，write_summary 改造）。
  const combatSession: CombatSessionHandle = { messages: [], client: null, summary: '' };

  // 叙事 emit 通道（设计 2026-08-09 §2.5）：声明演绎（routeEnemyCommand 的 assistant
  // content）经 RouteCtx.onNarration 转发到这里，结算结果句由结算短调用直接喂进来；
  // 统一以 v3_narrative 投进 combatLog（game-store 已消费，渲染成 combatLog narrative 行）。
  const emitNarration = (text: string): void => {
    const trimmed = (text ?? '').trim();
    if (!trimmed || !opts.onCombatEvent) return;
    opts.onCombatEvent({ type: 'v3_narrative', text: trimmed, round: session.snapshot().round });
  };
  // 把叙事通道装进依赖袋：decideForUnit / routeRequiredInput 构造 RouteCtx 时经
  // `...deps` 展开自动带上 onNarration（T7 既有的 spread 约定），两处路由的声明演绎
  // 都能经它投进 combatLog，无需逐个调用点传参。
  // T16：玩家输入等待事件通道一并注入（= 顶层 opts.onCombatEvent），两处 player 分支
  // emit v3_awaiting_player_input（仅 player 阵营）。
  const routingDeps: RunCombatV3Opts['deps'] = {
    ...deps,
    onNarration: emitNarration,
    onCombatEvent: opts.onCombatEvent,
  };

  const allEvents: DomainEvent[] = [];
  const loot: unknown[] = [];

  // F5（2026-08-10）：开局先调一次 AI 构建战斗场景 —— 氛围描写（进 combatLog）+ 可调查询
  // 工具获取信息（先攻由内核掷定，见 buildOpeningSceneMessage 的注入说明）。时序：F1 开局
  // 事件 emit 之后、正式回合循环（SupplyDice → decideForUnit）之前。
  // 触发条件：配置了 combat_v3 agent（configs 经 game-pipeline 恒透传）——无配置 = 无 agent
  // 可用，静默跳过（不阻塞战斗）。失败同样在 openCombatScene 内部静默降级。
  // 🔴 不产 Command、不改战斗状态：氛围描写阶段 AI 只输出叙事 + 查询，命令留到行动轮。
  const combatCfgPresent = (opts.deps.configs ?? []).some((c) => c.agentId === 'combat_v3');
  if (combatCfgPresent) {
    await openCombatScene(
      session,
      { ...routingDeps, saveId: opts.saveId },
      combatSession,
      emitNarration,
    );
  }

  // F4（2026-08-10）：待执行命令队列。敌方 Agent 一次 chatWithTools 可声明多个命令
  // （attack+action），routeEnemyCommand 全部收集返回；主循环每次取一个 dispatch，
  // dispatch 之间内核发 requiredInput（同单位继续）时**先消费队列**，不再重新调 AI。
  const pendingCommands: CombatCommand[] = [];

  // 首次注骰
  let currentCommand: CombatCommand = supplyCommand(opts.saveId, session, getDice());

  let steps = 0;
  let aborted = false;

  // 循环直到结算提交（Terminal 之后还要 dispatch 一次 settle）。
  // Q-22: `session.completed` 现在就是这个谓词（活 getter + 收窄到 SettlementCommitted），
  // 不必再自己读 phase 绕开它。
  while (!session.completed && steps < MAX_DISPATCH_STEPS) {
    steps++;

    // 终局：dispatch RequestSettlement（C3 幂等）
    if (session.snapshot().phase === 'Terminal') {
      const settleTrans = session.dispatch({
        commandId: `settle-${opts.saveId}`,
        expectedRevision: session.snapshot().revision,
        kind: 'RequestSettlement',
        actorId: '',
        cost: 'none',
        payload: { settlementId: `settle-${opts.saveId}` },
      });
      allEvents.push(...settleTrans.events);
      emitEvents(opts, settleTrans.events, session);
      if (settleTrans.rejection) {
        break;
      }
      break;
    }

    const trans = session.dispatch(currentCommand);
    allEvents.push(...trans.events);
    emitEvents(opts, trans.events, session);

    if (trans.rejection) {
      // 🔴 2026-08-12（Bug 2 修复）：玩家侧 SLOT_EXHAUSTED（攻击槽/动作槽已耗尽仍再点）
      //   **不是系统故障，是玩家误操作** —— 绝不能走熔断 abandon 毁掉整场战斗。
      //   此前这里一律 `if (steps > 3) break`：开局 dispatch 几次后 steps 早超 3，
      //   玩家攻击槽耗尽后再点一次攻击 → SLOT_EXHAUSTED → 直接熔断 → 整场被放弃
      //   （debug 的「战斗被放弃（M2 coordinator abandon）」= 主人看到的页面闪退）。
      //   现在：emit v3_rejection_notice（store 推提示行 + 重新亮等待输入）→ 回到
      //   等待玩家输入，玩家可换动作或点「结束回合」正常推进。
      const rejectedUnit = session.snapshot().units[currentCommand.actorId];
      const isPlayerSide = rejectedUnit?.side === 'player';
      if (isPlayerSide && trans.rejection.code === 'SLOT_EXHAUSTED') {
        if (opts.onCombatEvent) {
          opts.onCombatEvent({
            type: 'v3_rejection_notice',
            code: 'SLOT_EXHAUSTED',
            message: `「${rejectedUnit.name}」${trans.rejection.message}，请换其他行动或点「结束回合」`,
            unit: rejectedUnit.name,
            unitId: rejectedUnit.id,
          });
        }
        // 回到等待玩家输入（decideForUnit 玩家分支会 emit v3_awaiting_player_input
        // 并 submitCommand + waitForCommand；这里照 rejection 恢复路径的重决定写法）。
        const cmds = await decideForUnit(
          currentInitiative(session),
          session,
          routingDeps,
          opts.saveId,
          combatSession,
        );
        pendingCommands.push(...cmds);
        currentCommand = nextPending(pendingCommands, session);
        continue;
      }
      // 🔴 2026-08-12（Bug B 修复）：其余 rejection（含敌方 SLOT_EXHAUSTED /
      //   INVALID_PHASE / stale 等）**一律不再熔断 abandon**。此前 `steps > 3 break`
      //   的熔断出口让敌方一次 SLOT_EXHAUSTED 就整场被放弃（页面闪退真凶）。
      //   现在统一降级：emit v3_rejection_notice（message 用 rejection 原文）+
      //   构造 PassAttack 推进当前单位 —— 战斗继续，最坏情况是单位白费一次行动。
      //   MAX_DISPATCH_STEPS（500）仍是死循环兜底，熔断保护没有整个拆掉。
      if (opts.onCombatEvent) {
        opts.onCombatEvent({
          type: 'v3_rejection_notice',
          code: trans.rejection.code,
          message: trans.rejection.message,
          unit: rejectedUnit?.name,
          unitId: rejectedUnit?.id,
        });
      }
      // 降级推进的单位：命令 actor 仍在场且就是内核当前行动单位 → 用它；
      // 已不在场（TARGET_NOT_PRESENT）/ 张冠李戴 → 用 currentInitiative
      // （否则 PassAttack 会再次被拒，构成 rejection → 降级 → rejection 死循环）。
      const current = currentInitiative(session);
      const passActorId = rejectedUnit && rejectedUnit.id === current ? rejectedUnit.id : current;
      if (!passActorId) {
        // 无当前行动单位（极端空战场）→ 交给主循环（checkTerminal 已保证空战场必终局）
        continue;
      }
      currentCommand = nextPassCommand(session.snapshot().revision, passActorId, 'attack');
      continue;
    }

    // 结算演绎（设计 2026-08-09 §2.5）：数字卡片已由上面的 emitEvents 立即弹出
    // （v3_action），这里把本次 dispatch 的结算事实串（命中/评级/伤害）喂同一持久
    // 会话，AI 写一句结果句，以 v3_narrative 流式进 combatLog（卡片先显示数字、叙事
    // 随后补上）。纯叙事增强三条铁则：不产 Command、不改战斗状态（不影响内核判定
    // 与 Command 消费）；串行 await 保证 append 顺序与主决策消息不错位（前缀稳定）；
    // 失败（无 client / 调用抛错 / 空输出）在 narrateSettlement 内静默降级不注入。
    const facts = collectSettlementFacts(trans.events);
    if (facts.length > 0) {
      const sentence = await narrateSettlement(facts, combatSession);
      emitNarration(sentence);
    }

    if (trans.requiredInput) {
      // F4：两个命令的 dispatch 之间，内核会发 requiredInput（同单位继续）→ 先消费
      // 队列里的下一个命令（同一次 AI 声明的剩余命令），而不是重新调 AI。
      // 🔴 2026-08-12（真机 bug：莫名的槽位耗尽）：**BeginOutput（骰尽续杯）必须优先
      //   注骰，不能先消费队列**。attack 触发 BeginOutput 时，当前 dispatch 被骰尽
      //   中断（ResolutionFrame 挂着、攻击槽消费未提交），必须先 SupplyDice 恢复 frame
      //   才能继续。此前队列优先跳过注骰 → 先 dispatch 队列里的 action（动作槽被消费、
      //   攻击槽因 frame 未恢复仍在）→ 协调器以为乙还有攻击槽 → 又问敌方（浪费一次
      //   AI 调用）→ 第二次 action 撞 SLOT_EXHAUSTED。这就是「莫名的槽位耗尽」的根源。
      if (trans.requiredInput.kind !== 'BeginOutput' && pendingCommands.length > 0) {
        currentCommand = nextPending(pendingCommands, session);
        continue;
      }
      const cmds = await routeRequiredInput(
        trans.requiredInput,
        session,
        {
          ...routingDeps,
          saveId: opts.saveId,
          onPanel: (panel) => {
            if (opts.onCombatEvent) {
              opts.onCombatEvent({ type: 'v3_dice_epoch', outputId: `panel-${panel.length}` });
            }
          },
          combatSession,
        },
        getDice,
      );
      // 🆕 2026-08-12（Bug 修复：攻击撞骰池耗尽被丢 → 玩家必须重输一次）：
      // BeginOutput（骰尽续骰）后**重放被中断的命令**。玩家提交的攻击在内核结算中途
      // （intentCheck / attackHit 通道）骰子耗尽 → reducer 返回 BeginOutput，此时命令
      // **零微步骤已提交**（不伤血、不耗槽）。续骰后把被中断的 currentCommand 排在
      // SupplyDice 之后一起进队列，nextPending 取出时把 expectedRevision 修正为
      // SupplyDice 之后的当前内核 revision（不撞 STALE_REVISION）→ 原样重放，玩家
      // 不用重新输入一次攻击。
      //
      // 🔴 必须造新 commandId：kernel 幂等缓存（AA1-3，kernel.ts dispatch）会缓存
      //   **首次** BeginOutput transition（非 rejection 也缓存），复用原 commandId
      //   → 重放命中缓存直接返回首次 BeginOutput → 死循环注骰直至 MAX_DISPATCH_STEPS
      //   熔断。新 id 保持 kind/payload/actorId/cost 与当前命令逐字节一致（重放语义
      //   不变）；expectedRevision 由 nextPending 修正。
      // 🔴 只重放「命令未消费」的 BeginOutput（snapshot.phase === 'SlotConsume'：
      //   consumePlayerCommand 结算中途骰尽）。其余 BeginOutput（auto 相位骰尽：
      //   Initiative / MoraleCheck / UnitTurnClose 等）时命令可能已提交（伤害已结算、
      //   槽位已消费），重放会 SLOT_EXHAUSTED / 重复结算 → 保持既有行为（丢命令后
      //   decideForUnit 重问）。防死循环：重放后再遇 BeginOutput（续 60 颗新骰后
      //   理论几乎不可能）由 MAX_DISPATCH_STEPS 兜底熔断，无需额外计数器。
      if (trans.requiredInput.kind === 'BeginOutput' && trans.snapshot.phase === 'SlotConsume') {
        pendingCommands.push(...cmds, {
          ...currentCommand,
          commandId: nextCmdId(`retry-${currentCommand.kind}`),
        });
      } else {
        pendingCommands.push(...cmds);
      }
      currentCommand = nextPending(pendingCommands, session);
      continue;
    }

    // 无 requiredInput 且未终局 → 唯一真实场景就是 SupplyDice 刚喂完（phase 仍 CombatOpen，
    // kernel 未自动推进）。此时按**内核当前行动单位**决定其下一个动作，dispatch 时 kernel 会
    // auto 推进 CombatOpen→…→SlotConsume 并消费它。队列优先（同 requiredInput 的兜底）。
    // 🔴 COR-12：这里曾写「先攻首位」，续骰由回合中的非首位单位触发时会带着错误行动者
    // 往下走 → INVALID_PHASE → 整场战斗以空补丁放弃。见 currentInitiative 的注释。
    if (!trans.terminal) {
      if (pendingCommands.length > 0) {
        currentCommand = nextPending(pendingCommands, session);
        continue;
      }
      const cmds = await decideForUnit(
        currentInitiative(session),
        session,
        routingDeps,
        opts.saveId,
        combatSession,
      );
      pendingCommands.push(...cmds);
      currentCommand = nextPending(pendingCommands, session);
      continue;
    }

    if (trans.terminal) {
      // phase 已进 Terminal，下一轮 dispatch RequestSettlement
      continue;
    }
  }

  const finished: boolean = session.snapshot().phase === 'SettlementCommitted';

  if (!finished) {
    // 未完成 → 放弃（C4）：FP 不落库
    aborted = true;
    deps.abandon();
  }

  const rounds = session.snapshot().round;

  if (aborted) {
    return {
      narrativeSummary: '战斗被放弃（M2 coordinator abandon）',
      patches: [],
      totalExp: 0,
      totalFp: 0,
      loot: [],
      rounds,
      outcome: 'draw',
      aborted: true,
    };
  }

  // 终局落库（唯一一次 commitChatState）——A2-1 要求整场只 commit 一次。
  // FP 净变动 = 终局快照 − 开战快照（架构 §十二 12.2 Δ = snapshot.FP − 初始 FP）。
  const finalSnapshot = session.snapshot();
  const initialFp = opts.bundle.resourceSnapshots.FP;
  const finalFp = finalSnapshot.resourceSnapshots.FP;
  const fpDelta = finalFp - initialFp;
  const combatOutcome = outcomeOf(session);
  // §12.4 EXP 结算：ally_win 时按「被杀敌方 level × 战斗系数」求和平分给存活队友。
  const expReward = buildExpRewardPatches(
    finalSnapshot.units,
    opts.bundle.participants,
    deps.characters,
    combatOutcome,
  );
  // T10（设计 2026-08-09 §2.6 方案 1）：终局 Code 覆写回写 —— 把战斗结束时的单位
  // 资源（hp/mp/sp）与状态效果按 characterId 匹配存档角色，生成 StatePatch 与 FP
  // patch **合并进同一次 commitChatState**（A2-1：整场只 commit 一次，不开第二次）。
  // 召唤物（characterId 匹配不到存档角色）跳过，不硬造角色。
  const patches = [
    ...toPatches(allEvents, opts.bundle, fpDelta),
    ...expReward.patches,
    ...buildUnitPersistPatches(finalSnapshot.units, deps.characters, opts.bundle.participants),
  ];
  if (deps.stateManager) {
    await deps.stateManager.commitChatState(patches);
  }

  // 🆕 战斗终局 AI 总结（2026-08-12）：终局结算完成后，把整场战斗事实喂持久会话，
  // AI 写一段面向玩家的战斗总结叙事（替代「战斗直接中断、只靠战斗中 write_summary
  // 收集」）。顺序刻意如此：commitChatState 先落库（战斗结果铁定保存）→ 总结（失败
  // 只损失叙事，不阻塞主流程）→ 优先级 endSummary || collectedSummary || 兜底
  // （总结失败回落既有兜底语义，game-pipeline 照常注入【战斗摘要】，不崩）。
  const endFacts = collectCombatEndFacts(session, initialFp, opts.bundle.participants);
  const endSummary = await narrateCombatEnd(endFacts, combatSession);

  // T11（设计 2026-08-09 §2.2 write_summary 改造）：终局摘要回注正文 —— 用 AI 经
  // write_summary(text) 收集进 combatSession.summary 的文本；没有摘要（AI 从未调 /
  // 全部空文本）→ 兜底「战斗结束（reason）」非空文本，game-pipeline 照常注入，不崩。
  const collectedSummary = (combatSession.summary ?? '').trim();

  return {
    narrativeSummary:
      endSummary ||
      collectedSummary ||
      `战斗结束（${session.snapshot().terminal?.reason ?? 'terminal'}）`,
    patches,
    totalExp: expReward.totalExp,
    totalFp: finalFp,
    loot,
    rounds,
    outcome: combatOutcome,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// RequiredInput 路由（A2-3 穷尽 switch）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 战斗 Agent 持久会话消息（设计 2026-08-09 §2.1 决策 1A）：
 * agent-client ChatRequest.messages 的等价形状（含工具往返字段）。模块局部类型，
 * 非全局；对应全局契约在 agent-client 的 ChatRequest.messages 与
 * combat-v2-types 的 CombatClient.chatWithTools.request.messages。
 */
interface CombatAgentMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * 持久会话句柄（决策 1A）：一场战斗一个 client + 一条消息数组，挂在 coordinator 闭包。
 *  - messages：整场战斗累积的对话（system 只 append 一次；每回合 user → 工具往返 → assistant）
 *  - client：整场战斗复用的 combat_v3 client（首次需要时经 clientFactory 建，之后不再新建）
 * 省略（直捣路由的测试）时 routeEnemyCommand 回退到调用内的临时句柄，行为与一次性会话等价。
 */
interface CombatSessionHandle {
  messages: CombatAgentMessage[];
  client: CombatClient | null;
  /**
   * 终局摘要收集（T11，设计 2026-08-09 §2.2 write_summary 改造）：AI 调
   * write_summary(text) 时经 collectSummaryFromToolCalls 存入；终局时
   * runCombatV3 用它回注正文（narrativeSummary）。多段调用追加合并；
   * 缺省空串（没有摘要时终局走兜底文本）。
   */
  summary?: string;
}

interface RouteCtx {
  submitCommand: (cmd: CombatCommand) => Promise<void>;
  waitForCommand: () => Promise<CombatCommand>;
  /** 🎭 主持人/DM 模式（2026-08-12）：等玩家**意图文本** → 主持人解析 → Command */
  waitForPlayerIntent?: () => Promise<string>;
  abandon: () => void;
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => CombatClient;
  endpoint: ApiEndpoint;
  saveId: string;
  onPanel?: (panel: string) => void;
  /** M3.5：char_gen 战斗中调用所需的 AgentContext / characters（供 runCharGenForCombat 基座） */
  context?: AgentContext;
  characters?: Array<Record<string, unknown>>;
  configs?: import('../types').AgentConfig[];
  worldBooks?: import('../types').WorldBook[];
  presets?: import('../types').AgentPreset[];
  /** T2（2026-08-10）：模板系统上下文（开局 user 情境快照的数据源，全部可选） */
  combatBrief?: string;
  combatRoster?: string;
  userInput?: string;
  storyOutput?: string;
  history?: unknown[];
  /**
   * 持久会话句柄（设计 2026-08-09 §2.1 决策 1A）：整场战斗一个 client + 一条消息数组，
   * 由 runCombatV3 闭包持有并注入；routeEnemyCommand 读/写。省略时回退到调用内的
   * 临时句柄（一次性会话行为，直捣路由的测试可用）。
   */
  combatSession?: CombatSessionHandle;
  /**
   * 声明演绎通道（设计 2026-08-09 §2.5）：routeEnemyCommand 拿到 assistant 正文
   * （1-3 句战斗演绎，随 declare_attack 工具调用一并产出）时回调；runCombatV3 注入
   * emitNarration（emit v3_narrative）投进 combatLog。可省略（不关心叙事的直捣测试）。
   */
  onNarration?: (text: string) => void;
  /**
   * 玩家输入等待事件通道（T16，设计 2026-08-09 §3.1）：玩家单位轮到需要输入时 emit
   * v3_awaiting_player_input，game-store 据此置 combatAwaitingInput。由 runCombatV3
   * 经 routingDeps 注入（= opts.onCombatEvent）。仅 player 阵营 emit；可省略。
   */
  onCombatEvent?: (evt: CombatEvent) => void;
}

/** 骰子供应回调类型（闭包传入） */
type DiceSupplier = () => { outputId: string; dice: number[] };

/**
 * 内核处在**某个单位的回合之中**的 phase —— 只有这几个 phase 下 `currentTurnIndex`
 * 才真的指向「该被问下一条命令的那个单位」。
 */
const UNIT_TURN_PHASES: ReadonlySet<string> = new Set([
  'UnitTurnOpen',
  'SlotConsume',
  'MoraleCheck',
  'UnitTurnClose',
]);

/**
 * 续骰 / rejection 恢复时该问哪个单位（COR-12）。
 *
 * **回合中**（`UNIT_TURN_PHASES`）用 `initiativeOrder[currentTurnIndex]`：
 * SupplyDice 续骰由谁触发就该恢复给谁（attackHit / intentCheck / statusContest /
 * procCheck 任一通道耗尽都会续骰），而回合中触发它的多半不是先攻首位。此前一律返回
 * `initiativeOrder[0]`，于是下一条命令带着错误行动者 → `consumeSlot` 以 `INVALID_PHASE`
 * 拒绝 → coordinator 跳出并以空补丁**放弃整场战斗**。
 *
 * 🔴 **其余 phase 一律退回 `initiativeOrder[0]`，因为那时 `currentTurnIndex` 是陈旧的**
 * （2026-08-10 审查逮到 —— 初版这里没有分流，在最常见的那条续骰路径上反而更差）：
 *
 *   - `unit-turn.ts` 收尾最后一个单位时 `nextIndex >= order.length` → **不写**
 *     `currentTurnIndex`，它停在 `len-1`；`round.ts` 的 open/close 都不碰它。
 *   - `initiative.ts` 骰子耗尽时 `return out` **早于** `out.currentTurnIndex = 0`。
 *   - `reduceSupplyDice` 原样保留 phase、零推进。
 *
 * 于是 initiative 通道耗尽（它只有 10 颗，4 个单位打到第 3 轮必然发生）走到这里时，
 * phase 仍是 `Initiative` 而索引是**上一轮先攻末位**。两个值其实都只是猜——正确行动者要等
 * 内核用新骰子重掷先攻才知道——但上一轮首位（先攻修正不变）比上一轮末位更可能仍是首位。
 * 这条路上不做「改进」，保持既有行为。
 *
 * 索引钳制与 `phases/unit-turn.ts` 的 `currentUnitId` 一致（那边吃 CombatState，
 * 这边只拿得到 CombatView，故不能直接复用）。
 */
export function currentInitiative(session: CombatSession): string {
  const view = session.snapshot();
  const order = view.initiativeOrder;
  if (order.length === 0) return '';
  if (!UNIT_TURN_PHASES.has(view.phase)) return order[0] ?? '';
  return order[Math.min(view.currentTurnIndex, order.length - 1)] ?? '';
}

/**
 * 决定某个单位的第一个/下一个动作 Command 列表（按阵营分流：玩家 → store；敌方 → Agent）。
 * 返回数组：敌方 Agent 一次声明可产多个命令（F4：attack+action 逐条 dispatch）；
 * 玩家侧契约仍是单命令（submitCommand + waitForCommand 一次一个），包成单元素数组统一。
 * 与 routeRequiredInput 的 PlayerCommand 分支共用逻辑。
 * combatSession：持久会话句柄（决策 1A），透传给 routeEnemyCommand；可省略（一次性会话）。
 */
function decideForUnit(
  unitId: string,
  session: CombatSession,
  deps: RunCombatV3Opts['deps'],
  saveId: string,
  combatSession?: CombatSessionHandle,
): Promise<CombatCommand[]> {
  const snapshot = session.snapshot();
  const unit = snapshot.units[unitId];
  const rev = snapshot.revision;
  const unitName = unit?.name ?? unitId;
  const ctx: RouteCtx = { ...deps, saveId, combatSession };
  if (unit?.side === 'player') {
    return Promise.resolve().then(async () => {
      // T16：轮到玩家单位需要输入 → emit 等待事件（store 置 combatAwaitingInput）。
      // 仅 player 阵营 emit；必须抢在 submitCommand/waitForCommand 之前（UI 据此亮
      // 「等待玩家输入」，随后 submit 才有消费者）。
      ctx.onCombatEvent?.({
        type: 'v3_awaiting_player_input',
        unit: unitName,
        unitId,
        round: snapshot.round,
      });
      // 🎭 主持人/DM 模式（2026-08-12）：玩家输入走意图文本 → 主持人解析 → Command。
      // 生产（game-pipeline）注入 submitPlayerIntent/waitForPlayerIntent；直捣路由的
      // 测试没注入时回退旧路径（submitCommand/waitForCommand 拿 Command）。
      if (ctx.waitForPlayerIntent) {
        const intent = await ctx.waitForPlayerIntent();
        const res = await routePlayerIntent(
          intent,
          { kind: 'PlayerCommand', unitId, unitName, round: snapshot.round },
          session,
          ctx,
        );
        return res.commands;
      }
      await deps.submitCommand(nearestCommand(rev, unitId, unitName));
      // UI 提交的 command 可能 revision 过期，统一修正为内核当前值（乐观并发契约）
      return [await freshRevision(deps.waitForCommand(), session)];
    });
  }
  // 敌方 → 战斗 Agent：声明演绎（narration）已由 routeEnemyCommand 经 ctx.onNarration
  // 投进 combatLog，这里只取 commands 进内核（§2.5）。
  return routeEnemyCommand(
    { kind: 'PlayerCommand', unitId, unitName, round: snapshot.round },
    session,
    ctx,
  ).then((res) => res.commands);
}

/** 把前端返回的 Command 的 expectedRevision 修正为内核当前 revision（防 stale） */
async function freshRevision(
  p: Promise<CombatCommand>,
  session: CombatSession,
): Promise<CombatCommand> {
  const cmd = await p;
  return { ...cmd, expectedRevision: session.snapshot().revision };
}

/**
 * 从待执行命令队列取下一个命令并修正 revision（F4 多命令队列）：
 * 同一次 AI 声明的多个命令在 routeEnemyCommand 时共用当时的 revision，而前一个命令
 * dispatch 后内核 revision 已 +1 → 后续命令若不修正会 STALE_REVISION rejection。
 * 照 freshRevision（玩家命令）先例：dispatch 前统一修正为内核当前值（乐观并发契约）。
 */
function nextPending(pending: CombatCommand[], session: CombatSession): CombatCommand {
  const cmd = pending.shift()!;
  return { ...cmd, expectedRevision: session.snapshot().revision };
}

/**
 * 把 RequiredInput 路由到对应去处，返回应 dispatch 的下一条 Command 列表。
 * 返回数组：敌方 PlayerCommand 分支（routeEnemyCommand）一次声明可产多个命令
 * （F4：attack+action 逐条 dispatch）；其余分支恒为单元素数组。
 * 穷尽 switch：新增 RequiredInput 变体未接路由则编译失败（A2-3）。
 * 导出供测试直捣（M3.5）。
 */
export async function routeRequiredInput(
  req: RequiredInput,
  session: CombatSession,
  ctx: RouteCtx,
  getDice: DiceSupplier,
): Promise<CombatCommand[]> {
  switch (req.kind) {
    case 'PlayerCommand': {
      const unit = session.snapshot().units[req.unitId];
      const side = unit ? unit.side : undefined;
      if (side === 'player') {
        // T16：玩家单位轮次 → emit 等待事件（store 置 combatAwaitingInput），
        // 抢在 submitCommand/waitForCommand 之前。仅 player 阵营 emit。
        ctx.onCombatEvent?.({
          type: 'v3_awaiting_player_input',
          unit: req.unitName,
          unitId: req.unitId,
          round: session.snapshot().round,
        });
        // 🎭 主持人/DM 模式（2026-08-12）：玩家意图文本 → 主持人解析 → Command。
        // 生产注入 waitForPlayerIntent；直捣路由测试没注入时回退旧 Command 路径。
        if (ctx.waitForPlayerIntent) {
          const intent = await ctx.waitForPlayerIntent();
          return (await routePlayerIntent(intent, req, session, ctx)).commands;
        }
        // → game-store，等前端（Promise 在 coordinator 侧）；修正 revision
        await ctx.submitCommand(
          nearestCommand(session.snapshot().revision, req.unitId, req.unitName),
        );
        return [await freshRevision(ctx.waitForCommand(), session)];
      }
      // 敌方 → 战斗 Agent（声明演绎经 ctx.onNarration 进 combatLog，这里只取 commands）
      return (await routeEnemyCommand(req, session, ctx)).commands;
    }
    case 'BeginOutput': {
      // 注骰：调 getDice 取新 60 颗 → SupplyDice
      const d = getDice();
      return [supplyCommand(ctx.saveId, session, d)];
    }
    case 'EffectChoice':
      // M3.5 决定：EffectChoice 仍由 M4/后续实现（plan §6.7 只要求替换 CharGenRequest /
      // BoundedAdjudication 两路由）；这里保留显式 throw。
      throw new UnsupportedInM2('EffectChoice');
    case 'BoundedAdjudication':
      // M3.5：去内核 evaluateAdjudication 验证 → Adjudicate Command（或 EffectRejected 流回）
      return [await routeAdjudication(req, session)];
    case 'CharGenRequest':
      // M3.5：召唤出口（A35-1）——先查预生成池，未命中走实时 char_gen，再 SupplyUnit
      return [await routeCharGenRequest(req, session, ctx)];
    default: {
      const _exhaustive: never = req;
      throw new Error(`未知 RequiredInput：${String(_exhaustive)}`);
    }
  }
}

/**
 * M3.5（plan §6.2 ③-⑤）：路由 CharGenRequest。
 *
 * 时序：③a 先查预生成召唤物池（§6.4）→ 命中直接构造 definition；
 *       ③b 未命中 → await runCharGenForCombat（char-gen-agent.ts 新入口，不落库）
 *       ④ 解析校验 SummonedUnitDefinition（divinity ≤ cap clamp + warn / 属性预算超则等比缩放 /
 *          joinTiming 缺省 next_round_head / 自带 automaton 编译失败剔除不阻断）
 *       ⑤ 提交 { kind:'SupplyUnit', payload:{ requestId, definition } }
 */
async function routeCharGenRequest(
  req: Extract<RequiredInput, { kind: 'CharGenRequest' }>,
  session: CombatSession,
  ctx: RouteCtx,
): Promise<CombatCommand> {
  // ③a 先查池（幂等，命中直接用）
  let definition = lookupSummon(req.prompt);

  // ③b 未命中 → 实时 char_gen（不落库）
  if (!definition) {
    definition = await runCharGenForCombat(
      {
        prompt: req.prompt,
        constraints: req.constraints,
        base: {
          saveId: ctx.saveId,
          context: ctx.context ?? ({} as AgentContext),
          endpoint: ctx.endpoint,
          configs: ctx.configs,
          worldBooks: ctx.worldBooks,
          presets: ctx.presets,
        },
      },
      { clientFactory: ctx.clientFactory as never },
    );
  }

  // ④ clamp / validate（divinity ≤ cap，joinTiming 缺省 next_round_head）
  definition = clampSummon(definition, req.constraints);

  // ⑤ SupplyUnit
  return {
    commandId: nextCmdId(`summon-${req.requestId}`),
    expectedRevision: session.snapshot().revision,
    kind: 'SupplyUnit',
    actorId: req.prompt.sourceItem,
    cost: 'none',
    payload: { requestId: req.requestId, definition },
  };
}

/**
 * M3.5（plan §6.5 / 架构 §十一 11.2）：路由 BoundedAdjudication。
 *
 * 内核 evaluateAdjudication 验证由 **reducer** 在消费 Adjudicate Command 时执行（它持有完整
 * CombatState，能验 target.divinity 与不变量）；coordinator 只负责把提案转成 Adjudicate Command
 * 提交内力。reducer 侧 accepted → AdjudicationAccepted + RuleOverridden/MiracleTriggered + journal；
 * rejected → EffectRejected(code:'ADJUDICATION_REJECTED')（零状态变更零骰耗）。
 */
async function routeAdjudication(
  req: Extract<RequiredInput, { kind: 'BoundedAdjudication' }>,
  session: CombatSession,
): Promise<CombatCommand> {
  return {
    commandId: nextCmdId('adjudicate'),
    expectedRevision: session.snapshot().revision,
    kind: 'Adjudicate',
    actorId: req.unitId,
    cost: 'none',
    payload: { requestId: `adj-${req.unitId}`, adjudication: req.proposal },
  };
}

/**
 * M3.5（plan §6.2 ④）：clamp / validate SummonedUnitDefinition。
 *   - divinity > constraints.divinityCap → clamp + warn（不 reject）
 *   - joinTiming 缺省 → 'next_round_head'（保不变量①纯洁）
 *   - 纯函数：返回新对象，入参不被修改
 */
function clampSummon(
  d: SummonedUnitDefinition,
  constraints: { divinityCap: number },
): SummonedUnitDefinition {
  let next: SummonedUnitDefinition = { ...d };
  if (d.divinity > constraints.divinityCap) {
    // 超出 cap → clamp + warn（架构 §6.2 ④）
    console.warn(
      `[coordinator] 召唤物「${d.name}」divinity ${d.divinity} 超 cap ${constraints.divinityCap}，已 clamp`,
    );
    next = { ...next, divinity: constraints.divinityCap };
  }
  if (!next.joinTiming) {
    next = { ...next, joinTiming: 'next_round_head' };
  }
  return next;
}

/**
 * 战斗 Agent 的 system prompt 解析（设计 2026-08-09 §2.7）：
 * 主来源 agent-config 的 `agents.combat_v3.systemPrompt`（从 configs 按 agentId 找，
 * 照 char_gen/item_gen 读 configs 的先例）；取不到（未透传 / 字段缺失或全空白）时
 * 回退 FALLBACK_COMBAT_SYSTEM_PROMPT，保证无配置环境下行为与改造前一致。
 */
function combatSystemPrompt(ctx: RouteCtx): string {
  const cfg = ctx.configs?.find((c) => c.agentId === 'combat_v3');
  const prompt = cfg?.systemPrompt;
  return prompt && prompt.trim().length > 0 ? prompt : FALLBACK_COMBAT_SYSTEM_PROMPT;
}

/**
 * T2（2026-08-10）：开局第一条 user 消息 = Phase 10 模板渲染结果（情境快照）。
 *
 * 模板来源（三级回退）：
 *   1. ctx.configs 里 combat_v3 的 `template` 字段（agent-config.json 真源）
 *   2. getDefaultTemplate('combat_v3')（registry 默认模板；当前未注册 → 空串）
 *   3. 空 → 现状硬编码（「轮到敌方X行动 + 面板」，与改造前逐字一致）
 *
 * localParams 注入（优先级高于 registry，见 template-resolver）：
 *   - COMBAT_BRIEF  ← ctx.combatBrief（空给「（无战斗指令）」占位说明）
 *   - COMBAT_ROSTER ← ctx.combatRoster（我方/敌方名单；空给「（无参战方名单）」占位说明）
 *   - USER_INPUT   ← ctx.userInput（回落 ctx.context.userInput）
 *   - AGENT.STORY  ← ctx.storyOutput（仅显式非空时注入；否则回落 registry 的
 *                     agentOutputs.story 路径）
 *   - SYS_PROMPT   ← ''（system 消息已单独承载 systemPrompt，user 内不重复）
 *   - COMBAT_PANEL ← 当前面板（agent-config 现存模板仍引用 {{COMBAT_PANEL}}；
 *                     T3 替换模板后此键多余但无害）
 *   NARRATIVE / LORE_BOOK_STATIC 走 registry：前者读 tplCtx.history；后者经
 *   getEntriesForAgent（按 config.worldBookIds 过滤）→ filterActiveEntries →
 *   renderWorldBookEntries。EJS 走 fail-closed 退化（生产 QuickJS 下不求值、
 *   原文注入并记回退——与 buildAgentMessages 的同步兜底路同口径）。
 *
 * 严格一次：仅在持久会话 messages 为空（首轮决策）时调用；后续轮次 append 轮次消息。
 */
function renderOpeningCombatMessage(ctx: RouteCtx, panel: string, unitName: string): string {
  const cfg = ctx.configs?.find((c) => c.agentId === 'combat_v3');
  const template = cfg?.template?.trim() || getDefaultTemplate('combat_v3');
  if (!template) {
    return `轮到敌方「${unitName}」行动（我方单位由玩家控制）。\n\n${panel}`;
  }
  const tplCtx: AgentContext = {
    ...(ctx.context ?? ({} as AgentContext)),
    userInput: ctx.userInput ?? ctx.context?.userInput ?? '',
    history: (ctx.history ?? ctx.context?.history ?? []) as ChatMessage[],
  };
  const localParams: Record<string, string> = {
    SYS_PROMPT: '',
    COMBAT_BRIEF: (ctx.combatBrief ?? '').trim() || '（无战斗指令）',
    COMBAT_ROSTER: (ctx.combatRoster ?? '').trim() || '（无参战方名单）',
    USER_INPUT: tplCtx.userInput,
    COMBAT_PANEL: panel,
  };
  if (ctx.storyOutput) {
    localParams['AGENT.STORY'] = ctx.storyOutput;
  }
  const resolved = resolveTemplateWithGlobals(
    template,
    'combat_v3',
    tplCtx,
    cfg ?? ({ agentId: 'combat_v3' } as AgentConfig),
    ctx.worldBooks ?? [],
    ctx.configs ?? [],
    localParams,
  );
  // 渲染结果为空（极端路径）→ 兜底现状硬编码，绝不发空 user 消息
  return resolved.trim().length > 0
    ? resolved
    : `轮到敌方「${unitName}」行动（我方单位由玩家控制）。\n\n${panel}`;
}

/**
 * F5（2026-08-10）：开局氛围 user 消息 —— 明确指令 + 情境快照（模板渲染）+ 先攻说明。
 *
 * 指令在前（AI 先看到「描写氛围、禁止命令」再看快照）；情境快照复用
 * renderOpeningCombatMessage 的三区渲染（有模板时）；无模板（无 configs / 无 registry
 * 模板）→ 只有面板（projectToAgent 的 <action_info>）。
 *
 * 先攻说明：先攻由**内核**在首个真实 Command dispatch 时自动掷定（phases/initiative.ts），
 * 开局调用发生在注骰之前，initiativeOrder 必然为空 → 注入「由内核掷定」说明，不空口
 * 编序列；若快照已有（防御性，未来时序变化时生效）则注入真实序列。AI 想拿更多信息
 * 可调 get_combat_state（返回与面板同源的战况总览）。
 */
function buildOpeningSceneMessage(ctx: RouteCtx, panel: string, session: CombatSession): string {
  const cfg = ctx.configs?.find((c) => c.agentId === 'combat_v3');
  const hasTemplate = !!(cfg?.template?.trim() || getDefaultTemplate('combat_v3'));
  const snapshotText = hasTemplate ? renderOpeningCombatMessage(ctx, panel, '') : panel;
  const view = session.snapshot();
  const initiativeLine =
    view.initiativeOrder.length > 0
      ? `先攻序列: ${view.initiativeOrder.map((id) => view.units[id]?.name ?? id).join(' → ')}`
      : '先攻序列: 由内核掷定（首个行动轮揭晓）';
  return [
    '【战斗开场】战斗即将开始。请描写战场氛围与双方对峙的场面（1-3 句），并可调用工具（get_combat_state / get_unit_detail 等）确认战况。',
    '这是开场氛围描写：**禁止提交任何战斗命令**（declare_attack / declare_action 等），命令留到行动轮。',
    '',
    snapshotText,
    initiativeLine,
  ].join('\n');
}

/**
 * F5（2026-08-10）：开局先调一次 AI 构建战斗场景 —— 氛围描写 + 信息获取。
 *
 * 时序：runCombatV3 在 F1 开局事件 emit 之后、正式回合循环（SupplyDice）之前调用。
 * 复用持久会话（combatSession + clientFactory，与 routeEnemyCommand 同一句柄）：
 * messages 为空时先 append system（combatSystemPrompt）+ 开局 user（buildOpeningSceneMessage），
 * 再让 AI 输出氛围描写 —— 前缀稳定，开局内容保留进历史（后续决策可见情境快照）。
 *
 * 工具分流（氛围阶段不决策）：查询工具（get_*）经 executeCombatQuery 返回数据给模型；
 * write_summary 回确认；命令类工具 → 返回错误 ToolResult 回喂模型（不产 Command）。
 * AI 输出（assistant content）= 氛围描写 → 经 emitNarration（v3_narrative）进 combatLog。
 *
 * 失败静默降级（三档）：无 configs（调用方已判据跳过，这里不重复）→ 无 client /
 * client 无 chatWithTools → 直接返回；chatWithTools 抛错 → 回滚本调用 push 的
 * messages（length 截断，含 system——恢复为调用前原样，后续 routeEnemyCommand 首轮
 * 正常初始化），不阻塞战斗。工具往返回流照 routeEnemyCommand 同款（查询结果保留进历史）。
 */
async function openCombatScene(
  session: CombatSession,
  ctx: RouteCtx,
  handle: CombatSessionHandle,
  emitNarration: (text: string) => void,
): Promise<void> {
  // client 惰性建（照 routeEnemyCommand）：整场战斗复用同一 combat_v3 client
  if (!handle.client) {
    handle.client = ctx.clientFactory('combat_v3', ctx.endpoint, ctx.saveId);
  }
  const client = handle.client;
  if (!client || typeof client.chatWithTools !== 'function') return;

  const panel = projectToAgent(session.snapshot());
  if (ctx.onPanel) ctx.onPanel(panel);

  const messages = handle.messages;
  const beforeLen = messages.length;
  // system 只 append 一次（整场战斗开头；messages 为空 = 首个敌方决策前从未注入）
  if (beforeLen === 0) {
    messages.push({ role: 'system', content: combatSystemPrompt(ctx) });
  }
  messages.push({ role: 'user', content: buildOpeningSceneMessage(ctx, panel, session) });

  let sceneText = '';
  try {
    const result = await client.chatWithTools(
      {
        messages,
        tools: getToolsForAgent('combat_v3'),
      },
      // 查询/命令分流（氛围阶段不决策）：查询类返回数据；write_summary 回确认；
      // 命令类 → 错误 ToolResult 回喂模型（绝不产 Command，与 §2.2 决策 3C 同口径）。
      (name, args) => {
        if (isCombatQueryTool(name)) {
          return executeCombatQuery(name, args, session, ctx);
        }
        if (name === 'write_summary') {
          return Promise.resolve(collectCombatSummary(args));
        }
        return Promise.resolve({
          error: `【开局氛围阶段】禁止提交战斗命令「${name}」——战斗尚未开始，请先描写战场氛围，命令留到行动轮。`,
        } as ToolResult);
      },
      { maxRounds: MAX_TOOL_ROUNDS },
    );
    // 工具往返回流持久数组（查询结果保留进历史，与 routeEnemyCommand 同款）
    appendToolRoundtrip(messages, result.toolCalls ?? []);
    sceneText = (result.output ?? result.rawResponse ?? '').trim();
    if (sceneText.length > 0) {
      messages.push({ role: 'assistant', content: sceneText });
    }
  } catch {
    // 失败静默降级：回滚本调用 push 的消息（含 system），恢复调用前原样
    messages.length = beforeLen;
    return;
  }
  // 氛围描写 → combatLog（叙事通道失败也不阻塞战斗）
  try {
    if (sceneText.length > 0) emitNarration(sceneText);
  } catch {
    // 叙事通道异常静默（与 narrateSettlement 的降级口径一致）
  }
}

/**
 * 通用「主持人路由」：把一次决策请求交给战斗主持人会话（chatWithTools）+ 工具 → Command。
 *
 * 🎭 2026-08-12（主持人/DM 模式改造）：combat_v3 的定位从「敌方专属决策器」改为
 * **战斗主持人** —— 同一个持久会话贯穿整场，同时服务两侧：
 *   - 玩家轮次（routePlayerIntent）：user 消息 = 【玩家意图】文本 → 主持人分析玩家
 *     想做什么 → 调 declare_* 工具替玩家声明动作（玩家说攻击就攻击、说防御就防御）
 *   - 敌方轮次（routeEnemyCommand）：user 消息 = 轮到敌方X → 主持人扮演敌方决策
 *   - 结算演绎（narrateSettlement）：走同一会话写结果句
 * 两条路共用 handle.messages + handle.client（决策 1A），system 只 append 一次；
 * 前缀稳定 → LLM 前缀缓存命中。buildUserContent 由调用方按「玩家/敌方」构造首轮与
 * 后续轮次的 user 消息；缺省行为由 routeEnemyCommand / routePlayerIntent 各自封装。
 *
 * 持久会话（设计 2026-08-09 §2.1 决策 1A）：整场战斗一个 client + 一条消息数组
 * （ctx.combatSession，由 runCombatV3 闭包持有）。system 只 append 一次；每回合
 * append user → chatWithTools（回合内工具往返在 agent-client 内部循环）→ 按
 * result.toolCalls 把工具往返回流进持久数组 → append 最终 assistant 正文。
 * 省略 combatSession（直捣路由的测试）→ 调用内临时句柄，一次性会话行为。
 *
 * 返回值：{ commands, narration }——
 *   - commands：照旧进内核（commandsFromResult，收集**全部**命令类工具调用，按调用序；
 *     AI 一次声明 attack+action 两个命令 → [attackCmd, actionCmd]，主循环逐条 dispatch）
 *   - narration：声明演绎 = assistant content（1-3 句战斗演绎，随命令工具一并产出），
 *     同时经 ctx.onNarration 投进 combatLog（v3_narrative）；空正文时为空串。
 */
export async function routeHostCommand(
  req: { unitId: string; unitName: string; round: number },
  session: CombatSession,
  ctx: RouteCtx,
  buildUserContent: (panel: string, firstDecision: boolean) => string,
): Promise<{ commands: CombatCommand[]; narration: string }> {
  const panel = projectToAgent(session.snapshot());
  if (ctx.onPanel) ctx.onPanel(panel);

  const handle = ctx.combatSession ?? { messages: [], client: null };
  // client 只建一次：整场战斗复用同一 combat_v3 client，不再每单位每行动新建
  if (!handle.client) {
    handle.client = ctx.clientFactory('combat_v3', ctx.endpoint, ctx.saveId);
  }
  const client = handle.client;
  if (!client || !client.chatWithTools) {
    // 无 agent → 让当前单位过（defensive：pass 攻击槽推进）
    return { commands: [nextPass(session, 'attack')], narration: '' };
  }

  const messages = handle.messages;
  // 首轮判定：messages 为空 = 整场战斗的第一个决策（client 刚建、system 未注入）。
  // system 只 append 一次（整场战斗开头的首个决策时注入）
  const firstDecision = messages.length === 0;
  if (firstDecision) {
    messages.push({ role: 'system', content: combatSystemPrompt(ctx) });
  }
  // T2（2026-08-10）：首轮 user = 模板渲染结果（情境快照，含战斗指令/世界设定/玩家输入/
  // 触发正文/最近对话）；后续轮次只 append 面板增量（buildUserContent 构造），不再渲染模板。
  if (firstDecision) {
    messages.push({ role: 'user', content: renderOpeningCombatMessage(ctx, panel, req.unitName) });
  } else {
    messages.push({ role: 'user', content: buildUserContent(panel, false) });
  }

  // 🔴 tools 必须显式注入（2026-08-08 真机 bug）：此前 `tools: undefined` 且
  //    agent-client 不自动注入 → 模型收不到 declare_attack 的 schema → 只能文本猜
  //    参数名（target≠targetName）→ toolCalls 空 → 战斗 agent 每步 pass → abandon。
  //    先例：char_gen/item_gen/craft_gen 都在调用点显式 getToolsForAgent()，照抄。
  const result = await client.chatWithTools(
    {
      // 传持久数组本身：chatWithTools 内部 `const conversation = [...request.messages]`
      // 复制后在其副本上做回合内往返，不会改写我们的数组，只读引用无副作用。
      messages,
      tools: getToolsForAgent('combat_v3'),
    },
    // 查询/命令分流（设计 2026-08-09 §2.2 决策 3C，问题 2 根治）：命令类 → toolCallToCommand
    // 产 Command；查询类 → executeCombatQuery 返回数据给模型、不产 Command；收集类
    // （write_summary，T11）→ collectCombatSummary 返回确认、text 由 collectSummaryFromToolCalls
    // 收集。三类工具永不落 toolCallToCommand 的 default 变静默 pass。
    (name, args) => {
      if (isCombatQueryTool(name)) {
        return executeCombatQuery(name, args, session, ctx);
      }
      if (name === 'write_summary') {
        // T11：write_summary 是收尾收集动作，不产 Command —— 返回确认 ToolResult 给
        // 模型即可（text 的收集在下方统一扫描 result.toolCalls 做，单一收集点）。
        return Promise.resolve(collectCombatSummary(args));
      }
      return toolCallToCommand(name, args, session.snapshot().revision, req.unitId, session);
    },
    { maxRounds: MAX_TOOL_ROUNDS },
  );

  // T11（设计 2026-08-09 §2.2 write_summary 改造）：终局摘要收集 —— 扫描本次回合的
  // 工具调用，把 write_summary(text) 收进 combatSession.summary（终局回注正文用）。
  // 放在统一收口处而非 executor 内部：真实 agent-client 会执行 executor，但测试 mock
  // （不执行 executor、直接回 toolCalls 的先例）同样要能收集 —— 单一收集点不依赖
  // executor 是否被调。
  collectSummaryFromToolCalls(result.toolCalls ?? [], handle);

  // 工具往返回流持久数组（决策 1A/3）：回合内的 assistant(tool_calls) ↔ tool 结果消息
  // 只活在 chatWithTools 的内部副本里，这里按 result.toolCalls（name/args/result 按执行序）
  // 重建回流 —— 查询工具结果（get_* 数据）随之完整保留进历史，后续轮次可见。重建消息对
  // API 合法：tool_call_id ↔ assistant.tool_calls.id 一一对应（id 用确定性序号，铁律 1）。
  appendToolRoundtrip(messages, result.toolCalls ?? []);
  // 最终决策正文（assistant content，含声明演绎）也保留进历史
  const finalText = result.output ?? result.rawResponse;
  const narration = (finalText ?? '').trim();
  if (narration.length > 0) {
    messages.push({ role: 'assistant', content: narration });
  }
  // 声明演绎（§2.5）：随 declare_attack 的 assistant content 一起产出 → 投进 combatLog
  if (narration.length > 0) {
    ctx.onNarration?.(narration);
  }

  return {
    commands: commandsFromResult(result, session.snapshot().revision, req.unitId, session),
    narration,
  };
}

/**
 * 敌方 PlayerCommand → 战斗主持人扮演敌方决策。
 * （主持人/DM 模式，2026-08-12：routeEnemyCommand 变成 routeHostCommand 的敌方封装。）
 * user 消息：轮到敌方「X」行动（我方单位由玩家控制）+ 面板。
 */
export async function routeEnemyCommand(
  req: Extract<RequiredInput, { kind: 'PlayerCommand' }>,
  session: CombatSession,
  ctx: RouteCtx,
): Promise<{ commands: CombatCommand[]; narration: string }> {
  return routeHostCommand(
    req,
    session,
    ctx,
    (panel) => `轮到敌方「${req.unitName}」行动（我方单位由玩家控制）。\n\n${panel}`,
  );
}

/**
 * 🆕 玩家意图 → 战斗主持人解析 → Command（主持人/DM 模式，2026-08-12）。
 *
 * 玩家轮次：前端把玩家输入（拼装格式化文本 / 自由对话）经 submitPlayerIntent 提交，
 * coordinator 等意图文本 → 本函数把【玩家意图】文本 append 进同一主持人持久会话 →
 * 主持人分析玩家想做什么 → 调 declare_* 工具替玩家声明动作（Command 仍由内核校验消费）。
 *
 * 与敌方分支（routeEnemyCommand）共用 handle.messages + handle.client（决策 1A）：
 * 主持人有全程记忆，既记得玩家说过什么、也记得敌方做过什么。
 *
 * 导出供测试直捣。
 */
export async function routePlayerIntent(
  intentText: string,
  req: Extract<RequiredInput, { kind: 'PlayerCommand' }>,
  session: CombatSession,
  ctx: RouteCtx,
): Promise<{ commands: CombatCommand[]; narration: string }> {
  const trimmed = (intentText ?? '').trim();
  return routeHostCommand(
    req,
    session,
    ctx,
    (panel) =>
      `【玩家意图】${trimmed || '（玩家未给出具体指令，请按当前战况合理推进）'}\n\n` +
      `你是战斗主持人：理解玩家想做什么，调工具替他声明动作（玩家说攻击就攻击、说防御就防御、` +
      `说逃跑就逃跑——意图以玩家输入为准，不要替他发明他没说的行动）。\n\n${panel}`,
  );
}

/**
 * 工具往返回流（决策 1A/3）：把一次 chatWithTools 回合内执行过的工具调用按执行序重建为
 * assistant(tool_calls) + tool 消息对，append 进持久消息数组。查询工具结果（get_* 返回的
 * 数据）随 tool 消息内容完整保留，后续轮次可见。tool_call_id 用确定性序号（铁律 1：
 * 本文件零 Math.random），与 nextCmdId 同源，全局唯一。
 */
function appendToolRoundtrip(
  messages: CombatAgentMessage[],
  toolCalls: Array<{ name: string; arguments: unknown; result?: unknown }>,
): void {
  for (const tc of toolCalls) {
    const id = nextCmdId('combat-tc');
    const argsStr =
      typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: tc.name, arguments: argsStr } }],
    });
    messages.push({
      role: 'tool',
      tool_call_id: id,
      name: tc.name,
      content: JSON.stringify(tc.result ?? {}),
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 结算演绎（设计 2026-08-09 §2.5：数字即时 + AI 叙事补上）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 一次攻击动作的结算事实（形状对齐 v3_action 卡片载荷，projection-ui.ts）：
 * 从 DomainEvent 的 AttackDeclared / AttackResolved / DamageApplied 三个阶段事件
 * 按攻击对（attackerId + targetId）汇总成一条。纯数据，无随机/无 I/O。
 */
export interface SettlementActionFact {
  attackerId: string;
  targetId: string;
  /** 技能名（AttackDeclared.skill，未指定时缺省） */
  skill?: string;
  /** AttackResolved：检定值 / 评级 / 是否命中 */
  checkValue?: number;
  rating?: string;
  hit?: boolean;
  /** DamageApplied：减免前伤害 / 最终伤害 / 伤害类型 / 目标 HP 前后 */
  preReduction?: number;
  final?: number;
  damageType?: string;
  targetHpBefore?: number;
  targetHpAfter?: number;
}

/**
 * 从一段 dispatch 的 DomainEvent[] 汇总结算事实串（§2.5）：
 * 每一条 AttackDeclared 开一条 fact；后续同攻击对的 AttackResolved / DamageApplied
 * 按「未填该阶段字段」匹配就近合并（同一 dispatch 内的连击各自成行）。
 * 无攻击结算事件（pass / 注骰 / settle 等）→ 返回空数组，调用方不触发短调用。
 * 纯函数，导出供测试直捣。
 */
export function collectSettlementFacts(events: readonly DomainEvent[]): SettlementActionFact[] {
  const facts: SettlementActionFact[] = [];
  for (const evt of events) {
    switch (evt.kind) {
      case 'AttackDeclared':
        facts.push({ attackerId: evt.attackerId, targetId: evt.targetId, skill: evt.skill });
        break;
      case 'AttackResolved': {
        const fact =
          facts.find(
            (f) =>
              f.attackerId === evt.attackerId &&
              f.targetId === evt.targetId &&
              f.checkValue === undefined,
          ) ?? facts.find((f) => f.attackerId === evt.attackerId && f.targetId === evt.targetId);
        if (fact) {
          fact.checkValue = evt.checkValue;
          fact.rating = evt.rating;
          fact.hit = evt.hit;
        } else {
          facts.push({
            attackerId: evt.attackerId,
            targetId: evt.targetId,
            checkValue: evt.checkValue,
            rating: evt.rating,
            hit: evt.hit,
          });
        }
        break;
      }
      case 'DamageApplied': {
        const fact =
          facts.find(
            (f) =>
              f.attackerId === evt.attackerId &&
              f.targetId === evt.targetId &&
              f.final === undefined,
          ) ?? facts.find((f) => f.attackerId === evt.attackerId && f.targetId === evt.targetId);
        if (fact) {
          fact.preReduction = evt.preReduction;
          fact.final = evt.final;
          fact.damageType = evt.damageType;
          fact.targetHpBefore = evt.targetHpBefore;
          fact.targetHpAfter = evt.targetHpAfter;
        } else {
          facts.push({
            attackerId: evt.attackerId,
            targetId: evt.targetId,
            preReduction: evt.preReduction,
            final: evt.final,
            damageType: evt.damageType,
            targetHpBefore: evt.targetHpBefore,
            targetHpAfter: evt.targetHpAfter,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return facts;
}

/**
 * 结算事实串 → 喂给 AI 的文本（§2.5）。含命中/评级/伤害/HP 等确定性数字——
 * 这些数字只给 AI 当事实依据，契约要求结果句**不重复**数值（面板卡片已展示）。
 * 纯函数，导出供测试直捣。
 */
export function buildSettlementFactText(facts: readonly SettlementActionFact[]): string {
  if (facts.length === 0) return '';
  const lines = facts.map((f) => {
    const parts: string[] = [`「${f.attackerId}」攻击「${f.targetId}」`];
    if (f.skill) parts.push(`技能：${f.skill}`);
    if (typeof f.checkValue === 'number' && f.rating !== undefined) {
      parts.push(`检定 ${f.checkValue}（${f.rating}）${f.hit === true ? '，命中' : '，未命中'}`);
    }
    if (typeof f.final === 'number') {
      const typePart = f.damageType ? `（${f.damageType}）` : '';
      parts.push(`造成 ${f.final} 点伤害${typePart}`);
      if (typeof f.targetHpBefore === 'number' && typeof f.targetHpAfter === 'number') {
        parts.push(`目标 HP：${f.targetHpBefore} → ${f.targetHpAfter}`);
      }
    }
    return parts.join('，');
  });
  return `- ${lines.join('\n- ')}`;
}

/**
 * 结算演绎短调用（§2.5）：把结算事实串喂同一持久会话，AI 写一句结果句。
 *
 * 纯叙事增强，三条铁则：
 *  - **不产 Command、不改战斗状态**：结算调用只读，不影响内核判定 / Command 消费。
 *  - **走 client.chat（非工具路径）**：结果句是纯文本一句话，无需工具；也不消费主决策
 *    的 chatWithTools 工具轮预算。chat 收到的持久数组（含 tool 往返消息）对 API 合法：
 *    appendToolRoundtrip 保证每条 tool 消息都有对应 assistant.tool_calls。
 *  - **失败优雅降级**：无会话 / 无 client / 调用抛错 / 空输出 → 返回 ''，调用方不注入。
 *
 * 持久会话契约（决策 1A）：结算 user(事实串) 与 assistant(结果句) 都 append 进
 * handle.messages——与主决策消息同一数组、串行追加 → 前缀稳定、不错位。失败时回滚
 * user 消息（pop），数组保持失败前原样，不污染后续决策的前缀。
 * client 由主决策（routeEnemyCommand）惰性建；整场只有玩家行动、敌方从未行动时
 * client 为 null → 结算叙事静默跳过（无 agent 会话的降级形态）。
 */
async function narrateSettlement(
  facts: readonly SettlementActionFact[],
  handle: CombatSessionHandle,
): Promise<string> {
  const factText = buildSettlementFactText(facts);
  const client = handle.client;
  if (!factText || !client || typeof client.chat !== 'function') return '';
  const messages = handle.messages;
  const userContent =
    `【内核结算完成】本次行动已由代码结算（数字由战斗面板展示，叙事勿重复数值）。\n` +
    `${factText}\n\n按演绎契约写一句结果句（命中/伤害/受击反应）。`;
  messages.push({ role: 'user', content: userContent });
  try {
    // 🔴 2026-08-12 真机 debug 修复：CombatClient.chat 契约是**对象形状** `{ messages }`
    //   （对齐 AgentClient.chat），此前误传裸数组 → request.messages 为 undefined →
    //   ensureUserMessage 里 undefined.length 崩 → 每次结算叙事必失败（agentLog 记
    //   「Cannot read properties of undefined (reading 'length')」）。已把接口与
    //   调用点一并改为对象形状（combat-v2-types.ts 的 CombatClient.chat 签名同步改）。
    const result = await client.chat({ messages } as never);
    const sentence = (result.output ?? result.rawResponse ?? '').trim();
    if (sentence.length > 0) {
      messages.push({ role: 'assistant', content: sentence });
      return sentence;
    }
    messages.pop(); // 空输出（含 result.error 的失败形态）→ 回滚 user 消息
    return '';
  } catch {
    messages.pop(); // 调用抛错 → 回滚 user 消息，战斗主流程不受影响
    return '';
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 战斗终局 AI 总结（2026-08-12 新增）
// ──────────────────────────────────────────────────────────────────────────────

/** 终局原因（TerminalReason）的中文描述（喂 AI 的事实文本用） */
const TERMINAL_REASON_TEXT: Readonly<Record<string, string>> = {
  hp_zero: '一方全灭',
  morale_routed: '士气溃逃',
  flee_success: '逃跑成功',
  force_terminal: '强制终局',
};

/** 归一 outcome 的中文描述（与 CombatV3Result.outcome 同源，feed AI 的事实文本用） */
const COMBAT_OUTCOME_TEXT: Readonly<Record<CombatV3Result['outcome'], string>> = {
  ally_win: '我方获胜',
  enemy_win: '敌方获胜',
  fled: '战斗以逃遁告终',
  draw: '战斗以平局告终',
};

/**
 * 战斗终局事实（喂 AI 的整场战斗总结依据）。
 *
 * 纯数据：reason / winner / outcome / rounds / fpDelta + 存活与倒下（离场）单位名。
 * 数字只给 AI 当事实依据——叙事契约要求结果文本**不重复**数字卡片（战斗面板已展示，
 * 照叙事规范：结果句不出现 HP / FP / 检定等机制术语）。
 */
export interface CombatEndFacts {
  /** 终局原因（TerminalReason：hp_zero / morale_routed / flee_success / force_terminal） */
  reason: string;
  /** 胜方（'player' | 'enemy'；平局 / 逃跑成功时缺省） */
  winner?: string;
  /** 归一 outcome（ally_win / enemy_win / fled / draw，与 CombatV3Result.outcome 同源） */
  outcome: CombatV3Result['outcome'];
  /** 进行回合数 */
  rounds: number;
  /** 命运点数净变动（终局快照 − 开战快照，架构 §十二 12.2 Δ 口径） */
  fpDelta: number;
  /** 终局仍存活（终局快照在场且 hp > 0）的单位（展示名，铁律 ① 名字是逻辑键） */
  aliveUnits: Array<{ name: string; side: 'player' | 'enemy' }>;
  /** 倒下或已离场（终局快照 hp ≤ 0，或开战在场而终局快照已移除——逃跑成功 / 召唤到期）的单位 */
  fallenUnits: Array<{ name: string; side: 'player' | 'enemy' }>;
}

/**
 * 从终局快照组装终局事实。
 *
 * - 存活：终局快照 units 中 hp > 0 的单位（拿展示名）
 * - 倒下 / 离场：终局 units 中 hp ≤ 0 的单位 + 开战参与者（bundle.participants）里
 *   终局快照已找不到的（逃跑成功移除 / 召唤物到期——战斗结束时它们不在场）
 * - outcome 复用 outcomeOf 归一（与 CombatV3Result.outcome 同一函数，不重复推导）
 *
 * 纯函数（只读快照 + 初始名单，无 I/O），导出供测试直捣（先例 collectSettlementFacts）。
 */
export function collectCombatEndFacts(
  session: CombatSession,
  initialFp: number,
  participants: readonly CombatParticipant[],
): CombatEndFacts {
  const view = session.snapshot();
  const terminal = view.terminal;

  const aliveUnits: CombatEndFacts['aliveUnits'] = [];
  const fallenUnits: CombatEndFacts['fallenUnits'] = [];

  // 终局在场单位：hp > 0 → 存活；hp ≤ 0 → 倒下
  for (const u of Object.values(view.units)) {
    const entry = { name: u.name, side: u.side };
    if (u.hp > 0) aliveUnits.push(entry);
    else fallenUnits.push(entry);
  }

  // 开战在场而终局已移除（逃跑成功 / 召唤到期）→ 离场归入倒下名单。
  // 防御性去重：正常情况下 participants 与终局 units 一一对应，但召唤物/回放数据
  // 可能重叠，避免同一名字进两遍（名单只当事实依据，重复会误导 AI 人数）。
  const presentIds = new Set(Object.keys(view.units));
  const alreadyListed = new Set([...aliveUnits, ...fallenUnits].map((u) => u.name));
  for (const p of participants) {
    if (presentIds.has(p.characterId)) continue;
    if (alreadyListed.has(p.name)) continue;
    fallenUnits.push({ name: p.name, side: p.side === 'enemy' ? 'enemy' : 'player' });
  }

  return {
    reason: terminal?.reason ?? 'terminal',
    winner: terminal?.winner,
    outcome: outcomeOf(session),
    rounds: view.round,
    fpDelta: view.resourceSnapshots.FP - initialFp,
    aliveUnits,
    fallenUnits,
  };
}

/**
 * 终局事实 → 喂 AI 的文本（整场战斗总结的依据串）。
 *
 * 确定性数字（回合数 / FP 净变动 / 单位名单）只给 AI 当事实依据——契约要求结果
 * 文本不重复数字卡片、不出现机制术语（照叙事规范）。纯函数，导出供测试直捣
 * （先例 buildSettlementFactText）。
 */
export function buildCombatEndFactText(facts: CombatEndFacts): string {
  const lines: string[] = [];
  lines.push(`战斗结果：${COMBAT_OUTCOME_TEXT[facts.outcome] ?? '平局'}`);
  const reasonText = TERMINAL_REASON_TEXT[facts.reason] ?? facts.reason;
  if (reasonText) lines.push(`终局原因：${reasonText}`);
  lines.push(`进行回合数：${facts.rounds}`);
  const fpSign = facts.fpDelta >= 0 ? '+' : '';
  lines.push(`命运点数净变动：${fpSign}${facts.fpDelta}`);
  if (facts.aliveUnits.length > 0) {
    lines.push(`仍屹立于战场：${facts.aliveUnits.map((u) => u.name).join('、')}`);
  }
  if (facts.fallenUnits.length > 0) {
    lines.push(`倒下或已离场：${facts.fallenUnits.map((u) => u.name).join('、')}`);
  }
  return lines.join('\n');
}

/**
 * 战斗终局 AI 总结：终局结算完成后，把整场战斗事实喂同一持久会话，
 * AI 写一段面向玩家的战斗总结叙事（2-4 句，收束胜负 / 关键转折 / 幸存者命运）。
 *
 * 与 narrateSettlement 同形（三条铁则照抄）：
 *  - **不产 Command、不改战斗状态**：总结只读，战斗结果已由 commitChatState 落库。
 *  - **走 client.chat（非工具路径）**：总结是纯文本一段，无需工具；也不消费主决策
 *    的 chatWithTools 工具轮预算。
 *  - **失败优雅降级**：无 client / 调用抛错 / 空输出 → 返回 ''，调用方回落
 *    collectedSummary / 兜底（T11 语义不变，战斗结果不受影响）。
 *
 * 持久会话契约（决策 1A）：总结 user(终局事实) 与 assistant(总结文本) 都 append 进
 * handle.messages——与主决策消息同一数组、串行追加 → 前缀稳定、不错位。失败时回滚
 * user 消息（pop），数组保持失败前原样，不污染后续（战斗已结束，主要是保持可回放）。
 * client 由主决策（F5 openCombatScene / routeEnemyCommand）惰性建；整场从未调 AI 时
 * client 为 null → 总结静默跳过（无 agent 会话的降级形态，兜底摘要照常回注）。
 */
async function narrateCombatEnd(
  facts: CombatEndFacts,
  handle: CombatSessionHandle,
): Promise<string> {
  const client = handle.client;
  if (!client || typeof client.chat !== 'function') return '';
  const factText = buildCombatEndFactText(facts);
  if (!factText) return '';
  const messages = handle.messages;
  const userContent =
    `【战斗终局】战斗已结束，结算已落库。以下为整场战斗的终局事实` +
    `（数字由战斗面板展示，叙事勿重复数值）：\n${factText}\n\n` +
    `请以旁白口吻写一段面向玩家的战斗总结叙事（2-4 句）：交代胜负、关键转折与幸存者/` +
    `倒下者的命运，收束这场战斗。不要复述数字卡片，不要出现「HP」「FP」「检定」等机制术语。`;
  messages.push({ role: 'user', content: userContent });
  try {
    // 🔴 照 narrateSettlement 的 2026-08-12 修复：CombatClient.chat 契约是对象形状
    // `{ messages }`（对齐 AgentClient.chat），传裸数组会让 request.messages 为 undefined。
    const result = await client.chat({ messages } as never);
    const text = (result.output ?? result.rawResponse ?? '').trim();
    if (text.length > 0) {
      messages.push({ role: 'assistant', content: text });
      return text;
    }
    messages.pop(); // 空输出（含 result.error 的失败形态）→ 回滚 user 消息
    return '';
  } catch {
    messages.pop(); // 调用抛错 → 回滚 user 消息，战斗结果不受影响
    return '';
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 工具调用 → Command 翻译（v3 工具集 §4.4）
// ──────────────────────────────────────────────────────────────────────────────

const INTENTION_LEVELS: readonly IntentionLevel[] = [
  '非致死',
  '常规',
  '战术',
  '机能',
  '核心',
  '抹杀',
  '概念',
  '处决',
];

function toIntention(v: unknown): IntentionLevel {
  if (typeof v === 'string') {
    const hit = INTENTION_LEVELS.find((l) => l === v);
    if (hit) return hit;
  }
  return '常规';
}

/**
 * 查询类工具名单（设计 2026-08-09 §2.2 决策 3C）：只读查询，返回数据给模型，**不产 Command**。
 * 与命令类（5 个：declare_attack / declare_action / pass_slot / flee / submit_adjudication）
 * 严格分流 —— 查询工具永不落 toolCallToCommand 的 default 变静默 pass。
 * write_summary 自成**收集类**（T11）：既非查询也非命令，executor 分流到 collectCombatSummary，
 * 由 collectSummaryFromToolCalls 收集进 combatSession.summary（详见 routeEnemyCommand）。
 * get_unit_detail（T8 已实现于 agent-tools.ts）在波 3（T7）补进名单：战斗内调用走查询分支
 * 而非命令分支（否则落 toolCallToCommand default → 静默 pass）。
 */
const COMBAT_QUERY_TOOLS = new Set([
  'get_combat_state',
  'get_character',
  'get_inventory',
  'get_unit_detail',
]);

function isCombatQueryTool(name: string): boolean {
  return COMBAT_QUERY_TOOLS.has(name);
}

/**
 * 查询类工具执行（设计 2026-08-09 §2.2）：返回数据给模型，**不产 Command**。
 *
 * 数据来源复用现有实现，不重造：
 *   - get_character / get_inventory / get_unit_detail → agent-tools.executeToolCall（角色/背包/
 *     单位详情数据的唯一真源，形状与 char_gen / item_gen / craft_gen 各链一致；T3 已给
 *     get_character 补 skills/equipment，T8 已实现 get_unit_detail 五维+技能+装备聚合）。
 *   - get_combat_state → projection-agent.projectToAgent（与每回合注入的 {战况总览} 同源；
 *     agent-tools 里的 get_combat_state 仍是 M4 占位 throw，战斗内快照以本 session 为准）。
 *
 * 未知查询工具 → throw（chatWithTools 会把异常包成 {"error": …} tool 消息回喂模型，可行动），
 * 永不静默 pass。ToolExecutionContext 的 characters/variables 取自 ctx.context（AgentContext），
 * 照 char_gen/craft_gen 读 context 的先例；context 缺失时兜底空表（查询返回 found:false）。
 */
async function executeCombatQuery(
  name: string,
  args: Record<string, any>,
  session: CombatSession,
  ctx: RouteCtx,
): Promise<ToolResult> {
  switch (name) {
    case 'get_combat_state':
      return { combatState: projectToAgent(session.snapshot()) };
    case 'get_character':
    case 'get_inventory':
    case 'get_unit_detail':
      return executeToolCall(name, args, {
        saveId: ctx.saveId,
        characters: ctx.context?.characters ?? [],
        variables: ctx.context?.variables ?? {},
      });
    default:
      throw new Error(`未知查询工具「${name}」，可用: ${[...COMBAT_QUERY_TOOLS].join(', ')}`);
  }
}

/**
 * write_summary 工具执行（T11，设计 2026-08-09 §2.2 改造）：返回确认 ToolResult 给模型，
 * **不产 Command**（终局由内核判定，write_summary 只是收尾叙事；text 的收集由
 * collectSummaryFromToolCalls 统一做，这里只回确认，避免双收集）。schema：agent-tools.ts
 * 的 write_summary 定义（参数 text ≤500 字）。
 */
function collectCombatSummary(args: Record<string, any>): ToolResult {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  return { summary_collected: true, chars: text.length };
}

/**
 * 终局摘要统一收集（T11，设计 2026-08-09 §2.2 write_summary 改造）：
 * 扫描一次 chatWithTools 回合内执行过的工具调用，把 write_summary(text) 收集进
 * combatSession.summary（追加合并：AI 可能分次补全）。args 形状与 toolCallToCommandSync
 * 的解析口径一致（字符串 JSON 或对象）。空文本跳过（不写空值，保持「无摘要」语义）。
 * 纯函数副作用仅 handle.summary 一处，导出不必要（仅 routeEnemyCommand 调用）。
 */
function collectSummaryFromToolCalls(
  toolCalls: ReadonlyArray<{ name: string; arguments: unknown }>,
  handle: CombatSessionHandle,
): void {
  for (const tc of toolCalls) {
    if (tc.name !== 'write_summary') continue;
    let args: Record<string, any> = {};
    if (typeof tc.arguments === 'string') {
      try {
        args = JSON.parse(tc.arguments) as Record<string, any>;
      } catch {
        args = {};
      }
    } else if (tc.arguments && typeof tc.arguments === 'object') {
      args = tc.arguments as Record<string, any>;
    }
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (text.length === 0) continue;
    handle.summary = handle.summary ? `${handle.summary}\n${text}` : text;
  }
}

/**
 * 名字 → 单位 id 解析（数据字典铁律 ①：逻辑键 = 名字，AI 永不产 id，Code 负责解析）。
 *
 * 背景（2026-08-10 真机复现）：战斗面板（projectToAgent）给敌方 Agent 显示的是展示名
 * （中文），而内核 units 的 key 是 characterId（生产路径 = char.id，UUID）。Agent 从面板
 * 抄名字回来调 declare_attack(actorName="两栖洞穴魔物")，此前被 toolCallToCommandSync
 * 直接当 actorId 用 → 内核 TARGET_NOT_PRESENT rejection → 连续 4 次 abandon
 * （`if (steps > 3) break`）→ 战斗必被放弃。本函数把名字反查回在场单位的 id。
 *
 * 匹配顺序（exact 优先，模糊兜底，最少侵入）：
 *   ① 已是 id（units 里直接有这把 key）→ 原样返回，不误伤内核/工具链给的单位 id
 *   ② exact：展示名精确命中（面板正常回流的主路径）
 *   ③ 去空白：面板/模型可能折叠或插入空白
 *   ④ 包含：名字带别名/前后缀修饰（任一侧包含另一侧；两侧都要求长度 ≥2 防误伤）
 * 查不到 → 返回原值（现状兜底：可能是 id 本身，不抛错、不猜）。
 *
 * 纯函数，导出供测试直捣（先例：buildUnitPersistPatches）。
 */
export function resolveUnitIdByName(
  units: Readonly<Record<string, CombatUnitView>>,
  name: string,
): string {
  if (name.length === 0 || units[name]) return name;
  const compact = (s: string): string => s.replace(/\s+/g, '');
  const exact = Object.values(units).find((u) => u.name === name);
  if (exact) return exact.id;
  const want = compact(name);
  const byCompact = Object.values(units).find((u) => compact(u.name) === want);
  if (byCompact) return byCompact.id;
  if (want.length >= 2) {
    const byIncludes = Object.values(units).find(
      (u) =>
        compact(u.name).length >= 2 &&
        (compact(u.name).includes(want) || want.includes(compact(u.name))),
    );
    if (byIncludes) return byIncludes.id;
  }
  return name;
}

/** 从战斗会话构造名字 → id 解析器（取快照在场单位，每次决策时最新） */
function makeUnitNameResolver(session: CombatSession): (name: string) => string {
  const units = session.snapshot().units;
  return (name: string) => resolveUnitIdByName(units, name);
}

/** 一次 v3 工具调用 → 内核 Command（toolExecutor）。session 用于把 Agent 报的名字解析成单位 id */
async function toolCallToCommand(
  name: string,
  args: Record<string, any>,
  revision: number,
  actorId: string,
  session: CombatSession,
): Promise<CombatCommand> {
  return toolCallToCommandSync(name, args, revision, actorId, makeUnitNameResolver(session));
}

function toolCallToCommandSync(
  name: string,
  args: Record<string, any>,
  revision: number,
  actorId: string,
  resolveUnitId?: (name: string) => string,
): CombatCommand {
  const id = nextCmdId(`tool-${name}`);
  // 名字 → id 解析（铁律 ①：AI 报名字，Code 解析成 id）。不传解析器（直捣测试 /
  // 旧调用）→ 原值透传，行为与现状一致；传了而名字查不到 → 解析器返回原值，同样透传。
  const resolve = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 && resolveUnitId ? resolveUnitId(v) : undefined;
  switch (name) {
    case 'declare_attack':
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'DeclareAttack',
        actorId: resolve(args.actorName) ?? actorId,
        cost: 'attack',
        payload: {
          targetId: resolve(args.targetName) ?? '',
          skill: args.skillName as string | undefined,
          intentionLevel: toIntention(args.intentionLevel),
          costs: args.costs as { mp?: number; sp?: number } | undefined,
        },
      };
    case 'declare_action': {
      const t = args.actionType as string;
      if (t === '格挡') {
        return {
          commandId: id,
          expectedRevision: revision,
          kind: 'DeclareBlock',
          actorId: resolve(args.actorName) ?? actorId,
          cost: 'action',
          payload: { choiceId: undefined },
        };
      }
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'DeclareAction',
        actorId: resolve(args.actorName) ?? actorId,
        cost: 'action',
        payload: { actionType: mapActionType(t), description: undefined },
      };
    }
    case 'pass_slot':
      if (args.slot === 'action') {
        return {
          commandId: id,
          expectedRevision: revision,
          kind: 'PassAction',
          actorId: resolve(args.actorName) ?? actorId,
          cost: 'action',
          payload: {} as Record<string, never>,
        };
      }
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'PassAttack',
        actorId: resolve(args.actorName) ?? actorId,
        cost: 'attack',
        payload: {} as Record<string, never>,
      };
    case 'flee':
      // Bug A（2026-08-12）：逃跑不占攻击/动作槽（cost 'none'）——「想跑就能跑」。
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'Flee',
        actorId: resolve(args.actorName) ?? actorId,
        cost: 'none',
        payload: {} as Record<string, never>,
      };
    case 'end_turn':
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'EndTurn',
        actorId: resolve(args.actorName) ?? actorId,
        cost: 'none',
        payload: {} as Record<string, never>,
      };
    // submit_adjudication（设计 2026-08-09 §2.4 补执行端）：schema 有（agent-tools.ts:522）、
    // 原本无 case → 落 default 静默 pass。翻译成 Adjudicate Command，由 reducer 消费
    // Adjudicate 时走 evaluateAdjudication 内核实锤（六步边界验证，reducer.ts adjudicate()）。
    // 字段翻译：schema 声明的 effectDescription/divinity/verifiableBounds/requestedRuleOverride/
    // reason 照透传；schema 没声明的 requestId 给确定性默认（照 routeAdjudication 的 adj- 前缀）。
    // verifiableBounds 是 AI 自由填的 object → 保守归一化：缺 targetLegal/invariantCompliant
    // 给拒绝倾向默认（false / []），避免 evaluateAdjudication 解构 undefined 崩内核。
    case 'submit_adjudication': {
      const actorName = (args.actorName as string | undefined) ?? actorId;
      const rawVb = (args.verifiableBounds ?? {}) as Record<string, unknown>;
      const verifiableBounds: ProposedAdjudication['verifiableBounds'] = {
        targetLegal: typeof rawVb.targetLegal === 'boolean' ? rawVb.targetLegal : false,
        invariantCompliant: Array.isArray(rawVb.invariantCompliant)
          ? (rawVb.invariantCompliant as ProposedAdjudication['verifiableBounds']['invariantCompliant'])
          : [],
      };
      const nr = rawVb.numericalRange;
      if (nr && typeof nr === 'object' && 'min' in nr && 'max' in nr) {
        verifiableBounds.numericalRange = nr as { min: number; max: number };
      }
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'Adjudicate',
        actorId: actorName,
        cost: 'none',
        payload: {
          requestId: `adj-${actorName}`,
          adjudication: {
            effectDescription: (args.effectDescription as string | undefined) ?? '',
            divinity: (args.divinity as number | undefined) ?? 0,
            verifiableBounds,
            requestedRuleOverride: args.requestedRuleOverride as string | undefined,
            reason: (args.reason as string | undefined) ?? '',
          },
        },
      };
    }
    // write_summary 不在此翻译（T11，设计 2026-08-09 §2.2）：它是收尾收集动作、不产
    // Command —— 由 routeEnemyCommand 的 executor 分流到 collectCombatSummary（返回确认
    // ToolResult），text 经 collectSummaryFromToolCalls 收集进 combatSession.summary。
    // 落到这里（executor 分流遗漏 / 直捣调用）→ default 防御性 pass，不静默产出 Choose。
    default:
      return nextPassCommand(revision, actorId, 'attack');
  }
}

function mapActionType(t: string): 'item' | 'move' | 'focus' | 'defend' {
  switch (t) {
    case '道具':
      return 'item';
    case '移动':
      return 'move';
    case '专注':
      return 'focus';
    default:
      return 'defend';
  }
}

/**
 * F4（2026-08-10）：从 chatWithTools 最终结果收集**全部**命令类工具调用 → Command[]。
 *
 * 背景（真机复现）：敌方 Agent 一次 chatWithTools 声明 `declare_attack` + `declare_action`
 * 两个命令，旧实现（lastCommandFromResult）只取最后一条命令类调用 → attack 被丢弃 → 内核
 * 只消费动作槽 → 攻击槽永远 1/1 → 下一轮 AI 又声明 attack+action → 动作槽 SLOT_EXHAUSTED
 * → 熔断 abandon → 玩家永远轮不到。修复：按调用顺序收集全部命令类调用（AI 声明 attack →
 * action，就返回 [attackCmd, actionCmd]），由主循环逐条 dispatch。
 *
 * 仍跳过查询工具（get_*，返回数据不产 Command）与 write_summary（T11 收尾收集动作）；
 * 一条命令都没有（纯查询/纯 summary 收尾 / 无工具调用）→ 防御性 [PassAttack] 推进
 * （AI 未做决定，行为与修复前一致）。
 */
function commandsFromResult(
  result: {
    toolCalls?: Array<{ name: string; arguments: unknown }>;
    output?: string | null;
  },
  revision: number,
  actorId: string,
  session: CombatSession,
): CombatCommand[] {
  const calls = result.toolCalls ?? [];
  const commands: CombatCommand[] = [];
  for (const c of calls) {
    if (isCombatQueryTool(c.name) || c.name === 'write_summary') continue;
    let args: Record<string, any> = {};
    if (typeof c.arguments === 'string') {
      try {
        args = JSON.parse(c.arguments) as Record<string, any>;
      } catch {
        args = {};
      }
    } else if (c.arguments && typeof c.arguments === 'object') {
      args = c.arguments as Record<string, any>;
    }
    commands.push(
      toolCallToCommandSync(c.name, args, revision, actorId, makeUnitNameResolver(session)),
    );
  }
  if (commands.length === 0) return [nextPassCommand(revision, actorId, 'attack')];
  return commands;
}

// ──────────────────────────────────────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────────────────────────────────────

function nearestCommand(revision: number, actorId: string, _actorName: string): CombatCommand {
  return {
    commandId: nextCmdId('prompt'),
    expectedRevision: revision,
    kind: 'DeclareAttack',
    actorId,
    cost: 'attack',
    payload: { targetId: actorId, intentionLevel: '常规' },
  };
}

function nextPassCommand(
  revision: number,
  actorId: string,
  slot: 'attack' | 'action',
): CombatCommand {
  return {
    commandId: nextCmdId(`pass-${slot}`),
    expectedRevision: revision,
    kind: slot === 'attack' ? 'PassAttack' : 'PassAction',
    actorId,
    cost: slot,
    payload: {} as Record<string, never>,
  } as CombatCommand;
}

function nextPass(session: CombatSession, slot: 'attack' | 'action'): CombatCommand {
  const unitId = session.snapshot().initiativeOrder[0] ?? '';
  return nextPassCommand(session.snapshot().revision, unitId, slot);
}

function supplyCommand(
  saveId: string,
  session: CombatSession,
  d: { outputId: string; dice: number[] },
): CombatCommand {
  return {
    commandId: `sup-${saveId}-${d.outputId}`,
    expectedRevision: session.snapshot().revision,
    kind: 'SupplyDice',
    actorId: '',
    cost: 'none',
    payload: { outputId: d.outputId, dice: d.dice },
  };
}

function emitEvents(
  opts: RunCombatV3Opts,
  events: readonly DomainEvent[],
  session: CombatSession,
): void {
  if (opts.onCombatEvent && events.length > 0) {
    // T13：把当前单位字典投影进投影 A —— 首次 dispatch（含 CombatOpened）时补发
    // v3_units_snapshot，前端面板拿到开局单位快照（设计 2026-08-09 §3.1）
    for (const evt of projectToUi(events, { units: session.snapshot().units })) {
      opts.onCombatEvent(evt);
    }
    // 🔴 2026-08-12（真机 bug：打半天血量不掉）：普通伤害（DamageApplied→v3_action）
    //   **不触发 v3_unit_state_changed**（那只在 HpFloored/UnitDowned/UnitDefeated 发），
    //   前端 v3ActiveCombat.units 只在开战快照更新一次 → UI 面板 HP 永远停在开战值。
    //   修复：**每次 dispatch 后补发 v3_units_snapshot**（整个 units 字典），前端覆盖
    //   units —— HP/槽位/状态实时同步（伤害、血量变化、槽位消费都能看到）。
    //   幂等：store 的 v3_units_snapshot 分支是整份覆盖，重复发无害。
    opts.onCombatEvent({ type: 'v3_units_snapshot', units: { ...session.snapshot().units } });
  }
}

/** 终局结果归一 */
function outcomeOf(session: CombatSession): CombatV3Result['outcome'] {
  const t = session.snapshot().terminal;
  if (!t) return 'draw';
  switch (t.reason) {
    case 'flee_success':
      return 'fled';
    case 'hp_zero':
      return t.winner === 'player' ? 'ally_win' : 'enemy_win';
    default:
      return 'draw';
  }
}

/**
 * 把终局 DomainEvent 翻译成 StatePatch[]（M2 最小：FP 结算落库）。
 *
 * M1 内核 settle 不产 SettlementCommitted 事件（只产 CombatEnded + FP NarrativeCue），
 * 故这里直接按 fpDelta 生成 FP 结算 patch，保证终局一次 commitChatState（A2-1）。
 * 遵循数据字典五铁律 ④（FP 走 SaveProfile 唯一真源）。
 *
 * 🔴 2026-08-12（真机 bug：Patch set on users.fp: 未知操作: set）：
 *   旧实现用 `op:'set'` + `target:'users.fp'`——set 不在 StatePatchOp 联合里
 *   （state-manager 只认 replace/delta/add/remove 及各 set_hp/set_mp 等具名 op），
 *   target 也错了（FP 真源是 profile.fp，见 craft-gen-chain 的先例）。
 *   更糟的是语义：op:'set' value:N 会把 FP **覆盖**成 N 而不是加减——
 *   fpDelta=0 时会把玩家 FP 清零。幸好 state-manager 因不认识 op 而拒收，
 *   玩家的 FP 被「未知操作」这条错误救下来了。现在改为 delta_variable（与
 *   craft-gen-chain FP 奖励同 op/target），amount=0 时整条不发。
 */
function toPatches(
  _events: readonly DomainEvent[],
  _bundle: CombatDefinitionBundle,
  fpDelta: number,
): StatePatch[] {
  if (fpDelta === 0) return []; // 无变动不发 patch（delta_variable amount:0 是无意义噪声）
  return [
    {
      op: 'delta_variable',
      target: 'profile.fp',
      amount: Math.round(fpDelta),
    },
  ];
}

/**
 * 战斗胜利经验值结算（架构 §12.4 EXP）。
 *
 * v3 内核 M1 只结算 FP 净变动，EXP/战利品留给 coordinator 补（terminal.ts 注释明说）。
 * 本函数补上 EXP：仅 ally_win 结算；fled / enemy_win / draw 不给经验。
 *
 * 公式（世界书 #417617 战斗系数表 + ADR-11 确定性归 Code）：
 *   每个被击杀的敌方单位贡献 EXP = level × getCombatCoefficient(tier)
 *   求和后平分给玩家方存活（hp > 0）且有存档角色对应的单位。
 *
 * 被击杀敌方的 level/tier 取自 CombatParticipant（CombatUnitView 不带 level），
 * 按 characterId（= unit.id）匹配。匹配不到 participant 时 tier 兜底取 unit.tier，
 * level 兜底取 1。EXP 整除向下取整（Math.floor），余数丢弃。
 *
 * 纯函数，导出供测试直捣。铁律：不产 id（铁律 1）。
 */
export function buildExpRewardPatches(
  units: Readonly<Record<string, CombatUnitView>>,
  participants: readonly CombatParticipant[],
  characters: ReadonlyArray<Record<string, unknown>>,
  outcome: CombatV3Result['outcome'],
): { patches: StatePatch[]; totalExp: number } {
  if (outcome !== 'ally_win') return { patches: [], totalExp: 0 };

  const defeatedEnemies = Object.values(units).filter((u) => u.side === 'enemy' && u.hp <= 0);
  if (defeatedEnemies.length === 0) return { patches: [], totalExp: 0 };

  let rawExp = 0;
  for (const enemy of defeatedEnemies) {
    const p = participants.find((pp) => pp.characterId === enemy.id);
    const tier = p?.tier ?? enemy.tier ?? 1;
    const level = p?.level ?? 1;
    rawExp += level * getCombatCoefficient(tier);
  }
  const totalExp = Math.round(rawExp);
  if (totalExp <= 0) return { patches: [], totalExp: 0 };

  // 玩家方存活单位 → 匹配存档角色（召唤物/无对应角色跳过，不硬造）
  const survivorChars: string[] = [];
  for (const unit of Object.values(units)) {
    if (unit.side !== 'player' || unit.hp <= 0) continue;
    const saved = findSavedCharacter(characters, unit);
    const name = saved?.name;
    if (typeof name === 'string' && name.length > 0) {
      survivorChars.push(name);
    }
  }
  if (survivorChars.length === 0) return { patches: [], totalExp: 0 }; // 无人存活 → EXP 浪费

  const expPerSurvivor = Math.floor(totalExp / survivorChars.length);
  if (expPerSurvivor <= 0) return { patches: [], totalExp: 0 }; // 整除为 0 → 不发

  const patches: StatePatch[] = survivorChars.map((name) => ({
    op: 'update_character',
    target: `characters.${name}`,
    value: { totalExp: expPerSurvivor },
    metadata: { source: 'combat_v3', delta: true },
  }));
  return { patches, totalExp };
}

// ──────────────────────────────────────────────────────────────────────────────
// 终局落库回写（设计 2026-08-09 §2.6 方案 1：战斗后角色伤势持久化）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 终局单位 → 存档角色的覆写 StatePatch（T10，设计 2026-08-09 §2.6 方案 1）。
 *
 * 现状背景：v3 战斗全程纯内存，终局 toPatches 只落 FP，HP/MP/SP/状态不落库 →
 * 战斗打完角色伤势不持久化。本函数把战斗结束时的单位资源/状态回写到存档角色。
 *
 * 规则（照 §2.6 定案）：
 *  - 按 characterId（= unit.id）匹配存档角色（deps.characters）：先按 id、再按 name
 *    （名字是逻辑键，铁律 1；生产 characterId = char.id，测试/回放 characterId = name）。
 *  - 匹配到 → set_hp/set_mp/set_sp 覆写资源（走 StateManager 既有 op，handler 内
 *    clamp 到 [0, 对应 max]，与 set_hp 语义一致）；statusEffects 差量同步：
 *    终局集合逐个 add_status_effect（同名合并/刷新），初始有而终局无的补
 *    remove_status_effect（覆写语义：战斗中移除的效果不残留存档）。
 *  - 匹配不到（召唤物，无对应存档角色）→ **跳过**，不硬造角色。
 *  - 全部走 StateManager 既有 op，不新增 op（ADR-21 唯一写入口，patch 形状照
 *    state-manager 的 set_* / add_remove_status_effect 契约）。
 *
 * 纯函数，导出供测试直捣。铁律：不产 id（铁律 1）；不改账务字段以外的结构。
 */
export function buildUnitPersistPatches(
  units: Readonly<Record<string, CombatUnitView>>,
  characters: ReadonlyArray<Record<string, unknown>>,
  participants: readonly CombatParticipant[],
): StatePatch[] {
  const patches: StatePatch[] = [];
  for (const unit of Object.values(units)) {
    const saved = findSavedCharacter(characters, unit);
    if (!saved) continue; // 召唤物（无对应存档角色）→ 跳过，不硬造角色
    const name = saved.name;
    if (typeof name !== 'string' || name.length === 0) continue;

    // 资源覆写（handler 内 clamp 到 [0, 对应 max]）
    patches.push({ op: 'set_hp', target: `characters.${name}`, value: unit.hp });
    patches.push({ op: 'set_mp', target: `characters.${name}`, value: unit.mp });
    patches.push({ op: 'set_sp', target: `characters.${name}`, value: unit.sp });

    // statusEffects 差量同步（覆写语义）：
    // ① 初始有、终局无 → remove（战斗中移除的效果不残留存档）
    const initialEffects = participants.find((p) => p.characterId === unit.id)?.statusEffects ?? [];
    const finalNames = new Set(unit.statusEffects.map((fx) => fx.name));
    for (const fx of initialEffects) {
      if (!finalNames.has(fx.name)) {
        patches.push({
          op: 'remove_status_effect',
          target: `characters.${name}`,
          value: { name: fx.name },
        });
      }
    }
    // ② 终局有 → add（同名合并/刷新，照 add_status_effect 的既有叠加语义）
    for (const fx of unit.statusEffects) {
      patches.push({ op: 'add_status_effect', target: `characters.${name}`, value: fx });
    }
  }
  return patches;
}

/**
 * 按 characterId（= unit.id）在存档角色里找匹配（设计 2026-08-09 §2.6）。
 * 生产路径 characterId = char.id（characterToCombatParticipant）；测试/回放路径
 * characterId = name（名字是逻辑键，铁律 1）→ 先 id 后 name 双兜底。
 */
function findSavedCharacter(
  characters: ReadonlyArray<Record<string, unknown>>,
  unit: CombatUnitView,
): Record<string, unknown> | undefined {
  return (
    characters.find((c) => c?.id === unit.id) ??
    characters.find((c) => c?.name === unit.id || c?.name === unit.name)
  );
}
