import { describe, expect, it } from 'vitest';
import {
  checkPluginRelPath,
  pluginFileMime,
  PLUGIN_DIR_LIMITS,
  PLUGIN_FILE_TYPES as SERVER_FILE_TYPES,
} from '../../../server/plugin-dir';
import {
  computePluginContentHash,
  planPluginInstall,
  type PluginInstallFile,
  type PluginInstallInput,
} from '../../../src/core/plugins/plugin-install-plan';
import { canonicalNetworkHash } from '../../../src/core/plugins/plugin-network';
import {
  isSafePluginRelPath,
  PLUGIN_FILE_TYPES,
  PLUGIN_LIMITS,
} from '../../../src/core/plugins/plugin-surface';
import type { PluginManifest, PluginRecord } from '../../../src/core/types/types-plugin';

/**
 * plugin-install-plan：新装 / 更新 / 没变三种动作、新增域名、重新确认与按存档确认作废的判定、
 * 每一类校验错误，以及与 server/plugin-dir.ts 的路径与扩展名规则一致性。
 */

const MB = 1024 * 1024;

function manifestOf(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'example.shop',
    name: '杂货铺',
    version: '1.0.0',
    pluginApi: '^1.0',
    contributions: [
      {
        slot: 'game.toolbar',
        id: 'shop',
        label: '杂货铺',
        icon: 'icon.png',
        surface: 'window',
        entry: 'shop.html',
      },
    ],
    network: ['api.example.com'],
    capabilities: { read: ['player'] },
    ...patch,
  };
}

function baseFiles(): PluginInstallFile[] {
  return [
    { path: 'manifest.json', size: 400 },
    { path: 'shop.html', size: 1000 },
    { path: 'icon.png', size: 2000 },
  ];
}

function input(patch: Partial<PluginInstallInput> = {}): PluginInstallInput {
  return {
    manifestRaw: JSON.stringify(manifestOf()),
    files: baseFiles(),
    contentHash: 'hash-v1',
    source: 'local',
    existing: undefined,
    ...patch,
  };
}

/** 按某份计划造一条「已安装」记录 */
function recordFrom(manifest: PluginManifest, contentHash: string): PluginRecord {
  const networkHash = canonicalNetworkHash(manifest.network);
  const consent = { version: manifest.version, contentHash, networkHash, at: 1 };
  return {
    id: manifest.id,
    manifest,
    source: 'local',
    contentHash,
    networkHash,
    fileCount: 3,
    totalBytes: 3400,
    installedAt: 1,
    updatedAt: 1,
    installConsent: consent,
    saveConsents: { save1: consent },
  };
}

function installedV1(): PluginRecord {
  const plan = planPluginInstall(input());
  return recordFrom(plan.manifest as PluginManifest, 'hash-v1');
}

describe('planPluginInstall：动作判定', () => {
  it('未安装 → install，必须确认，不作废按存档确认，networkAdded 为空', () => {
    const plan = planPluginInstall(input());
    expect(plan.status).toBe('ok');
    expect(plan.action).toBe('install');
    expect(plan.errors).toEqual([]);
    expect(plan.manifest?.id).toBe('example.shop');
    expect(plan.networkHash).toBe(canonicalNetworkHash(['api.example.com']));
    expect(plan.networkAdded).toEqual([]);
    expect(plan.requiresReconsent).toBe(true);
    expect(plan.invalidatesSaveConsents).toBe(false);
    expect(plan.fileCount).toBe(3);
    expect(plan.totalBytes).toBe(3400);
    expect(plan.source).toBe('local');
    expect(plan.contentHash).toBe('hash-v1');
  });

  it('内容哈希相同 → unchanged，不需要确认', () => {
    const plan = planPluginInstall(input({ existing: installedV1() }));
    expect(plan.action).toBe('unchanged');
    expect(plan.requiresReconsent).toBe(false);
    expect(plan.invalidatesSaveConsents).toBe(false);
  });

  it('内容哈希相同但安装确认记的是别的内容 → 仍要求确认', () => {
    const existing = installedV1();
    existing.installConsent = { ...existing.installConsent, contentHash: 'stale' };
    const plan = planPluginInstall(input({ existing }));
    expect(plan.action).toBe('unchanged');
    expect(plan.requiresReconsent).toBe(true);
  });

  it('内容变了但 network 没变 → update，要求确认，按存档确认保留', () => {
    const plan = planPluginInstall(input({ existing: installedV1(), contentHash: 'hash-v2' }));
    expect(plan.action).toBe('update');
    expect(plan.requiresReconsent).toBe(true);
    expect(plan.invalidatesSaveConsents).toBe(false);
    expect(plan.networkAdded).toEqual([]);
  });

  it('network 变了 → 作废按存档确认，networkAdded 只列新增域名并排序', () => {
    const plan = planPluginInstall(
      input({
        existing: installedV1(),
        contentHash: 'hash-v2',
        manifestRaw: manifestOf({ network: ['z.example.com', 'api.example.com', 'b.example.com'] }),
      }),
    );
    expect(plan.action).toBe('update');
    expect(plan.networkAdded).toEqual(['b.example.com', 'z.example.com']);
    expect(plan.requiresReconsent).toBe(true);
    expect(plan.invalidatesSaveConsents).toBe(true);
  });

  it('只删除域名也算 network 变化，但没有新增域名', () => {
    const plan = planPluginInstall(
      input({
        existing: installedV1(),
        contentHash: 'hash-v2',
        manifestRaw: manifestOf({ network: [] }),
      }),
    );
    expect(plan.networkAdded).toEqual([]);
    expect(plan.invalidatesSaveConsents).toBe(true);
  });

  it('不兼容的 manifest → incompatible，保留 manifest 供展示', () => {
    const plan = planPluginInstall(input({ manifestRaw: manifestOf({ pluginApi: '^2.0' }) }));
    expect(plan.status).toBe('incompatible');
    expect(plan.incompatible).toContain('^2.0');
    expect(plan.manifest).not.toBeNull();
    expect(plan.errors).toEqual([]);
  });

  it('manifest 的处置记录原样带出', () => {
    const plan = planPluginInstall(input({ manifestRaw: manifestOf({ extra: 1 }) }));
    expect(plan.status).toBe('ok');
    expect(plan.droppedNotes).toContain('已丢弃未知字段 extra');
  });
});

