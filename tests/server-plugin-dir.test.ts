import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkPluginPathSegment,
  checkPluginRelPath,
  isRequestIntoPluginsDir,
  isValidPluginId,
  listPlugins,
  PLUGIN_DIR_LIMITS,
  PLUGIN_FILE_TYPES,
  pluginFileMime,
  readPluginFile,
  resolvePluginsDir,
} from '../server/plugin-dir';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

let tmp: string;
let pluginsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'poem-plugin-dir-'));
  pluginsDir = join(tmp, 'poem-plugins');
  mkdirSync(pluginsDir);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(rel: string, content: string | Buffer): void {
  const abs = join(pluginsDir, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** 尝试建目录链接：先 junction（Windows 免权限），失败再试 dir 符号链接；都失败返回原因 */
function tryDirLink(target: string, linkPath: string): string | null {
  const errors: string[] = [];
  for (const type of ['junction', 'dir'] as const) {
    try {
      symlinkSync(target, linkPath, type);
      return null;
    } catch (error) {
      errors.push(`${type}: ${String(error)}`);
    }
  }
  return errors.join('; ');
}

/** 尝试建文件符号链接；失败（如 Windows 无权限）返回原因 */
function tryFileLink(target: string, linkPath: string): string | null {
  try {
    symlinkSync(target, linkPath, 'file');
    return null;
  } catch (error) {
    return String(error);
  }
}

describe('resolvePluginsDir 目录位置', () => {
  const repo = resolve('/work/repo');

  it('缺省为仓库上一级的 poem-plugins', () => {
    expect(resolvePluginsDir({}, repo)).toEqual({
      ok: true,
      dir: resolve('/work/poem-plugins'),
      source: 'default',
    });
    expect(resolvePluginsDir({ POEM_PLUGINS_DIR: '   ' }, repo)).toMatchObject({
      ok: true,
      source: 'default',
    });
  });

  it('环境变量覆盖：绝对路径与相对仓库根的路径', () => {
    const abs = resolve('/elsewhere/plugins');
    expect(resolvePluginsDir({ POEM_PLUGINS_DIR: abs }, repo)).toEqual({
      ok: true,
      dir: abs,
      source: 'env',
    });
    expect(resolvePluginsDir({ POEM_PLUGINS_DIR: '../my-plugins' }, repo)).toMatchObject({
      ok: true,
      dir: resolve('/work/my-plugins'),
    });
  });

  it('落在 public/、dist-ui/、仓库根之内一律拒绝且不抛错', () => {
    const cases: [string, string][] = [
      [join(repo, 'public', 'plugins'), 'inside-public'],
      [join(repo, 'public'), 'inside-public'],
      [join(repo, 'dist-ui', 'x'), 'inside-dist-ui'],
      [join(repo, 'plugins'), 'inside-root'],
      [repo, 'inside-root'],
      ['plugins', 'inside-root'],
    ];
    for (const [value, reason] of cases) {
      const result = resolvePluginsDir({ POEM_PLUGINS_DIR: value }, repo);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(reason);
        expect(result.message).toContain('拒绝');
      }
    }
  });

  it('插件目录包含仓库根也拒绝', () => {
    const result = resolvePluginsDir({ POEM_PLUGINS_DIR: resolve('/work') }, repo);
    expect(result).toMatchObject({ ok: false, reason: 'contains-root' });
  });
});

describe('路径段校验（§4.6 每条规则）', () => {
  const rejected: [string, string][] = [
    ['', '空段'],
    ['.', '当前目录'],
    ['..', '上级目录'],
    ['a\\b', '反斜杠'],
    ['C:', '盘符'],
    ['a.txt:stream', 'NTFS 备用数据流'],
    ['a.txt::$DATA', 'NTFS 数据流后缀'],
    ['a\u0000b', 'NUL 控制字符'],
    ['a\nb', '换行'],
    ['a\u007fb', 'DEL'],
    ['a\u0085b', 'C1 控制字符'],
    ['name.', '尾随点'],
    ['name ', '尾随空格'],
    ['a<b', 'Windows 非法字符 <'],
    ['a|b', 'Windows 非法字符 |'],
    ['a?b', 'Windows 非法字符 ?'],
    ['a*b', 'Windows 非法字符 *'],
    ['a"b', 'Windows 非法字符 "'],
    ['x'.repeat(PLUGIN_DIR_LIMITS.maxSegmentLength + 1), '过长'],
  ];
  for (const [segment, label] of rejected) {
    it(`拒绝：${label}`, () => {
      expect(checkPluginPathSegment(segment)).not.toBeNull();
    });
  }

  const reserved = ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'COM¹', 'CONIN$'];
  for (const name of reserved) {
    it(`拒绝 Windows 保留设备名 ${name}（带不带扩展名都算）`, () => {
      expect(checkPluginPathSegment(name)).not.toBeNull();
      expect(checkPluginPathSegment(`${name}.txt`)).not.toBeNull();
      expect(checkPluginPathSegment(`${name}.tar.gz`)).not.toBeNull();
      expect(checkPluginPathSegment(`${name} .js`)).not.toBeNull();
    });
  }

  it('放行普通名字与形似保留名的名字', () => {
    for (const ok of ['index.html', 'a', 'COM0', 'COM10', 'console.js', 'nul-x.js', '.hidden']) {
      expect(checkPluginPathSegment(ok)).toBeNull();
    }
  });

  it('相对路径：前导斜杠、尾随斜杠、双斜杠、穿越、过深、过长都拒绝', () => {
    for (const bad of [
      '',
      '/a.js',
      'a/',
      'a//b.js',
      '../a.js',
      'a/../b.js',
      'a/./b.js',
      'C:/a.js',
      Array.from({ length: PLUGIN_DIR_LIMITS.maxDepth + 1 }, () => 'd').join('/'),
      `${'a/'.repeat(200)}x.js`,
    ]) {
      expect(checkPluginRelPath(bad).ok).toBe(false);
    }
    expect(checkPluginRelPath('ui/main.js')).toEqual({ ok: true, segments: ['ui', 'main.js'] });
  });

  it('插件 id 规则', () => {
    expect(isValidPluginId('shop')).toBe(true);
    expect(isValidPluginId('my.shop-1_x')).toBe(true);
    for (const bad of ['ab', 'Shop', '-shop', 'shop.', 'con', 'a'.repeat(65), 'sh op']) {
      expect(isValidPluginId(bad)).toBe(false);
    }
  });

  it('扩展名白名单按小写匹配，无扩展名与未知扩展名拒绝', () => {
    expect(pluginFileMime('a.HTML')).toBe(PLUGIN_FILE_TYPES.html);
    expect(pluginFileMime('a.png')).toBe('image/png');
    for (const bad of ['a.exe', 'a.bat', 'Makefile', '.env', 'a.', 'a.constructor', 'a.toString']) {
      expect(pluginFileMime(bad)).toBeNull();
    }
  });
});

