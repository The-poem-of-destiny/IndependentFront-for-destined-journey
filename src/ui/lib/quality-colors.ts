/** 品质中文名 → CSS 自定义属性名 */
const QUALITY_TO_VAR: Record<string, string> = {
  '普通': '--theme-quality-common',
  '优良': '--theme-quality-uncommon',
  '稀有': '--theme-quality-rare',
  '史诗': '--theme-quality-epic',
  '传说': '--theme-quality-legendary',
  '神话': '--theme-quality-mythic',
  '唯一': '--theme-quality-unique',
}

/** 返回 CSS var() 引用字符串，用于内联 style 绑定 */
export function qualityVar(quality: string): string {
  const varName = QUALITY_TO_VAR[quality]
  if (!varName) return '#9ca3af'
  return `var(${varName})`
}

/** 返回原始 CSS 变量名（不带 var() 包裹），用于动态 class 生成 */
export function qualityVarName(quality: string): string {
  return QUALITY_TO_VAR[quality] ?? '--theme-quality-common'
}
