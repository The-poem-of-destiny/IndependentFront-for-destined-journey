/** 工坊启用轴：完整 UID 展开、项目全选语义与创角三轴隔离。 */
import { describe, it, expect } from 'vitest';
import type { WorkshopProject, WorldBook, WorldBookEntry } from '@engine/types/types';
import { WORKSHOP_PARTITION, workshopBookId } from '@engine/workshop/workshop-types';
import {
  applyWorkshopSelection,
  buildWorkshopEnableOptions,
  isWorkshopProjectEnabled,
  selectedWorkshopProjectIds,
  workshopTokensFor,
  type WorkshopEnableOption,
} from '../../../src/ui/lib/workshop-enable';

const uid = (projectId: string, slug: string) => `workshop.${projectId}:creative_workshop/${slug}`;
function entry(uid: string): WorldBookEntry {
  return {
    uid,
    name: uid,
    content: `内容 ${uid}`,
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 100,
    position: 0,
  };
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
    droppedNotes: [],
    updatedAt: 1,
    ...over,
  };
}
function book(projectId: string, slugs: string[]): WorldBook {
  return {
    id: workshopBookId(projectId),
    name: `项目${projectId}`,
    partition: WORKSHOP_PARTITION,
    entries: slugs.map((slug) => entry(uid(projectId, slug))),
    builtIn: false,
  };
}

describe('buildWorkshopEnableOptions', () => {
  it('已装项目 + 对应书 → 展开出全部条目 UID（字典序去重）', () => {
    const options = buildWorkshopEnableOptions([project('p1')], [book('p1', ['c', 'a', 'b', 'a'])]);
    expect(options).toHaveLength(1);
    expect(options[0].projectId).toBe('p1');
    expect(options[0].entryUids).toEqual([uid('p1', 'a'), uid('p1', 'b'), uid('p1', 'c')]);
  });
  it('tags 与简介必须原样带出 —— D12 靠它让用户自己判断冲突', () => {
    const options = buildWorkshopEnableOptions(
      [project('p1', { tags: ['命定核心', '外挂'], description: '自带一个命定核心' })],
      [book('p1', ['a'])],
    );
    expect(options[0].tags).toEqual(['命定核心', '外挂']);
    expect(options[0].description).toBe('自带一个命定核心');
  });
  it('未安装的项目不出现 —— 只有书没有项目行时不造勾选项', () => {
    expect(buildWorkshopEnableOptions([], [book('p1', ['a', 'b'])])).toEqual([]);
  });
  it('已装但无条目（只带正则 / 书丢了）→ 仍在列表，entryUids 为空且不炸', () => {
    const options = buildWorkshopEnableOptions([project('p1'), project('p2')], [book('p2', [])]);
    expect(options.map((o) => o.projectId)).toEqual(['p1', 'p2']);
    expect(options[0].entryUids).toEqual([]);
    expect(options[1].entryUids).toEqual([]);
  });
  it('非工坊分区的书不会被当成工坊内容', () => {
    const foreign: WorldBook = {
      id: workshopBookId('p1'),
      name: 'x',
      partition: 'system_core',
      entries: [entry('fated:system_core/core')],
      builtIn: false,
    };
    expect(buildWorkshopEnableOptions([project('p1')], [foreign])[0].entryUids).toEqual([]);
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
    entryUids: [uid('p1', 'a'), uid('p1', 'b')],
  };
  it('token 直接使用完整 UID，返回独立数组', () => {
    expect(workshopTokensFor(opt)).toEqual(opt.entryUids);
    expect(workshopTokensFor(opt)).not.toBe(opt.entryUids);
  });
  it('全部条目在场才算启用', () => {
    expect(isWorkshopProjectEnabled(opt, [uid('p1', 'a'), uid('p1', 'b')])).toBe(true);
    expect(isWorkshopProjectEnabled(opt, [uid('p1', 'a')])).toBe(false);
    expect(isWorkshopProjectEnabled(opt, [])).toBe(false);
    expect(isWorkshopProjectEnabled(opt, [uid('p2', 'a'), uid('p2', 'b')])).toBe(false);
  });
  it('无条目的项目恒为未启用', () => {
    expect(isWorkshopProjectEnabled({ ...opt, entryUids: [] }, [uid('p1', 'a')])).toBe(false);
  });
  it('畸形与旧数字 token 不影响判定，也不能代替完整 UID', () => {
    const tokens = ['creative_workshop:', 'creative_workshop:105', uid('p1', 'a')];
    expect(isWorkshopProjectEnabled({ ...opt, entryUids: [uid('p1', 'a')] }, tokens)).toBe(true);
    expect(isWorkshopProjectEnabled(opt, ['creative_workshop:105', 'creative_workshop:106'])).toBe(
      false,
    );
  });
});

describe('applyWorkshopSelection', () => {
  const options = buildWorkshopEnableOptions(
    [project('p1'), project('p2')],
    [book('p1', ['a', 'b']), book('p2', ['a'])],
  );
  it('勾一个项目 → 写入该项目全部条目的完整 UID', () => {
    expect(applyWorkshopSelection([], options, ['p1'])).toEqual([uid('p1', 'a'), uid('p1', 'b')]);
  });
  it('取消 → 该项目 token 全部移除', () => {
    const on = applyWorkshopSelection([], options, ['p1', 'p2']);
    expect(on).toHaveLength(3);
    const off = applyWorkshopSelection(on, options, ['p2']);
    expect(off).toEqual([uid('p2', 'a')]);
    expect(applyWorkshopSelection(off, options, [])).toEqual([]);
  });
  it('★ 与 system_core / character 两轴互不干扰（原样按序保留）', () => {
    const base = ['fated:system_core/dalian', 'fated:character/guide', 'user:character/custom_abc'];
    const on = applyWorkshopSelection(base, options, ['p1']);
    expect(on.slice(0, 3)).toEqual(base);
    expect(on.slice(3)).toEqual([uid('p1', 'a'), uid('p1', 'b')]);
    expect(applyWorkshopSelection(on, options, [])).toEqual(base);
  });
  it('已卸载项目留下的陈旧 token 会被清掉（面板所见即所存）', () => {
    const stale = ['fated:system_core/dalian', uid('removed', 'a')];
    expect(applyWorkshopSelection(stale, options, ['p2'])).toEqual([
      'fated:system_core/dalian',
      uid('p2', 'a'),
    ]);
  });
  it('接受 Set 与数组两种入参，结果一致', () => {
    expect(applyWorkshopSelection([], options, new Set(['p1']))).toEqual(
      applyWorkshopSelection([], options, ['p1']),
    );
  });
  it('无条目项目被勾中也不产出任何 token', () => {
    const empty = buildWorkshopEnableOptions([project('p3')], []);
    expect(applyWorkshopSelection(['fated:system_core/core'], empty, ['p3'])).toEqual([
      'fated:system_core/core',
    ]);
  });
  it('往返: apply → selected 回读一致', () => {
    const tokens = applyWorkshopSelection(['fated:system_core/dalian'], options, ['p1', 'p2']);
    expect(selectedWorkshopProjectIds(options, tokens)).toEqual(['p1', 'p2']);
  });
});
