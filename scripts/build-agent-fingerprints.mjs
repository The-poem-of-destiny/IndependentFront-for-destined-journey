/**
 * build-agent-fingerprints.mjs —— 历史默认值指纹表生成器（D44 修正 3）
 *
 * 为什么存在（内容-引擎分离设计 v1.2 §5.4 修正 3）：
 *   agents 层重设计后 `settings.agents` 只承载**用户显式覆写**，默认层（pack > 占位）
 *   接管提示词/世界书/旋钮。但四位测试者/贡献者的 `settings.agents` 里存着
 *   **旧 boot 播种写进去的默认值**——它们看起来像「用户改过」，其实是 boot 播种抄进去的，
 *   不清掉的话 pack 后续版本永远够不到他们（新默认进不来）。
 *
 *   清掉的判据：**值与历史默认值完全相等**。历史默认值 = 本仓 `data/defaults/agent-config.json`
 *   当前内容（它就是「历史默认」——这个文件是私有内容仓同步来的真实默认）。
 *   为不泄露内容，存的是 SHA-256 指纹（hash 不可逆），逐 agent 逐字段一枚。
 *
 * 生成什么：
 *   `src/sillytavern/agent-defaults-fingerprints.json`，形如
 *   `{ "<agentId>": { "<field>": "<sha256-hex>" } }`，覆盖 `AgentSettingsEntry` 的 12 键
 *   （model / worldBookEnabled / worldBookIds / systemPrompt / template / temperature /
 *    topP / freqPen / presPen / maxTokens / historyLayers / historySlice）。
 *
 *   `preset` / `presetId` 不在 12 键内（它们是磁盘 `AgentDefaultEntry` 形状、不进
 *   `settings.agents` 覆写层），故不指纹——覆写层里没有它们的副本可清。
 *
 * 用法（维护者刷新指纹时跑，CI 不跑）：
 *   node scripts/build-agent-fingerprints.mjs
 *   # 默认从 data/defaults/agent-config.json 读、写 src/sillytavern/agent-defaults-fingerprints.json
 *   node scripts/build-agent-fingerprints.mjs --src <path> --out <path>
 *
 * 🔴 指纹的计算口径必须与 `agent-settings.ts` 里 `migrateLegacyAgentOverrides` 的口径**一字不差**
 *    一致：`sha256(JSON.stringify(value))`。两边漂移 = 迁移命中失败 = 测试者旧覆写清不掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** AgentSettingsEntry 的 12 键 —— 与 src/ui/stores/agent-settings.ts 同源 */
const AGENT_SETTING_FIELDS = [
  'model',
  'worldBookEnabled',
  'worldBookIds',
  'systemPrompt',
  'template',
  'temperature',
  'topP',
  'freqPen',
  'presPen',
  'maxTokens',
  'historyLayers',
  'historySlice',
];

/** 与迁移函数同口径的指纹计算：sha256(JSON.stringify(value)) */
function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function parseArgs(argv) {
  const args = { src: '', out: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') args.src = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const srcPath = args.src || path.join(repoRoot, 'data', 'defaults', 'agent-config.json');
  const outPath =
    args.out || path.join(repoRoot, 'src', 'sillytavern', 'agent-defaults-fingerprints.json');

  const raw = fs.readFileSync(srcPath, 'utf8');
  const config = JSON.parse(raw);
  const agents = config.agents;
  if (!agents || typeof agents !== 'object') {
    throw new Error(`[build-agent-fingerprints] ${srcPath} 缺少 agents 对象`);
  }

  /** { agentId: { field: sha256hex } } —— 只收 12 键里该 agent 真的有的字段 */
  const table = {};
  let agentCount = 0;
  let fieldCount = 0;
  for (const [agentId, entry] of Object.entries(agents)) {
    if (!entry || typeof entry !== 'object') continue;
    const fp = {};
    for (const field of AGENT_SETTING_FIELDS) {
      if (field in entry) {
        fp[field] = fingerprint(entry[field]);
        fieldCount++;
      }
    }
    table[agentId] = fp;
    agentCount++;
  }

  const json = JSON.stringify(table, null, 2) + '\n';
  fs.writeFileSync(outPath, json, 'utf8');
  console.log(
    `[build-agent-fingerprints] ${agentCount} agents / ${fieldCount} field-fingerprints → ${path.relative(repoRoot, outPath)}`,
  );
}

main();
