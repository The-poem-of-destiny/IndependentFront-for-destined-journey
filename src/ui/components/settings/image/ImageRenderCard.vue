<script setup lang="ts">
/**
 * 第二张卡：**出图** —— 后端选择 + per-provider 参数与限额（D51 / 图像 v2 C8），
 * 全部存 `UiSettings`。
 *
 * 五件在这张卡里必须做对的事：
 *
 * 1. 🔴 **三档开关不是三个光秃秃的单选**（D44）。`auto` 那一项底下带一行后果，
 *    并且**首次**从别的档切到 `auto` 时弹一次确认（`imageAutoConfirmed` 记住）。
 *    自动档是**无人值守花钱**，在决策点讲清楚比事后给一个计数器早一步。
 *    后果行里的两个数字取**当前设置值**而不是文案里写死的数 —— 用户调过限额之后
 *    还照着旧数字吓唬他，就成了一句假话。
 *
 * 2b. 🔴 **免费额度是 Opus 专属的**（D43 补丁，2026-08-04 真机催生）。默认参数满足
 *    Opus 的全部三条，于是这行指示器曾对**每一个**账户都说「在免费额度内」——
 *    对 Tablet / Scroll / 免订阅买点数的账户，那是每张扣约 17 点却被告知不花钱。
 *    档位由 `imageNovelai.tier` 明说，默认 `'unset'`（不猜），四支措辞互斥。
 *
 * 2. 🔴 **免费额度指示只在 `consumes-anlas` 时报数**（D43 / §11.2）。
 *    `estimateAnlasCost` 的 `anlasPerSample` 在免费档内**也是正数** —— 那是这张图
 *    的牌价，不是这次要付多少。在免费分支渲染它会显示「免费，约 17 点」这种自相矛盾。
 *    输入框被清空 → `NaN` → 函数返回 `consumes-anlas` + `invalid-input`，那一支
 *    单独渲染成「算不出来」：把**不知道**显示成**免费**正是这个指示器最不该犯的错。
 *    措辞一律是「按当前订阅规则**估算**」—— NAI 的规则会变，我们给的是提示不是保证。
 *
 * 3. 🔴 画质后缀与全局负向是**图的提示词**，直接拼进每一张图；上面那张卡的
 *    systemPrompt 是**Agent 的提示词**。两者都叫「提示词」却完全不同层，写错框
 *    两边都不报错（§11.3）。所以两处各写明作用范围，别删。
 *
 * 画质后缀与全局负向自图像 v2（C6）起是**方言属性**：这两个文本框写的是**当前方言的
 * 覆盖**，留空即回落方言 JSON 的默认值（`image-defaults` 的两个常量是内置 danbooru
 * 方言的默认）。值仍然**不带前导逗号** —— `composePrompt` 自己用 `', '` 连接各段。
 *
 * 4. 🔴 **后端切换要把 NAI 专属的东西整块藏掉**（图像 v2 / C9·C16）。端点 / 模型 /
 *    采样器 / UC 预设 / 账户档位 / Anlas 估算 / 每消息与每小时上限 —— 这七样在
 *    ComfyUI 下**一个都不成立**（本地渲染不花钱，限额按 C9 只保护 paid 后端）。
 *    留着它们的代价与 D43 那次一模一样：界面上一句**看着权威、其实是假的**话。
 *    宽 / 高 / 步数 / CFG 是两家共享的（comfy 侧作为 `%width%` 这类占位符的替换值），
 *    所以它们**始终**可见。
 *
 * 5. 🔴 **ComfyUI 地址不进 API 池**（C16）：池建模的是带 key 的远端服务，这里是无 key
 *    的本地地址，且填错的败法是诚实的 connection-refused。所以地址与工作流两格住在
 *    这张卡上，`ApiSection` 一个字不用改。
 */
