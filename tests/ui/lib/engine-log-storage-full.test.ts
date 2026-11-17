import { describe, expect, it, vi } from 'vitest';
import { handleEngineLogStorageFull } from '../../../src/ui/lib/engine-log-storage-full';

describe('engine-log-storage-full', () => {
  it('存储已满：把设置里的开关关掉，并弹常驻错误提示', () => {
    const settings = { engineLogEnabled: true };
    const toast = vi.fn();

    handleEngineLogStorageFull({ settings, toast });

    expect(settings.engineLogEnabled).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      '存储已满，完整运行日志已自动关闭；请到开发者设置导出并清空后重新开启',
      'error',
      0,
    );
  });
});
