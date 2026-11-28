/**
 * 词表是键 → 内核字段映射的唯一真源（审查报告 R6a 闸门）。
 *
 * 1. 词表里每个可写叶子都能被翻译层解析到写入规则与内核字段（`stateTreeTranslationRuleOf` /
 *    `stateTreeKernelFieldOf` 都读词表）。
 * 2. 翻译层 / 编辑层 / 投影源码里不再出现词表外的硬编码键映射：中文键 → 内核字段的对象字面量、
 *    按中文键分派的 `case '…'`、成串的中文键清单（`*_FIELD_KEYS` / `*_ENTITY_KEYS` 一类）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  STATE_TREE_DEPLETABLE_LEAF,
  STATE_TREE_NAMED_RECORD_KEYS,
  listStateTreePaths,
} from '../../../src/core/variables/state-tree-spec';
import {
  stateTreeKernelFieldOf,
  stateTreeTranslationRuleOf,
} from '../../../src/core/variables/state-tree-translator';

const VARIABLES_DIR = resolve(__dirname, '../../../src/core/variables');
// 翻译层自 R6b 起拆到 translator/ 目录：入口、编辑层与该目录下每个模块都扫；
// 投影自 L6（2026-11-27）起也只从词表读键 → 字段
const SOURCES = [
  'state-tree-translator.ts',
  'state-tree-edit.ts',
  'state-tree-projection.ts',
  ...readdirSync(resolve(VARIABLES_DIR, 'translator'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `translator/${f}`),
].map((name) => ({
  name,
  // 去掉注释再扫：注释里举例写到中文键不算映射
  code: readFileSync(resolve(VARIABLES_DIR, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, ''),
}));

const HAN = '[\\u4e00-\\u9fff]';

/** 源码里命中的片段（压成一行，便于报错时一眼看出是哪处）。 */
function hits(code: string, re: RegExp): string[] {
  return [...code.matchAll(re)].map((m) => m[0].replace(/\s+/g, ' '));
}

describe('词表 → 翻译层：每个可写叶子都解析到内核字段', () => {
  const writableLeaves = listStateTreePaths().filter((r) => r.spec.type === 'leaf' && !r.readonly);

  it('可写叶子不少于 60 个（防止词表被意外清空后闸门空转）', () => {
    expect(writableLeaves.length).toBeGreaterThan(60);
  });

  it('每个可写叶子都有写入规则（不是 readonly）', () => {
    const missing = writableLeaves
      .filter((r) => {
        const rule = stateTreeTranslationRuleOf(r.pattern);
        return rule === undefined || rule === 'readonly';
      })
      .map((r) => r.pattern);
    expect(missing).toEqual([]);
  });

  it('每个可写叶子都映射到内核字段', () => {
    const missing = writableLeaves
      .filter((r) => !stateTreeKernelFieldOf(r.pattern))
      .map((r) => r.pattern);
    expect(missing).toEqual([]);
  });

  it('同一实体条目下内核字段不重复', () => {
    for (const row of listStateTreePaths()) {
      if (row.spec.type !== 'branch' || !row.spec.entity) continue;
      const kernels = row.spec.children.map((c) => c.kernel).filter((k) => k !== undefined);
      expect(new Set(kernels).size, row.pattern).toBe(kernels.length);
    }
  });

  it('由词表推出的字典清单与可减没叶子', () => {
    expect([...STATE_TREE_NAMED_RECORD_KEYS]).toEqual([
      '背包',
      '装备',
      '技能',
      '状态效果',
      '要素',
      '权能',
      '法则',
      '关系列表',
      '任务列表',
    ]);
    expect(STATE_TREE_DEPLETABLE_LEAF).toEqual({ 背包: '数量', 装备: '数量', 状态效果: '层数' });
  });
});

describe('翻译层 / 编辑层 / 投影：没有词表外的硬编码键映射', () => {
  for (const { name, code } of SOURCES) {
    it(`${name}：没有「中文键: 内核字段」对象字面量`, () => {
      const re = new RegExp(`[{,]\\s*['"]?${HAN}+['"]?\\s*:`, 'g');
      expect(hits(code, re)).toEqual([]);
    });

    it(`${name}：没有按中文键分派的 case`, () => {
      expect(hits(code, new RegExp(`case\\s+'${HAN}`, 'g'))).toEqual([]);
    });

    it(`${name}：没有成串的中文键清单`, () => {
      const lit = `'${HAN}[^']*'`;
      const re = new RegExp(`\\[\\s*${lit}\\s*,\\s*${lit}\\s*,\\s*${lit}`, 'g');
      expect(hits(code, re)).toEqual([]);
    });

    it(`${name}：没有 *_FIELD_KEYS / *_ENTITY_KEYS / *_FIELDS 一类的手写映射常量`, () => {
      expect(
        hits(code, /const\s+[A-Z_]*(?:_FIELD_KEYS|_ENTITY_KEYS|_FIELDS|_BY_LABEL)\b/g),
      ).toEqual([]);
      expect(hits(code, /\bkernelOf\s*:/g)).toEqual([]);
    });
  }
});
