/**
 * Marker Protocol — XML 标记检测与解析 (ADR-25)
 *
 * Phase 6e 核心模块。正文 AI 通过 XML 标记与引擎通信:
 *   <craft_request>  — 🛑 阻塞型: Story 暂停 → 执行制作 → 结果注入正文
 *   <combat_trigger> — 🚩 独立型: request_dispatcher 输出后唤起独立战斗面板（M5.1 统一到调度器，原 Stage 1 story 输出已退役）
 *   <char_detect>    — 👤 隐式型: request_dispatcher 扫描后异步触发角色生成链
 *
 * Phase 10 新增 (request_dispatcher 调度器):
 *   <char_gen_request>    — request_dispatcher 发现新角色
 *   <char_update_request> — request_dispatcher 发现已有角色变更
 *   <item_gen_request>    — request_dispatcher 发现新物品
 *   <item_update_request> — request_dispatcher 发现已有物品变更
 *   <craft_gen_request>   — request_dispatcher 发现制作场景 (统一 _request 后缀)
 *
 * 设计决策:
 * - 纯函数模块，无副作用，无外部依赖
 * - 正则扫描而非 StreamTagParser — 标记检测在已完成文本上进行
 * - 嵌套标记不支持（文档化约束）
 * - **加标记只动 `MARKER_SPECS`**：扫描器、`MARKER_TAGS` 与 `scanMarkers` 的合并
 *   都由这张表推导（Q-05）。`play_audio` 是唯一例外，它的正则形态本质不同。
 */

import type {
  MarkerType,
  DetectedMarker,
  CraftRequestMarker,
  CombatTriggerMarker,
  CharDetectMarker,
  CharGenRequestMarker,
  CharUpdateRequestMarker,
  ItemGenRequestMarker,
  ItemUpdateRequestMarker,
  CraftGenRequestMarker,
  PlayAudioMarker,
  MarkerScanResult,
} from './types';

// ========== Constants ==========

/**
 * 走成对 `<tag …>body</tag>` 通用骨架的标记（= 除 `play_audio` 外的全部）。
 *
 * `play_audio` 不在此列：它还要认自闭合与漏写闭合两种写法，正则形态本质不同，
 * 见 `scanPlayAudioMarkers`。
 */
type BlockMarkerType = Exclude<MarkerType, 'play_audio'>;

/** 由标记类型取回对应的具体标记接口 */
type MarkerOf<K extends MarkerType> = Extract<DetectedMarker, { type: K }>;

/** 除去四个公共字段后，该标记独有的部分 —— 也就是各标记之间**唯一真正的差异** */
type MarkerFields<M extends DetectedMarker> = Omit<
  M,
  'type' | 'rawContent' | 'position' | 'bodyText'
>;

interface MarkerSpec<M extends DetectedMarker> {
  /** 从开标签属性表提取该标记的专有字段 */
  fields: (attrs: Record<string, string>) => MarkerFields<M>;
  /**
   * 正文为空时的取值。**这条差异是既有下游契约，不要顺手统一**：
   * 早期三种（craft_request / combat_trigger / char_detect）`bodyText` 可选，缺省 `undefined`；
   * Phase 10 的 `*_request` 那批类型上是必填 `string`，缺省 `''`。
   */
  emptyBody: M['bodyText'];
}

/**
 * 标记规格表 —— 加/改标记只动这张表（Q-05）。
 *
 * 此前 8 个扫描器各抄一遍完全相同的骨架（建正则 → exec 循环 →
 * push `type`/`rawContent`/`position`/`bodyText`），真正的差异只有 `fields` 这一行。
 * 更要命的是 `scanMarkers` 里还有**两份**手写清单（先分别调用、再手动合并数组），
 * 加第 10 种标记要记得改三处，漏掉合并那处就是「扫得到但没进结果」的静默漏扫。
 * 现在扫描器与合并都从这张表推出来，表是唯一入口。
 */
