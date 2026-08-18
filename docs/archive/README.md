# docs/archive/ — 历史文档归档区

这里放**价值已经交付完毕、但删掉可惜**的文档。归档件只作**历史脉络参考**，
任何结构性判断都不以这里的内容为准 —— 现行约定在根 `AGENTS.md`、两份分册
（`src/sillytavern/AGENTS.md` / `src/ui/AGENTS.md`）与 `docs/reference/`。

## 什么会落到这里

- **实施计划 / 编排 plan**（波次拆分、逐任务 brief）—— 代码合入后计划本身就没有读者了
- **RFC / proposal / handoff** —— 裁定已经写进设计文档或 ADR，原件只剩「当时怎么想的」
- **被新版取代的旧文档** —— 例如 `ARCHITECTURE-2026-06.md`（已被 2026-08-18 重写版取代）
- **一次性会话追踪**（`task_plan.md` / `findings.md` / `progress.md`）与走查证据存档（`design-qa.md`）

## 什么不落到这里

- **`docs/reviews/`** —— 审查存档有自己的家，带修复状态闭环表，仍是活文档，**不要往这里搬**
- **仍在推进的设计文档** —— 留在 `docs/planning/` 原位；只有等它描述的东西彻底交付、
  且内容已被现行文档吸收，才谈得上归档
- **契约真源类文档** —— 内容包格式、字段规范、创作者规范等，无论多老都留在原位

## 路径约定：按原路径镜像

归档**不重排目录**，原路径原样搬进 `archive/`：

```
docs/planning/X.md           →  docs/archive/planning/X.md
docs/reference/X.md          →  docs/archive/reference/X.md
docs/phases/phase7e/X.md     →  docs/archive/phases/phase7e/X.md
docs/superpowers/plans/X.md  →  docs/archive/superpowers/plans/X.md
```

这样「这份东西原来住哪」不需要额外索引就能读出来，回滚也只是把路径前缀去掉。

## 首批归档（2026-08-18）

首轮全量文档普查后一次性搬入 **62 份**（不含本 README），覆盖
`planning/`（战斗 v2/v3、音频、工坊、内容分离、地图、ComfyUI 等各期实施计划与 RFC）、
`superpowers/plans|specs/`（M1-M6 迁移批次与早期 chat-flow 设计）、
`phases/`（phase4、phase7 UI 总规格、phase7e 游戏页设计）、
`reference/`（v2 时代的 `combat-agent-api.md`、`status_page_architecture.md`、`agent_tools_reference.md`）。

同批还有三份含 IP 的剧情/压测文档**移入私有内容仓** `fated_poem_independent_assets/docs/planning/`，
公开仓侧不留副本，也不在本目录。

## 🔴 引用口径

本次归档已用机械改写把**仓内**所有 `.md` 里的路径字符串更新到新位置。
但**仓外或历史引用**（旧 PR 描述、已合入的提交信息、聊天记录、外部链接）仍会写老路径 ——
读到 `docs/planning/2026-07-3x-xxx-plan.md` 这类指不到的路径时，先来 `docs/archive/` 同名位置找一遍。