describe('planPluginInstall：校验错误', () => {
  function expectInvalid(patch: Partial<PluginInstallInput>, fragment: string): void {
    const plan = planPluginInstall(input(patch));
    expect(plan.status).toBe('invalid');
    expect(plan.errors.join('\n')).toContain(fragment);
  }

  it('manifest 不合格 → invalid，manifest 为 null，networkHash 为 null', () => {
    const plan = planPluginInstall(input({ manifestRaw: '{不是 JSON' }));
    expect(plan.status).toBe('invalid');
    expect(plan.manifest).toBeNull();
    expect(plan.networkHash).toBeNull();
    expect(plan.errors).toContain('manifest.json 不是合法的 JSON');
  });

  it('不安全的文件路径', () => {
    for (const path of ['../evil.js', '/abs.js', 'a\\b.js', 'C:/x.js', 'nul.txt', 'a/./b.js']) {
      expectInvalid({ files: [...baseFiles(), { path, size: 1 }] }, `文件路径不安全：${path}`);
    }
  });

  it('不允许的文件类型', () => {
    expectInvalid(
      { files: [...baseFiles(), { path: 'run.exe', size: 1 }] },
      '不允许的文件类型：run.exe',
    );
    expectInvalid(
      { files: [...baseFiles(), { path: 'noext', size: 1 }] },
      '不允许的文件类型：noext',
    );
  });

  it('重复路径', () => {
    expectInvalid(
      { files: [...baseFiles(), { path: 'shop.html', size: 1 }] },
      '文件重复：shop.html',
    );
  });

  it('文件大小无效', () => {
    expectInvalid({ files: [...baseFiles(), { path: 'a.js', size: -1 }] }, '文件大小无效：a.js');
    expectInvalid({ files: [...baseFiles(), { path: 'b.js', size: 1.5 }] }, '文件大小无效：b.js');
  });

  it('单文件超过上限', () => {
    expectInvalid(
      { files: [...baseFiles(), { path: 'big.js', size: PLUGIN_LIMITS.fileBytes + 1 }] },
      '文件超过 5MB 上限：big.js',
    );
    // 恰好在上限上的不报
    const ok = planPluginInstall(
      input({ files: [...baseFiles(), { path: 'big.js', size: PLUGIN_LIMITS.fileBytes }] }),
    );
    expect(ok.status).toBe('ok');
  });

  it('manifest.json 超过 64KB', () => {
    const files = baseFiles();
    files[0] = { path: 'manifest.json', size: PLUGIN_LIMITS.manifestBytes + 1 };
    expectInvalid({ files }, 'manifest.json 超过 64KB 上限');
  });

  it('合计超过 20MB', () => {
    const files = [...baseFiles()];
    for (let i = 0; i < 5; i++) files.push({ path: `part${i}.js`, size: 4 * MB + 512 * 1024 });
    expectInvalid({ files }, '插件合计超过 20MB 上限');
  });

  it('文件数超过上限', () => {
    const files = [...baseFiles()];
    for (let i = 0; files.length <= PLUGIN_LIMITS.files; i++)
      files.push({ path: `f${i}.txt`, size: 1 });
    expectInvalid({ files }, `超过 ${PLUGIN_LIMITS.files} 个的上限`);
  });

  it('缺少 manifest.json', () => {
    expectInvalid({ files: baseFiles().slice(1) }, '包内缺少 manifest.json');
  });

  it('入口、图标、后台页面必须在包内', () => {
    const files = baseFiles().filter((f) => f.path !== 'shop.html' && f.path !== 'icon.png');
    const plan = planPluginInstall(
      input({ files, manifestRaw: manifestOf({ background: 'bg.html' }) }),
    );
    expect(plan.status).toBe('invalid');
    expect(plan.errors).toContain('contributions[0].entry 指向的文件不在包内：shop.html');
    expect(plan.errors).toContain('contributions[0].icon 指向的文件不在包内：icon.png');
    expect(plan.errors).toContain('background 指向的文件不在包内：bg.html');
  });

  it('manifest id 与文件夹名不一致', () => {
    expectInvalid({ folderId: 'other.shop' }, '与文件夹名「other.shop」不一致');
    expect(planPluginInstall(input({ folderId: 'example.shop' })).status).toBe('ok');
  });

  it('已安装记录与 manifest id 不一致', () => {
    const existing = { ...installedV1(), id: 'other.shop' };
    expectInvalid({ existing, contentHash: 'hash-v2' }, '已安装记录的 id「other.shop」');
  });

  it('文件层面的错误不丢掉 manifest', () => {
    const plan = planPluginInstall(input({ files: baseFiles().slice(1) }));
    expect(plan.status).toBe('invalid');
    expect(plan.manifest?.id).toBe('example.shop');
    expect(plan.networkHash).not.toBeNull();
  });
});