const MARKER_SPECS: { [K in BlockMarkerType]: MarkerSpec<MarkerOf<K>> } = {
  craft_request: {
    emptyBody: undefined,
    fields: (a) => ({
      characterId: a['characterId'],
      industry: a['industry'],
      productName: a['productName'],
      targetQuality: a['targetQuality'],
      expects: a['expects'],
    }),
  },
  combat_trigger: {
    emptyBody: undefined,
    fields: (a) => ({
      combatType: a['combatType'],
      environment: a['environment'],
    }),
  },
  char_detect: {
    emptyBody: undefined,
    fields: (a) => ({
      characterName: a['characterName'],
      characterType: a['characterType'],
    }),
  },
  // Phase 10 新增: request_dispatcher 调度器 request 标签（专有字段收在 attributes 下）
  char_gen_request: {
    emptyBody: '',
    fields: (a) => ({
      attributes: {
        characterName: a['characterName'],
        race: a['race'],
        tier: a['tier'],
        characterType: a['characterType'],
        faction: a['faction'],
      },
    }),
  },
  char_update_request: {
    emptyBody: '',
    fields: (a) => ({ attributes: { target: a['target'] || '' } }),
  },
  item_gen_request: {
    emptyBody: '',
    fields: (a) => ({
      attributes: {
        itemType: a['itemType'] || '',
        source: a['source'],
        owner: a['owner'],
      },
    }),
  },
  item_update_request: {
    emptyBody: '',
    fields: (a) => ({
      attributes: {
        target: a['target'] || '',
        operation: a['operation'] || '',
        quantity: a['quantity'],
        owner: a['owner'],
      },
    }),
  },
  craft_gen_request: {
    emptyBody: '',
    fields: (a) => ({
      attributes: {
        characterId: a['characterId'],
        industry: a['industry'],
        productName: a['productName'],
        targetQuality: a['targetQuality'],
      },
    }),
  },
};

/** 走通用骨架的标记类型（顺序即 `scanMarkers` 的扫描顺序，最终仍按 position 重排） */
const BLOCK_MARKER_TYPES = Object.keys(MARKER_SPECS) as BlockMarkerType[];

/** 所有已知标记标签名（表推导，不再手抄一份） */
export const MARKER_TAGS: readonly MarkerType[] = [...BLOCK_MARKER_TYPES, 'play_audio'] as const;

/** 标记标签名 Set (O(1) 成员检查) */
export const MARKER_TAG_SET: ReadonlySet<string> = new Set(MARKER_TAGS);

// ========== Internal Helpers ==========

/**
 * 成对标记的通用扫描骨架 —— 8 种标记共用这一份。
 *
 * 返回的 marker 由「四个公共字段 + `spec.fields()` 的展开」拼成；TS 无法证明
 * 泛型展开的结果就是 `M`（`Omit<M,…> & {…}` 对任意 M 不可归约），故此处一处断言。
 * 断言的正确性由 `MARKER_SPECS` 的映射类型在编译期保证：`fields` 少给一个字段、
 * 或给错类型，都会在表里当场红。
 */
function scanByTag<K extends BlockMarkerType>(text: string, type: K): MarkerOf<K>[] {
  const spec = MARKER_SPECS[type] as MarkerSpec<MarkerOf<K>>;
  const markers: MarkerOf<K>[] = [];
  const regex = buildMarkerRegex(type);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const attrs = parseTagAttributes(match[1] || '');
    markers.push({
      type,
      rawContent: match[0],
      position: match.index,
      bodyText: match[2]?.trim() || spec.emptyBody,
      ...spec.fields(attrs),
    } as MarkerOf<K>);
  }
  return markers;
}

/**
 * 为指定标签名构建正则表达式。
 * 匹配完整的 XML 块: <tagname attrs>body</tagname>
 * 使用 [\s\S]*? 非贪婪匹配多行正文。
 */
