import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearAllData,
  commitStoryTurnMemory,
  deleteSaveSlot,
  exportAllData,
  getDatabase,
  getStoryArchives,
  getStoryTurnSummaries,
  importAllData,
  initializeDatabase,
  pruneOrphanStoryContextRecords,
  saveMessages,
  saveSaveSlot,
  getMessages,
  getStoryArchiveRetries,
  queueStoryArchiveRetries,
  commitStoryArchiveRetry,
} from '../../../src/core/persistence/database';
import { exportSessionSave, importSessionSave } from '../../../src/core/persistence/session-backup';
import {
  collectCompleteStoryTurns,
  resolveActiveStoryArchives,
} from '../../../src/core/memory/memory-context';
import {
  storyTurnSource,
  storySegmentFingerprint,
} from '../../../src/core/memory/story-memory-source';
import { withSaveWriteLock } from '../../../src/core/state/state-write-queue';
import type {
  SaveSlot,
  StoryArchiveRecord,
  StoryTurnSummaryRecord,
  StoryArchiveRetryRecord,
} from '../../../src/core/types/types';

function makeSave(id: string): SaveSlot {
  return {
    id,
    name: id,
    slot: 0,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      characterName: '甲',
      userName: '玩家',
      gameStartTime: '',
      totalTurns: 2,
      storyContextV2: { schema: 1, markedAt: 1 },
    },
  };
}
function turnMessages(saveId: string, turnKey: string, turn: number) {
  return [
    { id: turnKey, role: 'user' as const, content: '输入', timestamp: turn * 2, saveId, turn },
    {
      id: `${turnKey}-a`,
      role: 'assistant' as const,
      content: '正文',
      timestamp: turn * 2 + 1,
      saveId,
      turn,
    },
  ];
}
function record(saveId: string, key: string, content: string, order = 0): StoryTurnSummaryRecord {
  return {
    id: `${saveId}-${key}-${order}-${content}`,
    saveId,
    ...storyTurnSource(collectCompleteStoryTurns(turnMessages(saveId, key, 1))[0]),
    order,
    content,
    eventName: '送信',
    createdAt: 1,
  };
}
function archive(
  key: string,
  covered: StoryTurnSummaryRecord[],
  saveId = 's1',
): StoryArchiveRecord {
  return {
    id: `${saveId}-${key}-archive`,
    saveId,
    eventName: '送信',
    outcome: 'completed',
    evidence: '正文',
    overview: '送信已了结',
    detail: { cause: '', process: '', ending: '', promises: '', impact: '' },
    detailSource: 'source-text',
    coveredSegmentIds: covered.map((s) => s.id),
    coveredSources: [
      ...new Map(
        covered.map((s) => [
          s.sourceTurnKey,
          {
            sourceTurnKey: s.sourceTurnKey,
            sourceMessageIds: s.sourceMessageIds,
            sourceFingerprint: s.sourceFingerprint,
          },
        ]),
      ).values(),
    ],
    coveredSegmentFingerprints: Object.fromEntries(
      covered.map((s) => [s.id, storySegmentFingerprint(s)]),
    ),
    ...storyTurnSource(collectCompleteStoryTurns(turnMessages(saveId, key, 1))[0]),
    sequence: 0,
    createdAt: 1,
  };
}
function retry(draft: StoryTurnSummaryRecord[], arc: StoryArchiveRecord): StoryArchiveRetryRecord {
  return {
    id: 'retry',
    saveId: arc.saveId,
    sourceTurnKey: arc.sourceTurnKey,
    sourceMessageIds: arc.sourceMessageIds,
    sourceFingerprint: arc.sourceFingerprint,
    rawOutput: '{"archives":[]}',
    archives: [arc],
    summaries: draft,
    coveredSegmentIds: arc.coveredSegmentIds,
    coveredSources: arc.coveredSources!,
    coveredSegmentFingerprints: arc.coveredSegmentFingerprints!,
    createdAt: 1,
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  await clearAllData();
  await initializeDatabase();
  await saveSaveSlot(makeSave('s1'));
  await saveMessages([...turnMessages('s1', 'u1', 1), ...turnMessages('s1', 'u2', 2)]);
});

