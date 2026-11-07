/**
 * workshop-install-plan.test.ts — 安装计划器
 *
 * 这几条断言是本阶段的核心资产（实施计划 P1-1 验收）：
 * - 跨项目 UID 不重叠，安装顺序不影响条目身份
 * - 卸载后的失效引用不会命中其他项目；重装同项目恢复原 UID
 * - 按名匹配的**增 / 删 / 改**三种情形（D15）
 * - `sourceHash` 命中与不命中（D15：让警告精确，而非无条件恐吓）
 * - `droppedNotes` 内容正确（丢弃必须 loud）
 */

import { describe, it, expect } from 'vitest';
import { hashWorkshopContent, planInstall } from '../../../src/core/workshop/workshop-install-plan';
import type {
  InstallRegistry,
  WorkshopInstallInput,
  WorkshopProjectMeta,
  WorkshopSourceEntry,
  WorkshopSourceRegex,
} from '../../../src/core/workshop/workshop-types';
import { WORKSHOP_PARTITION } from '../../../src/core/workshop/workshop-types';
import type { WorldBookEntry } from '../../../src/core/types/types';
import { worldBookUidStem } from '../../../src/core/content/worldbook-uid';

const uid = (name: string, projectId = 'proj-yanling') =>
  `workshop.${projectId}:creative_workshop/${worldBookUidStem(name)}_${hashWorkshopContent(name)}`;

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

function source(
  name: string,
  content = `${name} 的正文`,
  over: Partial<WorkshopSourceEntry> = {},
): WorkshopSourceEntry {
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
function installed(name: string, content: string, hashOf = content): WorldBookEntry {
  return {
    uid: uid(name),
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

const FRESH: InstallRegistry = {};

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
    const plan = planInstall(input([]), FRESH);
    expect(plan.entries).toEqual([]);
    expect(plan.retiredUids).toEqual([]);
    expect(plan).not.toHaveProperty('nextUid');
    expect(plan).not.toHaveProperty('uidRange');
    expect(plan).not.toHaveProperty('allocatedUidRange');
  });
});

describe('planInstall —— ★ D8 确定性 UID', () => {
  it('上游 UID 仅作溯源，条目身份由项目与名称决定', () => {
    const plan = planInstall(
      input([
        source('a', 'a', { sourceUid: 0 }),
        source('b', 'b', { sourceUid: 1 }),
        source('c', 'c', { sourceUid: 2 }),
      ]),
      FRESH,
    );
    expect(plan.entries.map((e) => e.uid)).toEqual([uid('a'), uid('b'), uid('c')]);
    expect(plan.entries.map((e) => e.extra?.workshop?.sourceUid)).toEqual([0, 1, 2]);
    expect(plan).not.toHaveProperty('nextUid');
  });

  it('★ 跨项目 UID 不重叠 —— 上游三个项目 UID 全从 0 起编也不撞', () => {
    const yanling = planInstall(input([source('言灵核心')], [], { id: 'p1' }), FRESH);
    const vera = planInstall(
      input(
        Array.from({ length: 12 }, (_, i) => source(`维拉条目${i}`)),
        [],
        { id: 'p2' },
      ),
      FRESH,
    );
    const reader = planInstall(input([source('读者核心')], [], { id: 'p3' }), FRESH);
    const all = [...yanling.entries, ...vera.entries, ...reader.entries].map((e) => e.uid);
    expect(all).toHaveLength(14);
    expect(new Set(all).size).toBe(14);
    expect(yanling.entries[0].uid).toBe(uid('言灵核心', 'p1'));
    expect(reader.entries[0].uid).toBe(uid('读者核心', 'p3'));
  });

  it('★ 卸载后旧引用不命中其他项目，重装同项目恢复原身份', () => {
    const payload = input([source('a'), source('b')], [], { id: 'p1' });
    const first = planInstall(payload, FRESH);
    const other = planInstall(input([source('a'), source('b')], [], { id: 'p2' }), FRESH);
    for (const entry of first.entries)
      expect(other.entries.map((e) => e.uid)).not.toContain(entry.uid);
    expect(planInstall(payload, FRESH).entries.map((e) => e.uid)).toEqual(
      first.entries.map((e) => e.uid),
    );
  });

  it('安装顺序与其他机器的已装内容不影响身份', () => {
    const payload = input([source('a'), source('b')]);
    const first = planInstall(payload, FRESH);
    const unrelated = planInstall(input([source('x')], [], { id: 'other' }), FRESH);
    expect(unrelated.entries[0].uid).not.toBe(first.entries[0].uid);
    expect(planInstall(payload, {}).entries.map((e) => e.uid)).toEqual(
      first.entries.map((e) => e.uid),
    );
  });

  it('正文、版本、项目展示名与上游 UID 变更不改变条目身份', () => {
    const first = planInstall(input([source('a', 'old', { sourceUid: 0 })]), FRESH);
    const next = planInstall(
      input([source('a', 'new', { sourceUid: 'changed' })], [], {
        name: '新展示名',
        version: '3.0.0',
      }),
      FRESH,
    );
    expect(next.entries[0].uid).toBe(first.entries[0].uid);
    expect(next.entries[0].content).toBe('new');
  });

  it('非法项目 ID 明确报错，不静默生成碰撞身份', () => {
    for (const id of ['bad:id', '中文', 'bad id'])
      expect(() => planInstall(input([source('a')], [], { id }), FRESH)).toThrow(/project ID/);
  });
});

