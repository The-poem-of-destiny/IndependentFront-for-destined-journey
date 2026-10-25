# exp/2026-10-02-Combat-experiments → master 合并评估（2026-10-24）

> 结论先行：**这不是一份"解 13 个文本冲突"的活，是两个分叉了 25 天的架构在同一个工作区里碰面。**
> 文本冲突只有 14 个文件，但真正的成本在于：本分支删掉了 128 个文件（旧战斗引擎 + scripting/effects 子系统 + char_gen/item_gen），
> 而 master 在这 18 天里继续在**旧引擎**上加了 10 个提交的功能（Story v2、条目级 lore、Q-02/F08/Q-07 接线）。
> 合并 = 把旧引擎整体换掉，然后把 master 新增的接线逐条重接到新沙盒上。git 不会报错的地方，正是最容易出问题的地方。

## 1. 分叉现状

| 项          | 值                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| merge-base  | `c24552e` 2026-09-29 23:55（docs: 精简入门教程…）                                                             |
| 本分支      | `exp/2026-10-02-Combat-experiments` → `4867388` 2026-10-06 02:21，**5 个提交**，本地与 origin 完全同步（0/0） |
| master      | `origin/master` → `0f6acbf` 2026-10-24 01:01，**比 base 多 10 个提交**                                        |
| 落后 / 领先 | 落后 master **10** 个提交，领先 master **5** 个提交                                                           |
| 工作区      | 干净（无未提交改动、无 stash 依赖）                                                                           |
| 分支年龄    | **18 天**，约等于 `docs/planning/2026-07-31-repo-management.md` 里"分支生命周期 ≤ 3 天"上限的 6 倍            |

本分支 5 个提交：

1. `cd23817` feat(combat)!: 战斗去代码化 + 实体生成统一（协议沙盒 / entity_gen）
2. `9740290` feat(combat): 逐单位回合循环 + agent 式战斗对话流 + 结算/集群/响应式修复
3. `2e029de` test(combat): 对齐逐单位架构 + 修复放弃竞态
4. `eefc589` feat(prose): 正文润色 AI（DeepSeek beta 前缀续写）+ FP/性别/调试修复
5. `4867388` feat(story): 正文 AI 预填充 + 游戏页自动存档 + 剧情预检联动

master 侧（base 之后）：条目级 lore 读取权限 + 退役 Agent 世界书清单、Story v2 五区上下文与资料选择、
摘要归档与召回、独立 ST 供值、内置角色过滤修复、以及一批 planning/review 文档。

## 2. 两边到底动了多少

| 维度                 | 本分支                                                                                      | master                                                            |
| -------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 改动文件             | 267（+14554 / **-48053**）                                                                  | 152（+18788 / -2014）                                             |
| 新增文件             | 34                                                                                          | 46                                                                |
| **删除文件**         | **128**                                                                                     | **0**                                                             |
| `src/core/combat`    | 41 → **10**（`kernel/coordinator/automata/phases/reducer…` 全删，换 `sandbox/*`）           | 41（不变）                                                        |
| `src/core/scripting` | 4 → **0**                                                                                   | 4（不变）                                                         |
| `src/core/effects`   | 8 → **3**                                                                                   | 8（不变）                                                         |
| `src/core/memory`    | 2                                                                                           | 2 → **8**                                                         |
| agent 数量           | **14**（char_gen + item_gen → entity_gen，删 combat_enemy，加 daily_check / prose_rewrite） | **15**（保留 char_gen / item_gen / combat_enemy，加 lore_select） |
| `DB_VERSION`         | **27**（`combatSandboxes`）                                                                 | **29**（27 摘要 / 28 阶段归档 / 29 归档重试）                     |
| 测试文件数           | 424 → 363（删 58 个战斗测试）                                                               | 445                                                               |

**核心矛盾一句话**：两边各自从 `DB_VERSION = 26` 往上编号，各自重排了 agent 清单，各自在同一条
`game-pipeline.ts` / `state-manager.ts` / `database.ts` 主缝上施工。这三个文件才是战场，其余都是余波。

## 3. 冲突清单（`git merge-tree --write-tree origin/master HEAD` 实测）

