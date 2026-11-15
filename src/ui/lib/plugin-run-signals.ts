/**
 * plugin-run-signals.ts — 回合管线与插件系统之间的模块级接缝（计划决定 12、13）
 *
 * `game-pipeline.ts` 永远不 import 插件 store。两边只经这里交换三类信号:
 *
 * 1. **在途写入**（设计 §6.1「发送侧等待」）: 插件宿主每发起一次写入就 `trackPluginWrite`，
 *    管线开始读状态前 `await whenPluginWritesSettled()`，把落库与快照修补都等完。
 * 2. **回合事件**: 管线在回合开始 / 结束 / 失败时 `emitPluginTurnSignal`，插件运行时订阅后
 *    转成插件事件。监听方抛错一律吞掉，不许打断管线。
 * 3. **提示词输入**（决定 13）: 插件运行时注册 provider，管线组提示词时取
 *    `getPluginPromptInputs()`。没有 provider 或 provider 抛错都返回空列表 —— 插件出问题
 *    不能让一回合发不出去。
 *
 * 状态全在模块级；测试用 {@link resetPluginRunSignalsForTest} 复位。
 */

import type { PluginPromptInputs } from '@engine/types/types-plugin';

/** 管线发给插件运行时的回合信号 */
export interface PluginTurnSignal {
  type: 'turn.start' | 'turn.end' | 'turn.failed';
  saveId: string;
}

type PluginTurnListener = (signal: PluginTurnSignal) => void;
type PluginPromptInputProvider = () => PluginPromptInputs;

const inflight = new Set<Promise<void>>();
const listeners = new Set<PluginTurnListener>();
let promptProvider: PluginPromptInputProvider | null = null;

/**
 * 登记一笔在途的插件写入，原样返回同一个 Promise 方便链式使用。
 * 写入失败也算「结束」—— 等待方只关心有没有还在跑的，不关心成败。
 */
export function trackPluginWrite<T>(p: Promise<T>): Promise<T> {
  const settled = p.then(
    () => undefined,
    () => undefined,
  );
  inflight.add(settled);
  void settled.then(() => inflight.delete(settled));
  return p;
}

/**
 * 等所有在途写入结束。等待期间新登记的写入也一并等完（循环直到集合为空）。
 * 永不 reject。
 */
export async function whenPluginWritesSettled(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.all([...inflight]);
  }
}

/** 管线派发回合信号；单个监听方抛错不影响其他监听方，也不冒泡给管线 */
export function emitPluginTurnSignal(signal: PluginTurnSignal): void {
  for (const listener of [...listeners]) {
    try {
      listener(signal);
    } catch {
      // 插件侧的问题不许打断回合管线
    }
  }
}

/** 订阅回合信号，返回取消订阅函数 */
export function onPluginTurnSignal(cb: PluginTurnListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 注册（或用 `null` 清除）插件提示词输入的提供方；后注册的覆盖先注册的 */
export function setPluginPromptInputProvider(fn: PluginPromptInputProvider | null): void {
  promptProvider = fn;
}

function emptyInputs(): PluginPromptInputs {
  return { notes: [], contexts: [] };
}

/**
 * 取本回合要注入的插件文本。没有 provider、provider 抛错、返回形状不对时都给空列表。
 * 返回的是浅拷贝，调用方改它不影响 provider 内部状态。
 */
export function getPluginPromptInputs(): PluginPromptInputs {
  if (!promptProvider) return emptyInputs();
  try {
    const raw = promptProvider();
    if (!raw || !Array.isArray(raw.notes) || !Array.isArray(raw.contexts)) return emptyInputs();
    return { notes: [...raw.notes], contexts: [...raw.contexts] };
  } catch {
    return emptyInputs();
  }
}

/** 仅供测试：清空在途写入、监听方与 provider */
export function resetPluginRunSignalsForTest(): void {
  inflight.clear();
  listeners.clear();
  promptProvider = null;
}
