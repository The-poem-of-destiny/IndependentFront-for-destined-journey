/**
 * audio-folder.test.ts — File System Access 隔离层测试
 *
 * 全部用假句柄在 node 环境下跑，不需要真浏览器。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isFolderSupported,
  pickLibraryFolder,
  getStoredFolder,
  storeFolder,
  forgetFolder,
  checkPermission,
  requestPermission,
  scanFolder,
  resolveFile,
  __setFolderTestHooks,
  __resetFolderTestHooks,
} from './audio-folder';
import type { AudioHandleRecord } from '@engine/types';

// ═══════════════════════════════════════════════════════════
// 假句柄
// ═══════════════════════════════════════════════════════════

interface FakeFileOpts {
  name: string;
  size?: number;
  type?: string;
  /** getFile() 抛错，模拟单文件读失败 */
  throwOnGetFile?: unknown;
}

function fakeFileHandle(opts: FakeFileOpts) {
  return {
    kind: 'file' as const,
    name: opts.name,
    async getFile() {
      if (opts.throwOnGetFile) throw opts.throwOnGetFile;
      return { name: opts.name, size: opts.size ?? 100, type: opts.type ?? '' };
    },
  };
}

function fakeDirEntry(name: string) {
  return { kind: 'directory' as const, name };
}

interface FakeDirOpts {
  entries?: unknown[];
  permission?: string;
  /** 省略 query/requestPermission 方法 */
  noPermissionMethods?: boolean;
  files?: Record<string, unknown>;
}

function fakeDirHandle(opts: FakeDirOpts = {}) {
  const entries = opts.entries ?? [];
  const dir: Record<string, unknown> = {
    kind: 'directory',
    name: 'music',
    async *values() {
      for (const e of entries) yield e;
    },
    async getFileHandle(name: string) {
      const f = opts.files?.[name];
      if (!f) {
        const err = new Error('not found');
        err.name = 'NotFoundError';
        throw err;
      }
      return f;
    },
  };
  if (!opts.noPermissionMethods) {
    dir.queryPermission = vi.fn(async () => opts.permission ?? 'prompt');
    dir.requestPermission = vi.fn(async () => opts.permission ?? 'prompt');
  }
  return dir as unknown as FileSystemDirectoryHandle;
}

// ═══════════════════════════════════════════════════════════

let store: Map<string, AudioHandleRecord>;

beforeEach(() => {
  __resetFolderTestHooks();
  store = new Map();
  __setFolderTestHooks({
    getHandle: async (id) => store.get(id),
    saveHandle: async (rec) => {
      store.set(rec.id, rec);
      return rec.id;
    },
    deleteHandle: async (id) => {
      store.delete(id);
    },
  });
});

describe('isFolderSupported', () => {
  it('node 环境（无 showDirectoryPicker、无 picker 注入）返回 false 且不抛错', () => {
    __resetFolderTestHooks();
    expect(isFolderSupported()).toBe(false);
  });

  it('注入 picker 后视为支持', () => {
    __setFolderTestHooks({ picker: async () => fakeDirHandle() });
    expect(isFolderSupported()).toBe(true);
  });
});

describe('pickLibraryFolder', () => {
  it('成功时返回句柄并持久化到 library-root', async () => {
    const handle = fakeDirHandle();
    __setFolderTestHooks({ picker: async () => handle });
    const picked = await pickLibraryFolder();
    expect(picked).toBe(handle);
    expect(store.get('library-root')?.handle).toBe(handle);
    expect(store.get('library-root')?.addedAt).toBeGreaterThan(0);
  });

  it('用户取消（AbortError）返回 null 且不写库', async () => {
    const err = new Error('用户取消');
    err.name = 'AbortError';
    __setFolderTestHooks({
      picker: async () => {
        throw err;
      },
    });
    expect(await pickLibraryFolder()).toBeNull();
    expect(store.size).toBe(0);
  });

  it('其他错误照常抛出', async () => {
    const err = new Error('SecurityError 之类');
    err.name = 'SecurityError';
    __setFolderTestHooks({
      picker: async () => {
        throw err;
      },
    });
    await expect(pickLibraryFolder()).rejects.toThrow('SecurityError 之类');
  });

  it('无 picker 可用（不支持的浏览器）返回 null', async () => {
    __resetFolderTestHooks();
    expect(await pickLibraryFolder()).toBeNull();
  });
});

describe('getStoredFolder / storeFolder / forgetFolder', () => {
  it('已存在时返回句柄', async () => {
    const handle = fakeDirHandle();
    await storeFolder(handle);
    expect(await getStoredFolder()).toBe(handle);
  });

  it('不存在时返回 null', async () => {
    expect(await getStoredFolder()).toBeNull();
  });

  it('forgetFolder 后再读为 null', async () => {
    await storeFolder(fakeDirHandle());
    await forgetFolder();
    expect(await getStoredFolder()).toBeNull();
  });
});

