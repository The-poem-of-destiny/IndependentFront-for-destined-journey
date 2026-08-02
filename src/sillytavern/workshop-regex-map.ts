/**
 * workshop-regex-map.ts — ST 正则 → BeautifierRule（Phase 1 / P1-1，D16）
 *
 * 决策（D16）: **原样安装、默认启用、不做任何剥离。**
 * 不剥 `<script>`、不剥 `<style>`、不改写 `replaceString` 一个字节。
 * 已知后果已确认接受，逐条记入 `droppedNotes` 由 UI 如实展示 —— 见文件末尾
 * `noteKnownConsequences()`。
 *
 * ★ 每条 note 带 `kind`（`dropped` / `degraded` / `sideEffect`）。这不是装饰：
 * 「`placement` 不受支持」与「`<script>` 装上了但不执行」曾经合流成同一个数字，UI 报
 * 「34 项内容未导入」，而那些正则装得好好的。**只有 `dropped` 配叫「未导入」。**
 *
 * 三个**实测**的坑（每一个都曾是「看起来显然」的错误假设）:
 *
 * 1. `findRegex` **有两种形态**。实测 6 条里 2 条是裸 pattern（`<yanling_edits\b...`），
 *    4 条是带定界符的 `/pattern/flags`。把 `/.../g` 整串塞进 `new RegExp()` 会得到一个
 *    真的去匹配斜杠字符的正则 —— 能编译、不报错、永不命中。见 `parseFindRegex()`。
 *
 * 2. `substituteRegex` 是**枚举不是布尔**（实测值 0、1 与 2）。它只在
 *    `findRegex` 含上游宏时改变匹配式；完整公共语料的三个非零条目都不含这种宏，
 *    因而不能把惰性元数据误报成兼容性损失。
 *
 * 3. 捕获组方言**已核实兼容**，不要「顺手转写」。2026-08-02 的完整公开语料
 *    含 99 条正则、最高使用 `$39`；结构化编译器保持原生 JS replacement 语义。
 *    **`replacement` 原样搬。**
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局。唯一的「副作用」是
 * `new RegExp()` 试编译，用于把编译不过的规则挡在库外（`processRules()` 对
 * 编译失败是静默跳过的，不挡的话用户会看到一条永远不生效却显示「已启用」的规则）。
 *
 * 设计: docs/planning/2026-07-31-creative-workshop-compat-design.md D16
 */

import type { WorkshopNote } from './types';
import type { BeautifierRuleDraft, WorkshopSourceRegex } from './workshop-types';
import {
  WORKSHOP_RULE_GROUP_PREFIX,
  WORKSHOP_RULE_ORDER_BASE,
  workshopBookId,
  workshopNote,
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
  /**
   * 本批 `entries[0]` 在**整个项目**里的序号，默认 0。
   *
   * ★ 存在的唯一理由: 本函数是**索引敏感**的 —— 未命名正则兜底成
   * `未命名正则 ${序号+1}`，`order` 也按序号递增。装前检视要拿「按条归属」的
   * notes，只能一条一条单独调用，那时批内序号恒为 0；若不把真实序号传进来，
   * 同一条正则会在装前显示「未命名正则 1」、装后显示「未命名正则 3」，
   * 用户会以为是两条不同的规则出了问题。
   *
   * 整批调用（真正安装那次）不传即可，行为与加这个字段之前完全一致。
   */
  indexBase?: number;
}

export interface RegexMapResult {
  rules: BeautifierRuleDraft[];
  /**
   * 处置记录 —— **必须 loud**，静默截断会让用户以为装全了。
   *
   * ⚠️ 每条带 `kind`（见 `WorkshopNote`）。**别把这一整个数组当「未导入」报数**：
   * 只有 `dropped` 是真丢了；`degraded` / `sideEffect` 那条正则是**装了也启用了**的。
   */
  droppedNotes: WorkshopNote[];
}

/**
 * 记录「原样安装」带来的已知后果（D16 已确认接受，但必须如实告知）。
 *
 * ★ 这些**不是丢弃**：规则装上了、`enabled` 按上游、匹配照常发生。它们描述的是
 * 装上之后会怎么表现，所以一律是 `degraded`（自身渲染不完整）或 `sideEffect`
 * （溢出到规则之外）。把它们混进「未导入」的计数，就是本文件曾经在 UI 上说的谎。
 */