import { computed, onMounted, ref } from 'vue';
import AppCard from '../../shared/AppCard.vue';
import AppButton from '../../shared/AppButton.vue';
import AppModal from '../../shared/AppModal.vue';
import { useSettingsStore, type ApiEntry } from '../../../stores/settings-store';
import { ensureContentRegistryLoaded, getContentRegistry } from '../../../stores/content-store';
import { estimateAnlasCost } from '@engine/image-anlas';
import {
  FALLBACK_IMAGE_DIALECT,
  parseImageDialects,
  resolveImageDialect,
} from '@engine/image-dialect';
import { parseComfyWorkflow } from '@engine/image-providers/comfyui';
import { COMFY_DEFAULT_BASE_URL } from '../../../lib/image-client';
import type {
  ImageGenMode,
  ImageProviderId,
  ImageRating,
  NaiBillingTier,
} from '@engine/types-image';

const cfg = useSettingsStore();
const s = cfg.settings;

// ═══ 后端（C1/C16）═══

const PROVIDERS: { key: ImageProviderId; label: string; hint: string }[] = [
  {
    key: 'novelai',
    label: 'NovelAI',
    hint: '远端付费出图。API Key 在「API 配置」里加一条「图像生成」端点，地址由代码持有。',
  },
  {
    key: 'comfyui',
    label: 'ComfyUI（本地）',
    hint: '连本机跑着的 ComfyUI，出图不花钱。需要填地址，并粘贴一份 API 格式的工作流。',
  },
];

/**
 * 🔴 判据写成「等于 comfyui」而不是「不等于 novelai」，NAI 侧一律用 `!isComfy`：
 *    老档里这个键可能压根不存在（迁移之前的设置），那时候该走的是 v1 那条路。
 */
const isComfy = computed(() => s.imageProvider === 'comfyui');

// ═══ 方言（C2/C4/C6）═══

/**
 * 🔴 注册表**不是响应式的**（content-store 的模块级 `let`）：computed 里直接读
 *    `getContentRegistry()` 会把首次求值时那份**还没灌进来的空目录**永久缓存下来，
 *    症状是「内容加载完了，下拉里还是只有内置那一条」，且不报任何错。
 *    所以先同步读一次（boot 链常态下已灌好，少一帧空列表），挂载后再由加载门重取。
 */
const dialectFace = ref<unknown>(getContentRegistry().imageDialects);

onMounted(() => {
  void ensureContentRegistryLoaded().then(() => {
    dialectFace.value = getContentRegistry().imageDialects;
  });
});

/** 这一面缺席（404 / pack 清空）时退化成内置兜底方言 —— 下拉永远不是空的 */
const dialects = computed(() => {
  const parsed = parseImageDialects(dialectFace.value);
  return parsed.length > 0 ? parsed : [FALLBACK_IMAGE_DIALECT];
});

/**
 * 当前方言的**默认形态**：`resolveImageDialect` 不传 overrides，拿到的是方言 JSON 自己
 * 写的值。占位符要显示的正是它 —— 显示叠加后的值会让「我到底改没改过」看不出来。
 */
const activeDialect = computed(() => resolveImageDialect(dialects.value, s.imageDialectId));

/**
 * 画质后缀 / 全局负向（基础）的读写口 —— **过渡形态**（图像 v2 / T5）。
 *
 * C6 把这两个字符串从平铺设置搬进了「按方言 id 键控的覆盖」，于是这张卡上的两个
 * 文本框绑的不再是一个字段，而是**当前方言的覆盖项**：
 *   · 空 = 回落方言 JSON 的默认值（不是「一个空的画质后缀」）
 *   · 写了东西 = 只对当前这条方言生效
 * 方言选择器与「这一格的默认值长什么样」的占位提示是 T7a 的事，本次只改址不改样。
 *
 * 🔴 **清空 = 删键**，与 `ImagePromptCard` 的 `dialectPrompt` 同一条纪律：
 *    `resolveImageDialect` 把空串当「没覆盖」，写一个空串键只是在设置里攒下永远不生效的
 *    脏数据（行为无害，但下次读这袋子的人得先分辨「这条是不是覆盖」）。
 * 🔴 **判空前先 `trim()`**：留在框里的一个空格既不是覆盖也不是清空，两边都说不通 ——
 *    而它会一路走到装配层被当成一份真覆盖。存进去的仍是**原样文本**（不是 trim 后的）:
 *    回写 trim 后的值会在用户敲下一个空格的当口把它抹掉，光标跟着跳。
 */
