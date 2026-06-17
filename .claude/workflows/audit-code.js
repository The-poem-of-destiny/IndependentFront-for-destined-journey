/**
 * 世界书对齐审计 — 审查代码与世界书 reference 的冲突
 *
 * 用法: /workflow audit-code -- 'src/sillytavern/combat-damage.ts'
 *       /workflow audit-code -- 'src/sillytavern/tier-constants.ts,src/sillytavern/dice.ts'
 *       /workflow audit-code  (默认审计最近修改的战斗/制作模块)
 *
 * 检查项:
 *   1. 数值常量是否与世界书一致
 *   2. 公式是否对齐
 *   3. 枚举/类型定义是否完整
 *   4. 命名体系是否统一
 *   5. 缺失功能标记
 */

export const meta = {
  name: 'audit-code',
  description: '审计代码与世界书 reference 的冲突（数值/公式/类型/命名）',
  phases: [
    { title: '读取', detail: '读取代码文件 + 世界书参考条目' },
    { title: '对比', detail: '逐项对比代码与世界书' },
    { title: '验证', detail: '对抗性验证冲突是否真实' },
    { title: '报告', detail: '生成冲突报告' },
  ],
}

// 审计目标文件
const TARGET = args || 'src/sillytavern/combat-damage.ts,src/sillytavern/combat-intention.ts,src/sillytavern/combat-resolver.ts,src/sillytavern/tier-constants.ts,src/sillytavern/types.ts'
const FILES = Array.isArray(TARGET) ? TARGET.join(',') : TARGET

phase('读取')

// 并行读取：代码文件 + 世界书索引 + 审计历史
const [codeContent, worldBookData, auditHistory] = await parallel([
  () => agent(
    `读取并分析以下文件的完整内容，提取所有可审计项：
    目标文件: ${FILES}

    对每个文件提取：
    1. 所有数值常量（如乘数、系数、阈值、上限等）
    2. 所有公式字符串或数学表达式
    3. 所有枚举值/联合类型成员
    4. 所有中英文命名（如品质名、种族名、状态名等）
    5. 接口/类型的字段列表

    返回结构化的审计清单。`,
    {
      label: '读取:代码',
      schema: {
        type: 'object',
        properties: {
          constants: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' }, expectedSource: { type: 'string' } } } },
          formulas: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, description: { type: 'string' }, expression: { type: 'string' } } } },
          enums: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, name: { type: 'string' }, values: { type: 'string' } } } },
          naming: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, category: { type: 'string' }, currentValue: { type: 'string' } } } },
          types: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, name: { type: 'string' }, fields: { type: 'string' } } } },
        },
      },
    }
  ),
  () => agent(
    `读取并分析世界书参考文件，提取所有与战斗/制作/数值相关的规则：
    1. 读取 reference/world_book_index.md — 找到相关的世界书条目 key
    2. 读取 reference/audit_report.md — 了解之前发现的冲突
    3. 重点关注以下世界书条目：
       - #837805 [战斗协议] — 战斗类型/意图/伤害公式/命中评级/先攻/面板
       - #417617 [核心数值表] — 层级系数/HP乘数/EXP上限/属性上限
       - #884517 [随机池] — d20骰池规则
       - #265160 [品质效果限定] — 品质数值表
       - #683615 [生产制作协议] — 制作DC/品质继承
       - #597443 [状态规则] — 状态分类/持续时间单位

    返回结构化的世界书规则清单。`,
    {
      label: '读取:世界书',
      schema: {
        type: 'object',
        properties: {
          combatRules: { type: 'array', items: { type: 'object', properties: { entry: { type: 'string' }, rule: { type: 'string' }, value: { type: 'string' } } } },
          numericTables: { type: 'array', items: { type: 'object', properties: { entry: { type: 'string' }, param: { type: 'string' }, worldBookValue: { type: 'string' } } } },
          namingStandards: { type: 'array', items: { type: 'object', properties: { category: { type: 'string' }, standardValue: { type: 'string' } } } },
        },
      },
    }
  ),
  () => agent(
    `读取 reference/audit_report.md 了解之前审计发现的所有冲突和修复状态。
    列出所有之前发现但可能仍然存在的未修复问题。`,
    {
      label: '读取:审计历史',
      schema: {
        type: 'object',
        properties: {
          previousConflicts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, description: { type: 'string' }, status: { type: 'string' }, severity: { type: 'string' } } } },
        },
      },
    }
  ),
])

phase('对比')

