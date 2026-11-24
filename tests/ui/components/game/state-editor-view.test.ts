/**
 * state-editor-view — 变量修改器展示层判定（状态树协议 T11，设计 §11）
 *
 * 只读键不可编辑、时间只读、控件按叶子类型给、草稿只在改动时产 op、结构编辑的 op 形状、
 * 试算清单、锁定原因与撤销可用性。
 */
import { describe, expect, it } from 'vitest';
import { buildStateTree } from '@engine/variables/state-tree-projection';
import { previewPlayerEdit } from '@engine/variables/state-tree-edit';
import { makeInput } from '../../../core/variables/state-tree-fixture';
import {
  addEntryOp,
  buildEditorTree,
  collectDraftOps,
  describeOps,
  describePreview,
  encodePointerSegment,
  findEditorNode,
  formatEditorValue,
  indexEditorFields,
  initialDraft,
  isFieldDirty,
  parentPointer,
  parseDraft,
  pointerOf,
  READONLY_ATTRIBUTES,
  READONLY_BY_CODE,
  READONLY_PLAYER_LEVEL,
  READONLY_TIME,
  removeEntryOp,
  renameEntryOp,
  searchEditorTree,
  stateEditorLockReason,
  undoAvailability,
  validateEntryName,
  type EditorField,
  type FieldDraft,
} from '../../../../src/ui/components/game/state-editor-view';

function snap() {
  const input = makeInput();
  return { characters: input.characters, profile: input.profile };
}

function editor() {
  const s = snap();
  const tree = buildStateTree(s, { visibility: { mode: 'all' } });
  const nodes = buildEditorTree(tree);
  return { s, nodes, fields: indexEditorFields(nodes) };
}

function field(path: string): EditorField {
  const f = editor().fields.get(path);
  if (!f) throw new Error(`没有字段 ${path}`);
  return f;
}

describe('buildEditorTree', () => {
  it('顶层是世界、主角、关系列表、任务列表、变量', () => {
    expect(editor().nodes.map((n) => n.label)).toEqual([
      '世界',
      '主角',
      '关系列表',
      '任务列表',
      '变量',
    ]);
  });

  it('世界节点带上根上的命运点数；时间只读', () => {
    const world = findEditorNode(editor().nodes, '/世界')!;
    expect(world.fields.map((f) => f.path)).toContain('/命运点数');
    const time = world.fields.find((f) => f.path === '/世界/时间')!;
    expect(time.readonly).toBe(true);
    expect(time.readonlyReason).toBe(READONLY_TIME);
    expect(time.control).toBe('display');
  });

  it('`_` 只读键可见、置灰并说明由代码维护；属性给出分配入口提示', () => {
    expect(field('/主角/成长/_生命层级')).toMatchObject({
      readonly: true,
      readonlyReason: READONLY_BY_CODE,
      label: '生命层级',
    });
    expect(field('/主角/生命值/上限/_基础')).toMatchObject({ readonly: true });
    expect(field('/主角/成长/_属性/力量')).toMatchObject({
      readonly: true,
      readonlyReason: READONLY_ATTRIBUTES,
    });
    expect(field('/主角/档案/_年龄').readonly).toBe(true);
  });

  it('主角等级只读，NPC 等级可写（§9 #2）', () => {
    expect(field('/主角/成长/等级')).toMatchObject({
      readonly: true,
      readonlyReason: READONLY_PLAYER_LEVEL,
    });
    expect(field('/关系列表/布兰/成长/等级').readonly).toBe(false);
  });

  it('控件按叶子类型给', () => {
    expect(field('/主角/生命值/当前')).toMatchObject({ control: 'number', min: 0 });
    expect(field('/主角/生命值/上限/额外').control).toBe('number');
    expect(field('/关系列表/布兰/好感度')).toMatchObject({
      control: 'number',
      min: -100,
      max: 100,
    });
    expect(field('/主角/背包/治疗药水/品质').control).toBe('select');
    expect(field('/主角/背包/治疗药水/品质').options).toContain('稀有');
    expect(field('/主角/装备/长剑/位置').options).toContain('武器');
    expect(field('/关系列表/布兰/在场').control).toBe('toggle');
    expect(field('/主角/档案/身份').control).toBe('tags');
    expect(field('/主角/装备/长剑/效果')).toMatchObject({ control: 'dict', dictValue: 'text' });
    expect(field('/主角/装备/长剑/属性')).toMatchObject({ control: 'dict', dictValue: 'number' });
    expect(field('/主角/档案/种族').control).toBe('text');
    expect(field('/主角/装备/长剑/描述').control).toBe('textarea');
  });

  it('嵌套分支摊平成带前缀的标签', () => {
    expect(field('/主角/生命值/上限/额外').label).toBe('上限 · 额外');
    expect(field('/主角/装备/长剑/耐久/当前').label).toBe('耐久 · 当前');
  });

  it('字典节点的增删改名标志：人物可删不可改名，主角不可删', () => {
    const { nodes } = editor();
    expect(findEditorNode(nodes, '/主角')!.canRemove).toBe(false);
    expect(findEditorNode(nodes, '/关系列表')!.canAdd).toBe(false);
    expect(findEditorNode(nodes, '/关系列表/布兰')).toMatchObject({
      canRemove: true,
      canRename: false,
    });
    expect(findEditorNode(nodes, '/主角/背包')!.canAdd).toBe(true);
    expect(findEditorNode(nodes, '/主角/装备')!.canAdd).toBe(false);
    expect(findEditorNode(nodes, '/主角/背包/治疗药水')).toMatchObject({
      canRemove: true,
      canRename: true,
    });
    expect(findEditorNode(nodes, '/任务列表')!.canAdd).toBe(true);
  });

  it('变量：命名空间成节点，根不可新增，命名空间内可增删', () => {
    const { nodes } = editor();
    const root = findEditorNode(nodes, '/变量')!;
    expect(root.canAdd).toBe(false);
    const sys = findEditorNode(nodes, '/变量/sys')!;
    expect(sys.canAdd).toBe(true);
    expect(sys.fields[0]).toMatchObject({
      path: '/变量/sys/计数',
      control: 'number',
      removable: true,
    });
    expect(findEditorNode(nodes, '/变量/user')!.fields[0].control).toBe('tags');
  });

  it('名字里有 / 时按 JSON Pointer 转义', () => {
    expect(encodePointerSegment('a/b~c')).toBe('a~1b~0c');
    expect(pointerOf(['关系列表', 'a/b'])).toBe('/关系列表/a~1b');
    expect(parentPointer('/主角/背包/x')).toBe('/主角/背包');
  });
});

