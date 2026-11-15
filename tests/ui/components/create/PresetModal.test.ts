/**
 * PresetModal — 「加载」预设前的覆盖确认（C-13）
 *
 * 加载会整份替换当前草稿：草稿非空时必须先确认并列出替换内容；
 * 预设带大纲且当前已有大纲时，确认里要点明大纲也会被替换（被替换的大纲进历史，可回退）。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, reactive } from 'vue';
import PresetModal from '../../../../src/ui/components/create/PresetModal.vue';

let mockCreate: any;
let presetRows: any[];
const confirmDialog = vi.fn(async (_opts: any) => true);

vi.mock('../../../../src/ui/stores/create-store', () => ({
  useCreateStore: () => mockCreate,
}));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: (opts: any) => confirmDialog(opts),
}));
vi.mock('@engine/persistence/database', () => ({
  getCreatePresets: vi.fn(async () => presetRows),
  saveCreatePreset: vi.fn(async () => {}),
  deleteCreatePreset: vi.fn(async () => {}),
}));

// AppModal 走 Teleport，这里换成原地渲染的替身，便于查找按钮
const AppModalStub = defineComponent({
  name: 'AppModal',
  props: { open: Boolean },
  setup(_props, { slots }) {
    return () => h('div', [slots.header?.(), slots.default?.(), slots.footer?.()]);
  },
});

function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: '旧角色',
    createdAt: 1,
    updatedAt: 1,
    data: {
      id: 'p1',
      name: '旧角色',
      createdAt: 1,
      updatedAt: 1,
      difficulty: 'normal',
      character: { name: '露娜', race: '人类', level: 1 },
      equipments: [],
      items: [],
      skills: [],
      ...over,
    },
  };
}

async function mountAndLoad() {
  const wrapper = mount(PresetModal, {
    props: { visible: true },
    global: { stubs: { AppModal: AppModalStub } },
  });
  await flushPromises();
  const load = wrapper.findAllComponents({ name: 'AppButton' }).find((b) => b.text() === '加载')!;
  load.vm.$emit('click');
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  confirmDialog.mockClear();
  confirmDialog.mockResolvedValue(true);
  presetRows = [makeRow()];
  mockCreate = reactive({
    hasDraftContent: true,
    plotOutline: null as unknown,
    applyPresetData: vi.fn(),
    getCurrentPresetData: vi.fn(() => ({})),
  });
});

describe('PresetModal — 加载前确认（C-13）', () => {
  it('草稿为空时直接加载，不打扰', async () => {
    mockCreate.hasDraftContent = false;
    const wrapper = await mountAndLoad();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(mockCreate.applyPresetData).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('★ 草稿非空时先确认，并列出会被替换的内容', async () => {
    await mountAndLoad();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const opts = confirmDialog.mock.calls[0][0];
    expect(opts.title).toContain('旧角色');
    expect(opts.details.join('\n')).toContain('角色信息');
    expect(opts.details.join('\n')).not.toContain('剧情大纲');
    expect(mockCreate.applyPresetData).toHaveBeenCalledTimes(1);
  });

  it('★ 取消确认时什么都不替换，弹窗不关', async () => {
    confirmDialog.mockResolvedValueOnce(false);
    const wrapper = await mountAndLoad();
    expect(mockCreate.applyPresetData).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('★ 预设带大纲且当前已有大纲时，确认里点明大纲会被替换且可回退', async () => {
    mockCreate.plotOutline = { title: '当前大纲' };
    presetRows = [makeRow({ plotOutline: { title: '预设大纲' }, plotOutlineChapters: [] })];
    await mountAndLoad();
    const details: string[] = confirmDialog.mock.calls[0][0].details;
    expect(details.some((d) => d.includes('剧情大纲') && d.includes('回退上一版'))).toBe(true);
  });
});
