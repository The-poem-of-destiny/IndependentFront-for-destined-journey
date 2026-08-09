<script setup lang="ts">
/**
 * 第一张卡：**提示词生成** —— `image_prompt` 这个 LLM Agent 的配置面（D51/D52/D54）
 * 加上**按方言分档的那段 systemPrompt**（图像 v2 / C3·C6）。
 *
 * 🔴 **模型/温度/世界书那半仍是个薄壳**：交给 `AgentConfigPanel`，它由 `AgentSection`
 *    与本卡各渲染一次，只是 `agentId` 不同。抽壳的理由（草稿载入的
 *    `watch(..., { immediate: true })` 必须留在那一层）见 `AgentConfigPanel.vue` 文件头。
 *
 * 🔴 **提示词那半不能再交给它**（C3/C6）：`image_prompt` 的 systemPrompt 自图像 v2 起是
 *    **方言属性** —— 真源是方言 JSON（内容包可整份替换的第 7 面），用户改动按方言 id
 *    键控存进 `imageDialectOverrides[dialectId].systemPrompt`。所以本卡给
 *    `AgentConfigPanel` 传 `hide-prompt`，自己画一个**按方言**的编辑器。
 *    留着那个旧框的下场是 C6 点名的静默漂移：两个长得一样的框，一个跟方言走、
 *    一个不跟，用户改完看着生效了，换条方言又变回去。
 *
 * 🔴 **渲染位置 ≠ 存储位置**（D52）：模型/温度/世界书渲染的是 `agents` 袋子里的
 *    **同一份存储**，不复制。而 systemPrompt 现在压根不在那个袋子里（见上一条）。
 *
 * 🔴 **它不进 Agent 子导航**（D53）：同一份配置开两个入口，用户就要猜哪个是权威的。
 *    所以 `agent-list.ts` 一个字都不用动。
 *
 * 🔴 下面那句「作用范围」不是装饰：本分区里有**两处**都叫「提示词」的东西 ——
 *    这里的 systemPrompt 教模型**怎么把中文场景转成 danbooru 标签**，
 *    「出图」卡里的画质后缀/全局负向则**直接拼进每一张图**。写错框两边都不报错，
 *    只是画出来不对（§11.3，与 D27 同一类的静默失败）。
 */
import { computed, onMounted, ref } from 'vue';
import AgentConfigPanel from '../agent/AgentConfigPanel.vue';
import AppCard from '../../shared/AppCard.vue';
import AppButton from '../../shared/AppButton.vue';
import { useSettingsStore } from '../../../stores/settings-store';
import { ensureContentRegistryLoaded, getContentRegistry } from '../../../stores/content-store';
import {
  FALLBACK_IMAGE_DIALECT,
  parseImageDialects,
  resolveImageDialect,
} from '@engine/image-dialect';

/** 唯一常量：这张卡服务的 agent。写死是刻意的 —— 它不是一个可选项 */
const AGENT_ID = 'image_prompt';

const cfg = useSettingsStore();
const s = cfg.settings;

/**
 * 🔴 注册表**不是响应式的**（content-store 的模块级 `let`）：computed 里直接读
 *    `getContentRegistry()` 会把首次求值时那份**还没灌进来的空目录**永久缓存下来，
 *    而且不报任何错。所以先同步读一次，挂载后再由加载门重取。
 *
 * （「出图」卡里有同形状的六行 —— 那是**读注册表的固定姿势**，不是可抽的逻辑：
 *   真正的判定全在引擎的 `parseImageDialects` / `resolveImageDialect` 里，只有这一份。）
 */
const dialectFace = ref<unknown>(getContentRegistry().imageDialects);

onMounted(() => {
  void ensureContentRegistryLoaded().then(() => {
    dialectFace.value = getContentRegistry().imageDialects;
  });
});

const dialects = computed(() => {
  const parsed = parseImageDialects(dialectFace.value);
  return parsed.length > 0 ? parsed : [FALLBACK_IMAGE_DIALECT];
});

/**
 * 当前方言的**默认形态**（不叠加用户覆盖）——占位符要显示的正是它。
 * 显示叠加后的值，用户就再也看不出「我到底改没改过这条方言」。
 */
const activeDialect = computed(() => resolveImageDialect(dialects.value, s.imageDialectId));