describe('listPlugins 列目录', () => {
  it('目录不存在时 dirExists 为 false', async () => {
    expect(await listPlugins(join(tmp, 'missing'))).toEqual({
      ok: true,
      dirExists: false,
      plugins: [],
    });
  });

  it('插件目录本身是文件时拒绝', async () => {
    const file = join(tmp, 'file');
    writeFileSync(file, 'x');
    expect(await listPlugins(file)).toMatchObject({ ok: false, code: 'DIR_NOT_DIRECTORY' });
  });

  it('列出合法插件的文件、大小、sha256、manifest 原文；略过非法名字与非白名单类型', async () => {
    const manifest = '{"id":"shop"}';
    put('shop/manifest.json', manifest);
    put('shop/index.html', '<p>hi</p>');
    put('shop/ui/app.js', 'console.log(1)');
    put('shop/.DS_Store', 'junk');
    put('shop/run.exe', 'MZ');
    put('Invalid_ID/index.html', 'x');
    put('loose.html', 'x');

    const result = await listPlugins(pluginsDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dirExists).toBe(true);
    expect(result.plugins.map((p) => p.id)).toEqual(['shop']);
    const shop = result.plugins[0];
    expect(shop.error).toBeUndefined();
    expect(shop.manifestText).toBe(manifest);
    expect(shop.files).toEqual([
      { path: 'index.html', size: 9, sha256: sha('<p>hi</p>') },
      { path: 'manifest.json', size: manifest.length, sha256: sha(manifest) },
      { path: 'ui/app.js', size: 14, sha256: sha('console.log(1)') },
    ]);
    expect(shop.totalBytes).toBe(9 + manifest.length + 14);
    expect(shop.skipped.map((s) => s.path).sort()).toEqual(['.DS_Store', 'run.exe']);
  });

  it('没有 manifest.json 时 manifestText 为 null', async () => {
    put('shop/index.html', 'x');
    const result = await listPlugins(pluginsDir);
    expect(result.ok && result.plugins[0].manifestText).toBeNull();
  });

  it('manifest 超过 64KB 判整个插件不可用', async () => {
    put('shop/manifest.json', 'x'.repeat(PLUGIN_DIR_LIMITS.maxManifestBytes + 1));
    const result = await listPlugins(pluginsDir);
    expect(result.ok && result.plugins[0].error).toContain('manifest.json');
    expect(result.ok && result.plugins[0].files).toEqual([]);
  });

  it('单文件超过 5MB 判整个插件不可用', async () => {
    put('shop/big.png', Buffer.alloc(PLUGIN_DIR_LIMITS.maxFileBytes + 1));
    const result = await listPlugins(pluginsDir);
    expect(result.ok && result.plugins[0].error).toContain('5MB');
  });

  it('单插件合计超过 20MB 判整个插件不可用', async () => {
    const chunk = Buffer.alloc(PLUGIN_DIR_LIMITS.maxFileBytes);
    for (let i = 0; i < 4; i += 1) put(`shop/p${i}.png`, chunk);
    put('shop/extra.png', Buffer.alloc(1));
    const result = await listPlugins(pluginsDir);
    expect(result.ok && result.plugins[0].error).toContain('20MB');
    expect(result.ok && result.plugins[0].totalBytes).toBe(0);
  });

  it('恰好 20MB 仍可用', async () => {
    const chunk = Buffer.alloc(PLUGIN_DIR_LIMITS.maxFileBytes);
    for (let i = 0; i < 4; i += 1) put(`shop/p${i}.png`, chunk);
    const result = await listPlugins(pluginsDir);
    expect(result.ok && result.plugins[0].error).toBeUndefined();
    expect(result.ok && result.plugins[0].totalBytes).toBe(PLUGIN_DIR_LIMITS.maxPluginBytes);
  });

  it('包内目录过深判整个插件不可用', async () => {
    const deep = Array.from({ length: PLUGIN_DIR_LIMITS.maxDepth }, () => 'd').join('/');
    put(`shop/${deep}/a.js`, 'x');
    const result = await listPlugins(pluginsDir);
    expect(result.ok && result.plugins[0].error).toContain('过深');
  });

  it('插件子目录是目录链接时判不可用', async (ctx) => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'index.html'), 'secret');
    const reason = tryDirLink(outside, join(pluginsDir, 'linked'));
    if (reason !== null) ctx.skip(`当前环境无法创建目录联接或符号链接：${reason}`);
    const result = await listPlugins(pluginsDir);
    expect(result.ok && result.plugins).toEqual([
      expect.objectContaining({ id: 'linked', files: [], error: expect.stringContaining('链接') }),
    ]);
  });

  it('包内含目录链接时整个插件不可用', async (ctx) => {
    put('shop/index.html', 'x');
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    const reason = tryDirLink(outside, join(pluginsDir, 'shop', 'assets'));
    if (reason !== null) ctx.skip(`当前环境无法创建目录联接或符号链接：${reason}`);
    const result = await listPlugins(pluginsDir);
    expect(result.ok && result.plugins[0].error).toContain('assets');
    expect(result.ok && result.plugins[0].files).toEqual([]);
  });

  it('包内含文件符号链接时整个插件不可用', async (ctx) => {
    put('shop/index.html', 'x');
    const secret = join(tmp, 'secret.js');
    writeFileSync(secret, 'secret');
    const reason = tryFileLink(secret, join(pluginsDir, 'shop', 'evil.js'));
    if (reason !== null)
      ctx.skip(`当前环境无法创建文件符号链接（Windows 需开发者模式）：${reason}`);
    const result = await listPlugins(pluginsDir);
    expect(result.ok && result.plugins[0].error).toContain('evil.js');
  });

  it('插件目录本身是链接时整体拒绝', async (ctx) => {
    put('shop/index.html', 'x');
    const link = join(tmp, 'linked-root');
    const reason = tryDirLink(pluginsDir, link);
    if (reason !== null) ctx.skip(`当前环境无法创建目录联接或符号链接：${reason}`);
    expect(await listPlugins(link)).toMatchObject({ ok: false, code: 'DIR_IS_LINK' });
  });
});

