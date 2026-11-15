/**
 * useMarkerDraft — 标记工作台「编辑」页的表单草稿
 *
 * 🔴 草稿**只从「当前选中标记」这一个源头**填（审计 MAP-01，2026-11-14）：
 *    选中项有三条改法 —— 工作台列表、地图上点 overlay（`useMapMarkers` 直接改
 *    `activeMarkerId`）、新增标记（`addMarkerAt` 同样直接改）。此前只有列表那一条会填表单，
 *    于是从另两条路选中后打开编辑页改任意一个字段，保存会把**上一个标记的**名称/分组/描述
 *    （或空串）连同改动一起写进当前标记，1 秒内落库。监听选中 id 才能让三条路一视同仁。
 *
 * 只按 **id** 监听、不深监听标记本身：编辑页自己保存时标记内容会变，若跟着重灌草稿，
 * 输入框里尚未失焦提交的那几个字会被冲掉。
 */
import { ref, watch, type Ref } from 'vue';
import type { MapMarker } from '@engine/types/types';
import { DEFAULT_MARKER_COLOR, DEFAULT_MARKER_ICON } from './useMapMarkers';

export function useMarkerDraft(activeMarker: Readonly<Ref<MapMarker | null>>) {
  const name = ref('');
  const group = ref('');
  const description = ref('');
  const imageUrls = ref<string[]>([]);
  const icon = ref<string>(DEFAULT_MARKER_ICON);
  const color = ref(DEFAULT_MARKER_COLOR);

  /** 把草稿重置为某个标记的当前值；`null` = 没有选中项，草稿清空回默认 */
  function load(marker: MapMarker | null): void {
    name.value = marker?.name ?? '';
    group.value = marker?.group ?? '';
    description.value = marker?.description ?? '';
    imageUrls.value = [...(marker?.imageUrls ?? [])];
    icon.value = marker?.icon ?? DEFAULT_MARKER_ICON;
    color.value = marker?.color ?? DEFAULT_MARKER_COLOR;
  }

  watch(
    () => activeMarker.value?.id ?? null,
    () => load(activeMarker.value),
    { immediate: true },
  );

  /** 编辑页保存时写回标记的那几个字段 */
  function toPatch(): Partial<MapMarker> {
    return {
      name: name.value,
      group: group.value,
      description: description.value,
      icon: icon.value as MapMarker['icon'],
      color: color.value,
    };
  }

  return { name, group, description, imageUrls, icon, color, toPatch };
}
