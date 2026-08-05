/**
 * character-appearance-agent.ts — AI 报外貌的**线格式**与抽取（D56 / D57）
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md`「v1.2 修订」。
 *
 * ---
 *
 * ## 为什么与场景串走同一次调用
 *
 * `image_prompt` 侧链本来就要看这一段正文、这些出场角色、这个地点。「她换了身衣服」
 * 「左眼上多了道疤」正是从同一段正文里读出来的 —— 再开一次 LLM 调用去问同一份材料，
 * 是**双倍的钱与双倍的延迟**换一个更差的答案（第二次调用看不到第一次的判断）。
 * 所以外貌走同一次响应的附加标签，抽取在这里。
 *
 * ## 线格式
 *
 * ```xml
 * <character_appearance name="艾莉丝">
 * hairStyle: short hair, shoulder length
 * features: scar over left eye
 * outfit: dark travel cloak, leather chestplate
 * </character_appearance>
 * ```
 *
 * 每行 `槽名: 值`。**只写变了的槽** —— 这条既是提示词里的要求，也是本模块的语义：
 * 没出现的槽 = 没说 = 保留原值（`mergeAppearance` 的契约）。
 *
 * 🔴 **为什么不是 JSON**：同一个模型在同一次响应里已经要产 `<image_prompt>` 等三个
 * 标签了，再切一种语法只会提高它写错的概率；而 XML 标签 + 行式键值是本仓已经在用的
 * 形状（`story` 的 `<vars_update>` 同族）。宽松解析在这里比严格语法更值钱。
 *
 * 本文件是**纯函数层**：没有网络、没有 Dexie、不产随机。
 */

import type {
  CharacterAppearance,
  CharacterAppearancePatch,
  ParsedCharacterAppearance,
} from './character-appearance';
import { APPEARANCE_SLOT_ORDER, EMPTY_APPEARANCE } from './character-appearance';
import { normalizeTagString } from './image-prompt';

// 解析产物的类型在 `character-appearance.ts`（零依赖，types-image 要引用它，
// 放这边会成环）。本模块原样再导出，调用方 import 哪边都对。
export type { ParsedCharacterAppearance } from './character-appearance';

/** 槽名的容错映射：模型会写驼峰、下划线、也会写中文 */
const SLOT_ALIASES: Readonly<Record<string, keyof CharacterAppearance>> = {
  count: 'count',
  人数: 'count',
  haircolor: 'hairColor',
  hair_color: 'hairColor',
  发色: 'hairColor',
  hairstyle: 'hairStyle',
  hair_style: 'hairStyle',
  hair: 'hairStyle',
  发型: 'hairStyle',
  eyes: 'eyes',
  eyecolor: 'eyes',
  eye_color: 'eyes',
  瞳色: 'eyes',
  build: 'build',
  body: 'build',
  体型: 'build',
  features: 'features',
  feature: 'features',
  特征: 'features',
  outfit: 'outfit',
  clothes: 'outfit',
  clothing: 'outfit',
  服装: 'outfit',
  穿戴: 'outfit',
  condition: 'condition',
  state: 'condition',
  状态: 'condition',
  expression: 'expression',
  face: 'expression',
  表情: 'expression',
};

/** `<character_appearance name="…"> … </character_appearance>`，宽松匹配 */
const BLOCK_RE =
  /<character_appearance\s+name\s*=\s*["']([^"']*)["']\s*>([\s\S]*?)<\/character_appearance\s*>/gi;

/**
 * 把一段响应里的全部 `<character_appearance>` 块抽出来。
 *
 * 宽松到底：抽不到就返回空数组，**绝不抛**。外貌是锦上添花 —— 为了一个畸形的
 * 附加标签让整张图失败，是把「少一件衣服」升级成「没有图」。
 *
 * 🔴 认不出的槽名**直接丢弃**，不猜、不塞进别的槽。猜错的下场是把「疤」写进
 *    「发色」，那比丢掉更糟 —— 它会**永久**落进会话副本，之后每张图都错。
 */
