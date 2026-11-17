<script setup lang="ts">
/**
 * FxItemFlight — 物品飞入层。挂在 FxLayer，应用级覆盖层
 *
 * 特效层约定：叶子节点、`aria-hidden="true"`、`pointer-events: none`（见 styles/fx-core.css）。
 * 只在特效闸门打开时被挂载（父层 v-if）；执行器每次起飞前仍会再判一次闸门。
 *
 * 只对**挂载之后新推入**的「获得物品」系统消息起飞（判定见 lib/fx-item-flight.ts）：
 * - 载入存档 / 回退 / 恢复快照都是**整份换掉** `game.messages` 数组 —— 数组身份一变就只
 *   重新记账、不起飞，历史消息永远不会触发飞行；
 * - 同一数组上长出来的新消息才算「新推入」，一批里有几条都只飞一次。
 */
import { onBeforeUnmount, ref, watch } from 'vue';
import type { ChatMessage } from '@engine/types/types';
import { useGameStore } from '../../stores/game-store';
import { createItemFlight, isItemGainMessage } from '../../lib/fx-item-flight';

const game = useGameStore();
const overlay = ref<HTMLElement | null>(null);
const flight = createItemFlight({ getOverlay: () => overlay.value });

function idsOf(list: readonly ChatMessage[] | undefined): Set<string> {
  return new Set((list ?? []).map((m) => m.id));
}

let lastList: readonly ChatMessage[] | undefined = game.messages;
let seen = idsOf(lastList);

watch(
  () => [game.messages, game.messages?.length ?? 0] as const,
  ([list]) => {
    if (list !== lastList) {
      lastList = list;
      seen = idsOf(list);
      return;
    }
    let gained = false;
    for (const msg of list ?? []) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      if (isItemGainMessage(msg)) gained = true;
    }
    if (gained) flight.request();
  },
  { flush: 'post' },
);

onBeforeUnmount(() => flight.dispose());
</script>

<template>
  <div ref="overlay" class="fx-overlay fx-overlay--front fx-item-flight" aria-hidden="true" />
</template>

<style>
/* 光条由执行器动态插入（不带 scoped 属性），故规则写在非 scoped 块里，仍挂闸门之下 */
:root[data-fx='on'] .fx-item-flight .fx-flight-streak {
  position: absolute;
  top: -1px;
  left: -16px;
  width: 32px;
  height: 2px;
  border-radius: 999px;
  pointer-events: none;
  opacity: 0;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--theme-primary, #c9a86a) 55%, #fff) 85%,
    #fff
  );
  filter: blur(0.4px);
  will-change: transform, opacity;
}
</style>
