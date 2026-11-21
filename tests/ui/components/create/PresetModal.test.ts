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
import { saveCreatePreset } from '@engine/persistence/database';

let mockCreate: any;
let presetRows: any[];
const confirmDialog = vi.fn(async (_opts: any) => true);

vi.mock('../../../../src/ui/stores/create-store', () => ({
  useCreateStore: () => mockCreate,
}));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: (opts: any) => confirmDialog(opts),
}));
const toast = vi.fn();
vi.mock('../../../../src/ui/stores/ui-store', () => ({
  useUIStore: () => ({ toast }),
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

function mountModal() {
  return mount(PresetModal, {
    props: { visible: true },
    global: { stubs: { AppModal: AppModalStub } },
  });
}

function findButton(wrapper: ReturnType<typeof mountModal>, label: string, index = 0) {
  return wrapper.findAllComponents({ name: 'AppButton' }).filter((b) => b.text() === label)[index]!;
}

beforeEach(() => {
  vi.mocked(saveCreatePreset).mockClear();
  confirmDialog.mockClear();
  toast.mockClear();
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

describe('PresetModal — 初始等级上限（Lv.10）', () => {
  it('★ 预设被截断时弹警告 toast，写明原等级、新等级与需重分属性点', async () => {
    mockCreate.hasDraftContent = false;
    mockCreate.applyPresetData = vi.fn(() => 18);
    const wrapper = await mountAndLoad();
    expect(toast).toHaveBeenCalledTimes(1);
    const [message, type] = toast.mock.calls[0];
    expect(type).toBe('warning');
    expect(message).toContain('Lv.18');
    expect(message).toContain('Lv.10');
    expect(message).toContain('属性点');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('未截断时不弹 toast', async () => {
    mockCreate.hasDraftContent = false;
    mockCreate.applyPresetData = vi.fn(() => null);
    await mountAndLoad();
    expect(toast).not.toHaveBeenCalled();
  });

  it('★ 列表与详情标出等级超过上限的预设', async () => {
    presetRows = [
      makeRow({ character: { name: '高阶', race: '人类', level: 15 } }),
      { ...makeRow(), id: 'p2', name: '新手' },
    ];
    const wrapper = mount(PresetModal, {
      props: { visible: true },
      global: { stubs: { AppModal: AppModalStub } },
    });
    await flushPromises();
    const cards = wrapper.findAll('.preset-card');
    expect(cards[0].find('[data-test="preset-level-cap"]').exists()).toBe(true);
    expect(cards[1].find('[data-test="preset-level-cap"]').exists()).toBe(false);
    await cards[0].find('.preset-header').trigger('click');
    expect(wrapper.find('.preset-detail').text()).toContain('Lv.15（加载后为 Lv.10）');
  });
});

describe('PresetModal — 仅载入主角', () => {
  async function loadPersona() {
    const wrapper = mountModal();
    await flushPromises();
    findButton(wrapper, '仅载入主角').vm.$emit('click');
    await flushPromises();
    return wrapper;
  }

  it('★ 以 persona 范围调用 store，并关闭弹窗', async () => {
    const wrapper = await loadPersona();
    expect(mockCreate.applyPresetData).toHaveBeenCalledTimes(1);
    expect(mockCreate.applyPresetData.mock.calls[0][1]).toBe('persona');
    expect(mockCreate.applyPresetData.mock.calls[0][0].name).toBe('旧角色');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('★ 确认文案分列替换与保留的内容', async () => {
    await loadPersona();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const opts = confirmDialog.mock.calls[0][0];
    expect(opts.title).toContain('主角');
    const details = (opts.details as string[]).join('\n');
    expect(details).toContain('替换');
    expect(details).toContain('生日');
    expect(details).toContain('保留');
    expect(details).toContain('难度');
    expect(details).toContain('起始地点');
    expect(details).toContain('开局提示词');
  });

  it('取消确认时不调用 store', async () => {
    confirmDialog.mockResolvedValueOnce(false);
    const wrapper = await loadPersona();
    expect(mockCreate.applyPresetData).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('★ 等级被截断时与整份载入同样弹警告', async () => {
    mockCreate.hasDraftContent = false;
    mockCreate.applyPresetData = vi.fn(() => 18);
    await loadPersona();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain('Lv.18');
    expect(toast.mock.calls[0][1]).toBe('warning');
  });

  it('整份「加载」仍以默认范围调用 store', async () => {
    await mountAndLoad();
    expect(mockCreate.applyPresetData).toHaveBeenCalledTimes(1);
    expect(mockCreate.applyPresetData.mock.calls[0][1]).toBeUndefined();
  });
});

describe('PresetModal — 重命名', () => {
  async function startRename(rows = [makeRow()]) {
    presetRows = rows;
    const wrapper = mountModal();
    await flushPromises();
    findButton(wrapper, '重命名').vm.$emit('click');
    await flushPromises();
    return wrapper;
  }

  async function submit(wrapper: ReturnType<typeof mountModal>, name: string) {
    await wrapper.find('[data-test="preset-rename-input"]').setValue(name);
    findButton(wrapper, '确认').vm.$emit('click');
    await flushPromises();
  }

  it('★ 去掉首尾空白后写入外壳与 data 的名字，保留 id / createdAt 并更新 updatedAt', async () => {
    const wrapper = await startRename();
    await submit(wrapper, '  新名字  ');
    expect(saveCreatePreset).toHaveBeenCalledTimes(1);
    const rec = vi.mocked(saveCreatePreset).mock.calls[0][0];
    expect(rec.id).toBe('p1');
    expect(rec.createdAt).toBe(1);
    expect(rec.name).toBe('新名字');
    expect(rec.data.name).toBe('新名字');
    expect(rec.data.id).toBe('p1');
    expect(rec.data.createdAt).toBe(1);
    expect(rec.updatedAt).toBeGreaterThan(1);
    expect(rec.data.updatedAt).toBe(rec.updatedAt);
    expect(rec.data.character.name).toBe('露娜');
    expect(wrapper.find('[data-test="preset-rename-input"]').exists()).toBe(false);
  });

  it('★ 空名字被拒绝并在行内提示', async () => {
    const wrapper = await startRename();
    await submit(wrapper, '   ');
    expect(saveCreatePreset).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="preset-rename-error"]').text()).toContain('不能为空');
  });

  it('★ 与其他预设重名时被拒绝并在行内提示', async () => {
    const wrapper = await startRename([makeRow(), { ...makeRow(), id: 'p2', name: '另一个' }]);
    await submit(wrapper, '另一个');
    expect(saveCreatePreset).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="preset-rename-error"]').text()).toContain('另一个');
  });

  it('名字未改时直接退出编辑，不写库', async () => {
    const wrapper = await startRename();
    await submit(wrapper, '旧角色');
    expect(saveCreatePreset).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="preset-rename-input"]').exists()).toBe(false);
  });

  it('取消后恢复操作栏', async () => {
    const wrapper = await startRename();
    findButton(wrapper, '取消').vm.$emit('click');
    await flushPromises();
    expect(wrapper.find('[data-test="preset-rename-input"]').exists()).toBe(false);
    expect(findButton(wrapper, '加载')).toBeTruthy();
  });
});

describe('PresetModal — 详情显示年龄与生日', () => {
  async function openDetail(character: Record<string, unknown>) {
    presetRows = [makeRow({ character })];
    const wrapper = mountModal();
    await flushPromises();
    await wrapper.find('.preset-header').trigger('click');
    return wrapper.find('.preset-detail').text();
  }

  it('★ 有生日时显示「M月D日」与年龄', async () => {
    const text = await openDetail({
      name: '露娜',
      race: '人类',
      level: 1,
      age: 19,
      birthday: { month: 3, day: 15 },
    });
    expect(text).toContain('年龄19');
    expect(text).toContain('生日3月15日');
  });

  it('没有生日时显示「未设置」', async () => {
    const text = await openDetail({ name: '露娜', race: '人类', level: 1, birthday: null });
    expect(text).toContain('生日未设置');
  });
});
