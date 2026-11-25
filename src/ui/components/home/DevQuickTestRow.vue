<script setup lang="ts">
// 🧪 开发用快速测试入口（只在 DEV 构建存在）。
// HomePage 以字面量 `import.meta.env.DEV` 门控异步引入本组件 —— 生产构建里
// 本组件、test-save chunk 与按钮文案一并被摇掉，别在别处静态 import 它。
import { useUIStore } from '../../stores/ui-store';
import AppButton from '../shared/AppButton.vue';
import { confirmDialog } from '../../lib/confirm-dialog';

const ui = useUIStore();

// ⚠️ 会先清空**整个数据库** —— 素材库与音频库不随存档隔离，会一并没
async function quickTest() {
  // 2026-11-20：clone 后跑 dev 的测试者也看得到这个按钮，误点就是整库清空 —— 必须二次确认。
  const ok = await confirmDialog({
    title: '清空数据库并创建测试存档？',
    message: '这会删除本机全部存档、素材库与音频库，且无法撤销。',
    confirmLabel: '清空并创建',
    danger: true,
  });
  if (!ok) return;
  const { createTestSave } = await import('../../utils/test-save');
  const saveId = await createTestSave();
  ui.navigate('game', saveId);
}

// 🧪 同一个测试存档，但一个字节都不清 —— 手动导入的素材/音乐留着
// (调渲染面时要的是"能进去的存档"，不是"把刚导入的图全删了")
async function quickTestKeep() {
  const { createTestSavePreservingData } = await import('../../utils/test-save');
  const saveId = await createTestSavePreservingData();
  ui.navigate('game', saveId);
}
</script>

<template>
  <div class="dev-test-row">
    <AppButton
      variant="ghost"
      size="sm"
      class="dev-test-btn"
      title="清空整个数据库后重建测试存档 —— 素材库与音频库会一并清掉"
      @click="quickTest"
    >
      🧪 快速测试
    </AppButton>
    <AppButton
      variant="ghost"
      size="sm"
      class="dev-test-btn"
      title="创建测试存档，但不清任何数据 —— 已导入的素材与音乐保留"
      @click="quickTestKeep"
    >
      🧪 快速测试（保留数据）
    </AppButton>
  </div>
</template>

<style scoped>
/* 两个开发按钮并排；窄屏换行，不挤出容器 */
.dev-test-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--theme-spacing-xs, 4px);
}
.dev-test-btn {
  opacity: 0.5;
  font-size: 0.75rem;
  transition: opacity 0.2s;
  margin-top: 4px;
}
@media (prefers-reduced-motion: reduce) {
  .dev-test-btn {
    transition: none;
  }
}
.dev-test-btn:hover {
  opacity: 1;
}
</style>
