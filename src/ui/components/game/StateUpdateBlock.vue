<script setup lang="ts">
/**
 * 每楼变量更新块（状态树协议 T13，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §12）
 *
 * 挂在聊天流里每条已接纳、带 `stateUpdates` 的正文消息下方；原生 `<details>` 默认收起
 * （照 ActionPanel.vue 的先例）。展开后是纠正后的 op 列表：路径、动作、前值 → 后值、状态标记。
 *
 * - 最新一楼可改（逐条补差，§12.3）：改值 / 撤销 / 丢弃行改好后重新应用 / 新增一条。
 *   点后试算（`stateEdit.planStateUpdateRevision`）→ 预览 → 确认 → `stateEdit.commitStateUpdateRevision`
 *   （状态走变量修改器同一个写入口，成功后改写本楼记录）。冲突时让玩家选「仍然覆盖」或取消。
 * - 更早楼层只读，每行给「在变量修改器中打开此路径」。
 * - 「查看原文」只在调试记录里取得到本楼模型原文时出现（§9 #17：原文不落消息）。
 *
 * 🔴 判定全在 `state-update-view.ts`，本组件只画。
 * 🔴 全程文本插值，不用 v-html、不经美化管线（内容是模型产出的状态值）。
 * 🔴 正文不变；手改不告知模型（§9 #18）。
 */
import { computed, ref } from 'vue';
import type { ChatMessage, StateUpdateOpRecord } from '@engine/types/types';
import type {
  PlayerEditOp,
  RevisionPlan,
  UpdateBlockRevision,
} from '@engine/variables/state-tree-edit';
import { useGameStore } from '../../stores/game-store';
import { useStateEditStore } from '../../stores/state-edit-store';
import { useUIStore } from '../../stores/ui-store';
import AppButton from '../shared/AppButton.vue';
import {
  describeOps,
  describePreview,
  formatEditorValue,
  stateEditorLockReason,
  type PreviewView,
} from './state-editor-view';
import {
  APPEND_OPS,
  buildUpdateBlockView,
  editorJumpPath,
  findRawResponse,
  parseAppendInput,
  parseLooseValue,
  parseRevisionInput,
  revisionInputText,
  updateBlockBadges,
  updateBlockEditability,
  type UpdateRowView,
} from './state-update-view';

const props = defineProps<{ message: ChatMessage }>();

const game = useGameStore();
const stateEdit = useStateEditStore();
const ui = useUIStore();

const lockReason = computed(() =>
  stateEditorLockReason({
    isGenerating: game.isGenerating,
    isRewriting: game.isRewriting,
    isInCombat: game.isInCombat,
  }),
);
const access = computed(() =>
  updateBlockEditability(props.message, game.messages, lockReason.value),
);
const record = computed(() => props.message.stateUpdates ?? { ops: [], deltaMinutes: 0 });
const view = computed(() => buildUpdateBlockView(record.value, access.value.editable));
const badges = computed(() => updateBlockBadges(view.value));

// ═══ 查看原文 ═══
const rawResponse = computed(() =>
  findRawResponse(props.message, game.messages, game.agentLogHistory ?? []),
);
const rawOpen = ref(false);

// ═══ 修订流程：输入 → 试算 → 预览 / 冲突 → 确认 ═══
type Mode = 'edit' | 'revert' | 'reapply' | 'append';

interface Session {
  mode: Mode;
  /** 被修订行的下标；新增为 null。 */
  index: number | null;
  /** 值输入（改值 / 重新应用 / 新增）。 */
  text: string;
  /** 新增一条的动作与路径。 */
  appendOp: PlayerEditOp['op'];
  appendPath: string;
  inputError: string;
  revision: UpdateBlockRevision | null;
  plan: RevisionPlan | null;
  preview: PreviewView | null;
  force: boolean;
  busy: boolean;
  commitReasons: string[];
}

const session = ref<Session | null>(null);

function opsRecord(index: number): StateUpdateOpRecord | undefined {
  return record.value.ops[index];
}

