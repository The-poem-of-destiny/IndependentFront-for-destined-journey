# 仓库治理与协作规范 v1.0

> 起草: 2026-07-30 ｜ 定稿: 2026-07-31 ｜ 状态: ✅ **已定稿，落地中**
> 取代: `2026-07-30-repo-management-draft.md`（草案 v0.1，定稿后删除）
>
> 目标: 让多人 + 多 Agent（Claude Code / Codex / 其他）并行开发时高效、低冲突、质量有地板。
>
> 标记约定: `[✅已定]` = 决策已拍板不可再议；`[📦已落地]` = 已在仓库执行；`[⬜待落地]` = 待执行。

---

## 0. 现状诊断（2026-07-31 复核）

| #   | 问题                                                                               | 影响                                     | 严重度 | 当前状态                          |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------- | ------ | --------------------------------- |
| 1   | `CLAUDE.md` 与 `AGENTS.md` 双源分叉（AGENTS.md 停在素材/战斗 v2 之前，落后一大截） | 不同工具的 agent 看到不同的仓库真相      | 🔴     | 仍在，§1 解决                     |
| 2   | `CLAUDE.md` 进度表膨胀成变更日志（单格数千字，全文 805 行）                        | 每会话 token 浪费 + 多人合并冲突头号来源 | 🔴     | 仍在，§3 解决                     |
| 3   | CI 缺 `vue-tsc`（.vue SFC 检查无兜底）+ 无分支保护                                 | 质量地板有洞                             | 🔴     | `ci.yml` 已建但缺 vue-tsc，§4 补  |
| 4   | 无 lint/format 工具                                                                | 多 agent 风格漂移，diff 噪音累积         | 🟡     | §5 解决                           |
| 5   | 过程产物入库                                                                       | clone 变慢，仓库不可逆膨胀               | 🟡     | ✅ artifacts/ 已出库（`56f3ac4`） |
| 6   | 分支策略随缘 + 遗留分支 5 条未清                                                   | 多人并行互相踩脚                         | 🟡     | §2 解决                           |
| 7   | `package.json` license=`ISC` 与文档 MIT 矛盾（description 乱码已修）               | 元数据无守卫                             | 🟢     | license 待修，§5.4                |

---

## 1. 指令文件：单一真源 `[✅已定]`

**规则：`AGENTS.md` 是唯一正文，`CLAUDE.md` 是薄壳。**

### 1.1 为什么正文必须落 AGENTS.md

两个文件都得存在（工具硬约束：Claude Code 只认 `CLAUDE.md`，Codex/Cursor/Windsurf 只认 `AGENTS.md`），但「都存在」≠「两份正文都存在」。

`@path` import 是**单向**语法：

| 工具                      | 读哪个文件  | 支持 `@xxx` import？      |
| ------------------------- | ----------- | ------------------------- |
| Claude Code               | `CLAUDE.md` | ✅ 认                     |
| Codex / Cursor / Windsurf | `AGENTS.md` | ❌ 不认（当普通文本忽略） |

→ Codex 读 AGENTS.md 时不会执行 import，所以 **AGENTS.md 必须自含完整正文**（它写 `@CLAUDE.md` 对 Codex 无效，正文会丢）；而 CLAUDE.md 可以靠 `@AGENTS.md` 把正文拉进来。

**结果：正文物理上只存 AGENTS.md 一份。** Codex 直接读全文；Claude Code 通过 CLAUDE.md 的 import 拿到同一份。改架构只改一处——**分叉从结构上不再可能**。

### 1.2 目标结构

```
AGENTS.md    ← 正文唯一真源（工具中立）：项目概览/文档导航/架构图/设计约定/必读清单/常用命令/Phase 速览
               开头不再写"为 Codex 提供"，改成工具中立的说明（"为所有 AI 编码工具提供"）
CLAUDE.md    ← 薄壳，只留三样：
               ① 猫娘人格（Claude Code 专属）
               ② Claude Code 专属内容（skills/workflows 用法、/workflow 命令）
               ③ 一行  @AGENTS.md
```

### 1.3 内容归属铁律

| 内容                                          | 放哪          | 理由                                  |
| --------------------------------------------- | ------------- | ------------------------------------- |
| 项目概览/架构图/设计约定/必读清单/常用命令    | **AGENTS.md** | 所有 agent 都需要，工具中立           |
| Bug 反馈规范/世界观/数据字段/UI 设计规范      | **AGENTS.md** | 同上，Codex 也该遵守                  |
| 猫娘人格段（"本喵瞄"）                        | **CLAUDE.md** | Claude Code 专属，污染 Codex 无意义   |
| skills/workflows（`/workflow audit-code` 等） | **CLAUDE.md** | Claude Code 的 Skill 机制，Codex 没有 |
| `@AGENTS.md` import                           | **CLAUDE.md** | 单向语法，只 Claude Code 认           |

