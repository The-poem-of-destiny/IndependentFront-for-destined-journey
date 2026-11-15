/**
 * 离开游戏页确认（审查 GAME-08 / G-03）
 *
 * - 没有在跑的回合 / 润色 / 插画 → 直接放行，不弹确认
 * - 回合生成中 → 危险确认，文案说明回合会被中止、已发出的插画仍计费；返回值透传
 * - 只有插画在飞或排队 → 同样要确认
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  game: { isGenerating: false, isRewriting: false },
  images: { generatingId: null as string | null, queue: [] as string[] },
  confirm: vi.fn(async (_options: Record<string, unknown>) => true),
}));

vi.mock('../../../src/ui/stores/game-store', () => ({ useGameStore: () => state.game }));
vi.mock('../../../src/ui/stores/scene-image-store', () => ({
  useSceneImageStore: () => state.images,
}));
vi.mock('../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog: state.confirm }));

import { confirmLeaveGame } from '../../../src/ui/lib/leave-game-guard';

beforeEach(() => {
  state.game.isGenerating = false;
  state.game.isRewriting = false;
  state.images.generatingId = null;
  state.images.queue = [];
  state.confirm.mockReset();
  state.confirm.mockResolvedValue(true);
});

describe('confirmLeaveGame', () => {
  it('空闲时直接放行，不弹确认', async () => {
    await expect(confirmLeaveGame('设置')).resolves.toBe(true);
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('回合生成中弹危险确认，说明回合会被中止、插画仍计费', async () => {
    state.game.isGenerating = true;
    await expect(confirmLeaveGame('首页')).resolves.toBe(true);
    expect(state.confirm).toHaveBeenCalledTimes(1);
    const options = state.confirm.mock.calls[0][0];
    expect(options.danger).toBe(true);
    expect(options.title).toContain('首页');
    expect(options.message).toBe('正在生成的回合会被中止（已发出的插画请求仍会计费）。');
  });

  it('玩家取消 → 返回 false', async () => {
    state.game.isGenerating = true;
    state.confirm.mockResolvedValueOnce(false);
    await expect(confirmLeaveGame('设置')).resolves.toBe(false);
  });

  it('只有插画在飞或排队也要确认', async () => {
    state.images.generatingId = 'simg_1';
    await confirmLeaveGame('设置');
    state.images.generatingId = null;
    state.images.queue = ['simg_2'];
    await confirmLeaveGame('设置');
    expect(state.confirm).toHaveBeenCalledTimes(2);
    expect(String(state.confirm.mock.calls[0][0].details)).toContain('仍会计费');
  });

  it('润色进行中也要确认（结果会丢失）', async () => {
    state.game.isRewriting = true;
    await confirmLeaveGame('扩展');
    expect(String(state.confirm.mock.calls[0][0].details)).toContain('润色');
  });
});
