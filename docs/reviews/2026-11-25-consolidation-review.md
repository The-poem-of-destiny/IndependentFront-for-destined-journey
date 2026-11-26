# 2026-11-25 两周整合审查（PR #142～#182）

- 基线：`83f8448a`（#140）→ `069587b2`（#182），IF 仓约 40 个 PR、+13 万行；内容仓 `content/content-pack-alpha` PR #3～#8。
- 方式：四个只读审查分区并行——直出链路 / 变量协议与状态 / 行动面板与叙事 UI / 其余功能与内容仓。标「实测」的条目由审查员用探针或真实 StateManager + fake-indexeddb 复现过，其余为读代码推断。
- 基线检查（本机）：typecheck、typecheck:vue、lint 通过；测试 564/565 文件、12512 例通过。唯一失败 `tests/analyze-state-writes.test.ts` 是本机 `core.autocrlf=true` 让 `scripts/analyze-state-writes.mjs` 的 shebang 带 `\r`，CI 绿。

路径省略 `src/` 前缀。

---

## 第一批：可复现 bug（小改，每条带回归用例）

| #   | 区域     | 问题                                                                                                                                              | 位置                                                                                                                            | 规模                |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| A1  | 直出     | 标签计数扫全文：正文前思考块提到 `<maintext>` / `<direct_updates>` 即整楼拒收；#179 尾部提醒扩大了触发面（实测）                                  | `core/agents/direct-output.ts:759-779`                                                                                          | 小                  |
| A2  | 直出     | update / modify / upsert 不查值类型：`remainingTime:"3小时"` → `Math.max` 得 NaN 落库；`changes.stats:"abc"` 写进物品；`quests.upsert` 无键白名单 | `direct-output.ts:537-573,709-712`；`core/state/state-manager.ts:1904,2019`                                                     | 中（并入 R1）       |
| A3  | 行动面板 | `readNumber` 把「逗号+数字」当千分位：`60→26,3回合流血` 读成 263，伤害画成治疗（实测）                                                            | `ui/lib/action-digest.ts:336`                                                                                                   | 小                  |
| A4  | 行动面板 | 结算面板多人资源变化在收起态消失；Duel 结算脚注丢归属人名（实测）                                                                                 | `ui/lib/action-panel-view.ts:216-245`；五个 `ActionStyle*.vue` 结算模板                                                         | 中（并入 R3）       |
| A5  | 行动面板 | 两条正则回溯：10 万空格 `                                                                                                                         | 目标                                                                                                                            | `5.7 s、10 万`.`的` | 结果 | ` 15 s，流式每片重算（实测） | `action-digest.ts:374,1079` | 小  |
| A6  | 行动面板 | 标题带 `→` 一律判交锋（`制作流程: 熔炼 → 锻打`）；`HP -10%` 记成 −10；`action_info` 标签三套正则互不一致                                          | `action-digest.ts:562-567,779-791`；`ui/lib/action-panel.ts:161`、`ui/lib/stage-playback.ts:75`、`core/story/story-beats.ts:39` | 小                  |
| A7  | 变量协议 | 整对象写资源依赖键序：`{当前:6000,上限:7000}` 得当前 5000（实测）                                                                                 | `core/variables/state-tree-translator.ts:1566-1602,1872-1893`                                                                   | 小                  |
| A8  | 变量协议 | 档案写入走旁路：同批「写档案再改名」试算过、提交报「角色不存在」；直出下档案改动不在 `commitDirectTurn` 事务内（实测）                            | `state-tree-translator.ts:1744-1821`；`direct-output.ts:1034`；`state-manager.ts:723,1002`                                      | 中                  |
| A9  | 变量协议 | 金钱不为负、命运点不超扣只在翻译层钳，旧协议与 Agent 模式裸加                                                                                     | `state-tree-translator.ts:1637-1648,1937-1955`；`state-manager.ts:1536`                                                         | 小                  |
| A10 | NSFW     | 开→关后 Agent 模式基线签名不含开关，旧 transcript 原样回放露骨段                                                                                  | `core/prompts/prompt-session-assembler.ts:443-460`                                                                              | 小                  |
| A11 | NSFW     | 整条 nsfw 的冻结角色定义运行期不过滤，条目被剔后反而回落发 `lore` 原文                                                                            | `ui/lib/game-pipeline.ts:1196`；`core/character/character-definitions.ts:183`                                                   | 小                  |
| A12 | 工具链   | `*.mjs` 未固定 LF，本机 autocrlf 下 shebang 失效                                                                                                  | 新增 `.gitattributes`                                                                                                           | 小                  |