function start(mode: Mode, index: number | null) {
  const row = index === null ? undefined : opsRecord(index);
  session.value = {
    mode,
    index,
    text: mode === 'edit' || mode === 'reapply' ? revisionInputText(row?.value) : '',
    appendOp: 'replace',
    appendPath: '',
    inputError: '',
    revision: null,
    plan: null,
    preview: null,
    force: false,
    busy: false,
    commitReasons: [],
  };
  // 撤销没有输入，直接试算
  if (mode === 'revert') void runPlan(false);
}

function cancel() {
  session.value = null;
}

/** 当前输入 → 修订；输入不成立时写 inputError 并返回 null。 */
function buildRevision(s: Session): UpdateBlockRevision | null {
  if (s.mode === 'revert') return { kind: 'revert' };
  if (s.mode === 'append') {
    const parsed = parseAppendInput(s.appendOp, s.appendPath, s.text);
    if (!parsed.ok) {
      s.inputError = parsed.reason;
      return null;
    }
    return { kind: 'append', op: parsed.op };
  }
  const row = s.index === null ? undefined : opsRecord(s.index);
  if (!row) return null;
  if (s.mode === 'reapply' && row.op === 'remove') return { kind: 'reapply' };
  const parsed =
    row.value !== undefined ? parseRevisionInput(row.value, s.text) : parseLooseValue(s.text);
  if (!parsed.ok) {
    s.inputError = parsed.reason;
    return null;
  }
  return s.mode === 'edit'
    ? { kind: 'edit', value: parsed.value }
    : { kind: 'reapply', value: parsed.value };
}

async function runPlan(force: boolean) {
  const s = session.value;
  if (!s || s.busy) return;
  s.inputError = '';
  s.commitReasons = [];
  const revision = force && s.revision ? s.revision : buildRevision(s);
  if (!revision) return;
  s.busy = true;
  try {
    const plan = await stateEdit.planStateUpdateRevision(props.message.id, s.index, revision, {
      force,
    });
    if (session.value !== s) return;
    s.revision = revision;
    s.plan = plan;
    s.force = force;
    s.preview = plan.kind === 'ok' ? describePreview(plan.preview) : null;
  } finally {
    s.busy = false;
  }
}

function backToInput() {
  const s = session.value;
  if (!s) return;
  if (s.mode === 'revert') {
    session.value = null;
    return;
  }
  s.plan = null;
  s.preview = null;
  s.commitReasons = [];
}

async function confirm() {
  const s = session.value;
  if (!s || s.busy || s.plan?.kind !== 'ok' || !s.revision) return;
  s.busy = true;
  try {
    const result = await stateEdit.commitStateUpdateRevision(
      props.message.id,
      s.index,
      s.revision,
      s.plan.ops,
      `更新块：${describeOps(s.plan.ops)}`,
    );
    if (session.value !== s) return;
    if (result.ok) {
      ui.toast('已修订本楼状态', 'success');
      session.value = null;
    } else {
      s.commitReasons = result.reasons;
    }
  } finally {
    if (session.value === s) s.busy = false;
  }
}

function isActive(row: UpdateRowView): boolean {
  const s = session.value;
  return !!s && s.mode !== 'append' && s.index === row.index;
}

const MODE_TITLE: Record<Mode, string> = {
  edit: '改值',
  revert: '撤销这一条',
  reapply: '改好后重新应用',
  append: '新增一条',
};

function valueHint(s: Session): string {
  if (s.mode === 'append')
    return s.appendOp === 'delta' ? '增减量（数字）' : '值（数字、是/否、文本或 JSON）';
  const row = s.index === null ? undefined : opsRecord(s.index);
  if (row?.op === 'delta') return '新的增减量（按差额补到当前状态）';
  return '目标值';
}

function needsValueInput(s: Session): boolean {
  if (s.mode === 'revert') return false;
  if (s.mode === 'append') return s.appendOp !== 'remove';
  const row = s.index === null ? undefined : opsRecord(s.index);
  return !(s.mode === 'reapply' && row?.op === 'remove');
}

function openInEditor(row: UpdateRowView) {
  stateEdit.openStateEditorAt(editorJumpPath(row));
}

function formatMinutes(min: number): string {
  if (min <= 0) return '';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d ? `${d} 天` : '', h ? `${h} 小时` : '', m ? `${m} 分钟` : ''].filter(Boolean).join(' ');
}
</script>

