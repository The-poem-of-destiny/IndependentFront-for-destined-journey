/**
 * media-hash.test.ts — 唯一哈希实现的行为测试
 *
 * 重点在**降级**而不是算得对不对: 算得对靠一个已知摘要钉住即可，而
 * "非安全上下文里返回 undefined 而不是换个算法、也不抛" 才是这个模块存在的理由。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { hashMediaBytes, hashMediaBlob, isMediaHashAvailable } from './media-hash';

/** 'hello' 的 SHA-256 —— 换算法/换编码这条就会红 */
const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

const hello = (): Uint8Array => new Uint8Array([104, 101, 108, 108, 111]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hashMediaBytes', () => {
  it('已知字节给出已知摘要（小写 hex，64 字符）', async () => {
    const hash = await hashMediaBytes(hello());
    expect(hash).toBe(HELLO_SHA256);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('空字节也算得出（空不是"算不出"）', async () => {
    expect(await hashMediaBytes(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('同样的字节永远同样的结果，不同字节不同结果', async () => {
    const a = await hashMediaBytes(new Uint8Array([1, 2, 3]));
    const again = await hashMediaBytes(new Uint8Array([1, 2, 3]));
    const other = await hashMediaBytes(new Uint8Array([1, 2, 4]));
    expect(a).toBe(again);
    expect(a).not.toBe(other);
  });

  it('crypto.subtle 缺失 → undefined，绝不换第二种算法', async () => {
    vi.stubGlobal('crypto', {});
    expect(isMediaHashAvailable()).toBe(false);
    expect(await hashMediaBytes(hello())).toBeUndefined();
  });

  it('crypto 整个不存在（非安全上下文的极端形态）→ undefined，不抛', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(isMediaHashAvailable()).toBe(false);
    await expect(hashMediaBytes(hello())).resolves.toBeUndefined();
  });

  it('digest 自己抛错 → undefined，不把异常抖给调用方', async () => {
    vi.stubGlobal('crypto', {
      subtle: {
        digest: () => Promise.reject(new Error('operation not supported')),
      },
    });
    expect(isMediaHashAvailable()).toBe(true); // 检测得到，只是用起来会炸
    await expect(hashMediaBytes(hello())).resolves.toBeUndefined();
  });

  it('subtle.digest 不是函数时也算不可用', () => {
    vi.stubGlobal('crypto', { subtle: { digest: 'nope' } });
    expect(isMediaHashAvailable()).toBe(false);
  });
});

describe('hashMediaBlob', () => {
  it('Blob 与其字节算出同一个摘要 —— 上传路径与导入路径必须落在同一个哈希空间', async () => {
    const bytes = hello();
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer]);
    expect(await hashMediaBlob(blob)).toBe(await hashMediaBytes(bytes));
    expect(await hashMediaBlob(blob)).toBe(HELLO_SHA256);
  });

  it('crypto.subtle 缺失 → undefined，且不去读字节（省一次整文件读）', async () => {
    vi.stubGlobal('crypto', {});
    const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(8)));
    expect(await hashMediaBlob({ arrayBuffer } as unknown as Blob)).toBeUndefined();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('读字节失败 → undefined，不抛（上传绝不因哈希失败而失败）', async () => {
    const broken = {
      arrayBuffer: () => Promise.reject(new Error('NotReadableError')),
    } as unknown as Blob;
    await expect(hashMediaBlob(broken)).resolves.toBeUndefined();
  });
});
