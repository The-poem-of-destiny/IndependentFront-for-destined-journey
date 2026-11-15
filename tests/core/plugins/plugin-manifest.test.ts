import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  coercePluginManifest,
  satisfiesPluginApi,
} from '../../../src/core/plugins/plugin-manifest';
import { PLUGIN_API_VERSION } from '../../../src/core/plugins/plugin-surface';

/**
 * plugin-manifest 的例子测试 + 属性测试：设计文档 §3.2 每条字段规则各一组用例，
 * §3.6 / §8 的「不兼容」判定，以及「垃圾输入永不抛」。
 */

/** §7 商店示例的完整 manifest */
function shopManifest(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'example.shop',
    name: '杂货铺',
    version: '1.0.0',
    author: '示例作者',
    description: '在游戏里买东西',
    pluginApi: '^1.0',
    contributions: [
      {
        slot: 'game.toolbar',
        id: 'shop',
        label: '杂货铺',
        icon: 'icon.png',
        surface: 'window',
        entry: 'shop.html',
        width: 480,
        height: 640,
      },
    ],
    capabilities: {
      read: ['player'],
      commands: ['money.spend', 'item.grant'],
      events: [],
      ai: ['note'],
      storage: ['save'],
    },
  };
}

function withField(key: string, value: unknown): Record<string, unknown> {
  return { ...shopManifest(), [key]: value };
}

function withContribution(patch: Record<string, unknown>): Record<string, unknown> {
  const base = shopManifest();
  const contributions = base.contributions as Record<string, unknown>[];
  return { ...base, contributions: [{ ...contributions[0], ...patch }] };
}

function expectError(raw: unknown, fragment: string): void {
  const r = coercePluginManifest(raw);
  expect(r.manifest).toBeNull();
  expect(r.installable).toBe(false);
  expect(r.errors.join('\n')).toContain(fragment);
}

function expectIncompatible(raw: unknown, fragment: string): void {
  const r = coercePluginManifest(raw);
  expect(r.errors).toEqual([]);
  expect(r.installable).toBe(false);
  expect(r.manifest).not.toBeNull();
  expect(r.incompatible).toContain(fragment);
}

describe('coercePluginManifest：合格输入', () => {
  it('§7 商店示例完整通过，network 缺省规整为空数组', () => {
    const r = coercePluginManifest(shopManifest());
    expect(r.errors).toEqual([]);
    expect(r.droppedNotes).toEqual([]);
    expect(r.incompatible).toBeUndefined();
    expect(r.installable).toBe(true);
    expect(r.manifest).toEqual({ ...shopManifest(), network: [] });
  });

  it('接受 JSON 文本', () => {
    const r = coercePluginManifest(JSON.stringify(shopManifest()));
    expect(r.installable).toBe(true);
    expect(r.manifest?.id).toBe('example.shop');
  });

  it('联网版本：network 规范化后保留，background 入口保留', () => {
    const r = coercePluginManifest({
      ...shopManifest(),
      network: ['Shop-API.example.com', '*.cdn.example.org'],
      background: 'bg/worker.html',
    });
    expect(r.installable).toBe(true);
    expect(r.manifest?.network).toEqual(['shop-api.example.com', '*.cdn.example.org']);
    expect(r.manifest?.background).toBe('bg/worker.html');
  });

  it('缺省 contributions 与 capabilities 规整为空', () => {
    const base = shopManifest();
    delete base.contributions;
    delete base.capabilities;
    const r = coercePluginManifest(base);
    expect(r.installable).toBe(true);
    expect(r.manifest?.contributions).toEqual([]);
    expect(r.manifest?.capabilities).toEqual({
      read: [],
      commands: [],
      events: [],
      ai: [],
      storage: [],
    });
  });

  it('能力名去重', () => {
    const r = coercePluginManifest(
      withField('capabilities', { read: ['player', 'player'], commands: [] }),
    );
    expect(r.manifest?.capabilities.read).toEqual(['player']);
  });
});

describe('coercePluginManifest：不可解析的输入', () => {
  it('坏 JSON 文本', () => expectError('{not json', '不是合法的 JSON'));
  it('非对象', () => {
    expectError(null, '必须是 JSON 对象');
    expectError([1, 2], '必须是 JSON 对象');
    expectError(42, '必须是 JSON 对象');
  });
});