/**
 * 当前方言的 systemPrompt 覆盖（C6）。
 *
 * 🔴 **清空 = 删键**，不是写一个空串：`resolveImageDialect` 把空串当「没覆盖」，
 *    留着一个空串键只会在设置里攒下永远不生效的脏数据（与 AgentConfigPanel 的
 *    diff-write「相等就删键」同一条纪律）。
 *
 * 🔴 **只剩空白也算清空**：判空前先 `trim()`。`resolveImageDialect` 只看 `length > 0`、
 *    装配层只看真假 —— 于是框里剩下的一个空格会成为一份**完全合法的覆盖**，
 *    `image_prompt` 那条侧链就顶着一个内容为 `' '` 的 systemPrompt 去跑，产出一串垃圾
 *    而**没有任何一处报错**。存进去的仍是原样文本（不是 trim 后的）：回写 trim 后的值
 *    会在用户敲下换行/空格的当口把它抹掉，光标跟着跳。
 */
const dialectPrompt = computed<string>({
  get: () => s.imageDialectOverrides?.[s.imageDialectId]?.systemPrompt ?? '',
  set: (value: string) => {
    if (value.trim() === '') {
      delete s.imageDialectOverrides?.[s.imageDialectId]?.systemPrompt;
      return;
    }
    if (!s.imageDialectOverrides) s.imageDialectOverrides = {};
    const entry = (s.imageDialectOverrides[s.imageDialectId] ??= {});
    entry.systemPrompt = value;
  },
});

/** 改过没有 —— 「恢复本方言默认」只在真有覆盖时才有意义 */
const hasOverride = computed(() => dialectPrompt.value.length > 0);

function restoreDialectDefault() {
  dialectPrompt.value = '';
}
</script>

<template>
  <div class="image-card-head">
    <h4>提示词生成</h4>
    <p class="image-card-scope">
      这里配的是<strong>把中文场景转成出图提示词</strong>的那个 LLM
      Agent：模型、温度、世界书，以及<strong>按方言分档</strong>的那段系统提示词。
      <br />
      想改「每张图都带上的画质词与负向词」请去下面那张「出图」卡 ——
      那是<strong>图</strong>的提示词，不是 Agent 的提示词。
    </p>
  </div>

  <!-- 模型 / 温度 / 世界书走通用配置面；提示词卡藏掉（真源是方言，见文件头 C6） -->
  <AgentConfigPanel :agent-id="AGENT_ID" hide-prompt />

  <AppCard padding="md">
    <div class="dialect-prompt-head">
      <h4>系统提示词 · 当前方言（{{ activeDialect.label }}）</h4>
      <p class="form-hint">
        提示词<strong>按方言分档存储</strong>，切方言自动跟着换 —— 教模型产 danbooru
        标签的那段话，对散文吃法的模型是有害的。留空 =
        用这条方言自带的默认（占位符里就是那份）。真正的方言内容可以由内容包提供。
      </p>
    </div>

    <textarea
      v-model="dialectPrompt"
      class="form-input form-textarea dialect-prompt-input"
      rows="12"
      spellcheck="false"
      :placeholder="
        activeDialect.systemPrompt || '（这条方言没自带提示词，装配层会回落到内置模板）'
      "
    ></textarea>

    <div class="dialect-prompt-actions">
      <span class="dialect-prompt-state">{{
        hasOverride ? `已覆盖「${activeDialect.label}」的默认提示词` : '正在用方言自带的默认提示词'
      }}</span>
      <AppButton variant="ghost" size="sm" :disabled="!hasOverride" @click="restoreDialectDefault">
        恢复本方言默认
      </AppButton>
    </div>
  </AppCard>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
.image-card-head {
  margin-bottom: var(--theme-spacing-lg);
}
.image-card-head h4 {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 1.05rem;
  color: var(--theme-text-primary);
  margin: 0 0 var(--theme-spacing-xs);
}
/* Section 标题装饰线（design.md §5.1） */
.image-card-head h4::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.image-card-scope {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--theme-text-muted);
}

.dialect-prompt-head {
  margin-bottom: var(--theme-spacing-sm);
}
.dialect-prompt-head h4 {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 1rem;
  color: var(--theme-text-primary);
  margin: 0 0 var(--theme-spacing-xs);
}
.dialect-prompt-head h4::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.dialect-prompt-input {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.8rem;
  line-height: 1.6;
  min-height: 200px;
}
.dialect-prompt-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  margin-top: var(--theme-spacing-sm);
}
.dialect-prompt-state {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
</style>