function dialectOverride(field: 'qualitySuffix' | 'baseNegative') {
  return computed<string>({
    get: () => s.imageDialectOverrides?.[s.imageDialectId]?.[field] ?? '',
    set: (value: string) => {
      if (value.trim() === '') {
        // 整袋子/这一格本来就不在时，什么都不必建 —— 清空不该凭空造出一个空覆盖
        delete s.imageDialectOverrides?.[s.imageDialectId]?.[field];
        return;
      }
      if (!s.imageDialectOverrides) s.imageDialectOverrides = {};
      const entry = (s.imageDialectOverrides[s.imageDialectId] ??= {});
      entry[field] = value;
    },
  });
}

const qualitySuffix = dialectOverride('qualitySuffix');
const baseNegative = dialectOverride('baseNegative');

// ═══ 三档开关（D14 / D44）═══

const MODES: { key: ImageGenMode; label: string; hint: string }[] = [
  { key: 'off', label: '关闭', hint: '完全不出图，正文里的插画标记直接忽略。' },
  {
    key: 'manual',
    label: '手动（推荐）',
    hint: '标记只变成一个按钮，点了才生成。多几个标记不花钱。',
  },
  // auto 的后果行由 autoConsequence 拼（要带上当前限额），这里留空
  { key: 'auto', label: '自动', hint: '' },
];

/**
 * auto 那一行的后果说明 —— 数字取当前设置，不写死。
 *
 * 🔴 ComfyUI 下**换一套说法**：L1/L2 按 C9 只保护付费后端，本地档根本没有那两个上限。
 *    照搬 NAI 那句话会说出「每条消息最多 2 张」这种**当场就不成立**的承诺 ——
 *    与 D43 那行「免费额度」谎报是同一类错误：一句看着权威、实际不生效的话。
 */
const autoConsequence = computed(() =>
  isComfy.value
    ? '剧情里出现值得配图的时刻就自动生成。本地后端不设每消息 / 每小时上限，' +
      '只保留「同一回合不重复出图」这条去重规则 —— 不花钱，但会一直占着你的显卡。'
    : `剧情里出现值得配图的时刻就自动生成。每条消息最多 ${s.imageNovelai.maxPerMessage} 张、` +
      `每小时最多 ${s.imageNovelai.maxPerHour} 张，超出的会降级成按钮等你点。`,
);

/** 首次切到 auto 的一次性确认（D44）。已确认过的档位切换不再打断 */
const confirmAutoOpen = ref(false);

function selectMode(mode: ImageGenMode) {
  if (mode === 'auto' && !s.imageAutoConfirmed) {
    confirmAutoOpen.value = true;
    return;
  }
  s.imageGenMode = mode;
}

function confirmAuto() {
  s.imageAutoConfirmed = true;
  s.imageGenMode = 'auto';
  confirmAutoOpen.value = false;
}

// ═══ 端点（apiType: 'image'）═══

const imageEndpoints = computed<ApiEntry[]>(() =>
  s.apiPool.filter((entry) => entry.apiType === 'image'),
);

// ═══ 免费额度指示（D43 / §11.2）═══

/** v1 的 `n_samples` 恒为 1（D9）；写成常量而不是字面量，是为了让这条依赖看得见 */
const N_SAMPLES = 1;

const anlas = computed(() =>
  estimateAnlasCost(s.imageWidth, s.imageHeight, s.imageSteps, {
    samples: N_SAMPLES,
    // 🔴 必须传。不传 = 引擎按 'unset' 处理（那是刻意的兜底），但真源在这个设置里
    tier: s.imageNovelai.tier,
  }),
);

/**
 * 四支互斥，优先级从上到下：
 *   unknown   参数读不懂（NaN）—— 连牌价都算不出，先说这个
 *   depends   档位没设 —— 算得出牌价，但不知道要不要付
 *   free      Opus 且参数在额度内
 *   billed    确定要花钱
 *
 * 🔴 `unknown` 与 `depends` 都**不许**渲染成 `free`。两者的区别只在措辞：
 *    前者是「你把输入框清空了」，后者是「我不知道你买的是哪一档」。
 */