describe('atomic source validation / A02 A07 A08', () => {
  it('同来源整体替换不叠加，后续覆盖归档保留失效原因而不猜新片段映射', async () => {
    const first = record('s1', 'u1', '出发');
    const ending = record('s1', 'u2', '交付');
    await commitStoryTurnMemory('s1', 'u1', [first], []);
    await commitStoryTurnMemory('s1', 'u2', [ending], [archive('u2', [first, ending])]);
    const next = record('s1', 'u1', '重写');
    expect(await commitStoryTurnMemory('s1', 'u1', [next], [])).toBe(true);
    const rows = await getStoryTurnSummaries('s1');
    expect(rows.map((r) => r.content).sort()).toEqual(['交付', '重写']);
    const archives = await getStoryArchives('s1');
    expect(archives[0].invalidatedReason).toBe('summary-replaced');
    expect(archives[0].coveredSegmentIds).toContain(first.id);
    expect(resolveActiveStoryArchives(await getMessages('s1'), archives, rows)).toEqual([]);
  });

  it('同判断回合补建也保留旧归档/重试失效诊断', async () => {
    const row = record('s1', 'u1', '原摘要'),
      arc = archive('u1', [row]);
    const pending = retry([row], arc);
    await commitStoryTurnMemory('s1', 'u1', [row], [arc], { retries: [pending] });
    await commitStoryTurnMemory('s1', 'u1', [record('s1', 'u1', '补建摘要')], []);
    expect((await getStoryArchives('s1'))[0].invalidatedReason).toBe('summary-replaced');
    expect((await getStoryArchiveRetries('s1'))[0].invalidatedReason).toBe('summary-replaced');
  });

  it('同ID摘要修订同样使依赖归档失效', async () => {
    const first = record('s1', 'u1', '出发');
    const ending = record('s1', 'u2', '交付');
    await commitStoryTurnMemory('s1', 'u1', [first], []);
    await commitStoryTurnMemory('s1', 'u2', [ending], [archive('u2', [first, ending])]);
    await commitStoryTurnMemory('s1', 'u1', [{ ...first, content: '放弃' }], []);
    expect((await getStoryArchives('s1'))[0].invalidatedReason).toBe('summary-replaced');
  });

  it('摘要与归档原子生效；模拟bulkPut失败整体回滚，含覆盖失效标记', async () => {
    const first = record('s1', 'u1', '出发'),
      ending = record('s1', 'u2', '交付');
    const arc = archive('u2', [first, ending]);
    await commitStoryTurnMemory('s1', 'u1', [first], []);
    await commitStoryTurnMemory('s1', 'u2', [ending], [arc]);
    const next = record('s1', 'u1', '重写');
    const spy = vi
      .spyOn(getDatabase().storyArchives, 'bulkPut')
      .mockRejectedValueOnce(new Error('simulated write failure'));
    await expect(
      commitStoryTurnMemory('s1', 'u1', [next], [archive('u1', [next])]),
    ).rejects.toThrow('simulated write failure');
    spy.mockRestore();
    expect((await getStoryTurnSummaries('s1')).map((r) => r.id).sort()).toEqual(
      [first.id, ending.id].sort(),
    );
    expect(await getStoryArchives('s1')).toEqual([arc]);
  });

  it('记录参数不一致明确抛错；来源集合/指纹缺失拒绝且不改旧记录', async () => {
    const row = record('s1', 'u1', '旧');
    await commitStoryTurnMemory('s1', 'u1', [row], []);
    await expect(
      commitStoryTurnMemory('s1', 'u1', [{ ...row, saveId: 's2' }], []),
    ).rejects.toThrow();
    for (const invalid of [
      { ...row, sourceFingerprint: undefined },
      { ...row, sourceMessageIds: ['u1'] },
      { ...row, sourceMessageIds: ['u1', 'ghost'] },
    ])
      expect(await commitStoryTurnMemory('s1', 'u1', [invalid], [])).toBe(false);
    expect(await getStoryTurnSummaries('s1')).toEqual([row]);
  });

  it.each(['delete', 'rollback', 'replace-id', 'same-id-edit', 'cancel'] as const)(
    '排队期间%s后旧提交不能写回',
    async (mode) => {
      const gate = deferred(),
        entered = deferred();
      let current = true;
      const row = record('s1', 'u1', '迟到');
      const held = withSaveWriteLock('s1', async () => {
        entered.resolve();
        await gate.promise;
        const db = getDatabase();
        if (mode === 'delete') await deleteSaveSlot('s1');
        if (mode === 'rollback') {
          await db.messages.clear();
          await pruneOrphanStoryContextRecords('s1');
        }
        if (mode === 'replace-id') {
          await db.messages.delete('u1-a');
          await saveMessages([{ ...turnMessages('s1', 'u1', 1)[1], id: 'new-assistant' }]);
        }
        if (mode === 'same-id-edit') await db.messages.update('u1-a', { content: '不同正文' });
        if (mode === 'cancel') current = false;
      });
      await entered.promise;
      const work = commitStoryTurnMemory('s1', 'u1', [row], [archive('u1', [row])], {
        isCurrent: () => current,
      });
      gate.resolve();
      await held;
      expect(await work).toBe(false);
      expect(await getStoryTurnSummaries('s1')).toEqual([]);
      expect(await getStoryArchives('s1')).toEqual([]);
    },
  );

  it('取消发生于事务最后一次写入也回滚摘要和归档', async () => {
    const db = getDatabase(),
      row = record('s1', 'u1', '取消');
    let current = true;
    const put = db.storyArchives.bulkPut.bind(db.storyArchives);
    const spy = vi.spyOn(db.storyArchives, 'bulkPut').mockImplementation((...args) =>
      put(...args).then((result) => {
        current = false;
        return result;
      }),
    );
    expect(
      await commitStoryTurnMemory('s1', 'u1', [row], [archive('u1', [row])], {
        isCurrent: () => current,
      }),
    ).toBe(false);
    spy.mockRestore();
    expect(await getStoryTurnSummaries('s1')).toEqual([]);
    expect(await getStoryArchives('s1')).toEqual([]);
  });

  it('普通档不接纳v2记忆；归档缺覆盖或陈旧覆盖指纹拒绝', async () => {
    const save = makeSave('s1');
    delete save.metadata.storyContextV2;
    await saveSaveSlot(save);
    const row = record('s1', 'u1', '摘要');
    expect(await commitStoryTurnMemory('s1', 'u1', [row], [])).toBe(false);
    await saveSaveSlot(makeSave('s1'));
    const arc = archive('u1', [row]);
    expect(
      await commitStoryTurnMemory('s1', 'u1', [row], [{ ...arc, coveredSegmentIds: ['ghost'] }]),
    ).toBe(false);
    expect(await commitStoryTurnMemory('s1', 'u1', [{ ...row, content: '新摘要' }], [arc])).toBe(
      false,
    );
  });
});

