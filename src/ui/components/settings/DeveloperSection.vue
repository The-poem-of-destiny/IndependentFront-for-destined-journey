<script setup lang="ts">
/** 开发者模式分区 —— 单一开关 + 清晰的诊断边界。 */
import { computed, onMounted, ref, watch } from 'vue';
import AppCard from '../shared/AppCard.vue';
import AppButton from '../shared/AppButton.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import {
  decideStoryContextAdmission,
  isStoryContextV2Save,
} from '@engine/story/story-context-mode';
import { confirmDialog } from '../../lib/confirm-dialog';
import { ENGINE_LOG_LEVELS } from '@engine/runtime/engine-logger';
import { clearEngineLogs, countEngineLogs } from '@engine/persistence/engine-log-store';
import { exportEngineLogs } from '../../lib/engine-log-export';

const s = useSettingsStore().settings;
const game = useGameStore();
const ui = useUIStore();

function updateLoreHistoryMessages(event: Event) {
  const input = event.target as HTMLInputElement;
  const count = input.valueAsNumber;
  if (!Number.isSafeInteger(count) || count < 0) {
    if (event.type === 'input') return;
    input.value = String(s.loreHistoryMessages);
    ui.toast('检索历史消息数必须是 0 或正整数', 'warning');
    return;
  }
  s.loreHistoryMessages = count;
}

function updateStoryWindowBatchTurns(event: Event) {
  const input = event.target as HTMLInputElement;
  const count = input.valueAsNumber;
  if (!Number.isSafeInteger(count) || count < 1) {
    if (event.type === 'input') return;
    input.value = String(s.storyWindowBatchTurns);
    ui.toast('正文换窗批大小必须是正整数', 'warning');
    return;
  }
  s.storyWindowBatchTurns = count;
}

/**
 * 回合进行中不许切换 Story 模式（T39）：一个回合在开跑时就固定了模式，
 * 这里把开关锁住，免得玩家以为切换对正在生成的这一轮生效。
 */
const storyModeLocked = computed(() => game.isGenerating);

/**
 * 切换模式后，当前打开的存档若不再被准入（关掉开关时的测试档 / 打开开关时的普通档），
 * 立即退出它（计划 P6）：清掉会话投影，并把「游戏页」从返回历史里拿掉 ——
 * 否则点返回会回到一个这个模式下不能继续的存档。游戏页重新挂载时的准入检查仍是兜底。
 */
const exitedSaveName = ref('');
watch(
  () => s.storyContextV2Enabled,
  (enabled) => {
    const save = game.activeSave;
    if (!save || decideStoryContextAdmission(save, enabled === true).ok) return;
    exitedSaveName.value = save.name ?? '';
    game.clearActive();
    ui.activeSaveId = null;
    ui.viewHistory = ui.viewHistory.filter((view) => view !== 'game');
  },
);

/** 开关下方常驻的一句：当前哪一类存档能进（S-04） */
const openableSavesLine = computed(() =>
  s.storyContextV2Enabled
    ? '当前可进入：测试存档。普通存档需关闭本模式后才能进入。'
    : '当前可进入：普通存档。测试存档需开启本模式后才能进入。',
);

/**
 * 切换前确认（S-04）：这个开关会把人踢出当前存档、并锁住另一类存档，
 * 所以开与关都要先按**当前情形**把后果说清楚；取消时开关保持原样。
 */
