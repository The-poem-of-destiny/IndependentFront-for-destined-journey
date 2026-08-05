/**
 * scene-image-view.ts — 「这一格该渲染成什么」的判定（设计 §10.2 状态真值表）
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md` §10.2 / §10.2b。
 *
 * 为什么是一个纯函数而不是组件里的一串 `v-if`: 这张真值表里有一格是**唯一一处
 * 错了会直接花钱**的地方 ——
 *
 * 🔴 **「无记录 + `auto`」出的是按钮，不是去生成**（D15 / D21）。
 *
 * 自动档只对**编排器刚产出的那条消息**开火一次，这件事是靠「`onSceneImage` 回调
 * 只在新消息时触发」白拿的。渲染层如果把 `auto` 解释成「没记录就补一张」，那么
 * 每一次把开关从手动拨到自动、每一次滚回历史消息，都会追溯烧钱。设计里点名这是
 * 「将来最可能被人顺手补全掉的一环」，所以判定被抽到这里，由
 * `scene-image-view.test.ts` 逐格钉住 —— 组件里没有第二处状态判定。
 *
 * **纯度**: 无 I/O、无 Vue、无浏览器全局、无 `Date.now()`（时刻从 `now` 进）。
 */
import { IMAGE_FAILURE_RETRYABLE } from '@engine/image-defaults';
import type { ImageGenMode, SceneImageRecord } from '@engine/types-image';

/** story 没写 `title` 时占位框上的标签（`title` 是 sanitizeCaption 后的，可能是空串） */
export const SCENE_IMAGE_UNTITLED = '插画';

/** 记录上没留下可读原因时的兜底 —— **绝不静默留白**（§10.2 最后一行） */
export const SCENE_IMAGE_FAILED_FALLBACK = '这一张没画出来';

/**
 * 渲染态。**七个 kind 对应真值表的六行 + 一格 D47**:
 *
 * - `hidden` —— 无记录 + `off`。标记隐形，整个子系统在 UI 上不存在
 * - `offer` —— 无记录 + `manual`/`auto`。🔴 `auto` 也在这里，见文件头
 * - `queued` / `generating` —— **两个**态（D35），取消语义不同（D36）
 * - `done` —— 有字节
 * - `dropped` —— `done` 但字节被清理过（D47）。**不能渲染成 `<img>`**，那是一张破图
 * - `failed` —— 一行可读原因 + 重试（`retryable`）+ 自己写提示词（D42）
 */
export type SceneImageView =
  | { kind: 'hidden' }
  | { kind: 'offer'; title: string; intent: string }
  | { kind: 'queued'; recordId: string; position: number; title: string; intent: string }
  | { kind: 'generating'; recordId: string; elapsedSec: number; title: string; intent: string }
  | {
      kind: 'done';
      recordId: string;
      title: string;
      description: string;
      /** 出场角色里没有外观预设的那些（D41）；空数组 = 不出提示行 */
      missingPresets: readonly string[];
      /** 多 take 时角落的 `2/3`（D17/D45）。单张时 takeCount === 1 */
      takeIndex: number;
      takeCount: number;
    }
  | { kind: 'dropped'; recordId: string; title: string; description: string }
  | {
      kind: 'failed';
      recordId: string;
      title: string;
      intent: string;
      message: string;
      retryable: boolean;
    };

export interface SceneImageViewInput {
  /** 三档开关。**只影响「无记录」那一行** —— 有记录的一律照记录渲染 */
  mode: ImageGenMode;
  /** `displayedAt(messageId, anchorKind, occurrence)` 的产物；没有则是「无记录」 */
  record?: SceneImageRecord | undefined;
  /**
   * 标记那一格的元数据（无记录时占位框上的 title/intent 出自这里）。
   * `message-end` 的图带没有标记，此时省略。
   */
  marker?: { title: string; bodyText: string } | undefined;
  /** 队列里的位次，**1 起**（= UI 上那个「第 N 位」）。不在队列里省略 */
  queuePosition?: number | undefined;
  /** 当前时刻（毫秒）—— 只用来算「已用 N 秒」 */
  now: number;
  /** 出场角色里查不到预设的那些（D41）；调用方在预设库**装载完毕后**才传 */
  missingPresets?: readonly string[] | undefined;
  /** 同一锚点下这是第几张 / 共几张（1 起）。省略按单张处理 */
  takeIndex?: number | undefined;
  takeCount?: number | undefined;
}

