#!/usr/bin/env node
/**
 * build-placeholder-hashes.mjs —— 占位内容集的逐项 hash 清单构建器（内容-引擎分离 T15）。
 *
 * 设计: `docs/planning/2026-08-05-content-engine-separation-design.md` §6 / D20 / D42。
 *
 * ## 它产出什么
 *
 * `placeholder-hashes.json`（默认 `src/sillytavern/placeholder-hashes.json`）:
 *
 * ```jsonc
 * {
 *   "version": "1.0.0",              // 占位集版本戳（D42：戳前进才重播种）
 *   "byBook": { "world_setting": "…" },       // 15 本占位世界书逐本 hash
 *   "byPreset": { "placeholder-story-v1": "…" },
 *   "byBeautifierRule": { "demo-dialogue": "…" },
 *   "bySection": { "content/catalog": "…" }   // 其余占位件逐文件 hash
 * }
 * ```
 *
 * ## 为什么随引擎打包、而不是运行时现算
 *
 * 🔴 D20 裁定：占位基线**不许运行时从 `/data/*` 现算**。`POEM_CONTENT_DIR` overlay 生效时
 * `/data/*` 服务的是**真实内容树**，现算会把作者刚编辑的真书误判成「未动过的占位」而静默
 * 覆盖。这份清单是 D20 四态基线、D42 重播种、卸载 re-seed 三处的**共同输入**。
 *
 * ## hash 算法与引擎侧的一致性
 *
 * 🔴 本文件里的 `hashContentDeterministic` / `hashWorldBook` / `stableSerialize` 是
 * `src/sillytavern/content-source.ts` 与 `content-pack-plan.ts` 里同名函数的**逐行等价复刻**
 * （构建脚本是 `.mjs`，不能 import TS 源）。一致性不靠自觉，靠
 * `tests/build-placeholder-hashes.test.ts` —— 它同时 import 本脚本与那两个 TS 模块，
 * 对同一批输入断言两侧产出**同一个 hash 串**。改动任一侧而不改另一侧，那条测试立刻变红。
 * 若失守，D20 的四态基线会把每一本未动过的占位书都判成「已改」→ 首次装包全线冲突确认。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/build-placeholder-hashes.mjs                       # 默认输入 data/placeholder
 * node scripts/build-placeholder-hashes.mjs --input public/data   # 波 4 换输入根重跑
 * node scripts/build-placeholder-hashes.mjs --version 1.1.0       # 占位集升版（D42 触发重播种）
 * node scripts/build-placeholder-hashes.mjs --out /tmp/x.json --quiet
 * ```
 *
 * 🔴 **输入目录参数化是硬要求**：波 4 会把占位树搬到 `public/data`，届时只换 `--input`
 * 重跑，不改脚本。故本脚本内**不许**出现写死的 `data/placeholder`（除了默认值那一处常量）。
 *
 * 🔴 **缺文件跳过、不崩**：T15 与 T16 并行产出，跑脚本时 T16 那批占位件可能尚未落地。
 * 缺失项计入 `skipped` 并打印，退出码仍为 0。
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

/** 默认输入根（波 4 换成 `public/data`，走 `--input` 而不是改这里） */
export const DEFAULT_INPUT_DIR = 'data/placeholder';

/** 默认输出文件（随引擎打包，D20：不进内容树，overlay 覆盖不到） */
export const DEFAULT_OUTPUT_FILE = 'src/sillytavern/placeholder-hashes.json';

/**
 * 占位集版本戳（D42）。
 *
 * 🔴 **不许用时间戳/构建号**：settings 里存的 `placeholderVersion` 与它比对，戳一前进就对
 * 「hash 仍等于占位基线」的书重播种。每次构建都变的戳 = 每次发版都重播种一遍。
 * 只有真的改了占位内容时才手工推进这个常量（或用 `--version` 覆盖）。
 */
export const PLACEHOLDER_VERSION = '1.0.0';

// ═══════════════════════════════════════════════════════════
// hash 工具（引擎侧同名函数的等价复刻，见文件头「一致性」一节）
// ═══════════════════════════════════════════════════════════

/**
 * 内容正文的确定性 hash（同步，不依赖 `crypto.subtle`）。
 *
 * 与 `src/sillytavern/content-source.ts` 的 `hashContentDeterministic` **逐行等价**：
 * 双种子 FNV-1a 32 位拼成 16 位十六进制。长度也进哈希，故截断/追加空白可被区分。
 *
 * @param {string} content
 * @returns {string} 16 位十六进制
 */
