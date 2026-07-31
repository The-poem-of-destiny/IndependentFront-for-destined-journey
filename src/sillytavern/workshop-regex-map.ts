/**
 * workshop-regex-map.ts — ST 正则 → BeautifierRule（Phase 1 / P1-1，D16）
 *
 * 决策（D16）: **原样安装、默认启用、不做任何剥离。**
 * 不剥 `<script>`、不剥 `<style>`、不改写 `replaceString` 一个字节。
 * 已知后果已确认接受，逐条记入 `droppedNotes` 由 UI 如实展示 —— 见文件末尾
 * `noteKnownConsequences()`。
 *
 * 三个**实测**的坑（每一个都曾是「看起来显然」的错误假设）:
 *
 * 1. `findRegex` **有两种形态**。实测 6 条里 2 条是裸 pattern（`<yanling_edits\b...`），
 *    4 条是带定界符的 `/pattern/flags`。把 `/.../g` 整串塞进 `new RegExp()` 会得到一个
 *    真的去匹配斜杠字符的正则 —— 能编译、不报错、永不命中。见 `parseFindRegex()`。
 *
 * 2. `substituteRegex` 是**枚举不是布尔**（实测值 0 与 2）。`if (entry.substituteRegex)`
 *    在值为 2 时为真、值为 0 时为假，看着像布尔用着像布尔，直到有人传 1。
 *    本引擎无对应物，一律丢弃；仅非 0 时记 note（0 = 不替换，丢弃它没丢任何信息）。
 *
 * 3. 捕获组方言**已核实兼容**，不要「顺手转写」。实测 6/6 条一律 `$1..$9`，
 *    `{{match}}` 出现 0 次；引擎侧 `processRules()` 走的是原生
 *    `result.replace(re, rule.replacement)`，同为 JS 语义。**`replacement` 原样搬。**
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局。唯一的「副作用」是
 * `new RegExp()` 试编译，用于把编译不过的规则挡在库外（`processRules()` 对
 * 编译失败是静默跳过的，不挡的话用户会看到一条永远不生效却显示「已启用」的规则）。
 *
 * 设计: docs/planning/2026-07-31-creative-workshop-compat-design.md D16
 */

import type { BeautifierRuleDraft, WorkshopSourceRegex } from './workshop-types';
import {
  WORKSHOP_RULE_GROUP_PREFIX,
  WORKSHOP_RULE_ORDER_BASE,
  workshopBookId,
  workshopRuleId,
} from './workshop-types';

/** JS 正则合法 flag 字符（含 ES2022 的 `d` 与 ES2024 的 `v`） */
const VALID_REGEX_FLAGS = 'dgimsuvy';

export interface ParsedFindRegex {
  pattern: string;
  flags: string;
  /** 是否解析出了 `/pattern/flags` 定界形态（供测试与诊断） */
  delimited: boolean;
}

/**
 * 解析 ST 的 `findRegex` —— **两种形态都要吃**（D16 坑 1）。
 *
 * - `/<Vera\s+form="([^"]*)">/g` → `{ pattern: '<Vera\\s+form="([^"]*)">', flags: 'g' }`
 * - `<yanling_edits\b[^>]*>` → `{ pattern: '<yanling_edits\\b[^>]*>', flags: '' }`
 *
 * 定界形态的判定条件（全部满足才算）:
 * 1. 首字符是 `/`
 * 2. 存在一个**未被反斜杠转义**的收尾 `/`，且它不是首字符
 * 3. 收尾 `/` 之后的尾串是合法 flag 且无重复
 *
 * 任何一条不满足 → 当作裸 pattern 原样返回。这条兜底很重要:
 * 一个真的以 `/` 开头的裸 pattern（如 `/api/(\w+)` 这种匹配路径的）不会被误拆。
 *
 * ⚠️ 裸形态**不补 `g`**。ST 自己的 `regexFromString()` 对裸串也是
 * `new RegExp(input)`（无 flag），补 `g` 会让「只替换第一处」变成「替换全部」，
 * 是行为改写而不是兼容。
 */
export function parseFindRegex(findRegex: string): ParsedFindRegex {
  const bare: ParsedFindRegex = { pattern: findRegex, flags: '', delimited: false };
  if (findRegex.length < 2 || findRegex[0] !== '/') return bare;

  // 从右往左找第一个未转义的 `/`
  let close = -1;
  for (let i = findRegex.length - 1; i > 0; i--) {
    if (findRegex[i] !== '/') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && findRegex[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) {
      close = i;
      break;
    }
  }
  if (close <= 0) return bare;

  const flags = findRegex.slice(close + 1);
  const seen = new Set<string>();
  for (const ch of flags) {
    if (!VALID_REGEX_FLAGS.includes(ch) || seen.has(ch)) return bare;
    seen.add(ch);
  }

  return { pattern: findRegex.slice(1, close), flags, delimited: true };
}

export interface RegexMapContext {
  projectId: string;
  projectName: string;
  /** 规则 order 起始值，默认 `WORKSHOP_RULE_ORDER_BASE` */
  orderBase?: number;
}

export interface RegexMapResult {
  rules: BeautifierRuleDraft[];
  /** 丢弃项与已知后果 —— **必须 loud**，静默截断会让用户以为装全了 */
  droppedNotes: string[];
}

/**
 * 记录「原样安装」带来的已知后果（D16 已确认接受，但必须如实告知）。
 *
 * 这些不是我们**丢弃**的东西，而是我们**保留了但环境不支持**的东西 ——
 * 两者对用户是同一个问题：「我装的东西没完全生效」，故合流进同一个数组。
 */
