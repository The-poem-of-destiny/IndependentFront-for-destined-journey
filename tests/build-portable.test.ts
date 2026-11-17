import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import {
  filesContaining,
  findDevLaunchers,
  findPackServerEnv,
  ignoredPublicTargets,
  parseNulSeparated,
  shouldStore,
  stripIgnoredPublicFiles,
  writeZip,
} from '../scripts/build-portable.mjs';

/**
 * 便携版打包脚本的纯函数测试。真正的打包（vite 构建 + 复制 node.exe）太重，
 * 由 `node scripts/build-portable.mjs` + `scripts/smoke-portable.mjs` 手动端到端验证。
 */

describe('findDevLaunchers', () => {
  it('命中任意层级的开发启动器（大小写不敏感），放过玩家用的 Start.bat 与 server.mjs', () => {
    const root = 'narrative-engine-v1.0.0-win-x64';
    expect(
      findDevLaunchers([
        `${root}/Start.bat`,
        `${root}/app/server.mjs`,
        `${root}/app/web/index.html`,
        `${root}/dev.bat`,
        `${root}/DEV.SH`,
        `${root}/dev.local.bat`,
        `${root}/update.bat`,
        `${root}/scripts/dev.mjs`,
      ]),
    ).toEqual([
      `${root}/dev.bat`,
      `${root}/DEV.SH`,
      `${root}/dev.local.bat`,
      `${root}/update.bat`,
      `${root}/scripts/dev.mjs`,
    ]);
  });
});

describe('shouldStore', () => {
  it('已压缩的图片 / 音视频 / 字体 / 压缩包用 store', () => {
    for (const name of [
      'a.png',
      'web/assets/b.JPG',
      'x/y.jpeg',
      'c.webp',
      'bgm.mp3',
      'se.ogg',
      'v.mp4',
      'font.woff2',
      'pack.zip',
    ]) {
      expect(shouldStore(name), name).toBe(true);
    }
  });

  it('文本、脚本、wasm 与无扩展名文件用 deflate', () => {
    for (const name of [
      'index.html',
      'assets/index-abc.js',
      'assets/style.css',
      'assets/quickjs.wasm',
      'data.json',
      'runtime/node.exe',
      'LICENSE',
      '.png',
      'dir.png/readme',
    ]) {
      expect(shouldStore(name), name).toBe(false);
    }
  });
});

describe('writeZip', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'build-portable-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('写出的 zip 能被 fflate 解回原内容（含中文文件名、嵌套目录、store 与空文件）', async () => {
    const src = join(dir, 'src');
    mkdirSync(join(src, 'nested', 'deep'), { recursive: true });
    const big = Buffer.alloc(300_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 251;
    const files: Array<[string, string, Buffer]> = [
      ['root/使用说明.txt', join(src, 'readme.txt'), Buffer.from('\uFEFF你好，世界\r\n', 'utf8')],
      [
        'root/app/nested/deep/data.json',
        join(src, 'nested', 'deep', 'data.json'),
        Buffer.from('{"a":1}'),
      ],
      ['root/app/web/image.png', join(src, 'image.png'), big],
      ['root/app/web/big.bin', join(src, 'big.bin'), big],
      ['root/empty.txt', join(src, 'empty.txt'), Buffer.alloc(0)],
    ];
    for (const [, path, data] of files) writeFileSync(path, data);

    const out = join(dir, 'out', 'test.zip');
    await writeZip(
      out,
      files.map(([name, file]) => ({ name, file })),
    );

    const unzipped = unzipSync(new Uint8Array(readFileSync(out)));
    expect(Object.keys(unzipped).sort()).toEqual(files.map(([name]) => name).sort());
    for (const [name, , data] of files) {
      expect(Buffer.from(unzipped[name]).equals(data), name).toBe(true);
    }
    // 中文文件名必须带 UTF-8 标志位（通用标志 bit 11），否则 Windows 资源管理器按 GBK 解出乱码
    const raw = readFileSync(out);
    const nameBytes = Buffer.from('root/使用说明.txt', 'utf8');
    const nameAt = raw.indexOf(nameBytes);
    expect(nameAt).toBeGreaterThan(0);
    // 本地文件头：签名 4 + 版本 2 + 标志 2 …，文件名从偏移 30 开始
    expect(raw.readUInt32LE(nameAt - 30)).toBe(0x04034b50);
    expect(raw.readUInt16LE(nameAt - 30 + 6) & 0x0800).toBe(0x0800);
    expect(strFromU8(unzipped['root/app/nested/deep/data.json'])).toBe('{"a":1}');
  });
});