<template>
  <details class="su-block" data-testid="state-update-block">
    <summary class="su-bar">
      <span class="su-caret" aria-hidden="true">▶</span>
      <span class="su-title">本楼状态更新 {{ view.count }} 项</span>
      <span v-if="badges.length > 0" class="su-badges">
        <span
          v-for="b in badges"
          :key="b.tone"
          class="su-badge"
          :class="`tone-${b.tone}`"
          data-testid="state-update-badge"
          >{{ b.text }}</span
        >
      </span>
      <span v-if="formatMinutes(view.deltaMinutes)" class="su-time"
        >时间 +{{ formatMinutes(view.deltaMinutes) }}</span
      >
    </summary>

    <div class="su-body">
      <p v-if="access.latest && !access.editable" class="su-note" role="status">
        {{ access.lockReason }}
      </p>
      <p v-else-if="!access.latest" class="su-note">更早楼层只读；要改当前值请在变量修改器里改。</p>

      <ol class="su-rows">
        <li
          v-for="row in view.rows"
          :key="row.index"
          class="su-row"
          :class="[
            `tone-${row.tone}`,
            { 'is-folded': row.foldedIntoNo !== null, 'is-blocked': !!row.blockedReason },
          ]"
          data-testid="state-update-row"
        >
          <div class="su-row-top">
            <span class="su-no">{{ row.index + 1 }}</span>
            <span class="su-op">{{ row.opLabel }}</span>
            <code class="su-path">{{ row.from ? `${row.from} → ${row.path}` : row.path }}</code>
            <span v-if="row.badge" class="su-status" :class="`tone-${row.tone}`">{{
              row.badge
            }}</span>
          </div>
          <div v-if="row.change || row.valueText" class="su-values">
            <template v-if="row.change">
              <span class="su-before">{{ row.change.before }}</span>
              <span class="su-arrow" aria-hidden="true">→</span>
              <span class="su-after">{{ row.change.after }}</span>
            </template>
            <span v-if="row.valueText" class="su-written">写入 {{ row.valueText }}</span>
          </div>
          <div v-if="row.note" class="su-row-note">{{ row.note }}</div>
          <div v-if="row.foldedIntoNo !== null" class="su-row-note su-folded-note">
            已并入第 {{ row.foldedIntoNo }} 条
          </div>
          <div v-else-if="row.mergedFromNos.length > 0" class="su-row-note">
            吸收了第 {{ row.mergedFromNos.join('、') }} 条
          </div>
          <div v-if="row.blockedReason" class="su-row-note su-blocked-note">
            <i class="fa-solid fa-lock" aria-hidden="true" /> {{ row.blockedReason }}
          </div>

          <!-- 行内动作 -->
          <div
            v-if="!isActive(row) && (row.actions.edit || row.actions.revert || row.actions.reapply)"
            class="su-actions"
          >
            <button
              v-if="row.actions.edit"
              type="button"
              class="su-action"
              :disabled="!!session"
              @click="start('edit', row.index)"
            >
              改值
            </button>
            <button
              v-if="row.actions.revert"
              type="button"
              class="su-action"
              :disabled="!!session"
              @click="start('revert', row.index)"
            >
              撤销
            </button>
            <button
              v-if="row.actions.reapply"
              type="button"
              class="su-action"
              :disabled="!!session"
              @click="start('reapply', row.index)"
            >
              改好后重新应用
            </button>
          </div>
          <div v-else-if="!access.latest" class="su-actions">
            <button
              type="button"
              class="su-action"
              data-testid="state-update-open-editor"
              @click="openInEditor(row)"
            >
              在变量修改器中打开此路径
            </button>
          </div>

          <!-- 本行的修订面板 -->
          <div v-if="isActive(row) && session" class="su-editor" data-testid="state-update-editor">
            <template v-if="!session.plan">
              <label v-if="needsValueInput(session)" class="su-field">
                <span class="su-field-label"
                  >{{ MODE_TITLE[session.mode] }} · {{ valueHint(session) }}</span
                >
                <input
                  v-model="session.text"
                  class="su-input"
                  type="text"
                  data-testid="state-update-input"
                  @keydown.enter.prevent="runPlan(false)"
                />
              </label>
              <p v-if="session.inputError" class="su-error" role="alert">
                {{ session.inputError }}
              </p>
              <div class="su-editor-actions">
                <AppButton size="sm" variant="ghost" @click="cancel()">取消</AppButton>
                <AppButton
                  size="sm"
                  variant="primary"
                  :disabled="session.busy"
                  data-testid="state-update-plan"
                  @click="runPlan(false)"
                  >预览</AppButton
                >
              </div>
            </template>
            <template v-else>
              <!-- 冲突：现值已不等于记录的后值 -->
              <div
                v-if="session.plan.kind === 'conflict'"
                class="su-conflict"
                role="alert"
                data-testid="state-update-conflict"
              >
                <p>现值与本楼记录不符（之后又被改过）：</p>
                <p class="su-mono">
                  {{ session.plan.path }}：记录 {{ formatEditorValue(session.plan.expected) }}，现值
                  {{ formatEditorValue(session.plan.current) }}
                </p>
                <div class="su-editor-actions">
                  <AppButton size="sm" variant="ghost" @click="cancel()">取消</AppButton>
                  <AppButton
                    size="sm"
                    variant="danger"
                    :disabled="session.busy"
                    data-testid="state-update-force"
                    @click="runPlan(true)"
                    >仍然覆盖</AppButton
                  >
                </div>
              </div>
              <div v-else-if="session.plan.kind === 'blocked'" class="su-error" role="alert">
                {{ session.plan.reason }}
                <div class="su-editor-actions">
                  <AppButton size="sm" variant="ghost" @click="cancel()">关闭</AppButton>
                </div>
              </div>
              <div v-else-if="session.plan.kind === 'invalid'" class="su-error" role="alert">
                <ul>
                  <li v-for="r in session.plan.reasons" :key="r">{{ r }}</li>
                </ul>
                <div class="su-editor-actions">
                  <AppButton size="sm" variant="ghost" @click="backToInput()">返回</AppButton>
                </div>
              </div>
              <template v-else-if="session.preview">
                <div class="su-sec-title">将要发生的变更</div>
                <ul class="su-preview" data-testid="state-update-preview">
                  <li
                    v-for="(p, i) in session.preview.rows"
                    :key="p.path + i"
                    class="su-preview-row"
                  >
                    <span class="su-op">{{ p.op }}</span>
                    <code class="su-path">{{ p.from ? `${p.from} → ${p.path}` : p.path }}</code>
                    <span class="su-before">{{ p.before }}</span>
                    <span class="su-arrow" aria-hidden="true">→</span>
                    <span class="su-after">{{ p.after }}</span>
                    <span v-if="p.note" class="su-row-note">{{ p.note }}</span>
                  </li>
                </ul>
                <p v-if="session.force" class="su-note">将按目标值强制覆盖当前值。</p>
                <ul v-if="session.commitReasons.length > 0" class="su-error" role="alert">
                  <li v-for="r in session.commitReasons" :key="r">{{ r }}</li>
                </ul>
                <div class="su-editor-actions">
                  <AppButton size="sm" variant="ghost" @click="backToInput()">返回</AppButton>
                  <AppButton
                    size="sm"
                    variant="primary"
                    :disabled="session.busy || !access.editable"
                    data-testid="state-update-confirm"
                    @click="confirm()"
                    >确认修订</AppButton
                  >
                </div>
              </template>
            </template>
          </div>
        </li>
      </ol>

      <!-- 新增一条（只有最新一楼） -->
      <div v-if="access.editable" class="su-append">
        <button
          v-if="!session"
          type="button"
          class="su-action"
          data-testid="state-update-append"
          @click="start('append', null)"
        >
          <i class="fa-solid fa-plus" aria-hidden="true" /> 新增一条
        </button>
        <div
          v-else-if="session.mode === 'append'"
          class="su-editor"
          data-testid="state-update-editor"
        >
          <template v-if="!session.plan">
            <div class="su-append-grid">
              <label class="su-field">
                <span class="su-field-label">动作</span>
                <select v-model="session.appendOp" class="su-input">
                  <option v-for="o in APPEND_OPS" :key="o.op" :value="o.op">{{ o.label }}</option>
                </select>
              </label>
              <label class="su-field su-field-wide">
                <span class="su-field-label">路径</span>
                <input
                  v-model="session.appendPath"
                  class="su-input"
                  type="text"
                  placeholder="/主角/生命值/当前"
                  data-testid="state-update-append-path"
                />
              </label>
              <label v-if="needsValueInput(session)" class="su-field su-field-wide">
                <span class="su-field-label">{{ valueHint(session) }}</span>
                <input
                  v-model="session.text"
                  class="su-input"
                  type="text"
                  data-testid="state-update-input"
                  @keydown.enter.prevent="runPlan(false)"
                />
              </label>
            </div>
            <p v-if="session.inputError" class="su-error" role="alert">
              {{ session.inputError }}
            </p>
            <div class="su-editor-actions">
              <AppButton size="sm" variant="ghost" @click="cancel()">取消</AppButton>
              <AppButton
                size="sm"
                variant="primary"
                :disabled="session.busy"
                data-testid="state-update-plan"
                @click="runPlan(false)"
                >预览</AppButton
              >
            </div>
          </template>
          <template v-else>
            <div
              v-if="session.plan.kind === 'invalid' || session.plan.kind === 'blocked'"
              class="su-error"
              role="alert"
            >
              <ul>
                <li
                  v-for="r in session.plan.kind === 'invalid'
                    ? session.plan.reasons
                    : [session.plan.reason]"
                  :key="r"
                >
                  {{ r }}
                </li>
              </ul>
            </div>
            <template v-else-if="session.preview">
              <div class="su-sec-title">将要发生的变更</div>
              <ul class="su-preview" data-testid="state-update-preview">
                <li v-for="(p, i) in session.preview.rows" :key="p.path + i" class="su-preview-row">
                  <span class="su-op">{{ p.op }}</span>
                  <code class="su-path">{{ p.path }}</code>
                  <span class="su-before">{{ p.before }}</span>
                  <span class="su-arrow" aria-hidden="true">→</span>
                  <span class="su-after">{{ p.after }}</span>
                  <span v-if="p.note" class="su-row-note">{{ p.note }}</span>
                </li>
              </ul>
              <ul v-if="session.commitReasons.length > 0" class="su-error" role="alert">
                <li v-for="r in session.commitReasons" :key="r">{{ r }}</li>
              </ul>
            </template>
            <div class="su-editor-actions">
              <AppButton size="sm" variant="ghost" @click="backToInput()">返回</AppButton>
              <AppButton
                v-if="session.plan.kind === 'ok'"
                size="sm"
                variant="primary"
                :disabled="session.busy || !access.editable"
                data-testid="state-update-confirm"
                @click="confirm()"
                >确认新增</AppButton
              >
            </div>
          </template>
        </div>
      </div>

      <!-- 查看原文：只在调试记录里取得到时出现 -->
      <div v-if="rawResponse" class="su-raw">
        <button
          type="button"
          class="su-action"
          :aria-expanded="rawOpen"
          data-testid="state-update-raw-toggle"
          @click="rawOpen = !rawOpen"
        >
          {{ rawOpen ? '收起原文' : '查看原文' }}
        </button>
        <pre v-if="rawOpen" class="su-raw-text" data-testid="state-update-raw">{{
          rawResponse
        }}</pre>
      </div>
    </div>
  </details>
