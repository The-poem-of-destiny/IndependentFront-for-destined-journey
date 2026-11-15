/**
 * 插件宿主会话 —— 插件系统设计 §5.1–§5.4、§5.7–§5.8、§6.1–§6.3、§6.5。
 *
 * 一个插件在当前存档上的一份会话，实现桥背后的 `PluginBridgeHost`：
 * 桥（`plugin-bridge.ts`）已经做完协议解析、限流、大小上限与能力闸门，到这里的调用
 * 只剩「这件事现在能不能做、怎么做」。
 *
 * 环境访问全部注入（存档 id、投影输入、运行守卫、跨标签页锁、StateManager、界面回调、
 * P2 扩展方法），本模块不碰 Pinia，不挂组件即可单测。运行时由 `plugin-runtime-store` 装配。
 *
 * 几条硬约束：
 * - 写入的闸门顺序固定：没有存档 → `NO_SAVE`；跨标签页锁不在手 → `BUSY`；
 *   生成中 / 战斗中 → `BUSY` / `IN_COMBAT`。锁内复检由 `commitPluginCommand` 自己再做一次。
 * - 提交成功之后才补写本轮快照（`amendCurrentTurnSnapshot` 自己拿锁，绝不能在写锁里调），
 *   再回读游戏状态、再推订阅的投影。整段登记进 `trackPluginWrite`，
 *   让发送侧等待（§6.1）把补快照和回读也一并等完（§6.3）。存档级扩展写入
 *   （`SAVE_WRITE_METHODS`）同样整次调用登记，不只登记收尾。
 * - 越过端口的值只能是纯 JSON：读投影由 `buildPluginView` 做 JSON 往返，
 *   其余返回值本模块自己拼，不把注入进来的（可能是响应式代理的）对象原样交出去。
 * - `ui.fillInput` 只回填玩家输入框，永不替玩家发送。
 */
import { buildPluginView, type PluginProjectionInput } from '../../core/plugins/plugin-projection';
import { translatePluginCommands } from '../../core/plugins/plugin-commands';
import { PLUGIN_VIEWS } from '../../core/plugins/plugin-surface';
import type { StatePatch } from '../../core/types/types';
import type {
  PluginErrorCode,
  PluginExpect,
  PluginManifest,
  PluginResult,
  PluginRunGuard,
} from '../../core/types/types-plugin';
import type {
  PluginBridgeHost,
  PluginHostCall,
  PluginHostCallContext,
  PluginHostExtension,
} from './plugin-bridge';
import { trackPluginWrite } from './plugin-run-signals';
import type { PluginSaveLockState } from './plugin-save-lock';

/** 本模块用到的 StateManager 切面（game-store 按存档现建 `createStateManager(saveId)`） */
export interface PluginHostStateManager {
  commitPluginCommand(input: {
    saveId: string;
    pluginId: string;
    patches: readonly StatePatch[];
    expect: readonly PluginExpect[];
    isAllowed: PluginRunGuard;
    commandIndexOfPatch?: readonly number[];
  }): Promise<PluginResult>;
  amendCurrentTurnSnapshot(): Promise<void>;
}

/** 插件能动的界面回调；参数已由本模块校验过 */
interface PluginHostUi {
  /** 关掉这个插件界面 */
  close(surfaceId: string): void;
  /** 请求改尺寸（像素，已取整；最终夹逼归界面层） */
  resize(surfaceId: string, width: number, height: number): void;
  /** 宿主 toast（纯文本） */
  toast(text: string): void;
  /** 回填玩家输入框，只填不发 */
  fillInput(text: string): void;
}

/** 建一份宿主会话所需的全部依赖 */
export interface PluginHostDeps {
  pluginId: string;
  manifest: PluginManifest;
  /** 当前存档 id；不在游戏页 / 没有存档时为 `null` */
  getSaveId(): string | null;
  /** 投影输入（可以是响应式状态，`buildPluginView` 会做 JSON 往返） */
  getProjectionInput(): PluginProjectionInput;
  /** 运行态守卫：生成中 `BUSY`，战斗中 `IN_COMBAT` */
  guard: PluginRunGuard;
  /** 本存档跨标签页锁的当前状态（§6.5），只有 `held` 可写 */
  lockState(): PluginSaveLockState;
  /** 主角名（命令 `target` 缺省时的寻址键） */
  playerName(): string;
  /** 按存档取 StateManager */
  stateManagerFor(saveId: string): PluginHostStateManager;
  /** 写入落库后回读游戏状态 */
  refreshAfterWrite(): Promise<void>;
  /** 写入之后重推订阅的投影（桥按订阅过滤） */
  pushViews(): void;
  ui: PluginHostUi;
  /** P2 方法（存储 / AI / 外链）；方法名不得与内建方法或彼此重复 */
  extensions?: readonly PluginHostExtension[];
}