| #   | 文件                                           | hunk             | 性质          | 建议解法                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------- | ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `src/core/persistence/database.ts`             | 5                | 🔴 版本号撞车 | 采纳 master 的 27/28/29，把 `combatSandboxes` 顺延成 **v30**；三张 story 表**进** FullBackup，`combatSandboxes` **不进**（rebuildable），两边规则都要落进 `deleteSave` 级联                                                                                        |
| 2   | `src/core/state/state-manager.ts`              | 1                | 🔴 语义最强   | master 的 `assertCurrentTurn(isCurrent)` 陈旧回合守卫 + Q-02 正文自提交，必须嫁接在 exp 的 F08 持久借据语义上。**注意：exp 侧把该处的正文自提交整个删掉了**（Q-02 命中 6 → 1，`commitChatState` 调用 4 → 2），要确认是有意重构还是被旧版本覆盖 —— 选错会静默丢补丁 |
| 3   | `src/ui/lib/game-pipeline.ts`                  | 4                | 🔴            | imports 取并集；master 的 lore/story-v2 装配 + Q-07 `wireEffectSystem` 与 exp 的 sandbox 接线要人工重排，不能按行取边                                                                                                                                              |
| 4   | `public/data/defaults/agent-config.json`       | 2                | 🔴 需人决策   | 决定最终 roster（见 §4）后整块重写 `char_gen`/`item_gen`/`entity_gen`/`combat_enemy` 四段                                                                                                                                                                          |
| 5   | `src/core/content/placeholder-hashes.json`     | 1                | 🟡 机械       | **不要手解**，合并后重跑 `node scripts/build-placeholder-hashes.mjs`                                                                                                                                                                                               |
| 6   | `src/ui/stores/settings-store.ts`              | 1                | 🟡            | master 的 legacy 世界书暂存迁移分支 + exp 的预设播种分支并存，取并集                                                                                                                                                                                               |
| 7   | `src/ui/components/game/GamePage.vue`          | 1 行             | 🟢            | 取 master 的 `if (pipeline?.abort()) cancelStreamingPreview();`，再把 exp 的 `useAutosave` 装配接上                                                                                                                                                                |
| 8   | `docs/CHANGELOG.md`                            | 1（约 609 行块） | 🟢            | 两侧顶部条目 union，按交付日期倒序交错排列                                                                                                                                                                                                                         |
| 9   | `tests/core/agents/agent-orchestrator.test.ts` | 2（224 行块）    | 🟢            | 两侧都是在文件尾部追加新 describe，union 即可                                                                                                                                                                                                                      |
| 10  | `tests/ui/lib/game-pipeline.test.ts`           | 4                | 🟡            | 按合并后真实接线重写断言（char_gen→entity_gen、system_core 授权对象的差异）                                                                                                                                                                                        |
| 11  | `tests/core/persistence/database.test.ts`      | 3                | 🟡            | 版本号断言改 30，表清单取并集（`combatSandboxes` + 三张 story 表）                                                                                                                                                                                                 |
| 12  | `tests/no-world-content.test.ts`               | 1                | 🟡            | 数量断言重算（见 §4），并把"数字相等"改成名单比对                                                                                                                                                                                                                  |
| 13  | `tests/placeholder-content.test.ts`            | 1                | 🟡            | 同上；世界书数量 master 15 / exp 16（新增 `combat_extra.json`）                                                                                                                                                                                                    |
| 14  | `tests/core/combat/coordinator.test.ts`        | modify/delete    | 🟢            | 跟随 exp 删除（旧引擎已不存在），除非 master 还要留旧战斗                                                                                                                                                                                                          |

自动合并但值得盯一眼的（git 不报冲突、语义可能错）：
`src/ui/stores/game-store.ts`、`src/ui/main.ts`、`src/core/agents/agent-orchestrator.ts`、
`src/core/types/types.ts`、`src/core/prompts/*`、三份 `AGENTS.md`。

## 4. 合并前必须先定的三件事

1. **DB 版本序列**：27（story 摘要）/ 28（story 归档）/ 29（归档重试）沿用 master，`combatSandboxes` → **30**。
   顺带确认 `combatSandboxes` 的"rebuildable 缓存不进 FullBackup"与 story 表的"随存档导出"两条相悖规则都保留在
   `FullBackup` 白名单和 `deleteSave` 级联里。
2. **agent roster**：按成员并集算是 **15 个**（11 个共有 + `entity_gen` + `daily_check` + `prose_rewrite` + `lore_select`），
   前提是确认 `combat_enemy` 在新沙盒里已无席位（exp 让 combat 主持人 + 逐单位决策接管了它）。
   注意：**数字刚好也等于 master 的 15**，纯数量断言会假绿 —— 必须改成 `toContain` / `not.toContain` 名单校验（exp 已经是这么写的）。
