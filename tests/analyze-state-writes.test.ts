import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectStateWriteRecords,
  formatStateWriteTable,
  summarizeStateWriteRecords,
} from '../scripts/analyze-state-writes.mjs';

/**
 * 状态写入统计离线汇总脚本（§7.1 / T14）：两种输入格式的读取、按 协议 × 模型 的汇总与表格。
 * 夹具在 tests/fixtures/state-writes/，也可直接 `node scripts/analyze-state-writes.mjs <夹具>` 跑。
 */
const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'state-writes', name), 'utf8');

describe('collectStateWriteRecords', () => {
  it('DebugPanel 导出：只取 direct_main 的统计，按 invocationId 去重，无统计的旧记录计跳过', () => {
    const result = collectStateWriteRecords(fixture('fated-poem-debug-sample.json'));
    expect(result.format).toBe('debug');
    expect(result.records).toHaveLength(4);
    expect(result.skipped).toBe(1);
    expect(result.records.map((r) => r.model)).toEqual([
      'deepseek-chat',
      'deepseek-chat',
      'claude-sonnet',
      'deepseek-chat',
    ]);
  });

  it('运行日志 JSONL：跳过 header 与其他事件，payload 带模型名与缺区块标记', () => {
    const result = collectStateWriteRecords(fixture('engine-log-sample.jsonl'));
    expect(result.format).toBe('jsonl');
    expect(result.records).toHaveLength(3);
    expect(result.records[1]).toMatchObject({ protocol: 'legacy', updatesMissing: true });
    expect(result.records[2]).toMatchObject({ rejected: true });
  });

  it('BOM 与坏行不致命', () => {
    const text = '\uFEFF{"type":"header"}\n不是 JSON\n';
    expect(collectStateWriteRecords(text)).toMatchObject({
      format: 'jsonl',
      records: [],
      skipped: 1,
    });
  });
});

describe('summarizeStateWriteRecords', () => {
  it('拒收率按全部楼算，丢弃 / 纠正 / 缺区块按被接纳的楼算，丢弃率按 op 总数算', () => {
    const records = [
      ...collectStateWriteRecords(fixture('fated-poem-debug-sample.json')).records,
      ...collectStateWriteRecords(fixture('engine-log-sample.jsonl')).records,
    ];
    const rows = summarizeStateWriteRecords(records);
    expect(rows.map((r) => `${r.protocol}/${r.model}`)).toEqual([
      'legacy/deepseek-chat',
      'tree/claude-sonnet',
      'tree/deepseek-chat',
      'tree/全部',
    ]);
    const legacy = rows[0];
    expect(legacy.floors).toBe(3);
    expect(legacy.rejectedRate).toBeCloseTo(1 / 3);
    expect(legacy.droppedPerFloor).toBeCloseTo(0.5);
    expect(legacy.dropRate).toBeCloseTo(1 / 6);
    expect(legacy.missingBlockRate).toBeCloseTo(0.5);
    const treeAll = rows[3];
    expect(treeAll.floors).toBe(4);
    expect(treeAll.dropRate).toBeCloseTo(1 / 11);
    expect(treeAll.correctedPerFloor).toBeCloseTo(2 / 3);
  });

  it('全是拒收的分组：比率分母为 0 时给 null，表格显示 —', () => {
    const rows = summarizeStateWriteRecords([
      {
        protocol: 'tree',
        model: 'm',
        ops: 0,
        applied: 0,
        corrected: 0,
        dropped: 0,
        rejected: true,
        updatesMissing: false,
      },
    ]);
    expect(rows[0]).toMatchObject({ rejectedRate: 1, dropRate: null, droppedPerFloor: null });
    const table = formatStateWriteTable(rows);
    expect(table.split('\n')).toHaveLength(3);
    expect(table).toContain('100.0%');
    expect(table).toContain('—');
  });
});
