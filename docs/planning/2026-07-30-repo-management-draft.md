# 仓库治理与协作规范草案 (DRAFT v0.1)

> 日期: 2026-07-30 ｜ 状态: **草案，待主人评审** ｜ 目标: 让多人 + 多 Agent（Claude Code / Codex / 其他）并行开发时高效、低冲突、质量有地板。
>
> 每节末尾的 ☑/⬜ 表示采纳状态；🔶 标记需要主人拍板的决策点。

---

## 0. 现状诊断摘要

| # | 问题 | 影响 | 严重度 |
|---|------|------|--------|
| 1 | `CLAUDE.md` 与 `AGENTS.md` 双源已分叉（AGENTS.md 停在 Phase 10g） | 不同工具的 agent 看到不同的仓库真相 | 🔴 |
| 2 | CLAUDE.md 进度表膨胀成变更日志（单格数千字） | 每会话 token 浪费 + 多人合并冲突头号来源 | 🔴 |
| 3 | 无 CI、无分支保护 | 质量全靠自觉；typecheck 不查 .vue SFC 的坑无兜底 | 🔴 |
| 4 | 无 lint/format 工具 | 多 agent 风格漂移，diff 噪音累积 | 🟡 |
| 5 | 过程产物入库（artifacts/ ~25MB 截图）+ 大 PNG 直进 git + 历史埋 267MB mp3 | clone 变慢，仓库不可逆膨胀 | 🟡 |
| 6 | 分支策略随缘（时而直推 master、时而 PR），合并后分支不删 | 多人并行时互相踩脚 | 🟡 |
| 7 | package.json description 乱码 / license 字段 ISC 与文档 MIT 矛盾 | 小但暴露编码与元数据无守卫 | 🟢 |

---

## 1. Agent 指令文件：单一真源

**规则：`AGENTS.md` 是唯一正文，`CLAUDE.md` 是薄壳。**

- `AGENTS.md`（业界跨工具标准名，Codex/Cursor/Windsurf 等都读）承载：项目概览、文档导航、架构图、设计约定、必读清单、常用命令。
- `CLAUDE.md` 只留三部分：猫娘人格遵循、Claude Code 专属内容（skills/workflows 用法）、一行 `@AGENTS.md` 导入。
- **禁止在两个文件里重复同一段内容。** 更新架构/约定只改 AGENTS.md。
- 指令文件里**只写规则，不写历史**。"什么时候做了什么"一律进 changelog（见 §3）。

**瘦身红线**：AGENTS.md 目标 ≤ 500 行。超过就把细节下沉到 `docs/reference/` 并只留一行指路（现有的"XX 必读 → 路径"模式已经是对的，坚持它）。

⬜ 待采纳 ｜ 🔶 决策点：CLAUDE.md 的 `@AGENTS.md` 导入方案 vs 完全复制（Claude Code 支持 @import；Codex 不支持 import 所以正文必须放 AGENTS.md 这边）

---

## 2. 分支与合并策略

**模型：trunk-based + 短命分支 + PR 必经。**

- `master` 开启分支保护：禁止直推，必须走 PR，必须过 CI 必需检查。
- 分支命名：`feat/<topic>` `fix/<topic>` `docs/<topic>` `refactor/<topic>`；agent 自动创建的分支保留其前缀（如 `claude/<topic>`）。
- 分支生命周期 **≤ 3 天**。大功能拆成可独立合并的小 PR（本仓库的 M1-M6 批次模式就是范本）。
- **合并后立刻删分支**（GitHub 开 auto-delete head branches）。现存遗留分支（`audio-system` / `ui-test` / `feat/scenepanel-three-section` / `feature/phase7-background-refactor` 等）逐一确认后清理。
- 合并方式：**squash merge 为默认**——agent 产出的 WIP 提交链不值得进 master 历史；一个 PR = master 上一个语义完整的提交。

**多 agent 并行防踩脚：**

- 每个并行任务开独立分支 + 独立 worktree（`.claude/worktrees/` 机制已在用，保持）。
- 派工按**模块边界**切分：两个 agent 不同时改同一文件。高危共享文件（见 §6）改动需在任务描述里显式声明。

