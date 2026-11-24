import { computed, type ComputedRef } from 'vue';
import { useSettingsStore } from '../stores/settings-store';
import { resolveActionPanelStyle, type ActionPanelStyleId } from '../lib/action-panel-styles';

/**
 * 行动面板样式（读写 `settings.actionPanelStyle`）。
 *
 * `style` 是归一后的值：旧设置缺键、存了不认识的字符串都读成缺省样式，渲染面拿到的一定合法。
 * `setStyle` 写回设置袋，由 settings-store 的 deep watch 落 localStorage。
 */
export function useActionPanelStyle(): {
  style: ComputedRef<ActionPanelStyleId>;
  setStyle: (id: ActionPanelStyleId) => void;
} {
  const settings = useSettingsStore().settings;
  const style = computed(() => resolveActionPanelStyle(settings.actionPanelStyle));
  function setStyle(id: ActionPanelStyleId): void {
    settings.actionPanelStyle = resolveActionPanelStyle(id);
  }
  return { style, setStyle };
}
