/**
 * character-appearance-resolve.ts — 「这个角色现在到底长什么样」的**唯一**判定（D56/D57 v1.3）
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md`「v1.2 修订」+ 末尾 v1.3 修订。
 *
 * ---
 *
 * ## 两份定义，谁能写哪一份（v1.3 收口）
 *
 * | 层 | 存哪 | 谁能写 | 生命周期 |
 * | --- | --- | --- | --- |
 * | **初始设定（基线）** | `imagePresets.appearance`（全局） | **只有用户** | 跨存档，永不随存档删 |
 * | **本档外貌（会话）** | `characterAppearances.patch`（按存档） | 出图 AI 自动写 | 删存档连带删，两个重置口 |
 *
 * 🔴 **AI 一个字节都碰不到基线**（v1.3 裁定，2026-08-05）。此前 D57 让「没有基线的角色」
 *    由 AI 现建一份**基线**，理由是「第一次见到她的样子就是她的初始样子」。那条在结构上
 *    有三个洞：① 基线是全局的，A 周目里 AI 即兴出来的样子会成为 B 周目的定义；
 *    ② 两个重置口都只清会话表，够不着它；③ 设置页写着「剧情里的变化由 AI 记在本存档的
 *    副本里，初始设定不受影响」—— 界面在承诺一件代码不做的事。
 *
 *    现在改成: **没有基线时，AI 即兴出来的那份也只落会话层**（差量的基准是全空）。
 *    代价说清楚：这种角色「整档重置」之后会回到没有外貌可用的状态，下一张图重新即兴 ——
 *    这正是**想要**的语义（用户没定义过他，就没有什么可回退到）。想要跨存档钉死，
 *    路径是设置页那个「存为初始设定」，由**人**按下。
 *
 * ---
 *
 * 本文件是**纯函数叶子**：不 import 除 `character-appearance`（零依赖）与 `types-image`
 * （type-only）之外的任何东西，没有 Dexie / Pinia / Vue / 时钟 / 随机。存在的理由是
 * 「有没有可用外貌」这个判据**有四个消费方**（装配、侧链提示、正文缺预设提示、写入路由），
 * 各写一份必然漂 —— 而漂掉的表现是「界面说这张图的形象是随机的，其实并不是」。
 */

import type { CharacterAppearance, CharacterAppearancePatch } from './character-appearance';
import { EMPTY_APPEARANCE, mergeAppearance } from './character-appearance';
import type { CharacterSessionAppearance, ImagePreset } from './types-image';

/**
 * 角色预设的主键拼法 —— **引擎侧唯一一处**。
 *
 * 此前 `image-prompt.ts` 里有两处 `` `character:${name}` `` 字面量，本模块合成会话专属
 * 预设行时还要第三处；三处拼同一个键，改分隔符时漏掉一处的表现是「预设查不中」，
 * 不报错。UI 侧 `image-preset-store.imagePresetKey(kind, name)` 是它的多态版本
 * （还要拼 `kind`），两者必须产出同一个字符串 —— 那边的注释也指回这里。
 */
export function characterPresetKey(name: string): string {
  return `character:${name}`;
}

/**
 * 这份槽里有没有任何内容。
 *
 * 🔴 **全空的 `appearance` 等于没有 `appearance`**。设置页的编辑器**总是**整份写回九个槽
 * （D58：留空即空值），所以「只填了旧的正向标签框、九个槽全留空」的预设，其
 * `appearance` 是一个存在但全空的对象 —— 拿 `preset.appearance !== undefined` 当判据，
 * 就会让这条预设在装配时产出空串并被当成「没有预设」丢掉，而用户明明填过东西。
 */
export function hasAppearanceContent(appearance: CharacterAppearance | undefined): boolean {
  if (!appearance) return false;
  for (const value of Object.values(appearance)) {
    if (typeof value === 'string' && value.trim() !== '') return true;
  }
  return false;
}

/** 这条预设的**用户基线**（全空视作没有）。`undefined` = 用户没定义过他的外貌 */
export function baselineOf(preset: ImagePreset | undefined): CharacterAppearance | undefined {
  const appearance = preset?.appearance;
  return hasAppearanceContent(appearance) ? appearance : undefined;
}

/**
 * 这条预设有没有**手写的** danbooru 正向串（槽模型之前的老形态）。
 *
 * 它同样是**用户写的东西**，所以在写入路由里与基线同档：有它就不许 AI 覆盖。
 */
export function hasHandwrittenDialect(preset: ImagePreset | undefined): boolean {
  return (preset?.dialects?.danbooru?.positive ?? '').trim() !== '';
}

