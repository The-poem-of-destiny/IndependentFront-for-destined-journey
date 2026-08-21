import type { ApiCredentialRef, ApiRpmPolicy, ApiRpmWaitItem, ApiRpmWaitSnapshot } from './types';

const RPM_WINDOW_MS = 60_000;
const CREDENTIAL_PREFIX = 'api-rpm-v1\0';

type Waiter = {
  signal?: AbortSignal;
  onAbort?: () => void;
  start: () => void;
  reject: (error: unknown) => void;
};

type Bucket = {
  credentialId: string;
  label: string;
  rpmLimit: number;
  sentAt: number[];
  queue: Waiter[];
  pausedUntil: number | null;
  timer: ReturnType<typeof setTimeout> | null;
};

function abortError(): DOMException {
  return new DOMException('Request aborted', 'AbortError');
}

function normalizeApiBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl.trim());
  parsed.search = '';
  parsed.hash = '';
  return parsed.href.replace(/\/+$/, '');
}

export async function credentialIdFor(
  credential: Pick<ApiCredentialRef, 'baseUrl' | 'apiKey'> &
    Partial<Pick<ApiCredentialRef, 'label'>>,
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto is unavailable; cannot identify API RPM credential');
  }
  const source = `${CREDENTIAL_PREFIX}${normalizeApiBaseUrl(credential.baseUrl)}\0${credential.apiKey}`;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class ApiRpmLimiter {
  private readonly policies = new Map<string, number>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly listeners = new Set<(snapshot: ApiRpmWaitSnapshot) => void>();
  private readonly admissionTails = new Map<string, Promise<void>>();

  async schedule<T>(
    credential: ApiCredentialRef,
    signal: AbortSignal | undefined,
    dispatch: () => Promise<T>,
  ): Promise<T> {
    // Default-unlimited is the hot path. Avoid even the asynchronous fingerprint step so
    // existing request/cancellation timing remains unchanged when no policy is configured.
    if (this.policies.size === 0) return dispatch();
    if (signal?.aborted) throw abortError();
    const leaveAdmission = await this.enterAdmission(credential);
    try {
      if (signal?.aborted) throw abortError();
      const credentialId = await credentialIdFor(credential);
      if (signal?.aborted) throw abortError();
      const rpmLimit = this.policies.get(credentialId);
      if (rpmLimit === undefined) return dispatch();

      const bucket = this.getBucket(credentialId, credential.label, rpmLimit);
      bucket.label = credential.label || bucket.label;
      bucket.rpmLimit = rpmLimit;
      const now = Date.now();
      bucket.sentAt = bucket.sentAt.filter((sentAt) => now - sentAt < RPM_WINDOW_MS);

      if (bucket.pausedUntil === null && bucket.sentAt.length < bucket.rpmLimit) {
        bucket.sentAt.push(now);
        return dispatch();
      }

      return new Promise<T>((resolve, reject) => {
        const waiter: Waiter = {
          signal,
          reject,
          start: () => {
            signal?.removeEventListener('abort', waiter.onAbort!);
            void dispatch().then(resolve, reject);
          },
        };
        waiter.onAbort = () => {
          const index = bucket.queue.indexOf(waiter);
          if (index >= 0) bucket.queue.splice(index, 1);
          reject(abortError());
          this.stopPauseIfEmpty(bucket);
          this.emit();
        };
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        bucket.queue.push(waiter);
        if (bucket.pausedUntil === null) this.startPause(bucket, now);
        this.emit();
      });
    } finally {
      leaveAdmission();
    }
  }

  replacePolicies(policies: readonly ApiRpmPolicy[]): void {
    this.policies.clear();
    for (const policy of policies) {
      if (Number.isSafeInteger(policy.rpmLimit) && policy.rpmLimit > 0) {
        this.policies.set(policy.credentialId, policy.rpmLimit);
      }
    }

    for (const [credentialId, bucket] of this.buckets) {
      const nextLimit = this.policies.get(credentialId);
      if (nextLimit === undefined) {
        this.clearPause(bucket);
        this.release(bucket, bucket.queue.length, false);
        this.buckets.delete(credentialId);
        continue;
      }

      bucket.rpmLimit = nextLimit;
      bucket.sentAt = bucket.sentAt.filter((sentAt) => Date.now() - sentAt < RPM_WINDOW_MS);
      if (bucket.queue.length > 0 && bucket.sentAt.length < nextLimit) {
        this.release(bucket, nextLimit - bucket.sentAt.length, true);
      }
      if (bucket.queue.length === 0) this.clearPause(bucket);
    }
    this.emit();
  }

  subscribe(listener: (snapshot: ApiRpmWaitSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ApiRpmWaitSnapshot {
    const waits: ApiRpmWaitItem[] = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.queue.length === 0 || bucket.pausedUntil === null) continue;
      waits.push({
        credentialId: bucket.credentialId,
        label: bucket.label,
        rpmLimit: bucket.rpmLimit,
        queuedCount: bucket.queue.length,
        resumeAt: bucket.pausedUntil,
      });
    }
    waits.sort((a, b) => a.resumeAt - b.resumeAt || a.label.localeCompare(b.label));
    return { waits };
  }

  private getBucket(credentialId: string, label: string, rpmLimit: number): Bucket {
    let bucket = this.buckets.get(credentialId);
    if (!bucket) {
      bucket = {
        credentialId,
        label,
        rpmLimit,
        sentAt: [],
        queue: [],
        pausedUntil: null,
        timer: null,
      };
      this.buckets.set(credentialId, bucket);
    }
    return bucket;
  }

  private async enterAdmission(credential: ApiCredentialRef): Promise<() => void> {
    const key = `${normalizeApiBaseUrl(credential.baseUrl)}\0${credential.apiKey}`;
    const previous = this.admissionTails.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.admissionTails.set(key, tail);
    await previous;
    return () => {
      unlock();
      if (this.admissionTails.get(key) === tail) this.admissionTails.delete(key);
    };
  }

  private startPause(bucket: Bucket, now: number): void {
    this.clearPause(bucket);
    bucket.pausedUntil = now + RPM_WINDOW_MS;
    bucket.timer = setTimeout(() => this.resume(bucket), RPM_WINDOW_MS);
  }

  private resume(bucket: Bucket): void {
    bucket.timer = null;
    bucket.pausedUntil = null;
    bucket.sentAt = [];
    this.release(bucket, bucket.rpmLimit, true);
    if (bucket.queue.length > 0) this.startPause(bucket, Date.now());
    this.emit();
  }

  private release(bucket: Bucket, count: number, countSlots: boolean): void {
    const released = bucket.queue.splice(0, count);
    for (const waiter of released) {
      if (countSlots) bucket.sentAt.push(Date.now());
      waiter.start();
    }
  }

  private stopPauseIfEmpty(bucket: Bucket): void {
    if (bucket.queue.length !== 0) return;
    this.clearPause(bucket);
  }

  private clearPause(bucket: Bucket): void {
    if (bucket.timer !== null) clearTimeout(bucket.timer);
    bucket.timer = null;
    bucket.pausedUntil = null;
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

const globalLimiter = new ApiRpmLimiter();

export function scheduleApiRequest<T>(
  credential: ApiCredentialRef,
  signal: AbortSignal | undefined,
  dispatch: () => Promise<T>,
): Promise<T> {
  return globalLimiter.schedule(credential, signal, dispatch);
}

export function replaceApiRpmPolicies(policies: readonly ApiRpmPolicy[]): void {
  globalLimiter.replacePolicies(policies);
}

export function subscribeApiRpmWaits(listener: (snapshot: ApiRpmWaitSnapshot) => void): () => void {
  return globalLimiter.subscribe(listener);
}
