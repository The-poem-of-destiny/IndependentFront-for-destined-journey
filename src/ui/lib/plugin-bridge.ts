/**
 * 插件桥（宿主侧）—— 插件系统设计 §3.6、§4.7、§5.1、§5.5。
 *
 * 一条 MessagePort 一座桥：负责协议解析、限流、单条大小上限与能力闸门，
 * 通过闸门的调用才交给 `PluginBridgeHost.invoke`（由 `plugin-host.ts` 实现）。
 *
 * 端口协议（与 `plugin-frame.ts` 的帧内引导脚本对齐）：
 * - 帧 → 宿主：`{type:'ready', env}`、`{type:'req', id, method, args}`
 * - 宿主 → 帧：`{type:'res', id, ok:true, value?}` / `{type:'res', id, ok:false, code, message, index?}`、
 *   `{type:'event', name, payload}`、`{type:'view', view, value}`（`init` / `theme` 归帧模块发）
 *
 * 几条硬约束：
 * - 身份（pluginId、surfaceId）只取自构造参数，消息里自报的一律不采信（§4.7）。
 * - 形状不对的消息静默丢弃，不回话 —— 回话等于给乱发消息的帧一个探测通道。
 * - 能力闸门在调用宿主**之前**：未声明的投影 / 命令 / 事件 / AI 手段 / 存储一律 `DENIED`（§3.6）。
 * - 订阅（`subscribe` / `on`）的簿记就在桥里，宿主只管推，桥按订阅 + 声明过滤。
 * - 发往端口的值一律先做 JSON 往返深拷贝：切断 Vue 响应式代理（结构化克隆遇到 Proxy 会抛）。
 */
import { PLUGIN_LIMITS } from '../../core/plugins/plugin-surface';
import type {
  PluginErrorCode,
  PluginManifest,
  PluginResult,
  PluginRunGuard,
} from '../../core/types/types-plugin';

/** 交给宿主的一次调用；身份字段由桥按构造参数填写 */
export interface PluginHostCall {
  pluginId: string;
  method: string;
  args: unknown[];
  surfaceId?: string;
}

/** 桥背后的宿主实现（`plugin-host.ts`） */
export interface PluginBridgeHost {
  invoke(call: PluginHostCall): Promise<PluginResult<unknown>>;
}

/** 宿主执行单个方法时拿到的上下文（P2 扩展方法同样用它） */
export interface PluginHostCallContext {
  pluginId: string;
  manifest: PluginManifest;
  saveId: string | null;
  guard: PluginRunGuard;
  canWrite(): PluginResult;
  afterWrite(): Promise<void>;
  surfaceId?: string;
}

/** P2 方法的注册口：方法名 → 处理函数 */
export interface PluginHostExtension {
  methods: Record<
    string,
    (ctx: PluginHostCallContext, args: unknown[]) => Promise<PluginResult<unknown>>
  >;
}

interface PluginBridgeOptions {
  pluginId: string;
  manifest: PluginManifest;
  port: MessagePort;
  host: PluginBridgeHost;
  /** 限流用的时钟（毫秒），测试注入 */
  now?: () => number;
  surfaceId?: string;
}

interface PluginBridge {
  pushEvent(name: string, payload: unknown): void;
  pushView(view: string, value: unknown): void;
  dispose(): void;
}

/** 请求 id：安全整数，或不超过 64 个字符的非空字符串 */
type RequestId = number | string;

const MAX_STRING_ID_CHARS = 64;
const RATE_WINDOW_MS = 1000;

/** 不需要能力声明、直接交宿主的方法 */
const UI_METHODS = new Set([
  'ui.close',
  'ui.resize',
  'ui.toast',
  'ui.fillInput',
  'ui.openExternal',
]);

/** `storage.<area>.<op>`：area 要在 `capabilities.storage` 里 */
const STORAGE_METHOD = /^storage\.(save|global)\.(get|set|remove)$/;

/** AI 手段方法 → 需要声明的 `capabilities.ai` 项 */
const AI_METHODS: Readonly<Record<string, string>> = {
  'ai.note': 'note',
  'ai.context.set': 'context',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_ID_CHARS;
}

