/**
 * 离开游戏页之前的确认（审查 GAME-08 / G-03）。
 *
 * 游戏页没有 KeepAlive：导航去设置 / 扩展 / 首页都会卸载 GamePage，卸载时会中止
 * 正在生成的回合与全部在飞、排队的插画请求（`GamePage.vue` 的 onBeforeUnmount）。
 * 这些都是花了钱的活，所以凡是会把玩家带离游戏页的入口，都先过这一道。
 *
 * - 没有在跑的回合、也没有在飞/排队的插画 → 直接放行（true），不打扰。
 * - 否则弹一次危险确认：确认 → true，取消 / Esc / 遮罩 → false。
 *
 * 🔴 判据只读两个 store 的公开状态，不在 ui-store 里实现（导航本身与守卫分开）。
 */
import { useGameStore } from '../stores/game-store';
import { useSceneImageStore } from '../stores/scene-image-store';
import { confirmDialog } from './confirm-dialog';

/** 当前离开游戏页会不会中止在跑的付费工作 */
function leavingGameAbortsWork(): { turn: boolean; rewrite: boolean; images: boolean } {
  const game = useGameStore();
  const images = useSceneImageStore();
  const imageQueue = images.queue ?? [];
  return {
    turn: Boolean(game.isGenerating),
    rewrite: Boolean(game.isRewriting),
    images: images.generatingId != null || imageQueue.length > 0,
  };
}

/**
 * 离开游戏页前调用；返回 true 才继续导航。
 * @param destination 去处的中文名（如「设置」「首页」），写进弹窗标题
 */
export async function confirmLeaveGame(destination: string): Promise<boolean> {
  const busy = leavingGameAbortsWork();
  if (!busy.turn && !busy.rewrite && !busy.images) return true;

  const details: string[] = [];
  if (busy.turn) details.push('正在生成的回合会被中止，需要之后重新发送');
  if (busy.rewrite) details.push('正在进行的润色结果会丢失，原文保持不变');
  if (busy.images) details.push('排队中的插画会被取消；已发出的插画请求仍会计费');

  return confirmDialog({
    title: `现在去${destination}？`,
    message: busy.turn
      ? '正在生成的回合会被中止（已发出的插画请求仍会计费）。'
      : '离开游戏页会中止正在进行的工作（已发出的插画请求仍会计费）。',
    details,
    confirmLabel: '仍然离开',
    cancelLabel: '留在游戏',
    danger: true,
  });
}
