<script setup lang="ts">
/**
 * 行动面板收起视图右下（或头行）的展开提示：收起时「算式」、展开时「收起」，带一个转向的小箭头。
 * 五种样式共用这一处；外层定位（`margin-left: auto` 之类）仍由各样式按自己的布局写 ——
 * 根元素会带上父组件的 scoped 属性，父组件里 `.xx .more` 的规则照样生效。
 * 纯装饰：`aria-hidden`，开合语义在外壳的 `<details>` / `<summary>` 上。
 */
defineProps<{ open: boolean }>();
</script>

<template>
  <span class="more" :class="{ 'is-open': open }" aria-hidden="true"
    >{{ open ? '收起' : '算式' }}<i class="more-caret"
  /></span>
</template>

<style scoped>
.more {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.6875rem;
  letter-spacing: 0.1em;
  color: var(--theme-text-muted);
  white-space: nowrap;
}

.more-caret {
  width: 5px;
  height: 5px;
  border: solid currentColor;
  border-width: 0 1px 1px 0;
  transform: translateY(-2px) rotate(45deg);
  transition: transform var(--motion-duration-fast) var(--motion-ease-standard);
}

.more.is-open .more-caret {
  transform: translateY(1px) rotate(-135deg);
}
</style>