**铁律：AGENTS.md 里绝不写「Claude Code 怎么样」「Codex 怎么样」** —— 它是共享正文，必须工具中立。

### 1.4 瘦身红线

AGENTS.md 目标 **≤ 500 行**。超过就把细节下沉到 `docs/reference/` 并只留一行指路（现有"XX 必读 → 路径"模式已经是对的）。**指令文件只写规则，不写历史**——"什么时候做了什么"一律进 CHANGELOG（§3）。

---

## 2. 分支与合并 `[✅已定]`

**模型：trunk-based + 短命分支 + PR 必经 + squash merge。**

- `master` 开启分支保护：禁止直推，必须走 PR，必须过 CI 必需检查（§4）。**允许管理员绕过**（solo 热修场景刚需；多 agent 并行靠 worktree 隔离不靠禁推）。→ 主人在 GitHub Settings 手动配置。
- **🟢 例外：纯文档改动（只动 `.md`）可以直推 master，免 PR**（2026-08-04 追加）。
  - 理由：设计文档、说明书、规范这类改动没有可执行面，PR 的价值主要是 CI 与 review，而 CI 对 `.md` 只有一项 `format:check`——本地跑一遍 Prettier 就等价了。为一句错别字开 PR 是纯摩擦。
  - **🔴 前置条件：推之前必须 `npx prettier --write` 过每一个改动的 `.md`**，否则 CI 会在 master 上挂红。操作细则（只格式化改过的文件 / 写完再格式化 / 用 `git diff --numstat` 剔掉纯行尾抖动）见 `AGENTS.md` 的「提交前文档检查」一节。
  - 边界：一旦同一个提交里**碰了任何非 `.md` 文件**，就退回 PR 流程。混合提交没有"文档部分"这回事。
  - 推完仍要检查 CI —— 直推不等于免检。
- 分支命名：`feat/<topic>` `fix/<topic>` `docs/<topic>` `refactor/<topic>`；agent 自动创建的分支保留其前缀（如 `claude/<topic>`）。
- 分支生命周期 **≤ 3 天**。大功能拆成可独立合并的小 PR（M1-M6 批次模式是范本）。
- **合并后立刻删分支**（GitHub 开 auto-delete head branches）。
- 合并方式：**squash merge 为默认** —— agent 产出的 WIP 提交链不值得进 master 历史；一个 PR = master 上一个语义完整的提交。

### 遗留分支清理 `[⬜待落地]`

现存 5 条逐一确认后删除（本喵执行删除前需主人确认每条都没在用）：
`audio-system` / `feat/scenepanel-three-section` / `feature/phase7-background-refactor` / `ui-test` / `pr-7`

### 多 agent 并行防踩脚

- 每个并行任务开独立分支 + 独立 worktree（`.claude/worktrees/` 机制已在用）。
- 派工按**模块边界**切分：两个 agent 不同时改同一文件。高危共享文件（§6）改动需在任务描述里显式声明。

---

## 3. 变更记录：把历史从指令文件搬出去 `[✅已定]`

- 新建 `docs/CHANGELOG.md`（**单文件**，不按月分）。`CLAUDE.md` 现有进度表迁过去，指令文件只留一张 ≤30 行的「Phase → 状态」速览表。
- **迁移范围**：只搬「进行中 + 近期交付」的 Phase（素材 / 战斗 v2 / 真机迭代 / 10i-10k / 音频 / BFF 等）；已完成且稳定的旧 Phase（1-9 大部分）在速览表标 ✅ 即可，细节由 `docs/phases/` + git log 承载，CHANGELOG 不当全量归档。
- 格式：**append-only、按日期倒序**——追加式天然免冲突。
- 每个 PR 的详细记录写进 CHANGELOG。`docs/planning/` 继续放会话级计划文档（现有惯例）。

---

## 4. CI：质量地板 `[📦ci.yml 已建，⬜待补 vue-tsc]`

现有 `.github/workflows/ci.yml`（`56f3ac4`）已跑 `typecheck` + `test:run`，**补上 `.vue` SFC 检查缺口**：

