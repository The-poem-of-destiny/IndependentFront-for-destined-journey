import { Hono } from 'hono';
import { loadLatestManifest, loadLatestPack } from '../content-pack-release';

const app = new Hono();

/**
 * 内容包自动更新 v1 —— BFF 侧的两条只读路由。
 *
 * 前端不直接打 GitHub（Release 资产下载会 302 到 `release-assets.githubusercontent.com`，
 * 那一跳**不带 CORS 头**，浏览器 fetch 必被拦；实测 2026-09-26），所以拉取与解密
 * 全在服务端完成，前端只读本地 BFF 的同源明文。
 *
 * 🔴 本路由**不接受任何 URL / 仓库参数** —— 发布仓坐标与密钥全在 `content-pack-release.ts`
 *    里解析，从根上杜绝 SSRF。
 */

/** GET /latest —— 查最新版本清单。无发布版本返回 available:false（不是错误）。 */
app.get('/latest', async (c) => {
  try {
    const latest = await loadLatestManifest();
    if (!latest) return c.json({ ok: true, available: false });
    return c.json({
      ok: true,
      available: true,
      tag: latest.tag,
      ...latest.manifest,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[content-pack] 查询最新版本失败:', message);
    return c.json({ ok: false, error: message }, 502);
  }
});

/** GET /blob —— 拉取最新内容包并解密，直接回明文 pack JSON。 */
app.get('/blob', async (c) => {
  try {
    const result = await loadLatestPack();
    if (!result) return c.json({ error: '当前没有可用的内容包发布' }, 404);
    c.header('X-Pack-Version', result.manifest.packVersion);
    c.header('Cache-Control', 'no-store');
    return c.json(result.pack as Record<string, unknown>);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[content-pack] 拉取内容包失败:', message);
    return c.json({ error: message }, 502);
  }
});

export { app as contentPackRoutes };
