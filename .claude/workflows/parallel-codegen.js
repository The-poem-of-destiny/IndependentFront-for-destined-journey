/**
 * 并行代码生成 — 同时生成多个新模块
 *
 * 用法: /workflow parallel-codegen
 * 场景: Phase 2-7 中需要一次创建多个新文件时
 *
 * 这个 workflow 会：
 *  1. 对每个模块独立派发 agent 生成代码
 *  2. 各 agent 并行执行（最多 10 个同时跑）
 *  3. 写完代码后自动验证 TypeScript 编译
 */

export const meta = {
  name: 'parallel-codegen',
  description: '并行生成多个新模块（types/db/engine/UI），然后验证编译',
  phases: [
    { title: '设计', detail: '根据 findings.md 确定每个模块的接口' },
    { title: '生成', detail: '并行生成所有模块代码' },
    { title: '验证', detail: 'TypeScript 编译 + 接口一致性检查' },
  ],
}

// 模块清单（来自 Phase 2-7 的规划）
const MODULES = args?.modules || [
  // Phase 2: 数据结构
  { key: 'types-v4', path: 'src/sillytavern/types.ts', desc: '扩展所有 v4 新类型（CharacterState/AgentConfig/ApiEndpoint/Memory/PlotEvent/Snapshot）' },
  { key: 'database-v4', path: 'src/sillytavern/database.ts', desc: '新增表（memories/plot_events/characters/snapshots/saves/api_endpoints）+ 迁移 v3→v4' },

  // Phase 3: Agent 编排引擎
  { key: 'agent-orchestrator', path: 'src/sillytavern/agent-orchestrator.ts', desc: 'DAG 依赖调度器，串行/并行混合' },
  { key: 'agent-templates', path: 'src/sillytavern/agent-templates.ts', desc: '每 Agent 的 Prompt 模板系统' },
  { key: 'deepseek-client', path: 'src/sillytavern/deepseek-client.ts', desc: 'DeepSeek 特化 fetch 封装（独立 userId）' },

  // Phase 4: 记忆 & 剧情
  { key: 'memory-system', path: 'src/sillytavern/memory-system.ts', desc: '记忆召回/总结逻辑，MEM 编号系统' },
  { key: 'plot-engine', path: 'src/sillytavern/plot-engine.ts', desc: '嵌套事件结构，世界线变动修正' },

  // Phase 5: 角色 & 变量
  { key: 'character-manager', path: 'src/sillytavern/character-manager.ts', desc: '统一角色状态管理（登神长阶/要素/权能）' },
  { key: 'variable-patch', path: 'src/sillytavern/variable-patch.ts', desc: 'JSON Patch 操作（replace/delta/insert）' },

  // Phase 6: 战斗 & 制作
  { key: 'combat-resolver', path: 'src/sillytavern/combat-resolver.ts', desc: 'd20 战斗结算引擎' },
  { key: 'crafting-resolver', path: 'src/sillytavern/crafting-resolver.ts', desc: '制作品质检定引擎' },

  // 工具
  { key: 'snapshot-manager', path: 'src/sillytavern/snapshot-manager.ts', desc: '快照创建/回滚（10档×30快照）' },
  { key: 'ejs-renderer', path: 'src/sillytavern/ejs-renderer.ts', desc: 'EJS 模板静态化渲染器' },
  { key: 'violation-checker', path: 'src/sillytavern/violation-checker.ts', desc: 'AI 输出违规检测器' },
]

phase('生成')

// 并行生成所有模块
const results = await pipeline(
  args?.modules || MODULES,
  (mod) => agent(
    `实现 ${mod.path}：
    模块职责：${mod.desc}
    要求：
    - 遵循 CLAUDE.md 中的设计约定
    - 所有类型引用自 types.ts
    - 导出清晰的公共 API
    - 用 JSDoc 注释关键接口
    - 参考 findings.md 中的架构设计（特别是 Phase 1 修正版）
    - 已有代码在 src/sillytavern/ 下，不要破坏现有导出`,
    { phase: '生成', label: mod.key, isolation: 'worktree' }
  ),
  (result, mod) => {
    // 写入阶段完成后通知
    log(`${mod.key} → ${mod.path} 写入完成`)
    return result
  }
)

phase('验证')

// 验证编译
const typecheck = await agent(
  `检查并行生成的代码：
  1. 运行 npx tsc --noEmit 检查编译错误
  2. 检查所有新模块的导出是否与 index.ts 一致
  3. 检查是否有循环依赖
  4. 报告发现的任何问题`,
  { phase: '验证', label: 'typecheck' }
)

log(`生成结果：${results.filter(Boolean).length}/${MODULES.length} 模块成功`)
log(`验证报告：${typecheck}`)
