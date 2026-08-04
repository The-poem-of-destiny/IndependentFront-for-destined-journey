/**
 * image-segments.ts — 把一条消息正文切成「文本段 / 图片段」序列（图像生成 v1）
 *
 * 设计全文: `docs/planning/2026-08-04-image-generation-design.md` §5.1（契约）与 §10.1（时序）。
 *
 * **时序（§10.1 / D3）**: 分段发生在**美化之前**，且 always-on、不看美化开关 ——
 * 于是美化关掉或流式输出途中，`<scene_image>` 也不会漏成一行尖括号给玩家看见；
 * 各文本段再各自过 `compileBeautifierSegments`，美化规则也就不会跨过一张插画去匹配。
 *
 * **纯度（§5 全层约束）**: 无 I/O、无 Dexie、无 Vue、无浏览器全局、无 `Date.now()`、无随机。
 *
 * 🔴 本模块**不切** `anchorKind:'message-end'` 的图（§10.2b）—— 那种图在正文里没有对应
 *    字节，是由记录驱动、在正文渲染完之后追加的。两条路径不合并，否则分段器要去关心
 *    它看不到的东西。
 */

import { scanSceneImages } from './marker-protocol';
import type { NarrativeSegment } from './types-image';

/**
 * 相邻文本段合并 + 空文本段不产出。
 *
 * 照 `beautifier.ts` 的 `appendText` 写法（同一条不变式，别各写一份）：
 * 两个标记之间什么都没有时不该冒出一个空段，而剥掉一个无效标记之后左右两截文本
 * 必须重新粘成一段 —— 否则「剥掉」与「从来没写过」在下游看起来就不一样了。
 */
function appendText(segments: NarrativeSegment[], text: string): void {
  if (!text) return;
  const previous = segments[segments.length - 1];
  if (previous?.kind === 'text') previous.text += text;
  else segments.push({ kind: 'text', text });
}

/**
 * 正文 → `[{text}, {image, occurrence, marker}, {text}, …]`。
 *
 * 不变式（§5.1）:
 * - 🔴 **不自己写第二个解析器** —— 标记一律经 `scanSceneImages`（= `scanByTag(text,
 *   'scene_image')` 的薄壳）拿 `position` + `rawContent`，本函数只按这两个数切。
 *   一个标签两个解析器就是漂移的来路。
 * - `occurrence` 在**整条消息**上从 0 递增，且**只有真正产出的图片段才占号** ——
 *   它是 `SceneImageRecord.occurrence` 的另一半（D2 按 `(messageId, anchorKind,
 *   occurrence)` 反查），中间留洞会让记录挂不回正文。
 * - 相邻文本段合并；空文本段不产出。
 * - 🔴 `bodyText === ''` 的标记（自闭合 / 只有属性）**不产出任何段，正文照剥**，
 *   等价于它从没被写过（§3.4）。扫描器**会**把它扫出来（那是倒序剥离清掉那行尖括号
 *   的前提），过滤是本层的事 —— 别指望扫描器替你做。
 * - 输入无标记时返回 `[{kind:'text', text}]`（**不是空数组**，调用方不必特判）。
 * - 输入空串返回 `[]`。
 *
 * 空白照原样保留（只有**空串**才叫空文本段）：标记独占一行时前后的换行是正文的字节，
 * 该怎么排版是渲染层的事，分段器不替它做决定。
 */
export function splitSceneImageSegments(text: string): NarrativeSegment[] {
  if (!text) return [];

  const markers = scanSceneImages(text);
  const segments: NarrativeSegment[] = [];
  let cursor = 0;
  let occurrence = 0;

  for (const marker of markers) {
    // 兜底：扫描器产出的标记本就按 position 升序且互不重叠，真出现回退时宁可跳过
    // 这一个，也不能让 slice 拿到负长度切出重复正文。
    if (marker.position < cursor) continue;

    appendText(segments, text.slice(cursor, marker.position));
    if (marker.bodyText !== '') {
      segments.push({ kind: 'image', occurrence, marker });
      occurrence += 1;
    }
    cursor = marker.position + marker.rawContent.length;
  }

  appendText(segments, text.slice(cursor));
  return segments;
}
