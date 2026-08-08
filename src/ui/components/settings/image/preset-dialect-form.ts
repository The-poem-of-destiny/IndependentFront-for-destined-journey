/**
 * preset-dialect-form.ts — 「这条视觉预设在**当前方言**下还有没有可用形象」的纯判定（C15）
 *
 * 为什么单独一个文件而不是写在 `ImagePresetList.vue` 的模板里：这条判据必须与装配层
 * （`image-prompt.appearanceOf` + `composePrompt` 的 `missing-preset` 分支）**给出同一个
 * 答案**。两边不一致的表现不是报错，是「设置页说好好的，图里那个人就是没出现」——
 * C15 之所以要求补这个角标，正是因为跳过是静默的。埋进模板 = 埋进一个测不到的地方。
 *
 * 🔴 判据里 `appearance` 用 `hasAppearanceContent` 而**不是** `!== undefined`（D62）：
 *    编辑器总是整份写回九个槽（D58 留空即空值），所以「只填过老的正向标签框」的预设
 *    带着一个**存在但全空**的 `appearance`。按存在性判会把它当成「有槽」，于是
 *    prose 方言下明明会被跳过的角色不会被标出来 —— 恰好漏掉最需要提示的那一类。
 *
 * 设计: `docs/planning/2026-08-08-comfyui-image-provider-design.md` C15。
 */
import { hasAppearanceContent } from '@engine/character-appearance-resolve';
import type { ImageDialect, ImagePreset } from '@engine/types-image';

/**
 * 角标/提示行那句中文 —— **常量而不是模板里的字面量**，测试与界面读同一份。
 */
export const PRESET_NO_FORM_HINT = '当前方言下无可用形象（只有标签形式）';

/** 判定只需要这两格；收窄入参让调用方不必造整条记录 */
export type FormBearingPreset = Pick<ImagePreset, 'appearance' | 'dialects'>;

/**
 * 这条预设在给定方言下**给不出任何形象**（于是出图时会被判 `missing-preset` 跳过）。
 *
 * 三条同时成立才算：
 * 1. 方言是**散文形态**（`appearance === 'prose'`）—— danbooru 形态下老预设照常可用，
 *    标不出任何东西才是对的；
 * 2. 九个槽里**没有任何内容**（D62：全空 = 没有）——槽是跨方言通用的，有槽就有形象；
 * 3. 也没有写过**同方言**的手写串（`dialects.prose.positive`）。
 *    🔴 `dialects.danbooru` **不算数**：C15 明确不做跨方言降级透传，一串 danbooru 标签
 *    塞进吃句子的模型产出的是一张谁也没要的图。这里跟着装配层走，不自作主张。
 */
export function lacksFormUnderDialect(
  preset: FormBearingPreset,
  dialect: Pick<ImageDialect, 'appearance'>,
): boolean {
  if (dialect.appearance !== 'prose') return false;
  if (hasAppearanceContent(preset.appearance)) return false;
  return (preset.dialects?.prose?.positive ?? '').trim() === '';
}
