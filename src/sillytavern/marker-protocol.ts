/**
 * Marker Protocol — XML 标记检测与解析 (ADR-25)
 *
 * Phase 6e 核心模块。正文 AI 通过三种 XML 标记与引擎通信:
 *   <craft_request>  — 🛑 阻塞型: Story 暂停 → 执行制作 → 结果注入正文
 *   <combat_trigger> — 🚩 独立型: Stage 1 后唤起独立战斗页面
 *   <char_detect>    — 👤 隐式型: vars_update 扫描后异步触发角色生成链
 *
 * 设计决策:
 * - 纯函数模块，无副作用，无外部依赖
 * - 正则扫描而非 StreamTagParser — 标记检测在已完成文本上进行
 * - 嵌套标记不支持（文档化约束）
 */

import type {
  MarkerType,
  DetectedMarker,
  CraftRequestMarker,
  CombatTriggerMarker,
  CharDetectMarker,
  MarkerScanResult,
} from './types';

// ========== Constants ==========

/** 所有已知标记标签名 */
export const MARKER_TAGS: readonly MarkerType[] = [
  'craft_request',
  'combat_trigger',
  'char_detect',
] as const;

/** 标记标签名 Set (O(1) 成员检查) */
export const MARKER_TAG_SET: ReadonlySet<string> = new Set(MARKER_TAGS);

// ========== Internal Helpers ==========

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
 * 扫描文本中的 <craft_request> 标记。
 * 正则: /<craft_request([^>]*)>([\s\S]*?)<\/craft_request>/g
 */
export function scanCraftRequests(text: string): CraftRequestMarker[] {
  const markers: CraftRequestMarker[] = [];
  const regex = buildMarkerRegex('craft_request');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const attrs = parseTagAttributes(match[1] || '');
    markers.push({
      type: 'craft_request',
      rawContent: match[0],
      position: match.index,
      characterId: attrs['characterId'],
      industry: attrs['industry'],
      productName: attrs['productName'],
      targetQuality: attrs['targetQuality'],
      expects: attrs['expects'],
      bodyText: match[2]?.trim() || undefined,
    });
  }
  return markers;
}

/**
 * 扫描文本中的 <combat_trigger> 标记。
 * 正则: /<combat_trigger([^>]*)>([\s\S]*?)<\/combat_trigger>/g
 */
export function scanCombatTriggers(text: string): CombatTriggerMarker[] {
  const markers: CombatTriggerMarker[] = [];
  const regex = buildMarkerRegex('combat_trigger');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const attrs = parseTagAttributes(match[1] || '');
    markers.push({
      type: 'combat_trigger',
      rawContent: match[0],
      position: match.index,
      combatType: attrs['combatType'],
      environment: attrs['environment'],
      bodyText: match[2]?.trim() || undefined,
    });
  }
  return markers;
}

/**
 * 扫描文本中的 <char_detect> 标记。
 * 正则: /<char_detect([^>]*)>([\s\S]*?)<\/char_detect>/g
 */
export function scanCharDetects(text: string): CharDetectMarker[] {
  const markers: CharDetectMarker[] = [];
  const regex = buildMarkerRegex('char_detect');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const attrs = parseTagAttributes(match[1] || '');
    markers.push({
      type: 'char_detect',
      rawContent: match[0],
      position: match.index,
      characterName: attrs['characterName'],
      characterType: attrs['characterType'],
      bodyText: match[2]?.trim() || undefined,
    });
  }
  return markers;
}

/**
 * 主入口: 扫描文本中的全部三种标记。
 *
 * 返回:
 * - markers: 所有检测到的标记，按 position 升序排列
 * - cleanText: 剥离所有标记块后的纯文本
 *
 * 非标记 XML 标签 (如 <maintext>, <thinking>) 保留在 cleanText 中。
 * 畸形 XML (缺闭合标签) 被忽略，不崩溃。
 */
export function scanMarkers(text: string): MarkerScanResult {
  const craftMarkers = scanCraftRequests(text);
  const combatMarkers = scanCombatTriggers(text);
  const charMarkers = scanCharDetects(text);

  // 合并并按位置排序
  const allMarkers: DetectedMarker[] = [
    ...craftMarkers,
    ...combatMarkers,
    ...charMarkers,
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