function fail(code: PluginErrorCode, message: string, index?: number): PluginResult<unknown> {
  return index === undefined ? { ok: false, code, message } : { ok: false, code, message, index };
}

/**
 * 量一条消息序列化后的大小：按 JSON 长度计，二进制按字节数计（JSON 会把它们写成 `{}`，
 * 不单独计就能塞进任意大的 ArrayBuffer）。量不出来（循环引用、BigInt 等）返回 `null`。
 */
function measureMessage(data: unknown): number | null {
  let binaryBytes = 0;
  try {
    const text = JSON.stringify(data, (_key, value: unknown) => {
      if (value instanceof ArrayBuffer) {
        binaryBytes += value.byteLength;
        return null;
      }
      if (ArrayBuffer.isView(value)) {
        binaryBytes += value.byteLength;
        return null;
      }
      return value;
    });
    return (text?.length ?? 0) + binaryBytes;
  } catch {
    return null;
  }
}

/** 深拷贝成纯 JSON 值；`undefined` 原样返回，拷不了返回失败 */
function detach(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  try {
    const text = JSON.stringify(value);
    return { ok: true, value: text === undefined ? undefined : (JSON.parse(text) as unknown) };
  } catch {
    return { ok: false };
  }
}

/** 宿主回来的结果先验形状，不认识的当宿主出错 */
function isPluginResult(value: unknown): value is PluginResult<unknown> {
  if (!isRecord(value)) return false;
  if (value.ok === true) return true;
  return value.ok === false && typeof value.code === 'string' && typeof value.message === 'string';
}

