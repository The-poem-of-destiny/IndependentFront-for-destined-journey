export function resolvePackServerUrl(): string | null {
  const raw = process.env.POEM_PACK_SERVER_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('POEM_PACK_SERVER_URL 必须为 HTTPS origin（仅本机回环允许 HTTP）');
  }
  return url.origin;
}