> 📌 2026-11-25 更正（A12，`fix/gitattributes-mjs-lf`）：上表「位置」一栏写的「新增 `.gitattributes`」不准 —— 仓库根早有 `.gitattributes`（钉 `*.bat` CRLF，并逐个点名几份带 shebang 的脚本为 LF）。实际修法是在该文件里追加 `*.mjs` / `*.sh` 两条通配 `eol=lf`，取代逐个点名；当日实测这两类文件的索引本来就是 LF，加通配不改任何文件内容。已有工作区要重新检出才生效（PowerShell：`$f = git ls-files '*.mjs' '*.sh'; $f | % { Remove-Item -LiteralPath $_ }; git checkout -- $f`）。

## 第二批：发 beta 前的发布事项

1. **引擎版本闸门**：`package.json` 仍是 1.0.1（#170），其后 #172、#174、#176～#180 多次改包契约，新包会被 11-20 的旧引擎接受。发版前递增，并写进发布清单。
2. **内容仓收口**：`content/content-pack-alpha` 领先 main 12 个提交；`request_dispatcher` 仍写「开局轮含『--- 初始装备 ---』清单」（#172 自述要同步，未做）；最新构建包 2.14.0 早于内容 PR #5～#8。顺序：alpha 合进 main → 引擎版本递增 → 用现行内容重建包 → 跑 `tests/contract`。
3. **契约文档**：行动面板约定（`|变更|名字 HP 旧→新|`）在引擎侧无参考文档、无共享向量；装包校验不查 loreEntry 悬空和互斥组；`AGENTS.md:282`（keyDates）与内容仓 `AGENTS.md:34` 已过时。
4. **真机验证欠账**（按风险）：

| PR                       | 要验什么                                                                                                                                              | 风险               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| #169                     | 真实供应商下 429 / Retry-After；思考型模型首块后静默超过 timeout 是否被判空闲超时并重试重计费（`core/agents/agent-client.ts:848,1037`）；双标签页抢锁 | 高                 |
| #148 #158 #162 #176      | 旧库无指纹行升级（备份副本与常驻提示）；受保护包锁定再解锁后选择键；抽屉开关下一回合生效                                                              | 高（改写玩家数据） |
| #167                     | 新档跑回合、旧档补链、Delta 冷建一次                                                                                                                  | 中高               |
| #172 #173                | 三种模式首回合；首战只靠 protocolText；自制条目库                                                                                                     | 中高               |
| #168                     | 内容仓尚无标记，等于未验                                                                                                                              | 中                 |
| #160                     | 干净机双击、SmartScreen、Discord 登录（冒烟脚本不在 CI）                                                                                              | 中（发布阻塞）     |
| #146 #149 #150 #156 #161 | 日历游玩；分批换窗；日志配额与大导出；美化竞态                                                                                                        | 中                 |
| #147 #155 #157           | 首页观感；开发开关；真实 Gemini                                                                                                                       | 低                 |

## 第三批：结构重构

