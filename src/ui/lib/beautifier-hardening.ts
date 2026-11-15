/**
 * 美化帧加固开关 —— 插件系统设计 §4.4、§11 前两档。
 *
 * 为真时两档美化帧（规则帧 / 模型帧）的 CSP 去掉明文 `http:` 与 `ws:`，并套一层
 * 牢笼帧（`frame-cage.ts` 的 relay 模式）拦住帧的自我导航。
 *
 * 这是模块级状态而不是组件 prop 链：由插件运行时 store 在当前存档带
 * `metadata.pluginHardened` 或启用了任意插件时置真（规划决策 8：按存档粘滞，
 * 一旦置真不再清除），美化帧组件只读它。默认 false：没启用插件的存档保持现状。
 */
import { readonly, ref } from 'vue';

const hardened = ref(false);

/** 只读视图：组件读它决定是否走加固文档；写入只经 `setBeautifierHardened`。 */
export const beautifierHardened = readonly(hardened);

export function setBeautifierHardened(value: boolean): void {
  hardened.value = value;
}
