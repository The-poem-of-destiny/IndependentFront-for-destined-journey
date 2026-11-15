import { describe, expect, it } from 'vitest';
import {
  WORKSHOP_LOCKED,
  hasExtensionWork,
} from '../../../../src/ui/components/workshop/workshop-lock';

describe('workshop-lock', () => {
  it('当前创意工坊入口处于锁定状态', () => {
    expect(WORKSHOP_LOCKED).toBe(true);
  });

  it('锁定时只有装过社区扩展才算有事可做', () => {
    expect(hasExtensionWork({ locked: true, ready: true, installedCount: 0 })).toBe(false);
    expect(hasExtensionWork({ locked: true, ready: true, installedCount: 2 })).toBe(true);
  });

  it('锁定且尚未读完时一律不显示，避免闪烁', () => {
    expect(hasExtensionWork({ locked: true, ready: false, installedCount: 3 })).toBe(false);
  });

  it('解锁后无论是否装过都有事可做', () => {
    expect(hasExtensionWork({ locked: false, ready: false, installedCount: 0 })).toBe(true);
  });

  it('不传 locked 时读取锁定常量', () => {
    expect(hasExtensionWork({ ready: true, installedCount: 0 })).toBe(!WORKSHOP_LOCKED);
  });
});
