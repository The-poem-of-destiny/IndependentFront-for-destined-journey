/**
 * ui-store × 真 game-store —— 回到首页后，旧存档的守卫写入口不再落库（UIL-20）
 *
 * ui-store.test.ts 把 game-store 替身掉了，只证明了「调用了 clearActive」。这里用真实
 * game-store + fake-indexeddb 走一遍：载入存档 → 游戏页 → 返回首页，之后仍在飞的
 * 写入（消息持久化、自动存档）都不能再写进刚离开的存档。
 *
 * 🔴 在飞回合本身由 GamePipeline 承载（`ownsActiveSave` 守卫），拉起整条管线不现实；
 * 这里钉的是管线所依赖的 store 层守卫：game-store 活跃存档清空后，按「当前存档」
 * 寻址的写入口全部拒写。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useGameStore, setAutosaveImpl } from '../../../src/ui/stores/game-store';
import { useUIStore } from '../../../src/ui/stores/ui-store';
import {
  initializeDatabase,
  clearAllData,
  saveSaveSlot,
  getMessages,
} from '@engine/persistence/database';
import type { SaveSlot } from '@engine/types/types';

const SAVE_ID = 'save-leave-home';

function makeSaveSlot(): SaveSlot {
  return {
    id: SAVE_ID,
    name: '离开测试档',
    slot: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeSnapshotId: null,
    metadata: {
      characterName: '理查德',
      userName: 'Tester',
      gameStartTime: '001-01-01',
      totalTurns: 0,
    },
  };
}

describe('回到首页后旧存档的写入口拒写（真 game-store）', () => {
  beforeEach(async () => {
    try {
      await clearAllData();
    } catch {
      /* db 可能还不存在 */
    }
    await initializeDatabase();
    await saveSaveSlot(makeSaveSlot());
    setActivePinia(createPinia());
  });

  it('游戏页 → 首页：两处活跃存档清空，消息与自动存档都不再写进旧存档', async () => {
    const game = useGameStore();
    const ui = useUIStore();
    expect(await game.loadSave(SAVE_ID)).toBe(true);
    ui.navigate('game', SAVE_ID);
    expect(ui.activeSaveName).toBe('离开测试档');

    const autosave = vi.fn(async () => undefined);
    setAutosaveImpl(autosave);
    // 对照：仍在游戏页时自动存档照常执行，证明下面的「不执行」来自离开存档
    await game.runAutosave();
    expect(autosave).toHaveBeenCalledTimes(1);

    ui.navigate('home');

    expect(ui.activeSaveId).toBeNull();
    expect(game.activeSaveId).toBeNull();

    // 离开之后才到的消息：不带 saveId，persistMessage 拒写
    const before = (await getMessages(SAVE_ID)).length;
    game.addMessage('离开后才到的正文', 'assistant');
    await game.runAutosave();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await getMessages(SAVE_ID)).toHaveLength(before);
    expect(autosave).toHaveBeenCalledTimes(1);
  });
});
