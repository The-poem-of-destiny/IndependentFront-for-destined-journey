<script setup lang="ts">
/**
 * 消息显示分区 —— 系统通知总开关 + 七类事件过滤（Q-25 从 SettingsPage.vue 抽出）
 */
import { computed } from 'vue';
import AppCard from '../shared/AppCard.vue';
import FormSelect from '../shared/form/FormSelect.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useActionPanelStyle } from '../../composables/useActionPanelStyle';
import { ACTION_PANEL_STYLES, type ActionPanelStyleId } from '../../lib/action-panel-styles';

const s = useSettingsStore().settings;

const { style: actionPanelStyle, setStyle: setActionPanelStyle } = useActionPanelStyle();
const actionPanelStyleOptions = ACTION_PANEL_STYLES.map((st) => ({
  value: st.id,
  label: st.label,
}));
const actionPanelStyleDesc = computed(
  () => ACTION_PANEL_STYLES.find((st) => st.id === actionPanelStyle.value)?.description ?? '',
);

/** 事件键 → 中文名。查不到就把键原样显示出来，不吞掉未知类型 */
function eventFilterLabel(key: string | number): string {
  const labels: Record<string, string> = {
    craft: '制作完成',
    char_gen: '新角色加入',
    item_gen: '新物品获得',
    combat: '战斗结果',
    character_update: '角色微调',
    item_update: '物品变动',
    quest_update: '任务进度',
  };
  return labels[String(key)] ?? String(key);
}
</script>

<template>
  <section class="section centered">
    <h3>消息显示</h3>
    <p class="section-desc">
      控制正文的呈现方式与对话流中系统通知的可见性。关闭后对应类型的消息将不在正文中渲染。
    </p>

    <AppCard padding="md">
      <h4>正文演出</h4>
      <p class="card-desc">
        直出模式的新正文按节放出，点击正文或按空格推进；新角色首次登场时浮现立绘或名字。关闭后整段显示。
      </p>
      <div class="toggle-row">
        <span>逐节演出正文</span>
        <label class="toggle-label">
          <input v-model="s.stagedNarrative" type="checkbox" class="toggle-input" />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </AppCard>

    <AppCard padding="md">
      <h4>行动面板样式</h4>
      <p class="card-desc">正文里检定、伤害与结算面板的呈现方式。</p>
      <FormSelect
        :model-value="actionPanelStyle"
        :options="actionPanelStyleOptions"
        data-testid="action-panel-style"
        @update:model-value="(v) => setActionPanelStyle(v as ActionPanelStyleId)"
      />
      <p class="card-desc action-panel-style-desc">{{ actionPanelStyleDesc }}</p>
    </AppCard>

    <AppCard padding="md">
      <h4>全局开关</h4>
      <div class="toggle-row">
        <span>显示系统通知</span>
        <label class="toggle-label">
          <input v-model="s.systemEventsVisible" type="checkbox" class="toggle-input" />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </AppCard>

    <AppCard padding="md">
      <h4>分类控制</h4>
      <p class="card-desc">选择哪些类型的系统事件在对话流中展示</p>
      <div class="event-filter-grid">
        <div v-for="(enabled, key) in s.systemEventFilters" :key="key" class="toggle-row">
          <span>{{ eventFilterLabel(key) }}</span>
          <label class="toggle-label">
            <input v-model="s.systemEventFilters[key]" type="checkbox" class="toggle-input" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    </AppCard>
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
.action-panel-style-desc {
  margin: var(--theme-spacing-sm) 0 0;
}
.event-filter-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
