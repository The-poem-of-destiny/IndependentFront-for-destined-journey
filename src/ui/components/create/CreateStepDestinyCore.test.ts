/**
 * CreateStepDestinyCore — 命定核心步骤同屏承载「两条并列轴」
 *
 * 这一步曾只管命定核心单选，工坊项目多选挂在下一步（角色启用）。挪到同屏是因为
 * 工坊项目可能自带自己的命定核心，与内置那枚撞车 —— D12 明确**不做冲突拦截**
 * （tags 是上游自由文本，猜必误伤），改由用户对照两边自行判断，那就必须让两边
 * 出现在同一屏。所以本文件盯的是「同屏」与「两轴不可混淆」，不是像素。
 *
 * store mock 用 reactive: 裸对象会切断响应式链，"勾选后卡片变 checked" 那条
 * 断言会变得恒真/恒假，测不出东西。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import CreateStepDestinyCore from './CreateStepDestinyCore.vue';
import CreateStepCharacters from './CreateStepCharacters.vue';
import type { WorkshopEnableOption } from '../../lib/workshop-enable';

let mockCreate: any;

vi.mock('../../stores/create-store', () => ({
  useCreateStore: () => mockCreate,
}));

function makeOption(over: Partial<WorkshopEnableOption> = {}): WorkshopEnableOption {
  return {
    projectId: 'p1',
    name: '维拉的旅途',
    description: '一个社区角色包',
    authorName: '作者A',
    version: '1.2.0',
    tags: ['角色', '命定核心'],
    entryUids: [105, 106],
    ...over,
  };
}

beforeEach(() => {
  mockCreate = reactive({
    systemCoreEntries: [
      { uid: 413, name: '剑之魂', content: '一柄剑的低语。' },
      { uid: 414, name: '书之灵', content: '无尽书库的守门人。' },
    ],
    selectedSystemCoreEntryUid: null as number | null,
    get selectedSystemCoreEntry() {
      return (
        this.systemCoreEntries.find((e: any) => e.uid === this.selectedSystemCoreEntryUid) ?? null
      );
    },
    selectSystemCoreEntry(uid: number | null) {
      mockCreate.selectedSystemCoreEntryUid = uid;
      if (uid !== null) mockCreate.selectedWorkshopCoreProjectId = null;
    },

    workshopOptions: [makeOption()] as WorkshopEnableOption[],
    // 组件按「是不是标了『系统』」把项目分到两条轴上，与真 store 同一条判据
    get workshopSystemOptions() {
      return this.workshopOptions.filter((o: WorkshopEnableOption) => o.tags.includes('系统'));
    },
    get workshopExtraOptions() {
      return this.workshopOptions.filter((o: WorkshopEnableOption) => !o.tags.includes('系统'));
    },
    selectedWorkshopCoreProjectId: null as string | null,
    selectWorkshopCore(projectId: string | null) {
      mockCreate.selectedWorkshopCoreProjectId = projectId;
      if (projectId !== null) mockCreate.selectedSystemCoreEntryUid = null;
    },
    enabledWorkshopProjectIds: new Set<string>(),
    toggleWorkshopProject(projectId: string) {
      const next = new Set(mockCreate.enabledWorkshopProjectIds);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      mockCreate.enabledWorkshopProjectIds = next;
    },

    // CreateStepCharacters 需要的最小面
    characterEntries: [{ uid: 313, name: '莉娜', content: '旅店老板。' }],
    enabledCharacterEntryUids: new Set<number>(),
    toggleCharacterEntry: vi.fn(),
  });
});

describe('CreateStepDestinyCore — 工坊项目与命定核心同屏', () => {
  it('工坊项目区在命定核心步骤可见', () => {
    const wrapper = mount(CreateStepDestinyCore);
    expect(wrapper.findComponent({ name: 'WorkshopEnableList' }).exists()).toBe(true);
    expect(wrapper.find('.wk-card').exists()).toBe(true);
    expect(wrapper.text()).toContain('维拉的旅途');
  });

  it('工坊项目可勾选，勾完卡片进入 checked 态', async () => {
    const wrapper = mount(CreateStepDestinyCore);
    const box = wrapper.find('.wk-card input[type="checkbox"]');

    expect(wrapper.find('.wk-card').classes()).not.toContain('checked');
    await box.trigger('change');

    expect(mockCreate.enabledWorkshopProjectIds.has('p1')).toBe(true);
    expect(wrapper.find('.wk-card').classes()).toContain('checked');
  });

  it('★ 两条轴并列且不可混淆: 核心是 radio 单选，工坊是 checkbox 多选', () => {
    const wrapper = mount(CreateStepDestinyCore);

    // 两个分区标题各自带明确的单选/多选徽标
    const labels = wrapper.findAll('.axis-label').map((n) => n.text());
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('命定核心');
    expect(labels[0]).toContain('单选');
    expect(labels[1]).toContain('工坊项目');
    expect(labels[1]).toContain('多选');

    // 命定核心行是 radio；工坊项目一个都不在核心候选列表里
    expect(wrapper.findAll('.core-list [role="radio"]')).toHaveLength(2);
    expect(wrapper.find('.core-list').text()).not.toContain('维拉的旅途');
    expect(wrapper.findAll('.core-list input[type="checkbox"]')).toHaveLength(0);
  });

  it('勾工坊项目不会占用命定核心那个单选槽', async () => {
    const wrapper = mount(CreateStepDestinyCore);
    await wrapper.find('.wk-card input[type="checkbox"]').trigger('change');
    expect(mockCreate.selectedSystemCoreEntryUid).toBeNull();
  });

  it('命定核心单选照旧可用（没被工坊区挤坏）', async () => {
    const wrapper = mount(CreateStepDestinyCore);
    await wrapper.findAll('.core-row-body')[1].trigger('click');
    expect(mockCreate.selectedSystemCoreEntryUid).toBe(414);
    expect(wrapper.find('.selected-detail').text()).toContain('书之灵');
  });

  it('未安装工坊项目时给空态，不是一片空白', () => {
    mockCreate.workshopOptions = [];
    const wrapper = mount(CreateStepDestinyCore);
    expect(wrapper.find('.empty-tab').text()).toContain('工坊项目');
  });

  it('★ 标了「系统」的工坊项目进核心单选名单，不进下方多选区', () => {
    // 此前它混在多选区里：选中既过不了本步的必选闸门（按钮永远不亮，也没有提示），
    // 语义上也说不通 —— 两个命定核心同时生效，设定直接打架。
    mockCreate.workshopOptions = [
      makeOption(),
      makeOption({ projectId: 'sys1', name: '异界律令', tags: ['系统'] }),
    ];
    const wrapper = mount(CreateStepDestinyCore);

    // 它以 radio 身份出现在核心名单里
    expect(wrapper.find('.core-list').text()).toContain('异界律令');
    // 而多选区里没有它（否则同屏出现两次，勾哪个都过不了闸门）
    expect(wrapper.find('.workshop-enable-list').text()).not.toContain('异界律令');
    expect(wrapper.find('.workshop-enable-list').text()).toContain('维拉的旅途');
  });

  it('★ 选工坊核心会顶掉内置核心 —— 命定核心只有一枚', async () => {
    mockCreate.workshopOptions = [
      makeOption({ projectId: 'sys1', name: '异界律令', tags: ['系统'] }),
    ];
    const wrapper = mount(CreateStepDestinyCore);

    mockCreate.selectSystemCoreEntry(413);
    expect(mockCreate.selectedSystemCoreEntryUid).toBe(413);

    const row = wrapper.findAll('.core-row-workshop .core-row-body')[0];
    await row.trigger('click');
    expect(mockCreate.selectedWorkshopCoreProjectId).toBe('sys1');
    expect(mockCreate.selectedSystemCoreEntryUid).toBeNull();
  });
});