export function hashContentDeterministic(content) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((code << 5) | (code >>> 11)), 0x85ebca6b) >>> 0;
  }
  h2 = Math.imul(h2 ^ content.length, 0xc2b2ae35) >>> 0;
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 一本世界书的确定性 hash。
 *
 * 与 `content-source.ts` 的 `hashWorldBook` **逐行等价**：条目按 uid 稳定排序后，只拼
 * **内容语义**字段（`id`/`name`/`partition`/`builtIn` 与条目 `uid` 都不进 —— 那些是稳定标识，
 * hash 只回答「正文被人改过吗」）。
 *
 * @param {{ entries?: Array<Record<string, unknown>> }} book
 * @returns {string}
 */
export function hashWorldBook(book) {
  const entries = [...(book.entries ?? [])].sort((a, b) => Number(a.uid) - Number(b.uid));
  const payload = entries
    .map(
      (e) =>
        `${e.name} ${e.enabled ? 1 : 0} ${e.content} ${(e.key ?? []).join(',')} ${e.selectiveLogic} ${e.order}`,
    )
    .join('');
  return hashContentDeterministic(payload);
}

/**
 * 键稳定排序的 JSON 友好形状（与 `content-pack-plan.ts` 的 `stableSerialize` 等价）。
 *
 * 对象键按字典序递归排序；数组保持顺序（顺序是语义的一部分）；原始值原样返回。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function stableSerialize(value) {
  if (Array.isArray(value)) return value.map(stableSerialize);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stableSerialize(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * 预设整行 hash（与 `content-pack-plan.ts` 的 `hashPresetRow` 等价：只取 id/name/settings）。
 *
 * @param {{ id: string, name?: string, settings?: unknown }} preset
 * @returns {string}
 */
export function hashPresetRow(preset) {
  return hashContentDeterministic(
    JSON.stringify(
      stableSerialize({ id: preset.id, name: preset.name, settings: preset.settings }),
    ),
  );
}

/**
 * 美化规则整行 hash（与 `content-pack-plan.ts` 的 `hashRuleRow` 等价：整行进 hash）。
 *
 * @param {Record<string, unknown>} rule
 * @returns {string}
 */
export function hashRuleRow(rule) {
  return hashContentDeterministic(JSON.stringify(stableSerialize(rule)));
}

/**
 * 任意占位件文件的整份 hash（`bySection` 用）。
 *
 * 走 `stableSerialize` 而不是直接 hash 文件字节：重排 JSON 键、改缩进都不该被判成「内容变了」。
 *
 * @param {unknown} json 已 parse 的 JSON 值
 * @returns {string}
 */
export function hashJsonValue(json) {
  return hashContentDeterministic(JSON.stringify(stableSerialize(json)));
}

// ═══════════════════════════════════════════════════════════
// 采集
// ═══════════════════════════════════════════════════════════

/**
 * `bySection` 扫描的目录（相对输入根）—— 目录下每个 `*.json` 各得一枚 hash。
 *
 * 🔴 **按目录扫、不按文件名列表扫**（2026-08-06 修订）：初版写死了一张七项清单，而占位件是
 * 并行任务产出的、数量还会随波次变。清单漏一项的症状是**清单里静悄悄少一个基线**——
 * D20 首装时那一节没有基线可比，D42 也不会重播种它，两处都不报错。目录扫描让「新增一个占位件」
 * 自动进清单，不必记得回来改脚本。
 *
 * 分节键 = 去掉扩展名的相对路径（如 `content/catalog`），与输入根无关，故波 4 换成
 * `public/data` 后键不变。
 */
export const SECTION_DIRS = ['defaults', 'content'];

/**
 * 期望存在的占位件（相对输入根）—— **只用于 skip 报告**，不参与采集。
 *
 * 采集本身是目录扫描（见 {@link SECTION_DIRS}）。这张表的用途是：某个本该有的文件缺席时，
 * 在 `skipped` 里点名说出来，而不是让它无声无息地不出现在清单里。
 */
export const EXPECTED_SECTION_FILES = [
  'defaults/agent-config.json',
  'defaults/map-marker-presets.json',
  'defaults/story-preset.json',
  'defaults/beautifier-rules.json',
  'content/catalog.json',
  'content/locations.json',
  'content/bloodlines.json',
  'content/name-pools.json',
  'content/branding.json',
];

/** 占位 story 预设文件（`byPreset` 来源；同时也进 `bySection`） */
export const PRESET_FILE = 'defaults/story-preset.json';