describe('computePluginContentHash', () => {
  const a = { path: 'a.js', sha256: 'AA'.repeat(32) };
  const b = { path: 'b/c.css', sha256: 'bb'.repeat(32) };

  it('与顺序、SHA-256 大小写无关，16 位十六进制', () => {
    const h = computePluginContentHash([a, b]);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(computePluginContentHash([b, a])).toBe(h);
    expect(computePluginContentHash([{ ...a, sha256: a.sha256.toLowerCase() }, b])).toBe(h);
  });

  it('增删改任何一个文件都会改变哈希', () => {
    const h = computePluginContentHash([a, b]);
    expect(computePluginContentHash([a])).not.toBe(h);
    expect(computePluginContentHash([a, { ...b, sha256: 'cc'.repeat(32) }])).not.toBe(h);
    expect(computePluginContentHash([a, { ...b, path: 'b/d.css' }])).not.toBe(h);
  });
});

describe('与 server/plugin-dir.ts 的一致性', () => {
  const vectors = [
    'a.js',
    'dir/sub/file.css',
    'manifest.json',
    'UPPER.PNG',
    'font.woff2',
    'x.wav',
    '',
    '.',
    '..',
    '../a.js',
    'a/../b.js',
    '/abs.js',
    'a//b.js',
    'trailing/',
    'a\\b.js',
    'C:/x.js',
    'file:stream.js',
    'tab\there.js',
    'del\u007f.js',
    'c1\u0085.js',
    'q?.js',
    'star*.js',
    'pipe|.js',
    'lt<.js',
    'quote".js',
    'dot.',
    'space .js ',
    'nul.txt',
    'NUL',
    'con .js',
    'com1.js',
    'com¹.js',
    'lpt9.css',
    'conin$.js',
    'console.js',
    'aux/x.js',
    '.hidden',
    '.js',
    'noext',
    'a.exe',
    'a.html.exe',
    'a.constructor',
    'a.toString',
    'a.__proto__',
    'dir.js/file',
    'x'.repeat(128) + '.js',
    'x'.repeat(129),
    `${'a/'.repeat(15)}b.js`,
    `${'a/'.repeat(16)}b.js`,
    `${'abcdefgh/'.repeat(56)}z.js`,
    `${'abcdefgh/'.repeat(57)}z.js`,
  ];

  it('扩展名 → MIME 表逐项一致', () => {
    expect({ ...PLUGIN_FILE_TYPES }).toEqual({ ...SERVER_FILE_TYPES });
  });

  it('上限逐项一致', () => {
    expect(PLUGIN_LIMITS.fileBytes).toBe(PLUGIN_DIR_LIMITS.maxFileBytes);
    expect(PLUGIN_LIMITS.pluginBytes).toBe(PLUGIN_DIR_LIMITS.maxPluginBytes);
    expect(PLUGIN_LIMITS.manifestBytes).toBe(PLUGIN_DIR_LIMITS.maxManifestBytes);
    expect(PLUGIN_LIMITS.pathSegmentChars).toBe(PLUGIN_DIR_LIMITS.maxSegmentLength);
    expect(PLUGIN_LIMITS.pathChars).toBe(PLUGIN_DIR_LIMITS.maxPathLength);
    expect(PLUGIN_LIMITS.pathDepth).toBe(PLUGIN_DIR_LIMITS.maxDepth);
    expect(PLUGIN_LIMITS.files).toBe(PLUGIN_DIR_LIMITS.maxFiles);
  });

  it.each(vectors)('路径判定一致：%j', (path) => {
    expect(isSafePluginRelPath(path)).toBe(checkPluginRelPath(path).ok);
  });

  it.each(vectors)('安装计划对文件的接受与服务端一致：%j', (path) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const serverAccepts = checkPluginRelPath(path).ok && pluginFileMime(name) !== null;
    const plan = planPluginInstall(input({ files: [...baseFiles(), { path, size: 1 }] }));
    const coreRejects = plan.errors.some(
      (e) => e === `文件路径不安全：${path}` || e === `不允许的文件类型：${path}`,
    );
    expect(coreRejects).toBe(!serverAccepts);
  });
});
