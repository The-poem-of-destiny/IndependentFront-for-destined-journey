/**
 * useMessageKeyedCache — 按消息 id 的会话内缓存随消息移除清理
 *
 * 守的是（R8 缓存泄漏的回归）：回退（原地删）、整体换数组（切档 / 快照回退，长度可能不变）
 * 之后，缓存里不再留着已不存在的消息 id；仍在列表里的键原样保留；作用域停止后不再清理。
 */
import { describe, expect, it } from 'vitest';
import { effectScope, nextTick, reactive, ref } from 'vue';
import type { ChatMessage } from '@engine/types/types';
import { useMessageKeyedCache } from '../../../src/ui/composables/useMessageKeyedCache';

function msg(id: string): ChatMessage {
  return { id, role: 'assistant', content: id } as unknown as ChatMessage;
}

function setup(initial: ChatMessage[]) {
  const messages = ref<ChatMessage[] | undefined>(reactive(initial) as ChatMessage[]);
  const scope = effectScope();
  const cache = scope.run(() => useMessageKeyedCache<string>(() => messages.value))!;
  return { messages, scope, cache };
}

describe('useMessageKeyedCache', () => {
  it('回退原地删掉消息：对应键随之清掉，其余保留', async () => {
    const { messages, scope, cache } = setup([msg('a'), msg('b'), msg('c')]);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    expect(cache.size).toBe(3);

    messages.value!.splice(1, 2);
    await nextTick();
    expect(cache.size).toBe(1);
    expect(cache.has('a')).toBe(true);
    scope.stop();
  });

  it('整体换数组且长度不变（切档 / 快照回退）：旧 id 全部清掉', async () => {
    const { messages, scope, cache } = setup([msg('a'), msg('b')]);
    cache.set('a', 'A');
    cache.set('b', 'B');

    messages.value = reactive([msg('x'), msg('y')]) as ChatMessage[];
    await nextTick();
    expect(cache.size).toBe(0);
    scope.stop();
  });

  it('换成与原列表部分重叠的新数组：只留仍在的 id', async () => {
    const { messages, scope, cache } = setup([msg('a'), msg('b'), msg('c')]);
    cache.set('a', 'A');
    cache.set('c', 'C');

    messages.value = reactive([msg('a'), msg('b')]) as ChatMessage[];
    await nextTick();
    expect([...cache.keys()]).toEqual(['a']);
    scope.stop();
  });

  it('消息列表变成 undefined（离开存档）：缓存清空', async () => {
    const { messages, scope, cache } = setup([msg('a')]);
    cache.set('a', 'A');
    messages.value = undefined;
    await nextTick();
    expect(cache.size).toBe(0);
    scope.stop();
  });

  it('推入新消息不影响已有键', async () => {
    const { messages, scope, cache } = setup([msg('a')]);
    cache.set('a', 'A');
    messages.value!.push(msg('b'));
    await nextTick();
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe('A');
    scope.stop();
  });

  it('作用域停止后不再清理', async () => {
    const { messages, scope, cache } = setup([msg('a')]);
    cache.set('a', 'A');
    scope.stop();
    messages.value = reactive([]) as ChatMessage[];
    await nextTick();
    expect(cache.size).toBe(1);
  });
});