describe('coercePluginManifest：顶层字段规则', () => {
  it('id 必须符合规则', () => {
    expectError(withField('id', 'ab'), 'id 必须');
    expectError(withField('id', 'Shop'), 'id 必须');
    expectError(withField('id', '-shop'), 'id 必须');
    expectError(withField('id', 'a'.repeat(65)), 'id 必须');
    expectError(withField('id', 7), 'id 必须');
  });

  it('name / version 必填且有长度上限', () => {
    expectError(withField('name', ''), 'name 必须是非空字符串');
    expectError(withField('name', '名'.repeat(65)), 'name 超过 64');
    expectError(withField('version', undefined), 'version 必须是非空字符串');
    expectError(withField('version', '1'.repeat(33)), 'version 超过 32');
  });

  it('author / description 无效时丢弃并记处置记录，不影响安装', () => {
    const r = coercePluginManifest({
      ...shopManifest(),
      author: 12,
      description: '长'.repeat(1001),
    });
    expect(r.installable).toBe(true);
    expect(r.manifest?.author).toBeUndefined();
    expect(r.manifest?.description).toBeUndefined();
    expect(r.droppedNotes).toHaveLength(2);
  });

  it('manifestVersion 非数字是错误，不认识的版本是不兼容', () => {
    expectError(withField('manifestVersion', '1'), 'manifestVersion 必须是数字');
    expectIncompatible(withField('manifestVersion', 2), 'manifestVersion 2');
  });

  it('pluginApi 认不出是错误，不满足是不兼容', () => {
    expectError(withField('pluginApi', 'latest'), 'pluginApi 不是可识别的版本范围');
    expectError(withField('pluginApi', ''), 'pluginApi 必须是非空字符串');
    expectIncompatible(withField('pluginApi', '^2.0'), `本机是 ${PLUGIN_API_VERSION}`);
  });

  it('remoteCode 与其他未知字段被丢弃并记录', () => {
    const r = coercePluginManifest({ ...shopManifest(), remoteCode: true, homepage: 'x' });
    expect(r.installable).toBe(true);
    expect(r.manifest).not.toHaveProperty('remoteCode');
    expect(r.manifest).not.toHaveProperty('homepage');
    expect(r.droppedNotes.some((n) => n.includes('remoteCode'))).toBe(true);
    expect(r.droppedNotes.some((n) => n.includes('homepage'))).toBe(true);
  });

  it('background 必须是安全的 HTML 路径', () => {
    expectError(withField('background', '../bg.html'), 'background 不是安全的包内相对路径');
    expectError(withField('background', 'bg.js'), 'background 必须是 .html');
  });
});

describe('coercePluginManifest：network', () => {
  it('任何一项不合规整个插件不可安装', () => {
    const r = coercePluginManifest(withField('network', ['api.example.com', '127.0.0.1']));
    expect(r.installable).toBe(false);
    expect(r.manifest).toBeNull();
    expect(r.errors.join('\n')).toContain('127.0.0.1');
  });

  it('非数组不可安装', () => {
    expectError(withField('network', 'api.example.com'), 'network');
  });
});

describe('coercePluginManifest：贡献点', () => {
  it('contributions 必须是对象数组', () => {
    expectError(withField('contributions', {}), 'contributions 必须是数组');
    expectError(withField('contributions', [1]), 'contributions[0] 必须是对象');
  });

  it('不认识的贡献点是不兼容', () => {
    expectIncompatible(withContribution({ slot: 'game.sidebar' }), '不认识的贡献点 game.sidebar');
  });

  it('surface 必须是三种之一', () => {
    expectError(withContribution({ surface: 'popup' }), '.surface 必须是');
  });

  it('entry 必须是安全的 HTML 路径', () => {
    expectError(withContribution({ entry: '/etc/shop.html' }), '.entry 不是安全的包内相对路径');
    expectError(withContribution({ entry: 'a\\shop.html' }), '.entry 不是安全的包内相对路径');
    expectError(withContribution({ entry: 'shop.js' }), '.entry 必须是 .html');
  });

  it('id 规则与插件内唯一', () => {
    expectError(withContribution({ id: '' }), '.id 只能由');
    expectError(withContribution({ id: 'a b' }), '.id 只能由');
    const base = shopManifest();
    const c = (base.contributions as unknown[])[0];
    expectError({ ...base, contributions: [c, c] }, 'contributions[1].id 重复');
  });

  it('label 必填且有长度上限', () => {
    expectError(withContribution({ label: '' }), '.label 必须是非空字符串');
    expectError(withContribution({ label: '长'.repeat(33) }), '.label 超过 32');
  });

  it('icon 必须是安全的图片路径', () => {
    expectError(withContribution({ icon: '../icon.png' }), '.icon 不是安全的包内相对路径');
    expectError(withContribution({ icon: 'icon.html' }), '.icon 必须是图片文件');
  });

  it('无效尺寸与未知字段丢弃并记录', () => {
    const r = coercePluginManifest(withContribution({ width: -1, height: 'big', color: 'red' }));
    expect(r.installable).toBe(true);
    const c = r.manifest?.contributions[0];
    expect(c?.width).toBeUndefined();
    expect(c?.height).toBeUndefined();
    expect(c).not.toHaveProperty('color');
    expect(r.droppedNotes).toHaveLength(3);
  });
});

