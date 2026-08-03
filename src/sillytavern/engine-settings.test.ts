/**
 * engine-settings 专项测试（Q-06）
 *
 * 这个缝的全部价值是「引擎读到的就是用户真正选的那份」。所以断的是三件事：
 *   1. 注册后确实读到 provider 的值（旧实现的影子配置永远读不到）
 *   2. 没注册 / provider 只给一半 → 回到缺省，不是 undefined
 *   3. provider 抛异常不把写库路径带崩，但**必须留下痕迹**（旧桥是静默 warn，
 *      那正是断了没人发现的原因）
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getEngineSettings, setEngineSettingsProvider } from './engine-settings';
import { DEFAULT_SETTINGS } from './types';

afterEach(() => {
  setEngineSettingsProvider(undefined);
  vi.restoreAllMocks();
});

describe('getEngineSettings', () => {
  it('没注册 provider → 缺省值（与注册前的行为一致，不是新的降级路径）', () => {
    expect(getEngineSettings()).toEqual({
      maxSnapshotsPerSave: DEFAULT_SETTINGS.maxSnapshotsPerSave,
      snapshotRetentionMode: DEFAULT_SETTINGS.snapshotRetentionMode,
    });
  });

  it('注册后读到的是 provider 的值', () => {
    setEngineSettingsProvider(() => ({
      maxSnapshotsPerSave: 7,
      snapshotRetentionMode: 'dense',
    }));
    expect(getEngineSettings()).toEqual({
      maxSnapshotsPerSave: 7,
      snapshotRetentionMode: 'dense',
    });
  });

  it('每次调用都重新问 provider —— 设置页改完不必重启', () => {
    let limit = 10;
    setEngineSettingsProvider(() => ({ maxSnapshotsPerSave: limit }));
    expect(getEngineSettings().maxSnapshotsPerSave).toBe(10);
    limit = 99;
    expect(getEngineSettings().maxSnapshotsPerSave).toBe(99);
  });

  it('provider 只给一部分字段 → 其余走缺省', () => {
    setEngineSettingsProvider(() => ({ snapshotRetentionMode: 'dense' }));
    expect(getEngineSettings()).toEqual({
      maxSnapshotsPerSave: DEFAULT_SETTINGS.maxSnapshotsPerSave,
      snapshotRetentionMode: 'dense',
    });
  });

  it('provider 返回 undefined 也不炸', () => {
    setEngineSettingsProvider(() => undefined);
    expect(getEngineSettings().maxSnapshotsPerSave).toBe(DEFAULT_SETTINGS.maxSnapshotsPerSave);
  });

  it('provider 抛异常 → 按缺省继续，但打 error 留痕（不是静默 warn）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setEngineSettingsProvider(() => {
      throw new Error('store 还没就绪');
    });
    expect(getEngineSettings().maxSnapshotsPerSave).toBe(DEFAULT_SETTINGS.maxSnapshotsPerSave);
    expect(spy).toHaveBeenCalled();
  });

  it('撤销注册后回到缺省', () => {
    setEngineSettingsProvider(() => ({ maxSnapshotsPerSave: 3 }));
    expect(getEngineSettings().maxSnapshotsPerSave).toBe(3);
    setEngineSettingsProvider(undefined);
    expect(getEngineSettings().maxSnapshotsPerSave).toBe(DEFAULT_SETTINGS.maxSnapshotsPerSave);
  });
});
