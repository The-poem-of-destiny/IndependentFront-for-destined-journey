import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { resolvePackServerUrl } from '../content-pack-release';

/** Local BFF only forwards opaque sessions/ciphertext; no Discord secret or pack key is held here. */
const app = new Hono();
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
app.use('*', bodyLimit({ maxSize: 4096 }));
app.get('/config', (c) => {
  try {
    return c.json({ ok: true, serverUrl: resolvePackServerUrl() });
  } catch {
    return c.json({ ok: false, error: '中心服地址配置无效' }, 503);
  }
});
const routes = [
  ['GET', '/latest', '/api/v1/pack/latest'],
  ['GET', '/blob', '/api/v1/pack/blob'],
  ['POST', '/renew', '/api/v1/pack/renew'],
  ['POST', '/verify', '/api/v1/auth/discord/verify'],
  ['POST', '/logout', '/api/v1/auth/discord/logout'],
] as const;
for (const [method, path, upstream] of routes) {
  app.on(method, path, async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer [\w.-]+$/i.test(authorization) || authorization.length > 16400)
      return c.json({ ok: false, code: 'AUTH_REQUIRED', error: '请先登录 Discord' }, 401);
    try {
      const base = resolvePackServerUrl();
      if (!base)
        return c.json(
          { ok: false, code: 'PACK_SERVER_NOT_CONFIGURED', error: '尚未配置 POEM_PACK_SERVER_URL' },
          503,
        );
      const response = await fetch(`${base}${upstream}`, {
        method,
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: await c.req.text() } : {}),
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      });
      const headers = new Headers({
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store',
      });
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) headers.set('Retry-After', retryAfter);
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return c.json(
        { ok: false, code: 'PACK_SERVER_UNAVAILABLE', error: '内容中心服暂时无法连接，请稍后重试' },
        502,
      );
    }
  });
}
export { app as contentPackRoutes };
