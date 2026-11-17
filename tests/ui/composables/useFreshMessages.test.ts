/**
 * useFreshMessages — 分辨新到的消息与载入的历史
 *
 * 守的是：挂载时已在场的、整体换数组带来的都算历史；挂载后 push 进同一数组的才算新鲜；
 * 这一代生成里流式过的记为 streamed（草稿在提交前就被清空也照记）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { defineComponent, nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';
import type { ChatMessage } from '@engine/types/types';
import { useFreshMessages, type FreshMessages } from '../../../src/ui/composables/useFreshMessages';

function msg(id: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return { id, role, content: id, timestamp: 0 };
}

function setup(initial: ChatMessage[]) {
  const state = reactive({
    messages: initial,
    isGenerating: false,
    streamingText: '',
  });
  let api!: FreshMessages;
  mount(
    defineComponent({
      setup() {
        api = useFreshMessages({
          messages: () => state.messages,
          isGenerating: () => state.isGenerating,
          streamingText: () => state.streamingText,
        });
        return () => null;
      },
    }),
  );
  return { state, api: () => api };
}

describe('useFreshMessages', () => {
  it('挂载时已在场的消息不算新鲜', async () => {
    const { api } = setup([msg('a'), msg('b')]);
    await nextTick();
    expect(api().isFresh('a')).toBe(false);
    expect(api().fresh.value.size).toBe(0);
  });

  it('挂载后 push 的消息算新鲜；未流式过的 streamed 为假', async () => {
    const { state, api } = setup([msg('a')]);
    await nextTick();
    state.messages.push(msg('b'));
    await nextTick();
    expect(api().isFresh('b')).toBe(true);
    expect(api().wasStreamed('b')).toBe(false);
  });

  it('这一代流式过（提交前草稿已清空）→ 提交的消息记为 streamed', async () => {
    const { state, api } = setup([]);
    await nextTick();
    state.isGenerating = true;
    state.messages.push(msg('u1', 'user'));
    await nextTick();
    state.streamingText = '草稿……';
    await nextTick();
    state.streamingText = '';
    await nextTick();
    state.messages.push(msg('a1'));
    await nextTick();
    state.isGenerating = false;
    await nextTick();
    expect(api().wasStreamed('u1')).toBe(false);
    expect(api().wasStreamed('a1')).toBe(true);

    // 下一代没有流式：新消息不再被记成 streamed
    state.isGenerating = true;
    await nextTick();
    state.messages.push(msg('a2'));
    await nextTick();
    expect(api().isFresh('a2')).toBe(true);
    expect(api().wasStreamed('a2')).toBe(false);
  });

  it('流式欠账只由第一条 assistant 领走：同一代里之后推进来的通知 / 摘要照常算未流式', async () => {
    const { state, api } = setup([]);
    await nextTick();
    state.isGenerating = true;
    await nextTick();
    state.streamingText = '草稿……';
    await nextTick();
    state.streamingText = '';
    await nextTick();
    state.messages.push(msg('a1'));
    await nextTick();
    state.messages.push(msg('notice'));
    await nextTick();
    expect(api().wasStreamed('a1')).toBe(true);
    expect(api().isFresh('notice')).toBe(true);
    expect(api().wasStreamed('notice')).toBe(false);
  });

  it('生成结束即清账：流式过却没提交的一代，之后生成外推进来的消息不算流式', async () => {
    const { state, api } = setup([]);
    await nextTick();
    state.isGenerating = true;
    await nextTick();
    state.streamingText = '草稿……';
    await nextTick();
    state.streamingText = '';
    state.isGenerating = false; // 失败 / 中止：草稿没有变成正式消息
    await nextTick();
    state.messages.push(msg('summary'));
    await nextTick();
    expect(api().isFresh('summary')).toBe(true);
    expect(api().wasStreamed('summary')).toBe(false);
  });

  it('提交与生成结束同拍到达：提交的那条仍记为 streamed', async () => {
    const { state, api } = setup([]);
    await nextTick();
    state.isGenerating = true;
    await nextTick();
    state.streamingText = '草稿……';
    await nextTick();
    state.streamingText = '';
    state.messages.push(msg('a1'));
    state.isGenerating = false;
    await nextTick();
    expect(api().wasStreamed('a1')).toBe(true);
  });

  it('整体换数组（载入存档 / 回退）一律当历史，并清空新鲜记录', async () => {
    const { state, api } = setup([msg('a')]);
    await nextTick();
    state.messages.push(msg('b'));
    await nextTick();
    expect(api().isFresh('b')).toBe(true);
    state.messages = [msg('a'), msg('b'), msg('c')];
    await nextTick();
    expect(api().isFresh('b')).toBe(false);
    expect(api().isFresh('c')).toBe(false);
  });
});