3. **effects / scripting 子系统去留**：exp 删了 `scripting/*`（4 个）和 `effects/` 里 5 个运行时文件，
   master 侧仍在用（`main.ts` 的 `installProductionScriptBackend`、`game-store`/`game-pipeline` 的 `wireEffectSystem`/`unwireEffectSystem`）。
   合并后这些功能会**静默消失且 typecheck 依旧通过**（因为调用点全在 exp 改过的文件里被一起删了）。若不是有意"去代码化"，这里就是最大回归。

## 5. 建议的操作序列

```bash
# 0) 留个可回退的点
git tag pre-merge-combat-$(date +%Y%m%d) exp/2026-10-02-Combat-experiments
git tag pre-merge-master-$(date +%Y%m%d) origin/master

# 1) 在 exp 上做吸收合并（不要反过来：exp 是新架构，冲突必须按 exp 的世界观重接）
git switch -c integrate/2026-10-24-combat exp/2026-10-02-Combat-experiments
git merge origin/master --no-ff

# 2) 按 §3 的顺序解（先 1/2/3 三个核心文件，再 4/5，最后测试与文档）
#    §3-#5 的 placeholder-hashes 解完 config 后重算：
node scripts/build-placeholder-hashes.mjs

# 3) 全量闸门（仓库定义的 gates 八道）
npm run gates

# 4) 只有确定是本次删代码造成的基线漂移才更新（否则先看 diff）
npm run knip:update
```

## 6. 验收清单

- [ ] `npm run gates` 八道全绿（typecheck / typecheck:vue / typecheck:tools / build / format:check / lint / knip:ratchet / vitest）
- [ ] `DB_VERSION === 30`，旧档 v26 直接升上来不炸（起一个 v26 存档实测 openDb → 读存档）
- [ ] 全存档导出/导入往返：story 三表在包里、`combatSandboxes` 不在包里、删存档两条都级联清
- [ ] 新建档 → 跑一轮 → 战斗 → 结算 → 正文润色 → 预填充 → 自动存档，主链路走一遍
- [ ] 战斗中断（刷新页面）后 `combatSandboxes` 能续战
- [ ] `grep -rn "char_gen\|item_gen\|combat_enemy" src public/data` 只剩历史注释
- [ ] `grep -rn "effect-wiring\|script-backend" src` 为空，或确认保留
- [ ] 三份 `AGENTS.md` 的架构图与目录树按合并后重写（现在两侧都各自过时）
- [ ] `npx prettier --write` 过改过的 `.md`/`.json`

## 7. 治理提醒

仓库规范是 **trunk-based + 短命分支 + PR 必经 + squash merge**。这次如果按规范走 squash，
master 上会出现一个 **+14.5k / -48k、删 128 个文件** 的单提交 —— 可回滚性取决于那个 tag，
但 review 基本不可能。可选的两条路：

- **A（保守）**：拆成 3 个 PR 顺序落：① 战斗沙盒 + entity_gen（含 DB v30）② 正文润色 / 预填充 ③ 自动存档 / 检联动。
  每个 PR 自己 gates 全绿，出问题能单点 revert。
- **B（省事）**：一次 squash。前提是先打 tag、且 `npm run gates` 在合并后分支上真绿。

不管走哪条，下次别让"战斗引擎重写"和"上下文体系重写"同时长跑 18 天。

---

_评估依据：`git merge-tree --write-tree origin/master HEAD`（无副作用）+ 三路文件集/引用扫描，未改动任何工作区文件。_

## 8. 执行记录（2026-10-24，已按本方案落地）

- 集成分支：`integrate/2026-10-24-combat`（基于 `exp/2026-10-02-Combat-experiments`，`git merge origin/master --no-ff`）
- 回滚点：`pre-merge-combat-20261024` / `pre-merge-master-20261024` 两个 tag
- 八道闸门 `npm run gates` **全绿**：380 个测试文件 / 9115 用例通过（8 skipped）

### 8.1 十四个冲突的解法

