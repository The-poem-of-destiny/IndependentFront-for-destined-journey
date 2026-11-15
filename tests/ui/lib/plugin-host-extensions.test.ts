/**
 * plugin-host-extensions —— P2 宿主扩展方法（设计 §5.6、§5.7、§5.8）
 *
 * 钉住：每个方法的正常路径、无存档 NO_SAVE、写入许可拒绝、落库函数 QUOTA / INVALID 原样透传、
 * 可见告知另落 plugin_note 通知条、外链只交弹窗且拒绝一切危险地址。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPluginAiExtension,
  createPluginExternalLinkExtension,
  createPluginStorageExtension,
  type PluginAiExtensionDeps,
  type PluginStorageExtensionDeps,
} from '../../../src/ui/lib/plugin-host-extensions';
import type { PluginHostCallContext } from '../../../src/ui/lib/plugin-bridge';
import type { PluginManifest, PluginResult } from '../../../src/core/types/types-plugin';

const H = 'https' + ':' + '//';

const manifest: PluginManifest = {
  manifestVersion: 1,
  id: 'shop.demo',
  name: '杂货铺',
  version: '1.0.0',
  pluginApi: '^1.0',
  contributions: [],
  network: [],
  capabilities: {
    read: [],
    commands: [],
    events: [],
    ai: ['note', 'context'],
    storage: ['save', 'global'],
  },
};

function makeCtx(over: Partial<PluginHostCallContext> = {}): PluginHostCallContext {
  return {
    pluginId: 'shop.demo',
    manifest,
    saveId: 'save-1',
    guard: () => 'ok',
    canWrite: () => ({ ok: true }),
    afterWrite: vi.fn(async () => {}),
    ...over,
  };
}

const quota: PluginResult = { ok: false, code: 'QUOTA', message: '超出配额' };
const invalid: PluginResult = { ok: false, code: 'INVALID', message: '坏值' };
const busy: PluginResult = { ok: false, code: 'BUSY', message: '正在生成' };

function storageDeps(over: Partial<PluginStorageExtensionDeps> = {}): PluginStorageExtensionDeps {
  return {
    getSaveBag: vi.fn(async () => ({ gold: 5 })),
    writeSaveKv: vi.fn(async () => ({ ok: true }) as PluginResult),
    kvGet: vi.fn(async () => ({ ok: true, value: 'g' }) as PluginResult<unknown>),
    kvSet: vi.fn(async () => ({ ok: true }) as PluginResult<unknown>),
    kvRemove: vi.fn(async () => ({ ok: true }) as PluginResult<unknown>),
    ...over,
  };
}

function aiDeps(over: Partial<PluginAiExtensionDeps> = {}): PluginAiExtensionDeps {
  return {
    enqueueNote: vi.fn(async () => ({ ok: true }) as PluginResult),
    setContext: vi.fn(async () => ({ ok: true }) as PluginResult),
    currentTurn: () => 7,
    addSystemNotice: vi.fn(),
    ...over,
  };
}

describe('存储扩展：storage.save.*', () => {
  it('get 从本存档那一格读出键值，缺键返回 undefined', async () => {
    const deps = storageDeps();
    const m = createPluginStorageExtension(deps).methods;
    const ctx = makeCtx();
    expect(await m['storage.save.get']!(ctx, ['gold'])).toEqual({ ok: true, value: 5 });
    expect(await m['storage.save.get']!(ctx, ['missing'])).toEqual({ ok: true, value: undefined });
    expect(deps.getSaveBag).toHaveBeenCalledWith('save-1', 'shop.demo');
  });

  it('set / remove 交给窄写入口并带上 guard，成功后补快照', async () => {
    const deps = storageDeps();
    const m = createPluginStorageExtension(deps).methods;
    const ctx = makeCtx();
    expect(await m['storage.save.set']!(ctx, ['gold', { n: 1 }])).toEqual({ ok: true });
    expect(deps.writeSaveKv).toHaveBeenCalledWith(
      'save-1',
      'shop.demo',
      { set: ['gold', { n: 1 }] },
      ctx.guard,
    );
    expect(await m['storage.save.remove']!(ctx, ['gold'])).toEqual({ ok: true });
    expect(deps.writeSaveKv).toHaveBeenLastCalledWith(
      'save-1',
      'shop.demo',
      { remove: 'gold' },
      ctx.guard,
    );
    expect(ctx.afterWrite).toHaveBeenCalledTimes(2);
  });

  it('没有存档时三个方法都返回 NO_SAVE，不碰落库', async () => {
    const deps = storageDeps();
    const m = createPluginStorageExtension(deps).methods;
    const ctx = makeCtx({ saveId: null });
    for (const [method, args] of [
      ['storage.save.get', ['k']],
      ['storage.save.set', ['k', 1]],
      ['storage.save.remove', ['k']],
    ] as const) {
      const r = await m[method]!(ctx, [...args]);
      expect(r).toMatchObject({ ok: false, code: 'NO_SAVE' });
    }
    expect(deps.getSaveBag).not.toHaveBeenCalled();
    expect(deps.writeSaveKv).not.toHaveBeenCalled();
  });

  it('canWrite 拒绝时原样返回其结果，不写库', async () => {
    const deps = storageDeps();
    const m = createPluginStorageExtension(deps).methods;
    const ctx = makeCtx({ canWrite: () => busy });
    expect(await m['storage.save.set']!(ctx, ['k', 1])).toEqual(busy);
    expect(await m['storage.save.remove']!(ctx, ['k'])).toEqual(busy);
    expect(deps.writeSaveKv).not.toHaveBeenCalled();
    expect(ctx.afterWrite).not.toHaveBeenCalled();
  });

  it('落库返回的 QUOTA / INVALID 原样透传，且不补快照', async () => {
    const ctx = makeCtx();
    const q = createPluginStorageExtension(storageDeps({ writeSaveKv: async () => quota })).methods;
    expect(await q['storage.save.set']!(ctx, ['k', 1])).toEqual(quota);
    const i = createPluginStorageExtension(
      storageDeps({ writeSaveKv: async () => invalid }),
    ).methods;
    expect(await i['storage.save.remove']!(ctx, ['k'])).toEqual(invalid);
    expect(ctx.afterWrite).not.toHaveBeenCalled();
  });

  it('键与值的形状不对时返回 INVALID', async () => {
    const deps = storageDeps();
    const m = createPluginStorageExtension(deps).methods;
    const ctx = makeCtx();
    for (const key of [42, '', 'x'.repeat(257), '__proto__']) {
      expect(await m['storage.save.get']!(ctx, [key])).toMatchObject({ code: 'INVALID' });
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [undefined, () => 1, cyclic, Number.NaN, { n: Infinity }, 10n]) {
      expect(await m['storage.save.set']!(ctx, ['k', value])).toMatchObject({ code: 'INVALID' });
    }
    expect(deps.writeSaveKv).not.toHaveBeenCalled();
  });
});

describe('存储扩展：storage.global.*', () => {
  it('get / set / remove 走 pluginKv，不需要存档也不看写入许可', async () => {
    const deps = storageDeps();
    const m = createPluginStorageExtension(deps).methods;
    const ctx = makeCtx({ saveId: null, canWrite: () => busy });
    expect(await m['storage.global.get']!(ctx, ['k'])).toEqual({ ok: true, value: 'g' });
    expect(await m['storage.global.set']!(ctx, ['k', [1, 2]])).toEqual({ ok: true });
    expect(await m['storage.global.remove']!(ctx, ['k'])).toEqual({ ok: true });
    expect(deps.kvGet).toHaveBeenCalledWith('shop.demo', 'k');
    expect(deps.kvSet).toHaveBeenCalledWith('shop.demo', 'k', [1, 2]);
    expect(deps.kvRemove).toHaveBeenCalledWith('shop.demo', 'k');
  });

  it('QUOTA 原样透传，坏键与坏值返回 INVALID', async () => {
    const deps = storageDeps({ kvSet: async () => quota });
    const m = createPluginStorageExtension(deps).methods;
    const ctx = makeCtx();
    expect(await m['storage.global.set']!(ctx, ['k', 1])).toEqual(quota);
    expect(await m['storage.global.get']!(ctx, [''])).toMatchObject({ code: 'INVALID' });
    expect(await m['storage.global.set']!(ctx, ['k', undefined])).toMatchObject({
      code: 'INVALID',
    });
  });
});

describe('AI 扩展：ai.note', () => {
  it('入队时带上插件名与当前已完成回合号，成功后补快照', async () => {
    const deps = aiDeps();
    const m = createPluginAiExtension(deps).methods;
    const ctx = makeCtx();
    expect(await m['ai.note']!(ctx, ['商人补货了'])).toEqual({ ok: true });
    expect(deps.enqueueNote).toHaveBeenCalledWith(
      'save-1',
      'shop.demo',
      '杂货铺',
      '商人补货了',
      { turn: 7 },
      ctx.guard,
    );
    expect(deps.addSystemNotice).not.toHaveBeenCalled();
    expect(ctx.afterWrite).toHaveBeenCalledTimes(1);
  });

  it('visible 为真时另落一条 plugin_note 通知条', async () => {
    const deps = aiDeps();
    const m = createPluginAiExtension(deps).methods;
    expect(await m['ai.note']!(makeCtx(), ['商人补货了', { visible: true }])).toEqual({ ok: true });
    expect(deps.enqueueNote).toHaveBeenCalledWith(
      'save-1',
      'shop.demo',
      '杂货铺',
      '商人补货了',
      { turn: 7, visible: true },
      expect.any(Function),
    );
    expect(deps.addSystemNotice).toHaveBeenCalledWith({
      type: 'plugin_note',
      pluginId: 'shop.demo',
      pluginName: '杂货铺',
      text: '商人补货了',
      narrative: '杂货铺：商人补货了',
    });
  });

  it('入队失败时不落通知条，QUOTA / INVALID 原样透传', async () => {
    const deps = aiDeps({ enqueueNote: async () => quota });
    const m = createPluginAiExtension(deps).methods;
    expect(await m['ai.note']!(makeCtx(), ['x', { visible: true }])).toEqual(quota);
    expect(deps.addSystemNotice).not.toHaveBeenCalled();
    const i = createPluginAiExtension(aiDeps({ enqueueNote: async () => invalid })).methods;
    expect(await i['ai.note']!(makeCtx(), ['x'])).toEqual(invalid);
  });

  it('无存档返回 NO_SAVE，写入许可拒绝时原样返回', async () => {
    const deps = aiDeps();
    const m = createPluginAiExtension(deps).methods;
    expect(await m['ai.note']!(makeCtx({ saveId: null }), ['x'])).toMatchObject({
      code: 'NO_SAVE',
    });
    expect(await m['ai.note']!(makeCtx({ canWrite: () => busy }), ['x'])).toEqual(busy);
    expect(deps.enqueueNote).not.toHaveBeenCalled();
  });

  it('正文不是字符串、选项不是对象、visible 不是布尔时返回 INVALID', async () => {
    const deps = aiDeps();
    const m = createPluginAiExtension(deps).methods;
    const ctx = makeCtx();
    expect(await m['ai.note']!(ctx, [1])).toMatchObject({ code: 'INVALID' });
    expect(await m['ai.note']!(ctx, ['x', 'visible'])).toMatchObject({ code: 'INVALID' });
    expect(await m['ai.note']!(ctx, ['x', { visible: 'yes' }])).toMatchObject({
      code: 'INVALID',
    });
    expect(deps.enqueueNote).not.toHaveBeenCalled();
  });
});

describe('AI 扩展：ai.context.set', () => {
  it('设置与清除（null）都交给落库函数并带 guard', async () => {
    const deps = aiDeps();
    const m = createPluginAiExtension(deps).methods;
    const ctx = makeCtx();
    expect(await m['ai.context.set']!(ctx, ['常驻提示'])).toEqual({ ok: true });
    expect(await m['ai.context.set']!(ctx, [null])).toEqual({ ok: true });
    expect(deps.setContext).toHaveBeenNthCalledWith(
      1,
      'save-1',
      'shop.demo',
      '常驻提示',
      ctx.guard,
    );
    expect(deps.setContext).toHaveBeenNthCalledWith(2, 'save-1', 'shop.demo', null, ctx.guard);
    expect(ctx.afterWrite).toHaveBeenCalledTimes(2);
  });

  it('NO_SAVE、写入许可拒绝、QUOTA 透传、坏参数 INVALID', async () => {
    const m = createPluginAiExtension(aiDeps({ setContext: async () => quota })).methods;
    expect(await m['ai.context.set']!(makeCtx({ saveId: null }), ['x'])).toMatchObject({
      code: 'NO_SAVE',
    });
    expect(await m['ai.context.set']!(makeCtx({ canWrite: () => busy }), ['x'])).toEqual(busy);
    expect(await m['ai.context.set']!(makeCtx(), ['x'])).toEqual(quota);
    expect(await m['ai.context.set']!(makeCtx(), [3])).toMatchObject({ code: 'INVALID' });
    expect(await m['ai.context.set']!(makeCtx(), [])).toMatchObject({ code: 'INVALID' });
  });
});

describe('外链扩展：ui.openExternal', () => {
  it('合格地址交给弹窗（带插件名），不打开任何东西', async () => {
    const show = vi.fn();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const m = createPluginExternalLinkExtension({ showExternalLink: show }).methods;
    expect(await m['ui.openExternal']!(makeCtx(), [H + 'docs.example.com/a'])).toEqual({
      ok: true,
    });
    expect(show).toHaveBeenCalledWith('杂货铺', H + 'docs.example.com/a');
    expect(open).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('拒绝 http、IP、localhost、端口、用户信息、javascript、data，弹窗不出现', async () => {
    const show = vi.fn();
    const m = createPluginExternalLinkExtension({ showExternalLink: show }).methods;
    const bad = [
      'http' + ':' + '//example.com/',
      H + '192.168.1.1/',
      H + 'localhost/',
      H + 'example.com:8188/',
      H + 'user:pw@example.com/',
      'javascript' + ':alert(1)',
      'data' + ':text/html,x',
      42,
    ];
    for (const url of bad) {
      const r = await m['ui.openExternal']!(makeCtx(), [url]);
      expect(r).toMatchObject({ ok: false, code: 'INVALID' });
    }
    expect(show).not.toHaveBeenCalled();
  });
});