| #   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 依据          | 规模 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ---- |
| R1  | **直出校验改 contract 表驱动**（键 + 值类型）；normalize 只做无损纠正，丢弃一律归校验器。消掉原型键扫描两份、分区空值四份、`effects.remove` 剥键两处等重叠                                                                                                                                                                                                                                                                                                   | 直出 #2 #3    | 中   |
| R2  | **拆 `direct-main.ts`**（671 行）为组装 / 发送重试 / 诊断统计；草稿显式携带原文路径与开关（去掉模块级 WeakMap、接纳时重读开关）；tree / legacy 两支汇合；窗口估算统一走 `estimateTokens`                                                                                                                                                                                                                                                                     | 直出 #4 #5    | 中   |
| R3  | **行动面板样式共用层**：抽 `action-style-helpers.ts`（`sgn`/`rc`/`deltaClass`/`primaryOf` 等十余个逐字相同的助手）与 `ActionMoreHint` 子组件，通用与名册视图收成一处，顺带补 A4；五份近乎复制的样式测试同步收敛                                                                                                                                                                                                                                              | 行动面板 #4   | 中   |
| R4  | **状态树撤销改内核快照整体还原**：现撤销不是真逆操作（额外改 −9999 再撤销停在 1；穿戴顶替后撤销长剑留在背包；删 NPC 再撤销 id 换新）。可删 `inverseOf` / `rebuildDepleted` / `entryBefore` 等特例；更新块修订的状态提交与记录写回并入同一事务                                                                                                                                                                                                                | 变量 #2 #11   | 中   |
| R5  | **共享 reducer 取代影子镜像**：translator 手写镜像 StateManager 处理器，加 `patch-rehearsal.ts` 共三套模拟，已实测分歧。先补「影子后值 = 真实落库」多 op 序列测试，再抽 reducer                                                                                                                                                                                                                                                                              | 变量 #3 #10   | 大   |
| R6  | **词表成为映射真源 + 拆文件**：`state-tree-spec.ts` 的 field / entity / scalarLeaf 无生产代码读取，键→内核字段在 translator 多处与 edit 中重写；`resource-caps.ts` 仅测试引用。translator 按 shadow / rules / fields / item / skill-status / create-character / world-quest-vars 拆；`StateEditorPanel.vue` 拆树导航 / 字段表单 / 预览确认；`game-store.ts:1593-1801` 独立成 store。顺带修性能（每条 op 两次全量投影 + 整份深拷贝，304 角色 40 op ≈ 600 ms） | 变量 #6 #7 #9 | 大   |
| R7  | **预设共享目录工厂**：`game-pipeline.ts:1747` 与 `ui/composables/usePresets.ts:97` 两套口径；`AgentConfigPanel.vue:295` 绕过 `selectPreset`；`PresetManager.vue:103` 按名字注入；`database.ts:912` 的 `initializeDatabase`/`createDefaultPreset`、`database.ts:1596` 的 `reimportedPresetId` 已无生产调用                                                                                                                                                    | 其余 #6       | 中   |
| R8  | **零散清理**（可一个 PR）：见下                                                                                                                                                                                                                                                                                                                                                                                                                              | 各区          | 小   |

R8 清单：

- 死代码：`game-pipeline.ts:733-734`（plot 已在 normalize 清空）；`diceUsed` 校验后无人消费却计入「已忽略」提示（`direct-output.ts:735-749`）。
- 开发代码进生产包：`ui/components/home/HomePage.vue:94` 改字面量门控（照 #155 写法）。
- 时间常量与标签表收成唯一出口：`BeautifiedNarrative.vue:265`、`ActionStyleBattleLog.vue:24` 对齐 `entrance-timing.ts`；`action-digest.ts:162` 与 `action-panel-view.ts:137` 标签表合一。
- 约百行重复的减动效 CSS（已被 `themes/variables.css:170-192` 全局覆盖），同步 `docs/design.md` §6.4。
- `fx-foil.ts:105-113,180-182` 改走 fx-ticker / fx-pointer；`TurnSeal.vue:36-66` 复用 `fx-theme-signature.ts`。
- 缓存泄漏：`useStagedPlayback.ts:110` `inputCache`、`ChatFlow.vue:230` `mentionCache` 不随消息移除清理。
- `state-manager.ts:859-878,914-927,988-1001` 事务体三份；`isPlainObject` / `jsonClone` / 指针转义散在 6 个文件；「最新一楼」判定两份。
- 标签页锁只护 GamePage：整库导入、删档不看锁。
- 文档不一致：`docs/reference/direct-generation.md:74,300`（平铺收拢实际在 `direct-normalize.ts:460`）；`ui/AGENTS.md:16` 函数名；`direct-normalize.ts:80` 注释引用不存在的 `safeValues`；`direct-generation-cache.md` 重建清单缺 `reentered`。

## 修复状态闭环表

修一条回写一条（AGENTS.md 文档维护守则第 6 条）。第一批里未修的 bug 在报告老化前晋升到 `docs/known-issue.md`；第二批发布事项同步进 `docs/planning/2026-11-20-pre-beta-release-checklist.md`。

