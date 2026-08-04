/**
 * scene-image-actions.ts — 正文插画 `done` 态里两件**纯**判定（设计 §10.2 那一行的后半截）
 *
 * 这一格的交互（打码 / 切 take / 放大 / 悬停菜单）绝大多数是 CSS 与事件绑定，
 * 只有两件事值得抽成纯函数 —— 它们各自有一个**错了不会立刻被看见**的陷阱:
 *
 * 1. {@link copyablePromptOf} —— 「复制提示词」复制的必须是**这一张实际发出去的**那份。
 *    记录里同时躺着三个候选（`positive` / `editedScenePrompt` / `scenePrompt`），
 *    取错了不会报错，只会让人拿着一份"看起来对"的提示词去复现，得到另一张图。
 * 2. {@link nextTakeId} —— 角标 `2/3` 的点击是**浏览**，不是钉住。两者在 store 里是
 *    两个完全不同的动作（`pin()` 落库、正文从此定死），混起来会让"看一眼上一张"
 *    变成一次不可见的破坏性写入。所以这里只出 id，一个字节都不落库。
 *
 * 🔴 本模块**不做**七态判定 —— 那是 `scene-image-view.ts` 的唯一职责。这里的输入
 * 已经是 `done` 那一格之内的东西。
 */
import type { SceneImageRecord } from '@engine/types-image';

/** {@link copyablePromptOf} 需要的最小切面 —— 三个候选字段 */
export type PromptBearingRecord = Pick<
  SceneImageRecord,
  'positive' | 'scenePrompt' | 'editedScenePrompt'
>;

/**
 * 「复制提示词」复制哪一份。
 *
 * 🔴 优先 `positive` —— 它是**发请求的那一方回填**的、真正送到上游的整串正向提示词
 * （见 scene-image-store 的 `SceneImageSendResult` 注释，以及 Q-21 的教训:
 * 预测值不能当记账依据）。`scenePrompt` 只是场景那一段，角色词条与质量词条都还没
 * 拼进去，拿它去复现只会得到另一张图。
 *
 * 回退链存在的理由：`positive` 在**记录刚落库还没发出去**、以及老记录上是空串。
 * 那时候退到「用户改过的那份 → agent 给的那份」，宁可给一份不完整的，也好过复制出
 * 一个空字符串然后让人以为剪贴板坏了。
 */
export function copyablePromptOf(record: PromptBearingRecord): string {
  const sent = record.positive;
  if (typeof sent === 'string' && sent.trim() !== '') return sent;
  const edited = record.editedScenePrompt;
  if (typeof edited === 'string' && edited.trim() !== '') return edited;
  const scene = record.scenePrompt;
  if (typeof scene === 'string' && scene.trim() !== '') return scene;
  return '';
}

/**
 * 角标点一下之后该看哪一张（环形前进）。
 *
 * **纯浏览**: 只回一个 id，调用方把它放进一个组件内的 ref。它与 `store.pin()`
 * 是两回事 —— 后者写库并决定**以后每次**读到这条消息看到哪张（D45）。
 *
 * @param ids 这一锚点下**真的画出来了**的 take，按 take 升序（失败/排队的不在其中）
 * @param currentId 当前正在看的那一张；不在 `ids` 里（比如刚被删掉）时从头开始
 * @returns 下一张的 id；没有可看的返回 null
 */
export function nextTakeId(ids: readonly string[], currentId: string | null): string | null {
  if (ids.length === 0) return null;
  const i = currentId === null ? -1 : ids.indexOf(currentId);
  // 找不到（-1）时 (i + 1) % n === 0 → 回到第一张，正是想要的
  return ids[(i + 1) % ids.length] ?? null;
}
