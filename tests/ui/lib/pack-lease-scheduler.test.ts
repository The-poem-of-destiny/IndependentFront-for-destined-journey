import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPackLeaseScheduler } from '../../../src/ui/lib/pack-lease-scheduler';
import { PackApiError } from '../../../src/ui/lib/discord-auth-client';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});
function setup(expiresAt = 7 * 86400000) {
  const lease = { issuedAt: 0, expiresAt, verifiedAt: 0 };
  const renew = vi.fn(async () => {}),
    lock = vi.fn();
  const scheduler = createPackLeaseScheduler({
    lease: () => lease,
    now: Date.now,
    canRenew: () => true,
    renew,
    lock,
  });
  scheduler.start();
  return { scheduler, renew, lock, lease };
}
describe('lease lifecycle scheduling', () => {
  it('single-flights concurrent renewals and heartbeat revalidation', async () => {
    const { scheduler, renew } = setup();
    let finish!: () => void;
    renew.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = scheduler.trigger(),
      second = scheduler.trigger();
    expect(first).toBe(second);
    expect(renew).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await vi.advanceTimersByTimeAsync(15 * 60000);
    expect(renew).toHaveBeenCalledTimes(2);
    finish();
    await scheduler.trigger();
    scheduler.stop();
  });
  it('keeps unexpired content mounted on transient failure and cannot bypass backoff', async () => {
    const { scheduler, renew, lock } = setup();
    renew.mockRejectedValue(new PackApiError(503, 'DISCORD_UNAVAILABLE', 'offline'));
    await expect(scheduler.trigger()).rejects.toThrow('offline');
    scheduler.check();
    await scheduler.trigger();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(lock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300000);
    expect(renew).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });
  it('locks precisely at expiry even when renewal remains in flight', async () => {
    const { scheduler, renew, lock } = setup(2000);
    renew.mockImplementation(() => new Promise<void>(() => {}));
    void scheduler.trigger();
    await vi.advanceTimersByTimeAsync(1999);
    expect(lock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(lock).toHaveBeenCalled();
    scheduler.stop();
  });
  it.each([401, 403])(
    'definite rejection %s locks immediately and blocks automatic retries',
    async (status) => {
      const { scheduler, renew, lock } = setup();
      renew.mockRejectedValue(
        new PackApiError(status, status === 401 ? 'SESSION_EXPIRED' : 'NOT_IN_GUILD', 'denied'),
      );
      await expect(scheduler.trigger()).rejects.toThrow();
      expect(lock).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(16 * 60000);
      expect(renew).toHaveBeenCalledTimes(1);
      renew.mockResolvedValue();
      await scheduler.trigger(true);
      expect(renew).toHaveBeenCalledTimes(2);
      scheduler.stop();
    },
  );
  it('stops timers on disposal', async () => {
    const { scheduler, renew } = setup();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(8 * 86400000);
    expect(renew).not.toHaveBeenCalled();
  });
});
