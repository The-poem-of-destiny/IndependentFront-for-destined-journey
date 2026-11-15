/**
 * plugin-surface.ts —— 插件 API 面单一来源的结构测试（设计 §8）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLUGIN_AI,
  PLUGIN_API_VERSION,
  PLUGIN_CLOSED_OPS,
  PLUGIN_COMMANDS,
  PLUGIN_DEFERRED_OPS,
  PLUGIN_EVENTS,
  PLUGIN_FILE_TYPES,
  PLUGIN_LIMITS,
  PLUGIN_SLOTS,
  PLUGIN_STORAGE,
  PLUGIN_VIEWS,
  isSafePluginRelPath,
} from '../../../src/core/plugins/plugin-surface';
import type { StatePatchOp } from '../../../src/core/types/types';
import type {
  PluginCapabilities,
  PluginContribution,
  PluginErrorCode,
  PluginExpect,
  PluginExpectState,
  PluginPromptInputs,
  PluginResult,
  PluginRunGuard,
  PluginSurfaceKind,
} from '../../../src/core/types/types-plugin';

/** 从 types.ts 源码里读出 `StatePatchOp` 联合的全部成员（类型在运行时不存在） */
function readStatePatchOps(): string[] {
  const src = readFileSync(resolve(__dirname, '../../../src/core/types/types.ts'), 'utf8');
  const start = src.indexOf('export type StatePatchOp =');
  const end = src.indexOf(';', start);
  expect(start).toBeGreaterThan(-1);
  const body = src
    .slice(start, end)
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('命令表与 StatePatchOp 的对应', () => {
  it('每个 StatePatchOp 恰好落在 已映射 / 推迟 / 不开放 三个名单之一', () => {
    const ops = readStatePatchOps();
    expect(ops.length).toBeGreaterThan(40);
    const mapped = new Set<string>(Object.values(PLUGIN_COMMANDS).flat());
    const deferred = new Set<string>(PLUGIN_DEFERRED_OPS);
    const closed = new Set<string>(PLUGIN_CLOSED_OPS);
    for (const op of ops) {
      const hits = [mapped.has(op), deferred.has(op), closed.has(op)].filter(Boolean).length;
      expect(hits, `${op} 必须恰好在一个名单里`).toBe(1);
    }
    // 反向：名单里不许出现不存在的 op
    for (const op of [...mapped, ...deferred, ...closed]) {
      expect(ops, `${op} 不是 StatePatchOp`).toContain(op);
    }
  });

  it('覆盖设计 §5.3 的全部命令名', () => {
    const expected = [
      'vars.set',
      'vars.delta',
      'vars.remove',
      'vars.move',
      'vars.insert',
      'fp.add',
      'fp.spend',
      'character.update',
      'money.add',
      'money.spend',
      'resource.set',
      'resource.delta',
      'character.add',
      'character.remove',
      'character.rename',
      'status.add',
      'status.update',
      'status.remove',
      'item.grant',
      'item.remove',
      'item.update',
      'item.transfer',
      'item.equip',
      'item.unequip',
      'skill.add',
      'skill.update',
      'skill.remove',
      'location.set',
      'quest.upsert',
      'quest.remove',
      'affection.set',
      'affection.delta',
      'news.add',
      'plot.updateEvent',
      'memory.add',
    ];
    for (const name of expected) expect(Object.keys(PLUGIN_COMMANDS)).toContain(name);
    const tileCommands = Object.keys(PLUGIN_COMMANDS).filter((n) => n.startsWith('map.tile.'));
    expect(tileCommands).toHaveLength(6);
    expect(Object.keys(PLUGIN_COMMANDS)).toHaveLength(expected.length + 6);
  });

  it('memory.add 已开放：映射到 add_memory，推迟名单为空', () => {
    const deferred: readonly StatePatchOp[] = PLUGIN_DEFERRED_OPS;
    expect(deferred).toEqual([]);
    expect(PLUGIN_COMMANDS['memory.add']).toEqual(['add_memory']);
  });
});

describe('名称表', () => {
  it('版本号是语义化版本', () => {
    expect(PLUGIN_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('投影、事件、AI、存储、贡献点各自无重复且与设计一致', () => {
    for (const list of [PLUGIN_VIEWS, PLUGIN_EVENTS, PLUGIN_AI, PLUGIN_STORAGE, PLUGIN_SLOTS]) {
      expect(new Set(list).size).toBe(list.length);
    }
    expect(PLUGIN_VIEWS).toHaveLength(16);
    expect(PLUGIN_VIEWS).toContain('player.inventory');
    expect(PLUGIN_EVENTS).toContain('timeline.restored');
    expect([...PLUGIN_AI]).toEqual(['note', 'context']);
    expect([...PLUGIN_STORAGE]).toEqual(['save', 'global']);
    expect([...PLUGIN_SLOTS]).toEqual([
      'game.toolbar',
      'game.menu',
      'game.overlay',
      'panel.items.footer',
    ]);
  });

  it('文件类型表的扩展名一律小写不带点，MIME 非空', () => {
    for (const [ext, mime] of Object.entries(PLUGIN_FILE_TYPES)) {
      expect(ext).toMatch(/^[a-z0-9]+$/);
      expect(mime).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
    }
    expect(PLUGIN_FILE_TYPES.html).toBe('text/html');
    expect(PLUGIN_FILE_TYPES.js).toBe('text/javascript');
    // 与 server/plugin-dir.ts 的白名单逐项一致（一致性测试另有一条直接比对两份表）
    expect(Object.keys(PLUGIN_FILE_TYPES).sort()).toEqual(
      [
        'html',
        'htm',
        'js',
        'mjs',
        'css',
        'json',
        'txt',
        'md',
        'svg',
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'avif',
        'woff',
        'woff2',
        'ttf',
        'otf',
        'mp3',
        'ogg',
        'wav',
      ].sort(),
    );
  });

  it('上限数值与设计一致', () => {
    expect(PLUGIN_LIMITS).toEqual({
      messageBytes: 262144,
      commitBytes: 262144,
      messagesPerSecond: 60,
      fileBytes: 5 * 1024 * 1024,
      pluginBytes: 20 * 1024 * 1024,
      manifestBytes: 64 * 1024,
      pathSegmentChars: 128,
      pathChars: 512,
      pathDepth: 16,
      files: 1000,
      saveBagBytes: 262144,
      globalBytes: 1024 * 1024,
      networkHosts: 16,
      backgroundPlugins: 8,
      noteChars: 2000,
      noteQueue: 16,
      contextChars: 4000,
    });
  });
});

describe('isSafePluginRelPath', () => {
  it('接受普通相对路径', () => {
    for (const p of ['index.html', 'app/main.js', 'a/b/c.png', '图标/商店.svg', '.well/x.json']) {
      expect(isSafePluginRelPath(p), p).toBe(true);
    }
  });

  it('拒绝 §4.6 列出的每一类坏段', () => {
    const bad = [
      '',
      '/abs.js',
      'a//b.js',
      'a/',
      './a.js',
      '../a.js',
      'a/../b.js',
      'a\\b.js',
      'C:x.js',
      'file.js:stream',
      'a\u0000.js',
      'a\u001f.js',
      'a\u007f.js',
      'trail.',
      'trail ',
      'dir./a.js',
      'CON',
      'con.txt',
      'Nul.html',
      'com1',
      'LPT9.js',
      'aux/x.js',
      'con .js',
      'CONIN$',
      'com¹.txt',
      'a<b.js',
      'a?.js',
      'a*.js',
      'a"b.js',
      'a|b.js',
      'a\u0085.js',
      'x'.repeat(129),
      'a/'.repeat(16) + 'b.js',
      'a/' + 'b'.repeat(511),
    ];
    for (const p of bad) expect(isSafePluginRelPath(p), JSON.stringify(p)).toBe(false);
  });

  it('非字符串输入一律拒绝', () => {
    expect(isSafePluginRelPath(undefined as unknown as string)).toBe(false);
    expect(isSafePluginRelPath(42 as unknown as string)).toBe(false);
  });

  it('保留设备名只按整段判定，含它的普通名字不受影响', () => {
    expect(isSafePluginRelPath('console.js')).toBe(true);
    expect(isSafePluginRelPath('com10.js')).toBe(true);
    expect(isSafePluginRelPath('lpt0.js')).toBe(true);
  });
});

describe('类型契约', () => {
  it('结果、前置条件与提示词输入的形状可被构造', () => {
    const code: PluginErrorCode = 'QUOTA';
    const fail: PluginResult = { ok: false, code, message: '超额', index: 0 };
    const okResult: PluginResult<number> = { ok: true, value: 1 };
    const expects: PluginExpect[] = [
      { view: 'player.money', gte: 30 },
      { item: '治疗药水', owner: '甲', gte: 1 },
      { var: 'user.shop.stock', gte: 1 },
      { var: 'user.shop.open', eq: true },
      { var: 'user.shop.flag', exists: false },
    ];
    const guard: PluginRunGuard = () => 'ok';
    const surface: PluginSurfaceKind = 'window';
    const contribution: PluginContribution = {
      slot: PLUGIN_SLOTS[0],
      id: 'main',
      label: '商店',
      surface,
      entry: 'index.html',
    };
    const inputs: PluginPromptInputs = {
      notes: [{ pluginName: '商店', text: '进货' }],
      contexts: [],
    };
    const state: Partial<PluginExpectState> = { characters: [] };
    const caps: PluginCapabilities = {
      read: [...PLUGIN_VIEWS],
      commands: [],
      events: [],
      ai: [],
      storage: [],
    };
    expect(caps.read).toHaveLength(PLUGIN_VIEWS.length);
    expect(fail.ok).toBe(false);
    expect(okResult.ok).toBe(true);
    expect(expects).toHaveLength(5);
    expect(guard()).toBe('ok');
    expect(contribution.slot).toBe('game.toolbar');
    expect(inputs.notes).toHaveLength(1);
    expect(state.characters).toEqual([]);
  });
});
