/**
 * `build-placeholder-hashes.mjs` 的类型声明 —— 让 `tests/build-placeholder-hashes.test.ts`
 * 能在 `typecheck:tools`（strict，无 allowJs）下解析这个 .mjs 模块。
 *
 * 照 `knip-ratchet.d.mts` 的先例：只声明测试真正 import 的那些导出。
 */

/** 参与世界书 hash 的条目字段（`WorldBookEntry` 的结构子集） */
export interface HashableEntry {
  uid: number;
  name: string;
  content: string;
  enabled: boolean;
  key: string[];
  selectiveLogic: number;
  order: number;
}

/** 参与 hash 的世界书形状（`WorldBook` 的结构子集） */
export interface HashableBook {
  entries?: HashableEntry[];
}

/** 参与 hash 的预设行（`ChatPreset` 的结构子集） */
export interface HashablePreset {
  id: string;
  name?: string;
  settings?: unknown;
}

/** 最小文件系统接口（注入缝，供测试喂内存目录树） */
export interface FileReader {
  exists(p: string): boolean;
  readText(p: string): string;
  listDir(p: string): string[];
}

/** 采集产出的清单（与 `PlaceholderHashManifest` 的键一一对应，另加 `bySection`） */
export interface PlaceholderHashOutput {
  version: string;
  byBook: Record<string, string>;
  byPreset: Record<string, string>;
  byBeautifierRule: Record<string, string>;
  bySection: Record<string, string>;
}

export const DEFAULT_INPUT_DIR: string;
export const DEFAULT_OUTPUT_FILE: string;
export const PLACEHOLDER_VERSION: string;
export const PRESET_FILE: string;
export const BEAUTIFIER_FILE: string;
export const SECTION_DIRS: readonly string[];
export const EXPECTED_SECTION_FILES: readonly string[];
export const nodeFileReader: FileReader;

export function hashContentDeterministic(content: string): string;
export function hashWorldBook(book: HashableBook): string;
export function stableSerialize(value: unknown): unknown;
export function hashPresetRow(preset: HashablePreset): string;
export function hashRuleRow(rule: Record<string, unknown>): string;
export function hashJsonValue(json: unknown): string;
export function extractPresetRows(json: unknown): HashablePreset[];
export function extractRuleRows(json: unknown): Array<Record<string, unknown> & { id: string }>;

export function buildPlaceholderManifest(options: {
  inputDir: string;
  version?: string;
  fs?: FileReader;
}): { manifest: PlaceholderHashOutput; skipped: string[] };

export function parseArgs(argv: string[]): {
  input: string;
  out: string;
  version: string;
  quiet: boolean;
};