describe('readPluginFile 读单个文件', () => {
  it('读出字节、大小、MIME 与 sha256', async () => {
    put('shop/ui/app.js', 'console.log(1)');
    const result = await readPluginFile(pluginsDir, 'shop', 'ui/app.js');
    expect(result).toMatchObject({
      ok: true,
      size: 14,
      mime: 'text/javascript',
      sha256: sha('console.log(1)'),
    });
    expect(result.ok && result.bytes.toString('utf-8')).toBe('console.log(1)');
  });

  it('非法 id、非法路径、非白名单类型分别给出错误码', async () => {
    put('shop/run.exe', 'MZ');
    expect(await readPluginFile(pluginsDir, '../x', 'a.js')).toMatchObject({ code: 'INVALID_ID' });
    expect(await readPluginFile(pluginsDir, 'Shop', 'a.js')).toMatchObject({ code: 'INVALID_ID' });
    for (const bad of ['../shop/a.js', 'a/../../x.js', '/etc/a.js', 'a\\b.js', 'CON.js', 'a.js.']) {
      expect(await readPluginFile(pluginsDir, 'shop', bad)).toMatchObject({ code: 'INVALID_PATH' });
    }
    expect(await readPluginFile(pluginsDir, 'shop', 'run.exe')).toMatchObject({
      code: 'TYPE_NOT_ALLOWED',
    });
  });

  it('不存在、中间段是文件、目标是目录分别处理', async () => {
    put('shop/a.js', 'x');
    mkdirSync(join(pluginsDir, 'shop', 'dir.js'));
    expect(await readPluginFile(pluginsDir, 'shop', 'nope.js')).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await readPluginFile(pluginsDir, 'nope', 'a.js')).toMatchObject({ code: 'NOT_FOUND' });
    expect(await readPluginFile(pluginsDir, 'shop', 'a.js/b.js')).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await readPluginFile(pluginsDir, 'shop', 'dir.js')).toMatchObject({ code: 'NOT_FILE' });
  });

  it('超过 5MB 拒绝，恰好 5MB 放行', async () => {
    put('shop/big.png', Buffer.alloc(PLUGIN_DIR_LIMITS.maxFileBytes + 1));
    put('shop/edge.png', Buffer.alloc(PLUGIN_DIR_LIMITS.maxFileBytes));
    expect(await readPluginFile(pluginsDir, 'shop', 'big.png')).toMatchObject({
      code: 'TOO_LARGE',
    });
    expect(await readPluginFile(pluginsDir, 'shop', 'edge.png')).toMatchObject({
      ok: true,
      size: PLUGIN_DIR_LIMITS.maxFileBytes,
    });
  });

  it('路径中任何一级是目录联接都拒绝', async (ctx) => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'a.js'), 'secret');
    put('shop/index.html', 'x');
    const reasons = [
      tryDirLink(outside, join(pluginsDir, 'linked')),
      tryDirLink(outside, join(pluginsDir, 'shop', 'sub')),
    ];
    if (reasons.some((r) => r !== null)) {
      ctx.skip(`当前环境无法创建目录联接或符号链接：${reasons.join(' | ')}`);
    }
    expect(await readPluginFile(pluginsDir, 'linked', 'a.js')).toMatchObject({ code: 'LINK' });
    expect(await readPluginFile(pluginsDir, 'shop', 'sub/a.js')).toMatchObject({ code: 'LINK' });
    const rootLink = join(tmp, 'root-link');
    if (tryDirLink(pluginsDir, rootLink) === null) {
      expect(await readPluginFile(rootLink, 'shop', 'index.html')).toMatchObject({ code: 'LINK' });
    }
  });

  it('目标文件是符号链接时拒绝', async (ctx) => {
    put('shop/index.html', 'x');
    const secret = join(tmp, 'secret.js');
    writeFileSync(secret, 'secret');
    const reason = tryFileLink(secret, join(pluginsDir, 'shop', 'evil.js'));
    if (reason !== null)
      ctx.skip(`当前环境无法创建文件符号链接（Windows 需开发者模式）：${reason}`);
    expect(await readPluginFile(pluginsDir, 'shop', 'evil.js')).toMatchObject({ code: 'LINK' });
  });
});

