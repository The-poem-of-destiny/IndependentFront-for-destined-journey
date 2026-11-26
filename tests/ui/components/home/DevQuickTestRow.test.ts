/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DevQuickTestRow from '../../../../src/ui/components/home/DevQuickTestRow.vue';
import homePageSource from '../../../../src/ui/components/home/HomePage.vue?raw';

const mocks = vi.hoisted(() => ({
  ui: { navigate: vi.fn() },
  confirmDialog: vi.fn<() => Promise<boolean>>(),
  createTestSave: vi.fn<() => Promise<string>>(),
  createTestSavePreservingData: vi.fn<() => Promise<string>>(),
}));

vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => mocks.ui }));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog: mocks.confirmDialog }));
vi.mock('../../../../src/ui/utils/test-save', () => ({
  createTestSave: mocks.createTestSave,
  createTestSavePreservingData: mocks.createTestSavePreservingData,
}));

function mountRow() {
  return mount(DevQuickTestRow, {
    global: {
      stubs: {
        AppButton: { template: '<button v-bind="$attrs"><slot /></button>' },
      },
    },
  });
}

beforeEach(() => {
  mocks.ui.navigate.mockReset();
  mocks.confirmDialog.mockReset();
  mocks.createTestSave.mockReset().mockResolvedValue('test-1');
  mocks.createTestSavePreservingData.mockReset().mockResolvedValue('test-2');
});

describe('DevQuickTestRow 开发用快速测试', () => {
  it('清库建档前必须确认，取消时不建档', async () => {
    mocks.confirmDialog.mockResolvedValue(false);
    const row = mountRow();
    await row.findAll('button')[0]!.trigger('click');
    await flushPromises();
    expect(mocks.confirmDialog).toHaveBeenCalledTimes(1);
    expect(mocks.createTestSave).not.toHaveBeenCalled();
    expect(mocks.ui.navigate).not.toHaveBeenCalled();
  });

  it('确认后建测试存档并进入游戏页', async () => {
    mocks.confirmDialog.mockResolvedValue(true);
    const row = mountRow();
    await row.findAll('button')[0]!.trigger('click');
    await flushPromises();
    expect(mocks.createTestSave).toHaveBeenCalledTimes(1);
    expect(mocks.ui.navigate).toHaveBeenCalledWith('game', 'test-1');
  });

  it('保留数据版不确认、不清库', async () => {
    const row = mountRow();
    await row.findAll('button')[1]!.trigger('click');
    await flushPromises();
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
    expect(mocks.createTestSave).not.toHaveBeenCalled();
    expect(mocks.ui.navigate).toHaveBeenCalledWith('game', 'test-2');
  });
});

describe('HomePage 快速测试入口的生产门控（源码断言）', () => {
  it('以字面量 import.meta.env.DEV 门控异步引入，生产构建才能整块摇掉', () => {
    expect(homePageSource).toMatch(
      /import\.meta\.env\.DEV\s*\?\s*defineAsyncComponent\(\(\) => import\('\.\/DevQuickTestRow\.vue'\)\)\s*:\s*null/,
    );
  });

  it('HomePage 不再直接引用 test-save，也不经常量转存 DEV 标志', () => {
    expect(homePageSource).not.toContain('utils/test-save');
    expect(homePageSource).not.toMatch(/const\s+isDev\s*=/);
    expect(homePageSource).not.toMatch(/import\s+DevQuickTestRow\s+from/);
  });
});
