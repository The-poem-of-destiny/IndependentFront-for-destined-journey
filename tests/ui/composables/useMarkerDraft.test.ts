/**
 * useMarkerDraft — 标记编辑草稿只认「当前选中标记」（审计 MAP-01 回归）
 * @vitest-environment jsdom
 *
 * 缺陷原样：地图上点标记 B（或新放一个标记）→ 打开工作台「编辑」改颜色 → B 的名称/分组/描述
 * 被换成上一个从列表编辑过的 A 的内容（或空串），1 秒内落库。根因是表单只在列表点选时填。
 */
import { describe, it, expect } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import type { MapMarker } from '@engine/types/types';
import { useMarkerDraft } from '../../../src/ui/composables/useMarkerDraft';
import {
  DEFAULT_MARKER_COLOR,
  DEFAULT_MARKER_ICON,
} from '../../../src/ui/composables/useMapMarkers';
import mapPanelSource from '../../../src/ui/components/game/MapPanel.vue?raw';

const A: MapMarker = {
  id: 'a',
  name: '营地甲',
  group: '据点',
  description: '甲的描述',
  icon: 'fa-solid fa-flag',
  color: '#112233',
  position: { nx: 0.1, ny: 0.1 },
};
const B: MapMarker = {
  id: 'b',
  name: '港口乙',
  group: '港口',
  description: '乙的描述',
  position: { nx: 0.5, ny: 0.5 },
};

/** 与 useMapMarkers 同形：选中 id + 由它反查的 computed */
function setup(list: MapMarker[], initial: string | null = null) {
  const markers = ref<MapMarker[]>(list.map((m) => ({ ...m })));
  const activeId = ref<string | null>(initial);
  const active = computed(() => markers.value.find((m) => m.id === activeId.value) ?? null);
  return { markers, activeId, draft: useMarkerDraft(active) };
}

describe('useMarkerDraft', () => {
  it('挂载时就按当前选中项填（immediate）', () => {
    const { draft } = setup([A, B], 'a');
    expect(draft.name.value).toBe('营地甲');
    expect(draft.icon.value).toBe('fa-solid fa-flag');
  });

  it('不经过任何「选中处理函数」直接改选中 id（等同地图点 overlay）→ 草稿跟着换', async () => {
    const { activeId, draft } = setup([A, B], 'a');
    activeId.value = 'b';
    await nextTick();
    // 改一个字段后保存：写回的必须是 B 自己的其余字段，不是 A 的
    draft.color.value = '#abcdef';
    expect(draft.toPatch()).toEqual({
      name: '港口乙',
      group: '港口',
      description: '乙的描述',
      icon: DEFAULT_MARKER_ICON,
      color: '#abcdef',
    });
  });

  it('新增标记（push + 直接改选中 id）→ 草稿是新标记的值，不残留上一个', async () => {
    const { markers, activeId, draft } = setup([A], 'a');
    markers.value.push({ id: 'new', name: '新标记', group: '', position: { nx: 0, ny: 0 } });
    activeId.value = 'new';
    await nextTick();
    expect(draft.name.value).toBe('新标记');
    expect(draft.group.value).toBe('');
    expect(draft.description.value).toBe('');
    expect(draft.color.value).toBe(DEFAULT_MARKER_COLOR);
  });

  it('取消选中 → 草稿全部回默认（含图标与颜色）', async () => {
    const { activeId, draft } = setup([A], 'a');
    activeId.value = null;
    await nextTick();
    expect(draft.name.value).toBe('');
    expect(draft.icon.value).toBe(DEFAULT_MARKER_ICON);
    expect(draft.color.value).toBe(DEFAULT_MARKER_COLOR);
  });

  it('同一标记内容被保存改动时不重灌草稿（不冲掉尚未提交的输入）', async () => {
    const { markers, draft } = setup([A], 'a');
    draft.name.value = '正在输入';
    markers.value[0].color = '#000000';
    await nextTick();
    expect(draft.name.value).toBe('正在输入');
  });

  it('MapPanel 的表单来自 useMarkerDraft，选中处理函数里不再手填表单', () => {
    expect(mapPanelSource).toContain('useMarkerDraft(activeMarker)');
    const start = mapPanelSource.indexOf('function handleSelectMarker');
    const body = mapPanelSource.slice(start, mapPanelSource.indexOf('\n}\n', start));
    expect(body).not.toMatch(/editing\w+\.value\s*=/);
  });
});
