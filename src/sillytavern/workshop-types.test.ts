/**
 * workshop-types.test.ts — 处置记录的归一与分组
 *
 * 这一层存在的唯一理由: **UI 曾经在说谎**。三类处置（真丢弃 / 装了但渲染受限 /
 * 装了但有全局副作用）合流成一个 `string[]`，已装列表统一报「N 项内容未导入」，
 * 于是一条装好了也启用了、只是 `<style>` 会全局生效的正则，被算进了「未导入」。
 *
 * ★ 最重要的一组断言是**向后兼容**: 用户库里已经有 `string[]` 形态的老行
 * （P1 首版落库形态），读侧必须吃得下、归得对、一条都不能丢。
 */

import { describe, it, expect } from 'vitest';
import type { WorkshopNote, WorkshopNoteLike } from './types';
import {
  WORKSHOP_NOTE_KINDS,
  groupWorkshopNotes,
  normalizeWorkshopNote,
  normalizeWorkshopNotes,
  workshopNote,
  grantWorkshopBookToAgents,
  revokeWorkshopBookFromAgents,
} from './workshop-types';

describe('normalizeWorkshopNote —— 单条归一', () => {
  it('结构化 note 原样保留 kind 与 text', () => {
    expect(normalizeWorkshopNote({ kind: 'sideEffect', text: '<style> 全局生效' })).toEqual({
      kind: 'sideEffect',
      text: '<style> 全局生效',
    });
  });

  it('★ 裸字符串（P1 首版落库形态）归 dropped —— 与旧文案语气一致', () => {
    expect(normalizeWorkshopNote('丢弃 runOnEdit')).toEqual({
      kind: 'dropped',
      text: '丢弃 runOnEdit',
    });
  });

  it('kind 是脏值（老版本 / 手改过的备份）时退回 dropped，绝不抛', () => {
    const dirty = { kind: 'explosion', text: '来路不明' } as unknown as WorkshopNote;
    expect(normalizeWorkshopNote(dirty)).toEqual({ kind: 'dropped', text: '来路不明' });
  });

  it('text 非串时转成串，不产出 undefined 渲染进 DOM', () => {
    const dirty = { kind: 'degraded', text: 42 } as unknown as WorkshopNote;
    expect(normalizeWorkshopNote(dirty)).toEqual({ kind: 'degraded', text: '42' });
  });
});

describe('normalizeWorkshopNotes —— 整组归一', () => {
  it('★ 旧 string[] 整组能读，顺序不变，一条不丢', () => {
    const legacy = ['丢弃 placement', '丢弃 maxDepth', '整条未导入（promptOnly）'];
    const notes = normalizeWorkshopNotes(legacy);
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => n.text)).toEqual(legacy);
    expect(new Set(notes.map((n) => n.kind))).toEqual(new Set(['dropped']));
  });

  it('★ 新旧混合数组两者都留（更新过一次的老项目就是这个形状）', () => {
    const mixed: WorkshopNoteLike[] = [
      '老的裸串',
      workshopNote('sideEffect', '<style> 全局生效'),
      workshopNote('degraded', '围栏原样显示'),
    ];
    expect(normalizeWorkshopNotes(mixed).map((n) => n.kind)).toEqual([
      'dropped',
      'sideEffect',
      'degraded',
    ]);
  });

  it('undefined / 非数组 → 空数组（一条脏的展示字段不该让整个列表白屏）', () => {
    expect(normalizeWorkshopNotes(undefined)).toEqual([]);
    expect(normalizeWorkshopNotes('不是数组' as unknown as WorkshopNoteLike[])).toEqual([]);
    expect(normalizeWorkshopNotes(null as unknown as WorkshopNoteLike[])).toEqual([]);
  });

  it('空文本项被剔除 —— 它只会渲染成空 <li> 并把计数灌水', () => {
    expect(normalizeWorkshopNotes(['', workshopNote('dropped', ''), '有内容'])).toEqual([
      { kind: 'dropped', text: '有内容' },
    ]);
  });

  it('数组里的 null / undefined 跳过而不是炸', () => {
    const holey = ['甲', null, undefined, '乙'] as unknown as WorkshopNoteLike[];
    expect(normalizeWorkshopNotes(holey).map((n) => n.text)).toEqual(['甲', '乙']);
  });
});