function noteKnownConsequences(name: string, replacement: string, notes: string[]): void {
  if (/<script[\s>]/i.test(replacement)) {
    notes.push(`「${name}」replacement 含 <script>：v-html 插入的脚本浏览器不会执行，该段只占字节`);
  }
  if (/<style[\s>]/i.test(replacement)) {
    notes.push(`「${name}」replacement 含 <style>：样式会全局生效，可能覆盖应用主题 token`);
  }
  if (/^\s*```/.test(replacement)) {
    notes.push(`「${name}」replacement 包在 \`\`\` 围栏里：本应用无围栏渲染器，会原样显示`);
  }
  if (/<!doctype|<html[\s>]/i.test(replacement)) {
    notes.push(`「${name}」replacement 是完整 HTML 文档：<html>/<head>/<body> 会被解析器丢弃，渲染残缺`);
  }
  const macros = replacement.match(/\{\{[^}]+\}\}/g);
  if (macros && macros.length > 0) {
    notes.push(`「${name}」replacement 含 ${macros.length} 处 {{...}} 宏：美化管线无宏替换环节，将原样输出`);
  }
}

/**
 * 逐条丢弃 ST 侧无对应物的字段（D16）。
 *
 * 只在字段**真的携带了信息**时记 note —— `substituteRegex: 0` / 空 `placement` /
 * `minDepth: null` 丢掉不损失任何东西，为它们刷屏会淹没真正的丢弃项。
 */
function noteDroppedFields(name: string, entry: WorkshopSourceRegex, notes: string[]): void {
  if (entry.placement.length > 0) {
    notes.push(`「${name}」丢弃 placement=[${entry.placement.join(',')}]：本引擎无消息位置定向`);
  }
  if (entry.minDepth !== null) {
    notes.push(`「${name}」丢弃 minDepth=${entry.minDepth}：本引擎美化不按楼层深度限定`);
  }
  if (entry.maxDepth !== null) {
    notes.push(`「${name}」丢弃 maxDepth=${entry.maxDepth}：本引擎美化不按楼层深度限定`);
  }
  // ⚠️ 枚举非布尔：0 = 不替换，丢弃无损；非 0 才是真丢了东西
  if (entry.substituteRegex !== 0) {
    notes.push(`「${name}」丢弃 substituteRegex=${entry.substituteRegex}：本引擎无宏替换环节`);
  }
  if (entry.runOnEdit) {
    notes.push(`「${name}」丢弃 runOnEdit：本引擎美化在渲染时统一求值，无编辑态重跑`);
  }
  if (entry.trimStrings.length > 0) {
    notes.push(`「${name}」丢弃 trimStrings（${entry.trimStrings.length} 项）：本引擎无裁剪串环节`);
  }
  // markdownOnly=false 意味着上游同时改写提示词侧，而美化库是纯显示层
  if (!entry.markdownOnly) {
    notes.push(`「${name}」markdownOnly 为 false：提示词侧改写未导入，仅作用于显示层`);
  }
}

/**
 * ST 正则条目 → 美化规则（D16 字段映射表）。
 *
 * | ST | → BeautifierRule |
 * | --- | --- |
 * | `findRegex` | `pattern` + `flags`（两种形态，见 `parseFindRegex`） |
 * | `replaceString` | `replacement`（**原样**，不转写捕获组、不剥标签） |
 * | `disabled` | `enabled`（取反） |
 * | `scriptName` | `name` |
 * | `markdownOnly` | `scope: 'maintext'` |
 * | — | `isBuiltin: false` · `group: '创意工坊 · <项目名>'` |
 * | — | `autoEnable.worldBookIds: ['workshop:<projectId>']`（装了才启用，卸载即失效） |
 *
 * **整条跳过**的两种情况:
 * - `promptOnly: true` —— 美化库是显示层，无提示词侧改写通道，装进来只会是一条
 *   永远看不到效果的规则
 * - `pattern` 编译失败 —— `processRules()` 对编译失败静默跳过，装进来会显示
 *   「已启用」却永不生效
 */
export function mapWorkshopRegexes(
  entries: WorkshopSourceRegex[],
  ctx: RegexMapContext,
): RegexMapResult {
  const rules: BeautifierRuleDraft[] = [];
  const droppedNotes: string[] = [];
  const orderBase = ctx.orderBase ?? WORKSHOP_RULE_ORDER_BASE;

  entries.forEach((entry, index) => {
    const name = entry.scriptName.trim() || `未命名正则 ${index + 1}`;

    if (entry.promptOnly) {
      droppedNotes.push(`「${name}」整条未导入（promptOnly）：美化库是显示层，无提示词侧改写通道`);
      return;
    }

    const { pattern, flags } = parseFindRegex(entry.findRegex);
    if (!pattern) {
      droppedNotes.push(`「${name}」整条未导入：findRegex 为空`);
      return;
    }
    try {
      new RegExp(pattern, flags);
    } catch {
      droppedNotes.push(`「${name}」整条未导入：正则编译失败（${entry.findRegex.slice(0, 40)}…）`);
      return;
    }

    rules.push({
      id: workshopRuleId(ctx.projectId, entry.id),
      name,
      // 美化库是显示层，工坊正则一律落在正文作用域
      scope: 'maintext',
      pattern,
      flags,
      // ⚠️ 原样搬（D16 坑 3）：捕获组方言已核实兼容，不转写、不剥 script/style
      replacement: entry.replaceString,
      enabled: !entry.disabled,
      order: orderBase + index,
      isBuiltin: false,
      autoEnable: { worldBookIds: [workshopBookId(ctx.projectId)] },
      group: `${WORKSHOP_RULE_GROUP_PREFIX}${ctx.projectName}`,
    });

    noteDroppedFields(name, entry, droppedNotes);
    noteKnownConsequences(name, entry.replaceString, droppedNotes);
  });

  return { rules, droppedNotes };
}
