/**
 * agent-xml.ts — AI 输出 XML 解析的**唯一**工具面（Q-05，T2 AI 边界）
 *
 * ## 为什么要有这个文件
 *
 * 「AI 文本 → 引擎状态」这条缝此前被抄成四类互不通气的拷贝，最危险的一处是
 * **两个同名 `extractTag` 语义完全相反**：
 *
 * ```ts
 * // char-gen-agent.ts:  extractTag(xml, tag) → match[1].trim()   ← 标签内文本
 * // craft-gen-chain.ts: extractTag(tag, text) → match[0]          ← 含标签整块
 * ```
 *
 * 两边签名都是 `(string, string)`，把定义连同调用一起复制过去**编译照过**，
 * 运行时把整块 XML 当字段值写进角色档案。
 *
 * ## 本模块的约定（照抄前先读）
 *
 * 1. **参数顺序一律 `(source, tag)`** —— 源在前，永远。
 * 2. **名字自带语义**：`tagInner` 取内文（trim），`tagBlock` 取含标签整块。
 *    不再有叫 `extractTag` 的东西。
 * 3. **容错取各拷贝的并集**：标签名过 `escapeRegex`；属性单双引号都吃、
 *    容忍等号旁空格；标签可带任意属性。
 *
 * 新增解析函数请加在这里，不要在 agent 链里再长第二份。
 */

/** 正则元字符转义 —— 标签名可能来自数据（marker 表、AI 输出） */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 取标签**内文**（不含标签本身），trim 后返回；没匹配到返回 null。
 *
 * 标签可带任意属性：`<item name="x">内容</item>` → `'内容'`。
 */
export function tagInner(source: string, tag: string): string | null {
  const t = escapeRegex(tag);
  const m = source.match(new RegExp(`<${t}[^>]*?>([\\s\\S]*?)<\\/${t}>`, 'i'));
  return m ? m[1].trim() : null;
}

/**
 * 取**含标签的整块**（`<tag …>…</tag>`）；没匹配到返回 null。
 *
 * 与 `tagInner` 的区别只在「要不要标签本身」——这也是历史上两个 `extractTag`
 * 打架的地方，所以这里用两个不会认错的名字。
 */
export function tagBlock(source: string, tag: string): string | null {
  const t = escapeRegex(tag);
  const m = source.match(new RegExp(`<${t}[^>]*?>[\\s\\S]*?<\\/${t}>`, 'i'));
  return m ? m[0] : null;
}

/**
 * 取某标签上某个属性的值；单双引号都吃，容忍等号旁空格。
 *
 * `<char name = '艾琳'>` 与 `<char name="艾琳">` 都能取到。
 */
export function tagAttr(source: string, tag: string, attr: string): string | null {
  const t = escapeRegex(tag);
  const a = escapeRegex(attr);
  const dq = source.match(new RegExp(`<${t}[^>]*?${a}\\s*=\\s*"([^"]*)"`, 'i'));
  if (dq) return dq[1];
  const sq = source.match(new RegExp(`<${t}[^>]*?${a}\\s*=\\s*'([^']*)'`, 'i'));
  return sq ? sq[1] : null;
}

/**
 * 解析属性串 `key="val" key2='val2'` → Record。
 *
 * 取的是两份拷贝的并集：单双引号都吃 + 容忍 `key = "val"` 的空格
 * （craft 侧那份只有 `/(\w+)="([^"]*)"/g`，遇到单引号属性会整条丢掉）。
 */
export function parseAttrsStr(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([\w-]+)\s*=\s*"([^"]*)"|([\w-]+)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(attrStr)) !== null) {
    if (m[1] !== undefined) attrs[m[1]] = m[2];
    else if (m[3] !== undefined) attrs[m[3]] = m[4];
  }
  return attrs;
}

/**
 * 剥离字段值内 AI 自作主张的嵌套 XML 标签（真机修 2026-07-17）。
 *
 * 如 `<appearance>` 内嵌 `<physical>`/`<voice>`/`<presence>`、
 * `<personality>` 内嵌 `<code>`/`<description>`。
 * 成对标签 → 保留内容（换行拼接）；孤立/残缺标签 → 删除。最多展开 3 层嵌套。
 */
export function stripInnerTags(s: string): string {
  if (!s || !/<[a-z_]/i.test(s)) return s;
  let out = s;
  for (let i = 0; i < 3 && /<([a-z_][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/i.test(out); i++) {
    out = out.replace(
      /<([a-z_][\w-]*)\b[^>]*>([\s\S]*?)<\/\1>/gi,
      (_m, _t, inner) => `${String(inner).trim()}\n`,
    );
  }
  out = out.replace(/<\/?[a-z_][\w-]*[^>]*>/gi, ''); // 残留孤立标签清除
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 取属性并转 int —— 缺失/非法用缺省值，但**显式的 0 保留**。
 *
 * 真机修：意识体角色的某些属性合法为 0，不能被 `|| dflt` 吞掉。
 */
export function tagAttrInt(source: string, tag: string, attr: string, dflt: number): number {
  const v = parseInt(tagAttr(source, tag, attr) ?? '', 10);
  return Number.isNaN(v) ? dflt : v;
}

/**
 * 解析一个块内的**具名子元素**：`<effect name="灼烧">描述</effect>` → `{ 灼烧: '描述' }`。
 *
 * 用**宽松**正则（`name` 不必是第一个属性）。此前五个元素解析器各写一份，其中三份
 * 用的是严格版（要求 `name` 紧跟标签名），于是同一条 AI 输出
 * `<effect type="buff" name="灼烧">` 写在装备里能收到、写在技能里被静默丢掉。
 */
export function parseNamedChildren(
  inner: string,
  childTag: 'effect' | 'script',
): Record<string, string> {
  const t = escapeRegex(childTag);
  const out: Record<string, string> = {};
  const re = new RegExp(`<${t}\\s[^>]*?name="([^"]*)"[^>]*>([\\s\\S]*?)<\\/${t}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    out[m[1]] = m[2]?.trim() ?? '';
  }
  return out;
}

/**
 * 从块内剥掉已知的子块，剩下的当作纯文本描述。
 *
 * 此前是三处逐字重复的四连 `replace` 链（char-gen-agent 的
 * skills/equipment/inventory 解析各抄一遍）。
 */
export function stripKnownChildBlocks(inner: string): string {
  return inner
    .replace(/<(effect|script)\s[^>]*>[\s\S]*?<\/(effect|script)>/gi, '')
    .replace(/<modifiers\b[^>]*>[\s\S]*?<\/modifiers>/gi, '')
    .replace(/<modifiers\b[^>]*\/>/gi, '')
    .replace(/<automaton\b[^>]*>[\s\S]*?<\/automaton>/gi, '')
    .replace(/<automaton\b[^>]*\/>/gi, '');
}
