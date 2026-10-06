/**
 * useAutosave —— 自动存档调度（2026-10-05）
 *
 * 守四件事：
 *   1. 活表变动 → 节流窗口后调用 `runAutosave`；
 *   2. 连续改动**每 N 秒写一次**（节流，不是被无限推迟）；
 *   3. 无活跃存档不调度；
 *   4. 卸载后清定时器（不泄漏、不再调用）。
 *
 * `useGameStore` 用**真 ref** 的假身（读时取当前值，模拟 Pinia 的解包 + 响应式）。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';

vi.mock('../../../src/ui/stores/game-store', async () => {
  const { ref } = await import('vue');
  const activeSaveId = ref<string | null>('save-1');
  const messages = ref<any[]>([]);
  const characters = ref<any[]>([]);
  const saveProfile = ref<any>(null);
  const activePlotEvents = ref<any[]>([]);
  const runAutosave = vi.fn(async () => {});
  return {
    useGameStore: () => ({
      get activeSaveId() {
        return activeSaveId.value;
      },
      get messages() {
        return messages.value;
      },
      get characters() {
        return characters.value;
      },
      get saveProfile() {
        return saveProfile.value;
      },
      get activePlotEvents() {
        return activePlotEvents.value;
      },
      runAutosave,
    }),
    __autosaveState: {
      activeSaveId,
      messages,
      characters,
      saveProfile,
      activePlotEvents,
      runAutosave,
    },
  };
});

import { useAutosave } from '../../../src/ui/composables/useAutosave';
import * as storeMod from '../../../src/ui/stores/game-store';

/** 从被 mock 的 store 模块取出可控 ref（借宽松转换绕开真实模块不含该导出）。 */
const S = (storeMod as unknown as { __autosaveState: any }).__autosaveState;

const Host = defineComponent({
  setup() {
    useAutosave(50);
    return () => h('div');
  },
});

function pushMessage(content: string) {
  S.messages.value = [...S.messages.value, { id: `m-${content}`, role: 'assistant', content }];
}

describe('useAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    S.runAutosave.mockClear();
    S.activeSaveId.value = 'save-1';
    S.messages.value = [];
    S.characters.value = [];
    S.activePlotEvents.value = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('活表变动 → 节流窗口后调用 runAutosave', async () => {
    const w = mount(Host);
    pushMessage('a');
    await w.vm.$nextTick();
    expect(S.runAutosave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(S.runAutosave).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('连续改动每 N 秒写一次（节流，不是无限推迟）', async () => {
    const w = mount(Host);
    pushMessage('a');
    await w.vm.$nextTick();
    vi.advanceTimersByTime(50);
    expect(S.runAutosave).toHaveBeenCalledTimes(1);

    pushMessage('b');
    await w.vm.$nextTick();
    vi.advanceTimersByTime(50);
    expect(S.runAutosave).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('无活跃存档不调度', async () => {
    S.activeSaveId.value = null;
    const w = mount(Host);
    pushMessage('a');
    await w.vm.$nextTick();
    vi.advanceTimersByTime(200);
    expect(S.runAutosave).not.toHaveBeenCalled();
    w.unmount();
  });

  it('卸载后清定时器，不再调用', async () => {
    const w = mount(Host);
    pushMessage('a');
    await w.vm.$nextTick();
    w.unmount();
    vi.advanceTimersByTime(200);
    expect(S.runAutosave).not.toHaveBeenCalled();
  });
});
