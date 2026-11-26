/**
 * 翻译层性能用例（审查报告 R6a）：大存档（304 个角色、约 0.9MB）上一楼 40 条 op 的翻译耗时。
 *
 * 修复前每条 op 都要整份投影两次、整份深拷贝工作状态，实测约 600ms；修复后只克隆 / 投影被触及的人物或分区。
 * 上限放宽到 300ms 防 CI 抖动（本机实测远低于此，数字见提交报告）。
 */
import { describe, expect, it } from 'vitest';

import type { CharacterState } from '../../../src/core/types/types';
import { parseTreePatchBlock } from '../../../src/core/variables/state-tree-patch';
import { translateTreeOps } from '../../../src/core/variables/state-tree-translator';
import { GAME_TIME, makeNpc, makePlayer } from './state-tree-fixture';

const NPC_COUNT = 303;
const OP_COUNT = 40;
const LIMIT_MS = 300;

/** 一个「够重」的 NPC：随身条目、技能、状态与长文本，凑到每人约 3KB。 */
function heavyNpc(i: number): CharacterState {
  const text = (label: string) => `${label}${i}：${'风尘仆仆的旅人，'.repeat(12)}`;
  return makeNpc(`路人${i}`, {
    present: i % 3 === 0,
    appearance: text('外貌'),
    background: text('背景'),
    personality: text('性格'),
    hp: 100,
    maxHp: 200,
    inventory: Array.from({ length: 6 }, (_, k) => ({
      name: `杂物${k}`,
      quantity: 2,
      equippedSlot: null,
      type: '消耗品',
      rarity: '普通',
      description: text('物品描述'),
      tags: ['旧'],
    })),
    skills: Array.from({ length: 3 }, (_, k) => ({
      name: `技艺${k}`,
      description: text('技能描述'),
      type: 'active' as const,
      costText: '少许体力',
    })),
    statusEffects: [
      {
        name: '疲惫',
        description: text('状态描述'),
        category: '减益',
        stacks: 2,
        maxStacks: 5,
        remainingTime: 3,
        timeUnit: '小时',
        source: '赶路',
        effects: {},
      },
    ],
  });
}

function bigSnapshot() {
  const characters = [makePlayer(), ...Array.from({ length: NPC_COUNT }, (_, i) => heavyNpc(i))];
  return {
    characters,
    profile: {
      fp: 10,
      gameTime: GAME_TIME,
      affections: {},
      variables: { user: {}, sys: { 计数: 1 } },
      quests: {},
      news: [],
    },
  };
}

/** 40 条覆盖常见写法的 op：资源、金钱、物品增减、状态层数、好感、任务、变量、时间。 */
function bulkOps(): unknown[] {
  const ops: unknown[] = [];
  for (let k = 0; ops.length < OP_COUNT; k++) {
    const who = `/关系列表/路人${(k * 37) % NPC_COUNT}`;
    switch (k % 8) {
      case 0:
        ops.push({ op: 'delta', path: `${who}/生命值/当前`, value: -5 });
        break;
      case 1:
        ops.push({ op: 'delta', path: `${who}/金钱`, value: 3 });
        break;
      case 2:
        ops.push({ op: 'add', path: `${who}/背包/新得${k}`, value: { 品质: '普通', 数量: 1 } });
        break;
      case 3:
        ops.push({ op: 'delta', path: `${who}/背包/杂物1/数量`, value: -1 });
        break;
      case 4:
        ops.push({ op: 'delta', path: `${who}/状态效果/疲惫/层数`, value: 1 });
        break;
      case 5:
        ops.push({ op: 'delta', path: `${who}/好感度`, value: 2 });
        break;
      case 6:
        ops.push({ op: 'replace', path: `/任务列表/委托${k}/状态`, value: '进行中' });
        break;
      default:
        ops.push({ op: 'delta', path: '/变量/sys/计数', value: 1 });
    }
  }
  return ops;
}

describe('翻译层性能', () => {
  it(`304 个角色 × ${OP_COUNT} 条 op 翻译不超过 ${LIMIT_MS}ms`, () => {
    const snapshot = bigSnapshot();
    expect(JSON.stringify(snapshot).length).toBeGreaterThan(800_000);
    const parsed = parseTreePatchBlock(JSON.stringify({ version: 2, patch: bulkOps() }));
    if (parsed.kind !== 'patch') throw new Error('解析失败');
    expect(parsed.ops).toHaveLength(OP_COUNT);
    // 先热身一次（JIT），再取三次里最快的一次
    translateTreeOps(parsed.ops, snapshot, { actor: 'ai' });
    let best = Number.POSITIVE_INFINITY;
    let result: ReturnType<typeof translateTreeOps> | undefined;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      result = translateTreeOps(parsed.ops, snapshot, { actor: 'ai' });
      best = Math.min(best, performance.now() - t0);
    }
    console.info(`[翻译层性能] 304 角色 × ${OP_COUNT} op：${best.toFixed(1)}ms`);
    expect(result!.dropped).toEqual([]);
    expect(best).toBeLessThan(LIMIT_MS);
  });
});