describe('搜索', () => {
  it('空查询不过滤', () => {
    expect(searchEditorTree(editor().nodes, '  ')).toBeNull();
  });

  it('按名字命中并展开祖先', () => {
    const r = searchEditorTree(editor().nodes, '药水')!;
    expect(r.matched.has('/主角/背包/治疗药水')).toBe(true);
    expect(r.visible.has('/主角')).toBe(true);
    expect(r.expanded.has('/主角/背包')).toBe(true);
    expect(r.visible.has('/关系列表')).toBe(false);
  });

  it('按路径与字段名命中', () => {
    const r = searchEditorTree(editor().nodes, '/关系列表/布兰')!;
    expect(r.matched.has('/关系列表/布兰')).toBe(true);
    const byField = searchEditorTree(editor().nodes, '好感度')!;
    expect(byField.matched.has('/关系列表/卡拉')).toBe(true);
  });
});

describe('草稿 → op', () => {
  it('没改的字段不产 op；改了的产 replace', () => {
    const { fields } = editor();
    const hp = fields.get('/主角/生命值/当前')!;
    const drafts = new Map<string, FieldDraft>([
      ['/主角/生命值/当前', '120'],
      ['/主角/金钱', initialDraft(fields.get('/主角/金钱')!)],
    ]);
    expect(isFieldDirty(hp, '300')).toBe(false);
    expect(collectDraftOps(fields, drafts)).toEqual({
      ops: [{ op: 'replace', path: '/主角/生命值/当前', value: 120 }],
      errors: [],
    });
  });

  it('只读字段的草稿一律忽略', () => {
    const { fields } = editor();
    const drafts = new Map<string, FieldDraft>([['/主角/成长/_属性点', '9']]);
    expect(collectDraftOps(fields, drafts).ops).toEqual([]);
  });

  it('数值填不出数字报错，不产 op', () => {
    const { fields } = editor();
    const r = collectDraftOps(fields, new Map([['/主角/金钱', 'abc']]));
    expect(r.ops).toEqual([]);
    expect(r.errors[0]).toContain('金钱');
  });

  it('可选键缺席且留空不产 op', () => {
    const f = field('/主角/背包/绳子/品质');
    expect(f.value).toBeUndefined();
    expect(parseDraft(f, '')).toEqual({ ok: true, value: undefined });
    expect(isFieldDirty(f, '')).toBe(false);
    expect(isFieldDirty(f, '优良')).toBe(true);
  });

  it('标签、开关与字典的草稿往返', () => {
    const tags = field('/主角/档案/身份');
    expect(initialDraft(tags)).toEqual(['冒险者']);
    expect(parseDraft(tags, ['冒险者', ' 骑士 ', ''])).toEqual({
      ok: true,
      value: ['冒险者', '骑士'],
    });
    const present = field('/关系列表/布兰/在场');
    expect(initialDraft(present)).toBe(true);
    expect(isFieldDirty(present, false)).toBe(true);
    const fx = field('/主角/装备/长剑/效果');
    expect(initialDraft(fx)).toEqual([{ key: '锋利', value: '攻击附带流血' }]);
    expect(
      parseDraft(fx, [
        { key: '锋利', value: '更锋利' },
        { key: '', value: '空键丢掉' },
      ]),
    ).toEqual({ ok: true, value: { 锋利: '更锋利' } });
    expect(parseDraft(fx, [{ key: '__proto__', value: 'x' }]).ok).toBe(false);
    const stats = field('/主角/装备/长剑/属性');
    expect(parseDraft(stats, [{ key: '攻击力', value: 'x' }]).ok).toBe(false);
    expect(parseDraft(stats, [{ key: '攻击力', value: '20' }])).toEqual({
      ok: true,
      value: { 攻击力: 20 },
    });
  });

  it('草稿产出的 op 能通过引擎试算（改一个 HP）', () => {
    const { s, fields } = editor();
    const { ops } = collectDraftOps(fields, new Map([['/主角/生命值/当前', '120']]));
    const view = describePreview(previewPlayerEdit(ops, s));
    expect(view.ok).toBe(true);
    expect(view.rows[0]).toMatchObject({
      path: '/主角/生命值/当前',
      op: '修改',
      before: '300',
      after: '120',
    });
  });
});

