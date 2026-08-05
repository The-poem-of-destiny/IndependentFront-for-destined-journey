/**
 * `knip-ratchet.mjs` 的类型声明 —— 让 `tests/knip-ratchet.test.ts` 能在
 * `typecheck:tools`（strict，无 allowJs）下解析这个 .mjs 模块。
 */

export interface KnipIssueRow {
  name?: string;
}

export interface KnipReport {
  issues?: Array<Record<string, unknown> & { file?: string }>;
}

export declare function collectFindings(report: KnipReport): string[];

export declare function compareToBaseline(
  current: string[],
  baseline: string[],
): { added: string[]; resolved: string[] };
