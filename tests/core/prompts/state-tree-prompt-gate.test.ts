/**
 * 状态树协议文字闸门（T7）：协议状态写入段（state-tree-prompt.ts）与键词表（state-tree-spec.ts）必须说同一件事。
 * - op 名、只读约定句、顶层键、名字字典、可选槽位、枚举、五维按行首定位、插值片段整段断言；
 * - 协议里出现的每条 `/…` 路径与示例 JSON 的每条 op 都交给 spec 的查询函数校验。
 * 改了词表却没改协议、或协议教了树上没有的路径，这里会红。
 */
import { describe, expect, it } from 'vitest';
import {
  STATE_TREE_CACHE_PROTOCOL,
  STATE_TREE_ENUM_LABELS,
  STATE_TREE_PATCH_OPS,
  STATE_TREE_PROTOCOL_EXAMPLE,
  STATE_TREE_READONLY_RULE,
  STATE_TREE_RECORD_KEYS,
  STATE_TREE_ROOT_KEYS,
  STATE_TREE_WRITE_PROTOCOL,
} from '../../../src/core/prompts/state-tree-prompt';
import {
  ATTRIBUTE_LABELS,
  STATE_TREE_ENUM_VALUES,
  STATE_TREE_SLOT_VALUES,
  STATE_TREE_SPEC,
  findChildSpec,
  isReadonlyKey,
  type StateTreeEnumKind,
  type StateTreeNodeSpec,
} from '../../../src/core/variables/state-tree-spec';

const slash = (list: readonly string[]): string => list.join('/');

/** 按行首定位唯一一行；不唯一或不存在返回 undefined。 */
function lineOf(text: string, prefix: string): string | undefined {
  const found = text.split('\n').filter((line) => line.startsWith(prefix));
  return found.length === 1 ? found[0] : undefined;
}

// ========== 路径校验（只用 spec 的查询函数） ==========

type Resolved =
  { ok: true; spec: StateTreeNodeSpec; readonly: boolean } | { ok: false; at: string };

/**
 * 逐段对键词表解析路径：分支走 `findChildSpec`，名字字典吃掉一段条目名再进条目形状，
 * `变量` 子树键不翻译、其后任意段都合法。不做模糊匹配。
 */
function resolvePath(path: string): Resolved {
  const segments = path.split('/').slice(1);
  let node: StateTreeNodeSpec = STATE_TREE_SPEC;
  let readonly = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) return { ok: false, at: `${path}（空段）` };
    if (node.type === 'leaf') {
      if (node.leaf === 'variables') return { ok: true, spec: node, readonly };
      return { ok: false, at: `${path}（${node.key} 是叶子）` };
    }
    if (node.type === 'record') {
      node = node.entry;
      continue;
    }
    const child = findChildSpec(node, seg);
    if (!child) return { ok: false, at: `${path}（${node.key} 下没有 ${seg}）` };
    readonly = readonly || isReadonlyKey(child.key);
    node = child;
  }
  return { ok: true, spec: node, readonly };
}