describe('git 忽略的 public/ 文件剔除', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'build-portable-strip-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // git ls-files -z 的真实输出：路径原样 UTF-8、NUL 分隔、末尾带一个 NUL
  const gitOutput = [
    'public/audio/bgm/命定之诗 主题曲.mp3',
    'public/audio/se/a b.ogg',
    'public/missing.txt',
    'src/not-public.ts',
  ]
    .map((p) => `${p}\0`)
    .join('');

  it('按 NUL 切分，不 trim、不丢中文与空格', () => {
    expect(parseNulSeparated(gitOutput)).toEqual([
      'public/audio/bgm/命定之诗 主题曲.mp3',
      'public/audio/se/a b.ogg',
      'public/missing.txt',
      'src/not-public.ts',
    ]);
    expect(parseNulSeparated('')).toEqual([]);
  });

  it('只映射 public/ 下的条目到 web 产物目录', () => {
    expect(ignoredPublicTargets(dir, gitOutput)).toEqual([
      join(dir, 'audio', 'bgm', '命定之诗 主题曲.mp3'),
      join(dir, 'audio', 'se', 'a b.ogg'),
      join(dir, 'missing.txt'),
    ]);
  });

  it('删掉产物里对应的文件（含中文文件名），不存在的跳过，其余文件不动', () => {
    mkdirSync(join(dir, 'audio', 'bgm'), { recursive: true });
    mkdirSync(join(dir, 'audio', 'se'), { recursive: true });
    const chinese = join(dir, 'audio', 'bgm', '命定之诗 主题曲.mp3');
    const spaced = join(dir, 'audio', 'se', 'a b.ogg');
    const kept = join(dir, 'audio', 'bgm', 'kept.mp3');
    for (const f of [chinese, spaced, kept]) writeFileSync(f, 'x');

    expect(stripIgnoredPublicFiles(dir, gitOutput)).toBe(2);
    expect(existsSync(chinese)).toBe(false);
    expect(existsSync(spaced)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it('core.quotepath 风格的转义输出对不上任何文件（这就是必须用 -z 的原因）', () => {
    mkdirSync(join(dir, 'audio'), { recursive: true });
    const chinese = join(dir, 'audio', '曲.mp3');
    writeFileSync(chinese, 'x');
    const quoted = '"public/audio/\\346\\233\\262.mp3"\0';
    expect(stripIgnoredPublicFiles(dir, quoted)).toBe(0);
    expect(stripIgnoredPublicFiles(dir, 'public/audio/曲.mp3\0')).toBe(1);
  });
});

describe('VITE_PACK_SERVER_URL 守卫', () => {
  let dir: string;
  let savedShell: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'build-portable-env-'));
    savedShell = process.env.VITE_PACK_SERVER_URL;
    delete process.env.VITE_PACK_SERVER_URL;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedShell === undefined) delete process.env.VITE_PACK_SERVER_URL;
    else process.env.VITE_PACK_SERVER_URL = savedShell;
  });

  it('没有定义时返回空', async () => {
    writeFileSync(join(dir, '.env'), 'VITE_OTHER=1\n');
    expect(await findPackServerEnv(dir, ['production'])).toEqual([]);
  });

  it('识别 KEY=value 与 KEY: value 两种写法，并按 mode 区分文件', async () => {
    writeFileSync(join(dir, '.env.production'), 'VITE_PACK_SERVER_URL: https://colon.example\n');
    writeFileSync(
      join(dir, '.env.development.local'),
      'export VITE_PACK_SERVER_URL=https://eq.example\n',
    );
    expect(await findPackServerEnv(dir, ['production', 'development'])).toEqual([
      { mode: 'production', value: 'https://colon.example' },
      { mode: 'development', value: 'https://eq.example' },
    ]);
  });

  it('.env.local 对所有 mode 生效', async () => {
    writeFileSync(join(dir, '.env.local'), 'VITE_PACK_SERVER_URL = https://local.example\n');
    expect(await findPackServerEnv(dir, ['production'])).toEqual([
      { mode: 'production', value: 'https://local.example' },
    ]);
  });

  it('filesContaining 只扫 js/mjs/html，命中即返回', () => {
    const js = join(dir, 'a.js');
    const html = join(dir, 'index.html');
    const png = join(dir, 'b.png');
    writeFileSync(js, 'const u="https://leak.example";');
    writeFileSync(html, '<html></html>');
    writeFileSync(png, 'https://leak.example');
    expect(filesContaining([js, html, png], ['https://leak.example'])).toEqual([js]);
    expect(filesContaining([js, html, png], [])).toEqual([]);
    expect(filesContaining([js, html, png], ['https://other.example'])).toEqual([]);
  });
});