function buildMarkerRegex(tagName: string): RegExp {
  return new RegExp(
    `<${escapeRegex(tagName)}([^>]*?)>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`,
    'g',
  );
}

/** 转义正则特殊字符 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 提取标签体内容 (去掉开闭标签) */
function extractBody(fullMatch: string, tagName: string): string {
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  const openEnd = fullMatch.indexOf('>');
  if (openEnd === -1) return '';
  const body = fullMatch.slice(openEnd + 1, fullMatch.length - closeTag.length);
  return body;
}

// ========== Public API ==========

/**
 * 判断一个标签名是否为 Phase 6e 标记。
 * O(1) Set 成员检查。
 */
export function isMarkerTag(tagName: string): boolean {
  return MARKER_TAG_SET.has(tagName);
}

/**
 * 将标签名字符串映射到 MarkerType 枚举。
 * 未知标签返回 null。
 */
export function classifyMarker(tagName: string): MarkerType | null {
  if (MARKER_TAG_SET.has(tagName)) {
    return tagName as MarkerType;
  }
  return null;
}

/**
 * 解析 XML 开标签的属性字符串。
 * 例: 'industry="锻造" productName="长剑"' → { industry: '锻造', productName: '长剑' }
 *
 * 支持双引号和单引号属性值。
 */
export function parseTagAttributes(tagText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // 匹配 key="value" 或 key='value'
  const attrRegex = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(tagText)) !== null) {
    if (match[1] !== undefined) {
      attrs[match[1]] = match[2];
    } else if (match[3] !== undefined) {
      attrs[match[3]] = match[4];
    }
  }
  return attrs;
}

/**
 * 以下 8 个具名扫描器都是 `scanByTag` 的薄壳 —— 规格在 `MARKER_SPECS`（Q-05）。
 * 保留具名导出是为了调用方与测试的可读性，别把它们内联掉。
 */

/** 扫描文本中的 `<craft_request>` 标记 */
export function scanCraftRequests(text: string): CraftRequestMarker[] {
  return scanByTag(text, 'craft_request');
}

/** 扫描文本中的 `<combat_trigger>` 标记 */
export function scanCombatTriggers(text: string): CombatTriggerMarker[] {
  return scanByTag(text, 'combat_trigger');
}

/** 扫描文本中的 `<char_detect>` 标记 */
export function scanCharDetects(text: string): CharDetectMarker[] {
  return scanByTag(text, 'char_detect');
}

// ========== Phase 10: vars_update 调度器标签扫描 ==========

/** 扫描文本中的 `<char_gen_request>` 标记 */
export function scanCharGenRequests(text: string): CharGenRequestMarker[] {
  return scanByTag(text, 'char_gen_request');
}

/** 扫描文本中的 `<char_update_request>` 标记 */
export function scanCharUpdateRequests(text: string): CharUpdateRequestMarker[] {
  return scanByTag(text, 'char_update_request');
}

/** 扫描文本中的 `<item_gen_request>` 标记 */
export function scanItemGenRequests(text: string): ItemGenRequestMarker[] {
  return scanByTag(text, 'item_gen_request');
}

/** 扫描文本中的 `<item_update_request>` 标记 */
export function scanItemUpdateRequests(text: string): ItemUpdateRequestMarker[] {
  return scanByTag(text, 'item_update_request');
}

/**
 * 扫描文本中的 `<craft_gen_request>` 标记。
 * 与旧 `<craft_request>` 语义相同，统一 `_request` 后缀。
 */
export function scanCraftGenRequests(text: string): CraftGenRequestMarker[] {
  return scanByTag(text, 'craft_gen_request');
}

/**
 * 扫描文本中的 <play_audio> 标记。
 *
 * 与其它标记不同，这里**自闭合与成对写法都要认**: 配乐标记没有必须包裹的正文，
 * AI 十有八九会写成 `<play_audio situation="战斗"/>`。只认成对写法的话，自闭合
 * 的那些既不会触发播放、也不会被 stripMarkers 清掉——直接漏进正文给玩家看见。
 */
