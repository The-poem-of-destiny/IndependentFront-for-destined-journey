/**
 * 多维度代码审查 — 从正确性/性能/安全/架构四个维度并行审查
 *
 * 用法: /workflow multi-dimension-review -- 'src/sillytavern/types.ts'
 * 场景: 任何文件修改后，提交前审查
 */

export const meta = {
  name: 'multi-dimension-review',
  description: '从正确性/性能/安全/架构四个维度并行审查代码',
  phases: [
    { title: '审查', detail: '四维度并行审查' },
    { title: '验证', detail: '对抗性验证每个发现' },
    { title: '报告', detail: '综合报告' },
  ],
}

// 四个审查维度，每维度不同侧重点
const DIMENSIONS = [
  {
    key: 'correctness',
    prompt: `审查代码的正确性（bugs）：
    - 类型错误、空值处理、边界条件
    - Promise/async 使用是否正确
    - Dexie 数据库操作是否 await
    - 参照 CLAUDE.md 的设计约定检查违规
    - 只报告你 90% 以上确信的问题`,
  },
  {
    key: 'performance',
    prompt: `审查性能问题：
    - IndexedDB 查询是否用了索引
    - 是否有不必要的循环嵌套
    - 大 JSON 文件的加载策略
    - 世界书扫描是否有优化空间
    - Agent 并行调用的并发上限`,
  },
  {
    key: 'architecture',
    prompt: `审查架构一致性：
    - 新类型是否都在 types.ts 中（而非散落各模块）
    - 是否遵循三层架构（DB → Engine → Store）
    - 是否有循环依赖风险
    - API 是否与 findings.md 的 ADR 一致
    - 扩展点是否预留（角色可插拔、Agent 可配置）`,
  },
  {
    key: 'compatibility',
    prompt: `审查兼容性：
    - SillyTavern 导入/导出格式是否不被破坏
    - 现有 index.ts 的导出是否保持
    - Vanilla Store 的 Observer 模式是否不变
    - v3 → v4 数据库迁移是否正确
    - 浏览器环境 API 使用是否正确（IndexedDB/fetch/DOM）`,
  },
]

// 待审查的文件（从 args 或默认审查所有 .ts）
const FILES = args || ['src/sillytavern/']
const TARGET = Array.isArray(FILES) ? FILES.join(' ') : FILES

phase('审查')

// 每个维度审查所有文件
const findings = await pipeline(
  DIMENSIONS,
  (dim) => agent(
    `${dim.prompt}\n\n审查目标：${TARGET}`,
    { label: `审查:${dim.key}`, schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'number' },
              severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
              description: { type: 'string' },
              suggestion: { type: 'string' },
            },
            required: ['file', 'severity', 'description'],
          },
        },
      },
    }}
  )
)

phase('验证')

// 对抗性验证：对每个 finding 派一个验证 agent
const allFindings = findings.filter(Boolean).flatMap(f => f.findings || [])
const verified = await pipeline(
  allFindings,
  (f) => agent(
    `对抗性验证这个发现——尝试证伪它：
    ${JSON.stringify(f)}
    如果这个发现不成立（误报），返回 { isReal: false, reason: "..." }
    如果确实成立，返回 { isReal: true, confirmed: true }`,
    {
      label: `验证:${f.file}:${f.line}`,
      schema: {
        type: 'object',
        properties: {
          isReal: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['isReal'],
      },
    }
  ),
  (result, original) => ({ ...original, verdict: result })
)

phase('报告')

const real = verified.filter(Boolean).filter(v => v.verdict?.isReal)
const critical = real.filter(v => v.severity === 'critical')
const major = real.filter(v => v.severity === 'major')
const minor = real.filter(v => v.severity === 'minor')

log(`审查结果：
  🔴 Critical: ${critical.length}
  🟡 Major: ${major.length}
  🟢 Minor: ${minor.length}
  误报（已排除）: ${allFindings.length - real.length}`)

return {
  confirmed: real,
  summary: { critical: critical.length, major: major.length, minor: minor.length },
  dismissed: allFindings.length - real.length,
}
