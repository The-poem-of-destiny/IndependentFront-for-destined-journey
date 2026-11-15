import { describe, expect, it } from 'vitest';
import {
  buildPluginFrameCsp,
  canonicalNetworkHash,
  validateExternalUrl,
  validatePluginNetwork,
} from '../../../src/core/plugins/plugin-network';

/**
 * plugin-network 的例子测试：设计文档 §4.2 每一类拒绝各一组用例，外加 CSP 模板逐字比对。
 * 属性测试见同目录的 plugin-network.property.test.ts。
 */

function rejects(entry: unknown): string {
  const r = validatePluginNetwork([entry]);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('unreachable');
  expect(r.errors).toHaveLength(1);
  return r.errors[0]!.reason;
}

function accepts(entry: string): string {
  const r = validatePluginNetwork([entry]);
  if (!r.ok) throw new Error(`应当通过：${entry} → ${JSON.stringify(r.errors)}`);
  expect(r.hosts).toHaveLength(1);
  return r.hosts[0]!;
}

describe('validatePluginNetwork：合格输入', () => {
  it('普通多段域名原样通过', () => {
    expect(accepts('api.example.com')).toBe('api.example.com');
    expect(accepts('cdn.jsdelivr.net')).toBe('cdn.jsdelivr.net');
  });

  it('大写与首尾空白被规范化', () => {
    expect(accepts('  API.Example.COM ')).toBe('api.example.com');
  });

  it('punycode 国际化域名通过', () => {
    expect(accepts('xn--fiqs8s.xn--fiqz9s')).toBe('xn--fiqs8s.xn--fiqz9s');
  });

  it('前导 *. 的通配符，后面至少两段即可', () => {
    expect(accepts('*.example.com')).toBe('*.example.com');
    expect(accepts('*.co.uk')).toBe('*.co.uk');
  });

  it('undefined 视为未声明，返回空列表', () => {
    expect(validatePluginNetwork(undefined)).toEqual({ ok: true, hosts: [] });
    expect(validatePluginNetwork([])).toEqual({ ok: true, hosts: [] });
  });

  it('重复项（含大小写不同）只保留一份，顺序取首次出现', () => {
    const r = validatePluginNetwork(['b.example.com', 'a.example.com', 'B.Example.com']);
    expect(r).toEqual({ ok: true, hosts: ['b.example.com', 'a.example.com'] });
  });

  it('含连字符和数字的段可以通过，只要顶级域是字母', () => {
    expect(accepts('my-api2.example-1.io')).toBe('my-api2.example-1.io');
  });
});

describe('validatePluginNetwork：输入形状', () => {
  it('非数组整体拒绝', () => {
    const r = validatePluginNetwork('example.com');
    expect(r.ok).toBe(false);
  });

  it('非字符串项被拒并报告', () => {
    const r = validatePluginNetwork([42, null, { host: 'a.com' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.entry)).toEqual(['42', 'null', '{"host":"a.com"}']);
  });

  it('空串拒绝', () => {
    rejects('');
    rejects('   ');
  });

  it('一条错误不影响其他条目的报告，全部错误一起返回', () => {
    const r = validatePluginNetwork(['ok.example.com', 'localhost', '10.0.0.1']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.entry)).toEqual(['localhost', '10.0.0.1']);
  });
});

describe('validatePluginNetwork：协议、端口、路径', () => {
  it('带协议拒绝', () => {
    for (const e of ['https:' + '//example.com', 'http:' + '//example.com', 'wss:' + '//a.com']) {
      expect(rejects(e)).toMatch(/协议/);
    }
    expect(rejects('https:example.com')).toMatch(/协议/);
  });

  it('带端口拒绝', () => {
    expect(rejects('example.com:443')).toMatch(/端口/);
    expect(rejects('example.com:8188')).toMatch(/端口/);
  });

  it('带路径、查询、片段、反斜杠拒绝', () => {
    for (const e of ['example.com/api', 'example.com?x=1', 'example.com#a', 'example.com\\a']) {
      expect(rejects(e)).toMatch(/路径/);
    }
  });

  it('带用户信息拒绝', () => {
    expect(rejects('user@example.com')).toMatch(/用户信息/);
  });

  it('内部空白、尾随点、空段拒绝', () => {
    expect(rejects('exa mple.com')).toMatch(/空白/);
    expect(rejects('example.com.')).toMatch(/点结尾/);
    expect(rejects('a..example.com')).toMatch(/空段/);
    expect(rejects('.example.com')).toMatch(/空段/);
  });
});

