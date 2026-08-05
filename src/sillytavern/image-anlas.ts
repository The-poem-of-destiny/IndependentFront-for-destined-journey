/**
 * image-anlas.ts — D43：按当前参数**估算**这一张图会不会消耗 Anlas
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md` D43 / §11.2 / §6。
 *
 * 为什么要有这个文件（D43）:
 * 宽高与步数在设置里**是可调的**，调大了会**静默**开始烧点数 —— 用户改完只会看到
 * 图变清楚了，账单要过一阵才发现。参数卡底部那一行指示器就是拿本函数实时算的。
 *
 * 🔴 **本文件给的是提示，不是保证。** NAI 的免费档规则会变，我们手里只有下面
 *    `NAI_ANLAS_RULES` 这一份快照。所以：
 *    - 判定值叫 `within-free-allowance` 而不是 `isFree`（承诺 vs 提示，见 `AnlasVerdict`）
 *    - UI 的措辞必须是「按当前订阅规则估算」（§11.2 明令）
 *    - **规则一变只改 `NAI_ANLAS_RULES` 一处**，别把数字散进函数体
 *
 * 🔴 **这条规则会变，所以 `image-anlas.test.ts` 就是它的文档。** 那里的每条断言都写明
 *    了依据出自设计文档哪一段；改规则时先去看测试红在哪，那些红点就是这次改动的影响面。
 *
 * 纯函数、零依赖、无 I/O。
 */

import type { AnlasEstimate, AnlasFreeAllowanceBreach, NaiBillingTier } from './types-image';

/**
 * 估算所依据的**全部**规则与系数 —— 这是本模块唯一允许出现数字的地方。
 *
 * 来源:
 * - 免费额度: 设计 §6 尾注「Opus 订阅在『常规尺寸 + 单张』内不消耗点数。模板的
 *   `1216×832 / 23 步 / n_samples:1` 在免费档内」+ §6 参数表「1216 × 832 …… 卡在
 *   Opus 免费档内」。数值取 NAI 公布的「1 百万像素以内 / 28 步以内 / 单张」。
 * - 定价系数: NAI 前端定价函数的 SDXL(V3/V4) 分支。锚点：`1024×1024 / 28 步`
 *   算出 20 点，与官方公布的牌价一致（`image-anlas.test.ts` 把这个锚点钉死了）。
 *
 * 🔴 **v1 只覆盖 `action: 'generate'` 的文生图**（§6.1）。img2img / 局部重绘 / 放大
 *    另有系数，v1 不发那些请求，所以这里刻意不写 —— 别照着猜一个填进来。
 */
export const NAI_ANLAS_RULES = {
  /**
   * 进 `AnlasEstimate.rulesetLabel`，让「这是哪一版规则」在界面上看得见。
   *
   * 🔴 **免费额度那几条是 Opus 专属的**，标签里那三个字不是装饰。非 Opus 档位
   *    走 {@link TIER_RULESET_LABELS} 的另一句 —— 拿这句去描述一个按点数付费的
   *    账户，就是 2026-08-04 真机那天暴露的那个 bug 本身。
   */
  rulesetLabel: 'NovelAI Opus 订阅 · V4 系列文生图（规则快照 2026-08-04）',

  /**
   * 免费额度的尺寸上限，单位是**像素总数**（宽 × 高），不是各边分别限制。
   *
   * 🔴 这一条最反直觉、也最要紧：默认的 `1216×832` 长边**超过** 1024，但面积
   *    1,011,712 在预算内，所以仍然免费。写成「每边 ≤ 1024」会把默认参数误判成收费。
   */
  freeMaxPixels: 1024 * 1024,

  /** 免费额度的步数上限 */
  freeMaxSteps: 28,

  /**
   * 一次请求里享受免费额度的张数。
   *
   * 设计 D9 把 `n_samples` 恒定为 1，正是因为「常规尺寸 + **单张**」才落在免费档内。
   * 写成一个常量而不是 `samples === 1` 的硬判断，是为了让「免费的是前 N 张」这个
   * 语义能随规则调整（多要的那几张按牌价计，不是整单作废）。
   */
  freeSamplesPerRequest: 1,

  /** 定价：与像素数成正比的那一项 */
  anlasPerPixel: 2951823174884865e-21,

  /** 定价：与「像素数 × 步数」成正比的那一项 */
  anlasPerPixelStep: 5.753298233447344e-7,

  /** 每张的最低收费。极小的图也不会低于这个数 */
  minAnlasPerSample: 2,
} as const;

/**
 * 各档位的规则集标签。免费额度**只有 Opus 有**，所以另外两句都不提「免费档」。
 *
 * 与 `NAI_ANLAS_RULES.rulesetLabel` 同为「让用户看见依据的是哪一版规则」，
 * 分开写是因为它们描述的是**不同的账单规则**，不是同一句话的三种说法。
 */
