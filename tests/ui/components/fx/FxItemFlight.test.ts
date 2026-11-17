/**
 * FxItemFlight.vue — 物品飞入层的触发判定
 *
 * 守的是：挂载时已有的消息不起飞；整份换掉消息数组（载入存档 / 回退）不起飞；
 * 同一数组上新推入的「获得物品」系统消息才起飞，一批多条只请求一次；其余消息不起飞。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, enableAutoUnmount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import type { ChatMessage } from '@engine/types/types';

const mocks = vi.hoisted(() => ({
  request: vi.fn(() => 'started'),
  dispose: vi.fn(),
  // 响应式 store 替身在下方赋值（vi.hoisted 里拿不到 vue 的 reactive）
  holder: { store: null as unknown },
}));

vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => mocks.holder.store,
}));

vi.mock('../../../../src/ui/lib/fx-item-flight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/ui/lib/fx-item-flight')>();
  return {
    ...actual,
    createItemFlight: () => ({
      request: mocks.request,
      dispose: mocks.dispose,
      isBusy: () => false,
    }),
  };
});

import FxItemFlight from '../../../../src/ui/components/fx/FxItemFlight.vue';

const store = reactive<{ messages: ChatMessage[] }>({ messages: [] });
mocks.holder.store = store;

// 各用例的组件共享同一个 store 替身，用完必须卸载，否则旧实例也会跟着起飞
enableAutoUnmount(afterEach);

let seq = 0;
function msg(role: ChatMessage['role'], type?: string): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    role,
    content: '',
    timestamp: seq,
    ...(type ? { systemEvent: { type } } : {}),
  } as unknown as ChatMessage;
}

beforeEach(() => {
  mocks.request.mockClear();
  mocks.dispose.mockClear();
  store.messages = [msg('system', 'item_gen'), msg('assistant')];
});

describe('FxItemFlight', () => {
  it('渲染覆盖层根元素（aria-hidden）', () => {
    const w = mount(FxItemFlight);
    expect(w.classes()).toContain('fx-item-flight');
    expect(w.attributes('aria-hidden')).toBe('true');
  });

  it('挂载时已有的获得物品消息不起飞', async () => {
    mount(FxItemFlight);
    await nextTick();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('新推入 item_gen / craft 系统消息 → 请求一次飞行', async () => {
    mount(FxItemFlight);
    store.messages.push(msg('system', 'item_gen'));
    await nextTick();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    store.messages.push(msg('system', 'craft'));
    await nextTick();
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it('一批推入多条获得物品消息只请求一次', async () => {
    mount(FxItemFlight);
    store.messages.push(msg('system', 'item_gen'), msg('system', 'item_gen'), msg('assistant'));
    await nextTick();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('其他消息不起飞', async () => {
    mount(FxItemFlight);
    store.messages.push(msg('assistant'), msg('system', 'combat'), msg('user'));
    await nextTick();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('整份换掉消息数组（载入历史 / 回退）不起飞，之后的新推入照常起飞', async () => {
    mount(FxItemFlight);
    store.messages = [msg('system', 'item_gen'), msg('system', 'craft')];
    await nextTick();
    expect(mocks.request).not.toHaveBeenCalled();
    store.messages.push(msg('system', 'item_gen'));
    await nextTick();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('卸载时中止在飞动画', () => {
    const w = mount(FxItemFlight);
    w.unmount();
    expect(mocks.dispose).toHaveBeenCalled();
  });
});
