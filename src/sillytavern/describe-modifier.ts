// src/sillytavern/describe-modifier.ts
/**
 * describe-modifier.ts —— Modifier（战斗修正）→ 人类可读中文摘要
 *
 * 纯函数模块：零 I/O、零 Vue、零 Dexie。前端 ItemsPanel 详情弹窗用它渲染
 * 「战斗修正」区，玩家一眼看懂装备带什么战斗效果，无需理解数据结构。
 *
 * 设计：docs/superpowers/specs/2026-08-02-item-detail-summary-design.md §3.1
 */

import type { Modifier } from './effect-types';

/** AttributeName（拉丁键）→ 中文 */
const ATTRIBUTE_CN: Record<string, string> = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  spi: '精神',
};

/** 检定类型 → 中文措辞（attribute 存在时覆盖 checkType） */
function checkLabel(m: Extract<Modifier, { category: '检定' }>): string {
  return m.attribute ? `${ATTRIBUTE_CN[m.attribute] ?? m.attribute}检定` : `${m.checkType}检定`;
}

/** 单个 modifier → 中文行；无法描述（amount=0 等）返回 ''（调用方过滤） */
export function describeModifier(m: Modifier): string {
  let body: string;
  switch (m.category) {
    case '固伤':
      // amount<=0 无意义，返回 '' 由 describeModifiers 过滤
      if (m.amount <= 0) return '';
      body = m.damageType ? `造成 ${m.amount} 点${m.damageType}伤害` : `造成 ${m.amount} 点伤害`;
      break;
    case '百分比': {
      const sign = m.coefficient >= 0 ? '+' : '';
      const label = m.target === 'damage' ? '伤害' : m.target === 'heal' ? '治疗' : '资源';
      body = `${label} ${sign}${Math.round(m.coefficient * 100)}%`;
      break;
    }
    case '资源': {
      const verb = m.amount >= 0 ? '回复' : '消耗';
      body = `${verb} ${Math.abs(m.amount)} 点${m.resource.toUpperCase()}`;
      break;
    }
    case '检定':
      body = `${checkLabel(m)} ${m.bonus >= 0 ? '+' : ''}${m.bonus}`;
      break;
    case '附加效果':
      body = `附加 ${m.buffName}${m.stacks && m.stacks > 1 ? ` ${m.stacks}层` : ''}`;
      break;
    case '特殊机制':
      body = specialMechanismText(m.mechanism, m.value);
      break;
  }

  if (m.condition) {
    const cond = translateCondition(m.condition);
    if (cond) body = `[${cond}] ${body}`;
  }
  if (m.source) body += `（来源：${m.source}）`;
  return body;
}

/** 特殊机制 → 中文（value 按机制解释） */
function specialMechanismText(mechanism: string, value: number): string {
  switch (mechanism) {
    case 'DR':
      return `减伤 ${value}%`;
    case '穿透':
      return `穿透 ${value}%`;
    case '暴击倍率':
      return `暴击倍率 ×${value}`;
    case '召唤':
      return `可召唤（${value}）`;
    case '光环':
      return `光环效果（${value}）`;
    case '规则改写':
      return `规则改写（${value}）`;
    default:
      return `特殊机制（${value}）`;
  }
}

/** EJS 风格条件 → 可读中文（只做常见形态，识别不了原样保留） */
function translateCondition(cond: string): string {
  const hp = cond.match(/\{\{target\.hpPercent\}\}\s*<\s*([\d.]+)/);
  if (hp) return `目标HP<${Math.round(parseFloat(hp[1]) * 100)}%`;
  const hpGt = cond.match(/\{\{target\.hpPercent\}\}\s*>\s*([\d.]+)/);
  if (hpGt) return `目标HP>${Math.round(parseFloat(hpGt[1]) * 100)}%`;
  return cond;
}

/** 批量翻译，过滤空行 */
export function describeModifiers(list: Modifier[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.map(describeModifier).filter((s) => s.length > 0);
}
