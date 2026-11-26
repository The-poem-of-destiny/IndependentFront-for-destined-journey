#!/usr/bin/env node
/**
 * 状态写入统计的离线汇总（状态树协议设计 §7.1 / T14）—— 只作参考，不做任何门槛判定。
 *
 * ## 输入（两种都认，可一次给多个文件）
 * - DebugPanel 导出的 `fated-poem-debug-*.json`：取 `agentHistory[].entries[]`（缺席时退回
 *   `agentLog[]`）里 `agentId === 'direct_main'` 且带 `stateWriteStats` 的记录，按 `invocationId`
 *   去重；模型名取记录的 `model`。没有 `stateWriteStats` 的直出记录（统计上线前的旧记录）只计数跳过。
 * - 完整运行日志 JSONL（设置 → 开发者模式 → 完整运行日志 → 导出）：首行 header，其余每行一条
 *   日志；取 `cat === 'state.write_stats'` 的行，payload 即统计本身（另带 `model`）。
 *
 * ## 指标（按 协议 × 模型 分组，另给每个协议的合计行）
 * - 楼数：统计条数（含整楼拒收）。
 * - 整楼拒收率：rejected ÷ 楼数。
 * - 每楼丢弃 / 每楼纠正：Σdropped / Σcorrected ÷ 被接纳的楼数。
 * - 丢弃率：Σdropped ÷ Σops（被接纳的楼）。
 * - 缺区块率：updatesMissing ÷ 被接纳的楼数。
 * 各字段口径见 `src/core/agents/direct-write-stats.ts` 的 `summarizeStateWrites`。
 *
 * 用法：
 *   node scripts/analyze-state-writes.mjs <文件> [<文件> …]
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 一条统计是否形状可用（数字字段齐全、协议认得） */
function isStats(value) {
  if (!value || typeof value !== 'object') return false;
  return (
    (value.protocol === 'legacy' || value.protocol === 'tree') &&
    ['ops', 'applied', 'corrected', 'dropped'].every((key) => Number.isFinite(value[key])) &&
    typeof value.rejected === 'boolean'
  );
}

function toRecord(stats, model) {
  return {
    protocol: stats.protocol,
    model: typeof model === 'string' && model ? model : '（未知）',
    ops: stats.ops,
    applied: stats.applied,
    corrected: stats.corrected,
    dropped: stats.dropped,
    rejected: stats.rejected,
    updatesMissing: stats.updatesMissing === true,
  };
}

/** DebugPanel 导出 → 统计记录 */
function fromDebugExport(data) {
  const entries = Array.isArray(data.agentHistory)
    ? data.agentHistory.flatMap((turn) => (Array.isArray(turn?.entries) ? turn.entries : []))
    : Array.isArray(data.agentLog)
      ? data.agentLog
      : [];
  const seen = new Set();
  const records = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry || entry.agentId !== 'direct_main') continue;
    const key = entry.invocationId;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (isStats(entry.stateWriteStats)) records.push(toRecord(entry.stateWriteStats, entry.model));
    else skipped += 1;
  }
  return { format: 'debug', records, skipped };
}

/** 运行日志 JSONL → 统计记录 */
function fromJsonl(text) {
  const records = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!row || row.cat !== 'state.write_stats') continue;
    const payload = typeof row.payload === 'string' ? safeParse(row.payload) : row.payload;
    if (isStats(payload)) records.push(toRecord(payload, payload.model));
    else skipped += 1;
  }
  return { format: 'jsonl', records, skipped };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 读一份文件的文本，自动判别格式。整段是一个带 `agentHistory` / `agentLog` 的 JSON 对象 →
 * DebugPanel 导出；否则按 JSONL 逐行读。
 */
export function collectStateWriteRecords(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const whole = safeParse(clean);
  if (whole && typeof whole === 'object' && ('agentHistory' in whole || 'agentLog' in whole))
    return fromDebugExport(whole);
  return fromJsonl(clean);
}

function aggregate(protocol, model, records) {
  const accepted = records.filter((r) => !r.rejected);
  const sum = (key) => accepted.reduce((total, r) => total + r[key], 0);
  const ratio = (num, den) => (den > 0 ? num / den : null);
  return {
    protocol,
    model,
    floors: records.length,
    rejectedRate: ratio(records.length - accepted.length, records.length),
    droppedPerFloor: ratio(sum('dropped'), accepted.length),
    dropRate: ratio(sum('dropped'), sum('ops')),
    correctedPerFloor: ratio(sum('corrected'), accepted.length),
    missingBlockRate: ratio(accepted.filter((r) => r.updatesMissing).length, accepted.length),
  };
}

/** 按 协议 × 模型 汇总；每个协议末尾追加一行合计（model = '全部'） */
export function summarizeStateWriteRecords(records) {
  const rows = [];
  for (const protocol of ['legacy', 'tree']) {
    const ofProtocol = records.filter((r) => r.protocol === protocol);
    if (ofProtocol.length === 0) continue;
    const models = [...new Set(ofProtocol.map((r) => r.model))].sort();
    for (const model of models)
      rows.push(
        aggregate(
          protocol,
          model,
          ofProtocol.filter((r) => r.model === model),
        ),
      );
    if (models.length > 1) rows.push(aggregate(protocol, '全部', ofProtocol));
  }
  return rows;
}

/** 终端显示宽度：CJK 与全角字符计 2 */
function displayWidth(text) {
  let width = 0;
  for (const ch of text)
    width +=
      /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(
        ch,
      )
        ? 2
        : 1;
  return width;
}

function pad(text, width, right) {
  const gap = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return right ? gap + text : text + gap;
}

const pct = (value) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
const num = (value) => (value === null ? '—' : value.toFixed(2));

/** 汇总行 → 一张对齐的文本表 */
export function formatStateWriteTable(rows) {
  const header = [
    '协议',
    '模型',
    '楼数',
    '整楼拒收率',
    '每楼丢弃',
    '丢弃率',
    '每楼纠正',
    '缺区块率',
  ];
  const body = rows.map((row) => [
    row.protocol,
    row.model,
    String(row.floors),
    pct(row.rejectedRate),
    num(row.droppedPerFloor),
    pct(row.dropRate),
    num(row.correctedPerFloor),
    pct(row.missingBlockRate),
  ]);
  const widths = header.map((_, i) =>
    Math.max(displayWidth(header[i]), ...body.map((cells) => displayWidth(cells[i]))),
  );
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i], i >= 2)).join(' | ');
  const rule = widths.map((w) => '-'.repeat(w)).join('-+-');
  return [line(header), rule, ...body.map(line)].join('\n');
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error(
      '用法：node scripts/analyze-state-writes.mjs <fated-poem-debug-*.json | 运行日志.jsonl> …',
    );
    process.exit(1);
  }
  const records = [];
  for (const file of files) {
    const result = collectStateWriteRecords(readFileSync(file, 'utf8'));
    records.push(...result.records);
    const label = result.format === 'debug' ? 'DebugPanel 导出' : '运行日志 JSONL';
    const note = result.skipped > 0 ? `，跳过 ${result.skipped} 条（无统计或形状不对）` : '';
    console.log(`${basename(file)}：${label}，${result.records.length} 楼${note}`);
  }
  if (records.length === 0) {
    console.log('没有找到任何状态写入统计。');
    return;
  }
  console.log('');
  console.log(formatStateWriteTable(summarizeStateWriteRecords(records)));
  console.log('');
  console.log('只作参考：口径见 src/core/agents/direct-write-stats.ts 的 summarizeStateWrites。');
}

// 只有直接执行时才跑；被测试 import 时不跑。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
