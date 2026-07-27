/**
 * view-audio.ts — 界面 → 场景配乐的映射 (Phase Audio)
 *
 * 为什么存在: 场景配乐此前只认**地点**，而地点只在游戏页里才有意义。于是
 * 离开游戏页时音乐既不换也不停 —— 退回首页还在放着上一场战斗的曲子。
 *
 * 解法不是"离开就 stop"。突然死寂比继续放着更突兀，跟
 * 「未命中时保持当前播放」是同一条道理。改为**给每个界面一个默认场景**，
 * 切换界面时照常走 `playByScene` 打分选曲 —— 复用既有机制，不引入新概念。
 *
 * 纯函数模块: 只做映射，不碰 store、不播放。谁来调见 `App.vue` 的 watch。
 */

import type { SceneTagQuery } from '@engine/audio-scene';
import type { AppView } from '../stores/ui-store';

/**
 * 界面 → 查询。返回 `null` 表示**不动音乐**，两种情况：
 *
 * - `game`: 游戏页的配乐由 `GamePipeline` 按地点/人物/情绪/情境打分决定，
 *   界面这层不该插手，否则进游戏会先放一段"游戏页的曲子"再被地点顶掉。
 * - `settings` / `workshop`: 用户来这儿是调东西的，音乐跟着变只会碍事 ——
 *   尤其设置页里就在试听曲目，这时换歌纯属打架。
 */
export function queryForView(view: AppView): SceneTagQuery | null {
  switch (view) {
    case 'home':
      // 标题画面 —— 内置库里 `系统·菜单` 正是为界面写的
      return { situations: ['系统', '菜单', '界面'], moods: ['平静'] };
    case 'create':
      // 捏人 —— 给命运落笔的时刻一点仪式感
      return { situations: ['仪式'], moods: ['庄严', '神圣'] };
    case 'game':
    case 'settings':
    case 'workshop':
      return null;
    default:
      return null;
  }
}