describe('planInstall —— ★ D15 按名匹配的增 / 删 / 改', () => {
  const existingEntries = [
    installed('核心', '核心正文 v1'),
    installed('规则', '规则正文 v1'),
    installed('弃用条目', '将被上游删掉'),
  ];
  const registry: InstallRegistry = { existingEntries };

  it('【改】存活条目 UID 保持不变 —— 存档的 enabledWorldBookEntries 无需重写', () => {
    const plan = planInstall(input([source('核心', '核心正文 v2')]), registry);
    expect(plan.isUpdate).toBe(true);
    expect(plan.entries[0].uid).toBe(existingEntries[0].uid);
    expect(plan.entries[0].content).toBe('核心正文 v2');
  });

  it('【增】上游新增的条目使用新的确定性身份', () => {
    const plan = planInstall(
      input([source('核心', '核心正文 v1'), source('全新条目', '新')]),
      registry,
    );
    expect(plan.entries.map((e) => [e.name, e.uid])).toEqual([
      ['核心', uid('核心')],
      ['全新条目', uid('全新条目')],
    ]);
    expect(existingEntries.map((e) => e.uid)).not.toContain(plan.entries[1].uid);
  });

  it('【删】上游移除的条目 UID 退休，不会指向其他条目', () => {
    const plan = planInstall(input([source('核心', '核心正文 v1')]), registry);
    expect(plan.retiredUids.sort()).toEqual([uid('规则'), uid('弃用条目')].sort());
    expect(plan.entries.map((e) => e.uid)).not.toContain(uid('规则'));
    expect(plan.entries.map((e) => e.uid)).not.toContain(uid('弃用条目'));
  });

  it('增删改混合的一次真实更新', () => {
    const plan = planInstall(
      input([source('核心', '核心正文 v2'), source('规则', '规则正文 v1'), source('新技能', '新')]),
      registry,
    );
    expect(plan.entries.map((e) => [e.name, e.uid])).toEqual([
      ['核心', uid('核心')],
      ['规则', uid('规则')],
      ['新技能', uid('新技能')],
    ]);
    expect(plan.retiredUids).toEqual([uid('弃用条目')]);
    expect(plan.entries.map((e) => e.content)).toEqual(['核心正文 v2', '规则正文 v1', '新']);
  });

  it('条目在上游重排 → UID 跟着名字走，不跟着顺序走', () => {
    const plan = planInstall(
      input([source('规则', '规则正文 v1'), source('核心', '核心正文 v1')]),
      registry,
    );
    expect(plan.entries.map((e) => [e.name, e.uid])).toEqual([
      ['规则', uid('规则')],
      ['核心', uid('核心')],
    ]);
  });

  it('全部条目被上游删光 → 空 entries + 全员退休', () => {
    const plan = planInstall(input([]), registry);
    expect(plan.entries).toEqual([]);
    expect(plan.retiredUids.sort()).toEqual(existingEntries.map((e) => e.uid).sort());
  });

  it('existingEntries 为空数组 = 首装（无 if/else 两条路径）', () => {
    const plan = planInstall(input([source('a')]), { existingEntries: [] });
    expect(plan.isUpdate).toBe(false);
    expect(plan.entries[0].uid).toBe(uid('a'));
  });
});