describe('checkPermission', () => {
  it('granted', async () => {
    expect(await checkPermission(fakeDirHandle({ permission: 'granted' }))).toBe('granted');
  });

  it('prompt', async () => {
    expect(await checkPermission(fakeDirHandle({ permission: 'prompt' }))).toBe('prompt');
  });

  it('denied', async () => {
    expect(await checkPermission(fakeDirHandle({ permission: 'denied' }))).toBe('denied');
  });

  it('方法缺失时当作 prompt，不崩', async () => {
    expect(await checkPermission(fakeDirHandle({ noPermissionMethods: true }))).toBe('prompt');
  });

  it('方法抛错时当作 prompt', async () => {
    const dir = fakeDirHandle();
    (dir as unknown as { queryPermission: unknown }).queryPermission = async () => {
      throw new Error('boom');
    };
    expect(await checkPermission(dir)).toBe('prompt');
  });

  it('用 mode:read 调用 queryPermission', async () => {
    const dir = fakeDirHandle({ permission: 'granted' });
    await checkPermission(dir);
    expect(
      (dir as unknown as { queryPermission: ReturnType<typeof vi.fn> }).queryPermission,
    ).toHaveBeenCalledWith({ mode: 'read' });
  });
});

describe('requestPermission', () => {
  it('granted → true', async () => {
    expect(await requestPermission(fakeDirHandle({ permission: 'granted' }))).toBe(true);
  });

  it('denied → false', async () => {
    expect(await requestPermission(fakeDirHandle({ permission: 'denied' }))).toBe(false);
  });

  it('方法缺失 → false，不崩', async () => {
    expect(await requestPermission(fakeDirHandle({ noPermissionMethods: true }))).toBe(false);
  });
});

describe('scanFolder', () => {
  it('只保留受支持的音频扩展名，并按文件名排序', async () => {
    const dir = fakeDirHandle({
      entries: [
        fakeFileHandle({ name: 'zeta.mp3', size: 3 }),
        fakeFileHandle({ name: 'readme.txt', size: 1 }),
        fakeFileHandle({ name: 'alpha.flac', size: 2 }),
        fakeFileHandle({ name: 'cover.png', size: 9 }),
        fakeFileHandle({ name: 'mid.opus', size: 5 }),
      ],
    });
    const res = await scanFolder(dir);
    expect(res.map((f) => f.name)).toEqual(['alpha.flac', 'mid.opus', 'zeta.mp3']);
    expect(res[0]).toEqual({ name: 'alpha.flac', size: 2, mimeType: 'audio/flac' });
  });

  it('跳过目录条目（不递归）', async () => {
    const dir = fakeDirHandle({
      entries: [fakeDirEntry('subfolder'), fakeFileHandle({ name: 'a.wav' })],
    });
    const res = await scanFolder(dir);
    expect(res.map((f) => f.name)).toEqual(['a.wav']);
  });

  it('子目录里的音频不会被递归收集', async () => {
    const sub = fakeDirHandle({ entries: [fakeFileHandle({ name: 'deep.mp3' })] });
    const dir = fakeDirHandle({
      entries: [
        Object.assign(sub as unknown as object, { kind: 'directory', name: 'sub' }),
        fakeFileHandle({ name: 'top.mp3' }),
      ],
    });
    const res = await scanFolder(dir);
    expect(res.map((f) => f.name)).toEqual(['top.mp3']);
  });

  it('单个文件读取失败只跳过该文件，其余照常返回', async () => {
    const dir = fakeDirHandle({
      entries: [
        fakeFileHandle({ name: 'bad.mp3', throwOnGetFile: new Error('读失败') }),
        fakeFileHandle({ name: 'good.mp3', size: 7 }),
      ],
    });
    const res = await scanFolder(dir);
    expect(res.map((f) => f.name)).toEqual(['good.mp3']);
  });

  it('文件自带 type 时优先使用文件自身的 MIME', async () => {
    const dir = fakeDirHandle({
      entries: [fakeFileHandle({ name: 'a.m4a', type: 'audio/x-m4a', size: 4 })],
    });
    const res = await scanFolder(dir);
    expect(res[0].mimeType).toBe('audio/x-m4a');
  });

  it('空目录返回空数组；values() 缺失也返回空数组', async () => {
    expect(await scanFolder(fakeDirHandle({ entries: [] }))).toEqual([]);
    expect(await scanFolder({} as unknown as FileSystemDirectoryHandle)).toEqual([]);
  });
});

describe('resolveFile', () => {
  it('命中时返回 File', async () => {
    const file = { name: 'a.mp3', size: 12, type: 'audio/mpeg' };
    const dir = fakeDirHandle({ files: { 'a.mp3': { getFile: async () => file } } });
    expect(await resolveFile(dir, 'a.mp3')).toBe(file as unknown as File);
  });

  it('文件已消失（NotFoundError）返回 null', async () => {
    const dir = fakeDirHandle({ files: {} });
    expect(await resolveFile(dir, 'gone.mp3')).toBeNull();
  });

  it('空路径返回 null', async () => {
    expect(await resolveFile(fakeDirHandle(), '')).toBeNull();
  });
});
