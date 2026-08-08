/**
 * image-quota.ts — 三层限额的**唯一**判定处（设计 §5.3 / D20–D24）
 *
 * 装什么: `checkQuota` —— 一个纯函数，回答「这一张图现在该不该画」。
 * 不装什么: 时钟（`now` 从参数进）、存储（记录由调用方查好传进来）、
 *           拿到裁决之后做什么（自动降级成按钮 / 手动弹确认，都在调用方）。
 *
 * 🔴 **自动档与手动档共用这一个函数**（§5.3 不变式）。两处各写一份判定就是漂移的来路 ——
 *    一边改了阈值另一边没改，症状是「有时候拦有时候不拦」，而错的那一边在花钱。
 *    差别只在拿到 `ok:false` 之后做什么：自动降级成手动按钮（D21，**绝不丢弃标记**），
 *    手动弹一次确认（D24）。
 *
 * 🔴 **手动按钮永远可用**（§9.3）。任何限额都不能把它变灰 —— 所以 `source==='manual'`
 *    拿到的 `ok:false` 语义是**「要确认」而不是「不许」**，`message` 也照这个口吻写。
 *    机器该被拦死，人该只被减速。
 *
 * 🔴 调用方必须把 **queued / generating / failed 也传进来**（见 `QuotaInput.records`）。
 *    只传 `done` 的话，连点 10 次会在第一张落地之前全部放行 —— 限额形同虚设。
 *
 * 🔴 本函数**必须跑在 `image_prompt` 侧链之前**（D32）。否则被限流器拦下的插画
 *    已经白烧了一轮 LLM token：两处都花钱，闸门要在最前面。
 */

import { IMAGE_QUOTA_WINDOW_MS } from './image-defaults';
import type { QuotaReason, QuotaVerdict, SceneImageRecord } from './types-image';

/** `checkQuota` 的输入。全部由调用方备好 —— 本模块不查库、不读时钟。 */
export interface QuotaInput {
  /**
   * 本存档已有的全部记录（调用方按 `saveId` 过滤好）。
   *
   * 🔴 **含 queued / generating / failed** —— 在飞的和失败的都要计入，否则限额可以被连点绕过。
   * 本函数刻意**不接收 `status`**：它没有能力（也没有责任）替调用方决定哪些记录算数，
   * 传进来的每一条都算。
   */
  records: readonly Pick<SceneImageRecord, 'messageId' | 'turn' | 'source' | 'createdAt'>[];
  /** 本次要生成的目标 */
  target: { messageId: string; turn: number; source: 'auto' | 'manual' };
  /** 当前时刻，**从参数进**（纯函数不碰 `Date.now()`，否则快照重放与测试都不可复现） */
  now: number;
  /** 阈值。默认值在 `image-defaults.ts`（每消息 2 / 每小时 20），由调用方从设置里取 */
  limits: { maxPerMessage: number; maxPerHour: number };
  /**
   * 这一张由**谁付钱**（图像 v2 / C9）—— 取自**当前 provider** 的能力位
   * （`ImageProviderCapabilities.costModel`），不是设置里的某个开关。
   *
   * 🔴 `'local'` 时 L1/L2 **整条跳过**：那两层是**花钱**防线，而本地 ComfyUI 画一张
   *    只花自己的显卡时间。用户明确推翻了「本地也降档保留」的建议 —— 想画多少画多少。
   * 🔴 **`'local'` 不影响 L3**（见下）。这一格是必填而不是 `?: = 'paid'`：
   *    默认值会让新接的调用方白拿一个也许不对的答案，而两个方向都错得无声
   *    （paid 当 local = 不该花的钱花了；local 当 paid = 本地被莫名其妙拦住）。
   */
  costModel: 'paid' | 'local';
}