</template>

<style scoped>
.su-block {
  --su-mono: 'Cascadia Code', ui-monospace, 'SFMono-Regular', Consolas, monospace;
  margin: var(--theme-spacing-sm) 0 0;
  overflow: hidden;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-window-bg) 55%, var(--theme-card-bg));
  font-family: var(--theme-font-body);
  font-size: 0.8125rem;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  text-indent: 0;
}

.su-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-xs) 10px;
  min-height: 2.25rem;
  padding: 5px 10px;
  color: var(--theme-text-secondary);
  cursor: pointer;
  list-style: none;
  transition: background var(--motion-duration-fast) var(--motion-ease-standard);
}

.su-bar::-webkit-details-marker {
  display: none;
}

.su-bar:hover {
  background: var(--theme-tab-hover-bg);
}

.su-bar:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: -2px;
}

.su-block[open] > .su-bar {
  border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border) 60%, transparent);
}

.su-caret {
  display: inline-block;
  font-size: 0.625rem;
  opacity: 0.75;
  transition: transform var(--motion-duration-fast) var(--motion-ease-standard);
}

.su-block[open] .su-caret {
  transform: rotate(90deg);
}

.su-title {
  font-family: var(--su-mono);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
}

.su-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.su-badge,
.su-status {
  --chip-c: var(--theme-text-muted);
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--chip-c) 45%, transparent);
  border-radius: 2px;
  background: color-mix(in srgb, var(--chip-c) 10%, transparent);
  color: color-mix(in srgb, var(--chip-c) 55%, var(--theme-text-primary));
  font-size: 0.75rem;
  line-height: 1.6;
  white-space: nowrap;
}