/**
 * AI 报了一次外貌变化时，该往哪写、拿什么当差量基准。
 *
 * - `{ kind: 'session', base }` —— 落会话层。`base` 是差量基准：有基线就是基线，
 *   没有就是**全空**（即兴那一份，v1.3）。
 * - `{ kind: 'skip' }` —— 这条预设是用户**手写的老形态**（有 danbooru 串、没有槽）。
 *   会话层只能表达槽，把它落下去会让合并后的槽盖过那串手写标签（`danbooruOf` 槽优先），
 *   等于 AI 悄悄改写了用户写的东西。宁可这一档记不住「她换了衣服」，也不动用户的原文；
 *   迁移路径是把手写串填进槽（D58），不是让两者共存生效。
 */
export type AppearanceWriteTarget =
  { kind: 'session'; base: CharacterAppearance } | { kind: 'skip' };

export function appearanceWriteTarget(preset: ImagePreset | undefined): AppearanceWriteTarget {
  const base = baselineOf(preset);
  if (base) return { kind: 'session', base };
  if (hasHandwrittenDialect(preset)) return { kind: 'skip' };
  return { kind: 'session', base: EMPTY_APPEARANCE };
}

/**
 * 出图时该用的那份外貌 = 基线 + 本档覆盖；没有基线时 = 全空 + 本档覆盖（即兴，v1.3）。
 *
 * 返回 `undefined` 表示**这个角色没有任何可用外貌** —— 装配层据此产 `missing-preset` 告警，
 * 渲染层据此说「这张图里的形象是随机的」。两处必须用同一个答案。
 */
export function effectiveAppearanceOf(
  preset: ImagePreset | undefined,
  patch: CharacterAppearancePatch | undefined,
): CharacterAppearance | undefined {
  const base = baselineOf(preset);
  if (base) return mergeAppearance(base, patch);
  // 手写老形态：外貌由 `dialects.danbooru` 表达，不是槽 —— 这里没有槽可给
  if (hasHandwrittenDialect(preset)) return undefined;
  const improvised = mergeAppearance(EMPTY_APPEARANCE, patch);
  return hasAppearanceContent(improvised) ? improvised : undefined;
}

/** 这个角色此刻有没有**任何**可用外貌（槽或手写串）—— 缺预设提示的唯一判据 */
export function hasEffectiveAppearance(
  preset: ImagePreset | undefined,
  patch: CharacterAppearancePatch | undefined,
): boolean {
  return effectiveAppearanceOf(preset, patch) !== undefined || hasHandwrittenDialect(preset);
}

/**
 * 侧链要不要被告知「请为这几个人把九个槽写全」（D57）。
 *
 * 🔴 **有了会话副本之后就不再要求**。模型看不到库，全靠引擎点名；点名一直不撤的话，
 *    每一张图都会让它把九个槽**重新即兴一遍**，而那正是 D58 要消灭的「没钉住的属性
 *    每张图重新决定一次」—— 点名本身会变成漂移的来源。第一次报完就该收声。
 */
export function needsBaselineReport(
  preset: ImagePreset | undefined,
  patch: CharacterAppearancePatch | undefined,
): boolean {
  return !hasEffectiveAppearance(preset, patch);
}

/**
 * 预设全表 + 本档会话副本 → **装配层唯一认得的那一份**外貌预设表。
 *
 * 两件事：
 * 1. 有预设的角色：把本档覆盖就地叠进 `appearance`，于是 `composePrompt` 不必知道
 *    「有两份定义」这回事。
 * 2. 🔴 **只有会话副本、没有预设行的角色也要出现在结果里**（v1.3 的要害）。AI 即兴出来
 *    的外貌就住在这一类里；漏掉他们，那份即兴外貌就永远到不了提示词，表现为
 *    「AI 明明报了外貌，画出来还是每张一个样」。
 *
 * 手写老形态（有 danbooru 串、没有槽）原样透传，不叠会话覆盖 —— 同 {@link appearanceWriteTarget}。
 */
export function buildEffectivePresets(
  presets: readonly ImagePreset[],
  sessions: readonly CharacterSessionAppearance[],
): ImagePreset[] {
  const patchByName = new Map<string, CharacterAppearancePatch>();
  // 🔴 名字**原样**做键，不归一化（铁律 1）—— 会话行与预设行都以原始字符串 `===` 匹配
  for (const row of sessions) patchByName.set(row.name, row.patch);

  const covered = new Set<string>();
  const out: ImagePreset[] = [];

  for (const preset of presets) {
    if (preset.kind === 'character') covered.add(preset.name);
    const patch = patchByName.get(preset.name);
    const merged = patch === undefined ? undefined : effectiveAppearanceOf(preset, patch);
    out.push(merged === undefined ? preset : { ...preset, appearance: merged });
  }

  for (const row of sessions) {
    if (covered.has(row.name)) continue;
    const improvised = effectiveAppearanceOf(undefined, row.patch);
    // 全空的 patch 造不出外貌，也就没有理由造一条预设行
    if (improvised === undefined) continue;
    out.push({
      key: characterPresetKey(row.name),
      kind: 'character',
      name: row.name,
      appearance: improvised,
      dialects: {},
      createdAt: row.updatedAt,
      updatedAt: row.updatedAt,
    });
  }

  return out;
}
