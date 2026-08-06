/**
 * per-Agent 设置的读写口（Q-18；内容-引擎分离波 1 / D44 v1.2 大修）。
 *
 * ── 分层真源（D44 / §5.4）────────────────────────────────────────────
 * 一个 Agent 的有效设置 = **覆写层 ?? 默认层**：
 *   · **覆写层** = `settings.agents[agentId]`（`bag.agents`），只承载**用户显式覆写**。
 *   · **默认层** = pack `agentDefaults` > 占位文件，由调用方从 content-store 解析后
 *     作为 `defaultsLayer` 参数传进来。
 *
 * `settings.agents` 里现在不再由 boot 播种写默认值（那条路径已删 —— 它把默认值
 * 抄进覆写层、看起来像用户改过，新默认永远进不来）。默认值在读取咽喉
 * （`getAgentSettings`）处合并，写入路径只写用户真正改过的 diff。
 *
 * ── 四条修正（v1.2）──────────────────────────────────────────────────
 * 1. **resolve 覆盖全部 12 键**：`getAgentSettings` 加 `defaultsLayer` 参数，
 *    `model/worldBookEnabled/worldBookIds/systemPrompt/template/数值五参/
 *    historyLayers/historySlice` 全部走 `覆写 ?? 默认 ?? AGENT_SETTINGS_DEFAULTS`。
 *    🔴 不给默认层 = 全体 agent 静默失去世界书（删播种后世界书唯一来源就是默认层）。
 * 2. **名册迭代改源**：`listConfiguredAgents` / `updateAgentWorldBookIds` 迭代
 *    **解析名册**（默认层键 ∪ 覆写层键），覆写层为空时工坊装书仍能授权给全名册。
 * 3. **precedence 统一 = 覆写 ?? 默认** + 一次性指纹迁移（`migrateLegacyAgentOverrides`）。
 * 4. **覆写制造面全列改造**：`applyProjectDefaultToAgent` / `resetAgentSettings`
 *    语义改「清该 agent 覆写层」，解析值自动回默认层。
 *
 * 🔴 `agentDirty`（有未保存改动）**刻意不在这里**：它是 UI 状态不是设置。混进条目会
 *    跟着 `saveAsDefault` 一路写进 `data/defaults/agent-config.json`，而那份文件的
 *    形状是 `AgentDefaultEntry` —— 两者刻意同形，别把 UI 状态塞进去。
 */

/** 一个 Agent 的全部可调项 —— 与 `AgentDefaultEntry` 同形（后者是磁盘上的项目默认值） */
export interface AgentSettingsEntry {
  model: string;
  worldBookEnabled: boolean;
  worldBookIds: string[];
  systemPrompt: string;
  template: string;
  temperature: number;
  topP: number;
  freqPen: number;
  presPen: number;
  maxTokens: number;
  /**
   * 历史对话注入层数。
   *
   * 🔴 **必须保持可缺省**：「键不存在」在这里编码的是「按 agent 类别走引擎默认」，
   *    合并会把那条语义静默覆盖掉（引擎按 story / 侧链等类别给的默认各不相同）。
   *    `historySlice` 同理。两层都没有该键时 resolve 返回 `undefined`。
   */
  historyLayers?: number;
  /** 每条历史正文截断字数。缺省语义同 `historyLayers` */
  historySlice?: number;
}

/**
 * 数值旋钮的硬兜底默认值 —— **全应用唯一出现的地方**。
 *
 * 🔴 这是**第三层**兜底（覆写层 → 默认层 → 这里）。默认层（pack/占位）通常会给齐
 *    数值，但当默认层也没给时（例如测试、或 pack 只带了 systemPrompt），数值项落这里。
 *    语义与 v1.1 前 boot 兜底完全一致，只是位置从「写进覆写层」改成「读取时合」。
 */
export const AGENT_SETTINGS_DEFAULTS = {
  temperature: 0.7,
  topP: 1.0,
  freqPen: 0,
  presPen: 0,
  maxTokens: 16384,
} as const;

