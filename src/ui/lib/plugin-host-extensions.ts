/**
 * 插件宿主的 P2 扩展方法 —— 插件系统设计 §5.6（存储）、§5.7（外链）、§5.8（AI 手段）。
 *
 * 每个工厂返回一个 `PluginHostExtension`（方法名 → 处理函数），由运行时注册进宿主会话。
 * 能力闸门（`capabilities.storage` / `capabilities.ai`）已在 `plugin-bridge.ts` 里过完，
 * 这里只管参数形状、存档前置（`NO_SAVE`）、写入许可（`ctx.canWrite()`）与落库。
 *
 * 依赖一律注入：本文件不碰 Dexie、Pinia、DOM，便于单测，也让运行时（E1）决定接线。
 *
 * 几条约束：
 * - 存档级写入（`storage.save.*` 写、`ai.note`、`ai.context.set`）要有存档、`canWrite()` 放行，
 *   并把 `ctx.guard` 交给落库函数在写锁内复查；成功后调 `ctx.afterWrite()`（补当前回合快照）。
 *   整次调用由宿主（`plugin-host.ts` 的 `SAVE_WRITE_METHODS`）登记为在途写入，
 *   新增存档级写方法时要同步加进那张表，否则发送侧等待（§6.1）等不到它的落库。
 * - 设备级存储（`storage.global.*`）不需要存档，也不受存档写入许可约束。
 * - `ui.openExternal` 永不导航、永不 `window.open`：只把校验过的完整地址交给弹窗，
 *   让玩家自己复制（设计 §5.7、Q12）。
 */
import { validateExternalUrl } from '../../core/plugins/plugin-network';
import type { PluginErrorCode, PluginResult, PluginRunGuard } from '../../core/types/types-plugin';
import type { PluginNoteSystemEvent } from '../../core/types/types';
import type { PluginHostCallContext, PluginHostExtension } from './plugin-bridge';

/** 键长上限：键只是索引，不该拿来装数据 */
const MAX_KEY_CHARS = 256;

/** 会污染原型链的键，一律拒收 */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(code: PluginErrorCode, message: string): PluginResult<unknown> {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验存储键；合格返回 `null`，否则返回 `INVALID` 结果 */
function checkKey(key: unknown): PluginResult<unknown> | null {
  if (typeof key !== 'string' || key.length === 0) return fail('INVALID', '键必须是非空字符串');
  if (key.length > MAX_KEY_CHARS) return fail('INVALID', `键不能超过 ${MAX_KEY_CHARS} 个字符`);
  if (UNSAFE_KEYS.has(key)) return fail('INVALID', `键不能是 ${key}`);
  return null;
}

/** 值必须是 JSON 安全的：能序列化、不是 `undefined`、不含非有限数字 */
function checkJsonValue(value: unknown): PluginResult<unknown> | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('非有限数字');
      return v;
    });
  } catch {
    return fail('INVALID', '值必须能 JSON 序列化');
  }
  return json === undefined ? fail('INVALID', '值必须能 JSON 序列化') : null;
}

/** 存档级写入的公共前置：要有存档，且宿主此刻允许写 */
function checkSaveWrite(ctx: PluginHostCallContext): PluginResult<unknown> | string {
  if (ctx.saveId === null) return fail('NO_SAVE', '当前没有载入存档');
  const allowed = ctx.canWrite();
  if (!allowed.ok) return allowed;
  return ctx.saveId;
}

/** 写入成功后补快照；失败结果原样透传 */
async function settle(
  ctx: PluginHostCallContext,
  result: PluginResult<unknown>,
): Promise<PluginResult<unknown>> {
  if (result.ok) await ctx.afterWrite();
  return result;
}

// ---------------------------------------------------------------------------
// 存储（§5.6）
// ---------------------------------------------------------------------------

/** 存储扩展的依赖：存档级走 save-profile 的窄写入口，设备级走 pluginKv 表 */
export interface PluginStorageExtensionDeps {
  getSaveBag(saveId: string, pluginId: string): Promise<Record<string, unknown>>;
  writeSaveKv(
    saveId: string,
    pluginId: string,
    op: { set: [string, unknown] } | { remove: string },
    guard: PluginRunGuard,
  ): Promise<PluginResult>;
  kvGet(pluginId: string, key: string): Promise<PluginResult<unknown>>;
  kvSet(pluginId: string, key: string, value: unknown): Promise<PluginResult<unknown>>;
  kvRemove(pluginId: string, key: string): Promise<PluginResult<unknown>>;
}