📌 2026-11-25 回写：以下分支均已合进整合分支 `refactor/review-fixes-2026-11-25`，经文档分支 `docs/review-fixes-writeback` 回写；PR 号待整合 PR 开出后补填。

| 编号 | 状态 | PR / 备注                                                                                                                                                                                                                                                                                              |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1   | 已修 | #184 `fix/direct-tag-count`：`agents/direct-blocks.ts` 的 `locateDirectBlocks` 统一定位，先剔思考块、闭标签配最近开标签。行为变化：合法输出之后再提一次开标签名会按截断拒收；options 不再从思考块取                                                                                                    |
| A2   | 已修 | #184 内核侧 `fix/state-kernel-guards`（`validateStatePatch` 拒非有限 `remainingTime` 与 `update_item` 值类型不符）；直出侧随 R1 `refactor/direct-contract-validation`                                                                                                                                  |
| A3   | 已修 | #184 `fix/action-digest-parsing`                                                                                                                                                                                                                                                                       |
| A4   | 已修 | #184 `refactor/action-style-helpers`（随 R3，收起态经 `settledDeltas` 逐人画出）                                                                                                                                                                                                                       |
| A5   | 已修 | #184 `fix/action-digest-parsing`；面板标签正则线性化在第 1 波跟进 `fix/wave1-review-followups`                                                                                                                                                                                                         |
| A6   | 部分 | #184 `fix/action-digest-parsing`：`action_info` 标签识别收成引擎侧 `story-beats` 一份；`HP -10%` 已修；带 `→` 的标题只在左边是名字形态或已认出行动者时才判交锋。未修部分：无标签箭头标题仍判交锋，见遗留 L4                                                                                            |
| A7   | 已修 | #184 `fix/state-kernel-guards`                                                                                                                                                                                                                                                                         |
| A8   | 已修 | #184 `fix/state-tree-profile-patch`：档案字段改走 `update_character` 补丁，与改名同批按序落；直出落在 `commitDirectTurn` 事务内                                                                                                                                                                        |
| A9   | 已修 | #184 `fix/state-kernel-guards`：AI 来源扣命运点超余额钳 0，`update_character` 金钱钳 0；金钱非有限值归 0 在 `fix/wave1-review-followups`                                                                                                                                                               |
| A10  | 已修 | #184 `fix/nsfw-switch-leaks`：Agent 模式基线签名与 `direct_cached` 会话签名并入开关（开 → 关重建一次，关时签名不变）                                                                                                                                                                                   |
| A11  | 已修 | #184 `fix/nsfw-switch-leaks`：给模型的角色定义按开关投影；旧档首轮冻结用过滤前的书                                                                                                                                                                                                                     |
| A12  | 已修 | #184 `fix/gitattributes-mjs-lf`：追加 `*.mjs` / `*.sh` 通配 `eol=lf`（见上方 A12 更正注记）                                                                                                                                                                                                            |
| R1   | 已修 | #184 `refactor/direct-contract-validation`：值类型表 `DIRECT_VALUE_TYPES`，归一化只做无损纠正，登神有损丢弃移到 `salvageAscension`。`diceUsed` 坏行仍计入「已忽略」（既有断言钉住，保留原行为），见遗留 L9                                                                                             |
| R2   | 已修 | #184 `refactor/direct-main-split`：拆成 `direct-request` / `direct-send` / `direct-write-stats`，草稿携带开关与原文路径；`game-pipeline.ts:733` 死代码与 `direct-generation-cache.md` 缺 `reentered` 一并修                                                                                            |
| R3   | 已修 | #184 `refactor/action-style-helpers` + `refactor/action-style-shared-views`：共用助手、`ActionMoreHint`、通用 / 名册视图。行为变化：「经验」算结算类关键格                                                                                                                                             |
| R4   | 已修 | #184 `refactor/state-edit-snapshot-undo`：撤销改内核快照整体还原，更新块修订与记录写回同事务。`inverseOf` / `rebuildDepleted` / `entryBefore` 按裁定保留给更新块逐行撤销                                                                                                                               |
| R5   | 已修 | #184 `test/state-tree-shadow-parity`（安全网）+ `refactor/patch-reducer-character`（角色域）+ `refactor/patch-reducer-profile`（档案域，影子删除）；影子对照 3 条 `it.fails` 已转正。预演按槽位卸下的既有分歧见遗留 L1                                                                                 |
| R6   | 部分 | #184 `refactor/state-tree-spec-source`（词表 `kernel` / `rule` 成为映射真源，304 角色 × 40 op 约 514ms → 9ms）+ `refactor/state-editor-split`（修改器拆三块、状态编辑 store 独立）+ `refactor/state-tree-translator-split`（translator 拆目录）。未修部分：projection 仍有手写键 → 字段映射，见遗留 L6 |
| R7   | 已修 | #184 `refactor/preset-catalog-factory`：`buildUiPresetCatalog` 共用、`selectPreset` 唯一写口、上下文模板按 `storyContextTemplateOf`、`reimportedPresetId` 已删。按主人裁定保留 `initializeDatabase` / `createDefaultPreset`（约 40 个测试与 test-save 在用），见 L12                                   |
| R8   | 部分 | #184 已修项见下方 R8 逐项表；未修：`diceUsed` 计入「已忽略」（L9）、variables 目录外的同类工具重复（L10）                                                                                                                                                                                              |

