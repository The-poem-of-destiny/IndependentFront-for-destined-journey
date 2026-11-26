/**
 * 行动面板样式目录 + `useActionPanelStyle` 读写
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive } from 'vue';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BATTLELOG_STAGGER_LINES,
  STAGGER_INDEX_MAX,
  STAGGER_STEP_MS,
} from '../../../src/ui/components/game/action-panel/entrance-timing';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
import {
  ACTION_PANEL_STYLES,
  DEFAULT_ACTION_PANEL_STYLE,
  resolveActionPanelStyle,
} from '../../../src/ui/lib/action-panel-styles';

const mockSettings: Record<string, unknown> = reactive({});
vi.mock('../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: mockSettings }),
}));

const { useActionPanelStyle } = await import('../../../src/ui/composables/useActionPanelStyle');

describe('行动面板样式目录', () => {
  it('五种样式按约定顺序与中文名列出，id 不重复', () => {
    expect(ACTION_PANEL_STYLES.map((s) => s.id)).toEqual([
      'duel',
      'afterimage',
      'battlelog',
      'floating',
      'card',
    ]);
    expect(ACTION_PANEL_STYLES.map((s) => s.label)).toEqual([
      '对决条',
      '血条残影',
      '战报行',
      '跳字舞台',
      '打出的牌',
    ]);
  });

  it('每种样式都有一句说明与正的入场时长', () => {
    for (const s of ACTION_PANEL_STYLES) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(Number.isFinite(s.entranceMs)).toBe(true);
      expect(s.entranceMs).toBeGreaterThan(0);
    }
  });

  /**
   * entranceMs 必须盖住该样式最长的一段入场动画（延迟 + 时长），否则入场类撤得太早，动画被腰斩。
   * token 现读 variables.css，各样式自有的 CSS 定值现读组件源码；交错上限与步长直接 import entrance-timing.ts。
   * 资源条（ActionGauge）在四种样式里都会跟着播：fill slow、ghost 延迟 base + 时长 base。
   */
  it('每种样式的 entranceMs 不短于它最长一段入场动画，并留出余量', () => {
    const tokens = readFileSync(resolve(ROOT, 'src/ui/themes/variables.css'), 'utf8');
    const ms = (src: string, name: string): number => {
      const m = new RegExp(`${name}:\\s*(\\d+)ms`).exec(src);
      if (!m) throw new Error(`找不到 ${name}`);
      return Number(m[1]);
    };
    const fast = ms(tokens, '--motion-duration-fast');
    const base = ms(tokens, '--motion-duration-base');
    const slow = ms(tokens, '--motion-duration-slow');
    const step = STAGGER_STEP_MS;
    const comp = (name: string) =>
      readFileSync(resolve(ROOT, `src/ui/components/game/action-panel/${name}.vue`), 'utf8');
    const gauge = Math.max(slow, base + base);
    const i = STAGGER_INDEX_MAX;

    const afterimage = comp('ActionStyleAfterimage');
    const battlelog = comp('ActionStyleBattleLog');

    const longest: Record<string, number> = {
      // 箭 base；目标行 fast + i·step 延迟 + base；结论印 slow 延迟 + base
      duel: Math.max(base, fast + i * step + base, slow + base, gauge),
      // 盖片停留 --d2-hold 后 --d2-chase 收拢
      afterimage: Math.max(ms(afterimage, '--d2-hold') + ms(afterimage, '--d2-chase'), gauge),
      // 逐行：(BATTLELOG_STAGGER_LINES − 1)·--bl-step 延迟 + base
      battlelog: (BATTLELOG_STAGGER_LINES - 1) * ms(battlelog, '--bl-step') + base,
      // 跳字：fast + i·2·step 延迟 + slow
      floating: Math.max(fast + i * step * 2 + slow, gauge),
      // 发牌 slow；宝石 fast + base；绶带 base + base；小牌 slow + i·step 延迟 + base
      card: Math.max(slow, fast + base, base + base, slow + i * step + base, gauge),
    };
    for (const s of ACTION_PANEL_STYLES) {
      expect(longest[s.id], s.id).toBeGreaterThan(0);
      expect(s.entranceMs, s.id).toBeGreaterThanOrEqual(longest[s.id]! + 20);
    }
  });

  it('交错步长常量与 --motion-stagger-step token 同值', () => {
    const tokens = readFileSync(resolve(ROOT, 'src/ui/themes/variables.css'), 'utf8');
    const m = /--motion-stagger-step:\s*(\d+)ms/.exec(tokens);
    expect(m).not.toBeNull();
    expect(STAGGER_STEP_MS).toBe(Number(m![1]));
  });

  it('缺省样式是对决条', () => {
    expect(DEFAULT_ACTION_PANEL_STYLE).toBe('duel');
  });

  it('合法 id 原样返回', () => {
    for (const s of ACTION_PANEL_STYLES) expect(resolveActionPanelStyle(s.id)).toBe(s.id);
  });

  it('缺键 / 不认识的值 / 非字符串一律回落对决条', () => {
    for (const v of [undefined, null, '', 'DUEL', 'unknown', 3, {}, ['card']]) {
      expect(resolveActionPanelStyle(v)).toBe('duel');
    }
  });
});

describe('useActionPanelStyle', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  });

  it('设置袋缺键时读成对决条', () => {
    expect(useActionPanelStyle().style.value).toBe('duel');
  });

  it('存了无效值时读成对决条', () => {
    mockSettings.actionPanelStyle = 'neon';
    expect(useActionPanelStyle().style.value).toBe('duel');
  });

  it('setStyle 写回设置袋，style 随之更新', () => {
    const { style, setStyle } = useActionPanelStyle();
    setStyle('card');
    expect(mockSettings.actionPanelStyle).toBe('card');
    expect(style.value).toBe('card');
  });
});