export const TIER_RULESET_LABELS: Readonly<Record<NaiBillingTier, string>> = {
  opus: NAI_ANLAS_RULES.rulesetLabel,
  metered: 'NovelAI 按点数计费（Tablet / Scroll / 免订阅购点）· 无免费额度',
  unset: 'NovelAI 账户档位未设置 · 无法判断有没有免费额度',
};

/** 正的有限数才算能拿来估算的参数（设置页输入框清空会给出 `NaN`） */
function isUsable(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** {@link estimateAnlasCost} 的可选轴。留成对象是因为这一族参数还会长（v2 的 img2img） */
export interface AnlasEstimateOptions {
  /** `n_samples`，v1 恒 1（D9）；留参数是为了让规则本身可被表达 */
  samples?: number;
  /**
   * 账户档位。**缺省是 `'unset'`，不是 `'opus'`** —— 这条默认值就是修复本身。
   *
   * 缺省若给 `'opus'`，任何忘了传的调用方都会重新得到「这组参数免费」的乐观答案，
   * 而那正是 2026-08-04 那天的 bug：指示器对按点数付费的账户说不要钱。默认值
   * 必须是**不猜**，让忘了传的地方显示「取决于你的订阅」而不是「免费」。
   */
  tier?: NaiBillingTier;
}

/**
 * 按当前出图参数**估算** Anlas 消耗（D43）。
 *
 * @param width  `UiSettings.imageWidth`
 * @param height `UiSettings.imageHeight`
 * @param steps  `UiSettings.imageSteps`
 * @param opts   见 {@link AnlasEstimateOptions}；`tier` 缺省 `'unset'`（不猜）
 * @returns 一份**估算**，不是账单承诺 —— 判定值的命名与 `rulesetLabel` 都在说这件事
 *
 * 三条「绝不乐观」的早退/降级，共用同一条 doctrine ——
 * **把「不知道」显示成「免费」是这个指示器最不该犯的错**：
 * - 任一参数不是正的有限数 → `consumes-anlas` + `invalid-input`
 * - 档位是 `metered` → `consumes-anlas` + `no-free-allowance`（免费额度整个不存在）
 * - 档位是 `unset`   → `consumes-anlas` + `tier-unknown`
 */
export function estimateAnlasCost(
  width: number,
  height: number,
  steps: number,
  opts: AnlasEstimateOptions = {},
): AnlasEstimate {
  const rules = NAI_ANLAS_RULES;
  const samples = opts.samples ?? 1;
  const tier: NaiBillingTier = opts.tier ?? 'unset';
  const rulesetLabel = TIER_RULESET_LABELS[tier] ?? TIER_RULESET_LABELS.unset;

  if (!isUsable(width) || !isUsable(height) || !isUsable(steps) || !isUsable(samples)) {
    return {
      verdict: 'consumes-anlas',
      anlasPerSample: rules.minAnlasPerSample,
      estimatedAnlas: rules.minAnlasPerSample,
      breaches: ['invalid-input'],
      rulesetLabel,
    };
  }

  const pixels = width * height;

  const breaches: AnlasFreeAllowanceBreach[] = [];
  if (pixels > rules.freeMaxPixels) breaches.push('pixels');
  if (steps > rules.freeMaxSteps) breaches.push('steps');
  if (samples > rules.freeSamplesPerRequest) breaches.push('samples');

  // 单张牌价（不计免费额度）。免费档内它也是正数 —— 那是这张图值多少钱，
  // 不是这次要付多少钱，两者的区别由 verdict 表达。
  const anlasPerSample = Math.max(
    rules.minAnlasPerSample,
    Math.ceil(rules.anlasPerPixel * pixels + rules.anlasPerPixelStep * pixels * steps),
  );

  // 🔴 档位先于参数：免费额度是 **Opus 专属**的，别的档位参数再省也一样扣点。
  //    这两项与 pixels/steps 并列进 breaches（而不是替换它们）—— 用户既该知道
  //    「这一档没有免费额度」，也该在调大尺寸时照样看见是哪个参数越了界。
  if (tier === 'metered') breaches.push('no-free-allowance');
  if (tier === 'unset') breaches.push('tier-unknown');

  // 尺寸或步数越界 ⇒ 整单失去免费额度；只是张数多要了几张 ⇒ 仍免掉前 N 张。
  const outOfSpec = breaches.includes('pixels') || breaches.includes('steps');
  // 只有 Opus 才有那 N 张免费额度可言
  const freeSamples = outOfSpec || tier !== 'opus' ? 0 : rules.freeSamplesPerRequest;
  const billedSamples = Math.max(0, samples - freeSamples);

  return {
    verdict: billedSamples === 0 ? 'within-free-allowance' : 'consumes-anlas',
    anlasPerSample,
    estimatedAnlas: billedSamples * anlasPerSample,
    breaches,
    rulesetLabel,
  };
}