```yaml
jobs:
  test:
    steps:
      - run: npm ci
      - run: npm run typecheck # tsc --noEmit
      - run: npx vue-tsc --noEmit # ← 补这条：覆盖 .vue SFC
      - run: npm run test:run # vitest --run
```

- 三个检查全部设为 master 的 **required checks**（主人在 GitHub 手动配置）。
- **vue-tsc 存量错误一次性清零**（不用 continue-on-error）：CLAUDE.md 自己记了「SettingsPage.vue 独占 18/32 条错误」，集中可清；观察模式会永久卡住。
- 已知 flaky 测试要么修掉，要么显式标记，**不允许"重跑就绿"文化**。
- 后续可加：`npm run build` 冒烟、bundle 体积报警。

---

## 5. 代码规范与工具链 `[✅已定]`

### 5.1 格式化 + Lint：ESLint + Prettier

- 选 **ESLint + Prettier**（不选 Biome）：本仓大量 `.vue` SFC，`@vue/eslint-config-typescript` + `eslint-plugin-vue` 对 `<template>`/`<script setup>` 支持完整且和 vue-tsc 配合稳；Biome 对 Vue 模板格式化仍偏弱。
- 规则基线：推荐配置 + 少量项目定制；**风格问题一律交给工具，人和 agent 都不在 review 里争风格**。
- 落地：先 `format` 全仓库一次性提交（单独 PR，方便 git blame 跳过），再进 CI。

### 5.2 编码与行尾守卫

- 新建 `.editorconfig`：`charset = utf-8`，`end_of_line = lf`（`*.bat` 除外，已由 .gitattributes 管）。
- **中文源文件禁止用 PowerShell 重定向写入**（UTF-8 会被搞坏）；写文件用编辑器/Write 工具。

### 5.3 既有设计约定（从 CLAUDE.md 继承，继续有效）

- `types.ts` 唯一类型来源，大类型拆 `types-*.ts`
- StateManager 唯一状态写入入口 (ADR-21)
- Prompt vs Code 边界 (ADR-11)：确定性归 Code，创造性归 Prompt
- 每个新模块必须配套 `*.test.ts`（Vitest + fake-indexeddb）
- 逻辑键=名字，AI 永不产 id（数据字典规范五铁律）
- `$ API` 语义级抽象 (ADR-19) / 声明式优先 (ADR-20) / 世界书实现理念 (ADR-28) / 效果系统统一框架 (ADR-29)

### 5.4 提交规范 + 元数据修复

- Conventional commits 正式化：`feat|fix|docs|refactor|test|chore(scope): 中文描述`。
- `package.json` `license` 字段改为 `MIT`（package.json 描述的是**代码**部分，内容独立授权协议不归它管，在 AGENTS.md「内容许可」单列说明）。

---

## 6. 冲突热点治理 `[⬜待落地]`

多人 + 多 agent 并行时，可预期的合并冲突磁铁及对策：

| 热点文件                   | 对策                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `AGENTS.md` / `CLAUDE.md`  | §1 真源化 + §3 历史迁出，指令文件低频改动                                |
| `src/sillytavern/types.ts` | 新增大类型强制走 `types-*.ts` 分册；同 PR 内只 append 不重排             |
| `agent-config.json`        | 🔶 **本轮不拆**（见决策点⑧），中期再评估拆为 `agent-config/<agent>.json` |
| `docs/CHANGELOG.md`        | append-only 按日期，新条目永远加在自己日期段                             |
| `package-lock.json`        | 依赖变更单独 PR，不与功能混提                                            |

- 新建 `.github/CODEOWNERS`：给热点文件挂 owner，PR 触碰时自动请求 review。

---

## 7. 二进制资产 `[📦artifacts 已出库]`

- ✅ **过程产物不入库**：`artifacts/` 已加入 `.gitignore` 且 git 不追踪（`56f3ac4`，目录已删）。需要留档的评审结论以 markdown 摘要形式进 `docs/`。
- **交付资产走体积红线（不引 LFS）**：`src/ui/assets/themes/**/*.png` 等大图，单文件 **≤ 500KB** 红线，压缩后入库。理由：用户素材已走 IndexedDB Blob 不进 git，git 里只剩主题装饰 PNG，体量有限；LFS 配额 + 跨 fork/clone 麻烦，ROI 低。
- 音频维持现状：mp3 不入库（.gitignore 已有规则），manifest + README tracked。
- 历史瘦身（267MB mp3 已在历史中）：**刻意不做** history rewrite，除非 clone 速度成为实际痛点——与既有决定一致。

---

