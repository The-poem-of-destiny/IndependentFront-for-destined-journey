/**
 * 角色年龄 —— 真源是「开局时的年龄 + 生日」，当前年龄永远按游戏时间现算。
 *
 * 为什么不存出生年：游戏只有一个纪元，五百岁的角色出生年会落到纪元之前甚至为负，
 * 在没有纪元 / 历法体系的前提下那个数字没有意义。「开局那一刻几岁」对任何寿命都成立。
 *
 * 为什么不存「当前年龄」：存下来的年龄需要有人在每次时间推进时去加一，
 * 漏一条路径（快照恢复 / 回退 / 跳时）就静默走偏。只存锚点则没有这个账要记。
 *
 * 开局时刻 = `GAME_EPOCH_YEAR` 年 1 月 1 日（`createDefaultTime` 的日期）。
 * 历法沿用 `time-system.ts`：12 个月 × 30 天。
 */
import type { CharacterState } from '../types/types';
import type { CharacterAgeAnchor, CharacterAgeHint } from '../types/types-character';
import { GAME_EPOCH_YEAR, type GameTime } from '../time/time-system';

/** 没有任何年龄线索时的兜底年龄（指角色实例化那一刻） */
export const DEFAULT_CHARACTER_AGE = 18;
/** 没有生日线索时的兜底生日：1 月 1 日 */
const DEFAULT_BIRTHDAY = { month: 1, day: 1 } as const;
const DAYS_PER_MONTH = 30;
/** 年龄锚点对应的时刻：开局当天 */
const GAME_START = { year: GAME_EPOCH_YEAR, month: 1, day: 1 } as const;

type Now = Pick<GameTime, 'year' | 'month' | 'day'>;
type Birthday = { month: number; day: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value) : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^\d+/);
  return match ? parseInt(match[0], 10) : null;
}

/** 月 1-12、日 1-30；现实历法的 31 日并到 30 日，其余越界视为无效。 */
function monthDay(month: unknown, day: unknown): Birthday | null {
  const m = toInt(month);
  const d = toInt(day);
  if (m === null || d === null || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { month: m, day: Math.min(d, DAYS_PER_MONTH) };
}

function parseAge(raw: unknown): number | undefined {
  // 只认纯数字或「34岁」；「外貌约16岁」之类带限定语的不猜
  if (typeof raw === 'string' && !/^\s*\d+\s*岁?\s*$/.test(raw)) return undefined;
  const age = toInt(raw);
  return age !== null && age >= 0 ? age : undefined;
}

function parseBirthday(raw: unknown): Birthday | undefined {
  if (isRecord(raw)) return monthDay(raw.month, raw.day) ?? undefined;
  if (typeof raw !== 'string') return undefined;
  // "03-15" / "3/15" / "3月15日"；不接受年份 —— 出生年不是本模型的概念
  const match = raw.trim().match(/^(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?$/);
  return match ? (monthDay(match[1], match[2]) ?? undefined) : undefined;
}

/**
 * 宽容解析年龄线索：坏掉的那一半直接丢弃（由兜底接手），不连累另一半，也不抛错。
 * 接受 `{ age, birthday }`，其中 `birthday` 可以是 `{ month, day }` 或日期文本。
 */
export function parseAgeHint(raw: unknown): CharacterAgeHint {
  if (!isRecord(raw)) return {};
  const age = parseAge(raw.age);
  const birthday = parseBirthday(raw.birthday);
  return {
    ...(age !== undefined ? { age } : {}),
    ...(birthday ? { birthday } : {}),
  };
}

function isValidAnchor(value: unknown): value is CharacterAgeAnchor {
  return (
    isRecord(value) &&
    Number.isInteger(value.startAge) &&
    Number.isInteger(value.month) &&
    Number.isInteger(value.day) &&
    (value.month as number) >= 1 &&
    (value.month as number) <= 12 &&
    (value.day as number) >= 1 &&
    (value.day as number) <= DAYS_PER_MONTH
  );
}

/** 这一年的生日是否已经过了（含当天） */
function birthdayReached(birthday: Birthday, now: Now): boolean {
  return now.month > birthday.month || (now.month === birthday.month && now.day >= birthday.day);
}

/** 从开局到 `now` 一共过了几个生日（`now` 早于开局时为负） */
function birthdaysSinceStart(birthday: Birthday, now: Now): number {
  return (
    now.year -
    GAME_START.year -
    (birthdayReached(birthday, now) ? 0 : 1) +
    (birthdayReached(birthday, GAME_START) ? 0 : 1)
  );
}

/** 周岁。开局后才出生的角色（`startAge` 为负）在出生前记 0，不出负数。 */
export function ageAt(anchor: CharacterAgeAnchor, now: Now): number {
  return Math.max(0, anchor.startAge + birthdaysSinceStart(anchor, now));
}

/** 已知角色在 `now` 这一刻的年龄，反推开局时的年龄。 */
function startAgeFrom(ageNow: number, birthday: Birthday, now: Now): number {
  return ageNow - birthdaysSinceStart(birthday, now);
}

/**
 * 实例化闸门：角色没有合法年龄锚点时补上，已有则原样保留（幂等）。
 *
 * - 作者定义的 `age` 是**开局时**的年龄，原样采用 —— 与角色第几年才登场无关。
 * - 实例自带的 `customFields.age`（主角建号年龄、entity_gen 输出）是**此刻**的年龄，按 `now` 折算回开局。
 * - 两者都没有或无效：此刻 18 岁。生日缺失或无效：1 月 1 日。年龄与生日各自独立取用，作者优先。
 *
 * @returns 是否写入了新的锚点（调用方据此决定要不要落库）
 */
export function ensureCharacterAge(character: CharacterState, now: Now): boolean {
  if (isValidAnchor(character.ageAnchor)) return false;
  const authored = parseAgeHint(character.definition);
  const own = parseAgeHint(character.customFields);
  const birthday = authored.birthday ?? own.birthday ?? DEFAULT_BIRTHDAY;
  character.ageAnchor = {
    startAge: authored.age ?? startAgeFrom(own.age ?? DEFAULT_CHARACTER_AGE, birthday, now),
    month: birthday.month,
    day: birthday.day,
  };
  return true;
}

/** 角色当前年龄；尚未补锚点（旧存档未回填）或缺游戏时间时返回 null。 */
export function characterAge(
  character: Pick<CharacterState, 'ageAnchor'>,
  now: Now | null | undefined,
): number | null {
  return now && isValidAnchor(character.ageAnchor) ? ageAt(character.ageAnchor, now) : null;
}

/** 「24岁（生日3月15日）」；拿不到年龄时返回空串。 */
export function formatCharacterAge(
  character: Pick<CharacterState, 'ageAnchor'>,
  now: Now | null | undefined,
): string {
  const age = characterAge(character, now);
  if (age === null || !character.ageAnchor) return '';
  return `${age}岁（生日${character.ageAnchor.month}月${character.ageAnchor.day}日）`;
}

/**
 * 从旧世界书人物资料里取年龄：只认整行就是「年龄: 20」/「年龄：约400岁」的写法。
 * 「外貌约16岁 (实际百年以上)」这类带限定语的一律不猜，交给兜底。
 */
export function extractLoreAge(lore: string): number | undefined {
  const match = lore.match(/^[\s\-*·]*年龄\s*[:：]\s*约?\s*(\d{1,5})\s*岁?\s*$/m);
  return match ? parseInt(match[1], 10) : undefined;
}