function noteKnownConsequences(name: string, replacement: string, notes: WorkshopNote[]): void {
  if (
    /\b(?:window\s*\.\s*(?:parent|top|opener)|parent\s*\.|top\s*\.\s*document|opener\s*\.)/.test(
      replacement,
    ) ||
    /\b(?:SillyTavern|getContext|getVariables|setVariables|tavern_events|SlashCommandParser|eventSource)\b/.test(
      replacement,
    )
  ) {
    notes.push(
      workshopNote(
        'degraded',
        `「${name}」依赖父页面或酒馆 API：隔离框只提供空数据兼容面，不开放应用 DOM、存档或模型调用`,
      ),
    );
  }

  if (/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(replacement)) {
    notes.push(
      workshopNote(
        'degraded',
        `「${name}」使用浏览器存储：localStorage/sessionStorage 仅在当前隔离框内临时有效，IndexedDB 不可用`,
      ),
    );
  }

  const macros = replacement.match(/\{\{[^}]+\}\}/g);
  if (macros && macros.length > 0) {
    notes.push(
      workshopNote(
        'degraded',
        `「${name}」replacement 含 ${macros.length} 处 {{...}} 宏：已装上，但美化管线无宏替换环节，将原样输出`,
      ),
    );
  }
}

/**
 * 逐条记录 ST 侧仍可达、但本 renderer 无对应物的字段（D16）。
 *
 * 只在字段**真的改变当前有效路径**时记 note。`runOnEdit` 在没有消息编辑 UI 时不可达；
 * 非零 `substituteRegex` 在 findRegex 没有宏时也是惰性的，为它们刷屏会淹没真正缺口。
 */
function noteDroppedFields(name: string, entry: WorkshopSourceRegex, notes: WorkshopNote[]): void {
  const drop = (text: string): number => notes.push(workshopNote('dropped', text));

  // substituteRegex 只在 findRegex 本身含宏时改变行为。完整公共语料的三个非零值
  // 都没有 pattern 宏；为不可达分支报「丢弃」会误导用户。
  if (entry.substituteRegex !== 0 && /\{\{[^}]+\}\}/.test(entry.findRegex)) {
    drop(`「${name}」丢弃 substituteRegex=${entry.substituteRegex}：findRegex 宏替换尚未接线`);
  }
  if (entry.trimStrings.length > 0) {
    drop(`「${name}」丢弃 trimStrings（${entry.trimStrings.length} 项）：本引擎无裁剪串环节`);
  }
  // markdownOnly=false 意味着上游同时改写提示词侧，而美化库是纯显示层 ——
  // 显示侧装上了，提示词侧那一半是真丢了，故仍是 dropped
  if (!entry.markdownOnly) {
    drop(`「${name}」markdownOnly 为 false：提示词侧改写未导入，仅作用于显示层`);
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
 * | `placement` | 只接 AI output `2`；不含 2 的规则不进入 assistant renderer |
 * | `minDepth` / `maxDepth` | `minDepth` / `maxDepth`（零基、含边界） |
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
  const droppedNotes: WorkshopNote[] = [];
  const orderBase = ctx.orderBase ?? WORKSHOP_RULE_ORDER_BASE;
  const indexBase = ctx.indexBase ?? 0;

  entries.forEach((entry, localIndex) => {
    // 项目内的真实序号：单条调用时靠 indexBase 补回来，整批调用时 indexBase=0
    const index = indexBase + localIndex;
    const name = entry.scriptName.trim() || `未命名正则 ${index + 1}`;

    // ⚠️ return 分支都是**整条不产出规则** → 货真价实的 dropped。
    //    尤其 promptOnly：它长得像「装了但只在提示词侧生效」，实际是一条规则都没有。
    if (entry.promptOnly) {
      droppedNotes.push(
        workshopNote(
          'dropped',
          `「${name}」整条未导入（promptOnly）：美化库是显示层，无提示词侧改写通道`,
        ),
      );
      return;
    }

    const { pattern, flags } = parseFindRegex(entry.findRegex);
    if (!pattern) {
      droppedNotes.push(workshopNote('dropped', `「${name}」整条未导入：findRegex 为空`));
      return;
    }
    try {
      new RegExp(pattern, flags);
    } catch {
      droppedNotes.push(
        workshopNote(
          'dropped',
          `「${name}」整条未导入：正则编译失败（${entry.findRegex.slice(0, 40)}…）`,
        ),
      );
      return;
    }

    // 当前输出 renderer 只消费 AI output（ST placement=2）。不能把唯一的
    // user-only 规则错误地应用到任意 assistant 正文；[1,2] 仍保留其 output 一侧。
    if (!entry.placement.includes(2)) {
      droppedNotes.push(
        workshopNote(
          'dropped',
          `「${name}」整条未导入：placement=[${entry.placement.join(',')}] 不包含 AI 输出位置 2`,
        ),
      );
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
      minDepth: entry.minDepth ?? undefined,
      maxDepth: entry.maxDepth ?? undefined,
      autoEnable: { worldBookIds: [workshopBookId(ctx.projectId)] },
      group: `${WORKSHOP_RULE_GROUP_PREFIX}${ctx.projectName}`,
    });

    noteDroppedFields(name, entry, droppedNotes);
    noteKnownConsequences(name, entry.replaceString, droppedNotes);
  });

  return { rules, droppedNotes };
}
