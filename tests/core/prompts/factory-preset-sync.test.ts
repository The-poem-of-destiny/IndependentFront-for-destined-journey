/**
 * 出厂预设同步计划（factory-preset-sync）
 *
 * 守的是「出厂更新能落到玩家库里，但旧版 app 就地改过的行先另存副本、绝不静默丢掉」这条契约，
 * 以及指纹只看内容、不看时间戳与指纹字段本身。
 */
import { describe, expect, it } from 'vitest';
import {
  FACTORY_PRESET_BACKUP_SUFFIX,
  factoryPresetFingerprint,
  planFactoryPresetSync,
  stampFactoryPreset,
} from '../../../src/core/prompts/factory-preset-sync';
import type { ChatPreset } from '../../../src/core/types/types';

function preset(id: string, extra: Partial<ChatPreset> = {}): ChatPreset {
  return {
    id,
    name: `预设 ${id}`,
    settings: { prompts: [{ identifier: 'a', content: '甲' }], temp_openai: 1 },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function plan(factory: ChatPreset[], existing: ChatPreset[]) {
  let n = 0;
  return planFactoryPresetSync({
    factory,
    existing,
    scopeOf: () => 'story',
    newId: () => `backup-${++n}`,
    now: 999,
  });
}

describe('factoryPresetFingerprint', () => {
  it('忽略时间戳、指纹字段与键顺序', () => {
    const a = preset('p');
    const b: ChatPreset = {
      updatedAt: 50,
      settings: { temp_openai: 1, prompts: [{ content: '甲', identifier: 'a' }] },
      name: '预设 p',
      id: 'p',
      createdAt: 42,
      factorySeedHash: 'whatever',
    };
    expect(factoryPresetFingerprint(b)).toBe(factoryPresetFingerprint(a));
  });

  it('对 name / description / scope / settings 敏感', () => {
    const base = factoryPresetFingerprint(preset('p'));
    expect(factoryPresetFingerprint(preset('p', { name: '别名' }))).not.toBe(base);
    expect(factoryPresetFingerprint(preset('p', { description: '说明' }))).not.toBe(base);
    expect(factoryPresetFingerprint(preset('p', { scope: 'direct' }))).not.toBe(base);
    expect(
      factoryPresetFingerprint(preset('p', { settings: { prompts: [], temp_openai: 1 } })),
    ).not.toBe(base);
  });

  it('对数组顺序敏感', () => {
    const two = [
      { identifier: 'a', content: '甲' },
      { identifier: 'b', content: '乙' },
    ];
    const a = preset('p', { settings: { prompts: two } });
    const b = preset('p', { settings: { prompts: [...two].reverse() } });
    expect(factoryPresetFingerprint(a)).not.toBe(factoryPresetFingerprint(b));
  });
});

describe('stampFactoryPreset', () => {
  it('盖上内容指纹且不改入参', () => {
    const p = preset('p', { factorySeedHash: 'stale' });
    const stamped = stampFactoryPreset(p);
    expect(stamped.factorySeedHash).toBe(factoryPresetFingerprint(p));
    expect(p.factorySeedHash).toBe('stale');
  });
});

describe('planFactoryPresetSync', () => {
  it('规则 1：库里没有 → 写出厂行并盖指纹', () => {
    const fac = preset('p');
    const result = plan([fac], []);
    expect(result.backups).toEqual([]);
    expect(result.writes).toEqual([{ ...fac, factorySeedHash: factoryPresetFingerprint(fac) }]);
  });

  it('规则 2：内容相同但缺指纹 → 只补指纹，时间戳不动，不留副本', () => {
    const fac = preset('p', { createdAt: 100, updatedAt: 100 });
    const row = preset('p', { createdAt: 5, updatedAt: 7 });
    const result = plan([fac], [row]);
    expect(result.backups).toEqual([]);
    expect(result.writes).toEqual([{ ...row, factorySeedHash: factoryPresetFingerprint(fac) }]);
    expect(result.writes[0]!.createdAt).toBe(5);
    expect(result.writes[0]!.updatedAt).toBe(7);
  });

  it('规则 2：内容相同且指纹已对 → 什么都不写', () => {
    const fac = preset('p');
    const row = stampFactoryPreset(preset('p', { updatedAt: 9 }));
    expect(plan([fac], [row])).toEqual({ writes: [], backups: [] });
  });

  it('规则 3：有指纹且未改、出厂变了 → 静默覆盖并盖新指纹', () => {
    const old = stampFactoryPreset(preset('p', { createdAt: 3 }));
    const fac = preset('p', { settings: { prompts: [{ identifier: 'a', content: '新' }] } });
    const result = plan([fac], [old]);
    expect(result.backups).toEqual([]);
    expect(result.writes).toHaveLength(1);
    const written = result.writes[0]!;
    expect(written.settings).toEqual(fac.settings);
    expect(written.factorySeedHash).toBe(factoryPresetFingerprint(fac));
    expect(written.createdAt).toBe(3);
    expect(written.updatedAt).toBe(999);
  });

  it('规则 3：只有 name 变 → 覆盖，无副本', () => {
    const old = stampFactoryPreset(preset('p'));
    const fac = preset('p', { name: '新名字' });
    const result = plan([fac], [old]);
    expect(result.backups).toEqual([]);
    expect(result.writes.map((w) => w.name)).toEqual(['新名字']);
  });

  it('规则 4：无指纹的遗留行且内容不同 → 先另存副本再覆盖', () => {
    const row = preset('p', { settings: { prompts: [{ identifier: 'a', content: '玩家改的' }] } });
    const fac = preset('p', { settings: { prompts: [{ identifier: 'a', content: '新出厂' }] } });
    const result = plan([fac], [row]);
    expect(result.backups).toEqual([
      {
        factoryId: 'p',
        factoryName: fac.name,
        backupId: 'backup-1',
        backupName: `${row.name}${FACTORY_PRESET_BACKUP_SUFFIX}`,
      },
    ]);
    expect(result.writes).toHaveLength(2);
    const [backup, overwrite] = result.writes;
    expect(backup!.id).toBe('backup-1');
    expect(backup!.name).toBe(`预设 p${FACTORY_PRESET_BACKUP_SUFFIX}`);
    expect('factorySeedHash' in backup!).toBe(false);
    expect(backup!.settings).toEqual(row.settings);
    expect(backup!.description).toBe(row.description);
    expect(backup!.scope).toBe('story');
    expect(backup!.createdAt).toBe(999);
    expect(overwrite!.id).toBe('p');
    expect(overwrite!.settings).toEqual(fac.settings);
    expect(overwrite!.factorySeedHash).toBe(factoryPresetFingerprint(fac));
  });

  it('规则 4：有指纹但内容被就地改过 → 同样先另存副本', () => {
    const stamped = stampFactoryPreset(preset('p'));
    const edited: ChatPreset = { ...stamped, settings: { prompts: [], edited: true } };
    const fac = preset('p', { settings: { prompts: [{ identifier: 'z', content: '新' }] } });
    const result = plan([fac], [edited]);
    expect(result.backups).toHaveLength(1);
    expect(result.writes[0]!.settings).toEqual(edited.settings);
    expect('factorySeedHash' in result.writes[0]!).toBe(false);
    expect(result.writes[1]!.settings).toEqual(fac.settings);
  });

  it('副本 scope 取目录判定；判定为空时副本不带 scope', () => {
    const row = preset('p', { scope: 'story', settings: { prompts: [] } });
    const fac = preset('p');
    const result = planFactoryPresetSync({
      factory: [fac],
      existing: [row],
      scopeOf: () => undefined,
      newId: () => 'b',
      now: 1,
    });
    expect('scope' in result.writes[0]!).toBe(false);
  });

  it('不改入参、同 id 出厂只认第一条', () => {
    const row = preset('p', { settings: { prompts: [] } });
    const snapshot = JSON.parse(JSON.stringify(row));
    const result = plan([preset('p'), preset('p', { name: '第二条' })], [row]);
    expect(row).toEqual(snapshot);
    expect(result.writes.filter((w) => w.id === 'p')).toHaveLength(1);
    expect(result.writes.find((w) => w.id === 'p')!.name).toBe('预设 p');
  });
});