/** 占位美化规则文件（`byBeautifierRule` 来源；同时也进 `bySection`） */
export const BEAUTIFIER_FILE = 'defaults/beautifier-rules.json';

/**
 * 从占位 story 预设文件里取出预设行数组。
 *
 * 容忍三种形状（T16 尚在并行产出，形状可能微调）:
 * 1. `{ preset: { id, name, settings } }` —— 现行形状（T14 交付）
 * 2. `{ presets: [...] }` / 顶层数组
 * 3. 顶层就是一个 `ChatPreset`（有 `id` + `settings`）
 *
 * 认不出的形状返回 `[]`（记跳过，不猜、不崩）。
 *
 * @param {unknown} json
 * @returns {Array<{ id: string }>}
 */
export function extractPresetRows(json) {
  if (Array.isArray(json)) return json.filter((p) => p && typeof p.id === 'string');
  if (!json || typeof json !== 'object') return [];
  if (json.preset && typeof json.preset === 'object' && typeof json.preset.id === 'string') {
    return [json.preset];
  }
  if (Array.isArray(json.presets)) return json.presets.filter((p) => p && typeof p.id === 'string');
  if (typeof json.id === 'string' && json.settings !== undefined) return [json];
  return [];
}

/**
 * 从占位美化规则文件里取出规则行数组。
 *
 * 容忍 `{ version, rules: [...] }`（现行形状，与 `PackBeautifierRulesSection` 同形）与顶层数组。
 *
 * @param {unknown} json
 * @returns {Array<{ id: string }>}
 */
export function extractRuleRows(json) {
  if (Array.isArray(json)) return json.filter((r) => r && typeof r.id === 'string');
  if (json && typeof json === 'object' && Array.isArray(json.rules)) {
    return json.rules.filter((r) => r && typeof r.id === 'string');
  }
  return [];
}

/**
 * 最小文件系统接口（注入缝，供测试喂内存目录树）。
 *
 * @typedef {{
 *   exists: (p: string) => boolean,
 *   readText: (p: string) => string,
 *   listDir: (p: string) => string[],
 * }} FileReader
 */

/** 真实磁盘实现（生产默认） */
export const nodeFileReader = {
  exists: (p) => existsSync(p),
  readText: (p) => readFileSync(p, 'utf8'),
  listDir: (p) => readdirSync(p),
};

/**
 * 采集整份占位 hash 清单。
 *
 * **纯函数**（除了经 `fs` 注入缝读盘）：同输入永远产同输出，键全部排序，
 * 故重复构建产出**逐字节相同**的文件（否则每次构建都会污染 git diff）。
 *
 * 🔴 **缺文件跳过不崩**：T15/T16 并行，跑脚本时占位件可能只到位一半。缺失项进
 * `skipped`，退出码仍为 0；主会话在 T16 落地后重跑一次补齐。
 * 解析失败同样只记 `skipped`（附错误原文），不中断整份构建 —— 一个坏文件不该让另外
 * 十四本的基线一起产不出来。
 *
 * @param {{ inputDir: string, version?: string, fs?: FileReader }} options
 * @returns {{ manifest: {version: string, byBook: Record<string,string>, byPreset: Record<string,string>, byBeautifierRule: Record<string,string>, bySection: Record<string,string>}, skipped: string[] }}
 */
