import { getActivePinia } from 'pinia';
import { applyNsfwMode, nsfwEnabled } from '@engine/content/nsfw-filter';
import { useSettingsStore } from '../stores/settings-store';

/**
 * 当前是否允许露骨内容（响应式读取 `settings.nsfwContent`）。
 *
 * 没有激活的 Pinia 时（组件单测只挂组件不装 store）退回引擎注入缝的 `nsfwEnabled()`，
 * 那边缺省按「关」处理 —— 与生产默认一致，且不让每个组件测试都得为这一个开关装 Pinia。
 */
export function useNsfwEnabled(): () => boolean {
  const settings = getActivePinia() ? useSettingsStore().settings : null;
  return () => (settings ? settings.nsfwContent === true : nsfwEnabled());
}

/**
 * 游戏界面显示内容包文本时的露骨内容过滤（设计：docs/planning/2026-11-20-explicit-content-switch-design.md）。
 *
 * 返回的函数在模板里调用时会读 `settings.nsfwContent` 这个响应式值，开关一拨，用到它的组件即时重渲染。
 *
 * 🔴 世界书编辑器、Agent / 预设提示词编辑器**不要**用它 —— 那几处是「直接查看原文」，必须显示标记原样。
 */
export function useNsfwText(): (text: string | null | undefined) => string {
  const enabled = useNsfwEnabled();
  return (text) => (text ? applyNsfwMode(text, enabled()) : '');
}