| 文件                          | 解法                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `database.ts`                 | `DB_VERSION = 30`；master 的 v27/28/29（story 三表）保留，`combatSandboxes` 顺延成 **v30**；删存档的四张表全进事务清单                        |
| `state-manager.ts`            | 保留 master 的 `assertCurrentTurn(isCurrent)` 陈旧回合守卫与 Q-02 自提交，注释说明 Phase 3 后 `patches` 恒空、该分支是防御性的                |
| `game-pipeline.ts`            | imports 取并集；世界书读取范围**只留 lore-routing**（`agentCfg.worldBookIds` 那套随字段退役删除）；效果系统接线块不引入；story v2 装配保留    |
| `agent-config.json`           | 取 HEAD 的 `entity_gen`，删 master 的 `char_gen`/`item_gen` 与 `combat_enemy`；再补一刀删掉退役字段 `worldBookEnabled`/`worldBookIds`（6 处） |
| `placeholder-hashes.json`     | 不手解，改完 config 后 `node scripts/build-placeholder-hashes.mjs` 重算（books=16）                                                           |
| `settings-store.ts`           | master 的世界书退役迁移 + 预设播种注释都保留                                                                                                  |
| `GamePage.vue`                | 取 master 的 `if (pipeline?.abort()) cancelStreamingPreview();`（`abort(): boolean` 在合并后的 pipeline 里成立）                              |
| `CHANGELOG.md`                | 两侧条目 union，按"新条目在上"排：master 的 10-23/24 在前，HEAD 的 10-05/06 在后                                                              |
| `agent-orchestrator.test.ts`  | 两侧都是在文件尾部追加 describe，手工重排成"预填充块 + story v2 块"两个独立块                                                                 |
| `game-pipeline.test.ts`       | 世界书两条用例改成 lore-routing 语义（`char_gen`→`entity_gen`）；战斗结算用例取 C6 语义                                                       |
| `database.test.ts`            | 版本断言 `30`、表清单取并集、并新增"`combatSandboxes` 不在备份里"的断言                                                                       |
| `no-world-content.test.ts`    | 数量 15 + **逐条点名**（数量相同不等于成员相同）                                                                                              |
| `placeholder-content.test.ts` | 同上 + 世界书数量 15 → 16（`combat_extra.json`）                                                                                              |
| `coordinator.test.ts`         | modify/delete：跟随本分支删除（旧 v3 内核已不存在）                                                                                           |

### 8.2 三处语义决策（本方案的选择）

1. **DB 版本**：master 的 27/28/29 不动，战斗沙盒顺延 v30 —— 老库 v26 直接升上来，v30 只做加表。
2. **agent 名册 15 个**：`entity_gen` 取代 `char_gen`+`item_gen`，`combat_enemy` 随 v3 内核退役（新沙盒由单一 `combat` 主持人 + 逐单位决策承载），保留 master 的 `lore_select`。
3. **effects / scripting 跟随本分支删除**：这两套是"战斗去代码化"的一部分（现役替代 = 声明式 VarsPatch + combat/sandbox）。master 侧在它们上面的接线（Q-07 `wireEffectSystem`、`installProductionScriptBackend`）随之消失 —— 这是**有意的取舍**，若要保留需另开一轮把它们接到新沙盒上。

### 8.3 git 不会报、但必须一起修的数据层断链

- **世界书 `audiences` 重映射**：`char_gen` → `entity_gen` 共 **21 处**（7 本书）；`combat_enemy` 删除 **10 处**（这 10 条与 `combat` 完全重叠，无信息损失）。不改的后果：`entity_gen` 一本书都读不到，且**不报错**。
- **`combat_extra.json` 补 `audiences`**：4 条条目原本没有任何 `extra.lore`（HEAD 靠已退役的 `worldBookIds` 点名），补成 `["entity_gen", "daily_check"]`。
- **`lore-protocol.ts` 的 `AGENTS` 白名单**：原名单含 `char_gen`/`item_gen`/`combat_enemy`，缺 `entity_gen`/`daily_check`/`prose_rewrite` —— 不更新的话，内容包安装会把新 audiences 判成 `unknown-agent` 直接拒装。
- **`emitMessage` 的 `diagnostic` 默认值**：master 给 assistant 默认 `{ diagnostic: true }`，而 C6 的战斗摘要是正文的一部分 → 该调用点显式传空 markers，且空 markers 改走两参调用（与 HEAD 的调用形状一致）。

### 8.4 遗留（没在这次合并里做）

- 三份 `AGENTS.md` 的架构地图仍描述两套并存的子系统，需要按合并后的真实结构重写。
- `agent-defaults-fingerprints.json` 保留 `worldBookEnabled`/`worldBookIds` 的历史指纹（用于识别"用户没改过"的旧值），**不要删**。
- `src/ui/components/settings/agent/PresetManager.prefill.test.ts` 原本断言 `@change="togglePrefill"`，而实现是 `<label @click.stop.prevent>` —— 这是本分支自带的红测试（非合并引入），已把断言对齐真实写法。
