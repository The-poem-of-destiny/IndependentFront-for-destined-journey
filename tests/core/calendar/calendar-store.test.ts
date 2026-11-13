import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  deleteSaveSlot,
  exportAllData,
  getDatabase,
  importAllData,
  initializeDatabase,
  saveCharacter,
  saveSaveSlot,
} from '../../../src/core/persistence/database';
import { exportSessionSave, importSessionSave } from '../../../src/core/persistence/session-backup';
import {
  coerceSaveCalendar,
  getSaveCalendar,
  persistCalendarEntry,
  persistCalendarMode,
  persistCalendarVisibility,
  remapSaveCalendar,
  removeCalendarEntry,
} from '../../../src/core/calendar/calendar-store';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import type { SaveSlot } from '../../../src/core/types/types';

function makeSave(id: string): SaveSlot {
  return {
    id,
    name: id,
    slot: 0,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: { characterName: '甲', userName: '玩家', gameStartTime: '', totalTurns: 0 },
  };
}

beforeEach(async () => {
  await clearAllData();
  await initializeDatabase();
  await saveSaveSlot(makeSave('s1'));
});

describe('每存档日历的存储', () => {
  it('缺行即默认值：普通模式、空条目、无隐藏，且读取不写库', async () => {
    expect(await getSaveCalendar('s1')).toEqual({
      saveId: 's1',
      mode: 'normal',
      entries: [],
      hiddenKinds: [],
      hiddenRegions: [],
      hiddenKeys: [],
      localRegionOnly: false,
      updatedAt: 0,
    });
    expect(await getDatabase().saveCalendars.count()).toBe(0);
  });

  it('切换模式不丢数据；条目可新增、更新、删除', async () => {
    await persistCalendarEntry('s1', { id: 'a', title: ' 约定 ', start: { month: 4, day: 4 } });
    await persistCalendarVisibility('s1', { hiddenKeys: ['birthday:x'] });
    await persistCalendarMode('s1', 'immersive');
    await persistCalendarMode('s1', 'normal');
    let calendar = await getSaveCalendar('s1');
    expect(calendar.mode).toBe('normal');
    expect(calendar.entries.map((e) => e.title)).toEqual(['约定']);
    expect(calendar.hiddenKeys).toEqual(['birthday:x']);

    const createdAt = calendar.entries[0].createdAt;
    await persistCalendarEntry('s1', {
      id: 'a',
      title: '改期',
      start: { month: 4, day: 5 },
      end: { month: 4, day: 7 },
      year: 490,
      note: '带上干粮',
    });
    calendar = await getSaveCalendar('s1');
    expect(calendar.entries).toEqual([
      {
        id: 'a',
        title: '改期',
        start: { month: 4, day: 5 },
        end: { month: 4, day: 7 },
        year: 490,
        note: '带上干粮',
        createdAt,
      },
    ]);
    expect((await removeCalendarEntry('s1', 'a')).entries).toEqual([]);
  });

  it('不合法的条目被拒绝，不写库', async () => {
    expect(() =>
      persistCalendarEntry('s1', { id: 'a', title: '  ', start: { month: 4, day: 4 } }),
    ).toThrow();
    expect(() =>
      persistCalendarEntry('s1', { id: 'a', title: 'x', start: { month: 2, day: 31 } }),
    ).toThrow();
    expect(await getDatabase().saveCalendars.count()).toBe(0);
  });

  it('显示选择只改传进来的项，并做归一化', async () => {
    await persistCalendarVisibility('s1', {
      hiddenKinds: ['birthday', 'user' as never],
      hiddenRegions: ['帝国', '帝国', ''],
    });
    await persistCalendarVisibility('s1', { localRegionOnly: true });
    expect(await getSaveCalendar('s1')).toMatchObject({
      hiddenKinds: ['birthday'],
      hiddenRegions: ['帝国'],
      localRegionOnly: true,
    });
  });

  it('并发写入串行化，互不覆盖', async () => {
    await Promise.all([
      persistCalendarEntry('s1', { id: 'a', title: '甲', start: { month: 1, day: 1 } }),
      persistCalendarEntry('s1', { id: 'b', title: '乙', start: { month: 1, day: 2 } }),
      persistCalendarVisibility('s1', { hiddenKinds: ['festival'] }),
    ]);
    const calendar = await getSaveCalendar('s1');
    expect(calendar.entries.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(calendar.hiddenKinds).toEqual(['festival']);
  });

  it('库里的坏数据回落默认值，不抛', () => {
    expect(
      coerceSaveCalendar('s1', {
        mode: 'weird',
        entries: [{ id: 'ok', title: '好', start: { month: 1, day: 1 } }, { id: 'bad' }, 'x'],
        hiddenKinds: 'festival',
        hiddenKeys: [1, 'k'],
      }),
    ).toMatchObject({
      mode: 'normal',
      entries: [{ id: 'ok', title: '好' }],
      hiddenKinds: [],
      hiddenKeys: ['k'],
    });
  });
});

describe('日历随存档的生命周期', () => {
  it('按存档隔离，删档级联删除', async () => {
    await saveSaveSlot(makeSave('s2'));
    await persistCalendarEntry('s1', { id: 'a', title: '甲', start: { month: 1, day: 1 } });
    await persistCalendarEntry('s2', { id: 'b', title: '乙', start: { month: 1, day: 1 } });
    expect((await getSaveCalendar('s2')).entries.map((e) => e.id)).toEqual(['b']);
    await deleteSaveSlot('s1');
    expect(await getDatabase().saveCalendars.get('s1')).toBeUndefined();
    expect((await getSaveCalendar('s2')).entries).toHaveLength(1);
  });

  it('整库备份往返；旧备份缺这个字段时不动本机日历', async () => {
    await persistCalendarEntry('s1', { id: 'a', title: '甲', start: { month: 1, day: 1 } });
    const backup = await exportAllData();
    expect(backup.saveCalendars).toHaveLength(1);
    await removeCalendarEntry('s1', 'a');
    await importAllData(backup);
    expect((await getSaveCalendar('s1')).entries.map((e) => e.id)).toEqual(['a']);

    const legacy = { ...backup };
    delete legacy.saveCalendars;
    await persistCalendarMode('s1', 'immersive');
    await importAllData(legacy);
    expect((await getSaveCalendar('s1')).mode).toBe('immersive');
  });

  it('单存档导出再导入：条目保留，隐藏的生日键随角色 id 重映射', async () => {
    await saveCharacter(createDefaultCharacterState({ id: 'npc-1', saveId: 's1', name: '向导' }));
    await persistCalendarEntry('s1', { id: 'a', title: '甲', start: { month: 1, day: 1 } });
    await persistCalendarVisibility('s1', {
      hiddenKeys: ['birthday:npc-1', 'birthday:gone', 'fated:faction/x#harvest'],
    });
    await persistCalendarMode('s1', 'immersive');

    const exported = await exportSessionSave('s1');
    const result = await importSessionSave(JSON.parse(JSON.stringify(exported)));
    const db = getDatabase();
    const saves = await db.saves.toArray();
    const imported = saves.find((s) => s.id !== 's1')!;
    expect(result).toBeTruthy();
    const [newChar] = await db.characters.where('saveId').equals(imported.id).toArray();
    const calendar = await getSaveCalendar(imported.id);
    expect(calendar.mode).toBe('immersive');
    expect(calendar.entries.map((e) => e.title)).toEqual(['甲']);
    expect(newChar.id).not.toBe('npc-1');
    expect(calendar.hiddenKeys).toEqual([`birthday:${newChar.id}`, 'fated:faction/x#harvest']);
    // 原存档不受影响
    expect((await getSaveCalendar('s1')).hiddenKeys).toContain('birthday:npc-1');
  });

  it('没有日历行的旧单存档备份照常导入，得到默认日历', async () => {
    const exported = JSON.parse(JSON.stringify(await exportSessionSave('s1')));
    delete exported.saveCalendar;
    await importSessionSave(exported);
    const imported = (await getDatabase().saves.toArray()).find((s) => s.id !== 's1')!;
    expect(await getSaveCalendar(imported.id)).toMatchObject({ mode: 'normal', entries: [] });
    expect(await getDatabase().saveCalendars.count()).toBe(0);
  });

  it('remapSaveCalendar 换存档 id，映射不到的生日键丢弃', () => {
    const remapped = remapSaveCalendar(
      { saveId: 'old', mode: 'normal', hiddenKeys: ['birthday:a', 'birthday:b', 'user:x'] },
      'new',
      (id) => (id === 'a' ? 'A' : undefined),
    );
    expect(remapped.saveId).toBe('new');
    expect(remapped.hiddenKeys).toEqual(['birthday:A', 'user:x']);
  });
});