describe('结构编辑', () => {
  it('新增条目写空整对象，变量写空文本', () => {
    const { nodes } = editor();
    expect(addEntryOp(findEditorNode(nodes, '/主角/背包')!, ' 火把 ')).toEqual({
      op: 'add',
      path: '/主角/背包/火把',
      value: {},
    });
    expect(addEntryOp(findEditorNode(nodes, '/变量/sys')!, '新键')).toEqual({
      op: 'add',
      path: '/变量/sys/新键',
      value: '',
    });
  });

  it('删除与改名的 op 形状', () => {
    expect(removeEntryOp('/关系列表/布兰')).toEqual({ op: 'remove', path: '/关系列表/布兰' });
    expect(renameEntryOp('/主角/背包/绳子', '麻绳')).toEqual({
      op: 'move',
      from: '/主角/背包/绳子',
      path: '/主角/背包/麻绳',
    });
  });

  it('新条目名校验：空、只读前缀、原型污染键、重名', () => {
    const bag = findEditorNode(editor().nodes, '/主角/背包')!;
    expect(validateEntryName(bag, ' ')).toBe('名字不能为空');
    expect(validateEntryName(bag, '_x')).toContain('_');
    expect(validateEntryName(bag, '__proto__')).toContain('不能');
    expect(validateEntryName(bag, '绳子')).toContain('已经有');
    expect(validateEntryName(bag, '绳子', '/主角/背包/绳子')).toBeNull();
    expect(validateEntryName(bag, '火把')).toBeNull();
  });

  it('删除 NPC 的 op 试算通过，主角删除被拒', () => {
    const { s } = editor();
    expect(previewPlayerEdit([removeEntryOp('/关系列表/布兰')], s).ok).toBe(true);
    expect(previewPlayerEdit([removeEntryOp('/关系列表/艾琳')], s).ok).toBe(false);
  });
});

describe('试算展示', () => {
  it('被拒时带出原因与已丢弃行', () => {
    const view = describePreview(
      previewPlayerEdit([{ op: 'replace', path: '/主角/不存在', value: 1 }], snap()),
    );
    expect(view.ok).toBe(false);
    expect(view.reasons.length).toBeGreaterThan(0);
    expect(view.rows[0].status).toBe('已丢弃');
  });

  it('值的文字化', () => {
    expect(formatEditorValue(undefined)).toBe('（无）');
    expect(formatEditorValue('')).toBe('（空）');
    expect(formatEditorValue(true)).toBe('是');
    expect(formatEditorValue(['a', 'b'])).toBe('a、b');
    expect(formatEditorValue({ 攻击力: 15 })).toBe('攻击力：15');
  });

  it('一批 op 的简述', () => {
    expect(describeOps([{ op: 'replace', path: '/主角/金钱', value: 1 }])).toBe('修改 /主角/金钱');
    expect(
      describeOps([
        { op: 'replace', path: '/主角/金钱', value: 1 },
        { op: 'remove', path: '/关系列表/布兰' },
      ]),
    ).toBe('修改 /主角/金钱 等 2 项');
  });
});

describe('锁定与撤销', () => {
  it('生成中、润色中、战斗中整面只读并说明原因', () => {
    const idle = { isGenerating: false, isRewriting: false, isInCombat: false };
    expect(stateEditorLockReason(idle)).toBe('');
    expect(stateEditorLockReason({ ...idle, isGenerating: true })).toContain('生成中');
    expect(stateEditorLockReason({ ...idle, isRewriting: true })).toContain('润色中');
    expect(stateEditorLockReason({ ...idle, isInCombat: true })).toContain('战斗');
  });

  it('撤销只看栈顶；不可撤销的修改压在栈顶时给原因', () => {
    expect(undoAvailability([]).canUndo).toBe(false);
    const op = { op: 'replace' as const, path: '/主角/金钱', value: 1 };
    expect(undoAvailability([{ label: 'a', undo: [op] }])).toEqual({ canUndo: true, reason: '' });
    const blocked = undoAvailability([
      { label: 'a', undo: [op] },
      { label: 'b', undo: [] },
    ]);
    expect(blocked.canUndo).toBe(false);
    expect(blocked.reason).toContain('无法自动撤销');
  });
});