⬜ 待采纳 ｜ 🔶 决策点：squash vs merge commit；分支保护是否允许管理员绕过（solo 热修场景）

---

## 3. 变更记录：把历史从指令文件里搬出去

- 新建 `docs/CHANGELOG.md`（或 `docs/changelog/` 按月分文件）。CLAUDE.md 现有进度表**整体迁移**过去，指令文件只留一张 ≤ 30 行的「Phase → 状态」速览表。
- 每个 PR 的详细记录写进 changelog，**append-only、按日期倒序**——追加式文件天然免冲突。
- `docs/planning/` 继续放会话级计划文档（现有惯例，保持）。

⬜ 待采纳

---

## 4. CI：质量地板

新建 `.github/workflows/ci.yml`，PR 与 master push 触发：

```yaml
# 概念示意
jobs:
  check:
    - npm ci
    - npm run typecheck          # tsc --noEmit
    - npx vue-tsc --noEmit       # 补上 .vue SFC 检查缺口（agent-memory 已记录此坑）
    - npm run test:run           # vitest --run
```

- 三个检查全部设为 master 的 **required checks**。
- 已知 flaky 测试（agent-memory `known-flaky-tests.md`）：要么修掉，要么显式 `retry`/隔离标记，**不允许"重跑一次就绿"文化**。
- 后续可加：`npm run build` 冒烟、bundle 体积报警。

⬜ 待采纳 ｜ 🔶 决策点：vue-tsc 首次引入可能爆出存量错误——先以 `continue-on-error` 观察一周还是一次性清零

---

## 5. 代码规范与工具链

### 5.1 格式化 + Lint

- 🔶 **推荐 Biome**（单工具 = format + lint，速度快、零配置内战），备选 ESLint + Prettier（Vue 生态插件更全）。
- 规则基线：推荐配置 + 少量项目定制；**风格问题一律交给工具，人和 agent 都不在 review 里争风格**。
- 落地方式：先 `format` 全仓库一次性提交（单独 PR，方便 git blame 跳过），再进 CI。

### 5.2 编码与行尾守卫

- 新建 `.editorconfig`：`charset = utf-8`，`end_of_line = lf`（`*.bat` 除外，已由 .gitattributes 管）。
- **中文源文件禁止用 PowerShell 重定向写入**（agent-memory `powershell-mangles-utf8-source.md` 的坑）；写文件用编辑器工具/Write 工具。package.json 现有乱码 description 顺手修复。

### 5.3 既有设计约定（从 CLAUDE.md 继承，继续有效）

- `types.ts` 唯一类型来源，大类型拆 `types-*.ts`
- StateManager 唯一状态写入入口 (ADR-21)
- Prompt vs Code 边界 (ADR-11)：确定性归 Code，创造性归 Prompt
- 每个新模块必须配套 `*.test.ts`（Vitest + fake-indexeddb）
- 逻辑键=名字，AI 永不产 id（数据字典规范五铁律）

### 5.4 提交规范

- Conventional commits 正式化：`feat|fix|docs|refactor|test|chore(scope): 中文描述`（现状已基本如此，写进规范即可）。
- `package.json` license 字段改为与文档一致（引擎 MIT + 内容独立授权协议）。

⬜ 待采纳 ｜ 🔶 决策点：Biome vs ESLint+Prettier

---

## 6. 冲突热点治理

多人 + 多 agent 并行时，可预期的合并冲突磁铁及对策：

| 热点文件 | 对策 |
|----------|------|
| `CLAUDE.md` / `AGENTS.md` 进度表 | §3 迁走历史，指令文件低频改动 |
| `src/sillytavern/types.ts` | 新增大类型强制走 `types-*.ts` 分册；同 PR 内只 append 不重排 |
| `agent-config.json`（10+ Agent 的 systemPrompt 单文件） | 🔶 中期考虑拆为 `agent-config/<agent>.json` 每 Agent 一文件 + 构建时合并 |
| `docs/CHANGELOG.md` | append-only 按日期，新条目永远加在自己日期段 |
| `package-lock.json` | 依赖变更单独 PR，不与功能混提 |

- 新建 `.github/CODEOWNERS`：给热点文件挂 owner，PR 触碰时自动请求 review（人少时至少起"改到了敏感文件"的提示作用）。