function buildStoryModeConfirm(next: boolean): { title: string; message: string } {
  const save = game.activeSave;
  const name = save?.name ?? '当前存档';
  const willExit = !!save && !decideStoryContextAdmission(save, next).ok;
  if (next) {
    const lead = willExit
      ? `当前存档《${name}》是普通存档，开启后会立即退出，且开启期间所有普通存档无法进入。`
      : save && isStoryContextV2Save(save)
        ? `当前存档《${name}》是测试存档，可以继续使用；开启期间所有普通存档无法进入。`
        : '开启期间所有普通存档无法进入。';
    return {
      title: '开启 Story 上下文与记忆新模式？',
      message: `${lead}之后新建的存档会被永久标记为「测试方案」，这些测试存档只能在开启本模式时进入。`,
    };
  }
  const lead = willExit
    ? `当前存档《${name}》是测试存档，关闭后会立即退出，且关闭期间所有测试存档无法进入。`
    : '关闭期间所有测试存档无法进入。';
  return {
    title: '关闭 Story 上下文与记忆新模式？',
    message: `${lead}普通存档恢复可用，之后新建的存档不再标记为测试方案。`,
  };
}

async function onStoryModeChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const next = input.checked;
  // 先把开关复位：确认前不改设置，取消时界面也不留下已切换的假象
  input.checked = s.storyContextV2Enabled === true;
  if (next === (s.storyContextV2Enabled === true)) return;
  const { title, message } = buildStoryModeConfirm(next);
  const ok = await confirmDialog({
    title,
    message,
    confirmLabel: next ? '开启' : '关闭',
    danger: true,
  });
  if (!ok || storyModeLocked.value) return;
  s.storyContextV2Enabled = next;
}

// ═══ 实验性变量协议（状态树） ═══

/** 开关 ↔ `stateProtocol`：开 = tree，关 = legacy（缺省） */
const stateTreeEnabled = computed({
  get: () => s.stateProtocol === 'tree',
  set: (enabled: boolean) => {
    s.stateProtocol = enabled ? 'tree' : 'legacy';
  },
});

// ═══ 完整运行日志（引擎日志器） ═══

type EngineLogLevelSetting = 'trace' | 'debug' | 'info';
const ENGINE_LOG_LEVEL_LABELS: Record<EngineLogLevelSetting, string> = {
  trace: '全部（trace）',
  debug: '详细（debug）',
  info: '概要（info）',
};
/** 设置页只开放三档；warn / error 太少，不值得单独成档 */
const engineLogLevelOptions = ENGINE_LOG_LEVELS.filter(
  (level): level is EngineLogLevelSetting => level in ENGINE_LOG_LEVEL_LABELS,
).map((value) => ({ value, label: ENGINE_LOG_LEVEL_LABELS[value] }));

const engineLogCount = ref<number | null>(null);
const engineLogExporting = ref(false);
const engineLogExportedLines = ref(0);
const engineLogClearing = ref(false);
const engineLogBusy = computed(() => engineLogExporting.value || engineLogClearing.value);
const engineLogCountText = computed(() =>
  engineLogCount.value === null ? '读取中…' : `${engineLogCount.value.toLocaleString()} 条`,
);
const engineLogExportLabel = computed(() =>
  engineLogExporting.value
    ? `导出中… 已导出 ${engineLogExportedLines.value.toLocaleString()} 条`
    : '导出日志',
);

async function refreshEngineLogCount() {
  try {
    engineLogCount.value = await countEngineLogs();
  } catch (err) {
    console.warn('[DeveloperSection] 读取运行日志条数失败:', err);
  }
}

onMounted(() => {
  void refreshEngineLogCount();
});

