/**
 * calendar-isolation-gate.test.ts — 结构闸门：日历 v1 不向模型发送任何内容。
 *
 * 钉的是「日历完全本地」这条设计边界（docs/planning/2026-11-13-calendar-system-v1-design.md §1）。
 * 它破坏时不会报错：往提示词装配层 import 一个日历函数，编译得过、测试全绿，
 * 效果只是玩家的私人日程悄悄进了发给模型的上下文。
 *
 * 判据是源码扫描：会产出模型输入的三个目录不得引用 `calendar/` 模块或日历类型分册。
 * 关键日期的解析模块 `content/lore-key-dates.ts` 不在禁止之列 —— `lore-selection.ts`
 * 需要它把 `keyDates` 从区域资料指纹里排除，那正是为了不让日历元数据影响提示词侧。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE = join(__dirname, '..', 'src', 'core');
const MODEL_FACING = ['prompts', 'agents', 'memory'];
const FORBIDDEN =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*(?:\/calendar\/|types-calendar)[^'"]*['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('日历与模型输入隔离', () => {
  it('提示词 / Agent / 记忆三层不引用日历模块', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of MODEL_FACING) {
      for (const file of sourceFiles(join(CORE, dir))) {
        scanned++;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (FORBIDDEN.test(line)) offenders.push(`${file}:${index + 1}`);
          });
      }
    }
    // 扫到的文件数为 0 说明目录挪了，闸门在空转
    expect(scanned).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it('判据本身认得出违规写法', () => {
    expect(FORBIDDEN.test("import { buildCalendarItems } from '../calendar/calendar-view';")).toBe(
      true,
    );
    expect(FORBIDDEN.test("import type { SaveCalendar } from '../types/types-calendar';")).toBe(
      true,
    );
    expect(FORBIDDEN.test("const m = await import('../calendar/calendar-store');")).toBe(true);
    expect(FORBIDDEN.test("import { withoutLoreKeyDates } from './lore-key-dates';")).toBe(false);
  });
});
