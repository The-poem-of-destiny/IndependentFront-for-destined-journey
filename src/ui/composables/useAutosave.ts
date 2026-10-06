/**
 * useAutosave —— 游戏页自动存档调度（2026-10-05）
 *
 * 监听游戏活表（消息 / 角色 / 存档档案 / 剧情事件）的任意改动，在静默数秒后调用
 * `game.runAutosave()`，把当前状态覆写进「本轮那张 turn 快照」。于是「正文润色 / 重铸 /
 * 任何手动编辑」都会在下一轮拍出新快照之前被吸进本轮快照 —— 回档到本轮不再丢改动。
 *
 * 效果（主人要的存档结构）：
 *   · 39 轮 + 一堆手动改动 → `… 37 38 autosave_39`（39 这张被持续覆写）
 *   · 跑完 40 轮            → `… 37 38 39(冻结) autosave_40`
 *
 * 🔴 只在 GamePage 挂载期间生效，卸载即清定时器（不泄漏）。
 * 🔴 生成中 / 战斗中不写（`game.runAutosave` 自己判）；本层只管「何时该试」。
 * 🔴 节流而非纯防抖：连续改动也**每 N 秒写一次**，不会因为一直在动就一直不写。
 */
import { watch, onUnmounted } from 'vue';
import { useGameStore } from '../stores/game-store';

/** 活表改动后多久落一次（主人要的「隔几秒」）。 */
const AUTOSAVE_INTERVAL_MS = 5000;

export function useAutosave(intervalMs = AUTOSAVE_INTERVAL_MS): void {
  const game = useGameStore();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (!game.activeSaveId) return;
    // 已有一次待发就不再重置：连续改动照样每 N 秒落一次（节流），而不是被无限推迟。
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void game.runAutosave();
    }, intervalMs);
  };

  watch(() => [game.messages, game.characters, game.saveProfile, game.activePlotEvents], schedule, {
    deep: true,
  });

  onUnmounted(() => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  });
}