async function onExportEngineLogs() {
  if (engineLogBusy.value) return;
  engineLogExporting.value = true;
  engineLogExportedLines.value = 0;
  try {
    const result = await exportEngineLogs({
      level: s.engineLogLevel ?? 'trace',
      onProgress: (lines) => {
        engineLogExportedLines.value = lines;
      },
    });
    if (result.status === 'done') {
      ui.toast(
        `已导出 ${result.lines.toLocaleString()} 条运行日志（${result.fileName}）`,
        'success',
      );
    }
  } catch (err) {
    console.error('[DeveloperSection] 导出运行日志失败:', err);
    ui.toast(`导出运行日志失败：${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    engineLogExporting.value = false;
    await refreshEngineLogCount();
  }
}

async function onClearEngineLogs() {
  if (engineLogBusy.value) return;
  const ok = await confirmDialog({
    title: '清空全部运行日志？',
    message: '会删除本机保存的所有完整运行日志（全部存档），无法恢复。需要留档请先导出。',
    confirmLabel: '清空',
    danger: true,
  });
  if (!ok) return;
  engineLogClearing.value = true;
  try {
    await clearEngineLogs();
    ui.toast('运行日志已清空', 'success');
  } catch (err) {
    console.error('[DeveloperSection] 清空运行日志失败:', err);
    ui.toast(`清空运行日志失败：${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    engineLogClearing.value = false;
    await refreshEngineLogCount();
  }
}
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

    <AppCard
      padding="md"
      class="developer-mode-card"
      :class="{ 'is-enabled': s.storyContextV2Enabled }"
    >
      <div class="developer-toggle-row story-mode-header">
        <div class="developer-copy">
          <div class="developer-title-row">
            <h4>Story 上下文与记忆新模式</h4>
            <span class="developer-state" :class="{ 'is-enabled': s.storyContextV2Enabled }">
              <i
                :class="s.storyContextV2Enabled ? 'fa-solid fa-flask' : 'fa-solid fa-lock'"
                aria-hidden="true"
              ></i>
              {{ s.storyContextV2Enabled ? '已开启' : '已关闭' }}
            </span>
          </div>
          <p id="story-context-v2-help" class="card-desc">
            独立实验功能。开启后，新建存档会永久标记为「测试方案」，使用新的上下文与记忆流程。
          </p>
        </div>

        <label class="toggle-label developer-toggle">
          <input
            :checked="s.storyContextV2Enabled === true"
            type="checkbox"
            role="switch"
            class="toggle-input"
            aria-label="Story 上下文与记忆新模式"
            aria-describedby="story-context-v2-help"
            :disabled="storyModeLocked"
            @change="onStoryModeChange"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="story-mode-boundary" data-testid="story-mode-openable">
        {{ openableSavesLine }}
      </p>

      <div v-if="s.storyContextV2Enabled" class="story-settings">
        <label class="form-label story-field">
          <span>召回原文粒度</span>
          <select
            v-model="s.storyRecallRawMode"
            class="form-input"
            aria-describedby="story-recall-raw-help"
          >
            <option value="turn">整回合</option>
            <option value="snippet">相关片段加前后文</option>
          </select>
          <span id="story-recall-raw-help" class="form-hint">
            整回合保留完整输入与正文；片段只取相关段落及前后各一段。
          </span>
        </label>
        <label class="form-label story-field">
          <span>世界书检索历史消息数</span>
          <input
            :value="s.loreHistoryMessages"
            type="number"
            min="0"
            step="1"
            class="form-input"
            aria-label="世界书检索历史消息数"
            aria-describedby="lore-history-help"
            @input="updateLoreHistoryMessages"
            @change="updateLoreHistoryMessages"
          />
          <span id="lore-history-help" class="form-hint">
            默认 2 条玩家 / AI 消息，0 仅看当前输入。修改后下一轮生效。
          </span>
        </label>
        <label class="form-label story-field">
          <span>正文换窗批大小 K</span>
          <input
            :value="s.storyWindowBatchTurns"
            type="number"
            min="1"
            step="1"
            class="form-input"
            aria-label="正文换窗批大小 K"
            aria-describedby="story-window-batch-help"
            @input="updateStoryWindowBatchTurns"
            @change="updateStoryWindowBatchTurns"
          />
          <span id="story-window-batch-help" class="form-hint">
            1 = 每回合滑动（默认）。K &gt; 1 时原文窗口在 N 到 N+K−1 回合之间循环，攒满 K
            回合才整体换成摘要，期间前缀缓存可命中；最大的那一回合上下文最长。建议 K ≤ N。
          </span>
        </label>
      </div>

      <details class="story-details">
        <summary>模式说明与上下文规则</summary>
        <div class="story-details-copy">
          <p>
            正文窗口仍由正文 Agent
            的「历史层数」控制。世界书关键词激活与资料选择共用检索历史消息数；调大可参考更多历史，也会增加资料选择的输入。
          </p>
          <p>
            记忆总结使用内置提示词，每回合先判断事件是否结束并归档，再写短期摘要；归档进入长期记忆总览。召回沿用「设置
            → 记忆」的 LLM / Embedding 模式，读取摘要、事件档案与原文。
          </p>
          <p>
            固定资料进入第 1 区；区域背景按当前地理路径匹配，进入第 3 区；本轮资料由独立的
            lore_select Agent 筛选与有限补充后进入第 5
            区。关闭模式后普通存档沿用旧流程，内容包更新不会随开关回退。
          </p>
        </div>
      </details>
      <p v-if="storyModeLocked" class="story-mode-status" role="status">
        正在生成，本回合结束后才能切换模式。
      </p>
      <p v-if="exitedSaveName" class="story-mode-status" role="status">
        已退出存档「{{ exitedSaveName }}」：它不能在当前模式下继续，请从存档列表重新选择。
      </p>
    </AppCard>

    <AppCard
      padding="md"
      class="developer-mode-card"
      :class="{ 'is-enabled': stateTreeEnabled }"
      data-testid="state-protocol-card"
    >
      <div class="developer-toggle-row">
        <div class="developer-copy">
          <div class="developer-title-row">
            <h4>实验性变量协议（状态树）</h4>
            <span class="developer-state" :class="{ 'is-enabled': stateTreeEnabled }">
              <i
                :class="stateTreeEnabled ? 'fa-solid fa-flask' : 'fa-solid fa-lock'"
                aria-hidden="true"
              ></i>
              {{ stateTreeEnabled ? '已开启' : '已关闭' }}
            </span>
          </div>
          <p id="state-protocol-help" class="card-desc">
            只对直出存档生效：模型读写一棵中文状态树，每楼正文下记录本楼的状态更新。下一回合起生效；切换后缓存直出会冷建一次。
          </p>
        </div>

        <label class="toggle-label developer-toggle">
          <input
            v-model="stateTreeEnabled"
            type="checkbox"
            role="switch"
            class="toggle-input"
            aria-label="实验性变量协议（状态树）"
            aria-describedby="state-protocol-help"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </AppCard>

    <AppCard
      padding="md"
      class="developer-mode-card engine-log-card"
      :class="{ 'is-enabled': s.engineLogEnabled }"
    >
      <div class="developer-toggle-row story-mode-header">
        <div class="developer-copy">
          <div class="developer-title-row">
            <h4>完整运行日志</h4>
            <span class="developer-state" :class="{ 'is-enabled': s.engineLogEnabled }">
              <i
                :class="s.engineLogEnabled ? 'fa-solid fa-scroll' : 'fa-solid fa-lock'"
                aria-hidden="true"
              ></i>
              {{ s.engineLogEnabled ? '记录中' : '已关闭' }}
            </span>
          </div>
          <p id="engine-log-help" class="card-desc">
            记录每次模型调用实际发出的完整请求、完整响应与提示词组装过程，作为排查问题的最后手段。
          </p>
        </div>

        <label class="toggle-label developer-toggle">
          <input
            v-model="s.engineLogEnabled"
            type="checkbox"
            role="switch"
            class="toggle-input"
            aria-label="完整运行日志"
            aria-describedby="engine-log-help engine-log-warning"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <p id="engine-log-warning" class="engine-log-warning" role="note">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <span>
          开启后日志会非常大，导出文件可能达到几十到几百
          MB，并占用浏览器存储；只在需要排查问题时打开，用完请关闭并清空。每个存档保留最近 100
          回合。日志包含正文与提示词明文（装了加密内容包时也会把内容包提示词明文存到本机），API
          密钥已脱敏，分享前请检查。
        </span>
      </p>

      <div class="story-settings">
        <label class="form-label story-field">
          <span>记录粒度</span>
          <select
            v-model="s.engineLogLevel"
            class="form-input"
            aria-label="记录粒度"
            aria-describedby="engine-log-level-help"
          >
            <option
              v-for="option in engineLogLevelOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <span id="engine-log-level-help" class="form-hint">
            「全部」会额外记下提示词组装的每一步，体积约为「详细」的 2 到 3
            倍；「概要」只记关键事件。
          </span>
        </label>
        <div class="story-field engine-log-stats">
          <span class="engine-log-stats-label">当前日志</span>
          <p class="engine-log-count" data-testid="engine-log-count" aria-live="polite">
            {{ engineLogCountText }}
          </p>
          <div class="engine-log-actions">
            <AppButton
              size="sm"
              :loading="engineLogExporting"
              :disabled="engineLogClearing"
              data-testid="engine-log-export"
              @click="onExportEngineLogs"
            >
              <i v-if="!engineLogExporting" class="fa-solid fa-file-export" aria-hidden="true"></i>
              {{ engineLogExportLabel }}
            </AppButton>
            <AppButton
              size="sm"
              variant="ghost"
              :loading="engineLogClearing"
              :disabled="engineLogExporting"
              data-testid="engine-log-clear"
              @click="onClearEngineLogs"
            >
              <i v-if="!engineLogClearing" class="fa-solid fa-trash-can" aria-hidden="true"></i>
              清空日志
            </AppButton>
          </div>
        </div>
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

.story-mode-boundary,
.story-mode-status {
  margin: var(--theme-spacing-sm) 0 0;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  line-height: 1.6;
}

.story-mode-header {
  align-items: flex-start;
}

.story-settings {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--theme-spacing-xl);
  margin-top: var(--theme-spacing-lg);
  padding-top: var(--theme-spacing-lg);
  border-top: 1px solid var(--theme-card-border);
}

.story-field {
  min-width: 0;
  gap: var(--theme-spacing-sm);
}

.story-field .form-input {
  box-sizing: border-box;
  min-height: 2.5rem;
}

.story-field .form-hint {
  margin: 0;
  font-weight: 400;
  line-height: 1.6;
}

.story-details {
  margin-top: var(--theme-spacing-lg);
  padding-top: var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  line-height: 1.65;
}

.story-details summary {
  width: fit-content;
  cursor: pointer;
  color: var(--theme-text-secondary);
}

.story-details summary:hover {
  color: var(--theme-primary);
}

.story-details summary:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: var(--theme-spacing-xs);
  border-radius: var(--theme-radius-sm);
}