/**
 * 三层限额判定（§5.3 那张表 + 图像 v2 / C9 的分层）。三层**互相独立**，任一不满足即拒。
 *
 * | 层 | 判据 | 计谁 | 哪种后端 |
 * | --- | --- | --- | --- |
 * | L1 每条消息 | 同 `messageId` 的记录数 ≥ `maxPerMessage` | auto + manual 都计 | **仅 `paid`** |
 * | L2 滚动时间窗 | `now - createdAt < IMAGE_QUOTA_WINDOW_MS` 的记录数 ≥ `maxPerHour` | auto + manual 都计 | **仅 `paid`** |
 * | L3 同回合去重 | 目标是 `auto` 且同 `turn` 已有 `auto` 记录 | **只对 auto 生效** | **两种都开** |
 *
 * L3 只拦自动档：玩家想为同一段剧情多画几张，是他的钱、他的选择（§5.3 不变式）。
 * L1/L2 两种 source 都计：一个 UI bug 造成的连点也该被拦。
 *
 * 多层同时不满足时，按上表顺序报**第一条** —— 裁决必须是确定的，否则 tooltip 会随记录顺序变脸。
 */
export function checkQuota(input: QuotaInput): QuotaVerdict {
  const { records, target, now, limits, costModel } = input;

  // 🔴 L1/L2 是**花钱防线**，`local` 后端整条跳过（C9）。本地画一张只花自己的显卡时间，
  //    给它设上限是把一条为付费上游写的规则套在没有账单的地方。
  const spendGuarded = costModel === 'paid';

  // ── L1 每条消息 ──
  if (spendGuarded) {
    let perMessage = 0;
    for (const r of records) {
      if (r.messageId === target.messageId) perMessage += 1;
    }
    if (perMessage >= limits.maxPerMessage) {
      return deny(
        'per-message',
        perMessageMessage(target.source, perMessage, limits.maxPerMessage),
      );
    }
  }

  // ── L2 滚动时间窗 ──
  // 判据取自设计原文：`now - createdAt < IMAGE_QUOTA_WINDOW_MS`。
  // 时钟回拨造成的「未来」记录（差值为负）照样计入 —— 宁可多拦一张，不可漏掉一轮风暴。
  if (spendGuarded) {
    let inWindow = 0;
    for (const r of records) {
      if (now - r.createdAt < IMAGE_QUOTA_WINDOW_MS) inWindow += 1;
    }
    if (inWindow >= limits.maxPerHour) {
      return deny(
        'rolling-window',
        rollingWindowMessage(target.source, inWindow, limits.maxPerHour),
      );
    }
  }

  // ── L3 同回合去重（D23，只对 auto）──
  // 回退重发是既有功能且玩家用得很勤：不设这条，对同一段剧情重掷 5 次就产生 5 张图，
  // 其中 4 张挂在被丢弃的消息上。
  //
  // 🔴 **`costModel` 管不着这一层**（C9）：L3 是**正确性**规则不是花钱规则 ——
  //    一回合自动开火两次产出的是两张近乎相同的图 + 图鉴里两条重复条目，
  //    这件事与谁付钱无关，本地后端照样难看。所以它在 `spendGuarded` 之外。
  if (target.source === 'auto') {
    const sameTurnAuto = records.some((r) => r.turn === target.turn && r.source === 'auto');
    if (sameTurnAuto) {
      return deny('same-turn', '这一回合已经自动生成过插画了 · 想再画一张可以自己点按钮');
    }
  }

  return { ok: true };
}

function deny(reason: QuotaReason, message: string): QuotaVerdict {
  return { ok: false, reason, message };
}

/**
 * `message` 是**可读中文**，会直接出现在按钮 tooltip 上（§5.3 不变式）—— 不是错误码。
 *
 * 🔴 手动档那一支必须写成「还能继续、只是要确认」的口吻（D24 / §9.3）：
 *    同一句「已达上限」放在一个照样点得动的按钮上，只会让人以为按钮坏了。
 */
function perMessageMessage(source: 'auto' | 'manual', used: number, max: number): string {
  return source === 'manual'
    ? `这条消息已经有 ${used}/${max} 张插画，继续生成会额外消耗额度 —— 确认后仍可生成`
    : `这条消息已有 ${used}/${max} 张插画 · 不再自动生成 · 想要更多可以自己点按钮`;
}

function rollingWindowMessage(source: 'auto' | 'manual', used: number, max: number): string {
  return source === 'manual'
    ? `本小时已生成 ${used}/${max} 张插画，继续生成会额外消耗额度 —— 确认后仍可生成`
    : `已达本小时上限（${used}/${max}）· 暂不自动生成 · 想要这一张可以自己点按钮`;
}