## 8. PR 流程与模板 `[⬜待落地]`

新建 `.github/pull_request_template.md`，把"提交前文档检查"变成强制勾选：

```markdown
## 变更说明

<!-- 做了什么、为什么 -->

## 检查清单

- [ ] `npm run typecheck` + `npm run test:run` 本地通过
- [ ] 文档同步检查：AGENTS.md / docs/ / reference/agent流程测试/ / tests/agent-framework/README.md
- [ ] 涉及游戏数值/世界观 → 已查 `reference/world_book_index.md`
- [ ] 涉及数据实体字段 → 已查数据字典规范
- [ ] 涉及 UI → 已查 `docs/design.md`
- [ ] 新模块已配套 `*.test.ts`
- [ ] changelog 已追加条目
- [ ] （agent 产出的 PR）标注了使用的 agent/工具与人工复核人
```

**Agent 产出 PR 的额外规则：**

- PR 描述必须写明：哪个工具/agent 产出、人工是否逐行复核、验证方式（测试/真机/仅编译）。
- 未经人工真机验证的功能 PR，标题或 label 标注「待真机验证」（现有惯例正式化）。

---

## 9. Agent 协作专项

- **共享 agent 记忆**：`.claude/agent-memory/` 继续入库共享。一坑一文件、kebab-case、MEMORY.md 做索引——现状已如此，写进规范防走样。
- **Codex 侧对等**：`.codex/skills/` 与 `.claude/` 能力尽量对齐；新增 skill 时考虑是否两边都要。
- **派工粒度**：给 agent 的任务描述必须包含——目标文件清单、不许碰的文件、必读文档（按 AGENTS.md 必读矩阵）、验收标准（哪些测试要绿）。
- **世界观内容生成**：分派给任何 agent 的叙事类任务，prompt 必须引用 `reference/narrative_context_example.md`。
- **Debug 循环**：真机 bug 修复遵循 `docs/reference/debug-loop-handbook.md`，一次一 bug。

---

## 10. 落地顺序（四批，每批一个 PR）

| 批次  | 内容                                                                                                                              | 风险                     | 状态      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------- |
| **A** | AGENTS.md 真源化（搬正文/去重/工具中立化）+ CLAUDE.md 瘦身（人格+skills+`@AGENTS.md`）+ 进度表迁 `docs/CHANGELOG.md` + 删旧 draft | 低（纯文档）             | ⬜ 进行中 |
| **B** | CI 补 `vue-tsc` + vue-tsc 存量错误清零 + PR 模板 + CODEOWNERS + 分支保护（主人手动）+ 遗留分支清理                                | 低-中                    | ⬜        |
| **C** | `.editorconfig` + ESLint/Prettier 引入 + 全仓一次性 format（单独提交）+ `package.json` license=MIT                                | 中（大 diff，需单独 PR） | ⬜        |
| **D** | 资产体积红线落地（扫描现有大图 + 压缩）                                                                                           | 低                       | ⬜        |

**主人手动操作汇总（本喵改不了）：**

1. GitHub Settings → Branches：master 分支保护（禁推 + required checks = typecheck/test:run/vue-tsc）+ 允许管理员绕过
2. GitHub Settings → 勾选 auto-delete head branches

---

## 附：决策点定稿汇总（原 8 个 🔶 全部拍板）

| #   | 决策点                 | 定稿选择                       | 理由                                          |
| --- | ---------------------- | ------------------------------ | --------------------------------------------- |
| ①   | 格式化工具             | **ESLint + Prettier**          | Vue SFC 生态完整，与 vue-tsc 配合稳           |
| ②   | vue-tsc 存量错误       | **一次性清零，CI required**    | 观察模式会永久卡住，没人回头清                |
| ③   | 合并方式               | **Squash merge**               | agent WIP 链不值得进历史，blame 干净          |
| ④   | 分支保护严格度         | **允许管理员绕过**             | solo 热修刚需                                 |
| ⑤   | 大图资产               | **≤500KB 体积红线，不引 LFS**  | 用户素材已走 IndexedDB，LFS ROI 低            |
| ⑥   | CHANGELOG 格式         | **单文件 `docs/CHANGELOG.md`** | 搜得动，append-only 免冲突                    |
| ⑦   | CHANGELOG 历史范围     | **只搬进行中+近期交付**        | 已完成旧 Phase 由 docs/phases/ + git log 承载 |
| ⑧   | agent-config.json 拆分 | **本轮不做，中期再评估**       | 当下能编辑，痛不到值得动构建链                |