.tone-corrected {
  --chip-c: var(--theme-warning);
}

.tone-dropped {
  --chip-c: var(--theme-error);
}

.tone-revised {
  --chip-c: var(--theme-hue-info);
}

.su-time {
  margin-left: auto;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

.su-body {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) 10px 10px;
}

.su-note {
  margin: 0;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  font-style: italic;
}

.su-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.su-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--theme-card-border) 70%, transparent);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
}

.su-row.tone-dropped {
  opacity: 0.6;
}

.su-row.tone-dropped:focus-within,
.su-row.tone-dropped:hover {
  opacity: 0.85;
}

.su-row.is-folded {
  margin-left: var(--theme-spacing-lg);
  background: transparent;
  border-style: dashed;
}

.su-row-top {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  min-width: 0;
}

.su-no {
  min-width: 1.5em;
  color: var(--theme-text-muted);
  font-family: var(--su-mono);
  font-size: 0.6875rem;
}

.su-op {
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

.su-path {
  min-width: 0;
  color: var(--theme-text-primary);
  font-family: var(--su-mono);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.su-status {
  margin-left: auto;
}

.su-values,
.su-preview-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
  padding-left: calc(1.5em + 8px);
  font-family: var(--su-mono);
  font-size: 0.75rem;
}

.su-before {
  color: var(--theme-text-muted);
  overflow-wrap: anywhere;
}

.su-after {
  color: var(--theme-text-primary);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.su-arrow {
  color: var(--theme-text-muted);
}

.su-written {
  color: var(--theme-text-secondary);
  overflow-wrap: anywhere;
}

.su-row-note {
  padding-left: calc(1.5em + 8px);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

.su-folded-note {
  font-style: italic;
}

.su-blocked-note {
  color: var(--theme-text-muted);
}

.su-actions,
.su-editor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-left: calc(1.5em + 8px);
}

.su-editor-actions {
  justify-content: flex-end;
  padding-left: 0;
}

.su-action {
  min-height: 28px;
  padding: 2px 10px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-secondary);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition:
    background var(--motion-duration-fast) var(--motion-ease-standard),
    color var(--motion-duration-fast) var(--motion-ease-standard);
}

.su-action:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}

