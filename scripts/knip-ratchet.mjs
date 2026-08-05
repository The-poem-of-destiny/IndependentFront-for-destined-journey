#!/usr/bin/env node
/**
 * knip 棘轮闸门 —— 死代码只许变少，不许变多。
 *
 * ## 为什么不是直接 `npx knip` 当闸门
 * 首轮跑出 127 条（6 个未引用文件 + 67 个未引用导出 + 60 个未引用类型）。这些**不都是垃圾**：
 * - 捏人页那 4 个 Vue 组件是 Phase 7d **改造中**的在途件（AGENTS.md 进度表里 7d 仍是 🔄），
 *   删掉等于删同事没写完的活。
 * - 图像生成 v1 才落地两天，`NaiParameters` 这类类型是**刚设计出来的接口面**。
 * 抽样验证过：这批「未引用导出」绝大多数在**本文件内是有用的**，真正的修法是去掉 `export`
 * 关键字而不是删代码 —— 机械但要逐个确认，属于另一次提交。
 *
 * ## 棘轮怎么工作
 * 基线 `knip-baseline.json` 记下每一条已知问题的**身份**（`类型|文件|名字`），不是计数。
 * - 出现基线里没有的条目 → **退出码 1**（这就是「新写的死导出」）
 * - 基线里有、现在没有了 → 只提示「可以收紧基线」，不失败
 * 用身份而非计数，是为了让「修好一条、又新增一条」这种净零变化也能被抓住。
 *
 * 用法：
 *   node scripts/knip-ratchet.mjs            检查（CI 用）
 *   node scripts/knip-ratchet.mjs --update   重写基线（清理完死代码后跑）
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, '..', 'knip-baseline.json');

/** knip 报的问题类型里，我们纳入棘轮的那些。 */
const TRACKED = [
  'files',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'unresolved',
  'binaries',
  'exports',
  'types',
  'enumMembers',
  'namespaceMembers',
  'duplicates',
];

/**
 * knip 的 JSON 报告 → 扁平的问题身份列表。
 *
 * `duplicates` 的形状与其它类型不同：它的每个元素是**一组**同义导出（数组套数组），
 * 得摊平成一个组合名字，否则 `.name` 是 undefined，所有重复导出会挤成同一个身份。
 *
 * @param {{issues?: Array<Record<string, unknown> & {file?: string}>}} report
 * @returns {string[]} 形如 `exports|src/a.ts|foo` 的身份，已排序去重
 */
export function collectFindings(report) {
  const found = new Set();
  for (const issue of report?.issues ?? []) {
    const file = issue.file ?? '<unknown>';
    for (const type of TRACKED) {
      const rows = issue[type];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const name = Array.isArray(row)
          ? row.map((r) => r?.name ?? '?').join('+')
          : (row?.name ?? '?');
        found.add(`${type}|${file}|${name}`);
      }
    }
  }
  return [...found].sort();
}

/**
 * 把当前发现与基线比对。
 *
 * @param {string[]} current
 * @param {string[]} baseline
 * @returns {{added: string[], resolved: string[]}}
 */
export function compareToBaseline(current, baseline) {
  const known = new Set(baseline);
  const live = new Set(current);
  return {
    added: current.filter((item) => !known.has(item)),
    resolved: baseline.filter((item) => !live.has(item)),
  };
}

function runKnip() {
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['knip', '--reporter', 'json', '--no-exit-code'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' },
  );

  if (result.error) throw result.error;

  // BOM 防御：Windows 上任何一层管道都可能在前面塞一个 U+FEFF，JSON.parse 会当场报错。
  const raw = (result.stdout ?? '').replace(/^﻿/, '').trim();
  if (!raw) {
    throw new Error(`knip 没有输出 JSON。stderr:\n${result.stderr}`);
  }
  return JSON.parse(raw);
}

function main() {
  const update = process.argv.includes('--update');
  const findings = collectFindings(runKnip());

  if (update) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(findings, null, 2)}\n`, 'utf8');
    console.log(`基线已更新：${findings.length} 条`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`缺少基线文件 ${BASELINE_PATH}，先跑一次 --update`);
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const { added, resolved } = compareToBaseline(findings, baseline);

  if (resolved.length > 0) {
    console.log(`✅ 已清理 ${resolved.length} 条，跑 \`npm run knip:update\` 收紧基线：`);
    for (const item of resolved.slice(0, 20)) console.log(`   - ${item}`);
    if (resolved.length > 20) console.log(`   …还有 ${resolved.length - 20} 条`);
  }

  if (added.length > 0) {
    console.error(`\n❌ 新增 ${added.length} 条死代码（基线是 ${baseline.length} 条）：`);
    for (const item of added) console.error(`   + ${item}`);
    console.error(
      '\n要么删掉/接上它，要么——确属有意保留时——跑 `npm run knip:update` 并在提交信息里说明理由。',
    );
    process.exit(1);
  }

  console.log(`knip 棘轮通过：${findings.length} 条已知问题，无新增。`);
}

// 只有直接执行时才跑；被测试 import 时不跑。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
