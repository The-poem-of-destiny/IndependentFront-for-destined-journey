/**
 * game-pipeline.side-chain-abort.test.ts —— 侧链取消接线（2026-08-10 审查轮）
 *
 * ## 这个文件为什么单开
 * 它要把 `@engine/agent-client` 整个换成替身（拿到侧链真正收到的 `signal`），
 * 而 `game-pipeline.test.ts` 里的用例跑的是真 AgentClient 那条路 —— 在那边加模块级
 * `vi.mock` 会顺带改掉 80 多条既有用例的前提。照 `GamePage.scene-image-seams.test.ts`
 * 的先例另起一个文件。
 *
 * ## 修的是什么
 * 侧链（char_gen / item_gen / craft_gen / combat_v3）此前**完全不响应 abort**：
 * `getClientFactory` 的包装层把 `signal` 当入参转发，而这四条链的调用方一个都没传，
 * 于是 `run()` 的 `abortController` 只到得了 story（`callAgent` 显式传了）。两层后果：
 *
 *   ① 离开游戏页之后侧链照跑（item_gen 单次可达 300s），钱照花、结果照落库；
 *   ② 「停止生成」把 `isGenerating` 清成 false → 输入框解锁 → 玩家能开下一回合，
 *      而上一回合的侧链仍在飞，两轮对**同一个存档**交错写入。
 *
 * ②（并发写入）才是把它从「偏好」变成「缺陷」的那一条。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** 侧链真正收到的取消信号 —— 替身的唯一产出 */
const seen: {
  chat: Array<AbortSignal | undefined>;
  tools: Array<AbortSignal | undefined>;
  stream: Array<AbortSignal | undefined>;
} = { chat: [], tools: [], stream: [] };

vi.mock('@engine/agent-client', () => ({
  AgentClient: class {
    async chat(_request: unknown, signal?: AbortSignal) {
      seen.chat.push(signal);
      return { rawResponse: '', output: '', tokensUsed: 0, cacheHit: false, duration: 0 };
    }
    async chatWithTools(_request: unknown, _exec: unknown, options?: { signal?: AbortSignal }) {
      seen.tools.push(options?.signal);
      return { rawResponse: '', output: '', tokensUsed: 0, cacheHit: false, duration: 0 };
    }
    chatStream(_request: unknown, _callbacks: unknown, signal?: AbortSignal) {
      seen.stream.push(signal);
      return Promise.resolve({ rawResponse: '', output: '' });
    }
  },
}));

/** char_gen 链的产出：抛什么由用例设置 */
const charGenThrows = { current: null as unknown };

vi.mock('@engine/char-gen-agent', () => ({
  runCharGenChain: vi.fn(async () => {
    if (charGenThrows.current) throw charGenThrows.current;
    return { character: null, narrativeSummary: '' };
  }),
}));

vi.mock('@engine/state-manager', () => ({
  createStateManager: vi.fn(() => ({
    commitChatState: vi.fn(async () => ({ success: true, errors: [] })),
    advanceTurn: vi.fn(async () => {}),
  })),
}));

import { GamePipeline } from './game-pipeline';

function makePipeline() {
  const game = {
    activeSaveId: 'save-test',
    messages: [],
    characters: [],
    isGenerating: false,
    addAgentLogEntry: vi.fn(),
    updateAgentStatus: vi.fn(),
    clearAgentStatus: vi.fn(),
    clearAllAgentStatus: vi.fn(),
    clearAgentLog: vi.fn(),
    addMessage: vi.fn((content: string, role: string) => ({ id: 'm1', role, content, turn: 1 })),
    setPendingOptions: vi.fn(),
    refreshFromDb: vi.fn(async () => {}),
  } as any;
  const settings = {
    settings: {
      apiPool: [{ id: 'ep', name: 'ep', baseUrl: 'http://x', apiKey: 'k', model: 'm' }],
      agents: {},
    },
  } as any;
  const pipeline = new GamePipeline({
    gameStore: game,
    settingsStore: settings,
    saveId: 'save-test',
  });
  return { pipeline, game };
}

/** 造一个客户端：模拟侧链拿到 clientFactory 之后建 client 的那一步 */
function makeClient(pipeline: GamePipeline) {
  const factory = (pipeline as any).getClientFactory();
  return factory('char_gen', { id: 'ep' } as any, 'save-test');
}

beforeEach(() => {
  charGenThrows.current = null;
  seen.chat = [];
  seen.tools = [];
  seen.stream = [];
});

