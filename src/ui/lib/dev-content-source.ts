/**
 * dev-content-source.ts — 开发期「内容源」选择的纯解析器
 *
 * 开发时有两路内容源：已安装的内容包（Dexie `contentPacks` 行）与本地内容目录
 * （vite 中间件把 POEM_CONTENT_DIR 挂在 `/data/*`）。现状是已安装包总会静默盖住本地目录；
 * 这里只负责把「偏好 + 环境事实」解析成决策与提示，不读 `import.meta.env`、不碰 Vue/Dexie ——
 * 「仅开发期生效」的门由调用点负责。
 */

import type { ContentPack } from '@engine/types/types-content';

/** 'pack' = 现状（有包就用包）；'local' = 保留包行但不激活，改走本地目录。 */
export type DevContentSourcePreference = 'pack' | 'local';

export const DEV_CONTENT_SOURCE_KEY = 'poem_dev_content_source_v1';

/** 已安装包的最小事实：身份 + 是否受保护（加密/旧锁定包）。 */
export type DevInstalledPackInfo = Pick<ContentPack, 'packId' | 'packVersion'> & {
  protected: boolean;
};

export type DevContentNotice =
  'local-dir-missing' | 'pack-missing' | 'local-file-pack-materialized';

export interface DevContentSourceInput {
  preference: DevContentSourcePreference;
  /** 构建期是否配置了本地内容目录（`__POEM_CONTENT_DIR__` 非空） */
  localDirConfigured: boolean;
  installedPack: DevInstalledPackInfo | null;
}

export interface DevContentSourceResolution {
  preference: DevContentSourcePreference;
  /** true = 调用点不应激活已安装包 */
  suppressPack: boolean;
  suppressedPack: Pick<ContentPack, 'packId' | 'packVersion'> | null;
  notices: DevContentNotice[];
}

function isPreference(value: unknown): value is DevContentSourcePreference {
  return value === 'pack' || value === 'local';
}

function defaultStorage(): Storage | undefined {
  return (globalThis as { localStorage?: Storage }).localStorage;
}

/** 缺失、无法识别或存储抛错时一律回落 'pack'（即现状）。 */
export function readDevContentSourcePreference(
  storage?: Pick<Storage, 'getItem'>,
): DevContentSourcePreference {
  try {
    const raw = (storage ?? defaultStorage())?.getItem(DEV_CONTENT_SOURCE_KEY);
    return isPreference(raw) ? raw : 'pack';
  } catch {
    return 'pack';
  }
}

/** 写入偏好；存储不可用或抛错时静默忽略（开发便利项，丢了无妨）。 */
export function writeDevContentSourcePreference(
  preference: DevContentSourcePreference,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    (storage ?? defaultStorage())?.setItem(DEV_CONTENT_SOURCE_KEY, preference);
  } catch {
    // 隐私模式 / 配额满 / 存储被禁用：放弃持久化即可
  }
}

export function resolveDevContentSource(input: DevContentSourceInput): DevContentSourceResolution {
  const { preference, localDirConfigured, installedPack } = input;
  const notices: DevContentNotice[] = [];
  const suppressPack = preference === 'local' && installedPack !== null;

  if (preference === 'local') {
    // 没配本地目录时 `/data/*` 落到 public/data 占位内容
    if (!localDirConfigured) notices.push('local-dir-missing');
    // 非保护包的世界书与预设已物化进 Dexie（worldBooks / presets），不激活包也删不掉它们
    if (installedPack && !installedPack.protected) notices.push('local-file-pack-materialized');
  } else if (installedPack === null) {
    // 偏好用包但没有包：照旧回落到 `/data/*`
    notices.push('pack-missing');
  }

  return {
    preference,
    suppressPack,
    suppressedPack:
      suppressPack && installedPack
        ? { packId: installedPack.packId, packVersion: installedPack.packVersion }
        : null,
    notices,
  };
}

const NOTICE_TEXT: Record<DevContentNotice, string> = {
  'local-dir-missing':
    '未配置本地内容目录（POEM_CONTENT_DIR），/data 将提供 public/data 下的占位内容。',
  'pack-missing': '当前没有已安装的内容包，将回落到本地 /data 内容。',
  'local-file-pack-materialized':
    '已安装的内容包未加密，其世界书与预设已写入本地数据库；切到本地目录后它们仍会保留、可能与本地内容混用，其中的预设此时会显示为「我的预设」——这一模式下请勿编辑它们。',
};

export function describeDevContentNotices(notices: readonly DevContentNotice[]): string[] {
  return notices.map((notice) => NOTICE_TEXT[notice]);
}
