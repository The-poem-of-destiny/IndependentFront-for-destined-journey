/**
 * asset-resolve.ts — 素材查找 + 类型回退链 (Asset System v1)
 *
 * 为什么存在: 渲染面要问的是"给我苏婉的立牌"，而不是"苏婉有没有立绘、没有的话
 * 有没有立绘bg、都没有的话有没有头像"。这条**回退链 `立绘 → 立绘bg → 头像`**
 * （§7 / §11）是整个移植里最值钱的一行: 只有头像的角色照样能填进立牌槽位，
 * 半成品美术包**优雅降级**而不是留一个洞。今天打包的素材活到 VN 舞台落地那天。
 *
 * 🔴 **名字严格 `===`，不做任何归一化** —— 不 trim、不折叠大小写、不 NFKC。
 * 这是设计决策 D2，刻意的: 对齐 state-manager.ts:1391 的裸 `===`，并**刻意背离**
 * audio-names.ts 的 `normalizeAudioName`。理由（§3）: 若 AI 吐出 `苏婉 `（尾随
 * 空格），那是 prompt/世界书的缺陷，要在源头修；素材层宽容匹配 = 素材层认的角色
 * 与状态层认的角色可以是两个人。**不要在这里 import 或模仿 normalizeAudioName。**
 *
 * `indexes: AssetIndex[]` 收数组而非单个: v1 恒只传一个（store 那一个），
 * 但这就是为什么"内置库 / 文件夹库 / 导入库 三级优先级"是日后的**零改动**
 * 增补 —— 数组序即优先级序，加一个来源就是往数组前面塞一项。
 *
 * **两条链，按槽位形状选**（头像渲染面落地后新增；此前只有一条，且只有
 * 省略 type 时才走得到，于是"立牌位退头像"这条优雅降级实际上从没生效过）:
 *
 * | 链 | 顺序 | 谁用 |
 * |---|---|---|
 * | {@link ASSET_TYPE_FALLBACK_CHAIN} | 立绘 → 立绘bg → 头像 | **立牌位**: 竖幅/整幅（ScenePanel 的 4:5 在场角色位、日后的 VN 舞台） |
 * | {@link ASSET_TYPE_AVATAR_CHAIN}   | 头像 → 立绘 → 立绘bg | **脸位**: 圆形与 1:1 方框（StatusOverview / CharacterListPanel / 捏人页确认步） |
 *
 * 优先级必须**相反**而不是共用一条: 一张全身立牌裁进 2.5rem 圆里显示的是躯干
 * 不是脸。两条链都以"能接受的最后一档"收尾，所以两种槽位都不会因为半成品
 * 美术包留一个洞 —— 这正是回退链最值钱的地方。
 *
 * 单个类型（非数组）仍是**精确匹配、绝不降级**: 导入、设为主图这类"这一格就是
 * 这个类型"的调用方靠的就是它。只有**读取**才降级。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局。
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §3 / §7 / §11
 */

import type { AssetIndex, AssetTypeSlot } from './asset-index';
import { categoryForType } from './asset-types';
import type { AssetType } from './types';

/**
 * **立牌链** —— 竖幅/整幅槽位用，也是省略 `type` 时的缺省（§7 / §11）。
 *
 * 顺序即"最想要 → 能接受": 立牌优先，其次整幅背景图，最后头像。
 * 刻意不是 `ASSET_TYPES` 的顺序（那是 UI 展示序，`头像` 在最前），
 * 两者含义不同，不能共用一个数组。
 */
export const ASSET_TYPE_FALLBACK_CHAIN: readonly AssetType[] = ['立绘', '立绘bg', '头像'];

/**
 * **脸位链** —— 圆形头像与 1:1 方框用。
 *
 * 是立牌链的**反序**，不是同一条链换个名字: 这类槽位要的是一张脸，
 * 而全身立牌裁进小圆里露出的是躯干。头像拿不到才退而求其次用立牌 ——
 * 构图不对总好过留一个首字母的洞。
 */
export const ASSET_TYPE_AVATAR_CHAIN: readonly AssetType[] = ['头像', '立绘', '立绘bg'];

/** 从一个位里取: 请求的变体在就给它，否则给 base；两者都没有则 undefined */
function pickFromSlot(slot: AssetTypeSlot, variant?: string): string | undefined {
  if (variant !== undefined && variant !== '') {
    const hit = slot.variants[variant];
    if (hit !== undefined) return hit;
  }
  return slot.base;
}

/**
 * 查一个素材，返回 **asset id**（字节按 id 从 assetBlobs 取），查不到 `null`。
 *
 * 顺序: **索引数组序为外层**（前面的来源优先），每个索引内按类型链
 * `大类 → 名字 → 类型` 精确命中。所以第一个索引里只有 `头像` 也胜过第二个
 * 索引里的 `立绘` —— 这才是"优先级链"的意思。
 *
 * 变体缺席不是失败: 请求 `微笑` 而该类型只有无变体图时给 base。若该类型连
 * base 都没有（只有别的变体），就继续走类型链下一档 —— 空手比错图好，
 * 但"随便挑一个变体"比空手更糟（挑哪个都无从解释）。
 *
 * @param indexes 按优先级排列的索引；v1 恒传一个
 * @param name 角色名，**原样比较**（D2）
 * @param type 三种写法: **单个类型** = 精确匹配、绝不降级（导入/设为主图这类
 *   "就是这一格"的调用方）· **类型数组** = 按序走链（{@link ASSET_TYPE_AVATAR_CHAIN}
 *   或 {@link ASSET_TYPE_FALLBACK_CHAIN}，也可以自己拼）· **缺省** = 立牌链
 * @param variant 情绪/表情；`''` 等同未指定
 */
export function resolveAsset(
  indexes: readonly AssetIndex[],
  name: string,
  type?: AssetType | readonly AssetType[],
  variant?: string,
): string | null {
  // `typeof === 'string'` 而不是 `Array.isArray`: AssetType 是字符串字面量联合，
  // typeof 对它窄化得干净，而 `Array.isArray` 对 `readonly T[]` 的窄化历来别扭
  const chain: readonly AssetType[] =
    type === undefined ? ASSET_TYPE_FALLBACK_CHAIN : typeof type === 'string' ? [type] : type;

  for (const index of indexes) {
    for (const candidate of chain) {
      const byName = index[categoryForType(candidate)];
      // 名字键严格相等（D2）—— Record 的键查询本身就是 ===，这里不加任何加工
      const slots = byName?.[name];
      const slot = slots?.[candidate];
      if (slot === undefined) continue;
      const hit = pickFromSlot(slot, variant);
      if (hit !== undefined) return hit;
    }
  }

  return null;
}