R8 逐项：

| 子项                                     | 状态 | 分支 / 备注                                                                                                                           |
| ---------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `game-pipeline.ts:733-734` 死代码        | 已修 | `refactor/direct-main-split`                                                                                                          |
| `diceUsed` 计入「已忽略」                | 遗留 | 保留原行为，见 L9                                                                                                                     |
| HomePage 开发代码进生产包                | 已修 | `chore/ui-cleanup-batch`：快速测试移到 `home/DevQuickTestRow.vue`，字面量 DEV 门控异步引入                                            |
| 时间常量与标签表唯一出口                 | 已修 | `refactor/action-style-shared-views`：`entrance-timing.ts` 与 `action-digest.ts` 的标签正则                                           |
| 重复的减动效 CSS                         | 已修 | `chore/ui-cleanup-batch`，`docs/design.md` §6.4 已加更正注记                                                                          |
| fx-foil / TurnSeal                       | 已修 | `chore/ui-cleanup-batch`；fx-foil 混合输入的残留见 L3                                                                                 |
| 缓存泄漏                                 | 已修 | `chore/ui-cleanup-batch`：`useMessageKeyedCache`                                                                                      |
| state-manager 事务体三份                 | 已修 | `fix/state-kernel-guards`：共用私有 `applyPatchesAtomic`                                                                              |
| `isPlainObject` / `jsonClone` 等散落     | 部分 | `refactor/state-tree-translator-split`：variables 目录内收进 `state-tree-utils.ts`；目录外见 L10                                      |
| 「最新一楼」判定两份                     | 已修 | `refactor/state-editor-split`：只认 `state-update-view.ts` 的 `latestUpdateFloorId`                                                   |
| 标签页锁只护 GamePage                    | 已修 | `fix/save-tab-lock-import-delete`：删档、整库导入、清除所有数据经 `navigator.locks.query()` 试探，本标签页自持的锁不拦；装包回滚见 L2 |
| `direct-generation.md:74,300`            | 已修 | 文档已加 2026-11-25 更正注记                                                                                                          |
| `ui/AGENTS.md:16` 函数名                 | 已修 | 本次回写：实为 `recordDirectBuildNotes`                                                                                               |
| `direct-normalize.ts:80` `safeValues`    | 已修 | 注释已不再引用                                                                                                                        |
| `direct-generation-cache.md` `reentered` | 已修 | `refactor/direct-main-split`                                                                                                          |

### 遗留问题

修复过程中确认、本轮未修的问题。标 ⚠️ 的属于缺陷，已按文档维护守则第 6 条晋升到 [`docs/known-issue.md`](../known-issue.md)「2026-11-25 整合审查修复的遗留缺陷」。

