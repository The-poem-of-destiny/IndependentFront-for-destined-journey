/**
 * workshop-install-plan.test.ts — 安装计划器
 *
 * 这几条断言是本阶段的核心资产（实施计划 P1-1 验收）：
 * - 跨项目 uid **不重叠**（D8：否则 `creative_workshop:5` 同时命中所有工坊书）
 * - 卸载后号段**不回收**（D8：否则旧存档的启用引用会指向新项目的条目）
 * - 按名匹配的**增 / 删 / 改**三种情形（D15）
 * - `sourceHash` 命中与不命中（D15：让警告精确，而非无条件恐吓）
 * - `droppedNotes` 内容正确（丢弃必须 loud）
 */

import { describe, it, expect } from 'vitest';
import { hashWorkshopContent, planInstall } from './workshop-install-plan';
import type {
  InstallRegistry,
  WorkshopInstallInput,
  WorkshopProjectMeta,
  WorkshopSourceEntry,
  WorkshopSourceRegex,
} from './workshop-types';
import { WORKSHOP_PARTITION } from './workshop-types';
import type { WorldBookEntry } from './types';

function project(over: Partial<WorkshopProjectMeta> = {}): WorkshopProjectMeta {
  return {
    id: 'proj-yanling',
    rootProjectId: 'proj-yanling',
    name: '命定核心-言灵（重置）',
    description: '',
    version: '2.1.0',
    authorName: '夜见哉川',
    tags: ['系统', '外挂', '改词'],
    downloadUrl: 'https://example.invalid/project.json',
    fileSize: 24530,
    ...over,
  };
}

function source(name: string, content = `${name} 的正文`, over: Partial<WorkshopSourceEntry> = {}): WorkshopSourceEntry {
  return {
    sourceUid: 0,
    name,
    content,
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 1100,
    position: 4,
    ...over,
  };
}

function input(
  entries: WorkshopSourceEntry[],
  regexEntries: WorkshopSourceRegex[] = [],
  over: Partial<WorkshopProjectMeta> = {},
): WorkshopInstallInput {
  return { project: project(over), worldbookEntries: entries, regexEntries };
}

/** 造一条「由本流程装过」的已有条目 —— 带 sourceHash，故可判定改没改过 */
function installed(uid: number, name: string, content: string, hashOf = content): WorldBookEntry {
  return {
    uid,
    name,
    content,
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 1100,
    position: 4,
    extra: {
      workshop: {
        projectId: 'proj-yanling',
        projectName: '命定核心-言灵（重置）',
        sourceUid: 0,
        sourceComment: name,
        sourceHash: hashWorkshopContent(hashOf),
      },
    },
  };
}

const FRESH: InstallRegistry = { nextUid: 0 };

describe('planInstall —— 首装基本形状', () => {
  it('产出书 id / 分区 / 条目，全部对齐 D6·D7', () => {
    const plan = planInstall(input([source('核心'), source('规则')]), FRESH);
    expect(plan.bookId).toBe('workshop:proj-yanling');
    expect(plan.partition).toBe(WORKSHOP_PARTITION);
    expect(plan.partition).toBe('creative_workshop');
    expect(plan.isUpdate).toBe(false);
    expect(plan.entries.map((e) => e.name)).toEqual(['核心', '规则']);
  });

  it('条目字段从上游搬运，不篡改', () => {
    const plan = planInstall(
      input([
        source('核心', '正文', {
          enabled: false,
          key: ['k1'],
          keysecondary: ['k2'],
          selectiveLogic: 3,
          order: 500,
          position: 4,
        }),
      ]),
      FRESH,
    );
    expect(plan.entries[0]).toMatchObject({
      name: '核心',
      content: '正文',
      enabled: false,
      key: ['k1'],
      keysecondary: ['k2'],
      selectiveLogic: 3,
      order: 500,
      position: 4,
    });
  });

  it('每条都带完整 extra.workshop 溯源（D14）', () => {
    const plan = planInstall(input([source('核心', '正文', { sourceUid: '7' })]), FRESH);
    expect(plan.entries[0].extra?.workshop).toEqual({
      projectId: 'proj-yanling',
      projectName: '命定核心-言灵（重置）',
      sourceUid: '7', // 上游原始 uid 原样保留（string | number），仅溯源
      sourceComment: '核心',
      sourceHash: hashWorkshopContent('正文'),
    });
  });

  it('空载荷 → 空计划，不抛', () => {
    const plan = planInstall(input([]), { nextUid: 42 });
    expect(plan.entries).toEqual([]);
    expect(plan.nextUid).toBe(42);
    expect(plan.uidRange).toEqual({ start: 42, end: 42 });
    expect(plan.allocatedUidRange).toEqual({ start: 42, end: 42 });
  });
});

