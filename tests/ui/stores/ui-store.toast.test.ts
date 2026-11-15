/**
 * ui-store —— 提示（toast）的停留时长与暂停（审查 G-06）
 *
 * 重要错误不能 3 秒就消失：错误默认 8 秒、警告 5 秒、其余 3 秒；0 = 常驻；
 * 悬停暂停后按剩余时间继续计时。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('@ui/stores/game-store', () => ({
  useGameStore: () => ({ clearActive: vi.fn(), saves: [], activeSaveId: null, activeSave: null }),
}));

import { useUIStore } from '@ui/stores/ui-store';

describe('ui-store toast', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['info', 3000],
    ['success', 3000],
    ['warning', 5000],
    ['error', 8000],
  ] as const)('%s 类型缺省停留 %i 毫秒', (type, ms) => {
    const ui = useUIStore();
    ui.toast('提示', type);
    expect(ui.toasts[0]!.duration).toBe(ms);
    vi.advanceTimersByTime(ms - 1);
    expect(ui.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ui.toasts).toHaveLength(0);
  });

  it('错误提示不再 3 秒就消失', () => {
    const ui = useUIStore();
    ui.toast('出错了', 'error');
    vi.advanceTimersByTime(3000);
    expect(ui.toasts).toHaveLength(1);
  });

  it('显式传入的时长优先于类型缺省', () => {
    const ui = useUIStore();
    ui.toast('出错了', 'error', 1000);
    vi.advanceTimersByTime(1000);
    expect(ui.toasts).toHaveLength(0);
  });

  it('时长 0 = 常驻，直到手动关闭', () => {
    const ui = useUIStore();
    ui.toast('启动失败', 'error', 0);
    vi.advanceTimersByTime(60_000);
    expect(ui.toasts).toHaveLength(1);
    ui.removeToast(ui.toasts[0]!.id);
    expect(ui.toasts).toHaveLength(0);
  });

  it('暂停期间不消失，恢复后按剩余时间继续计时', () => {
    const ui = useUIStore();
    ui.toast('提示', 'info');
    const id = ui.toasts[0]!.id;
    vi.advanceTimersByTime(2000);
    ui.pauseToast(id);
    vi.advanceTimersByTime(10_000);
    expect(ui.toasts).toHaveLength(1);
    ui.resumeToast(id);
    vi.advanceTimersByTime(999);
    expect(ui.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ui.toasts).toHaveLength(0);
  });

  it('重复暂停 / 恢复不会叠加计时器', () => {
    const ui = useUIStore();
    ui.toast('提示', 'info');
    const id = ui.toasts[0]!.id;
    ui.resumeToast(id);
    ui.pauseToast(id);
    ui.pauseToast(id);
    ui.resumeToast(id);
    ui.resumeToast(id);
    vi.advanceTimersByTime(3000);
    expect(ui.toasts).toHaveLength(0);
  });
});
