import { describe, expect, it } from 'vitest';
import {
  checkPackUpdate,
  downloadLatestPack,
  isPackUpdateAvailable,
  type PackUpdaterFetch,
} from '../../../src/ui/lib/content-pack-updater';

function jsonRes(body: unknown, status = 200, headers?: Record<string, string>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => headers?.[name] ?? null },
  };
}

describe('isPackUpdateAvailable', () => {
  it('未装包 → 可安装', () => {
    expect(isPackUpdateAvailable('1.0.0', null)).toBe(true);
    expect(isPackUpdateAvailable('1.0.0', '')).toBe(true);
  });
  it('同版本 → 无更新；新版 → 有更新；旧版 → 无', () => {
    expect(isPackUpdateAvailable('1.0.0', '1.0.0')).toBe(false);
    expect(isPackUpdateAvailable('1.2.0', '1.1.0')).toBe(true);
    expect(isPackUpdateAvailable('1.0.0', '1.1.0')).toBe(false);
  });
  it('无最新版本信息 → 无更新', () => {
    expect(isPackUpdateAvailable(null, '1.0.0')).toBe(false);
  });
});

describe('checkPackUpdate', () => {
  it('有新版 → updateAvailable true', async () => {
    const fetchImpl: PackUpdaterFetch = async () =>
      jsonRes({ ok: true, available: true, tag: 'v2', packVersion: '2.0.0' });
    const r = await checkPackUpdate('1.0.0', fetchImpl);
    expect(r).toEqual({
      status: 'ok',
      info: {
        available: true,
        updateAvailable: true,
        packVersion: '2.0.0',
        tag: 'v2',
      },
    });
  });

  it('同版本 → updateAvailable false', async () => {
    const fetchImpl: PackUpdaterFetch = async () =>
      jsonRes({ ok: true, available: true, tag: 'v1', packVersion: '1.0.0' });
    const r = await checkPackUpdate('1.0.0', fetchImpl);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.info.updateAvailable).toBe(false);
  });

  it('发布源无版本 → available false', async () => {
    const fetchImpl: PackUpdaterFetch = async () => jsonRes({ ok: true, available: false });
    const r = await checkPackUpdate('1.0.0', fetchImpl);
    expect(r).toEqual({
      status: 'ok',
      info: { available: false, updateAvailable: false, packVersion: null, tag: null },
    });
  });

  it('BFF 502 → error 带服务端消息', async () => {
    const fetchImpl: PackUpdaterFetch = async () => jsonRes({ ok: false, error: '限流' }, 502);
    const r = await checkPackUpdate('1.0.0', fetchImpl);
    expect(r).toEqual({ status: 'error', message: '限流' });
  });

  it('网络异常 → error 不抛穿', async () => {
    const fetchImpl: PackUpdaterFetch = async () => {
      throw new Error('boom');
    };
    const r = await checkPackUpdate('1.0.0', fetchImpl);
    expect(r).toEqual({ status: 'error', message: 'boom' });
  });
});

describe('downloadLatestPack', () => {
  it('成功 → 回明文 pack + 版本头', async () => {
    const pack = { formatVersion: 1, packId: 'x', packVersion: '2.0.0' };
    const fetchImpl: PackUpdaterFetch = async () =>
      jsonRes(pack, 200, { 'X-Pack-Version': '2.0.0' });
    const r = await downloadLatestPack(fetchImpl);
    expect(r).toEqual({ status: 'ok', pack, packVersion: '2.0.0' });
  });

  it('404 → error 带消息', async () => {
    const fetchImpl: PackUpdaterFetch = async () =>
      jsonRes({ error: '当前没有可用的内容包发布' }, 404);
    const r = await downloadLatestPack(fetchImpl);
    expect(r).toEqual({ status: 'error', message: '当前没有可用的内容包发布' });
  });
});