/** 抽出文字里所有以 `/` 起头的路径（`/` 前不是字母数字，排除「上限/额外」这类并列写法）。 */
function pathsIn(text: string): string[] {
  return [...text.matchAll(/(?<![\p{L}\p{N}_}])\/[^\s"，。、；：（）(){}]+/gu)].map((m) => m[0]);
}

/** 整对象值的每个键都要在条目形状里（忽略 `_` 前缀），枚举值要在词表内。 */
function invalidValueKeys(spec: StateTreeNodeSpec, value: unknown, at: string): string[] {
  if (spec.type === 'leaf') {
    if (spec.leaf === 'enum' && spec.enumKind) {
      return STATE_TREE_ENUM_VALUES[spec.enumKind].includes(value as string)
        ? []
        : [`${at}=${String(value)} 不在 ${spec.enumKind} 词表`];
    }
    if (spec.leaf === 'slot') {
      return STATE_TREE_SLOT_VALUES.includes(value as string)
        ? []
        : [`${at}=${String(value)} 不是槽位`];
    }
    return [];
  }
  if (typeof value !== 'object' || value === null) return [];
  if (spec.type === 'record') {
    return Object.entries(value).flatMap(([k, v]) => invalidValueKeys(spec.entry, v, `${at}/${k}`));
  }
  return Object.entries(value).flatMap(([k, v]) => {
    const child = findChildSpec(spec, k);
    return child ? invalidValueKeys(child, v, `${at}/${k}`) : [`${at}/${k} 不在词表`];
  });
}

// ========== 闸门 ==========

describe('闸门 1：词表按行插值', () => {
  const text = STATE_TREE_WRITE_PROTOCOL;

  it('每个定位行都唯一存在', () => {
    const prefixes = [
      '状态写入：',
      'direct_updates 形如',
      '操作：',
      '路径：',
      '新建：',
      '背包与装备：',
      '数值：',
      '取值：',
      '示例：',
    ];
    expect(prefixes.filter((p) => lineOf(text, p) === undefined)).toEqual([]);
  });

  it('「状态写入：」行带顶层键与只读约定原句', () => {
    const line = lineOf(text, '状态写入：')!;
    expect(STATE_TREE_ROOT_KEYS).toEqual(STATE_TREE_SPEC.children.map((c) => c.key));
    expect(line).toContain(`顶层 ${slash(STATE_TREE_ROOT_KEYS)}）`);
    expect(line).toContain(`${STATE_TREE_READONLY_RULE}。`);
  });

  it('「操作：」行逐个讲到五个 op，且没有多余的 op', () => {
    const line = lineOf(text, '操作：')!;
    const missing = STATE_TREE_PATCH_OPS.filter(
      (op) => !new RegExp(String.raw`(?<![A-Za-z])${op} `).test(line.split('。')[0]),
    );
    expect(missing).toEqual([]);
    expect(STATE_TREE_PATCH_OPS).toEqual(['replace', 'add', 'remove', 'delta', 'move']);
  });

  it('「路径：」行列出全部名字字典', () => {
    const line = lineOf(text, '路径：')!;
    expect(STATE_TREE_RECORD_KEYS).toEqual(
      expect.arrayContaining(['关系列表', '任务列表', '背包', '装备', '技能', '状态效果']),
    );
    expect(line).toContain(`名字字典（${slash(STATE_TREE_RECORD_KEYS)}）`);
  });

  it('「新建：」行带五维中文键', () => {
    expect(lineOf(text, '新建：')).toContain(
      `成长.属性{${Object.values(ATTRIBUTE_LABELS).join(',')}}`,
    );
  });

  it('「背包与装备：」行列出全部可选槽位，并讲清 move 穿卸、remove 离开人物', () => {
    const line = lineOf(text, '背包与装备：')!;
    expect(line).toContain(`可选位置：${slash(STATE_TREE_SLOT_VALUES)}，`);
    expect(line).toContain('穿戴用 move 从背包到装备，value 写位置');
    expect(line).toContain('卸下用 move 从装备回背包');
    expect(line).toContain('表示物品离开人物');
  });

  it('「取值：」行逐个插值全部枚举词表', () => {
    const line = lineOf(text, '取值：')!;
    const kinds = Object.keys(STATE_TREE_ENUM_VALUES) as StateTreeEnumKind[];
    expect(Object.keys(STATE_TREE_ENUM_LABELS).sort()).toEqual([...kinds].sort());
    const missing = kinds
      .map((k) => `${STATE_TREE_ENUM_LABELS[k]} ${slash(STATE_TREE_ENUM_VALUES[k])}`)
      .filter((fragment) => !line.includes(fragment));
    expect(missing).toEqual([]);
  });

  it('「数值：」行：主角等级只读改累计经验值、上限只写额外、时间用分钟 delta', () => {
    const line = lineOf(text, '数值：')!;
    expect(line).toContain('主角的 成长/等级 只读，升级请改 成长/累计经验值');
    expect(line).toContain('上限只写 上限/额外');
    expect(line).toContain('delta /世界/时间，value 是本楼耗时分钟');
  });

  it('闸门能抓到被删掉的槽位片段', () => {
    const stripped = text.replace(slash(STATE_TREE_SLOT_VALUES), STATE_TREE_SLOT_VALUES[0]);
    expect(lineOf(stripped, '背包与装备：')).not.toContain(
      `可选位置：${slash(STATE_TREE_SLOT_VALUES)}，`,
    );
  });

  it('长度保持精简（约 1.5k 字符量级）', () => {
    expect(text.length).toBeLessThan(1800);
  });
});

describe('闸门 2：路径都在词表内', () => {
  it.each([
    ['状态写入段', STATE_TREE_WRITE_PROTOCOL],
    ['缓存措辞', STATE_TREE_CACHE_PROTOCOL],
  ])('%s：出现的每条 / 路径都能被 spec 解析', (_label, text) => {
    const paths = pathsIn(text);
    expect(paths.length).toBeGreaterThan(0);
    const bad = paths.map(resolvePath).filter((r) => !r.ok);
    expect(bad).toEqual([]);
  });

  it('路径解析器能拒收树外路径', () => {
    expect(resolvePath('/主角/生命/当前').ok).toBe(false);
    expect(resolvePath('/主角/背包').ok).toBe(true);
    expect(resolvePath('/变量/任意/深层').ok).toBe(true);
  });
});

describe('闸门 3：示例 JSON', () => {
  const line = lineOf(STATE_TREE_WRITE_PROTOCOL, '示例：')!;
  const example = JSON.parse(line.slice('示例：'.length)) as {
    version: number;
    patch: Array<{ op: string; path: string; from?: string; value?: unknown }>;
  };

  it('能被 JSON.parse，且与导出的示例常量一致', () => {
    expect(example).toEqual(STATE_TREE_PROTOCOL_EXAMPLE);
    expect(example.version).toBe(2);
    expect(example.patch.length).toBeGreaterThan(0);
  });

  it('只用合法 op，路径都在词表内且不写只读键', () => {
    const problems = example.patch.flatMap((row, i) => {
      const out: string[] = [];
      if (!(STATE_TREE_PATCH_OPS as readonly string[]).includes(row.op))
        out.push(`#${i} op=${row.op}`);
      for (const p of [row.path, ...(row.from ? [row.from] : [])]) {
        const r = resolvePath(p);
        if (!r.ok) out.push(`#${i} ${r.at}`);
        else if (r.readonly) out.push(`#${i} ${p} 只读`);
      }
      if (row.op === 'move' && (row.from === undefined || row.path === undefined))
        out.push(`#${i} move 缺 from`);
      return out;
    });
    expect(problems).toEqual([]);
  });

  it('整对象值的键与枚举取值都在词表内；穿戴 move 的 value 是可选槽位', () => {
    const problems = example.patch.flatMap((row) => {
      const r = resolvePath(row.path);
      if (!r.ok) return [];
      if (row.op === 'move' && row.path.includes('/装备/')) {
        return STATE_TREE_SLOT_VALUES.includes(row.value as string)
          ? []
          : [`${row.path} 位置 ${String(row.value)}`];
      }
      return row.op === 'add' || row.op === 'replace'
        ? invalidValueKeys(r.spec, row.value, row.path)
        : [];
    });
    expect(problems).toEqual([]);
  });
});