describe('groupWorkshopNotes —— 分组计数', () => {
  it('三个键恒在，空组给空数组（UI 直接取 .length）', () => {
    const groups = groupWorkshopNotes([]);
    for (const kind of WORKSHOP_NOTE_KINDS) expect(groups[kind]).toEqual([]);
  });

  it('★ 三类分别计数，互不串', () => {
    const groups = groupWorkshopNotes([
      workshopNote('dropped', '丢弃 placement'),
      workshopNote('degraded', '含 <script>'),
      workshopNote('degraded', '围栏'),
      workshopNote('sideEffect', '含 <style>'),
    ]);
    expect(groups.dropped).toHaveLength(1);
    expect(groups.degraded).toHaveLength(2);
    expect(groups.sideEffect).toHaveLength(1);
    // 「4 项未导入」是修掉的那个谎 —— dropped 只有 1
    expect(groups.dropped[0].text).toContain('placement');
    expect(groups.degraded.map((n) => n.text)).toEqual(['含 <script>', '围栏']);
  });

  it('★ 老的纯 string[] 项目：全部落进 dropped，计数与旧 UI 一致', () => {
    const groups = groupWorkshopNotes(['a', 'b', 'c']);
    expect(groups.dropped).toHaveLength(3);
    expect(groups.degraded).toHaveLength(0);
    expect(groups.sideEffect).toHaveLength(0);
  });

  it('undefined → 三个空组（没装过 / 老行没这个字段）', () => {
    expect(groupWorkshopNotes(undefined)).toEqual({ dropped: [], degraded: [], sideEffect: [] });
  });
});

describe('工坊书 → Agent 可见性', () => {
  const AGENTS = {
    story: ['world_setting', 'character'],
    item_gen: ['world_setting'],
    combat: [],
  };

  it('★ 授予后每个 Agent 的清单里都有这本书', () => {
    // 没有这一步，「装了 + 存档里勾了启用」的工坊内容一个 Agent 都读不到
    const next = grantWorkshopBookToAgents(AGENTS, 'workshop:p1');
    expect(next.story).toEqual(['world_setting', 'character', 'workshop:p1']);
    expect(next.item_gen).toEqual(['world_setting', 'workshop:p1']);
    expect(next.combat).toEqual(['workshop:p1']);
  });

  it('幂等 —— 重装/更新不会把同一个 id 塞两遍', () => {
    const once = grantWorkshopBookToAgents(AGENTS, 'workshop:p1');
    expect(grantWorkshopBookToAgents(once, 'workshop:p1')).toEqual(once);
  });

  it('纯函数：不改入参', () => {
    const input = { story: ['world_setting'] };
    grantWorkshopBookToAgents(input, 'workshop:p1');
    expect(input.story).toEqual(['world_setting']);
  });

  it('卸载收回，且只收回这一本', () => {
    const granted = grantWorkshopBookToAgents(AGENTS, 'workshop:p1');
    const both = grantWorkshopBookToAgents(granted, 'workshop:p2');
    const after = revokeWorkshopBookFromAgents(both, 'workshop:p1');
    expect(after.story).toEqual(['world_setting', 'character', 'workshop:p2']);
    expect(after.combat).toEqual(['workshop:p2']);
  });

  it('装-卸一轮回到原样，清单不会越积越长', () => {
    const after = revokeWorkshopBookFromAgents(
      grantWorkshopBookToAgents(AGENTS, 'workshop:p1'),
      'workshop:p1',
    );
    expect(after).toEqual(AGENTS);
  });

  it('脏值（备份改坏的非数组）不抛，退化成只含本书的清单', () => {
    const dirty = { story: undefined as unknown as string[] };
    expect(grantWorkshopBookToAgents(dirty, 'workshop:p1').story).toEqual(['workshop:p1']);
    expect(revokeWorkshopBookFromAgents(dirty, 'workshop:p1').story).toEqual([]);
  });

  it('空映射（Agent 配置还没水合）不炸', () => {
    expect(grantWorkshopBookToAgents({}, 'workshop:p1')).toEqual({});
  });
});
