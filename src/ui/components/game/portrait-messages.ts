/**
 * portrait-messages.ts — 玩家画像导入路径上「说给用户听的那一句」（Q-25）
 *
 * 为什么单独一层: 这三个函数收发都是普通值 —— 一个结局码、一个名字、一行素材，
 * 出一句话加一个 toast 档位。它们此前住在 `StatusOverview.vue` 里，于是断言
 * 一句文案要先挂起 game store、玩家、装备、buff 与整棵状态总览 DOM。
 * 判据全是纯的，测试就不该付那份钱。
 *
 * 🔴 **这里只决定"说什么"，不决定"做什么"**: 不碰 store、不弹 toast、不读 DOM。
 *    调用方拿到 `{ text, type }` 自己去 `ui.toast(...)`。这条边界是这层存在的
 *    全部意义 —— 一旦这里开始有副作用，它就又只能在 mount 里测了。
 *
 * 写入路径本身（往哪一格写、mp4 为什么不写头像）在 `composables/usePlayerPortrait.ts`，
 * 那是策略；本文件只把策略的**结果**翻译成人话。
 */
import type { AssetMetaRecord, AssetType } from '@engine/types';
import type { AssetMutationOutcome } from '../../stores/asset-store';

/** 一条待播报的提示 —— 文案 + 档位，调用方转给 `ui.toast` */
export interface PortraitToast {
  text: string;
  type: 'info' | 'warning' | 'error';
}

/**
 * 每种结局一句**属于它自己**的话。
 *
 * 两种「名字不合法」（D16 命名不变式 / D19 zip 条目名可承载性）**必须说清是名字的问题**:
 * 这条路径上文件名只贡献扩展名，name 由角色给定，所以用户改文件名一万次也没用 ——
 * 报成「导入失败」会让人对着一张好图反复重试。
 *
 * 🔴 **`'busy'` 刻意不在这张表里**: 互斥闸 `rejectIfBusy()` 自己已经播报过
 * 「已有一个导入正在进行，请等它结束。」，这里再说一句就是同一件事弹两条 toast。
 * 那句共用文案对本路径完全成立（要等的确实是同一个闸），所以删的是**本地这句**
 * 而不是共用那句。调用方在拿到 `'busy'` 时直接返回，绝不会走到这个 switch。
 */
export function portraitMessage(outcome: AssetMutationOutcome, name: string): PortraitToast {
  switch (outcome) {
    case 'ok':
      return { text: `已把这张图设为「${name}」的画像。`, type: 'info' };
    case 'naming-invariant':
      return {
        text: `没法用「${name}」这个角色名当素材文件名：名字里含有「头像 / 立绘 / 立绘bg」这类类型词（或名字为空），素材会被读成另一个角色。请先改角色名。`,
        type: 'error',
      };
    case 'unrepresentable-name':
      return {
        text: `没法用「${name}」这个角色名当素材文件名：名字里带「/」「\\」或以「.」开头，导出成素材包后会变成路径或被当成隐藏文件。请先改角色名。`,
        type: 'error',
      };
    case 'media-rule':
      return { text: '这个类型不接受 mp4，请换一张图片。', type: 'error' };
    default:
      // not-found / failed —— 字节没写进去（格式不认、读不出、存储写入失败）
      return {
        text: '这张图没能存进素材库：可能是格式不支持，或浏览器存储写入失败。',
        type: 'error',
      };
  }
}

export interface PortraitWriteReport {
  outcome: AssetMutationOutcome;
  /** 落库那一行的 id（`outcome !== 'ok'` 时为 undefined） */
  id: string | undefined;
  /** 角色名 */
  name: string;
  /** 写完之后**立牌链现在命中的那一行**（null = 链上什么都没命中） */
  shown: AssetMetaRecord | null;
  /** 这次写进了哪一格 —— 会出现在「被压住了」那句话里 */
  slot: AssetType;
}

/**
 * 落库的结论 → 说给用户听的那一句。**判据是这一格现在显示的是不是刚写的那一行**，
 * 不是 store 有没有返回 `'ok'`。
 *
 * 🔴 为什么必须多这一步: 写入定位到**一格**（`立绘bg`），而读取走的是**一条链**
 * （`立绘 → 立绘bg → 头像`）。角色已经有 `立绘` 时，链继续命中旧立绘，这一格
 * 一个像素都没变 —— 此时说「已设为画像」就是在骗人，而用户看着没反应只会再点一次。
 *
 * 遮挡**不是**可以靠写入解决的: 唯一的解法是删掉/换掉压在上面的那一行，而
 * **永不覆盖**（D11）不允许导入路径替用户做这个决定。所以这里给的是"谁压着、
 * 去哪改"，不是一句道歉。
 *
 * 调用方传进来的 `shown` 必须是**写完之后**读的那一行: `portraitRow` 是同步
 * computed（纯索引查找），而 store 在 `writeIntoSlot` 末尾已经 `refreshAssets()`
 * 过，所以 await 回来直接读它就是最新的答案。
 */
export function describePortraitWrite(report: PortraitWriteReport): PortraitToast {
  const { outcome, id, name, shown, slot } = report;
  if (outcome !== 'ok' || id === undefined) return portraitMessage(outcome, name);

  if (shown !== null && shown.id !== id) {
    return {
      text:
        `这段视频已经存进「${name}」的「${slot}」了，但画像位显示的仍是排在更前面的「${shown.type}」—— 这一格看上去没有任何变化。` +
        `想让视频显示出来，请到 设置 → 素材 里把「${name}」的那张「${shown.type}」删掉或换掉。`,
      type: 'warning',
    };
  }

  return { text: `已把这段视频设为「${name}」的画像。`, type: 'info' };
}

/**
 * 裁剪台两半各自的落地结果 → 一句汇总。
 *
 * 返回 `null` = **一句都不该说**（两半都没落地）。部分成功由编辑器就地说明，
 * 不在这里冒充成功 —— 所以这里照实数落了几张，只把数出来的那几张念出来。
 */
export function describeCropSaved(
  ids: { portraitId?: string; avatarId?: string },
  name: string,
): PortraitToast | null {
  const saved = [
    ...(ids.portraitId !== undefined ? ['立绘'] : []),
    ...(ids.avatarId !== undefined ? ['头像'] : []),
  ];
  if (saved.length === 0) return null;
  return { text: `已把这张图设为「${name}」的${saved.join('与')}。`, type: 'info' };
}