describe('R01 original-turn retry lifecycle', () => {
  it('整次提交失败草稿可持久化，prune不误判未落库草稿，之后回合结束仍按原回合重试', async () => {
    const first = record('s1', 'u1', '出发'),
      ending = record('s1', 'u2', '交付');
    await commitStoryTurnMemory('s1', 'u1', [first], []);
    const arc = archive('u2', [first, ending]);
    const pending = retry([ending], arc);
    expect(await queueStoryArchiveRetries('s1', [pending])).toBe(true);
    await pruneOrphanStoryContextRecords('s1');
    expect((await getStoryArchiveRetries('s1'))[0].invalidatedReason).toBeUndefined();
    await saveMessages(turnMessages('s1', 'u3', 3));
    expect(
      await commitStoryArchiveRetry('s1', pending.id, [
        { ...arc, detail: { ...arc.detail, ending: '原回合交付' } },
      ]),
    ).toBe(true);
    expect(await getStoryArchiveRetries('s1')).toEqual([]);
    expect((await getStoryArchives('s1'))[0].sourceTurnKey).toBe('u2');
    expect((await getStoryTurnSummaries('s1')).map((s) => s.id).sort()).toEqual(
      [first.id, ending.id].sort(),
    );
  });

  it('重试写失败保留原草稿，成功后删除；取消不消费待重试行', async () => {
    const row = record('s1', 'u1', '摘要'),
      arc = archive('u1', [row]),
      pending = retry([row], arc);
    await queueStoryArchiveRetries('s1', [pending]);
    expect(await commitStoryArchiveRetry('s1', pending.id, [arc], { isCurrent: () => false })).toBe(
      false,
    );
    const spy = vi
      .spyOn(getDatabase().storyArchives, 'bulkPut')
      .mockRejectedValueOnce(new Error('retry failed'));
    await expect(commitStoryArchiveRetry('s1', pending.id, [arc])).rejects.toThrow('retry failed');
    spy.mockRestore();
    expect(await getStoryArchiveRetries('s1')).toEqual([pending]);
    expect(await getStoryTurnSummaries('s1')).toEqual([]);
    expect(await commitStoryArchiveRetry('s1', pending.id, [arc])).toBe(true);
    expect(await getStoryArchiveRetries('s1')).toEqual([]);
  });

  it('跨回合替换使待重试归档失效且可诊断，不能吞掉后来重写', async () => {
    const first = record('s1', 'u1', '出发'),
      ending = record('s1', 'u2', '交付');
    await commitStoryTurnMemory('s1', 'u1', [first], []);
    const arc = archive('u2', [first, ending]),
      pending = retry([ending], arc);
    await queueStoryArchiveRetries('s1', [pending]);
    await commitStoryTurnMemory('s1', 'u1', [record('s1', 'u1', '改变经过')], []);
    expect((await getStoryArchiveRetries('s1'))[0].invalidatedReason).toBe('summary-replaced');
    expect(await commitStoryArchiveRetry('s1', pending.id, [arc])).toBe(false);
  });
});