// 主审计：对比代码 vs 世界书
const conflicts = await agent(
  `你是世界书对齐审计专家。请逐项对比以下代码内容与世界书规则，找出所有冲突。

## 代码审计清单
${JSON.stringify(codeContent, null, 2)}

## 世界书规则
${JSON.stringify(worldBookData, null, 2)}

## 之前发现的冲突
${JSON.stringify(auditHistory, null, 2)}

## 审计规则
对每个可审计项检查：
1. **数值一致性**: 代码中的数值常量是否与世界书完全一致？
2. **公式对齐**: 公式的运算顺序、系数、变量是否与世界书一致？
3. **枚举完整性**: 枚举值是否与世界书列出的所有选项一致（不缺不增）？
4. **命名统一性**: 中英文命名与世界书是否一致？
5. **类型完整性**: 类型定义是否包含了世界书要求的全部字段？
6. **缺失功能**: 世界书中有但代码中完全缺失的规则/功能？

## 重点检查
- tier-constants.ts 的 TIER_CONFIGS 是否每项都与世界书 #417617 完全一致
- combat-damage.ts 的 8 步管线是否与世界书 #837805 的伤害公式完全一致
- types.ts 的 CombatType(6种)/IntentionLevel(8级)/HitRating(7级) 是否与世界书一致
- 品质命名: 普通/优良/稀有/史诗/传说/神话/唯一（7级）是否在某处有误
- 属性硬上限 = 20（仅 T7 可达）
- 好感度范围 = -100 ~ +100
- 纪元名 = 复兴纪元

对于每个冲突标注严重度：
- 🔴 CRITICAL: 数值不一致（会导致游戏结算错误）
- 🟡 MAJOR: 公式/规则偏差（会导致行为不符合世界书）
- 🟢 MINOR: 命名/注释/类型字段缺失

请**保守判断**——只报告你能确定是冲突的项。如果存在合理的代码解释，不要强行报告。`,
  {
    label: '对比审计',
    schema: {
      type: 'object',
      properties: {
        conflicts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'number' },
              category: { type: 'string', enum: ['数值不一致', '公式偏差', '枚举不完整', '命名不统一', '类型缺失', '功能缺失'] },
              severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
              codeValue: { type: 'string' },
              worldBookValue: { type: 'string' },
              worldBookEntry: { type: 'string' },
              description: { type: 'string' },
              suggestion: { type: 'string' },
            },
            required: ['file', 'severity', 'codeValue', 'worldBookValue', 'description'],
          },
        },
        summary: {
          type: 'object',
          properties: {
            totalChecked: { type: 'number' },
            totalConflicts: { type: 'number' },
            critical: { type: 'number' },
            major: { type: 'number' },
            minor: { type: 'number' },
          },
        },
      },
    },
  }
)

phase('验证')

// 对抗性验证
const verifiedConflicts = await pipeline(
  conflicts.conflicts || [],
  (c) => agent(
    `对抗性验证这个审计发现——请尝试证伪它。

发现:
- 文件: ${c.file}
- 严重度: ${c.severity}
- 代码值: ${c.codeValue}
- 世界书值: ${c.worldBookValue}
- 描述: ${c.description}

请重新阅读相关代码文件和世界书条目，判断：
1. 代码值是否确实与世界书不一致？
2. 是否有合理的理由（如设计决策 ADR）导致差异？
3. 如果代码值确实有误，确认该冲突。

注意: 审计报告之前可能已经记录了部分修复。如果代码中的值已经与世界书一致，这是误报。`,
    {
      label: `验证:${c.file}:${c.severity}`,
      schema: {
        type: 'object',
        properties: {
          isReal: { type: 'boolean' },
          reason: { type: 'string' },
          correctedSeverity: { type: 'string', enum: ['critical', 'major', 'minor'] },
        },
        required: ['isReal', 'reason'],
      },
    }
  ),
  (result, original) => result ? { ...original, verdict: result } : null
)

phase('报告')

const real = verifiedConflicts.filter(Boolean).filter(c => c.verdict?.isReal)
const dismissed = verifiedConflicts.filter(Boolean).filter(c => !c.verdict?.isReal)
const critical = real.filter(c => c.severity === 'critical' || c.verdict?.correctedSeverity === 'critical')
const major = real.filter(c => c.severity === 'major' || c.verdict?.correctedSeverity === 'major')
const minor = real.filter(c => c.severity === 'minor' || c.verdict?.correctedSeverity === 'minor')

log(`审计完成:
  审计项: ${conflicts.summary?.totalChecked || 'N/A'}
  🔴 Critical: ${critical.length}
  🟡 Major: ${major.length}
  🟢 Minor: ${minor.length}
  ❌ 误报（已排除）: ${dismissed.length}`)

if (real.length > 0) {
  log('\n=== 需要修复的冲突 ===')
  for (const c of real) {
    log(`${c.severity === 'critical' ? '🔴' : c.severity === 'major' ? '🟡' : '🟢'} [${c.file}] ${c.description}`)
    log(`   代码: ${c.codeValue} → 世界书: ${c.worldBookValue}`)
    if (c.suggestion) log(`   建议: ${c.suggestion}`)
  }
} else {
  log('\n✅ 未发现代码与世界书的冲突！')
}

return {
  files: FILES,
  conflicts: {
    confirmed: real,
    dismissed: dismissed.length,
    summary: {
      total: real.length,
      critical: critical.length,
      major: major.length,
      minor: minor.length,
    },
  },
  auditTimestamp: null, // stamp after workflow returns
}
