/**
 * pack-install.contract.test.ts —— 跨仓安装契约（内容-引擎分离波 4 / D38）
 *
 * 反转依赖方向：公开引擎自带契约测试，私有 CI 构建真实 pack 后设 `POEM_PACK_FILE`
 * 跑本文件。未设 `POEM_PACK_FILE` → skip（公开 CI 不跑）。
 *
 * 断言：
 * - 新鲜播种引擎上装包 → 0 冲突（占位基线命中）
 * - 分节计数 + 0 dropped
 * - 模拟一次用户编辑后重装 → N 冲突（冲突路径活着）
 *
 * 基线由 `node:fs` 读 `public/data` 供给（占位内容随引擎打包，D20 裁定不许运行时现算）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { planPackInstall, type CurrentLibrary } from '../../src/sillytavern/content-pack-plan';
import { AGENT_TOOL_MAP } from '../../src/sillytavern/agent-tools';
import { hashWorldBook, validatePackOrThrow } from '../../src/sillytavern/content-source';
import type { ContentPack, PackBaseline } from '../../src/sillytavern/types-content';
import type { WorldBook } from '../../src/sillytavern/types';

const REPO_ROOT = join(__dirname, '..', '..');
const PACK_FILE = process.env.POEM_PACK_FILE;
const describeIf = PACK_FILE ? describe : describe.skip;

/** 从 public/data 读占位世界书（D20：占位基线由构建期清单 + 现算 hash 供给） */
function loadPlaceholderBooks(): WorldBook[] {
  const dir = join(REPO_ROOT, 'public', 'data', 'worldbooks');
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  return names.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) as WorldBook[];
}

/** 从 public/data 现算占位基线（hash 口径与 planner 一致） */
function buildPlaceholderBaseline(): PackBaseline {
  const byBook: Record<string, string> = {};
  for (const b of loadPlaceholderBooks()) {
    byBook[b.id] = hashWorldBook(b);
  }
  return { byBook };
}

/** 从占位书构造 CurrentLibrary（fresh 播种态） */
function freshLibrary(): CurrentLibrary {
  return { worldBooks: loadPlaceholderBooks() };
}

describeIf('pack-install 契约（POEM_PACK_FILE 已设）', () => {
  it('pack 通过校验（validatePackOrThrow 无 error）', () => {
    const pack = loadPack();
    const notes = validatePackOrThrow(pack);
    expect(notes.filter((n) => n.level === 'error')).toEqual([]);
  });

  it('新鲜播种引擎上装包 → 0 冲突', () => {
    const pack = loadPack();
    const current = freshLibrary();
    const placeholderBaseline = buildPlaceholderBaseline();
    const plan = planPackInstall(pack, current, {}, placeholderBaseline);
    const conflicts = Object.values(plan.sections).flatMap(
      (s) => (s && 'conflicted' in s ? s.conflicted : []) as Array<{ key: string }>,
    );
    expect(conflicts).toEqual([]);
  });

  it('分节计数合理 + 0 dropped', () => {
    const pack = loadPack();
    const current = freshLibrary();
    const plan = planPackInstall(pack, current, {}, buildPlaceholderBaseline());
    const wb = plan.sections.worldBooks;
    if (wb) {
      expect(wb.added.length + wb.updated.length).toBeGreaterThan(0);
    }
    expect(plan.notes.filter((n) => n.kind === 'dropped')).toEqual([]);
  });

  it('模拟用户编辑后重装 → 冲突路径活着', () => {
    const pack = loadPack();
    const current = freshLibrary();
    const books = [...(current.worldBooks ?? [])];
    // 编辑第一本书的第一条 → hash 偏离占位基线
    const edited: WorldBook = {
      ...books[0],
      entries: books[0].entries.map((e, i) =>
        i === 0 ? { ...e, content: `${e.content}（用户编辑）` } : e,
      ),
    };
    const editedLibrary: CurrentLibrary = { worldBooks: [edited, ...books.slice(1)] };
    const plan = planPackInstall(pack, editedLibrary, {}, buildPlaceholderBaseline());
    const conflicts = (plan.sections.worldBooks?.conflicted ?? []) as Array<{ key: string }>;
    expect(conflicts.length).toBeGreaterThan(0);
  });

  // 🔴 2026-08-08 真机回归：pack 的 agentDefaults 是运行时默认层（pack > 占位），
  // 装过 pack 的安装里旧 prompt 就来自这里——必须随 pack 一起守门：
  //   ① memory_summary 不得教模型留空 hiddenLine（空串会被解析器弃掉整条记忆）
  //   ② 各 agent「可用工具」广告的工具名必须 ∈ 工具白名单（幻影工具会废掉整条工具链）
  it('agentDefaults 提示词契约：hiddenLine 非空 + 广告工具 ⊆ 白名单', () => {
    const pack = loadPack();
    const agents = (pack.agentDefaults?.agents ?? {}) as Record<string, { systemPrompt?: string }>;

    const ms = agents.memory_summary?.systemPrompt ?? '';
    expect(ms).toContain('hiddenLine 必须是非空字符串');
    expect(ms).not.toMatch(/hiddenLine[^\n]{0,12}留空/);
    expect(ms).not.toContain('必须留空');

    // 工具广告契约（与 tests/agent-tools-prompt-contract.test.ts 同口径）
    for (const [agentId, entry] of Object.entries(agents)) {
      const prompt = entry?.systemPrompt ?? '';
      const start = prompt.indexOf('可用工具');
      if (start < 0) continue;
      const rest = prompt.slice(start);
      const endMatch = rest.match(/\n\s*\n|\n#/);
      const section = endMatch ? rest.slice(0, endMatch.index) : rest;
      const whitelist = AGENT_TOOL_MAP[agentId] ?? [];
      const advertised = new Set<string>();
      for (const m of section.matchAll(/(?<!<)\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
        advertised.add(m[0]);
      }
      for (const name of advertised) {
        expect(whitelist, `pack agentDefaults.${agentId} 广告了白名单外工具 ${name}`).toContain(
          name,
        );
      }
    }
  });
});

/** 读 POEM_PACK_FILE 指向的 pack（仅在 describeIf 分支内调用） */
function loadPack(): ContentPack {
  if (!PACK_FILE) throw new Error('POEM_PACK_FILE 未设置（不应调用本函数）');
  return JSON.parse(readFileSync(resolve(PACK_FILE), 'utf8')) as ContentPack;
}

describe('pack-install 契约（未设 POEM_PACK_FILE）', () => {
  it('未设时跳过（占位）—— 防止误报全绿', () => {
    expect(true).toBe(true);
  });
});