describe('planInstall —— ★ D8 uid 分配', () => {
  it('上游 uid 一律不采信：从分配器游标起连号发新的', () => {
    // 上游每个项目 uid 都从 0 起编，照搬必然跨项目撞号
    const plan = planInstall(
      input([
        source('a', 'a', { sourceUid: 0 }),
        source('b', 'b', { sourceUid: 1 }),
        source('c', 'c', { sourceUid: 2 }),
      ]),
      { nextUid: 100 },
    );
    expect(plan.entries.map((e) => e.uid)).toEqual([100, 101, 102]);
    expect(plan.nextUid).toBe(103);
    expect(plan.allocatedUidRange).toEqual({ start: 100, end: 103 });
    expect(plan.uidRange).toEqual({ start: 100, end: 103 });
  });

  it('★ 跨项目 uid 不重叠 —— 上游三个项目 uid 全从 0 起编也不撞', () => {
    // 真实样本：言灵 1 条(uid 0) / 维拉 12 条(uid 0..11) / 读者 1 条(uid 0)
    const yanling = planInstall(input([source('言灵核心')], [], { id: 'p1' }), { nextUid: 0 });

    const veraNames = Array.from({ length: 12 }, (_, i) => `维拉条目${i}`);
    const vera = planInstall(input(veraNames.map((n) => source(n)), [], { id: 'p2' }), {
      nextUid: yanling.nextUid,
    });

    const reader = planInstall(input([source('读者核心')], [], { id: 'p3' }), {
      nextUid: vera.nextUid,
    });

    const all = [...yanling.entries, ...vera.entries, ...reader.entries].map((e) => e.uid);
    expect(all).toHaveLength(14);
    expect(new Set(all).size).toBe(14); // 零重叠
    expect(all).toEqual([...Array(14).keys()]); // 0..13 连号
  });

  it('★ 卸载不回收号段 —— 中间项目卸掉后，下一个项目仍领全新号', () => {
    const p1 = planInstall(input([source('a'), source('b')], [], { id: 'p1' }), { nextUid: 0 });
    const p2 = planInstall(input([source('c'), source('d')], [], { id: 'p2' }), {
      nextUid: p1.nextUid,
    });
    expect(p2.entries.map((e) => e.uid)).toEqual([2, 3]);

    // 卸载 p1：store 只删行，**绝不**把 nextUid 退回去
    const cursorAfterUninstall = p2.nextUid;

    const p3 = planInstall(input([source('e')], [], { id: 'p3' }), {
      nextUid: cursorAfterUninstall,
    });
    // 若回收了 p1 的 0/1，p3 就会拿到 0 —— 旧存档里的 `creative_workshop:0`
    // 会静默指向一份陌生内容
    expect(p3.entries[0].uid).toBe(4);
    expect(p3.entries[0].uid).not.toBe(0);
    expect(p3.entries[0].uid).toBeGreaterThanOrEqual(cursorAfterUninstall);
  });

  it('游标只增不减 —— 任何计划的 nextUid 都 >= 入参', () => {
    for (const start of [0, 1, 7, 999]) {
      const plan = planInstall(input([source('a')]), { nextUid: start });
      expect(plan.nextUid).toBeGreaterThan(start);
    }
    const empty = planInstall(input([]), { nextUid: 7 });
    expect(empty.nextUid).toBe(7);
  });

  it('脏游标（NaN / 负数 / 小数）→ 归一，不把 NaN 传染给每个 uid', () => {
    expect(planInstall(input([source('a')]), { nextUid: NaN }).entries[0].uid).toBe(0);
    expect(planInstall(input([source('a')]), { nextUid: -5 }).entries[0].uid).toBe(0);
    expect(planInstall(input([source('a')]), { nextUid: 3.7 }).entries[0].uid).toBe(3);
  });
});

