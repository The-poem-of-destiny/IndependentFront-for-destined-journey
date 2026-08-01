/**
 * workshop-cover.ts — 项目封面的取图链（Phase 4 / 对齐上游）
 *
 * 移植自上游工坊页 `cloudflare/src/pages/home/utils.ts` 的
 * `appendCacheVersion` / `getWsrvUrl` / `getCoverImageSources`。
 *
 * 上游封面直接存 R2 原图，作者传什么就是什么 —— 3 MB 的 PNG 是常态。一页 20 张卡片
 * 直连原图，等于开一次浏览模态就下 60 MB。上游的解法是过一层 **wsrv.nl** 图片代理
 * 缩到 640px 宽并转 webp；我们照用同一层。
 *
 * ★ 与上游的两处不同:
 *
 * 1. **返回候选**数组而不是自己 `new Image()` 探测。上游那边整页是 innerHTML 重绘，
 *    背景图只能靠脚本探测；我们是 `<img>` + `@error`，让组件按序走候选天然更简单，
 *    也不会在组件卸载后还留着一个正在加载的 Image。
 * 2. **不出 SVG 占位图**。候选走完由组件交回它自己的兜底（我们的卡片是首字母块，
 *    跟着主题走）—— 上游那张深色 "No Preview" 贴在 parchment 主题上会是一块黑斑。
 *
 * 纯度约束: 无 Vue、无 store、无 I/O。
 */

/** wsrv.nl 的目标宽度 —— 卡片封面最宽也就 ~280 CSS px，2x 屏取 640 足够 */
const WSRV_WIDTH = 640;

/**
 * 给 URL 挂一个版本参数，让封面换了图之后能穿过浏览器缓存。
 *
 * 版本取项目的 `updatedAt`（上游用 `updatedAt || latestApprovedAt || coverImage`）。
 * 取不到就不挂 —— 挂一个恒定值等于没挂，挂随机值等于禁用缓存，两个都比不挂差。
 */
export function appendCacheVersion(url: string, version: string | undefined): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  const v = (version ?? '').trim();
  if (!v) return raw;

  try {
    // base 只在 url 是相对路径时起作用；上游封面恒为绝对 URL，给 base 纯属防御
    const parsed = new URL(raw, 'https://invalid.local');
    parsed.searchParams.set('v', v);
    // 相对路径进来会被拼上假 base —— 那种情况原样退回，绝不返回带 invalid.local 的串
    return parsed.origin === 'https://invalid.local' ? raw : parsed.toString();
  } catch {
    return raw;
  }
}

/** 原图 URL → wsrv.nl 代理 URL（缩宽 + 转 webp） */
export function wsrvUrl(url: string): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  return `https://wsrv.nl/?url=${encodeURIComponent(raw)}&w=${WSRV_WIDTH}&output=webp`;
}

/**
 * 封面候选链，**按优先级排列**，组件按序试，全挂了交回自己的兜底。
 *
 * 顺序是「省流量的在前，能出图的在后」:
 * 1. wsrv 代理（小、快，但多依赖一个第三方站点）
 * 2. 上游原图直连（大，但只要 R2 活着就一定出得来）
 *
 * 没有封面 → 返回空数组（调用方据此直接走兜底，不进 `<img>`）。
 */
export function coverCandidates(
  coverUrl: string | undefined,
  version?: string | undefined,
): string[] {
  const direct = appendCacheVersion(coverUrl ?? '', version);
  if (!direct) return [];

  const proxied = wsrvUrl(direct);
  // 代理 URL 拼失败（理论上不会）时不要往数组里塞空串 —— 空 src 会让浏览器
  // 去请求当前页面地址，然后画一个碎图标
  return proxied ? [proxied, direct] : [direct];
}
