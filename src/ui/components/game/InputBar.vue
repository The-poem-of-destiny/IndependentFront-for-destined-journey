<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useGameStore } from '../../stores/game-store'

const emit = defineEmits<{
  send: [content: string]
  stop: []
}>()

const props = defineProps<{ disabled?: boolean }>()

const game = useGameStore()
const input = ref('')
const showOptions = ref(false)

/** vars_update 解析出的动态行动选项 */
const dynamicOptions = computed(() => game.pendingOptions)

// 监听 ChatFlow 选项点击 → 填入输入框
watch(() => game.pendingInput, (v) => {
  if (v) {
    input.value = v
    game.clearPendingInput()
  }
})

function selectOption(option: string) {
  input.value = option
  showOptions.value = false
}

function handleSend() {
  const text = input.value.trim()
  if (!text) return
  emit('send', text)
  input.value = ''
}

function handleStop() {
  emit('stop')
}
</script>

<template>
  <div class="input-bar">
    <div class="options-popup" v-if="showOptions" role="listbox">
      <div class="options-title">可选行动</div>
      <button
        v-for="(opt, i) in dynamicOptions"
        :key="i"
        class="option-item"
        role="option"
        @click="selectOption(opt)"
      >
        {{ opt }}
      </button>
      <button class="option-custom" @click="showOptions = false">自定义输入...</button>
    </div>

    <!-- 非生成态：显示选项按钮 -->
    <button v-if="!props.disabled && dynamicOptions.length > 0" class="input-btn" @click="showOptions = !showOptions" title="可选行动" :aria-expanded="showOptions" aria-haspopup="listbox">
      <i class="fa-solid fa-list-ul" />
    </button>

    <input
      v-model="input"
      class="input-field"
      type="text"
      placeholder="输入你的行动..."
      :disabled="props.disabled"
      @keydown.enter="handleSend"
    />

    <!-- 非生成态：发送按钮 -->
    <button v-if="!props.disabled" class="input-btn send-btn" @click="handleSend" title="发送">
      <i class="fa-solid fa-paper-plane" />
    </button>

    <!-- 生成态：停止按钮 -->
    <button v-if="props.disabled" class="input-btn stop-btn" @click="handleStop" title="停止生成">
      <i class="fa-solid fa-stop" />
    </button>
  </div>
</template>

<style scoped>
.input-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--theme-title-bar-bg);
  border-top: 1px solid var(--theme-card-border);
  position: relative;
  flex-shrink: 0;
}
.input-btn {
  flex-shrink: 0;
  width: 2.25rem;
  height: 2.25rem;
  border: none;
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  font-size: 0.875rem;
  border-radius: var(--theme-radius-sm, 6px);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 100ms;
}
.input-btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.send-btn {
  color: var(--theme-primary);
}
.stop-btn {
  color: var(--theme-error);
  background: color-mix(in srgb, var(--theme-error) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, transparent);
}
.stop-btn:hover {
  background: color-mix(in srgb, var(--theme-error) 20%, transparent);
  color: var(--theme-error);
}
.input-field {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 6px);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-size: 0.875rem;
  font-family: inherit;
  outline: none;
  transition: border-color 150ms;
}
.input-field:focus {
  border-color: var(--theme-primary);
}
.input-field::placeholder {
  color: var(--theme-text-muted);
}
.options-popup {
  position: absolute;
  bottom: 100%;
  left: 12px;
  width: 17.5rem;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 8px);
  padding: 8px;
  margin-bottom: 4px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  z-index: var(--z-dropdown, 100);
}
.options-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  padding: 4px 8px;
  margin-bottom: 4px;
}
.option-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border: none;
  background: none;
  color: var(--theme-text-primary);
  font-size: 0.8125rem;
  cursor: pointer;
  border-radius: var(--theme-radius-sm, 4px);
  font-family: inherit;
  transition: background 100ms;
}
.option-item:hover {
  background: var(--theme-surface-muted);
}
.option-custom {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border: none;
  border-top: 1px solid var(--theme-card-border);
  background: none;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  cursor: pointer;
  font-family: inherit;
  margin-top: 4px;
}
.option-custom:hover {
  color: var(--theme-text-secondary);
}
</style>