/** `storage.save.get|set|remove` 与 `storage.global.get|set|remove` */
export function createPluginStorageExtension(
  deps: PluginStorageExtensionDeps,
): PluginHostExtension {
  return {
    methods: {
      'storage.save.get': async (ctx, args) => {
        const bad = checkKey(args[0]);
        if (bad) return bad;
        if (ctx.saveId === null) return fail('NO_SAVE', '当前没有载入存档');
        const key = args[0] as string;
        const bag = await deps.getSaveBag(ctx.saveId, ctx.pluginId);
        return {
          ok: true,
          value: Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined,
        };
      },
      'storage.save.set': async (ctx, args) => {
        const bad = checkKey(args[0]) ?? checkJsonValue(args[1]);
        if (bad) return bad;
        const saveId = checkSaveWrite(ctx);
        if (typeof saveId !== 'string') return saveId;
        const key = args[0] as string;
        return settle(
          ctx,
          await deps.writeSaveKv(saveId, ctx.pluginId, { set: [key, args[1]] }, ctx.guard),
        );
      },
      'storage.save.remove': async (ctx, args) => {
        const bad = checkKey(args[0]);
        if (bad) return bad;
        const saveId = checkSaveWrite(ctx);
        if (typeof saveId !== 'string') return saveId;
        const key = args[0] as string;
        return settle(
          ctx,
          await deps.writeSaveKv(saveId, ctx.pluginId, { remove: key }, ctx.guard),
        );
      },
      'storage.global.get': async (ctx, args) => {
        const bad = checkKey(args[0]);
        return bad ?? deps.kvGet(ctx.pluginId, args[0] as string);
      },
      'storage.global.set': async (ctx, args) => {
        const bad = checkKey(args[0]) ?? checkJsonValue(args[1]);
        return bad ?? deps.kvSet(ctx.pluginId, args[0] as string, args[1]);
      },
      'storage.global.remove': async (ctx, args) => {
        const bad = checkKey(args[0]);
        return bad ?? deps.kvRemove(ctx.pluginId, args[0] as string);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// AI 手段（§5.8）
// ---------------------------------------------------------------------------

/** AI 扩展的依赖 */
export interface PluginAiExtensionDeps {
  enqueueNote(
    saveId: string,
    pluginId: string,
    pluginName: string,
    text: string,
    opts: { turn: number; visible?: boolean },
    guard: PluginRunGuard,
  ): Promise<PluginResult>;
  setContext(
    saveId: string,
    pluginId: string,
    text: string | null,
    guard: PluginRunGuard,
  ): Promise<PluginResult>;
  /** 当前已完成的回合号（与投影的 `run.turn` 同口径） */
  currentTurn(): number;
  /** 落一条 system 通知条（运行时接到 game-store 的 `addSystemMessage`） */
  addSystemNotice(event: PluginNoteSystemEvent): void;
}

/** `ai.note` [text] / [text, {visible?}] 与 `ai.context.set` [text|null] */
export function createPluginAiExtension(deps: PluginAiExtensionDeps): PluginHostExtension {
  return {
    methods: {
      'ai.note': async (ctx, args) => {
        const text = args[0];
        if (typeof text !== 'string') return fail('INVALID', '告知内容必须是字符串');
        const opts = args[1];
        if (opts !== undefined && !isRecord(opts)) return fail('INVALID', '选项必须是对象');
        const visible = opts?.visible;
        if (visible !== undefined && typeof visible !== 'boolean') {
          return fail('INVALID', 'visible 必须是布尔值');
        }
        const saveId = checkSaveWrite(ctx);
        if (typeof saveId !== 'string') return saveId;
        const pluginName = ctx.manifest.name;
        const result = await deps.enqueueNote(
          saveId,
          ctx.pluginId,
          pluginName,
          text,
          visible === true
            ? { turn: deps.currentTurn(), visible: true }
            : { turn: deps.currentTurn() },
          ctx.guard,
        );
        if (result.ok && visible === true) {
          // 插件名与正文都是不可信文本：通知条按纯文本渲染（见 PluginNoteSystemEvent 注释）
          deps.addSystemNotice({
            type: 'plugin_note',
            pluginId: ctx.pluginId,
            pluginName,
            text,
            narrative: `${pluginName}：${text}`,
          });
        }
        return settle(ctx, result);
      },
      'ai.context.set': async (ctx, args) => {
        const text = args[0];
        if (text !== null && typeof text !== 'string') {
          return fail('INVALID', '提示块必须是字符串或 null');
        }
        const saveId = checkSaveWrite(ctx);
        if (typeof saveId !== 'string') return saveId;
        return settle(ctx, await deps.setContext(saveId, ctx.pluginId, text, ctx.guard));
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 外链（§5.7）
// ---------------------------------------------------------------------------

/** 外链扩展的依赖 */
export interface PluginExternalLinkExtensionDeps {
  /** 打开「复制链接」弹窗；宿主永不替玩家打开该地址 */
  showExternalLink(pluginName: string, url: string): void;
}

/** `ui.openExternal` [url]：校验后只交给弹窗展示与复制 */
export function createPluginExternalLinkExtension(
  deps: PluginExternalLinkExtensionDeps,
): PluginHostExtension {
  return {
    methods: {
      'ui.openExternal': async (ctx, args) => {
        const checked = validateExternalUrl(args[0]);
        if (!checked.ok) return fail('INVALID', `外链不合格：${checked.reason}`);
        deps.showExternalLink(ctx.manifest.name, checked.url);
        return { ok: true };
      },
    },
  };
}