- **L1 ⚠️ 预演不预判按槽位卸下**（V6 发现，既有分歧）：`state/patch-rehearsal.ts` 对不带名字、只给槽位的 `unequip_item` 直接放行；提交时槽位为空，内核抛「该槽位无穿戴」，整楼失败。既有断言钉着放行。建议：预演按槽位查当前穿戴，空槽丢该条并记丢弃，同时改那条断言。
- **L2 ⚠️ 装包失败回滚不看标签页锁**（第 2 波审查）：`ui/stores/content-store.ts` 的 `rollbackTo` 用 `importAllData(snapshot)` 整库还原，另一标签页正在游玩的存档会被一起覆盖。建议：回滚前同样经 `findSavesLockedElsewhere` 试探，或把回滚范围收窄到装包涉及的表。
- **L3 ⚠️ fx-foil 混合输入只落进入点**（第 1 波审查）：主输入设备不支持悬停（如触屏 / 平板）但外接了鼠标时，fx-foil 只在 `pointerenter` 进入点落一次光，之后不跟随指针移动 —— fx-pointer 只在 `(hover: hover)` 设备注册全局 `pointermove`。低危，只影响特效。建议：全局指针源改按实际指针类型（或 `any-hover`）决定是否注册。
- **L4 ⚠️ 无标签箭头标题仍判交锋**（第 1 波审查，A6 残留）：修复后带 `→` 的标题只在左边是名字形态或已认出行动者时才判交锋；但面板里没有 `|行动者|` / `|目标|` 等标签行、标题左边又恰好呈名字形态时，仍会被判成交锋。建议：无标签时要求箭头左右至少一侧是已知参与者，名字形态本身不够。
- **L5 ⚠️ entity-gen-parse 的 stacks / maxStacks 解析出 NaN**（第 1 波审查）：`agents/entity-gen-parse.ts` 状态块的 `parseInt(attrs.stacks …)` 无回落，非数字值得 NaN 进 `add_status_effect`。建议：照同函数 `remainingTime` 的写法，非有限值回落 1。
- **L6 ⚠️ projection 仍有手写键 → 字段映射**（V7）：`variables/state-tree-projection.ts` 的键 → 内核字段对应没纳入词表 `kernel` 真源，改词表时可能漏改。建议：投影也从 `state-tree-spec.ts` 读，并纳入 `state-tree-spec-source-gate` 闸门。
- **L7 「永久」时长回落 60 分钟**（第 1 波审查）：entity_gen 状态 `remainingTime="永久"` 等解析不出数值时回落 60，沿用原 `|| 60` 的语义，未改成永久。是否改成 null 待裁定。
- **L8 值类型与协议措辞之间无闸门**（第 2 波审查）：`DIRECT_VALUE_TYPES` 不进协议文本，契约闸门跳过它，两边靠手工对齐。建议：日后给协议行加一条按值类型表生成或比对的断言。
- **L9 `diceUsed` 坏行仍计入「已忽略」**（R1 / R8）：校验后无人消费却计入提示，既有断言钉住，保留原行为。
- **L10 variables 目录外的同类工具重复**（V9）：`state/patch-rules.ts` 的 `isRecord`、`state-manager.ts` 的 `cloneRow` 与 `state-tree-utils.ts` 同类；前端 canonical 改用引擎版后 `undefined` 键视为缺席（行为变化，已记录）。
- **L11 审查员提出、待裁定的两点**（V3）：撤销直写表行、绕过补丁处理器，是否算 ADR-21 的合理例外；更新块修订时该楼记录缺失现在整批失败（行为变化）。
- **L12 R7 裁定保留**：`core/persistence/database.ts` 的 `initializeDatabase` / `createDefaultPreset` 审查时判为无生产调用；按主人裁定保留（约 40 个测试与 test-save 在用），不是遗漏，不再列为待办。
- **L13 建议未做**（第 3 波审查）：非正 `stacks` 剥掉并记 note。

## 裁定结果（2026-11-25 主人裁定）

1. **结构化战斗去留** → **暂不动**。`core/combat/direct-combat.ts` 与各处分支维持现状；R2 不处理开关去留与缺省值，只做拆分与草稿携带。（背景：界面已锁死为关，`structuredCombat` 缺省 true 与生产相反，`direct-generation.test.ts` 29 处解析调用走休眠口径。）
2. **旧形状回落的退出时限** → **长期保留**。`direct-output.ts:789` 旧形状回落与 `direct-output.ts:1028` 信封 `time.delta_time` 不设退出时限；已在设计稿 §7.3 补注。R1 / R2 重构须保留这两条兜底。
3. **beta 节奏** → **暂不发 beta**。第二批的发版事项（版本递增、内容仓收口、真机验证）不排期，等决定发 beta 时再启动；第一批与第三批的顺序另定。
