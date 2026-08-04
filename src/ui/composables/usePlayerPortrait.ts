/**
 * usePlayerPortrait.ts — 玩家画像位：素材库渲染 + 定点导入（Q-25）
 *
 * 为什么单独一层: 这整段（读哪条链、点了去哪、mp4 落哪一格、裁剪台开关）与
 * 「状态总览显示什么」是两个不相干的变更理由，此前挤在 `StatusOverview.vue`
 * 的前 260 行里 —— 改一个受理 MIME 与改一行属性布局要动同一个文件，而那份
 * 897 行的同级测试全部只服务于这一段。
 *
 * 名字**严格 `===`**（D2）: `useAssetImage` 不做任何归一化，名字对不上就静默走
 * 首字母兜底 —— 那是 prompt / 世界书要在源头修的缺陷，素材层不宽容匹配。
 *
 * **读**走立牌链 `立绘 → 立绘bg → 头像`: 画像位是竖着的，有立绘就该铺开用。
 *
 * **写**分两条，判据是**这份字节能不能过画布**:
 *   · 图片 → 开裁剪台，一张源图烘出 `立绘` + `头像` 两行。这才是这个入口的意义:
 *     用户手里只有一张图，让他导两次、各裁一次，等于把"这两张图同源"的记账推给他。
 *   · mp4 → **不开**裁剪台。画布只取得到某一帧，"裁一段视频"没有意义；而且 D7
 *     本来就不让视频落在 `立绘` 上（那是要抠图合成的）。于是走原来的直通路径，
 *     写 `立绘bg` —— 存进去的必须是确定的一格，只有读取才降级。
 *
 * 🔴 mp4 为什么写 `立绘bg` 而不是 `头像`: 这个槽**读**的是立牌链
 * `立绘 → 立绘bg → 头像`，而 `头像` 在链的**最末**。往 `头像` 写，只要这个角色
 * 已经有一张 `立绘`（点「更换图片」的人多半正是这种情况），链照旧命中旧立绘 ——
 * 画面一动不动，却弹一句「已设为画像」。`立绘bg` 同样是 D7 认可的视频落点
 * （`allowsVideo('立绘bg') === true`：整幅铺满，什么都不合成，不需要 alpha），
 * 而且在链上**压过** `头像`，于是"没有立绘时视频立刻显示出来"成立。
 *
 * 但 `立绘` 仍会压过它，而**永不覆盖**（D11）是不可动摇的，所以这一格没法靠写入
 * 解决遮挡。剩下的唯一诚实做法: 写完回头看链现在命中的是不是这一行，不是就
 * 照实说「存下了，但这一格没变，是谁压着、去哪解决」（见 `describePortraitWrite`）。
 *
 * 文案一律出自 `components/game/portrait-messages.ts`（纯函数）—— 本文件只决定
 * **做什么**，不拼句子。
 */