describe('validatePluginNetwork：IP 字面量', () => {
  it('点分十进制 IPv4 拒绝', () => {
    for (const e of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '8.8.8.8']) {
      expect(rejects(e)).toMatch(/IP/);
    }
  });

  it('IPv4 的缩写、十进制整数、十六进制、八进制写法拒绝', () => {
    for (const e of [
      '127.1',
      '2130706433',
      '0x7f000001',
      '0x7f.0.0.1',
      '0177.0.0.1',
      '017700000001',
    ]) {
      expect(rejects(e)).toMatch(/IP/);
    }
  });

  it('IPv6 字面量拒绝（带不带方括号）', () => {
    for (const e of ['[::1]', '::1', 'fe80::1', '[fc00::1]', '::ffff:127.0.0.1']) {
      expect(rejects(e)).toMatch(/IPv6/);
    }
  });

  it('末段是数字或十六进制数字的名字拒绝（解析器会当作 IPv4）', () => {
    expect(rejects('foo.123')).toMatch(/数字/);
    expect(rejects('foo.0x7f')).toMatch(/数字/);
    expect(rejects('foo.0x')).toMatch(/数字/);
  });

  it('顶级域不是字母也拒绝', () => {
    expect(rejects('foo.a1')).toMatch(/顶级域/);
    expect(rejects('foo.c')).toMatch(/顶级域/);
  });
});