describe('planInstall —— ★ D15 按名匹配的增 / 删 / 改', () => {
  const existingEntries = [
    installed(10, '核心', '核心正文 v1'),
    installed(11, '规则', '规则正文 v1'),
    installed(12, '弃用条目', '将被上游删掉'),
  ];
  const registry: InstallRegistry = { nextUid: 20, existingEntries };

  it('【改】存活条目 uid 保持不变 —— 存档的 enabledWorldBookEntries 无需重写', () => {
    const plan = planInstall(input([source('核心', '核心正文 v2')]), registry);
    expect(plan.isUpdate).toBe(true);
    expect(plan.entries[0].uid).toBe(10); // 不是 20
    expect(plan.entries[0].content).toBe('核心正文 v2'); // 覆盖式
  });

  it('【增】上游新增的条目领新号', () => {
    const plan = planInstall(
      input([source('核心', '核心正文 v1'), source('全新条目', '新')]),
      registry,
    );
    expect(plan.entries.map((e) => [e.name, e.uid])).toEqual([
      ['核心', 10],
      ['全新条目', 20],
    ]);
    expect(plan.nextUid).toBe(21);
    expect(plan.allocatedUidRange).toEqual({ start: 20, end: 21 });
  });

  it('【删】上游移除的条目 uid 退休，不回收（D8）', () => {
    const plan = planInstall(input([source('核心', '核心正文 v1')]), registry);
    expect(plan.retiredUids.sort((a, b) => a - b)).toEqual([11, 12]);
    // 退休号段绝不回填分配器
    expect(plan.nextUid).toBe(20);
    expect(plan.entries.map((e) => e.uid)).not.toContain(11);
  });

  it('增删改混合的一次真实更新', () => {
    const plan = planInstall(
      input([
        source('核心', '核心正文 v2'), // 改
        source('规则', '规则正文 v1'), // 原样
        source('新技能', '新'), // 增
        // '弃用条目' 不再出现 → 删
      ]),
      registry,
    );
    expect(plan.entries.map((e) => [e.name, e.uid])).toEqual([
      ['核心', 10],
      ['规则', 11],
      ['新技能', 20],
    ]);
    expect(plan.retiredUids).toEqual([12]);
    expect(plan.uidRange).toEqual({ start: 10, end: 21 });
    expect(plan.allocatedUidRange).toEqual({ start: 20, end: 21 });
  });

  it('条目在上游重排 → uid 跟着名字走，不跟着顺序走', () => {
    const plan = planInstall(
      input([source('规则', '规则正文 v1'), source('核心', '核心正文 v1')]),
      registry,
    );
    expect(plan.entries.map((e) => [e.name, e.uid])).toEqual([
      ['规则', 11],
      ['核心', 10],
    ]);
  });

  it('全部条目被上游删光 → 空 entries + 全员退休', () => {
    const plan = planInstall(input([]), registry);
    expect(plan.entries).toEqual([]);
    expect(plan.retiredUids.sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  it('existingEntries 为空数组 = 首装（无 if/else 两条路径）', () => {
    const plan = planInstall(input([source('a')]), { nextUid: 5, existingEntries: [] });
    expect(plan.isUpdate).toBe(false);
    expect(plan.entries[0].uid).toBe(5);
  });
});

describe('planInstall —— ★ D15 sourceHash 冲突判定', () => {
  it('未改动 → 无冲突（静默覆盖，这正是更新的语义）', () => {
    const plan = planInstall(input([source('核心', 'v2')]), {
      nextUid: 20,
      existingEntries: [installed(10, '核心', 'v1')],
    });
    expect(plan.conflicts).toEqual([]);
  });

  it('已改动 → 记冲突，但仍覆盖（不做逐条保留）', () => {
    // 库里正文是 '用户手改过的', 而 sourceHash 记的是 'v1'
    const edited = installed(10, '核心', '用户手改过的', 'v1');
    const plan = planInstall(input([source('核心', 'v2')]), {
      nextUid: 20,
      existingEntries: [edited],
    });
    expect(plan.conflicts).toEqual([
      {
        uid: 10,
        name: '核心',
        sourceHash: hashWorkshopContent('v1'),
        currentHash: hashWorkshopContent('用户手改过的'),
      },
    ]);
    // 覆盖式：冲突不阻止覆盖，只让 store 有机会先弹警告
    expect(plan.entries[0].content).toBe('v2');
  });

  it('只有真被改过的那条进 conflicts —— 警告精确而非无条件恐吓', () => {
    const plan = planInstall(input([source('a', 'a2'), source('b', 'b2'), source('c', 'c2')]), {
      nextUid: 20,
      existingEntries: [
        installed(10, 'a', 'a1'),
        installed(11, 'b', '被改过', 'b1'),
        installed(12, 'c', 'c1'),
      ],
    });
    expect(plan.conflicts.map((c) => c.name)).toEqual(['b']);
  });

  it('没有 sourceHash 的已有条目（非本流程装的）→ 不谎报冲突', () => {
    const foreign: WorldBookEntry = {
      uid: 10,
      name: '核心',
      content: '来路不明',
      enabled: true,
      key: [],
      keysecondary: [],
      selectiveLogic: 0,
      order: 100,
      position: 0,
    };
    const plan = planInstall(input([source('核心', 'v2')]), {
      nextUid: 20,
      existingEntries: [foreign],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.entries[0].uid).toBe(10);
  });

  it('新装条目的 sourceHash 记的是**新**正文 —— 下次更新才判得准', () => {
    const plan = planInstall(input([source('核心', 'v2')]), {
      nextUid: 20,
      existingEntries: [installed(10, '核心', 'v1')],
    });
    expect(plan.entries[0].extra?.workshop?.sourceHash).toBe(hashWorkshopContent('v2'));

    // 用上一轮的产物当下一轮的 existing：内容没动 → 无冲突
    const again = planInstall(input([source('核心', 'v3')]), {
      nextUid: plan.nextUid,
      existingEntries: plan.entries,
    });
    expect(again.conflicts).toEqual([]);
  });

  it('hashWorkshopContent：同内容同哈希、异内容异哈希、空串有值', () => {
    expect(hashWorkshopContent('abc')).toBe(hashWorkshopContent('abc'));
    expect(hashWorkshopContent('abc')).not.toBe(hashWorkshopContent('abd'));
    expect(hashWorkshopContent('abc')).not.toBe(hashWorkshopContent('ab')); // 长度进哈希
    expect(hashWorkshopContent('abc')).not.toBe(hashWorkshopContent('cba')); // 同字符集
    expect(hashWorkshopContent('')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashWorkshopContent('言灵·改稿笺 🎴')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('planInstall —— droppedNotes 汇总', () => {
  /** note 正文拼一串（note 带 kind，直接 join 会得到 [object Object]） */
  function noteText(plan: { droppedNotes: Array<{ text: string }> }): string {
    return plan.droppedNotes.map((n) => n.text).join('\n');
  }

  function rx(over: Partial<WorkshopSourceRegex> = {}): WorkshopSourceRegex {
    return {
      id: 'rx-1',
      scriptName: '美化',
      findRegex: '<a>(.*)</a>',
      replaceString: '<b>$1</b>',
      disabled: false,
      markdownOnly: true,
      promptOnly: false,
      runOnEdit: false,
      trimStrings: [],
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
      placement: [],
      ...over,
    };
  }

  it('干净的载荷 → 零 note', () => {
    expect(planInstall(input([source('a')], [rx()]), FRESH).droppedNotes).toEqual([]);
  });

  it('正则侧的丢弃项汇总进来，且保留 kind', () => {
    const plan = planInstall(input([source('a')], [rx({ promptOnly: true })]), FRESH);
    expect(plan.rules).toHaveLength(0);
    expect(plan.droppedNotes.map((n) => n.kind)).toEqual(['dropped']);
    expect(noteText(plan)).toContain('promptOnly');
  });

  it('正则侧的 degraded / sideEffect 不被算成丢弃', () => {
    const plan = planInstall(
      input([source('a')], [rx({ replaceString: '<style>a{}</style><script>x</script>' })]),
      FRESH,
    );
    expect(plan.rules).toHaveLength(1); // 装上了
    expect(plan.droppedNotes.filter((n) => n.kind === 'dropped')).toHaveLength(0);
    expect(plan.droppedNotes.map((n) => n.kind).sort()).toEqual(['degraded', 'sideEffect']);
  });

  it('退休条目记一条 dropped，带 uid 与「不再复用」', () => {
    const plan = planInstall(input([]), {
      nextUid: 20,
      existingEntries: [installed(10, 'a', 'x'), installed(11, 'b', 'y')],
    });
    const note = plan.droppedNotes.find((n) => n.text.includes('已移除'));
    expect(note?.kind).toBe('dropped');
    expect(note?.text).toContain('2 条');
    expect(note?.text).toContain('10, 11');
    expect(note?.text).toContain('不再复用');
  });

  it('上游重名条目 → 本地唯一化并记 note（条目装进来了，故算 degraded 不算未导入）', () => {
    const plan = planInstall(input([source('核心', 'a'), source('核心', 'b')]), FRESH);
    expect(plan.entries.map((e) => e.name)).toEqual(['核心', '核心 (2)']);
    expect(plan.entries.map((e) => e.uid)).toEqual([0, 1]);
    expect(plan.droppedNotes.map((n) => n.kind)).toEqual(['degraded']);
    expect(noteText(plan)).toContain('重复');
  });

  it('三重名 → (2)/(3) 依次递增', () => {
    const plan = planInstall(
      input([source('x', '1'), source('x', '2'), source('x', '3')]),
      FRESH,
    );
    expect(plan.entries.map((e) => e.name)).toEqual(['x', 'x (2)', 'x (3)']);
    expect(new Set(plan.entries.map((e) => e.uid)).size).toBe(3);
  });
});

describe('planInstall —— 正则映射接入（D16）', () => {
  it('规则带项目分组与 autoEnable 绑定 —— 卸载即失效', () => {
    const plan = planInstall(
      input(
        [source('a')],
        [
          {
            id: 'rx-9',
            scriptName: '维拉美化',
            findRegex: '/<Vera>(.*)<\\/Vera>/g',
            replaceString: '<div>$1</div>',
            disabled: false,
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: false,
            trimStrings: [],
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
            placement: [],
          },
        ],
      ),
      FRESH,
    );
    expect(plan.rules).toHaveLength(1);
    expect(plan.rules[0]).toMatchObject({
      id: 'workshop-rule:proj-yanling:rx-9',
      pattern: '<Vera>(.*)<\\/Vera>', // 定界符已剥
      flags: 'g',
      group: '创意工坊 · 命定核心-言灵（重置）',
      autoEnable: { worldBookIds: ['workshop:proj-yanling'] },
      isBuiltin: false,
    });
  });
});

describe('planInstall —— 纯度', () => {
  it('不修改入参', () => {
    const existingEntries = [installed(10, '核心', 'v1')];
    const snapshot = JSON.stringify(existingEntries);
    const payload = input([source('核心', 'v2'), source('新')]);
    const payloadSnapshot = JSON.stringify(payload);
    const registry: InstallRegistry = { nextUid: 20, existingEntries };

    planInstall(payload, registry);

    expect(JSON.stringify(existingEntries)).toBe(snapshot);
    expect(JSON.stringify(payload)).toBe(payloadSnapshot);
    expect(registry.nextUid).toBe(20); // 游标不就地改，只在计划里返回
  });

  it('同输入同输出（可重放）', () => {
    const payload = input([source('a'), source('b')]);
    const registry: InstallRegistry = { nextUid: 7 };
    expect(JSON.stringify(planInstall(payload, registry))).toBe(
      JSON.stringify(planInstall(payload, registry)),
    );
  });
});
