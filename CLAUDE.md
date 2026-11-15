# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在此仓库中工作时提供指导。

> **指令正文在 `AGENTS.md`**（工具中立，所有 AI 编码工具共用）。本文件是薄壳，只承载 Claude Code 专属内容：skills/workflows 用法（猫娘人格已上移至 `AGENTS.md` 文首 `## 人格遵循`，2026-08-13）。下方的 `@AGENTS.md` 会把正文（项目概览/约定/必读清单/命令/进度）原样导入进来。
>
> **两份架构地图已拆成分册**，各自放在它描述的代码目录里，只在改那里的代码时才加载：
> [`src/core/AGENTS.md`](src/core/AGENTS.md)（引擎层）与 [`src/ui/AGENTS.md`](src/ui/AGENTS.md)（前端层）。
> 两处同目录都有 `CLAUDE.md` 薄壳自动导入，Claude Code 无需手动读取；只读根 `AGENTS.md` 的工具必须手动读分册。
>
> **改架构/约定只改 `AGENTS.md`（含分册）一处**，不要在两个文件里重复。

## 人格遵循

> 猫娘人格的唯一真源在 `AGENTS.md` 文首 `## 人格遵循`（2026-08-13 上移），此处不再重复保存，避免两处漂移。Claude Code 会话经 `@AGENTS.md` import 自动带上。

@AGENTS.md

## Claude Code 专属

以下 Skills / Workflows 是 Claude Code 的 Skill 机制，Codex 等其他工具不适用。

### Workflows

```bash
# 代码 vs 世界书对齐审计（Phase 完成前建议运行）
# 用法: 直接说 "运行 audit-code" 或 "/workflow audit-code"
# 审计指定文件: "用 audit-code 审计 combat-damage.ts"
# 审计多个文件: "用 audit-code 审计 tier-constants.ts,types.ts"

# 多维度代码审查
# 用法: "/workflow multi-dimension-review -- 'src/core/types/types.ts'"

# 并行代码生成
# 用法: "/workflow parallel-codegen"
```

### 与用户本地配置冲突时先问

本仓库 `.claude/agents/`（如 `code-writer`）与 `.claude/workflows/` 下的定义，是为特定协作者的 Claude Code 环境编写的，未必适用于当前用户的模型与环境。

如果当前用户在本机（`~/.claude/agents/`、`~/.claude/CLAUDE.md`、用户级 skills / workflows 等）定义了职责相近的 agent、workflow 或角色 / 模型分工规则（例如同为「写代码」的实现类 agent、同类的代码审查流程）：

- **不要自行决定用哪一套**。派发前先明确询问用户：本次遵循仓库内定义，还是其本地定义。
- 用户的答复在本次会话内持续有效，除非用户另行说明。
- 用户本地没有同类定义时，按仓库内定义正常使用，无需询问。
- 不要为了消除冲突而修改或删除仓库内的这些定义，它们归其编写者维护。

### 仓库治理规范

完整的仓库治理与协作规范（分支策略/CI/代码规范/资产策略/PR 流程/Agent 协作）见 `docs/planning/2026-07-31-repo-management.md`。
