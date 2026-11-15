/**
 * BeautifierSection —— 自定义规则删除与导入的防丢数据回归（审查 S-32 / S-33）
 *
 * - 删除按钮有图标与「删除规则」可读名，删除前确认并点名规则；
 * - 导入：坏 JSON / 错结构报原因；裸数组在已有自定义规则时先问「替换」，
 *   不替换可改为「追加导入」；成功报数量。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import type { BeautifierRule } from '@engine/types/types';
import { parseRuleImport } from '../../../../src/ui/components/settings/beautifier-import';

import type { ConfirmDialogOptions } from '../../../../src/ui/lib/confirm-dialog';

const confirmDialog = vi.hoisted(() =>
  vi.fn<(o: ConfirmDialogOptions) => Promise<boolean>>(async () => true),
);
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog }));

const toast = vi.fn();
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ({ toast }) }));

const settings = reactive<Record<string, unknown>>({
  beautifierEnabled: true,
  beautifierBuiltinDisabled: [],
});
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({ settings, saveNow: vi.fn() }),
}));
vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => ({ activeSave: null, characters: [] }),
}));

function rule(id: string, name = `规则${id}`): BeautifierRule {
  return {
    id,
    name,
    scope: 'maintext',
    pattern: 'x',
    flags: 'g',
    replacement: 'y',
    enabled: true,
    order: 0,
    isBuiltin: false,
  };
}

const store = reactive({
  userRules: [] as BeautifierRule[],
  presetRules: [] as BeautifierRule[],
  init: vi.fn(async () => {}),
  refreshPresetRules: vi.fn(async () => {}),
  deleteRule: vi.fn(async (id: string) => {
    store.userRules = store.userRules.filter((r) => r.id !== id);
  }),
  upsertRules: vi.fn(async (_list: BeautifierRule[]) => {}),
  replaceAllRules: vi.fn(async (_list: BeautifierRule[]) => {}),
  upsertRule: vi.fn(),
  toggleRule: vi.fn(),
});
vi.mock('../../../../src/ui/stores/beautifier-store', () => ({ useBeautifierStore: () => store }));

import BeautifierSection from '../../../../src/ui/components/settings/BeautifierSection.vue';

const wrappers: VueWrapper[] = [];
async function mountSection() {
  const wrapper = mount(BeautifierSection, {
    attachTo: document.body,
    global: { stubs: { RuleEditorModal: true } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

async function importFile(wrapper: VueWrapper, content: string) {
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
  await wrapper
    .findAll('button')
    .find((b) => b.text() === '导入规则')!
    .trigger('click');
  const picker = click.mock.contexts[0] as HTMLInputElement;
  click.mockRestore();
  const file = new File([content], 'rules.json', { type: 'application/json' });
  Object.defineProperty(picker, 'files', { value: [file] });
  (picker.onchange as (e: Event) => void)({ target: picker } as unknown as Event);
  await flushPromises();
}

beforeEach(() => {
  store.userRules = [];
  confirmDialog.mockReset();
  confirmDialog.mockResolvedValue(true);
  toast.mockReset();
  store.deleteRule.mockClear();
  store.upsertRules.mockClear();
  store.replaceAllRules.mockClear();
});
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()));

describe('parseRuleImport', () => {
  it('导出格式 → 追加语义并带 builtinDisabled', () => {
    const parsed = parseRuleImport({ version: 1, builtinDisabled: ['a', 3], rules: [rule('r1')] });
    expect(parsed).toMatchObject({ replace: false, builtinDisabled: ['a'] });
  });
  it('裸数组 → 替换语义', () => {
    expect(parseRuleImport([rule('r1')])).toMatchObject({ replace: true });
  });
  it('结构不对给出原因', () => {
    expect(parseRuleImport({ foo: 1 })).toContain('没有规则列表');
    expect(parseRuleImport([])).toContain('空的');
    expect(parseRuleImport([{ id: 'a', pattern: 'x' }])).toContain('第 1 条规则缺少替换内容');
    expect(parseRuleImport([42])).toContain('第 1 条规则不是对象');
  });
});

describe('BeautifierSection 删除自定义规则（S-32）', () => {
  it('删除按钮有图标与可读名称，确认后才删并点名规则', async () => {
    store.userRules = [rule('r1', '对话气泡')];
    const wrapper = await mountSection();
    const btn = wrapper.get('button.rule-delete-btn');
    expect(btn.attributes('title')).toBe('删除规则');
    expect(btn.attributes('aria-label')).toBe('删除规则 对话气泡');
    expect(btn.find('i.fa-trash').exists()).toBe(true);

    confirmDialog.mockResolvedValueOnce(false);
    await btn.trigger('click');
    await flushPromises();
    expect(store.deleteRule).not.toHaveBeenCalled();
    const opts = confirmDialog.mock.calls[0][0] as { message: string; danger: boolean };
    expect(opts.message).toContain('对话气泡');
    expect(opts.danger).toBe(true);

    await btn.trigger('click');
    await flushPromises();
    expect(store.deleteRule).toHaveBeenCalledWith('r1');
  });
});

describe('BeautifierSection 导入规则（S-33）', () => {
  it('坏 JSON → 错误提示，不写库', async () => {
    const wrapper = await mountSection();
    await importFile(wrapper, '{bad');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('不是有效的 JSON'), 'error');
    expect(store.upsertRules).not.toHaveBeenCalled();
    expect(store.replaceAllRules).not.toHaveBeenCalled();
  });

  it('结构不对 → 错误提示带原因', async () => {
    const wrapper = await mountSection();
    await importFile(wrapper, JSON.stringify({ hello: 1 }));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('没有规则列表'), 'error');
  });

  it('裸数组 + 已有规则：确认「替换」才整体替换，提示含原有条数', async () => {
    store.userRules = [rule('old1'), rule('old2')];
    const wrapper = await mountSection();
    await importFile(wrapper, JSON.stringify([rule('n1')]));
    const opts = confirmDialog.mock.calls[0][0] as { message: string; danger: boolean };
    expect(opts.message).toContain('将替换现有 2 条自定义规则');
    expect(opts.danger).toBe(true);
    expect(store.replaceAllRules).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('替换了原有 2 条'), 'success');
  });

  it('裸数组 + 已有规则：不替换 → 选「追加导入」走 upsert', async () => {
    store.userRules = [rule('old1')];
    confirmDialog.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const wrapper = await mountSection();
    await importFile(wrapper, JSON.stringify([rule('n1'), rule('old1')]));
    expect(store.replaceAllRules).not.toHaveBeenCalled();
    expect(store.upsertRules).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('已导入 2 条规则（新增 1 条，更新同 id 1 条）', 'success');
  });

  it('裸数组 + 已有规则：两次都取消 → 什么都不写', async () => {
    store.userRules = [rule('old1')];
    confirmDialog.mockResolvedValue(false);
    const wrapper = await mountSection();
    await importFile(wrapper, JSON.stringify([rule('n1')]));
    expect(store.replaceAllRules).not.toHaveBeenCalled();
    expect(store.upsertRules).not.toHaveBeenCalled();
  });

  it('没有已有规则时不问，直接导入并报数量', async () => {
    const wrapper = await mountSection();
    await importFile(wrapper, JSON.stringify({ version: 1, rules: [rule('n1'), rule('n2')] }));
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(store.upsertRules).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('已导入 2 条规则', 'success');
  });
});