/** settings 袋子（settings-store 的 `settings.value`） */
type SettingsBag = Record<string, any>;

/** 默认层形状：调用方从 content-store 解析出的 per-agent 默认（pack > 占位） */
export type AgentDefaultsLayer = Record<string, Partial<AgentSettingsEntry>>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 只读取覆写层，绝不建结构 —— 读一个从没配过的 agent 不该在袋子里留下空壳 */
function peek(bag: SettingsBag, agentId: string): Record<string, unknown> | null {
  const agents = bag.agents;
  if (!isPlainObject(agents)) return null;
  const entry = agents[agentId];
  return isPlainObject(entry) ? entry : null;
}

/** 写入用：缺哪层补哪层 */
function ensure(bag: SettingsBag, agentId: string): Record<string, unknown> {
  if (!isPlainObject(bag.agents)) bag.agents = {};
  const agents = bag.agents as Record<string, unknown>;
  if (!isPlainObject(agents[agentId])) agents[agentId] = {};
  return agents[agentId] as Record<string, unknown>;
}

/** 读覆写层单个字段 */
function readOverride<T>(
  bag: SettingsBag,
  agentId: string,
  field: keyof AgentSettingsEntry,
): T | undefined {
  const entry = peek(bag, agentId);
  return entry ? (entry[field] as T | undefined) : undefined;
}

/** 读默认层单个字段 */
function readDefault<T>(
  layer: AgentDefaultsLayer | undefined,
  agentId: string,
  field: keyof AgentSettingsEntry,
): T | undefined {
  if (!layer) return undefined;
  const entry = layer[agentId];
  if (!isPlainObject(entry)) return undefined;
  return entry[field] as T | undefined;
}

