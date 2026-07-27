/**
 * audio-names.ts — 音频实体的按名寻址 (Phase Audio)
 *
 * 为什么存在: AudioTrack / AudioPlaylist 此前只能按 id 寻址，但 UI 与用户
 * 心智里的锚点是**名字**。本模块提供唯一的名字归一化口径 + 查找/占用/去重
 * 三个纯函数，让"按名字找"和"名字唯一"在全项目只有一套规则。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无 AudioContext。仅 import 本模块
 * 不触碰任何浏览器全局 —— `src/sillytavern/` 必须在 vitest
 * environment:'node' 下可导入。
 *
 * 唯一性口径: 唯一性只对**新写入**生效。历史上已存在的重名行刻意不动，
 * 因此 findByName 必须在多命中时给出稳定答案（最早 createdAt，再按 id）。
 *
 * 🔴 已知限制（刻意不做）:
 * - 不做 Unicode 全角/半角折叠（`Ａ` 与 `A` 视为不同名）
 * - 不做拼音/罗马化匹配（`战斗` 与 `zhandou` 视为不同名）
 * - 不做 Unicode NFC/NFKC 规范化
 */

// ═══════════════════════════════════════════════════════════
// 扩展名表 —— 全项目唯一来源
// ═══════════════════════════════════════════════════════════

/**
 * 认可的音频扩展名 → MIME。
 *
 * 这份表原先住在 `src/ui/lib/audio-folder.ts`，现上提到引擎层作为唯一来源:
 * 名字归一化要剥扩展名，文件夹扫描要按扩展名筛 MIME，两处必须同表。
 * （引擎层禁止 import `src/ui/`，所以只能反向共享。）
 */
export const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  webm: 'audio/webm',
};

/** 认可的音频扩展名（小写，不含点） */
export const AUDIO_FILE_EXTENSIONS: readonly string[] = Object.keys(AUDIO_MIME_BY_EXTENSION);

const EXTENSION_SET = new Set(AUDIO_FILE_EXTENSIONS);

// ═══════════════════════════════════════════════════════════
// 归一化
// ═══════════════════════════════════════════════════════════

/**
 * 比较用的规范键。顺序: trim → 剥尾部扩展名 → 折叠内部空白 → casefold。
 *
 * 剥扩展名只认**真正的尾缀**: `战斗.mp3` → `战斗`，而 `v1.2 主题` 的点在
 * 名字中间，原样保留。整个字符串只是一个扩展名时（`.mp3`）不剥 —— 剥完
 * 就空了，那不是用户的意思。
 *
 * 返回值仅用于比较，**不要**拿它当展示名或落库值。
 */
export function normalizeAudioName(raw: string): string {
  const trimmed = (raw ?? '').trim();
  const dot = trimmed.lastIndexOf('.');
  // dot > 0 排除了"整串就是扩展名"的情况（`.mp3` 的 dot === 0）
  const withoutExt =
    dot > 0 && EXTENSION_SET.has(trimmed.slice(dot + 1).toLowerCase())
      ? trimmed.slice(0, dot)
      : trimmed;
  return withoutExt.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

// ═══════════════════════════════════════════════════════════
// 查找
// ═══════════════════════════════════════════════════════════

/** 多命中时的排序键: createdAt 升序，再按 id 升序（id 可缺省） */
function compareStable(
  a: { createdAt: number; id?: unknown },
  b: { createdAt: number; id?: unknown },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  const ai = typeof a.id === 'string' ? a.id : '';
  const bi = typeof b.id === 'string' ? b.id : '';
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * 按名字查找（归一化比较）。
 *
 * 多命中时返回 **createdAt 最小**的那条，同 createdAt 再按 id 升序 ——
 * 历史重名行刻意保留，所以答案必须与数组顺序无关、跨次加载稳定。
 * 空查询 / 全空白查询一律 undefined（不去匹配同样为空的名字）。
 */
export function findByName<T extends { name: string; createdAt: number }>(
  items: readonly T[],
  query: string,
): T | undefined {
  const key = normalizeAudioName(query);
  if (!key) return undefined;
  let best: T | undefined;
  for (const item of items) {
    if (normalizeAudioName(item.name) !== key) continue;
    if (best === undefined || compareStable(item, best) < 0) best = item;
  }
  return best;
}

// ═══════════════════════════════════════════════════════════
// 唯一性
// ═══════════════════════════════════════════════════════════

/**
 * 名字是否已被占用（归一化比较）。
 *
 * `exceptId` 用于改名校验: 忽略正在改名的那一行，于是"改成自己现在的名字"
 * 永远不算冲突。
 */
export function isNameTaken(
  items: readonly { id: string; name: string }[],
  candidate: string,
  exceptId?: string,
): boolean {
  const key = normalizeAudioName(candidate);
  if (!key) return false;
  return items.some(
    (item) => item.id !== exceptId && normalizeAudioName(item.name) === key,
  );
}

/** 已带 ` (n)` 尾缀的名字 —— 去重时在原尾缀上换号，而不是再套一层 */
const SUFFIX_RE = /^(.*?)\s*\((\d+)\)$/;

/**
 * 取一个不冲突的名字。空闲则原样返回；否则追加 `名字 (2)`、`名字 (3)`…
 * 取最小的可用整数（≥2）。
 *
 * 已带尾缀的输入会**换号而不是叠加**: 已有 `战斗 (2)` 时，`战斗` 与
 * `战斗 (2)` 都得到 `战斗 (3)`，绝不产出 `战斗 (2) (2)`。
 *
 * 只有**比较**走归一化；返回值保留调用方原本的大小写与空格。
 */
export function uniqueAudioName(
  items: readonly { id: string; name: string }[],
  desired: string,
): string {
  if (!isNameTaken(items, desired)) return desired;

  const trimmed = desired.trim();
  const matched = SUFFIX_RE.exec(trimmed);
  const base = matched && matched[1].trim() ? matched[1].trim() : trimmed;

  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!isNameTaken(items, candidate)) return candidate;
  }
}
