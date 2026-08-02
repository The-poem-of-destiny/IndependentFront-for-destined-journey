/**
 * item-effects.ts —— 效果词条归一化纯函数
 *
 * 真机 2026-08-02：item_gen 链落库的 `effects` 字段有三种形态，UI 层必须统一。
 * 独立成纯函数便于单测，ItemsPanel.vue 消费。
 */

/**
 * 效果词条归一化 —— 统一转成 `{ name → desc }` 对象供 `v-for` 逐条渲染。
 *
 * 三种输入形态：
 *   - 对象 `{ 能量伤害: "造成100%能量伤害", ... }`（类型定义期望的形态）→ 原样透传
 *   - 字符串 `"材料分析:进行任意生产制作时DC-4; 炼金加成:..."`（`名:描述` 分号分隔）
 *   - 数组 `["材料分析:...", "炼金加成:..."]`
 */
export function normalizeEffects(raw: unknown): Record<string, string> {
  if (!raw) return {};
  // 对象形态：已是「词条名→描述」，原样透传（值里的冒号是描述内容，不是分隔符，勿拆）
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
    }
    return out;
  }
  // 字符串 / 数组形态：`名:描述` 分号分隔 → 逐条拆解
  const list = Array.isArray(raw) ? raw : String(raw).split(/[;；]/);
  const out: Record<string, string> = {};
  for (const item of list) {
    const s = String(item).trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    else out[s] = '';
  }
  return out;
}