export function scanPlayAudioMarkers(text: string): PlayAudioMarker[] {
  const markers: PlayAudioMarker[] = [];
  // 三种写法都认，按此顺序尝试:
  //   ① 自闭合 `<play_audio .../>`
  //   ② 成对   `<play_audio ...>body</play_audio>`
  //   ③ 只有开标签、没写闭合 —— AI 漏写闭合标签是常事，不认它就等于
  //      「既不换歌、也剥不掉」，那行尖括号会直接漏到玩家眼前
  // 属性段用 `"…"|'…'|[^>"']` 逐段吞，于是属性值里的 `>` 不会被当成标签结束；
  // `i` 标志兼容 AI 写成大写的情况。
  const regex =
    /<play_audio((?:"[^"]*"|'[^']*'|[^>"'])*?)\/>|<play_audio((?:"[^"]*"|'[^']*'|[^>"'])*?)>([\s\S]*?)<\/play_audio\s*>|<play_audio((?:"[^"]*"|'[^']*'|[^>"'])*?)>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const attrs = parseTagAttributes(match[1] ?? match[2] ?? match[4] ?? '');
    markers.push({
      type: 'play_audio',
      rawContent: match[0],
      position: match.index,
      situation: attrs['situation'],
      mood: attrs['mood'],
      character: attrs['character'],
      variant: attrs['variant'],
      action: attrs['action'],
      bodyText: match[3]?.trim() || undefined,
    });
  }
  return markers;
}

/**
 * 只剥 `<play_audio>` 标记，其余标记原样保留。
 *
 * 为什么不用 `stripMarkers`: 正文渲染路径目前**刻意**保留 craft/combat 等标记
 * （美化规则与下游链路都还在读它们），一把全剥会改掉这些既有行为。配乐标记
 * 没有任何渲染意义，漏出去就是玩家眼前的一行尖括号，所以单独剥它。
 */
export function stripPlayAudioMarkers(text: string): string {
  const markers = scanPlayAudioMarkers(text);
  let out = text;
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    const m = markers[i];
    out = out.slice(0, m.position) + out.slice(m.position + m.rawContent.length);
  }
  return out;
}

/**
 * 主入口: 扫描文本中的全部标记（种类以 `MARKER_TAGS` 为准）。
 *
 * 返回:
 * - markers: 所有检测到的标记，按 position 升序排列
 * - cleanText: 剥离所有标记块后的纯文本
 *
 * 非标记 XML 标签 (如 <maintext>, <thinking>) 保留在 cleanText 中。
 * 畸形 XML (缺闭合标签) 被忽略，不崩溃。
 */
export function scanMarkers(text: string): MarkerScanResult {
  // 从规格表推导，不再手抄一份清单（Q-05：旧实现「先分别调用、再手动合并」
  // 两处清单必须同步，且原注释写「全部 8 种」而实际已有 9 种 —— 正是漏扫的温床）
  const allMarkers: DetectedMarker[] = [
    ...BLOCK_MARKER_TYPES.flatMap<DetectedMarker>((type) => scanByTag(text, type)),
    ...scanPlayAudioMarkers(text),
  ].sort((a, b) => a.position - b.position);

  // 生成 cleanText: 按位置倒序替换 (从后往前避免偏移)
  let cleanText = text;
  for (let i = allMarkers.length - 1; i >= 0; i--) {
    const marker = allMarkers[i];
    cleanText =
      cleanText.slice(0, marker.position) +
      cleanText.slice(marker.position + marker.rawContent.length);
  }

  return { markers: allMarkers, cleanText };
}

/**
 * 便利函数: 移除文本中的所有标记标签，返回纯文本。
 * 等价于 scanMarkers(text).cleanText。
 */
export function stripMarkers(text: string): string {
  return scanMarkers(text).cleanText;
}