describe('侧链取消接线', () => {
  it('🔴 侧链没传 signal 时回落本轮的 abortController —— 三个入口都要接上', async () => {
    const { pipeline } = makePipeline();
    const controller = new AbortController();
    (pipeline as any).abortController = controller;

    const client = makeClient(pipeline);
    await client.chat({ messages: [] });
    await client.chatWithTools({ messages: [] }, vi.fn());
    await client.chatStream({ messages: [] }, {});

    // 修复前这三个全是 undefined —— abort() 对侧链完全没有作用
    expect(seen.chat[0]).toBe(controller.signal);
    expect(seen.tools[0]).toBe(controller.signal);
    expect(seen.stream[0]).toBe(controller.signal);
  });

  it('调用方自己传了 signal 就用它的（回落不抢占既有契约）', async () => {
    const { pipeline } = makePipeline();
    (pipeline as any).abortController = new AbortController();
    const own = new AbortController();

    const client = makeClient(pipeline);
    await client.chat({ messages: [] }, own.signal);
    await client.chatWithTools({ messages: [] }, vi.fn(), { signal: own.signal });

    expect(seen.chat[0]).toBe(own.signal);
    expect(seen.tools[0]).toBe(own.signal);
  });

  it('🔴 信号在**工厂创建时**定死 —— 下一轮换了控制器也掐不动上一轮在飞的侧链', async () => {
    const { pipeline } = makePipeline();
    const roundOne = new AbortController();
    (pipeline as any).abortController = roundOne;

    // 侧链在第一轮里拿到工厂
    const client = makeClient(pipeline);

    // 第一轮还没收尾，第二轮已经开跑（abort() 会立刻解锁输入框，这是真会发生的时序）
    (pipeline as any).abortController = new AbortController();

    await client.chat({ messages: [] });

    // 每次调用现取的话这里会变成第二轮的信号 —— 于是第一轮的 abort 掐不动它，
    // 这条修复想要的效果正好丢掉
    expect(seen.chat[0]).toBe(roundOne.signal);
  });

  it('abort() 之后侧链拿到的信号确实已经是 aborted', async () => {
    const { pipeline } = makePipeline();
    (pipeline as any).abortController = new AbortController();
    const client = makeClient(pipeline);

    pipeline.abort();
    await client.chat({ messages: [] });

    expect(seen.chat[0]?.aborted).toBe(true);
  });
});

describe('取消不是失败', () => {
  const markers = [
    { attributes: { characterName: '甲' } },
    { attributes: { characterName: '乙' } },
    { attributes: { characterName: '丙' } },
  ] as any;

  it('🔴 侧链被取消 → 清干净状态（不留红），且**跳出整个循环**不再逐个重试', async () => {
    const { pipeline, game } = makePipeline();
    (pipeline as any).abortController = new AbortController();
    charGenThrows.current = Object.assign(new Error('Aborted'), { name: 'AbortError' });

    await (pipeline as any).handleCharGen(markers, {} as any);

    // 清状态时不带 error 参数 = UI 上不留失败态
    expect(game.clearAgentStatus).toHaveBeenCalledWith('char_gen');
    expect(game.clearAgentStatus).not.toHaveBeenCalledWith('char_gen', expect.anything());
    // 三个标记只试了第一个就跳出（信号已经拉了，后两个只会各自再被掐一次）
    expect(game.updateAgentStatus).toHaveBeenCalledTimes(1);
  });

  it('真失败仍然逐个继续，并带 error 报出来（不误伤既有语义）', async () => {
    const { pipeline, game } = makePipeline();
    (pipeline as any).abortController = new AbortController();
    charGenThrows.current = new Error('模型抽风');

    await (pipeline as any).handleCharGen(markers, {} as any);

    expect(game.clearAgentStatus).toHaveBeenCalledWith(
      'char_gen',
      expect.stringContaining('模型抽风'),
    );
    // 单个 NPC 失败不连锁抛弃后续请求（2026-07-17 真机修的那条语义）
    expect(game.updateAgentStatus).toHaveBeenCalledTimes(3);
  });
});

describe('run() 的收尾不许踩到下一轮（runSeq 守卫）', () => {
  it('🔴 上一轮的 finally 不清 isGenerating、也不抹掉新一轮的 abortController', async () => {
    const { pipeline, game } = makePipeline();

    // 第一轮开跑（世界书/预设都没接，管线会很快失败 —— 这里只关心 finally 干了什么）
    const first = pipeline.run('第一轮');
    // 模拟「abort() 解锁输入 → 玩家立刻发下一轮」：新一轮抢过了 runSeq 与控制器
    (pipeline as any).runSeq = 99;
    const roundTwo = new AbortController();
    (pipeline as any).abortController = roundTwo;
    game.isGenerating = true;

    await first;

    // 修复前：这两条都会被上一轮的 finally 踩掉 —— 输入框在新一轮飞行中解锁，
    // 且「停止生成」变成静默 no-op（abort() 里的 `?.` 会吃掉 null）
    expect(game.isGenerating).toBe(true);
    expect((pipeline as any).abortController).toBe(roundTwo);
  });
});
