/**
 * useMessageKeyedCache — 按消息 id 记的会话内缓存，消息移除时随之清掉
 *
 * ChatFlow 的「名字初次登场」缓存与逐节演出的正文输入缓存都按消息 id 记、只增不减，
 * 回退 / 切档 / 整体换数组之后旧 id 永远不会再被问到，却一直占着内存。
 * 这里返回一张普通 `Map`（读写照旧，非响应式），另挂一个 watch：
 * - 消息数组**整体换掉**（载入存档 / 快照回退，长度可能不变）；
 * - 或**长度变化**（回退时原地删、`push` 新消息）；
 * 任一发生就把缓存里已不在当前消息列表中的键删掉。新消息推入时也会扫一遍，代价是 O(消息数)，
 * 只在长度变化时跑，不逐帧。
 *
 * 必须在组件 setup（或某个 effect scope）里调用，watch 随作用域一起停。
 */
import { watch } from 'vue';
import type { ChatMessage } from '@engine/types/types';

export function useMessageKeyedCache<V>(
  messages: () => readonly ChatMessage[] | undefined,
): Map<string, V> {
  const cache = new Map<string, V>();
  watch(
    () => {
      const list = messages();
      return [list, list?.length] as const;
    },
    ([list]) => {
      if (cache.size === 0) return;
      const alive = new Set((list ?? []).map((m) => m.id));
      for (const id of Array.from(cache.keys())) {
        if (!alive.has(id)) cache.delete(id);
      }
    },
  );
  return cache;
}
