<script setup lang="ts">
/**
 * 行动面板收起视图 · 通用（generic）kind 的共用模板：标题行 + 前三个关键格 + 展开提示。
 *
 * 对决条 / 血条残影 / 跳字舞台三种样式的通用视图同构，只是类名与标签 / 值的先后不同，
 * 这里只写一份骨架，类名由 `classes` 传进来（DOM 类名保持各样式原样，样式规则仍写在各样式组件里）。
 * 打出的牌（牌面句子）与战报行（行表）的通用视图写法不同，不走这里。
 *
 * 🔴 本组件渲染出的元素不带父组件的 scoped 属性：父组件给这些类写规则要用 `:deep()`；
 *    共用静态类（`.nm` 之类）由本组件自己引入 action-panel-base.css。
 *    @keyframes 与入场动画仍留在用它的样式组件里（docs/design.md §6.0 第 6 条）。
 */
import type { ActionView } from '../../../lib/action-panel-view';
import { genericFacts } from '../../../lib/action-style-helpers';
import ActionMoreHint from './ActionMoreHint.vue';

defineProps<{
  view: ActionView;
  open: boolean;
  classes: {
    /** 标题行容器 */
    head: string;
    /** 标题文字外包的 span；不给则标题直接写在容器里 */
    title?: string;
    /** 关键格列表容器 */
    list: string;
    /** 每一格 */
    item: string;
    /** 每一格的元素名，缺省 span */
    itemTag?: 'span' | 'div';
    /** 标签外包的 small；不给则标签是裸文字 */
    label?: string;
    /** 值（b） */
    value: string;
    /** 脚注容器（放展开提示）；不给则展开提示写在标题行末 */
    foot?: string;
  };
  /** 值在上、标签在下 */
  valueFirst?: boolean;
}>();
</script>

<template>
  <div :class="classes.head">
    <span v-if="classes.title" :class="classes.title">{{ view.title || '行动详情' }}</span
    ><template v-else>{{ view.title || '行动详情' }}</template
    ><ActionMoreHint v-if="!classes.foot" :open="open" />
  </div>
  <div v-if="genericFacts(view).length > 0" :class="classes.list">
    <component
      :is="classes.itemTag ?? 'span'"
      v-for="(c, i) in genericFacts(view)"
      :key="`f-${i}`"
      :class="classes.item"
      ><template v-if="valueFirst"
        ><b :class="classes.value">{{ c.value }}</b
        ><small :class="classes.label">{{ c.label }}</small></template
      ><template v-else
        ><small v-if="classes.label" :class="classes.label">{{ c.label }}</small
        ><template v-else>{{ c.label }}</template
        ><b :class="classes.value">{{ c.value }}</b></template
      ></component
    >
  </div>
  <div v-if="classes.foot" :class="classes.foot">
    <ActionMoreHint :open="open" />
  </div>
</template>

<style scoped src="./action-panel-base.css"></style>