const anlasState = computed<'unknown' | 'depends' | 'free' | 'billed'>(() => {
  if (anlas.value.breaches.includes('invalid-input')) return 'unknown';
  if (anlas.value.breaches.includes('tier-unknown')) return 'depends';
  return anlas.value.verdict === 'within-free-allowance' ? 'free' : 'billed';
});

/**
 * 收费那一支的原因：是参数越界，还是这一档本来就没有免费额度。
 *
 * 分开说是有用的 —— 「调小尺寸就能免费」与「你这一档调什么都要钱」是两种完全不同的
 * 行动建议，混成一句话会让 Tablet 用户徒劳地去调步数。
 */
const billedBecauseTier = computed(() => anlas.value.breaches.includes('no-free-allowance'));

// ═══ 账户档位（D43 补丁）═══

const TIERS: { key: NaiBillingTier; label: string; hint: string }[] = [
  { key: 'unset', label: '没设置', hint: '不猜，一律按可能要花钱提示。' },
  {
    key: 'opus',
    label: 'Opus 订阅',
    hint: '单张、面积 ≤ 1024×1024、步数 ≤ 28 时不扣 Anlas。',
  },
  {
    key: 'metered',
    label: '按点数付费',
    hint: 'Tablet / Scroll / 免订阅买点数 —— 没有免费额度，每张都扣。',
  },
];

// ═══ ComfyUI（C11/C13/C16）═══

/**
 * 工作流的即时校验（失焦时跑一次）。
 *
 * 🔴 **空 = 合法**（用内置最小 SDXL 图，C11），所以空串先短路 ——
 *    `parseComfyWorkflow('')` 自己会返回一条「还没有粘贴」的失败，把它当错误画出来，
 *    等于对着一个**完全正常的默认状态**报红。
 * 🔴 校验只是**提前告知**，不拦保存：这一格里躺着的是用户从 ComfyUI 导出的整张图，
 *    我们没资格因为解析不过就把它丢掉。
 */
const workflowError = ref('');

function validateWorkflow() {
  const text = s.imageComfy?.workflowJson ?? '';
  if (!text.trim()) {
    workflowError.value = '';
    return;
  }
  const parsed = parseComfyWorkflow(text);
  workflowError.value = parsed.ok ? '' : parsed.message;
}

/**
 * 超时按**秒**显示、按**毫秒**存 —— 600000 那串零谁也数不清。
 *
 * 🔴 读不懂的输入（清空 / 负数）**不写**：把它当 0 存进去等于每张图一发出去就超时，
 *    而症状（「刚点就失败」）看起来完全不像是这一格干的。
 */
const comfyTimeoutSec = computed<number>({
  get: () => Math.round((s.imageComfy?.timeoutMs ?? 0) / 1000),
  set: (value: number) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    s.imageComfy.timeoutMs = Math.round(seconds) * 1000;
  },
});

// ═══ rating 上限（D38：**上限**而非默认）═══

const RATINGS: { key: ImageRating; label: string }[] = [
  { key: 'general', label: 'general — 全年龄' },
  { key: 'sensitive', label: 'sensitive — 轻度暴露' },
  { key: 'questionable', label: 'questionable — 明显性暗示' },
  { key: 'explicit', label: 'explicit — 露骨' },
];
</script>

