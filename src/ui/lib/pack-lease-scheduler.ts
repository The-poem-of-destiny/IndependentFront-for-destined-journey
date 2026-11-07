import { PackApiError } from './discord-auth-client';

export interface PackLeaseSchedule {
  issuedAt: number;
  expiresAt: number;
  verifiedAt: number;
}
interface LeaseSchedulerOptions {
  lease: () => PackLeaseSchedule | null;
  now: () => number;
  canRenew: () => boolean;
  renew: () => Promise<void>;
  lock: () => void;
}
const HEARTBEAT = 15 * 60 * 1000;
const BACKOFF = [60000, 300000, 900000];
export function isPackAccessDenied(error: unknown): boolean {
  return (
    error instanceof PackApiError &&
    (error.status === 401 ||
      (error.status === 403 &&
        ['NOT_IN_GUILD', 'MISSING_REQUIRED_ROLE', 'USER_BLOCKED'].includes(error.code)))
  );
}
export function isPackLeaseNearExpiry(lease: PackLeaseSchedule, now: number): boolean {
  return lease.expiresAt - now <= Math.max((lease.expiresAt - lease.issuedAt) * 0.25, 48 * 3600000);
}

/** Timers are lifecycle-owned, single-flight and never shorten a still-valid lease on transient faults. */
export function createPackLeaseScheduler(options: LeaseSchedulerOptions) {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let failureCount = 0,
    blocked = false,
    started = false,
    lastWake = -Infinity;
  let nextRetryAt = 0;

  function armDeadline() {
    clearTimeout(deadline);
    deadline = undefined;
    const lease = options.lease();
    if (!started || !lease) return;
    const remaining = lease.expiresAt - options.now();
    if (remaining <= 0) {
      options.lock();
      return;
    }
    const delay = remaining > 300000 ? remaining - 300000 : remaining;
    deadline = setTimeout(
      () => {
        const current = options.lease();
        if (current && current.expiresAt <= options.now()) options.lock();
        void trigger().catch(() => {});
        armDeadline();
      },
      Math.min(delay, 2147483647),
    );
  }
  function trigger(manual = false): Promise<void> {
    if (manual) {
      blocked = false;
      failureCount = 0;
      nextRetryAt = 0;
      clearTimeout(retry);
    }
    if (inFlight) return inFlight;
    if (blocked || options.now() < nextRetryAt || !options.canRenew() || !options.lease())
      return Promise.resolve();
    inFlight = options
      .renew()
      .then(() => {
        failureCount = 0;
        nextRetryAt = 0;
        clearTimeout(retry);
      })
      .catch((error: unknown) => {
        if (isPackAccessDenied(error)) {
          blocked = true;
          options.lock();
        } else {
          const lease = options.lease();
          if (lease && lease.expiresAt <= options.now()) options.lock();
          if (started) {
            clearTimeout(retry);
            const delay = Math.max(
              BACKOFF[Math.min(failureCount++, BACKOFF.length - 1)]!,
              error instanceof PackApiError ? error.retryAfterMs : 0,
            );
            nextRetryAt = options.now() + delay;
            retry = setTimeout(() => {
              void trigger().catch(() => {});
            }, delay);
          }
        }
        throw error;
      })
      .finally(() => {
        inFlight = null;
        armDeadline();
      });
    return inFlight;
  }
  function check() {
    const lease = options.lease();
    if (!lease) return;
    const now = options.now();
    if (now >= lease.expiresAt) options.lock();
    if (isPackLeaseNearExpiry(lease, now) || now - lease.verifiedAt >= HEARTBEAT)
      void trigger().catch(() => {});
    armDeadline();
  }
  function wake() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (options.now() - lastWake < 300000) return;
    lastWake = options.now();
    check();
  }
  function online() {
    check();
  }
  function start() {
    if (started) {
      armDeadline();
      return;
    }
    started = true;
    heartbeat = setInterval(check, HEARTBEAT);
    armDeadline();
    if (typeof window !== 'undefined') window.addEventListener('online', online);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
  }
  function stop() {
    started = false;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    clearTimeout(retry);
    if (typeof window !== 'undefined') window.removeEventListener('online', online);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
  }
  return { start, stop, trigger, check };
}
