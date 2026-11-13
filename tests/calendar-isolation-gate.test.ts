/**
 * calendar-isolation-gate.test.ts — 日历 v1 不向模型发送任何内容。
 *
 * 钉的是「日历完全本地」这条设计边界（docs/planning/2026-11-13-calendar-system-v1-design.md §1）。
 * 它破坏时不会报错：往提示词装配层接一个日历函数，编译得过、测试全绿，
 * 效果只是玩家的私人日程或节庆元数据悄悄进了发给模型的上下文。
 *
 * 三道检查，互相补位：
 *   ① 引用扫描（白名单制）：整个 `src/` 里，只有白名单内的文件可以引用日历模块与日历类型。
 *      扫全树而不是点名几个目录 —— 间接引用（先进某个工具模块、再被提示词层用）也过不去。
 *   ② 字段扫描：`keyDates` 这个字段名只允许出现在白名单文件里，
 *      挡住「不 import 任何东西、直接读 `entry.extra.lore.keyDates`」的写法。
 *   ③ 行为检查：带哨兵关键日期的条目，渲染成给模型的文本后哨兵不出现。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatWorldBookEntries } from '../src/core/content/worldbook-loader';
import type { WorldBookEntry } from '../src/core/types/types';

const SRC = join(__dirname, '..', 'src');

/** 可以引用日历模块 / 日历类型的文件：日历自身、存储接线、日历界面。 */
const CALENDAR_IMPORT_ALLOWED = [
  /^core\/calendar\//,
  /^core\/types\/types-calendar\.ts$/,
  /^core\/persistence\/(database|session-backup)\.ts$/,
  /^ui\/stores\/calendar-store\.ts$/,
  /^ui\/components\/game\/(CalendarPanel\.vue|calendar-panel\.ts)$/,
];
/** 可以出现 `keyDates` 字段名的文件：类型、解析与校验、汇总它的日历来源与界面。 */
const KEY_DATES_ALLOWED = [
  /^core\/types\/types\.ts$/,
  /^core\/content\/lore-key-dates\.ts$/,
  /^core\/content\/lore-protocol\.ts$/,
  /^core\/calendar\//,
  /^ui\/components\/game\/CalendarPanel\.vue$/,
];
/** 可以调用关键日期读取函数的文件 */
const KEY_DATES_READERS_ALLOWED = [
  /^core\/types\/types\.ts$/, // 只在字段注释里点名解析函数
  /^core\/content\/lore-key-dates\.ts$/,
  /^core\/calendar\//,
  /^ui\/components\/game\/CalendarPanel\.vue$/,
];

const CALENDAR_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"`][^'"`]*(?:\/calendar\/|calendar-store|calendar-panel|types-calendar)[^'"`]*['"`]/;
const KEY_DATES_FIELD = /\bkeyDates\b/;
const KEY_DATES_READER = /\b(?:collectLoreKeyDates|parseLoreKeyDates)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|vue)$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  rel: relative(SRC, path).split(sep).join('/'),
  lines: readFileSync(path, 'utf8').split('\n'),
}));

function offenders(pattern: RegExp, allowed: RegExp[]): string[] {
  return files
    .filter((file) => !allowed.some((rule) => rule.test(file.rel)))
    .flatMap((file) =>
      file.lines.flatMap((line, index) => (pattern.test(line) ? [`${file.rel}:${index + 1}`] : [])),
    );
}

describe('日历与模型输入隔离', () => {
  it('扫描面不是空的（目录挪了闸门就会空转）', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.rel.startsWith('core/prompts/'))).toBe(true);
    expect(files.some((f) => f.rel === 'ui/lib/game-pipeline.ts')).toBe(true);
  });

  it('① 只有白名单内的文件引用日历模块与日历类型', () => {
    expect(offenders(CALENDAR_IMPORT, CALENDAR_IMPORT_ALLOWED)).toEqual([]);
  });

  it('② keyDates 字段与它的读取函数只出现在白名单内的文件', () => {
    expect(offenders(KEY_DATES_FIELD, KEY_DATES_ALLOWED)).toEqual([]);
    expect(offenders(KEY_DATES_READER, KEY_DATES_READERS_ALLOWED)).toEqual([]);
  });

  it('判据本身认得出各种违规写法', () => {
    for (const line of [
      "import { buildCalendarItems } from '../calendar/calendar-view';",
      "import type { SaveCalendar } from '../types/types-calendar';",
      "const m = await import('../calendar/calendar-store');",
      'const m = await import(`../calendar/calendar-view`);',
      "import { useCalendarStore } from '../stores/calendar-store';",
    ])
      expect(CALENDAR_IMPORT.test(line), line).toBe(true);
    expect(CALENDAR_IMPORT.test("import { withoutLoreKeyDates } from './lore-key-dates';")).toBe(
      false,
    );
    expect(KEY_DATES_FIELD.test('const dates = entry.extra?.lore?.keyDates;')).toBe(true);
    expect(KEY_DATES_FIELD.test('lore: withoutLoreKeyDates(lore)')).toBe(false);
    expect(KEY_DATES_READER.test('collectLoreKeyDates(books)')).toBe(true);
  });

  it('③ 带关键日期的条目渲染成给模型的文本后，关键日期的内容不出现', () => {
    const entry = {
      uid: 'fated:world_setting/sentinel',
      name: 'sentinel',
      content: '正文只有这一句。',
      enabled: true,
      order: 0,
      extra: {
        lore: {
          keyDates: [
            {
              id: 'sentinel',
              name: 'SENTINEL_NAME',
              when: { precision: 'day', start: { month: 1, day: 1 } },
              summary: 'SENTINEL_SUMMARY',
              regions: ['SENTINEL_REGION'],
            },
          ],
        },
      },
    } as unknown as WorldBookEntry;
    const text = formatWorldBookEntries([entry]);
    expect(text).toBe('正文只有这一句。');
    expect(text).not.toContain('SENTINEL');
  });
});