<template>
  <AppCard padding="md">
    <div class="image-card-head">
      <h4>出图</h4>
      <p class="image-card-scope">
        这里配的是<strong>真正去画那一张图的那次请求</strong>：什么时候出图、交给哪个后端 （NovelAI
        或本地 ComfyUI）、画多大、以及每张图都带上的画质词与负向词。
      </p>
    </div>

    <!-- ════ 三档开关 ════ -->
    <div class="mode-list" role="radiogroup" aria-label="出图档位">
      <button
        v-for="m in MODES"
        :key="m.key"
        class="mode-item"
        :class="{ 'mode-active': s.imageGenMode === m.key }"
        role="radio"
        :aria-checked="s.imageGenMode === m.key"
        @click="selectMode(m.key)"
      >
        <span class="mode-label">{{ m.label }}</span>
        <span class="mode-hint">{{ m.key === 'auto' ? autoConsequence : m.hint }}</span>
      </button>
    </div>

    <!-- ════ 后端（C1/C16）════ -->
    <p class="block-title">出图后端</p>
    <!-- 沿用三档开关那套外壳类（mode-*）：同一张卡里几组单选长得不一样才是怪事 -->
    <div class="mode-list" role="radiogroup" aria-label="出图后端">
      <button
        v-for="p in PROVIDERS"
        :key="p.key"
        class="mode-item"
        :class="{ 'mode-active': (p.key === 'comfyui') === isComfy }"
        role="radio"
        :aria-checked="(p.key === 'comfyui') === isComfy"
        @click="s.imageProvider = p.key"
      >
        <span class="mode-label">{{ p.label }}</span>
        <span class="mode-hint">{{ p.hint }}</span>
      </button>
    </div>

    <!-- ════ ComfyUI 专属（C11/C13/C16）════ -->
    <div v-if="isComfy" class="provider-block">
      <div class="form-grid image-grid">
        <label class="form-label"
          >ComfyUI 地址
          <p class="form-hint">默认假定与本应用同机；不进「API 配置」的端点池（本地地址无 key）</p>
          <input
            v-model="s.imageComfy.baseUrl"
            class="form-input comfy-base-url"
            spellcheck="false"
            :placeholder="COMFY_DEFAULT_BASE_URL"
        /></label>
        <label class="form-label"
          >整体超时（秒）
          <p class="form-hint">本地渲染慢：闸太紧会把还在跑的图记成失败</p>
          <input
            v-model.number="comfyTimeoutSec"
            type="number"
            min="10"
            step="10"
            class="form-input comfy-timeout"
        /></label>
        <label class="form-label"
          >轮询间隔（毫秒）
          <p class="form-hint">每隔这么久问一次 /history 有没有出图</p>
          <input
            v-model.number="s.imageComfy.pollIntervalMs"
            type="number"
            min="250"
            step="250"
            class="form-input comfy-poll"
        /></label>
      </div>

      <label class="form-label workflow-field"
        >工作流（API 格式）
        <p class="form-hint">
          在 ComfyUI 里用「Save (API Format)」导出，把 JSON 整份粘进来。值位写
          <code>%positive%</code> <code>%negative%</code> <code>%seed%</code> <code>%width%</code>
          <code>%height%</code> <code>%steps%</code> <code>%scale%</code>（兼容
          <code>%prompt%</code> / <code>%negative_prompt%</code>）。留空 = 用内置最小 SDXL 图。
        </p>
        <textarea
          v-model="s.imageComfy.workflowJson"
          class="form-input form-textarea workflow-input"
          rows="6"
          spellcheck="false"
          @blur="validateWorkflow"
        ></textarea>
      </label>
      <p v-if="workflowError" class="workflow-error">{{ workflowError }}</p>
    </div>

    <!-- ════ NovelAI 专属（端点 / 模型 / 档位 / Anlas，C9·C16）════ -->
    <div v-else class="provider-block">
      <div class="form-grid image-grid">
        <label class="form-label"
          >图像端点
          <p class="form-hint">在「API 配置」里把类型设为「图像生成」的那些端点会出现在这里</p>
          <select v-model="s.imageNovelai.endpointId" class="form-input">
            <option :value="null">（未选择）</option>
            <option v-for="ep in imageEndpoints" :key="ep.id" :value="ep.id">{{ ep.name }}</option>
          </select></label
        >
        <label class="form-label"
          >NAI 模型
          <p class="form-hint">出图模型 id，不是 LLM 模型</p>
          <input v-model="s.imageNovelai.model" class="form-input" spellcheck="false"
        /></label>
        <label class="form-label"
          >采样器 <input v-model="s.imageNovelai.sampler" class="form-input" spellcheck="false"
        /></label>
        <label class="form-label"
          >噪声调度
          <input v-model="s.imageNovelai.noiseSchedule" class="form-input" spellcheck="false"
        /></label>
        <label class="form-label"
          >UC 预设编号
          <p class="form-hint">按录制值原样发；负向文本由下面的全局负向拿着</p>
          <input v-model.number="s.imageNovelai.ucPreset" type="number" min="0" class="form-input"
        /></label>
      </div>

      <!-- ════ 账户档位（D43 补丁）════ -->
      <p class="tier-title">NovelAI 账户档位</p>
      <p class="form-hint tier-desc">
        只影响下面那行估算，<strong>不改变任何请求</strong>。免费额度是 Opus 专属的 ——
        不问清楚的话，那行字会对按点数付费的账户谎报「免费」。
      </p>
      <div class="mode-list" role="radiogroup" aria-label="NovelAI 账户档位">
        <button
          v-for="t in TIERS"
          :key="t.key"
          class="mode-item"
          :class="{ 'mode-active': s.imageNovelai.tier === t.key }"
          role="radio"
          :aria-checked="s.imageNovelai.tier === t.key"
          @click="s.imageNovelai.tier = t.key"
        >
          <span class="mode-label">{{ t.label }}</span>
          <span class="mode-hint">{{ t.hint }}</span>
        </button>
      </div>

      <!-- ════ 免费额度指示（§11.2 + D43 补丁）════ -->
      <p
        class="anlas-line"
        :class="{
          'anlas-free': anlasState === 'free',
          'anlas-billed': anlasState === 'billed',
          'anlas-unknown': anlasState === 'unknown' || anlasState === 'depends',
        }"
      >
        <template v-if="anlasState === 'free'">
          按当前订阅规则估算，这组参数在 Opus 免费额度内，不消耗 Anlas。
        </template>
        <template v-else-if="anlasState === 'depends'">
          这组参数约 {{ anlas.anlasPerSample }} 点/张 —— 要不要付取决于你的账户档位，
          上面选一个才能算准。
        </template>
        <template v-else-if="anlasState === 'billed' && billedBecauseTier">
          按当前订阅规则估算，你这一档没有免费额度，每张都会消耗 Anlas（约
          {{ anlas.anlasPerSample }} 点/张）—— 调小尺寸或步数也免不掉。
        </template>
        <template v-else-if="anlasState === 'billed'">
          按当前订阅规则估算，这组参数会消耗 Anlas（约 {{ anlas.anlasPerSample }} 点/张）。
        </template>
        <template v-else>
          宽 / 高 / 步数需要是正整数，现在算不出这组参数会不会消耗 Anlas。
        </template>
      </p>
      <p class="form-hint anlas-ruleset">{{ anlas.rulesetLabel }} · 估算值，不是账单承诺</p>
    </div>

    <!-- ════ 共享出图参数（两家都读；comfy 侧当 %token% 的替换值）════ -->
    <p class="block-title">画多大</p>
    <p class="form-hint block-desc">
      两个后端共用。ComfyUI 侧这四个值填进工作流里的
      <code>%width%</code> <code>%height%</code> <code>%steps%</code> <code>%scale%</code>。
    </p>
    <div class="form-grid image-grid">
      <label class="form-label"
        >宽（px）
        <input v-model.number="s.imageWidth" type="number" min="64" step="64" class="form-input"
      /></label>
      <label class="form-label"
        >高（px）
        <input v-model.number="s.imageHeight" type="number" min="64" step="64" class="form-input"
      /></label>
      <label class="form-label"
        >步数
        <input v-model.number="s.imageSteps" type="number" min="1" max="50" class="form-input"
      /></label>
      <label class="form-label"
        >CFG scale
        <input
          v-model.number="s.imageScale"
          type="number"
          min="1"
          max="10"
          step="0.1"
          class="form-input"
      /></label>
    </div>

    <!-- ════ 方言（C2/C4/C6）════ -->
    <div class="form-grid image-grid">
      <label class="form-label"
        >提示词方言
        <p class="form-hint">
          决定<strong>侧链提示词与装配方式</strong>：画质后缀 / 基础负向 / 构图词随方言整套
          切换，覆盖也按方言分开存。
        </p>
        <select v-model="s.imageDialectId" class="form-input dialect-select">
          <option v-for="d in dialects" :key="d.id" :value="d.id">
            {{ d.label }}（{{ d.id }}）
          </option>
        </select></label
      >
    </div>

    <!-- ════ 图的提示词（≠ Agent 的提示词）════ -->
    <div class="prompt-block">
      <label class="form-label"
        >当前方言（{{ activeDialect.label }}）的画质后缀
        <p class="form-hint">
          追加在每一张图的正向提示词<strong>末尾</strong>（顺序即权重）。不要写前导逗号 ——
          各段由引擎连接。<strong>留空 = 回落方言默认</strong>（占位符里就是那份默认值）。
        </p>
        <textarea
          v-model="qualitySuffix"
          class="form-input form-textarea"
          rows="2"
          :placeholder="activeDialect.qualitySuffix"
        ></textarea>
      </label>
      <label class="form-label"
        >当前方言（{{ activeDialect.label }}）的基础负向
        <p class="form-hint">
          每一张图都带上。只写画质与解剖类缺陷，分级由下面的上限管。留空 = 回落方言默认。
        </p>
        <!--
          🔴 不吃负向的方言下这一格也要**可见地禁用**（C6）。装配层
          （`composePrompt` 的 `supportsNegative` 分支）在这条方言下把基础负向整段丢成
          空串 —— 与旁边那格「我的追加」是同一次丢弃。只停用其中一格、另一格照收，
          就成了「这一格生效那一格不生效」的猜谜，而两格其实都不生效。
        -->
        <textarea
          v-model="baseNegative"
          class="form-input form-textarea base-negative"
          rows="3"
          :placeholder="activeDialect.baseNegative"
          :disabled="!activeDialect.supportsNegative"
        ></textarea>
        <span v-if="!activeDialect.supportsNegative" class="negative-off">
          当前方言不支持负向提示词，这一格已停用 —— 这条方言下的基础负向会被整段丢掉，
          收下再悄悄丢掉只会让人以为它生效了。
        </span>
      </label>
      <label class="form-label"
        >全局负向（我的追加）
        <p class="form-hint">
          拼在基础负向之后，留空即不追加。<strong>这一格是全局的</strong> ——
          它是你的口味，不随方言切换。
        </p>
        <textarea
          v-model="s.imageExtraNegative"
          class="form-input form-textarea extra-negative"
          rows="2"
          :disabled="!activeDialect.supportsNegative"
        ></textarea>
        <span v-if="!activeDialect.supportsNegative" class="negative-off">
          当前方言不支持负向提示词，这一格已停用 —— 这类模型（CFG 1.0）根本不读负向，
          收下再悄悄丢掉只会让人以为它生效了。
        </span>
      </label>
    </div>

    <!-- ════ 分级上限与限额 ════ -->
    <div class="form-grid image-grid">
      <label class="form-label"
        >内容分级上限
        <p class="form-hint">这是<strong>上限</strong>：正文标记里写得更高会被钳到这里</p>
        <select v-model="s.imageMaxRating" class="form-input">
          <option v-for="r in RATINGS" :key="r.key" :value="r.key">{{ r.label }}</option>
        </select></label
      >
      <!-- 🔴 L1/L2 是**花钱防线**（C9），本地后端整块不出现 —— 画一个不生效的上限，
           就是又一句「看着权威、其实是假的」话 -->
      <template v-if="!isComfy">
        <label class="form-label"
          >每条消息最多几张
          <p class="form-hint">自动与手动都计入</p>
          <input
            v-model.number="s.imageNovelai.maxPerMessage"
            type="number"
            min="1"
            max="10"
            class="form-input quota-per-message"
        /></label>
        <label class="form-label"
          >每小时最多几张
          <p class="form-hint">失效保护：挡的是回退重发风暴与意外循环</p>
          <input
            v-model.number="s.imageNovelai.maxPerHour"
            type="number"
            min="1"
            max="200"
            class="form-input quota-per-hour"
        /></label>
      </template>
    </div>
    <p v-if="isComfy" class="form-hint local-quota-note">
      本地后端不设每消息 / 每小时上限（本地免费就该无上限）；「同一回合不重复出图」这条
      去重规则对两个后端恒开。
    </p>

    <label class="toggle-row">
      <span class="toggle-text">
        正文里的插画默认打码
        <span class="form-hint">点一下才揭示；不做硬屏蔽，随时可以自己看</span>
      </span>
      <span class="toggle-label">
        <input v-model="s.imageBlurByDefault" type="checkbox" class="toggle-input" />
        <span class="toggle-slider"></span>
      </span>
    </label>

    <!-- 首次切到自动档的一次性确认（D44）。留在卡内层，AppModal 自己 Teleport -->
    <AppModal
      :open="confirmAutoOpen"
      title="切换到自动出图？"
      size="sm"
      @update:open="confirmAutoOpen = $event"
    >
      <p class="confirm-text">
        自动档会在<strong>无人值守</strong>的情况下花钱：剧情推进时引擎自己决定要不要出图。
      </p>
      <p class="confirm-text">{{ autoConsequence }}</p>
      <p class="confirm-text text-muted">这条提示只出现这一次，之后可以随时切回手动。</p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="confirmAutoOpen = false">再想想</AppButton>
        <AppButton variant="primary" size="sm" @click="confirmAuto">我知道，开自动</AppButton>
      </template>
    </AppModal>
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

