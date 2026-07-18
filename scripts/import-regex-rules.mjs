/**
 * 导入远程正则规则 → beautifier-rules.json
 *
 * 用法: node scripts/import-regex-rules.mjs
 *
 * 读取 tmp/_regex_remote.json（从 CDN 下载的远程规则），
 * 字段映射为本地 BeautifierRule 格式，合并到 data/defaults/beautifier-rules.json。
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const REMOTE_PATH = resolve(ROOT, 'tmp/_regex_remote.json');
const OUTPUT_PATH = resolve(ROOT, 'data/defaults/beautifier-rules.json');

// ===== 字段映射 =====

/**
 * 解析远程 findRegex 格式 "/pattern/flags" → { pattern, flags }
 */
function parseFindRegex(raw) {
  if (!raw) return { pattern: '', flags: 'g' };
  // 格式: /pattern/flags 或纯字符串
  const m = raw.match(/^\/(.*?)\/([gimsu]*)$/s);
  if (m) {
    return { pattern: m[1], flags: m[2] || 'g' };
  }
  // 纯字符串（无外层斜杠）
  return { pattern: raw, flags: 'g' };
}

/**
 * 从 scriptName 推断 group
 */
function inferGroup(scriptName) {
  const n = scriptName || '';
  if (n.startsWith('长颈鹿')) return '长颈鹿通用';
  const m = n.match(/命定核心[-−](.+?)(美化|对话|技能|车票|咏唱)/);
  if (m) return `命定核心「${m[1]}」`;
  if (n.includes('祷诗')) return '通用';
  if (n.includes('读者对话')) return '通用';
  return '其他';
}

/**
 * 将远程规则转换为本地 BeautifierRule
 */
function convertRule(remote, index) {
  const { pattern, flags } = parseFindRegex(remote.findRegex);
  return {
    id: remote.id,
    name: remote.scriptName || '未命名规则',
    scope: remote.markdownOnly ? 'maintext' : 'global',
    pattern,
    flags,
    replacement: remote.replaceString || '',
    defaultEnabled: !remote.disabled,
    order: (index + 2) * 10, // 10, 20, 30... (0, 1 保留给内置规则)
    isBuiltin: true,
    group: inferGroup(remote.scriptName),
    autoEnable: {},
  };
}

// ===== 主流程 =====

console.log('读取远程规则...');
const remoteData = JSON.parse(readFileSync(REMOTE_PATH, 'utf-8'));
const remoteRules = Array.isArray(remoteData) ? remoteData : (remoteData.rules || []);

console.log(`远程规则数: ${remoteRules.length}`);

// 读取现有文件（保留内置规则）
let existingRules = [];
try {
  const existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8'));
  existingRules = existing.rules || [];
  console.log(`已有规则数: ${existingRules.length}`);
} catch {
  console.log('现有文件不存在，将新建');
}

// 转换远程规则
const converted = remoteRules.map((r, i) => convertRule(r, i));

// 验证所有正则合法
let errors = 0;
for (const r of converted) {
  try {
    new RegExp(r.pattern, r.flags);
  } catch (e) {
    console.error(`  ❌ 规则 "${r.name}" 正则无效: ${e.message}`);
    console.error(`     pattern: ${r.pattern.slice(0, 100)}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n${errors} 条规则正则无效，请手动修复后重试`);
  process.exit(1);
}

// 合并: 内置规则 ID 集合
const builtinIds = new Set(existingRules.filter(r => r.isBuiltin).map(r => r.id));
// 保留非远程的内置规则 + 所有新转换的远程规则
const merged = [
  ...existingRules.filter(r => builtinIds.has(r.id) && !converted.find(c => c.id === r.id)),
  ...converted,
];

const output = {
  version: 1,
  rules: merged,
};

writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
console.log(`\n✅ 写入 ${OUTPUT_PATH}`);
console.log(`   总规则数: ${merged.length} (内置 ${existingRules.filter(r => r.isBuiltin).length} + 远程 ${converted.length})`);

// 输出规则摘要
console.log('\n规则摘要:');
for (const r of merged) {
  const ae = r.autoEnable && Object.keys(r.autoEnable).length > 0 ? ' [已绑定]' : ' [待绑定]';
  console.log(`  ${r.defaultEnabled ? '✅' : '❌'} ${r.name} → ${r.group}${ae}`);
}