/** 宿主会话：桥的 `invoke` 加上销毁 */
export interface PluginHostSession extends PluginBridgeHost {
  /** 会话结束；之后的调用一律 `INVALID`，写入落库后的重推也不再做 */
  dispose(): void;
}

/** 内建处理、不交给扩展的方法 */
const BUILTIN_METHODS = new Set([
  'read',
  'commit',
  'ui.close',
  'ui.resize',
  'ui.toast',
  'ui.fillInput',
]);

/**
 * 会写存档的扩展方法：整次调用（落库 + `afterWrite` 收尾）登记为在途写入，
 * 让发送侧等待（§6.1）把它们也等完。设备级存储（`storage.global.*`）不碰存档，不在此列。
 */
const SAVE_WRITE_METHODS = new Set([
  'storage.save.set',
  'storage.save.remove',
  'ai.note',
  'ai.context.set',
]);

/** toast 文本上限（字符） */
const TOAST_MAX_CHARS = 200;
/** 回填输入框的文本上限（字符） */
const FILL_INPUT_MAX_CHARS = 4000;
/** 界面尺寸请求的合理上限（像素）；最终夹逼在界面层 */
const SURFACE_MAX_PX = 10000;

type HostMethod = (ctx: PluginHostCallContext, args: unknown[]) => Promise<PluginResult<unknown>>;

