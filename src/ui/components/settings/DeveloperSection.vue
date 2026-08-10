<script setup lang="ts">
/** 开发者模式分区 —— 单一开关 + 清晰的诊断边界。 */
import AppCard from '../shared/AppCard.vue';
import { useSettingsStore } from '../../stores/settings-store';

const s = useSettingsStore().settings;
</script>

<template>
  <section class="section centered">
    <h3>开发者模式</h3>
    <p class="section-desc">
      解锁 Agent 诊断与原始运行数据。普通游玩中的回合进程仍使用游戏语言，不会变成技术控制台。
    </p>

    <AppCard padding="md" class="developer-mode-card" :class="{ 'is-enabled': s.developerMode }">
      <div class="developer-toggle-row">
        <div class="developer-copy">
          <div class="developer-title-row">
            <h4>开发者模式</h4>
            <span class="developer-state" :class="{ 'is-enabled': s.developerMode }">
              <i
                :class="s.developerMode ? 'fa-solid fa-code' : 'fa-solid fa-lock'"
                aria-hidden="true"
              ></i>
              {{ s.developerMode ? '已开启' : '已关闭' }}
            </span>
          </div>
          <p id="developer-mode-help" class="card-desc">
            开启后，游戏工具栏会出现「调试」入口，并启用 Alt + Shift + D 诊断抽屉。
          </p>
        </div>

        <label class="toggle-label developer-toggle">
          <input
            v-model="s.developerMode"
            type="checkbox"
            role="switch"
            class="toggle-input"
            aria-label="开发者模式"
            aria-describedby="developer-mode-help"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </AppCard>

    <AppCard padding="md">
      <h4>启用后可查看</h4>
      <ul class="developer-capabilities">
        <li>
          <i class="fa-solid fa-bug" aria-hidden="true"></i>
          <span><strong>Agent 调用日志</strong>请求消息、模型响应、耗时与 token 用量</span>
        </li>
        <li>
          <i class="fa-solid fa-screwdriver-wrench" aria-hidden="true"></i>
          <span><strong>工具往返</strong>工具名称、参数、结果与失败原因</span>
        </li>
        <li>
          <i class="fa-solid fa-file-export" aria-hidden="true"></i>
          <span><strong>诊断导出</strong>当前回合与存档快照，便于复现和定位问题</span>
        </li>
      </ul>

      <p class="developer-warning" role="note">
        <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
        诊断内容可能包含对话正文、提示词与模型原始输出。分享导出文件前请先检查内容。
      </p>
    </AppCard>
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
.developer-mode-card {
  transition:
    border-color var(--theme-transition-fast),
    background-color var(--theme-transition-fast);
}

.developer-mode-card.is-enabled {
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  background-color: color-mix(in srgb, var(--theme-primary) 5%, var(--theme-card-bg));
}

.developer-toggle-row,
.developer-title-row {
  display: flex;
  align-items: center;
}

.developer-toggle-row {
  justify-content: space-between;
  gap: var(--theme-spacing-lg);
}

.developer-copy {
  min-width: 0;
  flex: 1;
}

.developer-title-row {
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-xs);
}

.developer-title-row h4 {
  margin: 0;
  color: var(--theme-text-primary);
  font-size: 0.95rem;
}

.developer-copy .card-desc {
  margin: 0;
}

.developer-state {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  padding: 2px 8px;
  border: 1px solid var(--theme-card-border);
  border-radius: 999px;
  color: var(--theme-text-muted);
  background: var(--theme-content-bg);
  font-size: 0.6875rem;
  line-height: 1.5;
}

.developer-state.is-enabled {
  border-color: color-mix(in srgb, var(--theme-success) 36%, var(--theme-card-border));
  color: var(--theme-success);
  background: color-mix(in srgb, var(--theme-success) 8%, var(--theme-card-bg));
}

.developer-toggle {
  flex: 0 0 auto;
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
}

.developer-capabilities {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--theme-spacing-md);
}

.developer-capabilities li {
  min-width: 0;
  display: grid;
  grid-template-columns: 1.75rem minmax(0, 1fr);
  align-items: start;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-secondary);
  background: var(--theme-content-bg);
  font-size: 0.75rem;
  line-height: 1.55;
}

.developer-capabilities li > i {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 9%, var(--theme-card-bg));
  font-size: 0.6875rem;
}

.developer-capabilities strong {
  display: block;
  margin-bottom: 2px;
  color: var(--theme-text-primary);
  font-size: 0.8rem;
}

.developer-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-sm);
  margin: var(--theme-spacing-md) 0 0;
  padding-top: var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  line-height: 1.55;
}

.developer-warning i {
  margin-top: 0.15em;
  color: var(--theme-primary);
}

@media (max-width: 900px) {
  .developer-capabilities {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .developer-toggle-row {
    align-items: flex-start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .developer-mode-card {
    transition: none;
  }
}
</style>