.su-action:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
}

.su-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.su-editor {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin-top: 4px;
  padding: var(--theme-spacing-sm);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
}

.su-append-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--theme-spacing-sm);
}

.su-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.su-field-wide {
  grid-column: span 1;
}

.su-append-grid .su-field-wide:last-child {
  grid-column: 1 / -1;
}

.su-field-label {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

.su-input {
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font-family: var(--su-mono);
  font-size: 0.8125rem;
}

.su-input:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: -1px;
}

.su-sec-title {
  color: var(--theme-text-secondary);
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  letter-spacing: 0.03em;
}

.su-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.su-preview-row {
  padding-left: 0;
}

.su-conflict {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--theme-text-primary);
  font-size: 0.75rem;
}

.su-conflict p {
  margin: 0;
}

.su-mono {
  font-family: var(--su-mono);
  overflow-wrap: anywhere;
}

.su-error {
  margin: 0;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, transparent);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-error) 8%, transparent);
  color: var(--theme-error);
  font-size: 0.75rem;
  list-style: none;
}

.su-error ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.su-raw {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.su-raw-text {
  box-sizing: border-box;
  width: 100%;
  max-height: 24rem;
  margin: 0;
  padding: var(--theme-spacing-sm);
  overflow: auto;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  color: var(--theme-text-secondary);
  font-family: var(--su-mono);
  font-size: 0.75rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .su-caret,
  .su-bar,
  .su-action {
    transition: none;
  }
}
</style>
