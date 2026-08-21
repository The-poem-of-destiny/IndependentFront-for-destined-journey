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
} from '@engine/api-rpm-limiter';
import { useUIStore } from '../../stores/ui-store';
import ApiRateLimitWaitPopup from './ApiRateLimitWaitPopup.vue';

let wrapper: VueWrapper | null = null;

beforeEach(() => {
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
  it('shows the shared credential wait, counts down, opens settings, and disappears on resume', async () => {
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
    const ui = useUIStore();
    expect(ui.currentView).toBe('settings');
    expect(ui.requestedSettingsSection).toBe('api');

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(queued).resolves.toBe('second');
    await flushPromises();
    expect(document.querySelector('.rpm-popup')).toBeNull();
  });
});
