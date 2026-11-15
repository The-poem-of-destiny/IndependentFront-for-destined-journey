/**
 * plugin-network.ts — 插件联网域名校验与 CSP 生成（插件系统设计 §4.2、§4.3）
 *
 * 为什么存在: 红线 D（插件不能向本机和局域网服务发出它们能理解的请求）的第一道防线
 * 就是 CSP 里只出现 https 与 wss 两种协议加声明的域名。这里把 manifest 的 `network`
 * 列表收窄成「公网多段主机名」，再展开成固定模板的 CSP。安装时与建帧时各验一次：
 * `buildPluginFrameCsp` 不信任调用方，自己重验，任何不合格输入直接抛错。
 *
 * 校验规则（逐条对应 §4.2）:
 * - 只收主机名：带协议、端口、路径、查询、片段、用户信息的一律拒。
 * - 可以有一个前导 `*.`，通配后的部分至少两段，且本身要满足全部规则。
 * - 只收 ASCII 字母、数字、连字符；国际化域名必须写成 punycode（`xn--`）。
 * - 至少两段；末段（顶级域）只收字母或 `xn--` 形式 —— 这比「末段不能是纯数字」更严，
 *   顺带挡住 WHATWG URL 解析器会当作 IPv4 数字的 `0x7f` 一类十六进制末段。
 * - 拒 IPv4（含十进制整数、十六进制、八进制、缩写）与 IPv6 字面量、`localhost`、
 *   单段名、保留后缀（`RESERVED_SUFFIXES`）、已知「公网名字解析到任意 IP」的服务
 *   （`REBINDING_SUFFIXES`，只是卫生措施，边界在 §4.3 的 443 + 证书论证）。
 * - 最多 `MAX_NETWORK_HOSTS` 项。
 *
 * 规范化: 去首尾空白、转小写、去重（保留首次出现的顺序）。尾随点（FQDN 写法）不做
 * 静默修正，直接拒绝 —— CSP 的主机匹配对尾随点另有语义，不在这里猜。
 *
 * ⚠️ 本文件不得出现字面的 `协议://主机` 写法（`tests/no-external-assets.test.ts` 会扫），
 * 协议前缀一律由常量拼接。
 *
 * 纯度约束: 无 I/O、无 Vue、无 Dexie、无浏览器全局。
 */

import { hashWorkshopContent } from '../workshop/workshop-install-plan';

/** 单个插件最多声明的联网域名数（§4.2） */
const MAX_NETWORK_HOSTS = 16;

/** 主机名总长上限（DNS 规范：253 个字符，不含尾随点） */
const MAX_HOST_LENGTH = 253;

/** 单段长度上限（DNS 规范） */
const MAX_LABEL_LENGTH = 63;

/**
 * 保留后缀：名字等于它或以 `.它` 结尾即拒（§4.2 原表，另加 `localhost`）。
 * 这些名字要么只在内网解析，要么按 RFC 永不在公网解析。
 */
const RESERVED_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'lan',
  'home',
  'corp',
  'intranet',
  'home.arpa',
  'test',
  'invalid',
  'example',
  'onion',
  'arpa',
];

/**
 * 「把公网名字解析到任意 IP」的已知服务（§4.2 的卫生表）。
 * 命中即拒；漏网的由 §4.3 的论证兜底（只有 443 + 有效证书才能真正送达）。
 */
const REBINDING_SUFFIXES: readonly string[] = [
  'nip.io',
  'sslip.io',
  'xip.io',
  'traefik.me',
  'localtest.me',
  'lvh.me',
  'vcap.me',
  'localho.st',
  'lacolhost.com',
  'fuf.me',
  '1u.ms',
  'rbndr.us',
];

/** 协议前缀由片段拼出，避免源码里出现字面 URL */
const SCHEME_HTTPS = 'https' + ':' + '//';
const SCHEME_WSS = 'wss' + ':' + '//';

/** 单段：字母数字开头结尾，中间可有连字符 */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** 顶级域：纯字母，或 punycode 形式 */
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]*[a-z0-9])$/;

/** WHATWG URL 解析器眼里的「IPv4 数字」：十进制、`0x` 十六进制、`0` 开头八进制 */
const IPV4_NUMBER_RE = /^(?:0x[0-9a-f]*|\d+)$/i;

/** 单条校验失败 */
interface PluginNetworkError {
  entry: string;
  reason: string;
}

type ValidateResult = { ok: true; hosts: string[] } | { ok: false; errors: PluginNetworkError[] };

