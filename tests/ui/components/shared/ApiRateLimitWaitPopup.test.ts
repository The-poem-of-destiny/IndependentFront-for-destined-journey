/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import {
  credentialIdFor,
  replaceApiRpmPolicies,
  scheduleApiRequest,
  subscribeApiRpmWaits,
} from '@engine/api/api-rpm-limiter';
import { useUIStore } from '../../../../src/ui/stores/ui-store';
import { useGameStore } from '../../../../src/ui/stores/game-store';
import ApiRateLimitWaitPopup from '../../../../src/ui/components/shared/ApiRateLimitWaitPopup.vue';

const { confirmDialogMock } = vi.hoisted(() => ({
  confirmDialogMock: vi.fn(async (_options: { danger?: boolean }) => true),
}));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog: confirmDialogMock }));

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  confirmDialogMock.mockClear();
  vi.useFakeTimers();
  setActivePinia(createPinia());
});

afterEach(() => {
  replaceApiRpmPolicies([]);
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('ApiRateLimitWaitPopup', () => {
  it('shows the shared credential wait, counts down, opens settings, and reports automatic resume', async () => {
    const credential = {
      baseUrl: 'https://rpm-popup.example/v1/',
      apiKey: 'popup-test-key',
      label: '剧情 API',
    };
    const credentialId = await credentialIdFor(credential);
    replaceApiRpmPolicies([{ credentialId, rpmLimit: 1, updatedAt: Date.now() }]);

    wrapper = mount(ApiRateLimitWaitPopup, { attachTo: document.body });
    await scheduleApiRequest(credential, undefined, async () => 'first');
    const waitVisible = new Promise<void>((resolve) => {
      const unsubscribe = subscribeApiRpmWaits((snapshot) => {
        if (snapshot.waits.length === 0) return;
        unsubscribe();
        resolve();
      });
    });
    const queued = scheduleApiRequest(credential, undefined, async () => 'second');
    await waitVisible;
    await nextTick();

    expect(document.body.textContent).toContain('API 请求已达到 RPM 限制');
    expect(document.body.textContent).toContain('剧情 API');
    expect(document.body.textContent).toContain('1 RPM · 1 个请求正在等待');
    expect(document.body.textContent).toContain('01:00');

    (document.querySelector('.rpm-popup-footer button') as HTMLButtonElement).click();
    await flushPromises();
    // 没有在跑的回合 → 离开确认直接放行，不弹窗
    expect(confirmDialogMock).not.toHaveBeenCalled();
    const ui = useUIStore();
    expect(ui.currentView).toBe('settings');
    expect(ui.requestedSettingsSection).toBe('api');

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(queued).resolves.toBe('second');
    await flushPromises();
    expect(document.body.textContent).toContain('正在继续…');
    expect(document.querySelector('.rpm-popup')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1200);
    await nextTick();
    expect(document.querySelector('.rpm-popup')).toBeNull();
  });

  it('回合生成中点「打开 API 限制设置」先确认；取消则留在游戏页（G-03）', async () => {
    const credential = {
      baseUrl: 'https://rpm-popup-guard.example/v1/',
      apiKey: 'popup-guard-key',
      label: '剧情 API',
    };
    const credentialId = await credentialIdFor(credential);
    replaceApiRpmPolicies([{ credentialId, rpmLimit: 1, updatedAt: Date.now() }]);
    const ui = useUIStore();
    const viewBefore = ui.currentView;
    useGameStore().isGenerating = true;
    confirmDialogMock.mockResolvedValueOnce(false);

    wrapper = mount(ApiRateLimitWaitPopup, { attachTo: document.body });
    await scheduleApiRequest(credential, undefined, async () => 'first');
    const waitVisible = new Promise<void>((resolve) => {
      const unsubscribe = subscribeApiRpmWaits((snapshot) => {
        if (snapshot.waits.length === 0) return;
        unsubscribe();
        resolve();
      });
    });
    const queued = scheduleApiRequest(credential, undefined, async () => 'second');
    await waitVisible;
    await nextTick();

    (document.querySelector('.rpm-popup-footer button') as HTMLButtonElement).click();
    await flushPromises();

    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(confirmDialogMock.mock.calls[0][0]).toMatchObject({ danger: true });
    expect(ui.currentView).toBe(viewBefore);
    expect(ui.currentView).not.toBe('settings');

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(queued).resolves.toBe('second');
  });
});