.story-details-copy {
  display: grid;
  gap: var(--theme-spacing-sm);
  margin-top: var(--theme-spacing-md);
}

.story-details-copy p {
  margin: 0;
}

.engine-log-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-sm);
  margin: var(--theme-spacing-md) 0 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 35%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-secondary);
  background: color-mix(in srgb, var(--theme-warning) 8%, var(--theme-card-bg));
  font-size: 0.75rem;
  line-height: 1.6;
}

.engine-log-warning i {
  margin-top: 0.2em;
  color: var(--theme-warning);
}

.engine-log-stats {
  display: flex;
  flex-direction: column;
}

.engine-log-stats-label {
  color: var(--theme-text-secondary);
  font-size: 0.85rem;
  font-weight: 500;
}

.engine-log-count {
  margin: 0;
  color: var(--theme-text-primary);
  font-size: 0.95rem;
  font-variant-numeric: tabular-nums;
}

.engine-log-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
}

.engine-log-actions .app-btn {
  min-height: 36px;
  gap: var(--theme-spacing-xs);
}

.developer-state {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  padding: calc(var(--theme-spacing-xs) / 2) var(--theme-spacing-sm);
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
  margin-bottom: calc(var(--theme-spacing-xs) / 2);
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

  .story-settings {
    grid-template-columns: 1fr;
    gap: var(--theme-spacing-lg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .developer-mode-card {
    transition: none;
  }
}
</style>