/** 第一级非 undefined 获胜（`??` 链的函数化，便于 12 键统一） */
function resolve<T>(...values: (T | undefined)[]): T | undefined {
  for (const v of values) {
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * 取一个 Agent 的完整设置 —— **唯一读取咽喉**（D44 修正 1）。
 *
 * 12 键全部走 `覆写层 ?? 默认层 ?? 兜底`：
 *   · 数值五参（temperature/topP/freqPen/presPen/maxTokens）兜底 `AGENT_SETTINGS_DEFAULTS`
 *   · 字符串（model/systemPrompt/template）兜底 `''`
 *   · 布尔（worldBookEnabled）兜底 `false`
 *   · 数组（worldBookIds）兜底 `[]`（永远返回副本）
 *   · historyLayers/historySlice **无兜底**：两层都没该键 → `undefined`
 *     （编码「按 agent 类别走引擎默认」，合默认会静默盖掉那条语义）
 *
 * 🔴 不传 `defaultsLayer` 时退回**纯覆写层 + 兜底** —— 与 v1.1 行为一致，给测试与
 *    旧调用方一个安全退化。但生产路径（game-pipeline / 设置页）**必须**传默认层，
 *    否则删播种后世界书/model/数值全静默丢失。
 *
 * `defaultsLayer` 的来源：`content-store` 解析出的 pack > 占位 agentDefaults
 * （settings-store 经 `projectAgentDefaults` 暴露）。调用方取 `layer[agentId]` 传入。
 */
export function getAgentSettings(
  bag: SettingsBag,
  agentId: string,
  defaultsLayer?: AgentDefaultsLayer,
): AgentSettingsEntry {
  const layer = defaultsLayer;
  return {
    model: resolve(readOverride(bag, agentId, 'model'), readDefault(layer, agentId, 'model')) ?? '',
    worldBookEnabled:
      resolve(
        readOverride<boolean>(bag, agentId, 'worldBookEnabled'),
        readDefault<boolean>(layer, agentId, 'worldBookEnabled'),
      ) ?? false,
    worldBookIds: [
      ...(resolve(
        readOverride<string[]>(bag, agentId, 'worldBookIds'),
        readDefault<string[]>(layer, agentId, 'worldBookIds'),
      ) ?? []),
    ],
    systemPrompt:
      resolve(
        readOverride<string>(bag, agentId, 'systemPrompt'),
        readDefault<string>(layer, agentId, 'systemPrompt'),
      ) ?? '',
    template:
      resolve(
        readOverride<string>(bag, agentId, 'template'),
        readDefault<string>(layer, agentId, 'template'),
      ) ?? '',
    temperature:
      resolve(
        readOverride<number>(bag, agentId, 'temperature'),
        readDefault<number>(layer, agentId, 'temperature'),
      ) ?? AGENT_SETTINGS_DEFAULTS.temperature,
    topP:
      resolve(
        readOverride<number>(bag, agentId, 'topP'),
        readDefault<number>(layer, agentId, 'topP'),
      ) ?? AGENT_SETTINGS_DEFAULTS.topP,
    freqPen:
      resolve(
        readOverride<number>(bag, agentId, 'freqPen'),
        readDefault<number>(layer, agentId, 'freqPen'),
      ) ?? AGENT_SETTINGS_DEFAULTS.freqPen,
    presPen:
      resolve(
        readOverride<number>(bag, agentId, 'presPen'),
        readDefault<number>(layer, agentId, 'presPen'),
      ) ?? AGENT_SETTINGS_DEFAULTS.presPen,
    maxTokens:
      resolve(
        readOverride<number>(bag, agentId, 'maxTokens'),
        readDefault<number>(layer, agentId, 'maxTokens'),
      ) ?? AGENT_SETTINGS_DEFAULTS.maxTokens,
    // 不兜底：两层都缺 → undefined（编码「按类别走引擎默认」）
    historyLayers: resolve(
      readOverride<number>(bag, agentId, 'historyLayers'),
      readDefault<number>(layer, agentId, 'historyLayers'),
    ),
    historySlice: resolve(
      readOverride<number>(bag, agentId, 'historySlice'),
      readDefault<number>(layer, agentId, 'historySlice'),
    ),
  };
}

/**
 * 改一个 Agent 的若干项（写进**覆写层**）。
 *
 * `undefined` 表示**删掉这个键**而不是写入 undefined —— 对
 * `historyLayers` / `historySlice` 来说这两件事语义不同（后者会让「键存在」成立，
 * 从而挡掉引擎默认）。
 */
export function patchAgentSettings(
  bag: SettingsBag,
  agentId: string,
  patch: Partial<AgentSettingsEntry>,
): void {
  const entry = ensure(bag, agentId);
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete entry[field];
    else entry[field] = value;
  }
}

/**
 * **清空**一个 Agent 的覆写层（D44 修正 4）。
 *
 * 语义变化：v1.1 前「恢复默认」会把来源值**写进覆写层**；现在改为**删掉覆写层里该
 * agent 的整条**——解析值（`getAgentSettings`）自动回默认层（pack > 占位），无需把
 * 默认值抄进覆写层。这样 pack 后续版本能持续够到这个 agent（不会被抄死的旧默认挡住）。
 *
 * story 分支的预设由调用方（AgentConfigPanel）单独处理（恢复 pack 预设 + activePresetId），
 * 本函数不碰预设——它只负责清覆写层条目。
 */
export function resetAgentSettings(bag: SettingsBag, agentId: string): void {
  if (!isPlainObject(bag.agents)) return;
  const agents = bag.agents as Record<string, unknown>;
  delete agents[agentId];
}

/**
 * 把一个**非 story** Agent 拉到「最新默认」—— v1.2 起语义改「清覆写层」
 * （D44 修正 4）。
 *
 * 与 `resetAgentSettings` 的区别：本函数**保留 `model`**（用户自己选的 API 池不该被
 * 默认值覆盖），只清其余字段；model 也清的话等于连 API 选择都抹掉。这是「恢复默认」/
 * 「恢复成最新」按钮的既有语义，也是「覆写差异面板」批量清除用的同一套逻辑 ——
 * 两处复用本函数，避免漂移。
 *
 * 🔴 不处理 story：story 的提示词是预设（`prompts[]`），走 PresetManager 那条分叉。
 *    story 的「恢复默认」在 AgentConfigPanel 里单独处理。
 */
export function applyProjectDefaultToAgent(bag: SettingsBag, agentId: string): void {
  // 保留 model（用户选的 API 池），清其余覆写字段 → 解析值回默认层
  const model = readOverride<string>(bag, agentId, 'model');
  if (!isPlainObject(bag.agents)) {
    // 覆写层本就空 —— 没东西可清
    return;
  }
  const agents = bag.agents as Record<string, unknown>;
  if (!isPlainObject(agents[agentId])) {
    // 该 agent 没有覆写条目 —— 解析值已经走默认层，无需动作
    return;
  }
  if (model !== undefined) {
    // 只留 model，其余清光
    agents[agentId] = { model };
  } else {
    delete agents[agentId];
  }
}

/**
 * 列出**解析名册**（D44 修正 2）—— 默认层键 ∪ 覆写层键。
 *
 * 🔴 必须传默认层（生产路径），否则工坊装书在覆写层为空时会**授权给零个 agent**
 *    且无报错——用户看到的是「装了等于没装」。
 *
 * 测试与不关心名册的旧调用方可不传默认层（退回纯覆写层键）。
 */
export function listConfiguredAgents(
  bag: SettingsBag,
  defaultsLayer?: AgentDefaultsLayer,
): string[] {
  const overrideKeys = isPlainObject(bag.agents) ? Object.keys(bag.agents) : [];
  const defaultKeys = defaultsLayer ? Object.keys(defaultsLayer) : [];
  return [...new Set([...defaultKeys, ...overrideKeys])];
}

/**
 * 把「所有 Agent 的世界书清单」当成一张 `Record<agentId, string[]>` 来整体改写。
 *
 * 工坊装/卸要给**每个** Agent 的清单加/删同一个 bookId，那两个纯函数
 * （`grantWorkshopBookToAgents` / `revokeWorkshopBookFromAgents`）本来就是按
 * 「一张 map 进、一张 map 出」写的。合并之后 map 不再存在，但**没必要**把它们改成
 * 认 `agents` —— 那会把工坊的纯函数绑死在设置的存储形状上。于是投影这一步收在这里：
 * 读出来一张 map、交给调用方变换、再写回条目。
 *
 * 🔴 D44 修正 2：投影名册必须是**解析名册**（默认层 ∪ 覆写层），否则覆写层为空时
 *    工坊装书授权给零个 agent。调用方（workshop-store）必须传默认层。
 *
 * 只动 `worldBookIds`，其余字段一个不碰（`worldBookEnabled` 尤其不能顺手开 ——
 * 见 `grantWorkshopBookToAgents` 的注释）。
 */
export function updateAgentWorldBookIds(
  bag: SettingsBag,
  transform: (current: Record<string, string[]>) => Record<string, string[]>,
  defaultsLayer?: AgentDefaultsLayer,
): void {
  const roster = listConfiguredAgents(bag, defaultsLayer);
  const current: Record<string, string[]> = {};
  for (const agentId of roster) {
    const override = readOverride<string[]>(bag, agentId, 'worldBookIds');
    if (override !== undefined) {
      current[agentId] = Array.isArray(override) ? [...override] : [];
    } else {
      const def = readDefault<string[]>(defaultsLayer, agentId, 'worldBookIds');
      current[agentId] = Array.isArray(def) ? [...def] : [];
    }
  }
  const next = transform(current);
  for (const [agentId, ids] of Object.entries(next)) {
    patchAgentSettings(bag, agentId, { worldBookIds: [...ids] });
  }
}

// ═══════════════════════════════════════════════════════════════
// D44 修正 3：历史默认值指纹迁移
// ═══════════════════════════════════════════════════════════════

/**
 * 历史默认值指纹表 —— 由 `scripts/build-agent-fingerprints.mjs` 从
 * `data/defaults/agent-config.json` 生成（逐 agent 逐字段 SHA-256）。
 *
 * 指纹不泄内容（SHA-256 不可逆）。覆盖 12 键里 agent-config.json 真的有的字段。
 * 未来新默认版本由私有构建重新跑生成脚本补指纹。
 */
import fingerprintsJson from '@engine/agent-defaults-fingerprints.json';

/** { agentId: { field: sha256hex } } */
type FingerprintTable = Record<string, Record<string, string>>;
const FINGERPRINTS: FingerprintTable = fingerprintsJson as FingerprintTable;

/** 与生成脚本同口径：sha256(JSON.stringify(value)) */
function fingerprintValue(value: unknown): string {
  // 浏览器侧没有 node:crypto —— 用 Web Crypto 的同步回退（仅用于迁移期一次性比对）。
  // 测试环境（node）走 node:crypto；二者口径必须一致（都吃 JSON.stringify 后的 utf8）。
  // 这里用一个纯 JS SHA-256 实现，避免异步 + 环境差异。
  return sha256Hex(JSON.stringify(value));
}

/**
 * 一次性迁移：扫描覆写层，命中历史默认指纹的键**删除**（D44 修正 3）。
 *
 * 触发时机：首启（settings-store 构造期，在 loadAgentProjectDefaults 之后）。
 * 后果：旧 boot 播种抄进去的默认值被清掉，默认层接管；用户真正改过的值（指纹不匹配）保留。
 *
 * @returns 被清除的 `{ agentId: field[] }` 列表，供调用方上报与测试断言
 */
export function migrateLegacyAgentOverrides(bag: SettingsBag): Record<string, string[]> {
  const cleared: Record<string, string[]> = {};
  if (!isPlainObject(bag.agents)) return cleared;
  const agents = bag.agents as Record<string, unknown>;
  for (const [agentId, entry] of Object.entries(agents)) {
    if (!isPlainObject(entry)) continue;
    const fpRow = FINGERPRINTS[agentId];
    if (!fpRow) continue; // agent-config.json 没这个 agent —— 没指纹可比
    const clearedFields: string[] = [];
    for (const field of Object.keys(entry)) {
      const fp = fpRow[field];
      if (!fp) continue; // 该字段没指纹（agent-config.json 里没有）—— 保留
      if (fingerprintValue(entry[field]) === fp) {
        clearedFields.push(field);
      }
    }
    if (clearedFields.length > 0) {
      cleared[agentId] = clearedFields;
    }
  }
  // 第二趟：真正删键（不能边迭代边删 Object.keys 的结果——先算后删）
  for (const [agentId, fields] of Object.entries(cleared)) {
    const entry = agents[agentId] as Record<string, unknown>;
    for (const f of fields) delete entry[f];
    // 整条空了就删掉，免得覆写层留一堆空壳
    if (Object.keys(entry).length === 0) delete agents[agentId];
  }
  return cleared;
}

// ── 纯 JS SHA-256（同步、无依赖、跨 node/浏览器同口径）────────────
// 移植自 FIPS 180-4 参考实现。仅需满足「同一 JSON 串同口径 hash」，
// 不涉及密码学强度（指纹表本身就是不可逆摘要）。
function sha256Hex(utf8: string): string {
  const bytes = new TextEncoder().encode(utf8);
  return sha256Bytes(bytes);
}

function sha256Bytes(bytes: Uint8Array): string {
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const len = bytes.length;
  const bitLen = len * 8;
  // 填充：0x80 + 0x00... + 8 字节大端长度，对齐到 64 字节
  const padLen = ((len + 9 + 63) >>> 6) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[len] = 0x80;
  // 高 32 位（JS 位运算 32 位，length 不会超 2^32-1 时高 32 位为 0）
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, bitLen >>> 0, false);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);

  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < padLen; i += 64) {
    const w = new Array(64);
    for (let j = 0; j < 16; j++) {
      w[j] = dv.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + k[j] + w[j]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}