describe('isRequestIntoPluginsDir 静态服务拦截判定', () => {
  const root = resolve('/work/repo');
  const plugins = resolve('/work/poem-plugins');
  const fsPath = plugins.replace(/\\/g, '/');
  const fsUrl = `/@fs/${fsPath.replace(/^\//, '')}/shop/index.html`;
  const into = (url: string) => isRequestIntoPluginsDir(url, plugins, root);

  it('/@fs/ 绝对路径形式', () => {
    expect(into(fsUrl)).toBe(true);
    expect(into(`/@fs/${fsPath.replace(/^\//, '')}`)).toBe(true);
    expect(into(`${fsUrl}?import`)).toBe(true);
    expect(into(`http://localhost:5173${fsUrl}`)).toBe(true);
  });

  it('百分号编码与双重编码', () => {
    const encoded = fsUrl.replace(/\//g, '%2F').replace(':', '%3A');
    expect(into(encoded)).toBe(true);
    expect(into(encodeURIComponent(encodeURIComponent(fsUrl)))).toBe(true);
    expect(into(fsUrl.replace('poem-plugins', 'poem%2Dplugins'))).toBe(true);
    expect(into(fsUrl.replace('poem-plugins', 'poem%252Dplugins'))).toBe(true);
  });

  it('反斜杠与大小写混写', () => {
    expect(into(fsUrl.replace(/\//g, '\\'))).toBe(true);
    expect(into(fsUrl.replace('poem-plugins', 'POEM-Plugins'))).toBe(true);
    expect(into(fsUrl.replace('/@fs/', '/@FS/'))).toBe(true);
  });

  it('尾随点空格、数据流后缀与 .. 穿越', () => {
    expect(into(fsUrl.replace('poem-plugins', 'poem-plugins. '))).toBe(true);
    expect(into(fsUrl.replace('index.html', 'index.html::$DATA'))).toBe(true);
    expect(into('/../poem-plugins/shop/index.html')).toBe(true);
    expect(into('/%2e%2e/poem-plugins/shop/index.html')).toBe(true);
    expect(into('/sub/..%5c..%5cpoem-plugins/shop/index.html')).toBe(true);
  });

  it('普通请求与相似名字不误判', () => {
    expect(into('/')).toBe(false);
    expect(into('/src/main.ts')).toBe(false);
    expect(into('/poem-plugins/shop/index.html')).toBe(false);
    expect(into(`/@fs/${fsPath.replace(/^\//, '')}-other/a.html`)).toBe(false);
    expect(into('/%E0%A4%A')).toBe(false);
  });
});

describe('只读结构约束', () => {
  it('源码不含写入、改名、删除、建目录与解析真实路径类的标识符', () => {
    const source = readFileSync(resolve(__dirname, '../server/plugin-dir.ts'), 'utf-8');
    const banned = [
      'real' + 'path',
      'write' + 'File',
      're' + 'name',
      'un' + 'link',
      'mk' + 'dir',
      'r' + 'm(',
      'r' + 'mdir',
      'r' + 'mSync',
      'append' + 'File',
    ];
    for (const word of banned) expect(source).not.toContain(word);
  });
});