function titleOf(record: SceneImageRecord | undefined, marker?: { title: string }): string {
  const raw = record?.title ?? marker?.title ?? '';
  return raw.trim() === '' ? SCENE_IMAGE_UNTITLED : raw;
}

function intentOf(record: SceneImageRecord | undefined, marker?: { bodyText: string }): string {
  return record?.intent ?? marker?.bodyText ?? '';
}

/**
 * 已用秒数（D37）。
 *
 * 🔴 用 `startedAt` 而**不是** `createdAt` —— 后者是入队时刻，拿它算的话排在第三位
 * 的图一开始转圈就显示「已用 180 秒」。`startedAt` 缺席（老记录 / 状态刚翻过来还没
 * 落库）时报 0，宁可从头数也不要报一个吓人的数字。
 */
function elapsedSeconds(record: SceneImageRecord, now: number): number {
  const started = record.startedAt;
  if (started === undefined || !Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}

/**
 * 真值表逐格判定。**组件不许再写第二处** —— 它只负责把这里的产物画出来。
 */
export function resolveSceneImageView(input: SceneImageViewInput): SceneImageView {
  const { record } = input;

  // ── 无记录 ──
  if (!record) {
    // `off` = 这个子系统在 UI 上完全不存在（标记隐形，不是灰按钮）
    if (input.mode === 'off') return { kind: 'hidden' };
    // 🔴 `manual` **与 `auto`** 都到这里 —— 出按钮，不去生成。见文件头
    return {
      kind: 'offer',
      title: titleOf(undefined, input.marker),
      intent: intentOf(undefined, input.marker),
    };
  }

  const title = titleOf(record, input.marker);
  const intent = intentOf(record, input.marker);

  switch (record.status) {
    case 'queued':
      return {
        kind: 'queued',
        recordId: record.id,
        position: Math.max(1, Math.floor(input.queuePosition ?? 1)),
        title,
        intent,
      };

    case 'generating':
      return {
        kind: 'generating',
        recordId: record.id,
        elapsedSec: elapsedSeconds(record, input.now),
        title,
        intent,
      };

    case 'done': {
      const description = record.description;
      // D47: 字节清理过的仍是 `done`（画出来过是历史事实），但**渲染成一个说明位**，
      // 不是 `<img src=null>` 那张破图
      if (record.blobDropped === true) {
        return { kind: 'dropped', recordId: record.id, title, description };
      }
      const takeCount = Math.max(1, Math.floor(input.takeCount ?? 1));
      const takeIndex = Math.min(takeCount, Math.max(1, Math.floor(input.takeIndex ?? 1)));
      return {
        kind: 'done',
        recordId: record.id,
        title,
        description,
        missingPresets: input.missingPresets ?? [],
        takeIndex,
        takeCount,
      };
    }

    case 'failed':
    default: {
      const message =
        record.error !== undefined && record.error.trim() !== ''
          ? record.error
          : SCENE_IMAGE_FAILED_FALLBACK;
      return {
        kind: 'failed',
        recordId: record.id,
        title,
        intent,
        message,
        // 分类缺席（老记录）时按「可以再试」处理: 多点一次的代价是一次请求，
        // 而把能救的一格画成死路等于让玩家白丢一张图
        retryable:
          record.errorKind === undefined ? true : IMAGE_FAILURE_RETRYABLE[record.errorKind],
      };
    }
  }
}

/**
 * 缺预设提示行那句中文（D41）。
 *
 * 首次游玩必然命中这一格；没有它，玩家只会看到一个跟角色毫无关系的人，并且不知道
 * 为什么。多个角色时只报第一个 + 「等 N 人」，一行放得下才有人读。
 */
export function missingPresetHint(names: readonly string[]): string {
  if (names.length === 0) return '';
  const head = names[0] ?? '';
  const rest = names.length - 1;
  const who = rest > 0 ? `${head} 等 ${names.length} 人` : head;
  return `${who} 还没有外观预设，这张图里的形象是随机的`;
}