/* 三档开关 —— 每一项都带自己的后果行，所以是块级按钮而不是一排 radio */
.mode-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-lg);
}
.mode-item {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  min-height: 36px;
  padding: 10px var(--theme-spacing-md);
  text-align: left;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-secondary);
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.mode-item:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.mode-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-primary);
}
.mode-label {
  font-size: 0.9rem;
  font-weight: 600;
}
.mode-active .mode-label {
  color: var(--theme-primary);
}
.mode-hint {
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--theme-text-muted);
}

.image-grid {
  margin-bottom: var(--theme-spacing-md);
}

/* 块小标题（后端 / 画多大）—— 与档位那条 .tier-title 同一级 */
.block-title {
  margin: var(--theme-spacing-md) 0 var(--theme-spacing-xs);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.block-desc {
  margin-top: 0;
}

/* per-provider 那一整块：切后端时整块换掉，块内不再有第二层缩进 */
.provider-block {
  display: flex;
  flex-direction: column;
}

.workflow-field {
  margin-bottom: var(--theme-spacing-sm);
}
.workflow-input {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.78rem;
  min-height: 120px;
}
/* 校验只是提前告知，不拦保存 —— 语义徽章配方（design.md §1） */
.workflow-error {
  margin: 0 0 var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  font-size: 0.8rem;
  line-height: 1.5;
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
  color: var(--theme-error);
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, transparent);
  border-radius: var(--theme-radius-md);
}