import { computed, ref, toValue, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue';
import { ASSET_MIME_BY_EXTENSION, mimeForAssetExtension } from '@engine/asset-types';
import { ASSET_TYPE_FALLBACK_CHAIN } from '@engine/asset-resolve';
import type { AssetMetaRecord, AssetType } from '@engine/types';
import { useAssetImage } from './useAssetImage';
import { useAssetStore } from '../stores/asset-store';
import { useUIStore } from '../stores/ui-store';
import {
  describeCropSaved,
  describePortraitWrite,
  portraitMessage,
} from '../components/game/portrait-messages';

/**
 * mp4 落在哪一格。
 *
 * `立绘bg` 是 D7 认可的两个视频落点之一（`allowsVideo('立绘bg') === true` ——
 * 整幅铺满，什么都不合成，用不上 alpha），同时在**立牌链**上压过 `头像`。
 * 另一个合法落点 `头像` 在链的最末，写进去很可能一点都看不见（见本文件顶部长注释）。
 * 🔴 绝不可以是 `立绘`: 那是要抠像叠在背景上的立牌，mp4 没有合成 alpha。
 */
export const PORTRAIT_VIDEO_TYPE: AssetType = '立绘bg';

/** 认可的素材 MIME —— 路由表是唯一来源（含 `video/mp4`），不在这里手抄一份 */
const ASSET_MIMES = new Set(Object.values(ASSET_MIME_BY_EXTENSION));

/** 文件选择框的 accept */
export const PORTRAIT_ACCEPT = Array.from(ASSET_MIMES).join(',');

/**
 * 这份字节按素材路由表算是什么 MIME —— 与 asset-store 的 `resolveSourceMime`
 * **同一条优先级**: 先信 `blob.type`（从磁盘选出来的 `File` 在某些系统上是空串，
 * 但有值时它比扩展名可靠），问不出来再退到文件名扩展名。
 *
 * 两边都问不出 → `undefined`，**不猜**: 猜错了会让一份 svg / 乱改扩展名的文件
 * 一路走到裁剪台，然后在保存那一刻才含糊地失败。
 */
export function assetMimeOf(file: File): string | undefined {
  const declared = (file.type ?? '').trim().toLowerCase();
  if (ASSET_MIMES.has(declared)) return declared;
  const dot = file.name.lastIndexOf('.');
  return mimeForAssetExtension(dot > 0 ? file.name.slice(dot + 1) : '');
}

export interface UsePlayerPortrait {
  /** 立牌链命中的 object URL（没命中 → null，由调用方退回首字母占位） */
  url: Ref<string | null>;
  /** 命中的那一行是 mp4 吗 —— 由**行**判定，不嗅 URL */
  isVideo: Ref<boolean>;
  /** 立牌链最终命中的那一行（取景、id 都从这里取） */
  row: Ref<AssetMetaRecord | null>;
  /** 铺成大画像还是留 1:1 小方框 —— 判据是命中的**档位**，不是「有没有图」 */
  hasLargePortrait: ComputedRef<boolean>;
  /** 点画像时的说明（两条去处结果不同，说明也必须不同） */
  actionLabel: ComputedRef<string>;
  /** 文件选择框的 accept 串 */
  accept: string;
  /** 绑到隐藏 `<input type="file">` 上 */
  inputRef: Ref<HTMLInputElement | null>;
  /** 整块画像的点击入口 —— 有东西可调就开弹窗，否则直接开文件框 */
  activate: () => void;
  /** 直接开文件选择框（弹窗里的「更换图片」走的也是这条） */
  pick: () => void;
  /** 隐藏 input 的 change 处理 */
  onFile: (e: Event) => Promise<void>;
  dialogOpen: Ref<boolean>;
  closeDialog: () => void;
  cropOpen: Ref<boolean>;
  cropSource: Ref<File | null>;
  cropName: Ref<string>;
  closeCrop: () => void;
  onCropSaved: (ids: { portraitId?: string; avatarId?: string }) => void;
}

/**
 * @param name 角色名。取 getter 而非快照 —— 存档可以切、角色可以改名，
 *             画像位必须跟着走（唯一的例外是裁剪台，见 `cropName`）。
 */
export function usePlayerPortrait(name: MaybeRefOrGetter<string | undefined>): UsePlayerPortrait {
  const assets = useAssetStore();
  const ui = useUIStore();

  const { url, isVideo, row } = useAssetImage(() => toValue(name), ASSET_TYPE_FALLBACK_CHAIN);

  /**
   * 铺成大画像，还是留在 1:1 小方框里？
   *
   * 判据是**链上命中的那一档**，不是「有没有图」: `立绘` / `立绘bg` 本来就是竖幅
   * 或整幅构图，铺满整栏是它们该有的样子；而 `头像` 是一张脸的特写，拉满整栏宽
   * 只会糊成一团，看起来像 bug 而不像功能 —— 所以只有头像的角色必须留小框。
   */
  const hasLargePortrait = computed(
    () => url.value !== null && (row.value?.type === '立绘' || row.value?.type === '立绘bg'),
  );

  const inputRef = ref<HTMLInputElement | null>(null);

  function pick(): void {
    inputRef.value?.click();
  }

  // ── 点画像 = 一个入口，两种去处 ────────────────────────────
  //
  // 画像上**什么家具都不放**（没有旋钮、没有相机徽章）: 那两样都盖在图上，
  // 而旋钮弹出的浮层还会盖住画像自己 —— 一边调一边看不见调的结果。
  // 现在整块画像可点，点了去哪由**有没有东西可调**决定:
  //   · 已经是大画像（立绘 / 立绘bg）→ 开设置弹窗，那里有取景滑块和「更换图片」；
  //   · 没有素材，或只有一张头像 → **直接**开文件选择框。这时取景无从谈起
  //     （头像是圆形裁切的脸位，没有取景概念），弹一个只有「更换图片」可点的
  //     窗口纯属多一次点击。

  const dialogOpen = ref(false);

  function activate(): void {
    if (hasLargePortrait.value) dialogOpen.value = true;
    else pick();
  }

  function closeDialog(): void {
    dialogOpen.value = false;
  }

  const actionLabel = computed(() =>
    hasLargePortrait.value
      ? `调整「${toValue(name) ?? ''}」的画像取景，或更换图片`
      : `挑一张图，裁出「${toValue(name) ?? ''}」的立绘与头像`,
  );

  // ── 裁剪台的开关 ──────────────────────────────────────────
  // 名字在**开台那一刻**就定死（`cropName`），不是每帧去读角色名: 编辑器
  // 开着的时候存档可以切、角色可以改名，而用户裁的是他刚才点开的那个人。
  // 🔴 编辑器**永不**改名字，它只决定像素（见 AssetCropEditor 顶部注释）。

  const cropOpen = ref(false);
  const cropSource = ref<File | null>(null);
  const cropName = ref('');

  /**
   * 取消 = **什么都不留下**: 没有半张素材（落库全在编辑器的确认里）、没有卡住的
   * 忙碌位（本 composable 不持有忙碌位，互斥闸在 store 里且随那次调用结束而释放）、
   * 源字节也放掉（编辑器自己会撤销它铸的 object URL）。
   *
   * 文件选择框的 `value` 不在这里清 —— 它在 `onFile` 一进门就清了，
   * 那才是唯一正确的时机: 取消**编辑器**与取消**文件对话框**是两件事，只有前者
   * 会走到这里，而"连选同一个文件两次"这个坑两条路都要躲过。
   */
  function closeCrop(): void {
    cropOpen.value = false;
    cropSource.value = null;
  }

  /** 两半都落地了才会来（部分成功由编辑器就地说明，不冒充成功） */
  function onCropSaved(ids: { portraitId?: string; avatarId?: string }): void {
    const saved = describeCropSaved(ids, cropName.value);
    closeCrop();
    if (saved) ui.toast(saved.text, saved.type);
  }

  async function onFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    // 🔴 先清空，否则连续选**同一个文件**不会再触发 change（浏览器认为值没变）。
    // 必须在**所有** early return 之前 —— 走到裁剪台那条分支同样要清，否则
    // "开了裁剪台 → 取消 → 想重选刚才那张图" 会一声不响地什么都不发生。
    input.value = '';
    if (!file) return;
    const who = toValue(name);
    if (!who) return;

    const mime = assetMimeOf(file);
    if (mime === undefined) {
      // 连 MIME 都问不出来: 不开裁剪台，也不把一个必然失败的请求发给 store
      const { text, type } = portraitMessage('failed', who);
      ui.toast(text, type);
      return;
    }

    if (!mime.startsWith('video/')) {
      // 图片 → 交给裁剪台，由它调 `importPortraitPair` 一次烘出 立绘 + 头像
      cropSource.value = file;
      cropName.value = who;
      cropOpen.value = true;
      return;
    }

    // mp4 → 裁不了（画布只有某一帧），直通导入，写 立绘bg（见本文件顶部"为什么不是头像"）。
    // 文件名在这条路径上**只**贡献扩展名 —— name 与 type 由这个槽位说了算，
    // 于是 `IMG_1234.mp4` 不会在库里长出一个叫 IMG_1234 的幽灵角色组
    const { outcome, id } = await assets.importForCharacter(file, who, PORTRAIT_VIDEO_TYPE);
    // 互斥闸已经自己播报过了 —— 这里再补一句就是两条 toast 说同一件事
    if (outcome === 'busy') return;
    const { text, type } = describePortraitWrite({
      outcome,
      id,
      name: who,
      shown: row.value,
      slot: PORTRAIT_VIDEO_TYPE,
    });
    ui.toast(text, type);
  }

  return {
    url,
    isVideo,
    row,
    hasLargePortrait,
    actionLabel,
    accept: PORTRAIT_ACCEPT,
    inputRef,
    activate,
    pick,
    onFile,
    dialogOpen,
    closeDialog,
    cropOpen,
    cropSource,
    cropName,
    closeCrop,
    onCropSaved,
  };
}