describe('planInstall —— ★ D15 sourceHash 冲突判定', () => {
  it('未改动 → 无冲突（静默覆盖，这正是更新的语义）', () => {
    const plan = planInstall(input([source('核心', 'v2')]), {
      existingEntries: [installed('核心', 'v1')],
    });
    expect(plan.conflicts).toEqual([]);
  });

  it('已改动 → 记冲突，但仍覆盖（不做逐条保留）', () => {
    // 库里正文是 '用户手改过的', 而 sourceHash 记的是 'v1'
    const edited = installed('核心', '用户手改过的', 'v1');
    const plan = planInstall(input([source('核心', 'v2')]), {
      existingEntries: [edited],
    });
    expect(plan.conflicts).toEqual([
      {
        uid: uid('核心'),
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
      existingEntries: [installed('a', 'a1'), installed('b', '被改过', 'b1'), installed('c', 'c1')],
    });
    expect(plan.conflicts.map((c) => c.name)).toEqual(['b']);
  });

  it('没有 sourceHash 的已有条目（非本流程装的）→ 不谎报冲突', () => {
    const foreign: WorldBookEntry = {
      uid: uid('核心'),
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
      existingEntries: [foreign],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.entries[0].uid).toBe(uid('核心'));
  });

  it('新装条目的 sourceHash 记的是**新**正文 —— 下次更新才判得准', () => {
    const plan = planInstall(input([source('核心', 'v2')]), {
      existingEntries: [installed('核心', 'v1')],
    });
    expect(plan.entries[0].extra?.workshop?.sourceHash).toBe(hashWorkshopContent('v2'));

    // 用上一轮的产物当下一轮的 existing：内容没动 → 无冲突
    const again = planInstall(input([source('核心', 'v3')]), {
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
      placement: [2],
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

  it('正则侧的 iframe 降级不被算成丢弃', () => {
    const plan = planInstall(
      input(
        [source('a')],
        [
          rx({
            replaceString:
              '<img src="https://cdn.example/image.png"><script>parent.document</script>',
          }),
        ],
      ),
      FRESH,
    );
    expect(plan.rules).toHaveLength(1); // 装上了
    expect(plan.droppedNotes.filter((n) => n.kind === 'dropped')).toHaveLength(0);
    expect(plan.droppedNotes.map((n) => n.kind)).toEqual(['degraded']);
  });

  it('退休条目记一条 dropped，带完整 UID', () => {
    const plan = planInstall(input([]), {
      existingEntries: [installed('a', 'x'), installed('b', 'y')],
    });
    const note = plan.droppedNotes.find((n) => n.text.includes('已移除'));
    expect(note?.kind).toBe('dropped');
    expect(note?.text).toContain('2 条');
    expect(note?.text).toContain(uid('a'));
    expect(note?.text).toContain(uid('b'));
  });

  it('上游重名条目 → 本地唯一化并记 note（条目装进来了，故算 degraded 不算未导入）', () => {
    const plan = planInstall(input([source('核心', 'a'), source('核心', 'b')]), FRESH);
    expect(plan.entries.map((e) => e.name)).toEqual(['核心', '核心 (2)']);
    expect(plan.entries.map((e) => e.uid)).toEqual([uid('核心'), uid('核心 (2)')]);
    expect(plan.droppedNotes.map((n) => n.kind)).toEqual(['degraded']);
    expect(noteText(plan)).toContain('重复');
  });

  it('三重名 → (2)/(3) 依次递增', () => {
    const plan = planInstall(input([source('x', '1'), source('x', '2'), source('x', '3')]), FRESH);
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
            placement: [2],
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
    const existingEntries = [installed('核心', 'v1')];
    const snapshot = JSON.stringify(existingEntries);
    const payload = input([source('核心', 'v2'), source('新')]);
    const payloadSnapshot = JSON.stringify(payload);
    const registry: InstallRegistry = { existingEntries };

    planInstall(payload, registry);

    expect(JSON.stringify(existingEntries)).toBe(snapshot);
    expect(JSON.stringify(payload)).toBe(payloadSnapshot);
    expect(Object.keys(registry)).toEqual(['existingEntries']);
  });

  it('同输入同输出（可重放）', () => {
    const payload = input([source('a'), source('b')]);
    const registry: InstallRegistry = {};
    expect(JSON.stringify(planInstall(payload, registry))).toBe(
      JSON.stringify(planInstall(payload, registry)),
    );
  });
});