/** 建一座桥。端口用 `addEventListener` 监听，帧模块可以在同一端口上另挂监听 */
export function createPluginBridge(options: PluginBridgeOptions): PluginBridge {
  const { pluginId, manifest, port, host, surfaceId } = options;
  const now = options.now ?? (() => Date.now());
  const caps = manifest.capabilities;
  const subscribedViews = new Set<string>();
  const subscribedEvents = new Set<string>();
  /** 最近一秒内被接受的消息时间戳 */
  const recent: number[] = [];
  let disposed = false;

  function post(message: Record<string, unknown>): void {
    if (disposed) return;
    try {
      port.postMessage(message);
    } catch {
      // 端口已被对端关闭或值不可克隆：丢掉这一条，不让一条坏消息打断桥
    }
  }

  function reply(id: RequestId, result: PluginResult<unknown>): void {
    if (result.ok) {
      const detached = detach(result.value);
      if (!detached.ok) {
        post({ type: 'res', id, ok: false, code: 'INVALID', message: '返回值无法序列化' });
        return;
      }
      post(
        detached.value === undefined
          ? { type: 'res', id, ok: true }
          : { type: 'res', id, ok: true, value: detached.value },
      );
      return;
    }
    post({
      type: 'res',
      id,
      ok: false,
      code: result.code,
      message: result.message,
      ...(result.index === undefined ? {} : { index: result.index }),
    });
  }

  /** 每秒至多 `messagesPerSecond` 条；被拒的不计入窗口 */
  function admitByRate(): boolean {
    const t = now();
    while (recent.length > 0 && t - recent[0] >= RATE_WINDOW_MS) recent.shift();
    if (recent.length >= PLUGIN_LIMITS.messagesPerSecond) return false;
    recent.push(t);
    return true;
  }

  /** 第一个参数必须是字符串，且在声明表里 */
  function gateName(
    args: unknown[],
    declared: readonly string[],
    what: string,
  ): PluginResult<unknown> | string {
    const name = args[0];
    if (typeof name !== 'string' || name.length === 0)
      return fail('INVALID', `${what}名必须是字符串`);
    if (!declared.includes(name)) return fail('DENIED', `未声明的${what}：${name}`);
    return name;
  }

  function gateCommit(args: unknown[]): PluginResult<unknown> | null {
    const input = args[0];
    if (!isRecord(input) || !Array.isArray(input.commands)) {
      return fail('INVALID', 'commit 需要 { commands: [] }');
    }
    for (let i = 0; i < input.commands.length; i++) {
      const command: unknown = input.commands[i];
      if (!isRecord(command) || typeof command.type !== 'string') {
        return fail('INVALID', '命令缺少 type', i);
      }
      if (!caps.commands.includes(command.type)) {
        return fail('DENIED', `未声明的命令：${command.type}`, i);
      }
    }
    return null;
  }

  async function forward(method: string, args: unknown[]): Promise<PluginResult<unknown>> {
    const call: PluginHostCall =
      surfaceId === undefined ? { pluginId, method, args } : { pluginId, method, args, surfaceId };
    try {
      const result = await host.invoke(call);
      return isPluginResult(result) ? result : fail('INVALID', '宿主返回了无法识别的结果');
    } catch {
      return fail('INVALID', '宿主处理失败');
    }
  }

  /** 闸门 + 分派；本地处理的方法（订阅簿记）不经宿主 */
  async function handle(method: string, args: unknown[]): Promise<PluginResult<unknown>> {
    switch (method) {
      case 'read': {
        const gated = gateName(args, caps.read, '投影');
        return typeof gated === 'string' ? forward(method, [gated]) : gated;
      }
      case 'subscribe':
      case 'unsubscribe': {
        const gated = gateName(args, caps.read, '投影');
        if (typeof gated !== 'string') return gated;
        if (method === 'subscribe') subscribedViews.add(gated);
        else subscribedViews.delete(gated);
        return { ok: true };
      }
      case 'on':
      case 'off': {
        const gated = gateName(args, caps.events, '事件');
        if (typeof gated !== 'string') return gated;
        if (method === 'on') subscribedEvents.add(gated);
        else subscribedEvents.delete(gated);
        return { ok: true };
      }
      case 'commit': {
        const denied = gateCommit(args);
        return denied ?? forward(method, args);
      }
    }
    if (UI_METHODS.has(method)) return forward(method, args);
    const aiCapability = AI_METHODS[method];
    if (aiCapability !== undefined) {
      return caps.ai.includes(aiCapability)
        ? forward(method, args)
        : fail('DENIED', `未声明的 AI 手段：${aiCapability}`);
    }
    const storage = STORAGE_METHOD.exec(method);
    if (storage) {
      return caps.storage.includes(storage[1])
        ? forward(method, args)
        : fail('DENIED', `未声明的存储：${storage[1]}`);
    }
    return fail('INVALID', `未知方法：${method}`);
  }

  function onMessage(event: MessageEvent): void {
    if (disposed) return;
    const data: unknown = event.data;
    if (!isRecord(data)) return;
    const id = data.type === 'req' && isRequestId(data.id) ? data.id : null;

    if (!admitByRate()) {
      if (id !== null) reply(id, fail('QUOTA', '消息过于频繁'));
      return;
    }
    const size = measureMessage(data);
    if (size === null || size > PLUGIN_LIMITS.messageBytes) {
      if (id !== null) reply(id, fail('INVALID', '消息过大或无法序列化'));
      return;
    }

    if (data.type === 'ready') {
      // 帧环境由帧模块的 onReady 处理；这里只校验形状，不回话
      return;
    }
    if (id === null || typeof data.method !== 'string') return;
    const rawArgs = data.args ?? [];
    if (!Array.isArray(rawArgs)) return;
    const args: unknown[] = rawArgs;

    void handle(data.method, args).then((result) => {
      if (!disposed) reply(id, result);
    });
  }

  port.addEventListener('message', onMessage);
  port.start();

  return {
    pushEvent(name, payload) {
      if (disposed || !subscribedEvents.has(name) || !caps.events.includes(name)) return;
      const detached = detach(payload);
      if (detached.ok) post({ type: 'event', name, payload: detached.value });
    },
    pushView(view, value) {
      if (disposed || !subscribedViews.has(view) || !caps.read.includes(view)) return;
      const detached = detach(value);
      if (detached.ok) post({ type: 'view', view, value: detached.value });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      subscribedViews.clear();
      subscribedEvents.clear();
      port.removeEventListener('message', onMessage);
      port.close();
    },
  };
}