describe('coercePluginManifest：能力声明', () => {
  it('不认识的能力名是不兼容', () => {
    expectIncompatible(
      withField('capabilities', { commands: ['money.spend', 'save.delete'] }),
      'save.delete',
    );
    expectIncompatible(withField('capabilities', { read: ['secrets'] }), 'secrets');
    expectIncompatible(withField('capabilities', { events: ['turn.later'] }), 'turn.later');
    expectIncompatible(withField('capabilities', { ai: ['prompt'] }), 'prompt');
    expectIncompatible(withField('capabilities', { storage: ['disk'] }), 'disk');
  });

  it('不认识的能力类别是不兼容', () => {
    expectIncompatible(withField('capabilities', { fs: ['read'] }), 'capabilities.fs');
  });

  it('结构错误是错误', () => {
    expectError(withField('capabilities', []), 'capabilities 必须是对象');
    expectError(
      withField('capabilities', { read: 'player' }),
      'capabilities.read 必须是字符串数组',
    );
    expectError(withField('capabilities', { read: [1] }), '非字符串项');
  });
});

describe('coercePluginManifest：永不抛', () => {
  it('任意 JSON 值与任意字符串都不抛，结果自洽', () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.string(), fc.anything()), (raw) => {
        const r = coercePluginManifest(raw);
        expect(r.installable).toBe(r.errors.length === 0 && r.incompatible === undefined);
        if (r.errors.length > 0) expect(r.manifest).toBeNull();
      }),
    );
  });

  it('在合格 manifest 上乱改任一字段也不抛', () => {
    const keys = Object.keys(shopManifest()).concat(['network', 'background', 'remoteCode']);
    fc.assert(
      fc.property(fc.constantFrom(...keys), fc.anything(), (key, value) => {
        const r = coercePluginManifest(withField(key, value));
        expect(Array.isArray(r.errors)).toBe(true);
        expect(Array.isArray(r.droppedNotes)).toBe(true);
      }),
    );
  });
});

describe('satisfiesPluginApi', () => {
  it('^：锁最左非零段', () => {
    expect(satisfiesPluginApi('^1.0', '1.0.0')).toBe(true);
    expect(satisfiesPluginApi('^1.0', '1.9.3')).toBe(true);
    expect(satisfiesPluginApi('^1.2', '1.1.9')).toBe(false);
    expect(satisfiesPluginApi('^1.0.0', '2.0.0')).toBe(false);
    expect(satisfiesPluginApi('^0.2.1', '0.2.5')).toBe(true);
    expect(satisfiesPluginApi('^0.2.1', '0.3.0')).toBe(false);
    expect(satisfiesPluginApi('^0.0.3', '0.0.4')).toBe(false);
    expect(satisfiesPluginApi('^1', '1.5.0')).toBe(true);
  });

  it('~：锁次版本', () => {
    expect(satisfiesPluginApi('~1.2.0', '1.2.9')).toBe(true);
    expect(satisfiesPluginApi('~1.2.0', '1.3.0')).toBe(false);
    expect(satisfiesPluginApi('~1', '1.9.0')).toBe(true);
    expect(satisfiesPluginApi('~1', '2.0.0')).toBe(false);
  });

  it('>=：只有下界', () => {
    expect(satisfiesPluginApi('>=1.0.0', '5.0.0')).toBe(true);
    expect(satisfiesPluginApi('>= 1.1', '1.0.9')).toBe(false);
  });

  it('精确与省略段', () => {
    expect(satisfiesPluginApi('1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesPluginApi('=1.0.0', '1.0.1')).toBe(false);
    expect(satisfiesPluginApi('1.0', '1.0.7')).toBe(true);
    expect(satisfiesPluginApi('1', '1.4.0')).toBe(true);
    expect(satisfiesPluginApi('1', '2.0.0')).toBe(false);
  });

  it('默认对照宿主 PLUGIN_API_VERSION', () => {
    expect(satisfiesPluginApi(`^${PLUGIN_API_VERSION}`)).toBe(true);
  });

  it('认不出的范围或版本保守拒绝', () => {
    for (const range of ['', '*', 'latest', '^1.0.0-beta', '<2.0.0', '1.x', '^^1', '1.0.0.0']) {
      expect(satisfiesPluginApi(range, '1.0.0')).toBe(false);
    }
    expect(satisfiesPluginApi('^1.0', 'one')).toBe(false);
  });
});