describe('prune and backups', () => {
  it('回退清除未来摘要/归档/重试；同ID改正文亦清理', async () => {
    const first = record('s1', 'u1', '保留'),
      ending = record('s1', 'u2', '结局'),
      arc = archive('u2', [first, ending]);
    await commitStoryTurnMemory('s1', 'u1', [first], []);
    await commitStoryTurnMemory('s1', 'u2', [ending], [arc], { retries: [retry([ending], arc)] });
    await getDatabase().messages.bulkDelete(['u2', 'u2-a']);
    expect(await pruneOrphanStoryContextRecords('s1')).toBe(3);
    expect(await getStoryTurnSummaries('s1')).toEqual([first]);
    await getDatabase().messages.update('u1-a', { content: '修订正文' });
    expect(await pruneOrphanStoryContextRecords('s1')).toBe(1);
  });

  it('删档级联删除摘要/归档/重试，另档保留', async () => {
    const row = record('s1', 'u1', '摘要'),
      arc = archive('u1', [row]);
    await commitStoryTurnMemory('s1', 'u1', [row], [arc], { retries: [retry([row], arc)] });
    await saveSaveSlot(makeSave('s2'));
    await saveMessages(turnMessages('s2', 'v1', 1));
    await commitStoryTurnMemory('s2', 'v1', [record('s2', 'v1', '另档')], []);
    await deleteSaveSlot('s1');
    expect(await getStoryTurnSummaries('s1')).toEqual([]);
    expect(await getStoryArchives('s1')).toEqual([]);
    expect(await getStoryArchiveRetries('s1')).toEqual([]);
    expect(await getStoryTurnSummaries('s2')).toHaveLength(1);
  });

  it('整库备份完整保留原来源/覆盖指纹和待重试生命周期；旧备份缺重试表清空', async () => {
    const row = record('s1', 'u1', '摘要'),
      arc = archive('u1', [row]),
      pending = retry([row], arc);
    await commitStoryTurnMemory('s1', 'u1', [row], [arc], { retries: [pending] });
    const backup = await exportAllData();
    await clearAllData();
    await importAllData(backup);
    expect(await getStoryTurnSummaries('s1')).toEqual([row]);
    expect(await getStoryArchives('s1')).toEqual([arc]);
    expect(await getStoryArchiveRetries('s1')).toEqual([pending]);
    expect(
      resolveActiveStoryArchives(
        await getMessages('s1'),
        await getStoryArchives('s1'),
        await getStoryTurnSummaries('s1'),
      ),
    ).toHaveLength(1);
    delete backup.storyArchiveRetries;
    await importAllData(backup);
    expect(await getStoryArchiveRetries('s1')).toEqual([]);
  });

  it('重复单档导入来源/覆盖ID独立，fingerprint不依赖ID并保留', async () => {
    const first = record('s1', 'u1', '出发'),
      ending = record('s1', 'u2', '结局'),
      arc = archive('u2', [first, ending]);
    await commitStoryTurnMemory('s1', 'u1', [first], []);
    await commitStoryTurnMemory('s1', 'u2', [ending], [arc]);
    // Invalid imported legacy source is deliberately seeded, not accepted by commit.
    await getDatabase().storyTurnSummaries.put({
      ...first,
      id: 'invalid',
      sourceMessageIds: ['u1', 'ghost'],
    });
    const backup = await exportSessionSave('s1');
    const one = await importSessionSave(backup),
      two = await importSessionSave(backup);
    expect(one.saveId).not.toBe(two.saveId);
    for (const { saveId } of [one, two]) {
      const rows = await getStoryTurnSummaries(saveId),
        arcs = await getStoryArchives(saveId),
        msgs = await getMessages(saveId);
      expect(rows).toHaveLength(2);
      expect(resolveActiveStoryArchives(msgs, arcs, rows)).toHaveLength(1);
      expect(rows.map((r) => r.sourceFingerprint)).toEqual([
        first.sourceFingerprint,
        ending.sourceFingerprint,
      ]);
      expect((await getDatabase().saves.get(saveId))!.metadata.storyContextV2).toBeDefined();
    }
  });
});
