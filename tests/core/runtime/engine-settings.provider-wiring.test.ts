/**
 * `main.ts` 的 provider 接线断言（随机事件系统 v1 / 裁定 §13-4）
 *
 * `engine-settings.test.ts` 测的是**缝本身**（注册 / 缺省 / 现读 / 抛错兜底），
 * 它证明不了有人把 `randomEventsEnabled` / `randomEventsFrequency` 真的供进来 ——
 * 那两格只在 `src/ui/main.ts` 的 provider 里出现一次。
 *
 * 🔴 漏接的症状不是报错：`getEngineSettings()` 会安安静静走缺省值（开 + 1 倍），
 *    于是设置页那两个开关拨了没反应，而测试全绿。故照本仓既有的**源码断言**
 *    先例（placeholder-registry.map-context / .random-events 末尾的供值断言）
 *    直接读 `main.ts` 的源码钉住这条接线。
 */
import { describe, expect, it } from 'vitest';

const UI_SOURCES: Record<string, string> = import.meta.glob('@ui/main.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

describe('EngineSettings provider 接线', () => {
  it('🔴 main.ts 的 provider 真的供了随机事件两格', () => {
    const source = Object.values(UI_SOURCES)[0] ?? '';
    expect(source.length).toBeGreaterThan(0);

    expect(source).toContain('setEngineSettingsProvider(');
    expect(source).toContain('randomEventsEnabled: s.randomEventsEnabled');
    expect(source).toContain('randomEventsFrequency: s.randomEventsFrequency');
  });

  it('🔴 两格读在 provider 回调**里面** —— 提到外面存快照 = 开关永久钉在启动那一刻', () => {
    const source = Object.values(UI_SOURCES)[0] ?? '';
    const providerAt = source.indexOf('setEngineSettingsProvider(');
    expect(providerAt).toBeGreaterThanOrEqual(0);

    expect(source.indexOf('randomEventsEnabled: s.randomEventsEnabled')).toBeGreaterThan(
      providerAt,
    );
    expect(source.indexOf('randomEventsFrequency: s.randomEventsFrequency')).toBeGreaterThan(
      providerAt,
    );
  });
});
