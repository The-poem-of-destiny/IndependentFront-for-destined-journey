/**
 * 批量迁移/重构 — 跨多个文件做一致性的重命名/接口变更
 *
 * 用法: /workflow batch-migrate
 * 场景: 当 types.ts 中改了接口名，需要在所有引用处同步更新
 *
 * @param args { pattern: string, replacement: string } 或 { task: string }
 */

export const meta = {
  name: 'batch-migrate',
  description: '跨文件批量重构——一致的接口重命名/签名变更/导入路径更新',
  phases: [
    { title: '发现', detail: '搜索所有需要变更的文件' },
    { title: '迁移', detail: '并行修改每个文件' },
    { title: '验证', detail: '编译检查 + 一致性验证' },
  ],
}

const task = args?.task || '检查 types.ts 的所有接口变更并迁移引用'

phase('发现')

// 先找出所有受影响的位置
const impact = await agent(
  `分析变更影响范围：
  任务：${task}
  项目目录：${args?.scope || 'src/'}

  返回：
  - affected_files: 需要修改的文件列表
  - for each file: 具体要改什么（旧→新）`,
  {
    label: 'impact-analysis',
    schema: {
      type: 'object',
      properties: {
        affectedFiles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              changes: { type: 'string' },
              risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['file', 'changes'],
          },
        },
        totalFiles: { type: 'number' },
      },
    },
  }
)

if (!impact || impact.affectedFiles.length === 0) {
  log('没有发现需要迁移的文件')
  return { migrated: 0 }
}

log(`发现 ${impact.totalFiles} 个文件需要变更`)

phase('迁移')

// 并行迁移，高风险文件用 worktree 隔离
const migrated = await pipeline(
  impact.affectedFiles,
  (f) => agent(
    `修改 ${f.file}：
    ${f.changes}
    注意：
    - 只做指定的变更，不要改其他内容
    - 保持代码风格与周围一致
    - 不要引入新的类型错误`,
    {
      label: `迁移:${f.file}`,
      isolation: f.risk === 'high' ? 'worktree' : undefined,
    }
  ),
  (result, original) => {
    log(`${original.file} 变更完成 (风险: ${original.risk})`)
    return { file: original.file, success: !!result }
  }
)

phase('验证')

// 验证编译
const verify = await agent(
  `运行 npx tsc --noEmit 验证迁移结果。
  如果有错误：
  1. 列出每个错误的文件和行号
  2. 判断是否由本次迁移引起
  3. 对迁移引起的错误提出修复建议`,
  { label: 'verify-compile' }
)

const successCount = migrated.filter(Boolean).filter(m => m.success).length
log(`迁移完成：${successCount}/${impact.totalFiles} 文件成功`)
log(`编译验证：${verify}`)

return {
  migrated: successCount,
  total: impact.totalFiles,
  verify,
}
