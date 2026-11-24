/**
 * `analyze-state-writes.mjs` 的类型声明 —— 让 `tests/analyze-state-writes.test.ts` 能在
 * `typecheck:tools`（strict，无 allowJs）下解析这个 .mjs 模块。
 */

export interface StateWriteRecord {
  protocol: 'legacy' | 'tree';
  model: string;
  ops: number;
  applied: number;
  corrected: number;
  dropped: number;
  rejected: boolean;
  updatesMissing: boolean;
}

export interface StateWriteSummaryRow {
  protocol: 'legacy' | 'tree';
  model: string;
  floors: number;
  rejectedRate: number | null;
  droppedPerFloor: number | null;
  dropRate: number | null;
  correctedPerFloor: number | null;
  missingBlockRate: number | null;
}

export declare function collectStateWriteRecords(text: string): {
  format: 'debug' | 'jsonl';
  records: StateWriteRecord[];
  skipped: number;
};

export declare function summarizeStateWriteRecords(
  records: StateWriteRecord[],
): StateWriteSummaryRow[];

export declare function formatStateWriteTable(rows: StateWriteSummaryRow[]): string;
