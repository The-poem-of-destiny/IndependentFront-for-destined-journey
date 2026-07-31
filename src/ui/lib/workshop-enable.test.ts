/**
 * workshop-enable.test.ts — 工坊启用轴纯函数（P1-5）
 *
 * 最重要的两条: ①勾一个项目 = 该项目**全部**条目的 token（D12）
 *               ②三条轴互不干扰 —— system_core / character 的 token 一个字节都不能动
 */
import { describe, it, expect } from 'vitest';
import type { WorkshopProject, WorldBook, WorldBookEntry } from '@engine/types';
import { WORKSHOP_PARTITION, workshopBookId } from '@engine/workshop-types';
import {
  applyWorkshopSelection,
  buildWorkshopEnableOptions,
  isWorkshopProjectEnabled,
  selectedWorkshopProjectIds,
  workshopTokensFor,
  type WorkshopEnableOption,
} from './workshop-enable';

function entry(uid: number, name = `条目${uid}`): WorldBookEntry {
  return {
    uid,
    name,
    content: `内容 ${uid}`,
    enabled: true,
    constant: false,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 100,
    position: 0,
  } as WorldBookEntry;
}

function project(id: string, over: Partial<WorkshopProject> = {}): WorkshopProject {
  return {
    id,
    rootProjectId: id,
    name: `项目${id}`,
    description: `简介${id}`,
    version: '1.0.0',
    authorName: '作者',
    tags: ['系统'],
    downloadUrl: '',
    fileSize: 0,
    installState: 'installed',
    installedVersion: '1.0.0',
    installedAt: 1,
    fetchedAt: 1,
    uidRange: { start: 0, end: 0 },
    droppedNotes: [],
    updatedAt: 1,
    ...over,
  } as WorkshopProject;
}

function book(projectId: string, uids: number[]): WorldBook {
  return {
    id: workshopBookId(projectId),
    name: `项目${projectId}`,
    partition: WORKSHOP_PARTITION,
    description: '',
    entries: uids.map((u) => entry(u)),
    builtIn: false,
  } as WorldBook;
}

describe('buildWorkshopEnableOptions', () => {
  it('已装项目 + 对应书 → 展开出全部条目 uid（升序去重）', () => {
    const options = buildWorkshopEnableOptions([project('p1')], [book('p1', [107, 105, 106, 105])]);
    expect(options).toHaveLength(1);
    expect(options[0].projectId).toBe('p1');
    expect(options[0].entryUids).toEqual([105, 106, 107]);
  });

  it('tags 与简介必须原样带出 —— D12 靠它让用户自己判断冲突', () => {
    const options = buildWorkshopEnableOptions(
      [project('p1', { tags: ['命定核心', '外挂'], description: '自带一个命定核心' })],
      [book('p1', [1])],
    );
    expect(options[0].tags).toEqual(['命定核心', '外挂']);
    expect(options[0].description).toBe('自带一个命定核心');
  });

  it('未安装的项目不出现 —— 只有书没有项目行时不造勾选项', () => {
    const options = buildWorkshopEnableOptions([], [book('p1', [1, 2])]);
    expect(options).toEqual([]);
  });

  it('已装但无条目（只带正则 / 书丢了）→ 仍在列表，entryUids 为空且不炸', () => {
    const options = buildWorkshopEnableOptions([project('p1'), project('p2')], [book('p2', [])]);
    expect(options.map((o) => o.projectId)).toEqual(['p1', 'p2']);
    expect(options[0].entryUids).toEqual([]);
    expect(options[1].entryUids).toEqual([]);
  });

  it('非工坊分区的书不会被当成工坊内容', () => {
    const foreign = {
      id: workshopBookId('p1'),
      name: 'x',
      partition: 'system_core',
      description: '',
      entries: [entry(9)],
      builtIn: false,
    } as unknown as WorldBook;
    const options = buildWorkshopEnableOptions([project('p1')], [foreign]);
    expect(options[0].entryUids).toEqual([]);
  });
});

describe('workshopTokensFor / isWorkshopProjectEnabled', () => {
  const opt: WorkshopEnableOption = {
    projectId: 'p1',
    name: '项目1',
    description: '',
    authorName: '',
    version: '1.0.0',
    tags: [],
    entryUids: [105, 106],
  };

  it('token 格式与 system_core:413 同形', () => {
    expect(workshopTokensFor(opt)).toEqual(['creative_workshop:105', 'creative_workshop:106']);
  });

  it('全部条目在场才算启用', () => {
    expect(isWorkshopProjectEnabled(opt, ['creative_workshop:105', 'creative_workshop:106'])).toBe(
      true,
    );
    expect(isWorkshopProjectEnabled(opt, ['creative_workshop:105'])).toBe(false);
    expect(isWorkshopProjectEnabled(opt, [])).toBe(false);
  });

  it('无条目的项目恒为未启用', () => {
    expect(isWorkshopProjectEnabled({ ...opt, entryUids: [] }, ['creative_workshop:105'])).toBe(
      false,
    );
  });

  it('畸形 token 不影响判定', () => {
    const tokens = ['creative_workshop:', 'creative_workshop:abc', 'creative_workshop:105'];
    expect(isWorkshopProjectEnabled({ ...opt, entryUids: [105] }, tokens)).toBe(true);
  });
});

describe('applyWorkshopSelection', () => {
  const options = buildWorkshopEnableOptions(
    [project('p1'), project('p2')],
    [book('p1', [105, 106]), book('p2', [201])],
  );

  it('勾一个项目 → 写入该项目全部条目的 creative_workshop:<uid>', () => {
    const next = applyWorkshopSelection([], options, ['p1']);
    expect(next).toEqual(['creative_workshop:105', 'creative_workshop:106']);
  });

  it('取消 → 该项目 token 全部移除', () => {
    const on = applyWorkshopSelection([], options, ['p1', 'p2']);
    expect(on).toHaveLength(3);
    const off = applyWorkshopSelection(on, options, ['p2']);
    expect(off).toEqual(['creative_workshop:201']);
    expect(applyWorkshopSelection(off, options, [])).toEqual([]);
  });

  it('★ 与 system_core / character 两轴互不干扰（原样按序保留）', () => {
    const base = ['system_core:413', 'character:313', 'character:320'];
    const on = applyWorkshopSelection(base, options, ['p1']);
    expect(on.slice(0, 3)).toEqual(base);
    expect(on.slice(3)).toEqual(['creative_workshop:105', 'creative_workshop:106']);
    // 来回切换不侵蚀另两轴
    expect(applyWorkshopSelection(on, options, [])).toEqual(base);
  });

  it('已卸载项目留下的陈旧 token 会被清掉（面板所见即所存）', () => {
    const stale = ['system_core:413', 'creative_workshop:9999'];
    expect(applyWorkshopSelection(stale, options, ['p2'])).toEqual([
      'system_core:413',
      'creative_workshop:201',
    ]);
  });

  it('接受 Set 与数组两种入参，结果一致', () => {
    expect(applyWorkshopSelection([], options, new Set(['p1']))).toEqual(
      applyWorkshopSelection([], options, ['p1']),
    );
  });

  it('无条目项目被勾中也不产出任何 token', () => {
    const empty = buildWorkshopEnableOptions([project('p3')], []);
    expect(applyWorkshopSelection(['system_core:1'], empty, ['p3'])).toEqual(['system_core:1']);
  });

  it('往返: apply → selected 回读一致', () => {
    const tokens = applyWorkshopSelection(['system_core:413'], options, ['p1', 'p2']);
    expect(selectedWorkshopProjectIds(options, tokens)).toEqual(['p1', 'p2']);
  });
});
