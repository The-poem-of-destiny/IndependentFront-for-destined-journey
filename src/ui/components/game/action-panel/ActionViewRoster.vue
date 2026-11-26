<script setup lang="ts">
/**
 * 行动面板收起视图 · 名册（roster）kind 的共用模板：一排单位格，每格「徽章 + 名字（集群人数）」，
 * 资源读数交给插槽 `#unit="{ unit }"`（各样式画法不同：三条资源条 / HP 条 + 读数 / 小牌读数）。
 *
 * 对决条 / 跳字舞台 / 打出的牌三种样式的单位格同构，这里只写一份；标题行与脚注各样式不同，留在父组件。
 * 血条残影（无单位外框的网格）与战报行（行表）的名册写法不同，不走这里。
 * 单位格按下标交错入场，`--i` 出自 entrance-timing.ts 的 `staggerStyle`。
 *
 * 🔴 根元素（列表容器）带父组件的 scoped 属性；单位格、名字、集群人数不带 ——
 *    父组件给它们写规则要用 `:deep()`。插槽内容按父组件编译，父组件的 scoped 规则照常生效。
 *    @keyframes 与入场动画仍留在用它的样式组件里（docs/design.md §6.0 第 6 条）。
 */
import type { RosterUnit } from '../../../lib/action-digest';
import type { ActionView } from '../../../lib/action-panel-view';
import ActionBadge from './ActionBadge.vue';
import { staggerStyle } from './entrance-timing';

defineProps<{
  view: ActionView;
  classes: {
    /** 单位格列表容器 */
    list: string;
    /** 每个单位格 */
    unit: string;
    /** 集群人数小字（另带共用的 `rng`） */
    cluster: string;
  };
  badgeSize: 'sm' | 'md' | 'lg';
}>();

defineSlots<{ unit(props: { unit: RosterUnit }): unknown }>();
</script>

<template>
  <div :class="classes.list">
    <div
      v-for="(u, i) in view.roster"
      :key="`u-${i}`"
      :class="classes.unit"
      :style="staggerStyle(i)"
    >
      <ActionBadge :name="u.name" target :size="badgeSize" />
      <span class="nm"
        >{{ u.name
        }}<small v-if="u.cluster" class="rng" :class="classes.cluster"
          >{{ u.cluster.alive }}/{{ u.cluster.total }}</small
        ></span
      >
      <slot name="unit" :unit="u" />
    </div>
  </div>
</template>

<style scoped src="./action-panel-base.css"></style>