/* 方言不吃负向时那两格的可见说明（C6：可见地禁用，不静默丢弃）——
 * 方言级「基础负向」与全局「我的追加」在这条方言下是同一次丢弃，所以同一副长相 */
.base-negative:disabled,
.extra-negative:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.negative-off {
  margin-top: var(--theme-spacing-xs);
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--theme-warning);
}

.local-quota-note {
  margin-bottom: var(--theme-spacing-lg);
}

.image-card-scope code,
.form-hint code {
  padding: 0 3px;
  font-family: 'Cascadia Code', monospace;
  font-size: 0.95em;
  color: var(--theme-text-secondary);
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm);
}

/* 账户档位（D43 补丁） */
.tier-title {
  margin: var(--theme-spacing-md) 0 var(--theme-spacing-xs);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.tier-desc {
  margin-top: 0;
}

/* 免费额度指示 */
.anlas-line {
  margin: 0 0 var(--theme-spacing-xs);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  font-size: 0.82rem;
  line-height: 1.5;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.anlas-free {
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  color: var(--theme-success);
  border-color: color-mix(in srgb, var(--theme-success) 30%, transparent);
}
.anlas-billed {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  border-color: color-mix(in srgb, var(--theme-warning) 30%, transparent);
}
.anlas-unknown {
  background: color-mix(in srgb, var(--theme-text-muted) 8%, transparent);
  color: var(--theme-text-muted);
}
.anlas-ruleset {
  margin: 0 0 var(--theme-spacing-lg);
}

.prompt-block {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  margin-bottom: var(--theme-spacing-lg);
}
.toggle-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.85rem;
  color: var(--theme-text-secondary);
}
.confirm-text {
  margin: 0 0 var(--theme-spacing-md);
  font-size: 0.85rem;
  line-height: 1.7;
  color: var(--theme-text-secondary);
}
</style>