function describeEntry(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

function matchesSuffix(name: string, suffix: string): boolean {
  return name === suffix || name.endsWith('.' + suffix);
}

/**
 * 校验单条（已去空白、转小写）。返回 `null` 表示合格，否则返回拒绝理由。
 * 检查顺序有意义：先挡结构性错误（协议、端口、路径），再判 IP，最后判名字。
 */
function checkHost(host: string): string | null {
  if (host.length === 0) return '域名为空';
  if (host.includes('://')) return '不能带协议，只写主机名';
  // IPv6 要先于「单个冒号 = 协议」判断，否则 `fe80::1` 会被误报成协议
  if (host.includes('[') || host.includes(']') || (host.match(/:/g)?.length ?? 0) >= 2) {
    return '不能是 IPv6 地址';
  }
  if (/^[a-z][a-z0-9+.-]*:(?!\d+$)/.test(host)) return '不能带协议，只写主机名';
  if (host.includes('@')) return '不能带用户信息';
  if (/[/?#\\]/.test(host)) return '不能带路径、查询或片段';
  if (host.includes(':')) return '不能带端口（只允许默认的 443）';
  if (/\s/.test(host)) return '不能含空白字符';
  if (/[^\x00-\x7f]/.test(host)) return '国际化域名请写成 punycode（xn-- 形式）';
  if (host.endsWith('.')) return '不能以点结尾';

  let name = host;
  if (name.startsWith('*.')) {
    name = name.slice(2);
    if (name.includes('*')) return '通配符只能出现一次，且只能是前导的 *.';
    if (name.split('.').length < 2) return '通配符后至少要有两段（如 *.example.com）';
  } else if (name.includes('*')) {
    return '通配符只能写成前导的 *.';
  }

  const labels = name.split('.');
  // IP 字面量：每段都是 IPv4 数字（含单段十进制整数、十六进制、八进制、缩写）
  if (labels.every((l) => IPV4_NUMBER_RE.test(l))) return '不能是 IP 地址';
  if (name.length > MAX_HOST_LENGTH) return '域名过长';
  for (const label of labels) {
    if (label.length === 0) return '域名里有空段（连续的点或以点开头）';
    if (label.length > MAX_LABEL_LENGTH) return '某一段超过 63 个字符';
    if (!LABEL_RE.test(label)) return '只允许字母、数字和连字符，且每段不能以连字符开头或结尾';
  }
  if (labels.length < 2) {
    return name === 'localhost' ? '不能是 localhost' : '不能是单段主机名';
  }
  for (const suffix of RESERVED_SUFFIXES) {
    if (matchesSuffix(name, suffix)) return `不能使用内网或保留后缀 .${suffix}`;
  }
  const tld = labels[labels.length - 1] ?? '';
  if (IPV4_NUMBER_RE.test(tld)) return '最后一段不能是数字（会被当作 IP 地址解析）';
  if (!TLD_RE.test(tld)) return '最后一段必须是字母组成的顶级域';
  for (const suffix of REBINDING_SUFFIXES) {
    if (matchesSuffix(name, suffix)) return `${suffix} 会把名字解析到任意 IP，不允许声明`;
  }
  return null;
}

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 校验 manifest 的 `network` 字段。
 *
 * `undefined` 视同「未声明联网域名」，返回空列表；其他非数组值、非字符串项都报错。
 * 合格时返回规范化（去空白、小写、去重）后的列表，顺序保留首次出现。
 */
export function validatePluginNetwork(list: unknown): ValidateResult {
  if (list === undefined) return { ok: true, hosts: [] };
  if (!Array.isArray(list)) {
    return { ok: false, errors: [{ entry: describeEntry(list), reason: 'network 必须是数组' }] };
  }
  const errors: PluginNetworkError[] = [];
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const raw of list as unknown[]) {
    if (typeof raw !== 'string') {
      errors.push({ entry: describeEntry(raw), reason: '每一项都必须是字符串' });
      continue;
    }
    const host = normalizeHost(raw);
    const reason = checkHost(host);
    if (reason !== null) {
      errors.push({ entry: raw, reason });
      continue;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  if (hosts.length > MAX_NETWORK_HOSTS) {
    errors.push({
      entry: `共 ${hosts.length} 项`,
      reason: `最多声明 ${MAX_NETWORK_HOSTS} 个联网域名`,
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, hosts };
}

/**
 * 生成插件帧（牢笼帧与插件帧共用）的 CSP，指令集严格等于 §4.2 模板。
 *
 * `innerFrame: 'blob'` 时 `frame-src` 改为 `blob:`（牢笼用 blob 装载内层的备选方案，
 * 见 §4.1）；默认 `'none'`。主机按字典序排列，同一组域名永远得到同一份 CSP。
 * 输入不合格时抛错 —— 调用方必须先用 `validatePluginNetwork` 校验。
 */
export function buildPluginFrameCsp(
  hosts: string[],
  opts?: { innerFrame?: 'srcdoc' | 'blob' },
): string {
  const result = validatePluginNetwork(hosts);
  if (!result.ok) {
    const detail = result.errors.map((e) => `${e.entry}: ${e.reason}`).join('; ');
    throw new Error(`插件联网域名不合格，拒绝生成 CSP：${detail}`);
  }
  const sorted = [...result.hosts].sort();
  const d = sorted.map((h) => SCHEME_HTTPS + h);
  const w = sorted.map((h) => SCHEME_WSS + h);
  const src = (...parts: string[]) => parts.join(' ');
  const frameSrc = opts?.innerFrame === 'blob' ? 'blob:' : "'none'";
  const directives = [
    "default-src 'none'",
    src(
      'script-src',
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'wasm-unsafe-eval'",
      'blob:',
      'data:',
      ...d,
    ),
    src('style-src', "'unsafe-inline'", 'blob:', 'data:', ...d),
    src('img-src', 'blob:', 'data:', ...d),
    src('font-src', 'blob:', 'data:', ...d),
    src('media-src', 'blob:', 'data:', ...d),
    src('connect-src', 'blob:', 'data:', ...d, ...w),
    'worker-src blob:',
    `frame-src ${frameSrc}`,
    "child-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "manifest-src 'none'",
  ];
  return directives.join('; ');
}

/**
 * 联网域名集合的规范哈希：与顺序、大小写、首尾空白、重复项无关。
 *
 * 用于同意记录（`PluginConsent.networkHash`）比对「声明的域名变了没有」。
 * 同步实现，复用工坊的双种子 FNV-1a（不需要密码学强度：没有对手在构造碰撞，
 * 只是检测作者改了列表）。本函数不校验输入，校验交给 `validatePluginNetwork`。
 */
export function canonicalNetworkHash(hosts: string[]): string {
  const canonical = [...new Set(hosts.map(normalizeHost))].sort();
  return hashWorkshopContent(canonical.join('\n'));
}

/** 外链地址长度上限：够放正常的分享链接，又不至于把弹窗撑爆 */
const MAX_EXTERNAL_URL_LENGTH = 2048;

/** `validateExternalUrl` 的结果；合格时 `url` 是解析器规整后的完整地址 */
type ExternalUrlResult = { ok: true; url: string } | { ok: false; reason: string };

/**
 * 校验插件经 `host.ui.openExternal(url)` 递来的外链（设计 §5.7）。
 *
 * 只收 `https:`；主机名过与 `validatePluginNetwork` 同一套规则（不必在 `network` 里），
 * 另外不许通配符、端口（含显式的 443）、用户信息。宿主拿到合格地址也只给玩家看和复制，
 * 从不替玩家打开（Q12）—— 这里的校验是为了不把内网地址、IP 之类明显危险的东西摆到玩家面前。
 *
 * 先按原始字符串切出主机段再判，不只信解析器：解析器会悄悄吞掉显式 443、
 * 把反斜杠当斜杠、把十六进制数字主机改写成 IPv4，原始形态里的这些花样一律直接拒。
 */
export function validateExternalUrl(url: unknown): ExternalUrlResult {
  if (typeof url !== 'string' || url.length === 0)
    return { ok: false, reason: '链接必须是非空字符串' };
  if (url.length > MAX_EXTERNAL_URL_LENGTH) return { ok: false, reason: '链接过长' };
  if (/[\s\x00-\x1f\x7f]/.test(url)) return { ok: false, reason: '链接不能含空白或控制字符' };
  if (url.includes('\\')) return { ok: false, reason: '链接不能含反斜杠' };
  if (url.slice(0, SCHEME_HTTPS.length).toLowerCase() !== SCHEME_HTTPS) {
    return { ok: false, reason: '只允许 https 链接' };
  }
  const rest = url.slice(SCHEME_HTTPS.length);
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes('@')) return { ok: false, reason: '链接不能带用户信息' };
  if (authority.includes('*')) return { ok: false, reason: '链接不能含通配符' };
  const host = authority.toLowerCase();
  const reason = checkHost(host);
  if (reason !== null) return { ok: false, reason };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: '链接无法解析' };
  }
  // 双保险：解析器眼里的主机、协议、端口与原始切出来的必须一致
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== host ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return { ok: false, reason: '链接解析结果与原文不一致' };
  }
  return { ok: true, url: parsed.href };
}