describe('validatePluginNetwork：本机与内网名字', () => {
  it('localhost 与 *.localhost 拒绝', () => {
    expect(rejects('localhost')).toMatch(/localhost/);
    expect(rejects('LOCALHOST')).toMatch(/localhost/);
    expect(rejects('app.localhost')).toMatch(/localhost/);
    expect(rejects('*.localhost')).toMatch(/两段|localhost/);
    expect(rejects('*.a.localhost')).toMatch(/localhost/);
  });

  it('单段主机名拒绝', () => {
    expect(rejects('nas')).toMatch(/单段/);
    expect(rejects('router')).toMatch(/单段/);
  });

  it('文档列出的每个保留后缀都拒绝', () => {
    const suffixes = [
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
    for (const s of suffixes) {
      expect(rejects(`nas.${s}`)).toMatch(/保留后缀/);
      expect(rejects(`*.box.${s}`)).toMatch(/保留后缀/);
    }
    expect(rejects('1.0.0.127.in-addr.arpa')).toMatch(/保留后缀/);
  });

  it('后缀只按整段匹配，不误伤以同样字母结尾的公网名', () => {
    expect(accepts('mylocal.com')).toBe('mylocal.com');
    expect(accepts('local.com')).toBe('local.com');
    expect(accepts('example.com')).toBe('example.com');
  });
});

describe('validatePluginNetwork：重绑定服务表', () => {
  it('nip.io、sslip.io 等「名字解析到任意 IP」的服务拒绝', () => {
    for (const e of [
      '127.0.0.1.nip.io',
      'nip.io',
      '10-0-0-1.sslip.io',
      'app.localtest.me',
      'lvh.me',
      '*.nip.io',
      '*.x.traefik.me',
    ]) {
      expect(rejects(e)).toMatch(/任意 IP/);
    }
  });

  it('只是名字里含有 nip 的公网域名不受影响', () => {
    expect(accepts('notnip.io')).toBe('notnip.io');
  });
});

describe('validatePluginNetwork：通配符', () => {
  it('*.com 这类通配后只剩一段的拒绝', () => {
    expect(rejects('*.com')).toMatch(/两段/);
  });

  it('非前导、多个、裸的 * 都拒绝', () => {
    expect(rejects('*')).toMatch(/通配符/);
    expect(rejects('a.*.example.com')).toMatch(/通配符/);
    expect(rejects('*.*.example.com')).toMatch(/通配符/);
    expect(rejects('*example.com')).toMatch(/通配符/);
    expect(rejects('api*.example.com')).toMatch(/通配符/);
  });

  it('通配后的部分是 IP 也拒绝', () => {
    expect(rejects('*.0.0.1')).toMatch(/IP/);
  });
});

describe('validatePluginNetwork：非 ASCII 与字符集', () => {
  it('Unicode 国际化域名要求写成 punycode', () => {
    expect(rejects('例子.中国')).toMatch(/punycode/);
    expect(rejects('exаmple.com')).toMatch(/punycode/); // 西里尔字母 а
  });

  it('下划线和首尾连字符拒绝', () => {
    expect(rejects('my_api.example.com')).toMatch(/字母、数字和连字符/);
    expect(rejects('-api.example.com')).toMatch(/连字符/);
    expect(rejects('api-.example.com')).toMatch(/连字符/);
  });

  it('超长段与超长名字拒绝', () => {
    expect(rejects(`${'a'.repeat(64)}.com`)).toMatch(/63/);
    const long = Array.from({ length: 60 }, () => 'abcd').join('.') + '.com';
    expect(rejects(long)).toMatch(/过长/);
  });
});

describe('validatePluginNetwork：数量上限', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`);

  it('16 项通过', () => {
    const r = validatePluginNetwork(many(16));
    expect(r.ok).toBe(true);
  });

  it('17 项拒绝', () => {
    const r = validatePluginNetwork(many(17));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[r.errors.length - 1]!.reason).toMatch(/16/);
  });

  it('重复项去重后计数', () => {
    const r = validatePluginNetwork([...many(16), 'H0.example.com']);
    expect(r.ok).toBe(true);
  });
});

describe('buildPluginFrameCsp', () => {
  const H = 'https' + ':' + '//';
  const W = 'wss' + ':' + '//';

  it('未声明域名时与 §4.2 模板逐字一致', () => {
    expect(buildPluginFrameCsp([])).toBe(
      [
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
        "style-src 'unsafe-inline' blob: data:",
        'img-src blob: data:',
        'font-src blob: data:',
        'media-src blob: data:',
        'connect-src blob: data:',
        'worker-src blob:',
        "frame-src 'none'",
        "child-src 'none'",
        "object-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "manifest-src 'none'",
      ].join('; '),
    );
  });

  it('声明域名后展开成 https 与 wss 两种来源，按字典序排列', () => {
    const csp = buildPluginFrameCsp(['b.example.com', 'A.example.com']);
    const d = `${H}a.example.com ${H}b.example.com`;
    expect(csp).toContain(`img-src blob: data: ${d};`);
    expect(csp).toContain(
      `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: ${d};`,
    );
    expect(csp).toContain(`connect-src blob: data: ${d} ${W}a.example.com ${W}b.example.com;`);
    expect(csp).toContain('worker-src blob:;');
  });

  it('同一组域名换顺序得到同一份 CSP', () => {
    expect(buildPluginFrameCsp(['a.com', 'b.com'])).toBe(buildPluginFrameCsp(['b.com', 'a.com']));
  });

  it('通配符域名以 https://*.域名 的形式出现', () => {
    const csp = buildPluginFrameCsp(['*.example.com']);
    expect(csp).toContain(`${H}*.example.com`);
    expect(csp).toContain(`${W}*.example.com`);
  });

  it('指令集合恰好是模板里的 14 条', () => {
    const names = buildPluginFrameCsp(['a.com'])
      .split('; ')
      .map((d) => d.split(' ')[0]);
    expect(names).toEqual([
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'font-src',
      'media-src',
      'connect-src',
      'worker-src',
      'frame-src',
      'child-src',
      'object-src',
      'form-action',
      'base-uri',
      'manifest-src',
    ]);
  });

  it("innerFrame 为 blob 时 frame-src 改为 blob:，srcdoc 或缺省时为 'none'", () => {
    expect(buildPluginFrameCsp([], { innerFrame: 'blob' })).toContain('frame-src blob:;');
    expect(buildPluginFrameCsp([], { innerFrame: 'srcdoc' })).toContain("frame-src 'none';");
    expect(buildPluginFrameCsp([], { innerFrame: 'blob' })).toContain("child-src 'none'");
  });

  it('输入不合格时抛错，不生成任何 CSP', () => {
    expect(() => buildPluginFrameCsp(['127.0.0.1'])).toThrow(/不合格/);
    expect(() => buildPluginFrameCsp(['localhost'])).toThrow();
    expect(() => buildPluginFrameCsp(['a.com:8188'])).toThrow();
    expect(() => buildPluginFrameCsp(['a.com; script-src *'])).toThrow();
    expect(() => buildPluginFrameCsp(Array.from({ length: 17 }, (_, i) => `h${i}.a.com`))).toThrow(
      /16/,
    );
    expect(() => buildPluginFrameCsp('a.com' as unknown as string[])).toThrow();
  });
});

describe('canonicalNetworkHash', () => {
  it('与顺序、大小写、空白、重复无关', () => {
    const a = canonicalNetworkHash(['a.example.com', 'b.example.com']);
    expect(canonicalNetworkHash(['B.example.com ', 'a.example.com', 'a.EXAMPLE.com'])).toBe(a);
  });

  it('集合不同则哈希不同', () => {
    expect(canonicalNetworkHash(['a.example.com'])).not.toBe(
      canonicalNetworkHash(['b.example.com']),
    );
    expect(canonicalNetworkHash([])).not.toBe(canonicalNetworkHash(['a.example.com']));
    expect(canonicalNetworkHash(['a.com', 'b.com'])).not.toBe(canonicalNetworkHash(['a.comb.com']));
  });

  it('返回 16 位十六进制串，空集也是确定值', () => {
    expect(canonicalNetworkHash([])).toMatch(/^[0-9a-f]{16}$/);
    expect(canonicalNetworkHash([])).toBe(canonicalNetworkHash([]));
  });
});

describe('validateExternalUrl：插件外链校验（§5.7）', () => {
  const H = 'https' + ':' + '//';

  function rejectsUrl(url: unknown): string {
    const r = validateExternalUrl(url);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    return r.reason;
  }

  it('合格的 https 公网地址通过，返回规整后的完整地址', () => {
    expect(validateExternalUrl(H + 'docs.example.com/guide?a=1#top')).toEqual({
      ok: true,
      url: H + 'docs.example.com/guide?a=1#top',
    });
    expect(validateExternalUrl(H + 'Example.COM')).toEqual({ ok: true, url: H + 'example.com/' });
  });

  it('非 https 协议一律拒绝', () => {
    expect(rejectsUrl('http' + ':' + '//example.com/')).toContain('https');
    expect(rejectsUrl('javascript' + ':alert(1)')).toContain('https');
    expect(rejectsUrl('data' + ':text/html,<b>x</b>')).toContain('https');
    expect(rejectsUrl('ws' + 's:' + '//example.com/')).toContain('https');
  });

  it('IP 地址、localhost、保留后缀被拒', () => {
    expect(rejectsUrl(H + '127.0.0.1/')).toContain('IP');
    expect(rejectsUrl(H + '0x7f000001/')).toContain('IP');
    expect(rejectsUrl(H + '[::1]/')).toContain('IPv6');
    expect(rejectsUrl(H + 'localhost/')).toContain('localhost');
    expect(rejectsUrl(H + 'router.lan/')).toContain('.lan');
    expect(rejectsUrl(H + 'a.nip.io/')).toContain('nip.io');
  });

  it('带端口（含显式 443）被拒', () => {
    expect(rejectsUrl(H + 'example.com:8188/')).toContain('端口');
    expect(rejectsUrl(H + 'example.com:443/')).toContain('端口');
  });

  it('带用户信息被拒，含反斜杠伪装的写法', () => {
    expect(rejectsUrl(H + 'user:pw@example.com/')).toContain('用户信息');
    expect(rejectsUrl(H + 'example.com@127.0.0.1/')).toContain('用户信息');
    expect(rejectsUrl(H + 'example.com\\@127.0.0.1/')).toContain('反斜杠');
  });

  it('非字符串、空串、空白、通配符、过长都被拒', () => {
    rejectsUrl(42);
    rejectsUrl('');
    expect(rejectsUrl(H + 'exa mple.com/')).toContain('空白');
    expect(rejectsUrl(H + '*.example.com/')).toContain('通配符');
    expect(rejectsUrl(H + 'example.com/' + 'a'.repeat(3000))).toContain('过长');
  });
});