export function buildPlaceholderManifest({
  inputDir,
  version = PLACEHOLDER_VERSION,
  fs = nodeFileReader,
}) {
  /** @type {string[]} */
  const skipped = [];
  const byBook = {};
  const byPreset = {};
  const byBeautifierRule = {};
  const bySection = {};

  /** 读并 parse 一个 JSON；缺失记跳过、坏文件记跳过，两种都返回 undefined（不抛） */
  const readJson = (relPath) => {
    const abs = join(inputDir, relPath);
    if (!fs.exists(abs)) {
      skipped.push(`${relPath}（文件不存在）`);
      return undefined;
    }
    try {
      return JSON.parse(fs.readText(abs));
    } catch (err) {
      skipped.push(
        `${relPath}（JSON 解析失败: ${err instanceof Error ? err.message : String(err)}）`,
      );
      return undefined;
    }
  };

  /** 目录下的 `*.json`（字典序）；目录不存在返回空数组，不抛 */
  const listJson = (relDir) => {
    const abs = join(inputDir, relDir);
    if (!fs.exists(abs)) return [];
    return fs
      .listDir(abs)
      .filter((f) => f.endsWith('.json'))
      .sort();
  };

  // —— 世界书（byBook）——
  if (!fs.exists(join(inputDir, 'worldbooks'))) {
    skipped.push('worldbooks/（目录不存在）');
  } else {
    for (const file of listJson('worldbooks')) {
      const rel = `worldbooks/${file}`;
      const book = readJson(rel);
      if (!book) continue;
      if (typeof book.id !== 'string' || !book.id) {
        skipped.push(`${rel}（缺 id）`);
        continue;
      }
      byBook[book.id] = hashWorldBook(book);
    }
  }

  // —— 其余占位件逐文件 hash（bySection）——
  // 按目录扫（SECTION_DIRS），新增占位件自动进清单；解析结果缓存给下面两节复用。
  /** @type {Map<string, unknown>} */
  const sectionJson = new Map();
  for (const dir of SECTION_DIRS) {
    for (const file of listJson(dir)) {
      const rel = `${dir}/${file}`;
      const json = readJson(rel);
      if (json === undefined) continue;
      sectionJson.set(rel, json);
      bySection[rel.replace(/\.json$/, '')] = hashJsonValue(json);
    }
  }

  // —— 预设（byPreset）：从上面缓存里取，不重复读盘 ——
  const presetJson = sectionJson.get(PRESET_FILE);
  if (presetJson !== undefined) {
    const rows = extractPresetRows(presetJson);
    if (rows.length === 0) skipped.push(`${PRESET_FILE}（认不出预设形状）`);
    for (const p of rows) byPreset[p.id] = hashPresetRow(p);
  }

  // —— 美化规则（byBeautifierRule）——
  const ruleJson = sectionJson.get(BEAUTIFIER_FILE);
  if (ruleJson !== undefined) {
    const rows = extractRuleRows(ruleJson);
    if (rows.length === 0) skipped.push(`${BEAUTIFIER_FILE}（认不出规则形状）`);
    for (const r of rows) byBeautifierRule[r.id] = hashRuleRow(r);
  }

  // —— 期望存在却缺席的占位件：点名进 skip 报告（采集本身已由目录扫描完成）——
  // 🔴 只报**真的不在盘上**的：解析失败的那些上面已经报过一次，别报第二遍。
  for (const rel of EXPECTED_SECTION_FILES) {
    if (!sectionJson.has(rel) && !fs.exists(join(inputDir, rel))) {
      skipped.push(`${rel}（文件不存在）`);
    }
  }

  return {
    manifest: {
      version,
      byBook: sortKeys(byBook),
      byPreset: sortKeys(byPreset),
      byBeautifierRule: sortKeys(byBeautifierRule),
      bySection: sortKeys(bySection),
    },
    skipped,
  };
}

/** 键字典序重排（保证重复构建产出逐字节相同的 JSON） */
function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// ═══════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════

/**
 * 解析命令行参数（纯函数，可测）。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{ input: string, out: string, version: string, quiet: boolean }}
 */
export function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT_DIR,
    out: DEFAULT_OUTPUT_FILE,
    version: PLACEHOLDER_VERSION,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') opts.input = argv[++i];
    else if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a === '--version' || a === '-v') opts.version = argv[++i];
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else throw new Error(`未知参数: ${a}`);
  }
  if (!opts.input) throw new Error('--input 需要一个目录');
  if (!opts.out) throw new Error('--out 需要一个文件路径');
  if (!opts.version) throw new Error('--version 需要一个版本串');
  return opts;
}

/** CLI 入口（仅在被直接执行时运行，被 import 时不跑） */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inputDir = resolve(REPO_ROOT, opts.input);
  const outFile = resolve(REPO_ROOT, opts.out);

  const { manifest, skipped } = buildPlaceholderManifest({
    inputDir,
    version: opts.version,
  });

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (!opts.quiet) {
    const log = console.log;
    log(`[placeholder-hashes] 输入 ${opts.input} → 输出 ${opts.out}`);
    log(
      `[placeholder-hashes] version=${manifest.version} ` +
        `books=${Object.keys(manifest.byBook).length} ` +
        `presets=${Object.keys(manifest.byPreset).length} ` +
        `rules=${Object.keys(manifest.byBeautifierRule).length} ` +
        `sections=${Object.keys(manifest.bySection).length}`,
    );
    if (skipped.length > 0) {
      log(`[placeholder-hashes] 跳过 ${skipped.length} 项（并行任务尚未落地时属正常）:`);
      for (const s of skipped) log(`  - ${s}`);
    } else {
      log('[placeholder-hashes] 无跳过项');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