export function parseCharacterAppearances(raw: string): ParsedCharacterAppearance[] {
  const out: ParsedCharacterAppearance[] = [];
  if (!raw) return out;

  BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BLOCK_RE.exec(raw)) !== null) {
    const name = match[1].trim();
    // 空名字对不上任何角色，留着只会在会话表里长出一行永远查不中的垃圾
    if (name === '') continue;

    const patch: CharacterAppearancePatch = {};
    for (const line of match[2].split(/[\r\n]+/)) {
      const sep = line.indexOf(':');
      if (sep <= 0) continue;
      const key = line.slice(0, sep).trim().toLowerCase().replace(/\s+/g, '');
      const slot = SLOT_ALIASES[key];
      if (!slot) continue; // 认不出就丢，不猜
      // 值过一遍标点归一化（模型在中文语境里极易带出全角逗号）
      patch[slot] = normalizeTagString(line.slice(sep + 1));
    }

    if (Object.keys(patch).length > 0) out.push({ name, patch });
  }
  return out;
}

/**
 * 首次出图时给这个角色**建基线**（D57）。
 *
 * 与上报共用同一条线格式与同一个抽取器 —— 建基线只是「patch 落在一份空白上」，
 * 不值得为它再发明一套语法。
 *
 * 🔴 **建的是基线不是会话副本**：第一次见到这个角色时她的样子，定义上就是她的
 *    初始样子。写进会话副本会让基线永远空着，D56 那份「干净的、可回退的真源」
 *    也就不存在了。
 */
export function bootstrapAppearance(patch: CharacterAppearancePatch): CharacterAppearance {
  const out: CharacterAppearance = { ...EMPTY_APPEARANCE };
  for (const slot of APPEARANCE_SLOT_ORDER) {
    const value = patch[slot];
    if (value !== undefined) out[slot] = value;
  }
  return out;
}

/** 这份 patch 值不值得当作基线用 —— 全空的基线与没有基线是一回事 */
export function isUsableBaseline(appearance: CharacterAppearance): boolean {
  return APPEARANCE_SLOT_ORDER.some((slot) => appearance[slot].trim() !== '');
}

/**
 * 要追加进 `image_prompt` systemPrompt 的那段规则（D56/D57）。
 *
 * 放在这里而不是直接写进 `agent-config.json`，是为了让**格式的定义与解析器同源**：
 * 改线格式时两边一起改，不会出现「提示词教它写 A、解析器只认 B」那种静默失效。
 * 装配侧把它拼进 systemPrompt。
 */
export const APPEARANCE_PROMPT_RULES = `
若这一段正文里出现了**角色外貌的变化**（换了衣服、受伤留疤、剪了头发、浑身湿透等），
在三个标签之后**追加**下面这种块，一个角色一块；没有变化就一个都不要写:

<character_appearance name="角色名">
outfit: dark travel cloak, leather chestplate
condition: soaked, muddy
</character_appearance>

规则:
1. 名字必须与出场角色名**逐字相同**。
2. 每行 \`槽名: danbooru 标签\`。可用槽名只有这九个:
   count（人数性别）/ hairColor（发色）/ hairStyle（发型发长）/ eyes（瞳色）/
   build（体型）/ features（疤痕纹身等固有特征）/ outfit（当前穿戴）/
   condition（湿透脏污负伤等临时状态）/ expression（表情）
3. 🔴 **只写这一刻**真的**变了或值得记下的槽**，没变的一个都别写 ——
   没写的槽会保留原值，重复写一遍反而可能把措辞改坏。
4. 输入里若给了**尚无外观设定的角色**名单，**为那几个角色把九个槽尽量写全**（写不出的留空
   即可不写），那会成为他们的初始设定。名单之外的角色仍按第 3 条只写变化。
`.trim();