function fail(code: PluginErrorCode, message: string, index?: number): PluginResult<unknown> {
  return index === undefined ? { ok: false, code, message } : { ok: false, code, message, index };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPluginView(value: unknown): value is (typeof PLUGIN_VIEWS)[number] {
  return typeof value === 'string' && (PLUGIN_VIEWS as readonly string[]).includes(value);
}

function lockMessage(state: PluginSaveLockState): string {
  switch (state) {
    case 'waiting':
      return '另一个标签页正在使用这个存档，插件写入已暂停';
    case 'unsupported':
      return '当前环境不支持跨标签页锁，插件写入已禁用';
    default:
      return '插件写入未就绪';
  }
}

function guardMessage(guard: 'BUSY' | 'IN_COMBAT'): string {
  return guard === 'BUSY' ? '正在生成本回合，暂不能写入' : '战斗中，暂不能写入';
}

/** 合并扩展方法；与内建方法或彼此重名直接抛 —— 装配错误，不该静默覆盖 */
function mergeExtensions(extensions: readonly PluginHostExtension[]): Map<string, HostMethod> {
  const merged = new Map<string, HostMethod>();
  for (const extension of extensions) {
    for (const [name, handler] of Object.entries(extension.methods)) {
      if (BUILTIN_METHODS.has(name)) throw new Error(`插件扩展方法与内建方法重名：${name}`);
      if (merged.has(name)) throw new Error(`插件扩展方法重名：${name}`);
      merged.set(name, handler);
    }
  }
  return merged;
}

/** 建一份插件宿主会话 */
export function createPluginHost(deps: PluginHostDeps): PluginHostSession {
  const { pluginId, manifest, ui } = deps;
  const extensionMethods = mergeExtensions(deps.extensions ?? []);
  let disposed = false;

  /** 写入闸门：存档 → 跨标签页锁 → 运行态 */
  function canWrite(): PluginResult {
    if (deps.getSaveId() === null) return { ok: false, code: 'NO_SAVE', message: '当前没有存档' };
    const lock = deps.lockState();
    if (lock !== 'held') return { ok: false, code: 'BUSY', message: lockMessage(lock) };
    const guard = deps.guard();
    if (guard !== 'ok') return { ok: false, code: guard, message: guardMessage(guard) };
    return { ok: true };
  }

  /**
   * 写入落库之后的收尾：补写本轮快照 → 回读 → 重推投影。
   * 数据已经落了，收尾某一步失败不该把成功报成失败，只记一条告警。
   */
  async function finishWrite(saveId: string): Promise<void> {
    try {
      await deps.stateManagerFor(saveId).amendCurrentTurnSnapshot();
    } catch (err) {
      console.warn(`[plugin-host] ${pluginId} 写入后补写本轮快照失败:`, err);
    }
    try {
      await deps.refreshAfterWrite();
    } catch (err) {
      console.warn(`[plugin-host] ${pluginId} 写入后回读状态失败:`, err);
    }
    if (!disposed) deps.pushViews();
  }

  function contextFor(call: PluginHostCall): PluginHostCallContext {
    const saveId = deps.getSaveId();
    const ctx: PluginHostCallContext = {
      pluginId,
      manifest,
      saveId,
      guard: deps.guard,
      canWrite,
      afterWrite: () =>
        saveId === null ? Promise.resolve() : trackPluginWrite(finishWrite(saveId)),
    };
    if (call.surfaceId !== undefined) ctx.surfaceId = call.surfaceId;
    return ctx;
  }

  function read(args: unknown[]): PluginResult<unknown> {
    const view = args[0];
    if (!isPluginView(view)) return fail('INVALID', '未知的投影');
    if (deps.getSaveId() === null) return fail('NO_SAVE', '当前没有存档');
    return { ok: true, value: buildPluginView(view, deps.getProjectionInput()) };
  }

  async function commit(args: unknown[]): Promise<PluginResult<unknown>> {
    const saveId = deps.getSaveId();
    if (saveId === null) return fail('NO_SAVE', '当前没有存档');
    const allowed = canWrite();
    if (!allowed.ok) return allowed;

    const input = args[0];
    if (!isRecord(input)) return fail('INVALID', 'commit 需要 { commands: [] }');
    const translated = translatePluginCommands({
      commands: input.commands,
      expect: input.expect,
      declared: manifest.capabilities.commands,
      saveId,
      playerName: deps.playerName(),
    });
    if (!translated.ok) {
      return fail(translated.code, translated.message, translated.index);
    }

    // 提交 + 收尾整段登记为在途写入：发送侧要等到补快照与回读也做完（§6.1、§6.3）
    return trackPluginWrite(
      (async (): Promise<PluginResult<unknown>> => {
        const result = await deps.stateManagerFor(saveId).commitPluginCommand({
          saveId,
          pluginId,
          patches: translated.patches,
          expect: translated.expect,
          isAllowed: deps.guard,
          commandIndexOfPatch: translated.commandIndexOfPatch,
        });
        if (!result.ok) {
          return fail(result.code, result.message, result.index);
        }
        // 🔴 commit 已返回、写锁已放，才能补快照（它自己要拿锁）
        await finishWrite(saveId);
        return { ok: true };
      })(),
    );
  }

  function surfaceOf(call: PluginHostCall): string | null {
    return typeof call.surfaceId === 'string' && call.surfaceId.length > 0 ? call.surfaceId : null;
  }

  function uiClose(call: PluginHostCall): PluginResult<unknown> {
    const surfaceId = surfaceOf(call);
    if (surfaceId === null) return fail('INVALID', '后台页面没有可关闭的界面');
    ui.close(surfaceId);
    return { ok: true };
  }

  function uiResize(call: PluginHostCall): PluginResult<unknown> {
    const surfaceId = surfaceOf(call);
    if (surfaceId === null) return fail('INVALID', '后台页面没有可调整的界面');
    const [width, height] = call.args;
    const valid = (n: unknown): n is number =>
      typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= SURFACE_MAX_PX;
    if (!valid(width) || !valid(height)) return fail('INVALID', '尺寸必须是合理范围内的正数');
    ui.resize(surfaceId, Math.round(width), Math.round(height));
    return { ok: true };
  }

  function uiToast(args: unknown[]): PluginResult<unknown> {
    const text = args[0];
    if (typeof text !== 'string' || text.trim().length === 0) {
      return fail('INVALID', '提示文本必须是非空字符串');
    }
    if (text.length > TOAST_MAX_CHARS) {
      return fail('INVALID', `提示文本不能超过 ${TOAST_MAX_CHARS} 字`);
    }
    ui.toast(text);
    return { ok: true };
  }

  function uiFillInput(args: unknown[]): PluginResult<unknown> {
    const text = args[0];
    if (typeof text !== 'string') return fail('INVALID', '回填文本必须是字符串');
    if (text.length > FILL_INPUT_MAX_CHARS) {
      return fail('INVALID', `回填文本不能超过 ${FILL_INPUT_MAX_CHARS} 字`);
    }
    if (deps.getSaveId() === null) return fail('NO_SAVE', '当前没有存档');
    // 只填不发：发送永远由玩家自己按
    ui.fillInput(text);
    return { ok: true };
  }

  async function dispatch(call: PluginHostCall): Promise<PluginResult<unknown>> {
    const args = Array.isArray(call.args) ? call.args : [];
    switch (call.method) {
      case 'read':
        return read(args);
      case 'commit':
        return commit(args);
      case 'ui.close':
        return uiClose(call);
      case 'ui.resize':
        return uiResize({ ...call, args });
      case 'ui.toast':
        return uiToast(args);
      case 'ui.fillInput':
        return uiFillInput(args);
    }
    const handler = extensionMethods.get(call.method);
    if (handler === undefined) return fail('INVALID', `宿主不支持该方法：${call.method}`);
    const ctx = contextFor(call);
    // 存档级写入整段登记：只登记 afterWrite 的话，落库本身还在飞时发送侧就会放行（§6.1）
    if (SAVE_WRITE_METHODS.has(call.method)) return trackPluginWrite(handler(ctx, args));
    return handler(ctx, args);
  }

  return {
    async invoke(call) {
      if (disposed) return fail('INVALID', '插件会话已结束');
      // 身份只认构造参数：桥填的 pluginId 对不上说明接错了线
      if (call.pluginId !== pluginId) return fail('INVALID', '插件身份不符');
      return dispatch(call);
    },
    dispose() {
      disposed = true;
    },
  };
}