⬜ 待采纳

---

## 7. 二进制资产策略

- **过程产物不入库**：`artifacts/` 加入 `.gitignore`（设计评审截图是会话产物，不是交付物；现存 ~25MB 逐步清理）。需要留档的评审结论以 markdown 摘要形式进 `docs/`。
- **交付资产走 Git LFS**：`src/ui/assets/themes/**/*.png` 等大图迁 LFS（🔶 需评估 GitHub LFS 配额 vs 仓库现状 —— 若不想引入 LFS，则退而求其次：单文件 ≤ 500KB 红线 + 压缩后入库）。
- 音频维持现状：mp3 不入库（.gitignore 已有规则），manifest + README tracked。
- 历史瘦身（267MB mp3 已在历史中）：**刻意不做** history rewrite，除非 clone 速度成为实际痛点——与既有决定一致。

⬜ 待采纳 ｜ 🔶 决策点：LFS 引入 vs 体积红线

---

## 8. PR 流程与模板

新建 `.github/pull_request_template.md`，把 CLAUDE.md 的"提交前文档检查"变成强制勾选：

```markdown
## 变更说明
<!-- 做了什么、为什么 -->

## 检查清单
- [ ] `npm run typecheck` + `npm run test:run` 本地通过
- [ ] 文档同步检查：AGENTS.md / docs/ / reference/agent流程测试/ / tests/agent-framework/README.md
- [ ] 涉及游戏数值/世界观 → 已查 `reference/world_book_index.md`
- [ ] 涉及数据实体字段 → 已查数据字典规范
- [ ] 涉及 UI → 已查 `docs/design.md` (+DESIGN.md 主题决策)
- [ ] 新模块已配套 `*.test.ts`
- [ ] changelog 已追加条目
- [ ] （agent 产出的 PR）标注了使用的 agent/工具与人工复核人
```

**Agent 产出 PR 的额外规则：**

- PR 描述必须写明：哪个工具/agent 产出、人工是否逐行复核、验证方式（测试/真机/仅编译）。
- 未经人工真机验证的功能 PR，标题或 label 标注「待真机验证」（现有惯例正式化）。

⬜ 待采纳

---

## 9. Agent 协作专项

- **共享 agent 记忆**：`.claude/agent-memory/` 继续入库共享（这是本仓库的独特优势）。规范化：一坑一文件、kebab-case 命名、MEMORY.md 做索引——现状已如此，写进规范防走样。
- **Codex 侧对等**：`.codex/skills/` 与 `.claude/` 的能力尽量对齐；新增 skill 时考虑是否两边都要。
- **派工粒度**：给 agent 的任务描述必须包含——目标文件清单、不许碰的文件、必读文档（按 AGENTS.md 的必读矩阵）、验收标准（哪些测试要绿）。
- **世界观内容生成**：分派给任何 agent 的叙事类任务，prompt 必须引用 `reference/narrative_context_example.md`（现有规则，纳入派工模板）。
- **Debug 循环**：真机 bug 修复遵循 `docs/reference/debug-loop-handbook.md`，一次一 bug。

⬜ 待采纳

---

## 10. 落地顺序（建议分四批，每批一个 PR）

| 批次 | 内容 | 风险 |
|------|------|------|
| A | AGENTS.md 重建为真源 + CLAUDE.md 瘦身 + 进度表迁 CHANGELOG | 低（纯文档） |
| B | CI workflow + PR 模板 + CODEOWNERS + 分支保护开启 + 遗留分支清理 | 低 |
| C | .editorconfig + 格式化工具引入 + 全仓一次性 format + package.json 修复 | 中（大 diff，需单独 PR） |
| D | artifacts/ 出库 + 资产体积策略（LFS 或红线） | 中（需决策） |

---

## 附：待主人拍板的决策点汇总

1. **格式化工具**：Biome（快、单工具）vs ESLint+Prettier（Vue 生态成熟）
2. **合并方式**：squash（推荐）vs merge commit
3. **大图资产**：Git LFS vs 单文件体积红线
4. **vue-tsc 存量错误**：观察模式 vs 一次清零
5. **agent-config.json**：是否拆分为每 Agent 一文件
6. **分支保护严格度**：管理员可否绕过（solo 热修场景）
