/**
 * vars-update-translator 专项测试（Q-19）
 *
 * 这些断言此前只能在 `agent-orchestrator.test.ts` 里做，而且每一条都得先搭
 * 一整条 pipeline + mock client + mock StateManager —— 只为验「AI 给
 * `path=equipment` 应该产一条 `add_item`」这种纯映射。
 *
 * 现在直接喂 parsed 对象、断言 patch 数组。原来那批 pipeline 测试保留不动
 * （它们现在的价值是端到端冒烟），本文件补的是翻译规则本身。
 */
import { describe, it, expect } from 'vitest';
import {
  buildDispatcherPatches,
  buildQuestPatches,
  buildVarsUpdatePatches,
} from './vars-update-translator';

describe('buildDispatcherPatches', () => {
  it('replace / insert → set_variable / insert_variable，路径加 variables. 前缀', () => {
    const { patches } = buildDispatcherPatches({
      replace: [{ path: '天气', value: '小雨' }],
      insert: [{ path: '事件', value: 'x', index: 2 }],
    });
    expect(patches).toEqual([
      {
        op: 'set_variable',
        target: 'variables.天气',
        value: '小雨',
        metadata: { source: 'request_dispatcher', operation: 'replace' },
      },
      {
        op: 'insert_variable',
        target: 'variables.事件',
        value: 'x',
        metadata: { source: 'request_dispatcher', operation: 'insert', index: 2 },
      },
    ]);
  });

  it('🔴 世界新闻路径被拦截成 add_news，不写变量（#16 双轨退役）', () => {
    const { patches } = buildDispatcherPatches({
      replace: [{ path: '世界新闻', value: { title: '战报', content: '北境有变' } }],
    });
    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('add_news');
    // 关键：一条 set_variable 都不许产出 —— 真源是 profile.news
    expect(patches.some((p) => p.op === 'set_variable')).toBe(false);
  });

  it('世界新闻的子路径同样拦截', () => {
    const { patches } = buildDispatcherPatches({
      replace: [{ path: '世界新闻.0', value: '快讯' }],
    });
    expect(patches[0].op).toBe('add_news');
  });

  it('delta_time 不产 patch，单独带出来（它走 applyTimeAdvance）', () => {
    expect(buildDispatcherPatches({ delta_time: 30 })).toEqual({ patches: [], deltaTime: 30 });
    // 0 与负数不推进
    expect(buildDispatcherPatches({ delta_time: 0 }).deltaTime).toBeUndefined();
    expect(buildDispatcherPatches({ delta_time: -5 }).deltaTime).toBeUndefined();
    expect(buildDispatcherPatches({ delta_time: 'x' }).deltaTime).toBeUndefined();
  });

  it('空对象 → 空补丁，不抛', () => {
    expect(buildDispatcherPatches({})).toEqual({ patches: [], deltaTime: undefined });
  });
});

describe('buildVarsUpdatePatches', () => {
  it('characters.replace 的 hp/mp/sp 路径 → set_* op', () => {
    const patches = buildVarsUpdatePatches({
      characters: {
        replace: [
          { name: '理查德', path: 'hp', value: 88 },
          { name: '理查德', path: 'mp', value: 12 },
        ],
      },
    });
    expect(patches.map((p) => p.op)).toEqual(['set_hp', 'set_mp']);
    expect(patches[0].target).toBe('characters.理查德');
  });

  it('🔴 缺 name 的条目跳过（铁律1：逻辑键=名字）', () => {
    const patches = buildVarsUpdatePatches({
      characters: { replace: [{ path: 'hp', value: 88 }] },
    });
    expect(patches).toEqual([]);
  });

  it('affections.set / delta → set_affection / delta_affection', () => {
    const patches = buildVarsUpdatePatches({
      affections: { set: [{ name: '莉娜', value: 40 }], delta: [{ name: '莉娜', amount: -5 }] },
    });
    expect(patches.map((p) => p.op)).toEqual(['set_affection', 'delta_affection']);
    expect(patches[1]).toMatchObject({ target: 'affections.莉娜', amount: -5 });
  });

  it('affections 缺 name 同样跳过', () => {
    expect(buildVarsUpdatePatches({ affections: { set: [{ value: 40 }] } })).toEqual([]);
  });

  it('空对象 → 空数组，不抛', () => {
    expect(buildVarsUpdatePatches({})).toEqual([]);
  });
});

describe('buildQuestPatches', () => {
  it('upsert → update_quest；缺 name 跳过', () => {
    const patches = buildQuestPatches({
      upsert: [{ name: '寻剑', status: '进行中' }, { status: '进行中' }],
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      op: 'update_quest',
      target: 'quests.寻剑',
      value: { name: '寻剑', status: '进行中' },
    });
  });

  it('remove → remove_quest，value 形态统一为 {name} 对象（#40）', () => {
    const patches = buildQuestPatches({ remove: [{ name: '寻剑' }] });
    expect(patches[0]).toMatchObject({ op: 'remove_quest', value: { name: '寻剑' } });
  });

  it('空对象 → 空数组', () => {
    expect(buildQuestPatches({})).toEqual([]);
  });
});
