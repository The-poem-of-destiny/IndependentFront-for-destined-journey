/**
 * CreateStepPlot — 剧情关闭时隐藏大纲区（UIL-14）+ 与设置页共用参数范围（UIL-10）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { reactive } from 'vue';
import CreateStepPlot from '../../../../src/ui/components/create/CreateStepPlot.vue';
import {
  PLOT_COUNT_MIN,
  PLOT_DIFFICULTY_OPTIONS,
  PLOT_DURATION_YEARS_MAX,
} from '../../../../src/ui/lib/create-options';

let mockCreate: any;
vi.mock('../../../../src/ui/stores/create-store', () => ({
  useCreateStore: () => mockCreate,
}));

beforeEach(() => {
  mockCreate = reactive({
    plotMode: 'off',
    plotDurationYears: 5,
    plotChapterCount: 0,
    plotEventsPerChapter: 0,
    plotDifficultyTier: 'adaptive',
    plotAllowNonWorldbookNpc: true,
    plotGenrePreference: ['combat'],
    plotCustomPreference: '',
    plotFocusRegion: '',
    plotTabooContent: '',
    plotOutline: null,
    plotOutlineChapters: [],
    isPlotGenerating: false,
    plotStreamStats: null,
    plotOutlineRevealed: false,
    plotGenerationError: null,
    outlineHistory: [],
    plotSettings: { mode: 'off' },
    generatePlotOutline: vi.fn(),
  });
});

describe('CreateStepPlot', () => {
  it('剧情关闭时不渲染大纲预览与生成/导入入口', () => {
    const wrapper = shallowMount(CreateStepPlot);
    expect(wrapper.find('.outline-section').exists()).toBe(false);
    expect(wrapper.find('.generate-row').exists()).toBe(false);
  });

  it('主线模式渲染大纲区，步进器允许 0 并给出「0 = AI 自行判断」提示', () => {
    mockCreate.plotMode = 'main';
    const wrapper = shallowMount(CreateStepPlot);
    expect(wrapper.find('.outline-section').exists()).toBe(true);
    expect(wrapper.find('.generate-row').exists()).toBe(true);
    const steppers = wrapper.findAllComponents({ name: 'FormStepper' });
    expect(steppers[0].props('max')).toBe(PLOT_DURATION_YEARS_MAX);
    expect(steppers[1].props('min')).toBe(PLOT_COUNT_MIN);
    expect(steppers[2].props('min')).toBe(PLOT_COUNT_MIN);
    expect(wrapper.text()).toContain('0 = AI 自行判断');
  });

  it('难度按钮覆盖设置页的全部层级选项', () => {
    mockCreate.plotMode = 'main';
    const wrapper = shallowMount(CreateStepPlot);
    expect(wrapper.findAll('.difficulty-btn')).toHaveLength(PLOT_DIFFICULTY_OPTIONS.length);
  });
});
