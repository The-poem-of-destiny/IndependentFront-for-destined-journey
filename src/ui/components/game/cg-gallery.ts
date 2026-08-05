/**
 * cg-gallery.ts — CG 图鉴的纯逻辑层（收录判据 / 折叠 / 排序 / 兜底可见性）
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md` §10.3。
 *
 * **零新数据模型** —— 图鉴是 `SceneImageRecord` 的第二个视图，本文件只把同一批记录
 * 重新分组一次。任何「图鉴专属字段」的念头都该在这里被挡住: 想显示的东西都已经
 * 在记录里了（`turn` / `title` / `description` / `take` / `pinned` / `blobDropped`）。
 *
 * 之所以是一个独立的 `.ts` 而不是写在 `.vue` 里: 收录判据与折叠规则是**会静默出错**
 * 的那一类逻辑（漏掉一段筛选，界面上只是多几个格子），而挂载一个网格去断言它们
 * 既慢又绕。分出来之后这三条能被直接钉住。
 */
import type { SceneImageAnchorKind, SceneImageRecord } from '@engine/types-image';

/**
 * 一格 —— 同一个锚点 `(messageId, anchorKind, occurrence)` 的全部 take 折在一起（§10.3）。
 *
 * 为什么折叠: 重画产生的是**同一处的第 N 张**（D17），它们讲的是同一个瞬间。
 * 平铺开来，一个反复重画过的场景会在图鉴里占掉半屏，把剧情顺序冲散。
 */
export interface GalleryCell {
  /** 锚点键 —— 折叠的唯一依据，也是列表的 `:key` */
  key: string;
  messageId: string;
  anchorKind: SceneImageAnchorKind;
  occurrence: number;
  /** 剧情顺序（同锚点的全部 take 共享一个 turn） */
  turn: number;
  /** 按 `take` 升序的全部**已画出来的** take */
  takes: SceneImageRecord[];
  /** 格子上显示哪一张 —— 与 `scene-image-store.displayedAt` 同口径（D45） */
  displayed: SceneImageRecord;
  /** 这一格最早那张的 createdAt，用于同回合内的稳定排序 */
  earliestAt: number;
}

/**
 * 这条记录进不进图鉴。
 *
 * 🔴 **只有 `done`**（§10.3）。未生成的标记与失败的记录都**不进** —— 图鉴是
 * 「已经画出来的东西」，塞灰格子会让它从战利品陈列变成待办清单。补画入口在正文里，
 * 失败的自助入口也在正文那一段旁边（D42）。
 *
 * ⚠️ `blobDropped` 的记录**照收**（D47）: 它的 `status` 仍是 `done`，因为这张图
 * 画出来过 —— 那是历史事实，不因为腾空间而改写。它在格子里显示「字节已清理」+
 * 重画按钮，而不是一个破图。
 */
export function isGalleryVisible(record: SceneImageRecord): boolean {
  return record.status === 'done';
}

/** 锚点键 —— 三段缺一不可: 漏掉 `anchorKind`，`marker#0` 与 `message-end#0` 会被折成一格 */
export function anchorKeyOf(record: SceneImageRecord): string {
  return `${record.messageId}|${record.anchorKind}|${record.occurrence}`;
}

/**
 * 把记录折成图鉴的格子，**按 `turn` 升序**（剧情顺序，§10.3）。
 *
 * 同回合内按这一格最早那张的 `createdAt` 排，再按 key 兜底 —— 两条都为了让
 * 同一批记录每次渲染出同一个顺序（Dexie 的返回序不保证）。
 */
export function buildGalleryCells(records: readonly SceneImageRecord[]): GalleryCell[] {
  const byAnchor = new Map<string, SceneImageRecord[]>();
  for (const r of records) {
    if (!isGalleryVisible(r)) continue;
    const key = anchorKeyOf(r);
    const bucket = byAnchor.get(key);
    if (bucket) bucket.push(r);
    else byAnchor.set(key, [r]);
  }

  const cells: GalleryCell[] = [];
  for (const [key, bucket] of byAnchor) {
    const takes = [...bucket].sort((a, b) => a.take - b.take || a.createdAt - b.createdAt);
    // takes 一定非空: 只有 push 过至少一条才会有这个桶
    const first = takes[0];
    const displayed = takes.find((r) => r.pinned === true) ?? takes[takes.length - 1];
    let earliestAt = first.createdAt;
    for (const r of takes) if (r.createdAt < earliestAt) earliestAt = r.createdAt;
    cells.push({
      key,
      messageId: first.messageId,
      anchorKind: first.anchorKind,
      occurrence: first.occurrence,
      turn: first.turn,
      takes,
      displayed,
      earliestAt,
    });
  }

  return cells.sort(
    (a, b) => a.turn - b.turn || a.earliestAt - b.earliestAt || (a.key < b.key ? -1 : 1),
  );
}

/**
 * 图里**恰好一个**角色时给出他的名字，否则 null（§10.3 的「把这次的 seed 钉给他」）。
 *
 * 为什么必须是「恰好一个」: seed 钉的是整张图的构图种子，两个人的图钉给谁都不对。
 * 名字**原样**返回，不 trim / 不折叠大小写 —— 预设是按名字 `===` 查中的（铁律 1）。
 */
export function soleCharacterOf(record: SceneImageRecord): string | null {
  const named = record.characters.filter((n) => n !== '');
  return named.length === 1 ? named[0] : null;
}

/** 这一张能不能钉 seed —— 恰好一个角色 **且** 这次真有 seed（随机那次没有可钉的东西） */
export function canPinSeed(record: SceneImageRecord): boolean {
  return soleCharacterOf(record) !== null && typeof record.seed === 'number';
}

/** 懒加载兜底扫描的默认余量（上下各 1500px，§10.3） */
export const GALLERY_PRELOAD_MARGIN = 1500;

/**
 * 定时兜底用的可见性判据 —— 元素在**视口 ±margin** 之内就算「该装了」。
 *
 * 🔴 为什么要有第二道保险: `IntersectionObserver` 在低带宽 / 弱设备上可能不触发
 * （首帧还没排版好、回调被长任务推迟），表现为一屏空白框 —— 而且是那种
 * 「我这边好好的」的 bug。所以观察器之外还要有一次 `getBoundingClientRect()` 复查。
 *
 * 判据本身是纯的（矩形 + 视口高度进，布尔出），于是「余量算错」这件事能被直接钉住，
 * 不必去模拟一个观察器。
 */
export function isNearViewport(
  rect: { top: number; bottom: number },
  viewportHeight: number,
  margin: number = GALLERY_PRELOAD_MARGIN,
): boolean {
  return rect.bottom >= -margin && rect.top <= viewportHeight + margin;
}
