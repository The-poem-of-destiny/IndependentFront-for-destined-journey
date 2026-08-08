# 变更记录 (CHANGELOG)

> **本文件承载「进行中 + 近期交付」Phase 的详细记录。**
> Append-only，新条目加在顶部。已完成且稳定的旧 Phase（1-9、10a-h）细节见 `docs/phases/` + git log，不在此处重复。
>
> 指令文件（`AGENTS.md`）只保留 ≤30 行的 Phase 速览表，不写历史——历史在这里。

---

## 进行中 / 近期交付（按交付时间倒序）

### 内容-引擎分离 R1-R4 全部完成 ｜ ✅ v1.3 闭环（2026-08-07）

**R1 内容归家**：新私有内容仓 `fated_poem_independent_assets`（GitHub private，
`_private-staging/` 完整等价树迁入，100 文件 136MB）；🔴 全树密钥/PII 扫描首跑抓到
2 个真实 API key（deepseek + siliconflow——后者正是 T0.1 说的公开历史 key）——已 gitignore
排除；84MB 对局导出按主人裁定删除（价值已提炼进战斗样本/agent 分析，README 留记录）；
`tools/scan-secrets.mjs` 常态化。

**R2 pack 构建器**：`tools/build-pack.mjs`——schema 组装 + 编码门 + **D10 黑名单硬拦**
（Overlord / Fate=圣杯战争 / HP=踏星仪式三条 franchise 背景——HP 是化名「雾晶学院/魔法帽」，
靠 git 历史溯源定位）+ provenance 标记（kitsch/D35③ 授权未决）+ 逐节 SHA-256 + 自检。
产物 3.31MB（预估 3.2MB 吻合），15 本世界书 509 条（与设计 max uid≈509 吻合）。

**R3 真实 pack v1.0.0 + 分发**：契约测试（`POEM_PACK_FILE`）全绿——validate 0 error /
新鲜播种 0 冲突 / 编辑冲突路径活着。Release `pack-1.0.0` 已发内容仓；
`MIGRATION.md` 测试者迁移公告（四降级面：美化 22 条/地图标记/捏人目录/曲库 zip 通道）。

**R4 真机三走查**：占位演示环路 / 装包全链路 / 存档迁移全过（主人 2026-08-07 真机）；
key 轮换确认（验收 #7 勾掉）；可选扫尾三处语料文档（ARCHITECTURE 世界观半部 /
combat-v3-stress-test / narrative_context_example）移私有仓——工作树不再有正文级世界观语料。

**真机修出的四个引擎缺陷**（全部合入 master + 回归测试）：

| PR  | 缺陷                                                 | 根因                                                                                                                                                                                        |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #49 | 装包失败零日志                                       | DataSection 空 catch 吞错，只弹 toast                                                                                                                                                       |
| #50 | 装包 DataCloneError「#<Object> could not be cloned」 | `packPending = ref(raw)` 被 Vue 深代理成 Proxy → savePreset(Proxy) / contentPacks.put(Proxy) 落库失败（Q-16 detach 纪律的漏网点——世界书有 detach，presets/整包没有）                        |
| #51 | 装包后美化规则仍是占位 5 条                          | ① boot 竞态：beautifier.init 先于 pack provider 注册，之后没人刷新 ② pack 规则缺字段归一化（`defaultEnabled` 未转 `enabled` → 全判不激活）                                                  |
| #52 | 地图加载失败（12.48MB 图源 30 秒超时中断）           | `MAP_OPEN_TIMEOUT_MS=30000` 砍掉慢网下载 + 只有内存缓存每次刷新重下 → v21 `mapBlobs` 字节本地化 + 下载不设超时 + 进度显示                                                                   |
| #54 | 记忆每轮不落库（7 轮只有 1 条）                      | memory_summary 默认 prompt 教模型「剧情事件/时间为空时 hiddenLine 留空」，而解析器按 Q-03 裁定弃掉空 hiddenLine 的整条记忆 —— prompt 改为必写非空兜底句 + 契约回归测试（私有内容仓同修）    |
| #55 | 进存档对话不自动滚到底                               | ChatFlow 只 watch messages.length：进存档是整数组替换（长度不变不触发）、挂载时消息已就位也不触发 —— 补 onMounted 滚动 + 数组引用 watch                                                     |
| #57 | 快照回退角色不回退 / 对话流只回退不恢复              | ① refreshFromDb 角色同步是合并语义（内存独有角色保留）→ 恢复后角色整表替换 ② 快照不存 messages，恢复只能按 turn 截断 → 新快照随拍消息、恢复整体覆写（向前恢复成立，旧快照兜底截断）         |
| #58 | char_gen 性格编码格式错误（WoAgy(F)）                | 旧版 prompt 广告白名单外幻影工具 call_item_gen → 模型一调报错即放弃全部工具、手编随机值 → 未知工具报错改可行动文案（引导写 XML 请求区块）+ 默认 prompt 工具白名单契约闸门（私有内容仓同修） |

| PR | 缺陷 | 根因 |
**R1-R4 之后补的一处仓库面缺口（2026-08-07）**：波 4 交换时顺手删掉了
`reference/workshop-reference/` 与 `reference/_local-notes/` 两条 ignore（留下两条无 pattern
的孤儿注释）。当时理由成立——`reference/` 整树已离场；但 R1 之后**真实内容会回到本机**
（设计 v1.3 写明可从 `2afc23c` 提取，私有内容仓也发整树），于是这些路径变成
「未跟踪且未忽略」，`git add -A` 一次就能把正文级语料推回公开仓。守门测试按 D32 只扫
`public/data/**`，扫不到这一面。现补一张恢复面防误提交网：`/data/`、`/reference/`、
`tests/agent-framework/`、`worldbook-ejs-corpus.test.ts`、四个内容工具脚本；同时删掉被它
覆盖的三条旧规则（`data/worldbooks/_batch_*`、`.api-config*.json`、两条孤儿注释）。
`git ls-files -i -c` 为空——没有任何已跟踪文件因此被忽略。

---

### 内容-引擎分离 波 4 + v1.3 缩减裁定 ｜ ✅ 波 4 完成（2026-08-07）

**波 4（PR #45，T17 原子交换 + T18 守门）**：真实内容全部离树（15 本世界书 / agent-config /
美化规则 / 目录七件 / `regex-remote-snapshot` / `reference/` 整树 / agent-framework 语料 /
`worldbook-ejs-corpus.test.ts` / 四个内容工具脚本，共 -172,726 行），占位内容落
`public/data/`（URL 不变）；`vite.config.ts` 换 `POEM_CONTENT_DIR` 条件 overlay +
`configurePreviewServer` 挂 BFF；新增守门 `tests/no-world-content.test.ts`（词表轴钉
`public/data/**` + 体量轴）与契约 `tests/contract/pack-install.contract.test.ts`
（`POEM_PACK_FILE` 门控）。CI 绿。真实内容暂存 `_private-staging/`（gitignored，仅在
执行 T17 的机器上；任何机器可从 `2afc23c` 恢复）。

**v1.3 缩减裁定（2026-08-07 主人）**：**不做开源发布**——本仓保持公开仅为让用户核验代码
无害；分离范围收窄至敏感内容本体（世界书正文/预设/提示词）。三仓拓扑（D1/D2/D4/D45）、
快照切仓（T25）、IP 专名清洗（T19/T20 大部）作废；私有仓与构建器缩水为「内容归家 +
本地构建脚本」。剩余工作重排为 **R1-R4**（内容归家 → pack 构建器 → 真实 pack v1.0.0 +
分发 → 真机三走查），聚焦用户导入路径；git 历史敏感内容永久公开被显式接受。
🔴 §5.8 时序现已生效：HEAD 是占位态，测试者拉更新即降级——真实 pack 必须先于他们更新可用。
详见设计文档文首 v1.3 节与实施计划 §6。

### 内容-引擎分离 波 2 + 波 3 —— 代码内 IP 数据驱动化 + 占位内容集 ｜ ✅ 完成（2026-08-06）

设计真源 `docs/planning/2026-08-05-content-engine-separation-design.md`（v1.2 / D1-D45），
编排 `-implementation-plan.md`（8 波 26 任务）。波 0（安全前置）与波 1（provider / pack 机制 /
agents 分层）已于 PR #36-#43 合入，本轮交付 **波 2（T8a + T8-T14）与波 3（T15-T16）**。

**波 2 —— 真实数据出代码，引擎只留 schema + 纯函数 + 注册表读取。**
本波结束时 app 行为与波前完全一致 —— 数据只是换了载体，这是「改造与搬家分离」的关键：
行为回归能在真实内容还在库里的时候就被发现，而不是等波 4 搬完家。

- **T8a（计划外补的前置）** —— 波 1 留下的注册表是**空骨架**，六面全 `undefined`，
  而波 2 七个任务都要往同一处灌注：这是计划没点名的唯一真实撞面。补
  `ensureContentRegistryLoaded()`（六面各自 fetch / 一面失败不拖累其余 / 永不抛 / memoize /
  已装 pack 经 `resolveSection` 继续赢），七个任务的文件面才真正互不重叠。
  卸载包后重拉占位 —— 否则卸个包捏人页与地图页直接空。
- **T8 捏人目录（D24）** —— `start-catalog-data.ts`（8704 行）删除，劈成
  `start-catalog-mechanics.ts`（机制）+ `data/content/catalog.json`（七池）。
  机制文件配了一条**导出名黑名单**结构闸门，防具体条目日后再漏回引擎。
  D9 起源印记区块改可选通用区块（没选就整块不出现，收尾指令不再留悬空的「展现其苏醒」）。
  🔴 Overlord / Fate / HP 三段背景**原样抽进 JSON** —— D10 黑名单在 pack 构建器执行，
  不在抽取时悄悄删，留审计痕迹。
- **T9 / T10（D25）** —— `location-db.ts` 921→292 行、`bloodlines.ts`、`random-tables.ts`
  数据清零走注册表，逐项结构校验、坏行丢弃而不是整表塌。顺带修了一个既有 bug：
  姓氏池为空的种族原本产出 `名·undefined`。
- **T11 地图 + 外链三清（D23）** —— MapPanel 的 `data/` 静态 import 断开（全仓 `src/` 下
  已无一条）；两条 `i.ibb.co` 热链移出代码，图源改由 `branding.mapSources` 供给；
  OSD 雪碧图自托管进 `public/osd/`（从已装 npm 包复制，不下载外部文件）。
  `no-external-assets.test.ts` 扩成扫 `src/**` 的 `https?://` 主机名白名单。
- **T12 era（D9）** —— 线程化而非删字段：`createDefaultTime(era?)` /
  `fromEpochMinutes(em, era?)` / `createDefaultSaveProfile(saveId, era?)` /
  `getProfile(saveId, era?)`，缺省空串（引擎不自造纪元名），存档创建时盖章、此后只读存档。
  选①不选②的理由：去字段要动持久化形状 + 约 60 处 fixture + Dexie 迁移，还会留下
  「老档带 era、新档没有」的半状态。
- **T13 branding / 版本门 / 工坊配置化（D26/D40/D41）** —— `branding-defaults.ts` 中性默认值
  - 注册表 branding 面；favicon / 标题 / dev.bat 等逐项去 IP。
    🔴 `__ENGINE_VERSION__` 要注入**两份 config**：本仓有独立 `vitest.config.ts`，vite 那份
    在测试里根本不生效；且 `define` 只替换**裸标识符**，T1 预留的 `globalThis.__ENGINE_VERSION__`
    注了也永远读不到。两条都踩过，各配一条回归钉 —— 钉红 = 版本门静默恒放行。
- **T14 演示面（D27）** —— test-save / test-fixtures / agent-templates stub /
  placeholder-registry 中性重写；通用奇幻 story 占位预设 11 条目 + 回退 systemPrompt。

**波 3 —— 占位内容集（三级标准：UI 不空破 / 演示环路可走 / 不承诺游戏性）。**

- **T15** —— 15 本占位世界书（同 id / 同分区 / `builtIn:true`，38 条目，
  uid 全在 900001-901402 保留段内，1 条 EJS 动态 + 37 条静态）+
  `scripts/build-placeholder-hashes.mjs`（输入目录参数化，波 4 换 `public/data` 重跑）→
  `src/sillytavern/placeholder-hashes.json`。hash 一致性不靠自觉：测试同时 import 构建脚本与
  `content-source.ts` / `content-pack-plan.ts`，两侧产出必须同串 —— 任一侧改了另一侧没改
  就当场变红（若失守，D20 会把每本没动过的占位书判成「已改」）。
- **T16** —— 占位 agent-config（13 个 id 与真实侧逐字相同，输出契约与工具约定保真，
  只换叙事风格）+ 占位六面（`data/placeholder/content/`，文件名与真实侧逐字相同 —— URL
  同形铁律）+ 占位标记 / 美化规则 / audio manifest。血脉 **id 与 statModifiers 与真实侧一致**，
  只换描述（数值机制变了捏人页数值门会塌）。

**收波时补的五处跨任务缺口**（各 agent 互相报到、没人认领的）：

1. `getProfile(saveId, era.value)` —— SaveProfile 是惰性创建的，这是生产上唯一的创建点，
   不透传等于新档纪元名落成空串，而存档一旦盖章就永不重读内容包。
2. 演示存档 `createDefaultTime(getBranding().era)`。
3. `PackBrandingSection` 与 `BrandingConfig` 对齐 —— `plotTemplate` 是段落数组不是字符串、
   `mapSources` 是 `{key,name,url}` 不是裸 URL 串。schema 与实际解析器对不上，症状是
   pack 供的 branding 静默走形。
4. 真实图源移进 `data/content/branding.json` 的 `mapSources` —— 波 2 铁律是「行为不变」，
   而 T11 删热链时没有把它们放回内容侧，地图会空。
5. 🔴 **占位基线清单读不到**：波 1 的 T7 写的是 `fetch('/data/placeholder-hashes.json')`，
   而清单由 T15 产在 `src/sillytavern/` 下随引擎打包 —— 那次 fetch **永远 404**，
   而空清单是**合法态**（四态回落 updated/conflicted），所以它不报错、不变红，
   只是让 D20 基线、D42 重播种、卸载 re-seed 三处一起静默失效。改成静态 import
   （`resolveJsonModule`），并补测试覆写口 `setPlaceholderHashesForTests`。
   就算把文件放到 `/data/` 也仍是错的：overlay 生效时那里是**真实内容**，
   拿真实内容当占位基线比对，等于把每一本都判成「用户没改过」。

**闸门**：typecheck ×3 干净 / lint 0 warning / knip 棘轮 145 无新增 / prettier 全过 /
**7078 tests passed**（波前 6875，+203）/ 编码门 U+FFFD=0、控制字符=0、JSON 可解析。

**编排上值得记的一条**：波 2 七个任务在同一工作树里并行跑，靠的是「文件面互不重叠 +
撞面显式移交」（`create-store.ts` 由 T8 独占并代执行 T10/T12 的改点，`MapPanel.vue` 由 T11
独占，`agent-tools.ts` 由 T10 独占）。代价是每个 agent 都会看到别人半成品造成的 typecheck 红，
brief 里必须写明「不属于你文件面的错忽略并记悬置」，否则会互相去修对方的文件。

### 测试体系加固 —— 编码闸门 / knip 棘轮 / 属性测试 / lint 收紧 ｜ ✅ 完成（2026-08-05）

起因是一次盘点：**6564 个用例没拦住 PR #22 评审的任何一条缺陷**——问题不是量不够，是**种类不全**
（当时零覆盖率 / 零 E2E / 零属性测试 / 零死代码检测）。本轮补四种**新种类**的闸门，全部进 CI。

**① 编码不变式闸门**（`tests/encoding-invariants.test.ts`，43 用例）——把 AGENTS.md 那条「改中文文本
之后必须验编码」的**手工命令**变成断言。三条判据：U+FFFD=0 / 控制字符=0 / JSON 可解析，且**raw 与
parsed 两遍都扫**（合法转义的退格源码干净、`JSON.parse` 也不报错，但落进字符串值里仍是真退格）。
扫 `data/` + `src|server|tests|scripts` 源码；**不扫** `reference/`（上游语料自带坏字，实测 workshop
正则快照 8 个 U+FFFD、某第三方角色卡 21 个 0x1C）。带「确实扫到了文件」哨兵，防路径写错导致的假绿。
**上线当天就逮到一条真的**：`ejs-backend-parity.test.ts` 里两个**真 0x08 退格**——作者想写正则单词边界，
落地成了退格字节，于是 `Intl` 那条豁免分支**永远匹配不到任何东西**，而测试一直是绿的。

**② knip 死代码棘轮**（`knip.json` + `scripts/knip-ratchet.mjs` + `knip-baseline.json`）——首轮 133 条，
其中绝大多数**不是垃圾**（捏人页 4 个 Vue 组件是 Phase 7d 在途件；图像生成 v1 才落地两天，
`NaiParameters` 这类是刚设计的接口面；抽样验证「未引用导出」多数在本文件内有用，真正修法是去掉
`export` 而非删代码）。故不做一次性大扫除，改**按身份棘轮**：只许变少不许变多，出现基线外的条目就
退出码 1。用身份而非计数，是为了让「修好一条又新增一条」的净零变化也能被抓住。顺手删掉真死的
`vue-router` 依赖（全仓零 import，删后 typecheck/vue-tsc/build 三关照过）。

**③ 属性测试**（fast-check，4 个 `*.property.test.ts`，33 用例）——覆盖 `crop-rects`（此前**零测试**）
/ `image-quota` / `image-anlas` / `image-prompt`。**做过变异验证**：6 个人工注入的缺陷全部被杀，
其中一个正是 2026-08-04 真机那天的 bug（anlas 默认档位从 `unset` 变回 `opus` → 对按点数付费的账户说不要钱）。

**④ ESLint 从提示板改成闸门**——此前 `npm run lint` 有 **193 条 warning 却 exit 0**，且
`no-empty: { allowEmptyCatch: true }` **明文允许**「异常被 catch 咽掉」这一 PR #22 的缺陷类，
更没开类型感知规则（`no-floating-promises` 这类不带类型信息根本无法工作）。现在：`--max-warnings 0`

- 类型感知三规则 + 禁空 catch + `unused-imports` 自动删未引用导入。**逮到 4 处真的 floating promise**，
  其中 `agent-orchestrator.callAgentStreaming` 那处：`chatStream` 拒绝时既没人 resolve 外层 promise
  （整条管线永久挂起）又多一个未处理拒绝，已补 `.catch`。清掉 186 条 unused-vars 基线（约 122 条是
  未引用导入自动删；其余逐条判定：形参/解构/循环变量改 `_` 前缀，确证死掉的声明直接删）。

**顺带发现的两个真问题**（未就地修，属功能改动不是 lint 清理）：`craft-dc.ts` 的 `materialSave`
算出来了**却没进返回值**——「材料节省」整条机制是死的，骰值照收结果照丢，已在原地留注释；
`placeholder-registry.formatCharacters` 是**从未接进注册表**的死函数（已删）。

**验证**：256 文件 / 6648 passed + 4 skipped 全绿；typecheck ×3、lint（0 warning）、knip 棘轮、build 全过。

### skillPower 链路修复 —— 主动攻击技能威力接入 v3 结算管线 ｜ ✅ 完成（2026-08-04）

排查 debug 真机样本发现：item_gen 生成的主动攻击技能（火球术威力 450）**没有进 v3 伤害结算**——
`attack.ts:128` 三 fallback 全 `skillPower:0`，公式「属性×10×层级系数 + **技能威力** + 武器攻击力」
里技能威力项恒为 0；AI 被逼把威力塞进 cast 脚本 `$resource.modifyHp(target,-450)`（战斗外固定伤害，
且 v3 战斗内根本不执行 cast 脚本）。根因是 v2→v3 迁移遗漏：v2 `combat_attack` schema 有 skillPower（AI 填），
v3 按 ADR-28 删了 AI 入口但**没建 Code 入口**（按 skillName 查）。

**单点收口**（`attack.ts:128`）：fallback 链从三层变四层——`payload.ability → activeSkills[skillName] →
attacker.ability → 字面量兜底 0`，敌方 AI / 玩家 / replay 三路径自动受益。**上游通路**：`Skill` 加
`skillPower/relevantAttribute/damageType` + `ItemGenOutput.skills`/`CharGenOutput.skills` 同步加字段；
`parseSkillsXML` 解析 `<skill power="..." attr="..." dtype="...">`（白名单过滤非法值）+ JSON 兜底路径 +
`assembleCharacterState` 三处透传；`characterToCombatParticipant` 摘主动技能 → `CombatParticipant.activeSkills` →
`createCombatState` 透传 → `CombatUnitState.activeSkills`。**item_gen prompt**：`<skill>` 加 `power/attr/dtype`
属性 + 主体威力铁律（禁 cast modifyHp，buff 必须写 `<buffs>` 子元素）。**旁路 D**：effect-parser 废弃
"技能威力"词条映射（防 power 属性与 effect 词条双通道重复计算）。**配套**：`combat-agent-api.md` 的 v2
`combat_attack` 规格加 v3 迁移标注。6 新测试用例（characterToCombatParticipant 摘主动技能 / parseSkillsXML
解析 power / createCombatState 透传 / 旧存档兼容）。**5934 tests 全绿**，零回归。

### 图像生成 v1 —— NovelAI 情景插画（标记锚点 / 三档开关 / CG 图鉴 / 第 13 分区）｜ ✅ 已实施，待真机（2026-08-04）

设计 `docs/planning/2026-08-04-image-generation-design.md`（v1.1 / D1–D55）落地，编排照
`docs/planning/2026-08-04-image-generation-implementation-plan.md` 走 lean-delegation：**实际 7 波 22 个任务**
（原计划 6 波 19 个，偏差与理由已写进该文件开头的「实际执行情况」一节）。

**链路**：story 在正文里就地写 `<scene_image title characters rating>一句中文</scene_image>` 当锚点 →
`GamePipeline.onSceneImage` 三档分流 → `checkQuota` → `image_prompt` 侧链把中文转 danbooru →
`composePrompt` 装配 → `buildNaiRequest` → BFF 透传 → `parseNaiZip` → 落库 → 正文就地渲染 + 进 CG 图鉴。

**引擎纯函数层（9 个新模块，全部无 I/O / 无随机 / 无时钟）**：`types-image.ts`（子系统类型分册，
数据模型也在里面——与 types.ts 既有实体零交织）· `image-defaults.ts`（默认值唯一出处；默认模型刻意
**不是 Curated**，它的官方画质后缀强制带 `rating:general`，本项目要支持露骨内容，带上等于每张图都在跟
自己的提示词打架）· `image-prompt.ts`（承重：角色预设绝不拼进 base、角色负向进**该角色的槽**，官方文档
确认并进 baseNegative 会串味；`normalizeTagString` 全仓唯一一份）· `image-quota.ts`（三层限额唯一判定，
自动/手动共用；记录必须含 queued/generating/failed，否则连点能在第一张落地前全部放行）·
`image-segments.ts`（分段在美化**之前**且不看美化开关，否则流式途中标记会漏成尖括号）·
`image-world-tags.ts`（时段/天气 → 标签，**映射不中一律返空串绝不猜**——天气是 AI 自由文本，
猜错是在画面上画出没发生的事）· `image-anlas.ts`（免费额度**估算**，规则数字只许出现在一处）·
`image-prompt-agent.ts`（侧链两端纯函数、中间一次 I/O；抽不到 `<image_prompt>` 就是明确失败，不启发式兜底）·
`image-providers/novelai.ts`（**三重冗余**：同一份内容展开到 `input` / `v4_prompt` / `characterPrompts`
三处且字段名各不相同，只填一处不报错、只静默产出不对的图，故由同一中间结构一次性展开）。
`marker-protocol.ts` 加 `scene_image`（只动 MARKER_SPECS，Q-05）+ `sanitizeCaption`。

**存储（Dexie v17）**：`sceneImages` / `sceneImageBlobs` / `imagePresets`。删存档连带删前两张，
`imagePresets` 全局不删（与素材库同口径）；FullBackup 收 `sceneImages` + `imagePresets`，
**blob 不进**（字节进 JSON 会爆炸）。记录**先落库再发请求**（D5），`startedAt` 与 `createdAt` 分开
——否则排第三位的图一上来就显示「已用 180 秒」。队列**串行**（NAI 有速率限制且并发同时扣费），
取消 queued 项零网络调用（有断言）。重画**追加 take 不覆盖**。

**前端**：`scene-image-store`（Dexie 唯一口 + 队列 + 状态机，限额/侧链/发请求做成三条注入缝，
生产实现集中在 `lib/scene-image-seams.ts`）· `image-preset-store`（主键 `${kind}:${name}`，name 不归一化）·
`lib/image-client.ts`（唯一网络接触点；成功路径**只准 `arrayBuffer()`**，按文本读会在非法 UTF-8 处产生
U+FFFD 把 zip 悄悄读坏）· `server/routes/image.ts`（复用 `forward()` 管道直通，NAI 没有 CORS 必须走 BFF）·
`SceneImageSegment.vue` + `scene-image-view.ts`（七态真值表抽成纯函数）· CG 图鉴三件套（零新数据模型，
懒加载双保险）· 设置页**第 13 分区** `settings/image/`（三张卡 = 三处不同存储：`agents` 袋子 / `UiSettings` /
Dexie）· ChatFlow 右键「为这一段配图」· DataSection 加本存档插画用量与清理。
前置重构：`AgentConfigPanel.vue` 从 `AgentSection.vue` 抽壳，图像分区第一张卡传不同 `agentId` 复用。

**四条钱相关的铁则，各自钉在一个文件里**：自动档**绝不追溯开火**（`game-pipeline.ts`；回调只在编排器
刚产出这条消息时触发一次，历史消息重渲染根本不经过它——注释已写明日后别为「补全历史插画」加扫描全量的路径）·
限额在 `image_prompt` **之前**（D32，两处都花钱）·「无记录 + auto」出的是**按钮不是去生成**
（`scene-image-view.ts`）· 手动**永不被判成不可用**，最多是要确认（`useManualSceneImage.ts`）。

🔴 **实施中逮到的三件事，都是坑不是功能**：

1. **给 story 的那句指令不写进 `agents.story.systemPrompt`** —— story 有一条别的 agent 没有的短路：
   `buildAgentMessages(story)` 先跑 `assemblePresetContent`，拿到内容就直接用、根本不看 systemPrompt，
   只有「一个预设都没有」时才回退 `fixedSystem + fixedExamples`。往那个字段写字有两种结果、没有一种是
   想要的：有预设时（常态）永远不生效；没预设时**顶掉整份** fixedSystem+fixedExamples。真源是**预设条目**，
   且 `assemblePresetContent` 按条目自身 `enabled` 过滤、**不读 `prompt_order`**（现行 101 条只有 32 条
   真的进提示词）。设计 §8.5 与 AGENTS.md 已同步。
2. **`blurByDefault` 声明了但没人传**，D46 打码整个是死的。根因是只有单组件测试——那种测试能证明逻辑对，
   **证明不了有人供值**。已补从 `ChatFlow` 真渲染到底的链路测试。
3. **`data/defaults/agent-config.json` 有 47 个 U+FFFD 坏字符**（16 段 / 6 个 agent），其中一处落在
   闭合 XML 标签的标签名里（模型看到的是坏标签）。**既有问题，本轮未修**，已另开任务。

**真机走查未做**：NAI 真实响应 zip、0 角色时两个数组、`ucPreset` 按模型各自编号这三点目前只有自压 fixture
做保证；若真机发现不对，改动只落在 `image-providers/novelai.ts` 一个文件里。`image_prompt` 的正式
systemPrompt 也**仍是临时最小版**（带 TODO）——提示词好不好要看真机出的图才谈得上调，是延后的独立任务。

### Q-21 结算层去重 —— 伤害管线两处调用合一 + 制作骰子接线 + 投影拆分 ｜ ✅ 完成（2026-08-04）

审查 `docs/reviews/2026-08-03-code-quality-refactor` 的 Q-21。原文列四刀，**第一刀（集群阈值梯两份）
已由 Q-04/Q-15 的删尸体覆盖** —— `cluster-system.ts` 与 `combat-damage.getClusterAttackCount`
都已不在仓库里，那两份「注释自陈分叉」的死实现连同它们的测试一起没了。剩下三刀本轮全做。

**伤害管线（含 live bug）**：`attack.ts` 里两处 17 字段的 `runDamagePipeline({...})` 收进
`buildDamageInput(attacker, defender, spec)`，两条路径的差异全部落到 `spec` 上、看得见。
两处已分叉的字段里，`damageType` 是当下就在错的：常规路径用
`command.payload.ability ?? attacker.ability ?? {…}`，格挡重算路径却回头读
`attacker.ability?.damageType ?? '物理'`。格挡一记伤害类型异于攻击者基础档的技能（火系法术、
真实伤害），管线 Step 5 会按另一条抗性算，`DamageApplied.damageType` 也报错。现在 `damageType`
冻进 `DamageRecomputeCtx`，恢复路径一个字段都不回头读 `attacker`。顺带：两处手抄的
`initialDamage`（第三份「属性×10×层级系数 + 技能威力 + 武器攻击力」）删掉改读 `damage.initialDamage`；
`finalizeAttack` 那个只被读了 `damageType` 一项的 8 字段 ability 形参收成一个 `DamageType`
（格挡路径因此不必再现编一个 ability —— 那个字面量里的 `'物理'` 正是分叉的第二处落点）；
`outcome.ts` 里逐字段抄自 `DamageRecomputeCtx` 的 `ImportedRecomputeCtx` 删掉，它注释里那句
「避免 types.ts 循环依赖」不成立（本文件已在从 `../types` 取 10 个类型）。

**制作骰子（含 live bug）**：`craft_check` 与 `craft_settle` 各装配一遍 15 字段的
`CraftActionRequest`，且都写 `d20Rolls: []`，注释「Will be rolled inside craftResolver」是错的 ——
`resolveCheck` 原样透传，`craft-dc.rollCraftDice` 落到 `d20Rolls[0] ?? 10`。于是**生产环境
每一次制作检定都是 d20 = 10**，连带**大失败不可达**（判据要 `d20Rolls.length === 1`，而 length 是 0）
与**优势/劣势整条死规则**（`rollCraftDice` 要 `length >= 2`）。与 Q-01 同形状，但 Q-01 的修复
只覆盖了 combat-v3 的 coordinator。现在装配收进 `craft-request.buildCraftRequest`（纯函数、无随机），
骰子在工具边界真掷（`agent-tools.takeCraftTape`，与「内核禁 Math.random、随机源在内核外」同口径）。
`craft_check` 掷的骰带按**请求指纹**存进 per-run 的 `ToolExecutionContext.craftDice`，
同参数的 `craft_settle` 取走 —— 用指纹而不是让 AI 回传 id：骰带不出引擎，AI 编造不了，
同一次制作重复 check 幂等（刷检定无效），换任一项就是另一次制作。
🔴 骰数由优/劣势决定（齐平 1 颗 / 优劣势 2 颗），**不能**图省事一律掷 2 颗 —— 那会让常规检定的
`length === 2`，把大失败判据换个姿势再打掉一次。

**制作投影**：`buildCraftPanelLines` / `buildCraftDescription`（约 140 行 `<action_info>` 竖线表）
搬进 `craft-projection.ts`，照 combat-v3 `projection-agent`/`projection-ui` 的先例。
`buildCraftDescription` 那四个由调用方各算一遍的形参（含自己重算的 `success`）就地推导。
顺手删掉 `craft-resolver` 里 6 个从未用到的 import（其中 `buildSettlementBreakdown` 是
`resolveSettlement` 的另一份实现，留着会让人以为结算读过材料节省）与生产零调用、
内部拿 `Math.random` 掷三颗骰的 `createCraftRequest`（它让任何造「传说」的测试有 15% 概率
被静默升成神话）。

涉及文件: 新增 `craft-request.ts` / `craft-projection.ts`（+ 两份测试）·
`combat-v3/phases/attack.ts` · `combat-v3/phases/outcome.ts` · `combat-v3/types.ts` ·
`agent-tools.ts` · `craft-resolver.ts` · `types.ts`（`CraftDiceTape` / `CraftToolArgs` /
`ToolExecutionContext.craftDice`）· `data/defaults/agent-config.json`（craft_gen 提示词）·
`reference/agent流程测试/agent预期分析.md`

验证: 218 文件 / 5928 passed / 4 skipped（基线 216 / 5883）· tsc & vue-tsc & typecheck:tools
0 错误 · lint 0 error · `vite build` 通过。**两处 live bug 各配了会红的回归测试** ——
把修复逐个还原后，伤害类型那条报 `expected '物理' to be '真实'`，制作骰子那 6 条全红。
🔴 未做真机走查。

### PR #24 审查收口（模型帧脚本策略 / 匹配预算 / 覆盖列表语义 / 开场重试）｜✅ 完成（2026-08-03）

- **模型输出不再顺带拿到脚本面与网络出口**：`<item_info>` / `<task_info>` 卡片的 markup 是**本轮模型输出**，不是用户装过的规则，却和工坊正则共用同一档全开 frame（`allow-scripts` + `connect-src http: https:` + 整份 `regexStorage` 快照内嵌进 srcdoc）。`BeautifierMatchSegment` 新增 `origin: 'rule' | 'model'`，renderer 据此分档：模型帧走 nonce-only `script-src` + `script-src-attr 'none'` + `connect-src 'none'`，且不注入共享命名空间。拦截由**浏览器执行 CSP** 完成，markup 一个字符都不改（不回退到正则消毒）；样式/图片/字体/媒体照旧，卡片视觉不降级。规则帧契约完全不动，工坊兼容面零影响。
- **匹配阶段封顶**：`findEligibleMatches` 的越界重试分支（匹配从文本范围内起头、却越过范围尾撞上前一条规则的占位符）是 O(n²)：贪婪 pattern 每次退一格重来、每次扫到正文末尾。现按扫描字符数记账封顶（`MAX_OVERLAP_SCAN_CHARS_PER_RULE = 5e6`），病态规则退化成「少匹配几处」而不是卡死渲染线程。只卡这一个分支——正常命中的 `exec` 一找到就返回，拿总量卡会误伤「长正文 + 多命中」的正经规则。回归用例去掉封顶后耗时 3.9 s 且断言失败，装上后 9 ms。
- **`beautifierBuiltinDisabled` 语义迁移**：该字段从「强制关掉」改成「相对出厂默认翻转」后，22 条预设里 21 条出厂 `defaultEnabled: false` —— 旧 UI 点它们是空操作，但 id 照样进了列表。不迁移的话老档升级会突然打开这 21 条。新增 `pruneLegacyBuiltinOverrides()`：带标志位、只保留旧语义下真的起过作用的 id（出厂开启的那些），认不出来的 id 保守留着。
- **开场生成失败可重试**：认领发生在长管线之前且刻意不归还，一次 API 抽风就把开场永久烧掉，玩家只剩一句自己的话、没有叙事、也没法重来。新增 `releaseOpeningPromptClaim()`；仅当「一句 assistant 正文都没产出」时归还，重挂载会重跑开场。用户消息已落库时不再重复插入（`run()` 的 `isUserMessage` 按现存消息判定），所以归还不会带来重复正文。
- **清理**：删掉零调用方的 `beautify()`（它还停留在旧的 `builtinDisabled` 语义，与 `mergeRules` 自相矛盾）；`processRules()` 补上「返回值不是可直接 `v-html` 的安全 HTML」的显式警告——隔离边界在渲染面，不在这个字符串里。移除 iframe 上的 `csp` 属性（CSP Embedded Enforcement 从未落地、Chrome 已移除，真正生效的是文档内 `<meta http-equiv>`）。合并 `App.vue` 里重复的 `worldbooks.init()`。
- **仍未收口（已记进审查文档）**：每命中一帧的常驻开销（长对话可累积数百 frame）与 inline 命中会断段——两者都需要真机量化，见 `docs/reviews/2026-08-02-workshop-regex-compatibility.md` 第 10/11 条。

### 输出美化视觉边界收口｜✅ 完成（2026-08-03）

- **根因**：只要消息含一个富正则命中，renderer 就把未命中正文与全部 replacement 拼进同一个 iframe；因此规则的 `body`、`span`、`*`、继承字体或背景等 CSS 仍会影响普通正文。iframe 根的 `color-scheme: light dark` 还会让透明画布按系统暗色偏好绘成深色。
- **边界修订**：未命中正文与内置对话卡片始终留在宿主原生 Vue renderer；每个非原生富命中各自进入 opaque `sandbox="allow-scripts"` iframe。规则自带的颜色体系、HTML/CSS/JS 与完整文档保持原样，但视觉作用域只覆盖该命中，不能触及普通正文或其它命中；跨命中 DOM 查询不再兼容。
- **验证**：组件回归测试以 `* { background:#111; color:#eee }` 钉死边界；青花瓷宽/窄视口真机检查确认普通正文保持透明底与钴蓝文字，深色规则卡片仍在 iframe 内使用自己的深色方案。全量测试与 production build 通过后方可交付。

### 生成链路 / Agent / 正文渲染审查与收口｜ ✅ 完成（2026-08-02）

- **管线成功契约**：默认 `story` 为必需 Agent；缺失、报错、`null`、空白输出或完成处理失败时不再推进回合。`onAgentComplete` 支持异步并由编排器等待，记忆与剧情持久化不再与下一阶段竞速。
- **SSE 结算**：支持 CRLF、多 `data:` 字段、`[DONE]`、尾部 usage 与 EOF；完成/错误只结算一次。`finish_reason` 后有 1 秒尾包窗口，异常常开连接会主动收口，不再无限挂起。
- **正文唯一投影**：新增 `story-output.ts`，流式预览与最终入库共用 `<maintext>` / `<option(s)>` / 控制区块解析；开标签前的内容先缓冲，投影后无可见正文则整轮失败；当前玩家输入只进 `userInput`，不再同时重复进历史区。
- **Agent 工具寻址**：角色名优先、旧 UUID 兼容；制作补丁统一使用角色逻辑名；物品筛选复用字段枚举别名，未知类型显式失败。
- **美化兼容边界**：撤销 DOM 消毒方案。正文编译为转义文本与原样富匹配片段；同一条已提交消息的全部片段进入一个无 same-origin、`credentialless`、`no-referrer` 的 `allow-scripts` iframe，使跨命中脚本与 inline replacement 共享原有 message DOM。外部 HTTP(S) 资源与原生网络 API 放行；form、popup、download、top navigation、嵌套 frame、parent DOM 与应用存储仍隔离，应用 `/api` 拒绝 `Origin: null`。规则 replacement、捕获组、HTML/CSS/script、事件属性、SVG/控件及完整文档保持原样；流式阶段不执行脚本，提交后才创建 frame。向远程/本地网络请求以及外传正文/regex-namespace 数据是明确接受的兼容代价。
- **正则专用持久存储**：Dexie v16 新增 `regexStorage`，整张表就是所有正则、信任级别与规则预览共享的唯一不可信命名空间；工坊更新/卸载不清理，并纳入 `FullBackup`（pre-v16 缺字段时保留现表）。宿主在 authored `<head>` script 执行前完成 hydration，iframe 以同步 `localStorage` 镜像及 `window.regexStorage` 别名读写，mutation 异步落库并向其它 frame 广播；`sessionStorage` 仍是 frame-ephemeral，IndexedDB、应用 storage/Dexie 与 API Key 不开放。配额为每命名空间 5 MiB、1024 keys、单 key 4096 UTF-8 bytes。
- **工坊正则元数据**：只把包含 AI-output `placement=2` 的规则接入 assistant 正文，避免 user-only 规则误投；`minDepth`/`maxDepth` 以最新 user/assistant 消息为 0、忽略 system event、含边界执行。公共语料里 `runOnEdit` 当前不可达，非零 `substituteRegex` 均因 findRegex 无宏而惰性。
- **API Key 迁移**：API Key 从 `fated-poem-settings` localStorage 快照迁入 Dexie `apiEndpoints`；事务写入并回读验证成功后才清理旧 key，任一阶段失败则保留唯一可恢复副本并在设置页提示。API CRUD 改为 Dexie-first。
- **BFF 响应编码**：Node `fetch` 会自动解压上游 gzip/deflate/Brotli 响应但保留 `content-encoding`；代理现与 `content-length` 一并剥离该失效头，避免浏览器二次解压并报 `ERR_CONTENT_DECODING_FAILED`。新增本地 Brotli 上游回归测试覆盖真实转发链路。
- **调试弹窗布局**：工具栏「调试 & 导出」弹窗与 `Alt+Shift+D` 开发抽屉曾共用 `.debug-panel`，Vue 父级 scoped 样式因此把弹窗内容误设为 fixed 并移出布局流；开发抽屉现改用独立 `.debug-drawer`，并新增双调试面的类名隔离回归测试。真机在 1280×720 与 900×700 下确认弹窗恢复正常高度，开发抽屉仍固定于右侧。
- **全量工坊语料**：2026-08-02 完成一次性匿名公共快照审查，覆盖 303/303 项目详情、303/303 payload 响应与 99 条正则（0 编译失败，最高 `$39`）。本地 41.6 MB 语料位于 gitignored `reference/workshop-reference/`；60 条外部资源规则已按联网契约放行，16 条父页面耦合与 14 条宿主 API 耦合仍明确报告降级；历史项目里已持久化的旧「禁止联网」提示会被过滤。storage 报表的 8 条是词法命中；逐条审查确认 5 个项目共 6 条 active、另 2 条只在注释中出现，active 全部仅调用 `localStorage.getItem`/`setItem`/`removeItem`，现由共享持久镜像覆盖。
- **创作者契约**：新增 `docs/reference/worldbook-ejs-regex-authoring-guide.md`，以中文统一规定世界书激活与排序、EJS 语法/能力/持久化/预算/回退、ST 正则字段映射、原生 replacement 语义、联网 iframe 与共享 `regexStorage`。同步校正 `poem-ejs.d.ts` 和文档导航，明确 EJS `local` 当前是每存档共享桶、QuickJS fail-closed 与 50 ms/5 s 预算、99 条语料中 94 条可落地，以及纯正则项目当前缺少存档启用信号。
- **验证**：全量 Vitest 207 文件、5807 通过 / 3 跳过；`tsc --noEmit`、`vue-tsc --noEmit`、Vite production build 与浏览器真机 iframe 探针通过。真机覆盖 pre-head hydration、同 frame 不重载、跨 frame 广播、页面重载持久、sessionStorage 重载清空，以及 parent DOM / IndexedDB / 应用 API 继续不可达。

### 真机 debug 修复轮 · 开局链路（美化/item_gen 批量/词条落库/userId 缓存）｜ ✅ 完成（2026-08-02）

基于 4 份真机 debug 导出（`484c6363` / `0b7f8f6e` / `2743e219` / `e91825e1` / `e91825e1`）逐项定位并修复开局链路的六类问题：

**1. 正文美化完全不生效（🔴 回归，`d185286` 引入）** — `beautifier.ts`

- 根因：P1-01 安全修复在 `processRules` 开头整体 `escapeHtmlBasic(text)`，22 条规则里 13 条依赖字面尖括号（`<dalian>`/`<revue>`/`<lilith>` 等）全部失配。
- 修复：改「原文跑正则 + 占位符保护 + 收尾整体转义」三步 —— 标签规则恢复、XSS 防线不降级。

**2. 技能效果一字一个（🔴）** — `item-effects.ts`（新）

- 根因：item_gen 落库的 `effects` 是**字符串**（`"材料分析:进行任意生产制作时DC-4"`），ItemsPanel 按 `Record<string,string>` 用 `v-for` 迭代 → 按字符拆行。
- 修复：新增 `normalizeEffects` 纯函数，兼容字符串/数组/对象三种形态，抽到 `item-effects.ts` 便于单测。

**3. `<maintext>` 标签漏进正文（🔴）** — `game-pipeline.ts`

- 根因：AI 输出只有开标签 `<maintext>` 无闭合 `</maintext>`，剥离正则要求闭合才匹配 → 标签漏进 message。
- 修复：`extractStoryOptions` 增加未闭合形态剥离。

**4. 初始技能走 item_gen 链路（🔴 断链三处）** — `placeholder-registry.ts` + `agent-config.json`

- 根因：主角 skills 落库为空（留 item_gen）、request_dispatcher 模板**无历史/初始内容注入**、prompt 缺"技能判断"规则段 → 初始技能永不生成。
- 修复：新增 `{{SKILL_STATE}}` 占位符（从 openingPrompt 提取初始技能声明）+ request_dispatcher 模板加 `<已有技能>` 区块 + systemPrompt 加"技能判断"规则段（逐条发 `<item_gen_request itemType="skill">`）。

**5. item_gen 批量生成 + 超时（🔴）** — `item-gen-chain.ts` + `game-pipeline.ts` + `agent-client.ts`

- 串行→批量：`handleItemGen` 从「每 marker 一次调用」改为「批量打包」+ 单批上限 5（调用次数 N → ceil(N/5)），新增 `buildItemRequestsXML` 纯函数。
- 超时：批量后单次调用 240s+ 撞 API 池 60s 默认超时 → `getClientFactory` 给 item_gen 传 300s。
- AI 思考过重：item_gen prompt「思考深度要求」段加批量优先规则（每条目 30-80 字，保证产出 `<item_result>` 优先）。
- `applyAddSkill` 补透传 `modifiers/buffs/divinity/automata`（此前只收 8 字段，item_gen 合法产出的技能 modifiers 落库即丢 → 生产检定加值不生效，与 `applyAddItem` S1/S3 对齐）。

**6. item_info / task_info 卡片结构化渲染（🔴）** — `beautifier.ts`

- story 预设引导 AI 输出 `<item_info>`/`<task_info>` HTML 美化卡片，但引擎不处理 → 标签被转义成文本。
- 修复：规则循环前提取卡片块为富匹配片段，交由同一隔离 iframe renderer；不再使用正则或 DOM sanitizer。

**7. userId 缓存跨存档复用（🟢 降本）** — `agent-client.ts`

- 根因：DeepSeek `user_id` 参与 KVCache 缓存隔离，`fp|saveId|agentId` 让每个存档缓存全 miss → 开新档全价重算（~0.5 元/次）。
- 修复：改为 `fp|agentId`（只按 agent 区分），`parseUserId` 兼容新旧格式回溯。

**回归防护**：beautifier 标签规则/结构化片段/item_info、normalizeEffects 三形态、未闭合 maintext、SKILL_STATE 提取、item_gen 批量打包、applyAddSkill 透传、userId 新格式 —— 全部补测试钉死。**5701 tests 全绿，typecheck 0 错误。**

---

### 工坊 P3+P4 · 真机走查 + 评审修复轮（PR #23）｜ ✅ 完成（2026-08-02）

分支 rebase 到 master（`04ffd80` 之上）—— 分支上原有的 11 个 EJS 提交是 PR #22 的旧版草稿，随 rebase 丢弃，保留 master 上经过评审的那版（回退白名单 7 → 0）。

**真机走查**：B4 写侧（投稿上传 / 编辑 / 删除）+ P3 社交（点赞 / 订阅）已人工走过。B1-B3 未专门走查；B5 审核面因当前账号 `isAdmin: false` **无法自测，已搁置**。

**评审修的三处**（fable 审查，均先写失败测试再改）

- **🔴 并发 toggle 互相抹掉**（`workshop-social-store.ts`）—— 节流键刻意按（项目 × 动作）分开，
  所以「点完赞马上点订阅」是受支持路径，两枪会同时在飞。而 `runToggle` 的校正与回滚都拿**起飞时**
  抓的 `base`/`previous` 整份盖回覆盖层：
  - 两个都成功、点赞后落地 → 点赞的校正用陈旧 base 把订阅的成果重置回起飞前，且因为覆盖层优先于
    响应（§3.3），刷新前不会自愈；
  - 点赞失败、订阅成功 → 点赞回滚 `removeOverride` 连订阅的乐观值一起清掉，随后订阅的校正又从
    含有点赞失败乐观值的 base 里把 `userLiked: true` 带了回来 —— 覆盖层里留下一个服务端从没记过的赞。

  现在校正基线取**落地那一刻**的 `overrides.value[id]`，回滚抽出 `rollback()` 只放回自己那一对字段；
  「回滚后删掉覆盖层」的条件收紧成「起飞前本来就没有 **且** 放回后恰好等于起飞基线」。

- **编辑表单从本地已装库取初值**（`WorkshopPage.vue` / `WorkshopBrowseModal.vue`）—— 「我的项目」列的是
  作者名下全部项目、未必在本地装过，查空就把表单开成空白，而「提交修改」是把 name/description/version/tags
  整份 PUT 上去，一次没留神就把上游还在的简介清成空串、标签清光。上游列表响应本来就带这些字段
  （契约 20 字段含 `description`），现在 `edit` 事件转达**上游整行**，本地那份只做兜底。

- **登录弹窗不验地址**（`workshop-social-store.ts`）—— `window.open` 吃的是起飞端点响应里的
  一个字段，也就是说由服务端（或任何能改写那条响应的人）说了算。两条后果：`javascript:` /
  `data:` 会在与本源关联的上下文里执行（localStorage 里是 API Key、IndexedDB 里是存档）；
  而弹窗**刻意保留 opener**（登录靠 postMessage 回传，`noopener=no`），任何被放行的第三方域
  都能 `opener.location = 钓鱼页` —— 偏偏这个弹窗的全部用途就是让用户在上面输账号密码。
  现在开窗前先过 `isAllowedLoginUrl()`：只放行 https，主机名钉死 `discord.com` 与工坊 worker
  两个域（含子域，且用 `host === a || host.endsWith('.' + a)` 判定，`notdiscord.com` 进不来）。

**补的测试**（+8）

- 两条并发用例：「两个都成功，后落地的不许把先落地的重置回起飞前」「点赞失败回滚不许连累订阅，
  也不许留下幻影赞」。此前的并发覆盖只有节流键分离与字段对隔离，且每个 toggle 都 `await` 过 ——
  **没有任何一条让两枪同时在飞**，缺陷正好活在那个洞里。
- 一条回归：「编辑」转达的是上游整行而非光一个 id（`installed` 刻意留空，复现没装过的那种项目）。
- 五条白名单：非 https 拒（含 `javascript:` / `data:`）· 陌生域拒（含 `notdiscord.com` 这种后缀陷阱、
  以及把域名藏在 query/hash 里的）· 放行 Discord 与 worker 含子域 · 畸形串与相对地址拒且不抛 ·
  端到端「起飞端点给了坏地址 → 一个弹窗都不许开」。
  ⚠️ 同时把三条老用例里的占位登录地址 `https://d/` 换成真实的 Discord 授权页 —— 那个占位符本来
  就没有意义，白名单一上就会被拦。

**验证**：192 文件 / 5620 通过 · typecheck + vue-tsc 零错误 · lint 零错误

**未修（评审列出，判为可后续）**：弹窗 `closed` 旗标声明了没读（关掉弹窗要空等 60s）· 60s 收场时在飞的
poll 可能吃掉并丢弃一次成功登录（KV 单次消费）· `parseToggleAck` 无条件先读 `liked`（上游今天只回一个旗标，
属前瞻）· 零持久化测试只断言了 `likesCount` 缺席，没覆盖整组字段。

### EJS 能力面 · 评审修复轮（PR #22）｜ ✅ 完成（2026-08-01）

外部评审在 PR #22 上 request changes，8 条全部核实属实（读代码 + 真后端探针取证），另外自查出 3 条评审没抓到的。

**修的**

- **能力面接生产**：`buildCapabilityInput()` 此前写好了但**零调用点**，`buildEjsPassContext()` 漏了 `capabilities` 字段
  —— 生产里 `char`/`quest`/`lore`/`local`/`ui`/`engine` 全取默认空值。字段可选 → 编译期不报 → 全绿 CI 掩护着空能力面上线。
- **QuickJS 补齐别名层**：guest 里 `getMessageVar`/`getvar`/`setvar`/`getLocalVar`/`getwi`/`getChatMessage`/
  `matchChatMessages`/`variables`/`YAML`/`TavernHelper`/`toastr`/`alert`/`localStorage`/`console`/`print` **全部缺席**，
  38 个真机片段里 27 个 `ReferenceError`。语义逐条对齐 `buildSandboxArgs`（读取优先级 stats→vars→defaults、危险键、默认值）。
- **QuickJS 支持 `await`**：改 async IIFE + 微任务泵（泵轮数有上限，自我调度的 job 链不能变成绕过 interrupt 的通道）。
- **QuickJS 接上代码位宏改写**：`rewriteCodeMacros` 从 `ejs-runtime` 导出，两个编译器共用同一套规则。
- **QuickJS 逐条目回滚**：进 guest 前存 `vars` 快照 + 宿主侧 `_local` 快照，失败即恢复（对齐 D8）。
- **QuickJS 逐条目播种**：`seed ‖ 条目正文`，与 Legacy 同口径；此前整 pass 一条序列，条目换个位置就换个结果。
- **QuickJS 对齐严格模式**：guest body 加 `'use strict'`。此前未声明赋值在 Legacy 下 `ReferenceError`、在 guest 下静默建全局。
- **🔴 句柄泄漏**：装配期 `unwrapResult` 的完成值句柄没释放，同步条目的 `.catch` reaction job 从没泵过 ——
  `runtime.dispose()` 时 QuickJS 断言 `list_empty(&rt->gc_obj_list)` 失败并 `abort()` 整个 wasm 实例。
  而 dispose 外面那圈 `try/catch` 把异常**咽掉了**：测试全绿，stderr 刷 38 行 `Aborted` 没人看见。
- **三处重复**：危险键集 5 份抄写收敛到 `var-resolver` 唯一导出；`worldbook-loader` 同/异步渲染共用 `partitionEntries` +
  `assembleResult`（分区规则是缓存前缀稳定性的地基，两条路径判定漂移 = 静默缓存击穿）。

**补的测试**

- `ejs-backend-parity.test.ts`（新）—— 根因修复。此前渲染正确性全测 Legacy、QuickJS 只测安全属性，
  「两后端渲染不同」这一整类缺陷结构性无人看守。断言统一为 `legacy(x) === quickjs(x)`（文本 + 成败 + 草稿末态）。
  C 档已登记差异显式豁免并**断言豁免数 ≤ 3**。
- `ejs-backend.test.ts`（新）—— 接缝此前无测试，违反「每个新模块必须配套 `*.test.ts`」。
- lodash T5 十个方法的测试（含 `cloneDeep` 的环 / 危险键）+「写方法一个都不提供」的守卫。
- `agent-templates.test.ts` 能力面接线回归 —— 穿过 `buildAgentMessages` 断言，含「`lore.get` 读不到该 Agent
  看不见的书」这条安全断言。
- `localStorage` shim 的安全用例：这个名字被别名层刻意占着，需单独证明占位的不是宿主那个。

**验证**：184 文件 / 5348 通过 + 3 跳过，`Aborted` 0 次，typecheck / lint（0 error）干净。

**仍未做**：真机走查；`ejs-preflight` 的 UI 接入；SEC-01（与 EJS 无关，`WORKSHOP_ENTRY_ENABLED` 继续 `false`）。

### EJS 能力面 T1-T8 — 隔离后端 + 12 个创作者 namespace ｜ ✅ 完成（2026-08-01）

设计真源: `docs/planning/2026-08-01-ejs-capability-surface-design.md`（含实测数据与全部裁定）。

**一句话**：世界书 EJS 从「参数遮蔽的伪沙盒」变成 **QuickJS realm 隔离 + 12 个显式能力**，
SEC-02 的四条攻击全部实测堵住，同时内置全语料回退 **7 → 0**。

**T1 异步 + 后端接缝**

- `ejs-backend.ts`：`EjsBackend` 接口 + `LegacyBackend`（现行 `new Function`）+ 可替换单例
- 含 `await` 的条目编译成 **`AsyncFunction`**（真机 3 条 `await getwi(...)`）；同步入口对它们给
  可读失败而非假装成功。**不无脑全用 AsyncFunction** —— 那会让上百处同步调用点连同 123 个单测一起塌
- `prerenderWorldBookEntries` 异步预渲染 + `buildAgentMessagesAsync`：
  **`PlaceholderResolver` / `resolveTemplate` 签名一个字没动**（否则 227 个单测跟着改）

**T2 种子随机** — `ejs-rng.ts`。种子 = `hash(saveId ‖ 回合号 ‖ 条目正文)`。
快照回退重放产出**同一份**世界书正文；`{{roll}}` / `{{random::}}` 与 `_.random` 全部改走它。

**T3 stats 扩面** — 背包/装备/技能/状态效果/登神长阶/金钱/队伍/世界(时段·回合·天气·地点)。
P2 设计 D4 曾把这些挂起，实际后果是语料 17 处读全走守卫默认分支 ——
对创作者是**沉默的错误**不是降级。仍不投 `effects/scripts/modifiers/automata`（引擎内部形状，不做承诺）。

**T4/T5 能力面 12 个 namespace**

- `ejs-capabilities.ts`：`chat` / `char` / `world` / `quest` / `lore` / `local` / `ui` / `engine`
- `ejs-fmt.ts`：`fmt.yaml`（语料 5 条刚需）+ 表格/数值/进度条 + **不依赖 `localeCompare` 的 `compareName`**
- `_` shim 17 → **27 方法**（补 `cloneDeep`/`isPlainObject`/`size`/`omit`/`mapKeys`/`forOwn`… 全读边）
- 边界：`lore` 遵守 Phase 8 可见性分区、每条目 8 次预算；`local` 按项目隔离、16/64 KB 上限；
  `ui.notify` 每 pass 3 条 + 同文去重 + **强制「内容说：」前缀**（防项目名伪装成系统提示）

**T6 别名层重接** — `getChatMessage` / `getwi` / `YAML` / `TavernHelper` / `toastr` / `alert` /
`localStorage` / `console` / `message_id` / `lastMessageId` 全部映射到能力面。
`localStorage` **永远碰不到真的 `window.localStorage`**（那里躺着 API Key）。
🟢 **内置全语料（509 条目）回退 7 → 0**。

**T7 QuickJS 后端** — `ejs-quickjs-backend.ts`（quickjs-emscripten 0.32，**主线程**）。实测：

| 攻击                                              | Legacy          | QuickJS                    |
| ------------------------------------------------- | --------------- | -------------------------- |
| `Object.constructor("return globalThis")().fetch` | 拿得到真全局 ❌ | `undefined` ✅             |
| `while(true){}`                                   | 冻死进程 ❌     | interrupt 掐断 ✅          |
| `/(a+)+b/.test("a".repeat(40))`                   | 冻死进程 ❌     | interrupt 掐断 ✅（762ms） |
| `"x".repeat(1e9)`                                 | OOM ❌          | 内存上限拒绝 ✅            |

第三条是 **AST 白名单方案结构性做不到**的（单表达式无循环，`__tick` 执行不到），
而真机 19 个条目用正则字面量 —— 这是选 QuickJS 的决定性证据。
Worker 不需要：interrupt 在主线程就能掐死死循环，宿主能力调用因此保持同步。

**T8 上线 + 创作者体验**

- `installProductionEjsBackend()` 在 `main.ts` 里**不 await** 地切换；现会**急加载 wasm 并跑探针**（审查轮修复），失败 **fail-closed**（不退回 Legacy）：动态条目按原文注入 + `console.error` + 首页 toast 提示
- `public/poem-ejs.d.ts`：创作者类型定义（12 namespace + 别名层全部标 `@deprecated` 并指向新写法）
- `ejs-preflight.ts`：装前预检。语法 / 未知符号 / 跨后端不一致 / 不可复现随机 / 代码位内嵌宏，
  逐条给**可执行的替代建议**。**不阻断安装** —— 职责是让人看见后果，不是替人做决定

**已知能力差异**（QuickJS，§3.14 登记）：无 `Intl` / `structuredClone`；`localeCompare` 非本地化；
**命名捕获组不可用**（真机语料 0 处使用）。全部有 `fmt.*` 替代且预检会标出。

**验证**：全仓 **182 文件 / 5301 tests + 3 skip**，typecheck / eslint 零错误。
新增依赖 `quickjs-emscripten@^0.32`。

**审查轮修复（2026-08-01，PR #22 评审 1-12 项）**

- 沙盒边界收口：vars 快照 / `readBackVars` 窗口补挂 interrupt（堵掉 `vars.toJSON` 死循环冻 UI）；
  `runPass` 创建期收进 try（永不抛穿）；`executePendingJobs` 改真实 `DisposableResult` 形状（空队列早退恢复 + 错误句柄 dispose）；
  install 急加载 wasm + 探针，失败 fail-closed 返 `false`
- 双后端 parity 对齐：`chat.match(RegExp)` 结构化跨界重建、能力预算逐条目重建、`world.isDaytime` guest shim、
  guest lodash 补 `_.chain/.value()`（内置 `dlc.json#477` 生产回退修复）、Legacy `stats` 逐条目深克隆
- 契约修正：`char.affection` 按名索引（原按 id 恒 0）；`quest` 投影改读真实字段（`detail/objective/reward`）；
  `getLocalVar/setLocalVar` 别名统一走 `local.*` 项目桶与护栏
- 装配接线：捏人页大纲改走 `buildAgentMessagesAsync`（不再绕过隔离后端）；同步渲染路径 fail-closed 闸门；
  异步路径 outcome 改按位置配对（uid 撞号不再串文）
- 语料与夹具：语料门 Legacy/QuickJS 双后端双向白名单（QuickJS 侧 0 回退）；混淆器补种子化拉丁词替换 +
  `--transform` 模式，法语诗句/专有名词泄漏清除，防泄漏测试升级
- 验证：**185 文件 / 5399 tests + 3 skip**，typecheck / typecheck:vue 零错误

**审查轮补修（2026-08-01，二次评审复现的两条后端分叉）**

- **trim 语义对齐**：`compileToGuestBody` 原先只跳过 `<%_`/`_%>`/`-%>` 标记字符、不做 trim，
  QuickJS 下大量条目多出空行（107/109 语料条目用 trim 标记）。改为与 Legacy 共用 `tokenizeTrimmed`
  （= `tokenize` + `applyTrim`），两路渲染字节一致
- **guest `__proto__` 漏拦**：guest DANGER 表 `{ __proto__: 1, ... }` 的 `__proto__` 不产生自有属性，
  `isDanger('__proto__')` 恒 false，writePath 能污染 guest `Object.prototype`（同 pass 跨条目串扰 +
  合法 `vars` 写入静默丢进原型）。改用不依赖自有属性的冻结列表分段判定，对齐宿主 `DANGEROUS_PATH_SEGMENTS`
  （**非沙盒逃逸**：realm 边界成立、不跨 pass、不碰宿主全局）
- **渲染字节 parity 门**：原语料门只比回退集合、不比渲染字节，正是上面两条漏网的根因。新增采样字节门
  （排除 19/109 用 `Math.random()` 的条目——未种子化的原生 PRNG 是已知后端差异，可复现路径是 `rng` 命名空间）
- 验证：**185 文件 / 5406 tests + 3 skip**，typecheck / typecheck:vue / prettier 零错误

> 🔒 **工坊入口仍保持下线**：EJS 侧边界已具备，但 **SEC-01（正则 `replaceString` → `v-html` 的 XSS）
> 尚未修复**，它与 EJS 无关、独立成链。

### EJS 能力面 T0 — 混淆真实语料 + 合成语料双闸门（全 CI，零人工）｜ ✅ 完成（2026-08-01）

设计真源: `docs/planning/2026-08-01-ejs-capability-surface-design.md`（§10.5 测试策略 + §11 切片 T0）。

**背景**：仓库 `data/worldbooks/`（509 条目 / 45 含 EJS）只有真机语料的 **4 成**——真机三本命定之诗世界书是 754 条目 / 109 含 EJS / 1524 块。但真实内容不能进 git（4.4 MB + 内容授权协议），且良性语料**测不到危险路径**（`.constructor` / 死循环 / ReDoS 全是 0 命中）。

**交付两套互补语料，都在 CI 跑：**

**① 混淆真实语料**（`scripts/scramble-worldbook-ejs.mjs` + `tests/fixtures/ejs-scrambled-corpus.json` 660 KB）

- 正文**整体换填充串**（不做字符置换——置换保留字频、可被频率分析还原）；`{{宏}}` 保形不保内容（`{{setvar::系统名::XXX}}` 的载荷就是世界观正文）
- 代码区 **CJK 一致置换**：同字恒同 → `getvar('X')` 与 `=== 'X'` 仍相等、`setMessageVar`→`getMessageVar` 读写链仍通
- **ASCII 标识符一致重命名**：抹掉音译人名。白名单含 JS 内建 / 宿主 API / **lodash 方法名** / `localeCompare` 等宿主成员 / 契约 token（`stat_data`）
  - 🔴 实施期踩到两次：漏 lodash 方法名 → `_.chain` 变 `_.n1dbx`，测出来是「方法名被改坏」不是「shim 缺方法」；漏 `localeCompare` / `lastMessageId` 同理。**白名单不全 = 基线失真**
- **生成器自带闸门**：逐条目比对「原文编译结果 == 混淆后编译结果」，不一致拒绝写出
- 测试闸门：双向白名单（16 条已知回退，每条带 `fixedBy` 指向切片）+ 执行不抛穿 + 无残留 `<%` + 失败条目 vars 零残留 + 状态稳定 + **混淆有效性抽查**（9 个专有名词零出现）
- 片段补充：38 个**自足**代码块（跨块 `if {` 半截块由自足性闸门滤掉），含 6 个 `await` 片段作 T1 反向闸门

**② 合成语料**（`ejs-synthetic-corpus.test.ts`，36 例 + 3 skip）

- **A 语法覆盖 15 例**：按真机特征表逐项（跨块 if/for、IIFE、模板串、`String.raw`、展开、可选链、计算下标、命名捕获组、try/catch、`<%#`、`<%%`、未闭合降级…）
- **D 契约不变式 13 例**：pass 内写→读可见、stats 优先、写永不穿透 stats、只读隔离、失败整体回滚（引用不变）、危险段拒写、环安全、静动分层字节稳定、差量前缀与体积护栏、代码位宏改写
- **E 对抗 8 例**：原型污染（写入侧 + 出境侧）、深递归、不可字符串化抛出物、超大输出；**3 例按 `INTERRUPTIBLE_BACKEND` 开关 skip**（死循环 / 灾难回溯 / `repeat(1e9)`——当前后端同步不可中断，真跑会挂死测试进程，vitest 超时救不了），并配**元测试保险丝**盯着开关
- 🔴 **两条「已知洞」用例断言当前事实并要求反转**：构造器逃逸目前**可以**拿回真全局（SEC-02）、`await` 目前编译失败。隔离后端 / AsyncFunction 落地时会红，逼实现者回来更新

**基线（16 条回退，全部有主）**：YAML×2 / getChatMessage×3 / lastMessageId×2 / message_id×1 / `_.cloneDeep`×2（shim 缺 9 方法）/ await×3 / 宏嵌代码位×3（设计内不修）。

**验证**：全仓 **177 文件 / 5186 tests 绿 + 3 skip**，typecheck / eslint 零错误。新增 `npm run ejs:fixture` 刷新夹具。

### 工坊 P2 补丁 — 代码位内嵌 ST 值宏改写（`{{roll}}` / `{{random::}}`）｜ ✅ 完成（2026-08-01）

设计真源: `docs/planning/2026-07-31-workshop-phase2-ejs-design.md` §4（原「注定回退」行已改写为已解决）。

**问题**：上游（ST + 酒馆助手）宏由 ST 核心**先**展开、EJS **后**求值，所以语料写得出 `<%_ if ({{roll 1d100}} >= 100) { _%>`（event.json uid 358）。本引擎 ADR-30 D1 的顺序是反的（EJS 在前、宏剥离在后），照直编译即 SyntaxError → 整条目回退原文注入，模板源码直喂 AI。

**修法**（不动 D1 顺序）：`ejs-runtime.ts` 编译期新增 `rewriteCodeMacros` —— 把**代码位**（`<% %>` / `<%= %>` / `<%- %>`）里的**自足值宏**降成沙盒调用：

- `{{roll 1d100}}` / `{{roll::1d100}}` → `__roll("1d100")`（复用 `dice.ts` 的 `parseDiceFormula` + `rollDice`，公式不可解析取 0 不抛错）
- `{{random::A,B,C}}` → `__random("A,B,C")`（语义对齐 `preset-loader.resolveRandoms`）

**三条不变式**（写进源码头注释，改前必读）：

1. **只动代码位** —— 文本位的宏原样交下游宏链，`{{user}}`/`{{getvar}}`/`{{setvar}}` 既有行为零改动
2. **只认自足值宏** —— `{{user}}` 在代码位多嵌于字符串字面量（实测 dlc#479 / system_core#417 共 5 处），改写反而破坏输出；`{{getvar}}` 取值依赖宏链 setvar 表，求值时机不安全
3. **改写成调用而非字面值** —— 正文字节不变 → `getCompiled` 的 session 级编译缓存照常命中，且每次执行真正重掷（字面值代换会把首轮结果冻死在缓存里）

**验证**：`ejs-runtime.test.ts` 新增 9 例（uid 358 形态、修正量、双冒号写法、不可解析取 0、区间、文本位不动、代码位 `{{user}}` 不动、引号注入、缓存不冻结）；全语料冒烟白名单 **8 → 7 条**（uid 358 出列，反向闸门已验证它真的不再回退）。全仓 175 文件 / 5136 tests 绿，typecheck 零错误。

### 词条效果贯穿链路修复 S4 — prompt 模板 + 失败品链路 + Skill 落库补字段 ｜ ✅ 完成（2026-08-01）

实施计划: `docs/planning/2026-08-01-item-gen-combat-link-plan.md` §3 S4；待办追踪: `docs/planning/combat-v3-fix-backlog.md`。S1-S3 打通 modifiers/automaton 代码链路后，S4 补齐 AI 侧模板 + 失败体验 + 技能生产加值落库（问题 2 + S2-2 收口）。

**S4a Skill 落库补 modifiers（收 S2-2 技能生产加值）:**

- `types.ts` `Skill` 接口补 `modifiers`/`buffs`/`divinity` 字段（S3 已加 automata）
- `char-gen-agent.ts` `assembleCharacterState` skills 映射透传 modifiers/buffs/divinity
- `agent-tools.ts` `collectCraftToolBonus` → `collectCraftBonuses`：同时收集**装备**（toolBonus，C 位）+ **技能**（skillBonus，B 位）「生产检定」modifier → craft_check/craft_settle 两处接线
- **S2-2 闭环**：技能「锻造辅助 生产+3」→ craft_check fixedBonus 含 +3（此前 skillBonus 恒 0）

**S4b craft_gen prompt（agent-config.json）:**

- `<item_requests>` 的 `<request>` 加 `<affix>` 词条意图子元素（`<affix>锻火余温：命中+2</affix>`），成功示例更新
- **失败/大失败也输出 `<item_requests>`**：失败品/残料（type="inventory"、quality=普通），失败 XML 示例 + 标签说明表 + 自检清单同步
- 失败品是象征性补偿，不结算 EXP/FP、不写战斗词条

**S4c item_gen prompt（agent-config.json）:**

- M3.5 的 `<automaton>` 注释段 → **具体 JSON 模板 + 2 示例**（damage.after 吸血 / check.hit 残血追击）+ 18 窗口清单 + trigger 封闭文法 + intents 8 大类 + ctx 根段白名单（防止 AI 产出不合规 JSON 被编译期静默剔除）
- 新增「收到 `<affix>` 必须翻译成 modifiers/automaton」硬性规则；生产向词条 → 检定类 `checkType='生产'` 说明
- `<equip>` 输出格式示例补完整 `<modifiers>`（含 checkType='生产'）+ `<automaton>` 块

**S4d 失败品链路（craft-gen-chain.ts）:**

- `runCraftGenChain`：item_gen 调用条件从 `success && itemRequests.length>0` → `itemRequests.length>0`（成功/失败都发）
- `buildCraftPatches`：失败时只落失败品 add_item（**不 auto-equip** / 不结算 EXP/FP）；成功路径保持 auto-equip + 结算
- 新测试 3 用例（失败装备失败品 / 失败库存失败品 / 成功回归不破坏 auto-equip）

**验收:** S4a（技能生产加值落库 + craft_check 生效）、S4d（失败品落库 / 成功回归）全绿。全量 **5126 测试 / 175 文件全绿**（+5）；typecheck 0；prettier 干净（agent-config.json 经 restringify 字节稳定验证，未跑 prettier）。

### 词条效果贯穿链路修复 S3 — `<automaton>` DSL 自由效果进 v3 战斗 ｜ ✅ 完成（2026-08-01）

实施计划: `docs/planning/2026-08-01-item-gen-combat-link-plan.md` §3；待办追踪: `docs/planning/combat-v3-fix-backlog.md`。S1/S2 打通 modifiers 链路后，S3 让 AI 产的自由效果 DSL automaton（`<automaton>` JSON）走通「解析 → 落库 → 编译 → 战斗生效」全链路（问题 1）。

**解析**：

- `char-gen-agent.ts` 新增 `parseAutomataXML`（复用 parseModifiersXML 容错模式：自闭合视为空 / 跳过注释 / 单行 parse 失败 warn 跳过 / 缺 subscribe+intents 判别跳过）
- 接入 `parseSkillsXML`/`parseEquipmentXML`/`parseInventoryXML` + JSON 兜底 `parseItemGenJSONLoose`；描述预剥离 automaton 块防污染

**类型**：`ItemGenOutput`（skills/equipment/inventory 三组元素）+ `InventoryItem` + `Skill` + `CombatParticipant` 加 `automata?: EffectAutomaton[]`（type-only import combat-v3/types）

**落库**：`assembleCharacterState`（三处透传）+ `applyAddItem`（补收 automata）+ `buildCraftPatches`（equipment/inventory 透传）

**编译**：`characterToCombatParticipant` 收集已装备物品 automata + **被动技能** automata（主动技能不走被动效果）→ `CombatParticipant.automata`；`createCombatState` `compileEffectProgram({...automata})` 编译进 activeEffects。DSL 编译期 9 条校验（A3-3）自动兜底不合规 automaton（subscribe 越界等剔除）。

**验收**: S3-1 ~ S3-4 全绿（解析 4 用例 + 编译 2 用例 + 落库 2 用例 + participant 收集 4 用例）。全量 **5121 测试 / 175 文件全绿**（+12）；typecheck 0；prettier 干净。

### 词条效果贯穿链路修复 S1+S2 — 物品/技能介入制造 + 落库链路 ｜ ✅ 完成（2026-08-01）

实施计划: `docs/planning/2026-08-01-item-gen-combat-link-plan.md`；待办追踪: `docs/planning/combat-v3-fix-backlog.md`。M5 退役 v2 后排查发现，item_gen 生成的装备词条（modifiers）在 v3 战斗/制造里没生效。本批修正向链路（落库丢 modifiers）+ 反向链路（物品/技能介入制造）。

**S1 正向链路闭环（applyAddItem 落库补收 3 字段）:**

- `state-manager.ts` `applyAddItem` 此前只收 9 字段，丢 `modifiers`/`buffs`/`divinity` → craft_gen→item_gen 产物 + item_gen 独立链（开局/char_gen）装备词条都落不了库。现补齐，一条修复通两条链。

**S2 反向链路（物品/技能介入制造）:**

- `effect-types.ts` `CheckModifier.checkType` 加 `'生产'`（世界书《品质效果限定》检定类含生产检定修正）
- `combat-item-validator.ts` `VALID_CHECK_TYPES` 加 `'生产'`
- `agent-tools.ts` `craft_check`/`craft_settle` 新增 `collectCraftToolBonus()`：从已装备物品收集「生产检定」modifier → `toolBonus`（世界书《生产制作协议》检定加值 = 属性+技能+道具+身份）
- **S2c 世界书语义落地**：`craft-dc.ts` `calcCraftCheck` 把 toolBonus 从 DC 减免拆出——**只进 fixedBonus（检定加值分子），不再同时减免 finalDC**（「检定加值」与「DC 减免」是两条独立声明）
- **防泄漏**：`compile.ts` 检定分支 `checkType='生产'` → 返回 null（不编译进战斗，否则 slotMap 落到 hitBonus 误成命中）
- **skillBonus 留 0**：落库 `Skill` 接口无 modifiers 字段，技能生产加值待 S4 补（字段级已支持）

**验收:** S1-1/S1-2（落库保留）、S2-1（装备生产+5 → craft_check 含 +5）、S2-3（回归护栏）、S2-4（战斗不误收）全绿；S2-2（技能生产加值）阻塞待 S4。全量 **5109 测试 / 174 文件全绿**；typecheck 0；prettier 干净。新增 6 用例。

### 战斗 v3 M5 — 收尾：默认翻 v3 + 退役 v2 + 文档同步 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§十四 引擎边界 / §十五 模块迁移映射表）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §8。把 v3 从「可选引擎」翻转为「默认引擎」，退役 v2 战斗运行时。**战斗 v3 全里程碑（M0→M5）收尾**。

**PR1（翻默认 + 文档，不删代码，观察一版本周期）:**

- `types.ts` `combatEngineVersion` 默认 `'v2'` → `'v3'`（A5-1）；`game-pipeline.ts` 分支点兜底 `?? 'v3'`（旧存档无字段也走 v3）
- 文档同步（A5-4）：v2 架构文档加退役横幅（保留作为纯计算规则引用）/ `combat-agent-api.md` 标 v2 专用 + 指向 v3 接口 / handoff 文档收尾 + §2 待补完表标 ✅ 指向架构节号 / AGENTS.md 架构图加 `combat-v3/` 子目录 + ADR-20/29 补战斗内走 DSL

**PR2（真正退役 v2，主人拍板选 A）:**

- 🗑 删 6 文件（含测试 12 个）：`combat-runner` / `combat-pipeline` / `combat-actions-pipeline` / `combat-modifier-inject` / `combat-resolver` / `combat-settlement-pipeline`（职责已由 v3 接管）
- 🆕 `combat-v2-types.ts`：迁移存活契约（CombatClient/CombatEvent/PipelineContext/COMBAT_EVENTS/characterToCombatParticipant），v3/agent-tools/game-store/morale-pipeline 改指
- v2 分支优雅退役：`game-pipeline.ts` 打回 'v2' → 优雅提示（不炸、无悬空 import，A5-2）；`agent-tools.ts` 删 `AGENT_TOOL_MAP['combat']` + executeCombatToolCall + 19 v2 工具（保留 `combat_v3`）；`agent-config.json` 删 combat 条目（python 精确切片，保留 combat_v3）
- ✅ 保留（v3 内核在调）：`combat-panel` / `combat-damage` / `combat-intention` / `combat-turn` / `combat-morale-pipeline` / `combat-item-validator`

**验收:** A5-1 ~ A5-4 全过（默认 v3 / v2 优雅退役可打回 / typecheck+test 全绿 / 文档 4 处同步）。全量 **5101 测试 / 174 文件全绿**（5245 - 144 v2 测试块）；typecheck 0；prettier 干净；零残留引用。

**遗留:** `game-pipeline.ts` 的 flag 分支结构保留一个版本周期（下个周期再删 'v2' 分支与 flag 本身）。

### 战斗 v3 M4 — 压力测试：7 场 fixture 全绿 + RuleKey 补全 + divinity 泛化 + eventHash 冻结 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§八 closed RuleKey 与 divinity 压制 / §九 反射专项 R1-R8 / §十三 DomainEvent）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §7。这是**最重的一个里程碑**——机制层（4 RuleKey + divinity 泛化）+ 窗口接线层（修 M3 真实缺口）+ replay harness 升级 + 7 场 fixture 端到端 + eventHash 冻结。

**机制层（A4-3/A4-4）:**

- `rule-keys.ts` — 四把 RuleKey 全注册（terminal.forceTerminal / morale.forceState / action.freezeSlot / death.threshold，各带 schema + divinity 门槛 + merge policy）+ `resolveOverride` 真正解析 + **`divinitySuppression(atk, def)`** 泛化：差 1~4 级 → ±20%/40%/60%/80%，≥5 级 → `{ certain: true }`（必成/必败，**不消费骰子**）
- `phases/attack.ts` — check.intent 意图对抗接压制（差≥5 跳过 intentCheck 骰，A4-4）+ unit.beforeDown 接 death.threshold（PreventDeath → DamagePrevented + 同批原子提交，A4-3）
- `intents.ts` — ApplyStatus.contest 接压制（守方 div 高≥5 状态抵抗）+ OverrideIntent → freezeSlotPatches
- `unit-turn.ts` — action.freezeSlot 生效（被冻结槽位不发）+ turn.open 窗口触发源
- `state.ts` — applyPending 合并 frozenSlots（max_rounds）+ applyOutcome 落 frozenSlots

**窗口接线层（修 M3 真实缺口）:**

- `attack.ts` `finalizeAttack` ⑨ damage.after **不再丢弃 evaluateWindow 结果** → `applyAfterWindow` 接 applyIntents（**M3 遗留：反射 intent 从未落地**，case-24/x1 跑不通的根因）
- **`reflectChain` 链式反伤递归**：depth 传播 + 每轮查新受击方被动 + R6 depth≥2 → `mutual_cancel` + `NarrativeCue('反射湮灭')`（case-x1 互反熔断，A4-2）
- R8 反伤命中骰 attackHit 通道 + 优势/劣势 + BeginOutput 续杯
- `windows.ts` resolveNumber 补全：parseExpression → evaluate → fallback（错误隔离不抛出），`ctx.damage.preReduction * N` 表达式可求值

**replay harness 升级（A4-1 地基）:**

- `replay.ts` — **M0 空转 → 驱动真实内核**（openCombat + dispatch 循环），RequiredInput 自动处理（BeginOutput 续杯 / PlayerCommand / CharGenRequest / EffectChoice / BoundedAdjudication）
- hash 基于 **DomainEvent 序列**（A4-5）；`fixtureBundle` 统一英文 attrs
- `reducer.ts` `adjudicate` — `terminal.forceTerminal` 落 `state.terminal`（case-09 认知剥夺终局生效）

**7 场 fixture + contract test（A4-1/A4-2）:**

| fixture                               | 断言重点                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------- |
| case-06-summon（全量）                | 召唤端到端：UnitSummoned + this_round_tail 当回合参战 + FP 300→200          |
| case-07-prevent-death（全量）         | PreventDeath 保命（death.threshold）                                        |
| case-09-concept（全量）               | damage + roundCount + forceTerminal 落 state（Adjudicate → RuleOverridden） |
| case-13-time-freeze                   | freezeSlot 端到端：理查德 TurnOpened 0 攻 0 动                              |
| case-24-reflection（全量）            | 反射 depth=1 落地 + 攻方 HP 扣减                                            |
| **case-x1-mutual-reflection**（新增） | 双方 30% 反伤 → depth 2 熔断 → 反射湮灭 + 无 depth≥2 事件                   |
| **case-x2-true-death-revive**（新增） | HP→0 → death.threshold（divinity 6）→ 保命 + DamagePrevented                |

**eventHash 冻结（A4-5）:** 7 场 fixture 的 `expected.eventHash` 从 null 升级为具体 hash（h1vj9zgo 等），contract test 断言 `result.hash === fixture.expected.eventHash`——此后任何改动导致 hash 变化必须在 PR 说明。

**顺手修的:** `applyPending` 同名 buff tick 语义（remainingTime 不同=覆盖/相同=叠层）；DamageReflected.depth 用本轮深度（修 OBO 偏移）。

**验收:** A4-1 ~ A4-6 全过（5 场全量 + 2 极端 + 4 RuleKey + divinity 泛化 + eventHash 冻结 + 第 07 场续杯）。全量 **5245 测试 / 180 文件全绿**（combat-v3 291 / 35 files）；typecheck 0；prettier 干净；no-nondeterminism 守卫通过。

### 战斗 v3 M3.5 — 开放性出口：CharGenRequest + BoundedAdjudication + prompt 改写 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§十 char_gen 战斗中调用 / §十一 BoundedAdjudication 有界裁决）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §6。把 v3 内核从「封闭战斗」打开——召唤走 char_gen（CharGenRequest），创意效果走有界裁决（BoundedAdjudication），并改写 `combat_v3` / `item_gen` / `char_gen` 三个 prompt。

**新建 3 文件:**

- `combat-v3/adjudication.ts` — `evaluateAdjudication(p, state)` 纯函数六步验证（照架构 §11.2）：divinity 硬门槛 <5 reject（**A35-4**）/ 目标合法 / RuleKey 已注册 / 不变量 / 边界 / 冲突检测；通过产 `AdjudicationAccepted` + `RuleOverridden`（或 `MiracleTriggered`）+ journal 带 reason（A35-5）
- `combat-v3/summon-pool.ts` — §6.4 预生成召唤物池最小实现（key 归一化 + `lookupSummon`），内容留空走实时 char_gen（「M3.5 不做也能验收」）
- `combat-v3/phases/spawn.test.ts` — A35-1/2/3 + actionEconomy 三态 + FP 原子扣费

**关键改动:**

- `coordinator.ts` — 替换 M2 两处 `throw UnsupportedInM2`：**CharGenRequest** 路由（③a 先查池 → ③b `await runCharGenForCombat` → ④ 解析校验 `SummonedUnitDefinition`（divinity≤cap clamp / 属性总和≤budget 等比缩放 / joinTiming 缺省 next_round_head / automaton 走 compileEffectProgram 失败剔除不阻断）→ ⑤ 提交 `SupplyUnit`）；**BoundedAdjudication** 路由（调 evaluateAdjudication，reject → EffectRejected(ADJUDICATION_REJECTED) 流回；通过 → 提交 `Adjudicate`）。**EffectChoice 保留 throw**（plan §6.7 只要求替换另两路）
- `reducer.ts` — `SupplyUnit` frame 恢复分支（plan §6.2 ⑥）：从冻结 frame 续跑 → 插 state.units → joinTiming='this_round_tail' `draw(initiative,1)` 插先攻序列尾部 / 'next_round_head' 下轮参与 → actionEconomy 三态槽位 → duration → `ApplyStatus('召唤时限', rounds)` → automaton 增量进 ActiveEffectIndex → **与 SpendResource(FP,100) 同一次原子提交**（不变量④）→ `UnitSummoned` + `ResourceSpent`；`Adjudicate` 内核重锤验证（持完整 CombatState 验 target.divinity）产事件 + journal
- `phases/action.ts` — `SpawnOrDespawnIntent` 且 `templateRef` 缺省 ⇒ freeze spawn frame 返回 `RequiredInput.CharGenRequest`（A35-1，内核不存 Promise）；命中 ⇒ 直接产 UnitSummoned
- `phases/round.ts` — 召唤时限到期 `round.close` 移除 → `UnitDespawned` + updateIndex 摘 automaton（A35-3）
- `char-gen-agent.ts` — 新增 `runCharGenForCombat`（战斗中、单个、**不落库**，复用现有链跳过 buildPatches/DB）；与 `runCharGenChain` 并列，不改现有入口
- `types.ts` — 定型 `Adjudicate`/`SupplyUnit` payload、`RequiredInput.CharGenRequest`/`BoundedAdjudication` 完整形状、新增 `SummonedUnitDefinition`/`ProposedAdjudication`/`AdjudicationResult`
- `state.ts` / `phases/outcome.ts` — `removeUnitIds`/`activeEffects` 收进 `applyOutcome`；修 `applyPending` 同名 buff tick 语义（remainingTime 不同=覆盖，相同=叠层）

**prompt 改写（`data/defaults/agent-config.json`，raw slicing 禁 prettier）:** `combat_v3` 删除掷骰指令（骰值由内核提供）+ 删除判输赢调 combat_end（终局内核判）+ 改为逐步决策模式（每次一个 Command）+ 新增「无法用标准动作表达 ⇒ submit_adjudication，且仅当 divinity ≥ 法则级」+ 保留叙事摘要（write_summary ≤500 字）；`item_gen` 输出改 `<automaton>` JSON 块 + 格式约束段（subscribe 窗口清单 / trigger 封闭文法 / intents 8 大类 / divinity ≤ 物品声明）；`char_gen` 新增 `combatParticipation` 输出段。**采 additive**：新增段为可选，保留 `<script>` 主链（避免破坏 assembleCharacterState 与既有测试）。

**`reference/agent流程测试/agent预期分析.md`:** 新增 §5.5 combat_v3 完整输出追踪（思维链 → 工具调用序列 → JSON）+ 下游解析链路。

**验收:** A35-1 ~ A35-5 全过（templateRef 缺省触发 / joinTiming 时序 / 时限到期移除 / divinity<5 reject / 通过产事件+journal）。全量 **5191 测试 / 169 文件全绿**（新增 25）；typecheck 0 错误；prettier 干净。

**已知遗留（M4 对齐）:** 第 06 场 fixture 端到端（A35-6）未做——fixture 是 concept 版（`_synthetic`，用老 DeclareAction+summon payload 结构），与 SpawnOrDespawnIntent 内核流不对接，M4 重做；`<automaton>` JSON 实装消费（compile → windows 求值）归 M4；`runCharGenForCombat` 召唤物防御/DR 用保守默认 0，后续精化。

### 战斗 v3 M3 — 效果系统：DSL + 编译链 + windows 实装 + damage.preview ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§五 ReactionWindow / §六 EffectIntent / §七 EffectAutomaton DSL + 编译链 / §九 反射专项）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §5。把「效果」从 v2 的任意 JS 脚本（`new Function` 执行）翻转为**声明式 automaton + 封闭微文法表达式**，`windows.ts` 从空转变实装。**战斗内全链路零 `new Function` / `eval`**（铁律 2，C1 战斗内消解）。

**新建 `combat-v3/automata/` 子目录 + 2 文件:**

- `automata/parser.ts` — 递归下降 parser：token 集封闭、词法期拒绝白名单外 token（`=`/`[`/`{`/反引号/`;`/`new`/`function`/`this`/未知标识符）、`ctx.` 点分路径合并、`parseCmp` 非结合（`a<b<c` 报错）、**`ExprSyntaxError` 带 1-based 列号**（A3-1）
- `automata/interpreter.ts` — 零 eval AST 解释器：字面量/路径/白名单函数（min/max/floor/ceil/abs/percent/has）/一元/二元；除零返回 0；未定义 ctx 路径抛 `ExprEvalError`（错误隔离）
- `automata/compile.ts` — `compileEffectProgram` 三来源编译链（① `modifiers[]` → push-handler automaton（ADR-29）/ ② `ParsedEffect` → 内建 adapter / ③ AI automaton JSON）+ **9 条编译期校验**（窗口存在/trigger 文法/kind∈8 大类/RuleKey 白名单/divinity≤所有者/数值 clamp/ctx 路径根段/五维直改/前缀，A3-3）
- `automata/builtins.ts` — 15 条内建映射（固伤/伤害%/受到伤害-%（修 M-6）/命中/闪避/先攻/DR/穿透/反伤/吸血/护盾/DoT/HoT/暴击率/次数）
- `automata/index-active.ts` — `buildIndex`/`updateIndex`：按窗口分组并按 §5.3 排序、离场移除
- `automata/reflection.ts` — 反射专项（§九）：R4 preReduction 基准 / R6 depth=2 熔断产 `NarrativeCue('反射湮灭')` / R7 基准不放大 / R8 attackHit 通道
- `intents.ts` — `validateBatch`（batch 内一个非法 ⇒ 整批 reject + `EffectRejected`，**不取消**核心攻击与同窗口其他 automaton，A3-7）+ `applyIntents` 解释执行
- `windows.ts`（实装）— 求值顺序（窗口→divinity→priority→stable id）/ 在场过滤 / charges 耗尽跳过 / trigger 错误隔离 / batch 原子性 / **预算 64 截断 + BUDGET_EXCEEDED**

**damage.preview 全流程（§5.4）:** `phases/attack.ts` 步骤⑥ 接 `RequestChoice`：`hasSubscribers` 判空 → 有订阅者则冻结 `ResolutionFrame` → 返回 `RequiredInput.EffectChoice`；`reducer.ts` 加 `DeclareBlock` frame 恢复分支 → 格挡 intent batch → **回到 `damage.compute` 重算**（不在 final 上打折）→ 487→97 比例。无订阅者**不暂停**（A3-6）。

**修改文件:** `combat-item-validator.ts` 新增 v3 共享常量（`V3_WINDOW_KEYS`/`V3_INTENT_KINDS`/`V3_RULE_KEYS`），**v2 运行时入口保留不删**；`phases/outcome.ts`/`round.ts`/`action.ts` 适配 Windows ctx；`state.ts` 加 `freezeFrame`/`restoreFrame`。

**验收:** A3-1 ~ A3-8 全过（parser 列号 / evaluate 零 eval / 编译期剔除 / modifier push-handler / 487→97 重算 / 无订阅不暂停 / batch 原子性 / 第 24 场反伤 depth=2 熔断）。全量 **5166 测试 / 166 文件全绿**；typecheck 0 错误；lint 0 error。

**M3 修复的 Critical/Major:** C1（战斗内消解：全链路零 `new Function`）/ M-6（守方百分比进 `collect_defender_mods`）/ M-2（ActiveEffectIndex 通电）/ M-12（窗口递归 ≤5 + 反射 depth ≤2 + 预算 64）/ M-15（automaton 返回 undefined 视为空 batch）。

**已知遗留（M3.5 对齐）:** Coordinator 的 `EffectChoice` 路由仍 `throw UnsupportedInM2`（M3 只做内核，M3.5 接 game-store→UI 格挡询问）；`makeWindowRuntimeCtx.resolveNumber` 对非数字表达式返回 fallback（M3 范围限于 damage.preview 全量求值，其余窗口表达式求值 M3.5/M4 补全）；`reflection`/`charges` 内建特判。

### 战斗 v3 M2 — 接线：Coordinator + feature flag + 双投影 + 前端桥 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§十三 双投影 / §十四 引擎边界 + Coordinator + feature flag + 四态 UI / §十二 FP 协议）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §4。把 M1 的内核骨架接到真实业务路径：Coordinator 驱动完整战斗循环、feature flag 整场切换、投影 A（UI）/B（Agent 文本面板）、前端 Command 桥。v2 路径一行未删（flag 默认 `'v2'`）。

**新建文件（`combat-v3/`）:**

- `index.ts` — **唯一公共出口**：`openCombat(NewCombat | RestoreCombat): CombatSession` + 公共类型 + `runCombatV3`（coordinator 公共 seam）。internal 一律不导出（架构 §十四 14.1）
- `coordinator.ts` — `runCombatV3(opts)` 协调循环：openCombat → 首注骰 → dispatch 循环（无 requiredInput 则自动推进）→ 终局 RequestSettlement → **一次 `commitChatState`**（A2-1）。`routeRequiredInput` 四路由穷尽 switch（`default: never` 兜底，A2-3）：PlayerCommand（玩家→store / 敌方→Agent）/ BeginOutput（注骰）/ EffectChoice·BoundedAdjudication·CharGenRequest（M2 `throw UnsupportedInM2`）。`abandon()`：session 丢弃、FP 不落库、解除 isGenerating（**C4**）。敌方 Agent 工具预算 `MAX_TOOL_ROUNDS=8`，超限自动 pass
- `projection-ui.ts` — 投影 A：`projectToUi(events)` 对 **29 个 DomainEvent 穷尽 switch**（A2-6，漏一个编译不过）。v3 新增映射为 `v3_*` CombatEvent 变体（扩展 `combat-runner.ts` 的 CombatEvent 联合），v2 分支保留
- `projection-agent.ts` — 投影 B：`projectToAgent(view)` 从唯一 CombatView 生成 `<action_info>` 文本面板（M2 基于 CombatView 而非内部 CombatState——kernel 闭包藏 state，已标注为 M3 若需完整状态再调整）
- `fixtures/case-09-concept.fixture.json` + `case-09.test.ts` — 第 09 场端到端（真理火球 / 处决人 / FP 2400），断言 `roundCount` / `damage` / `terminal.reason: 'force_terminal'` / `fpDelta`

**修改文件:**

- `game-pipeline.ts` — `handleCombatTrigger` 加 **feature flag 分支点**（唯一，架构 §十四 14.5）：`combatEngineVersion === 'v3'` 走 `runCombatV3`，`'v2'` 走现有 `runCombat`（:1196-1225 保留）。v3 分支组装 bundle（`characterToCombatParticipant` 复用 combat-resolver）+ 前端 Command 桥（pending resolver）+ coordinator 句柄暴露给 store
- `game-store.ts` — 新增 `v3ActiveCombat` / `combatCoordinator` 句柄 / `submitCombatCommand`（自动补 `commandId`+`expectedRevision`）/ `abandonCombat` / `applyCombatEvent` v3 变体分支；v2 分支保留
- `agent-tools.ts` — 新增 `AGENT_TOOL_MAP['combat_v3']`（6 工具 + 4 只读，§4.4）；**不动** `['combat']`（v2 回滚要用）
- `agent-config.json` — 新增 `combat_v3` agent 条目（最小可用：逐 Command 决策、不掷骰、不判终局）
- `combat-runner.ts` — `CombatEvent` 联合扩展 v3 变体（`v3_*`），v2 变体原样保留

**验收:** A2-1 ~ A2-6 全过（v3 端到端一次 commitChatState / v2 行为完全一致 / RequiredInput 四路由穷尽 / abandon 不落库 / 摘要回注 / 29 DomainEvent 全映射）。全量 **5050 测试 / 157 文件全绿**；typecheck 0 错误；vue-tsc 0 错误；lint 0 error。

**M2 修复的 Critical/Major:** C4（abandon 流程）。M1 已修的 C3/C5/C6/C7/M-1/M-3/M-4/M-9 由 A2-1 端到端验证。

**已知遗留（M3 对齐）:** 前端 Vue 组件（CombatActionBar/CombatPanel 等）留最小改动、当前仍走 v2 渲染路径（标注 M2.5 前端完善）；`projectToAgent` 基于 CombatView 而非完整 CombatState（kernel 闭包藏 state）；`toPatches` 只算 FP 结算 patch（EXP/战利品 M4 settlement.before 补）；EffectChoice / BoundedAdjudication / CharGenRequest 三路由 `throw UnsupportedInM2`。

### 工坊 P4 — 上游功能对齐（B1–B5）｜ ✅ 完成 待真机（2026-08-01）

参照物: 上游工坊自己的两个客户端（`github.com/AkabaneSaki/myrepo`，本地克隆 `E:\Projects\myrepo`）——
worker 托管的工坊页 `cloudflare/src/pages/home/*`（~2100 行字符串拼装的原生 JS）与 ST 扩展
`src/CreativeWorkshop/*`。**方向是抄功能不抄实现**：我们有类型、有测试、有主题体系，
上游那套 `innerHTML` 全量重绘 + 手写 `escapeHtml` 的做法照搬进来是倒退。

**B1 展示面**

- `workshop-cover.ts`（新）— 封面候选链 `wsrv.nl 代理(640/webp) → 原图`，组件按序试、走完交回自己的首字母兜底。
  上游封面存 R2 原图（3 MB PNG 是常态），一页 20 张直连原图 = 开一次浏览模态下 60 MB
- `workshop-upstream-error.ts`（新）— Cloudflare 平台错误**优先于**业务错误：1027 日额度耗尽 / 1102 资源超限 /
  429 限流 / HTML 拦截页。⚠️ 顺序要紧——平台错误体有时也是带 `message` 的 JSON，那句 message 是英文栈信息
- 类型徽章（系统/扩展/角色/事件）+ 卡片下载数 + 加载更多分页（替掉上一页/下一页）

**B2 账号面**

- `WorkshopListingMeta`（新，第二个 sidecar）— 作者身份 + 审核状态。与 `WorkshopSocialMeta` 同一条纪律：
  **纯内存、绝不落库**。不并进 `WorkshopProjectMeta` 是因为那个类型是落库实体的投影
- `listMyProjects()` — 上游一次全量返回、不吃任何筛选参数，所以该视图的搜索/标签只能落到本地，
  排序与「加载更多」整个不出现（摆一个点了没反应的控件比没有更糟）
- 三视图切换：全部 / 我的项目 / 订阅与已装。后者是纯派生视图，不发请求

**B3 更新改动预告**

- `workshop-diff.ts`（新）— ★ 与上游实现的根本不同：上游重拉详情再把两边**各自重新归一化**一遍去比
  （两套字段读法），转换规则一改 diff 就开始撒谎。我们拿 `planInstall()` **已经算出的那批条目**去比，
  预告与提交在结构上不可能不一致
- `WorkshopConflictModal` 现在对**每一次更新**都出现，不只有冲突时。加/删条目同样不可逆，此前一个字都不说。
  有冲突才用「确认覆盖你修改过的条目」那句标题，否则只是「确认更新」

**B4 投稿面**

- client 写侧：`createProject` / `updateProject` / `setProjectVisibility` / `deleteProject` /
  `uploadProjectFile`（载荷·正则）/ `uploadProjectCover`（multipart）
- 🔴 **编辑已发布项目上游会开草稿并返回草稿 id**（`createDraftFromPublished`），后续文件必须传到新 id 上——
  传回旧 id 就是在改线上那一版。这是整个投稿面最容易错的一处，测试专门钉住
- `WorkshopSubmitModal`（新）— 四步进度逐步亮出；中途失败明确告知「项目已经建好了，去我的项目里编辑它补传，
  别再走一遍新建」（重走会留下第二个空项目）
- 卡片上的作者管理动作（编辑/隐藏/删除），按 `listing.authorId === 登录用户` 判定而非按所在视图判定

**B5 审核面（管理员）**

- client：`listPendingProjects` / `reviewProject` / `listAdmins` / `listAdminLogs` / `setAdmin`
- `WorkshopAdminModal`（新）— 待审核 / 管理员 / 操作日志三 Tab 合一（上游分三个入口）；后两个超管才可见
- 驳回**必须填理由**——理由会落到项目行上，作者在「我的项目」里看得到；不给理由的驳回等于让作者去猜
- 🔴 权限判定只决定**画不画入口**，不是安全边界：真门禁是上游那几行 403。客户端那份 `isAdmin` 是同一枚
  token 里抄来的显示用旗标，拿它当门禁等于把权限交给一个 localStorage 值

**与上游刻意不同的三处**（都写进了各自文件头）

1. 没有任何基础标签的项目**不出徽章**。上游 `getBaseTag` 退回 `BASE_TAGS[0]`，会把只挂「路边」的项目
   盖章成「系统」——而「系统」恰恰是最需要用户警惕的那类（D12）
2. diff 由安装计划派生，不重新归一化一遍（见上）
3. 保留我们自己的主题化占位图，不用上游那张深色 "No Preview" SVG（parchment 主题上是一块黑斑）

**上游的一个真 bug（未跟随）**: 上游搜索框只在**已加载的页**里做客户端过滤，`fetchProjects` 从不发
`?search=`，而它自家 API 支持。我们一直是服务端搜索，不跟。

**真机走查发现并修掉的两条（2026-08-01 当天）**

1. **待审核项目「删除」点了没反应** —— 二次确认用的是原生 `window.confirm`，它在内嵌
   webview 里会被**直接自动关掉并返回 false**，于是删除表现成「什么都没发生」：没有报错、
   没有请求。Chrome 里正常，所以极易被当成后端问题。改成应用内模态（与「卸载」那道确认同款），
   顺带排除了原生弹窗与主题格格不入的问题。⚠️ 上游服务端**不禁止**删除 pending 项目
   （`ProjectDelete` 只校验登录与归属）；上游页面是在 UI 上禁掉的，我们没跟。
2. **改完标题点进项目还是旧的，要等几分钟** —— 是**我们自己的详情缓存**在骗人
   （`WORKSHOP_DETAIL_TTL_MS` = 5 分钟），不是上游延迟。新增
   `invalidateWorkshopProject(projectId)`：写操作（投稿/编辑/删除/改可见性）成功后丢掉该 id
   的详情（**所有身份桶**）与**全部列表页**（改一个名字影响哪几页算不出来，而列表 TTL 只有
   120 秒、重拉很便宜）。载荷刻意不丢 —— 它按 `downloadUrl` 存键，上游发新版天然是另一把钥匙。
   编辑走草稿时新旧两个 id 都丢。

3. **列表每页只出一个项目，「加载更多」也一次只加一个** —— 根因是 `pageSize` 被带跑:
   `listMyProjects` 是**不分页**的端点，它回执里的 `pageSize` 只表示「这把拿到几条」，
   而浏览模态把任何一次响应的 `pageSize` 都无条件写回共用的查询状态。名下只有 1 个项目的
   作者点一次「我的项目」，`pageSize` 就被钉成 1，切回「全部」之后每页只剩一个 —— 而且
   这个坏状态会一直粘着，因为再没有任何一次响应会把它改回去。改成**只有服务端分页的视图
   才准回写** `pageSize`，并补了回归用例。

**功能删除（同日）**: 「导入本地文件」整条链路移除 —— 页面按钮 + file input、
`workshopStore.prepareInstallFromFile` / `installFromFile`、`WorkshopSourceKind` 的
`'local_file'` 支、`LOCAL_IMPORT_NOTE`，以及对应的 7 个用例。

> 缘由: 这个功能的前提是「用户手里有一份 `project-xxx.json`」，而查上游源码后确认
> **工坊页从来没有提供过下载入口**（三个 file input 全是投稿用的上传口，详情里那个
> `fa-download` 图标是「安装」按钮自己的）。一条没有起点的后路。
> ⚠️ 这一并撤掉了 D17 写的「离线来源」那半边: 上游 worker 挂掉时，现在没有任何安装途径。

**UI 调整（同日）**: 登录位 / 审核 / 投稿 / 导入本地文件 / 浏览工坊 五个入口从顶栏右角**下沉进
页面本体**，成为简介下方的一条动作区（左身份、右动作，「浏览工坊」作主动作排在最后）。
顶栏只留「返回」与标题。原来全挤在顶栏一条里，窄屏会折行顶掉标题，而这一页最主要的入口
「浏览工坊」反而在最边角。

> 「我的项目」列表本身的那几秒延迟不在此列: `listMyProjects` 本来就不进我们的缓存，
> 那是上游 D1 / 边缘那一侧的事，我们管不着。

**验证**: 160 文件 / 5235 tests 全绿（P3 收尾时是 5157）；`tsc` / `vue-tsc` 零错误；eslint 零错误
（顺带修掉 P3 遗留的两个 `prefer-const`，P3 交接文件里「eslint 零错误」那句当时就不成立）。
🔴 **B5 无法自测** —— 当前账号 `isAdmin: false`，审核面板要有管理员账号才能真机走查。

---

### 工坊 P3 — 社交面：Discord 登录 + 点赞 + 订阅 ｜ ✅ 完成 待真机（2026-08-01）

设计真源: `docs/planning/2026-08-01-workshop-social-design.md`（D18–D25，接续工坊 D 编号）。上游后端源码已取得（github.com/AkabaneSaki/myrepo，`cloudflare/src/`），全部契约**直接读自源码**并以 file:line 落进设计文档附录——判决：会话是 Bearer JWT（零 Cookie），CORS `ACAO:*` 放行 `Authorization`，**直连 REST 成立**，附录 B iframe 桥永久搁置（D18）。

**引擎/客户端层（P3b）:**

- `workshop-types.ts` + `WorkshopSocialMeta` / `WorkshopToggleAck`；`workshop-manifest.ts` + `parseSocialMeta` / `parseToggleAck` 纯函数（缺字段回 0/false）
- `workshop-client.ts` — D21 契约修订（`WorkshopFetchInit` 扩 `method/headers/cache`，注释禁令同步改写）；`setWorkshopAuthTokenProvider` 注入缝 + `decodeJwtPayload`；已登录列表/详情 `no-store` + 缓存键身份前缀（`anon:`/`u<id>:`，载荷键刻意不分身份——按版本不可变）；`toggleLike/toggleSubscribe`（无体 POST、**永不重试**——上游是翻转语义非幂等）；`startLogin/pollLogin`；`WorkshopFailureKind` + `'unauthorized'`；双错误体形状解析
- `workshop-social-store.ts`（新）— 弹窗 + postMessage 快路径（source+state 双验证）+ 2s 轮询兜底 60s 超时（D19）；JWT 本地解码 + exp 判定 + localStorage `workshop-auth`（D20）；per-project 覆盖层 + 乐观→无条件校正→失败回滚 + 800ms（项目×动作）节流（D23）；登出零请求（上游 logout 是 no-op）

**UI 层（P3c）:** `WorkshopSocialActions.vue`（新，卡片/详情共用唯一动作入口）；`WorkshopPage` 顶栏登录位（头像/登出/guild 门槛失败文案 D25）；卡片与详情接 `socials`/`social`（随既有响应捎带，零新增读请求 D22）；卡片根节点 `<button>`→`div[role=button]`（按钮嵌套非法 HTML）。

**请求优化（读后端源码推导，O1–O6）:** 跳过 `/api/auth/me`（其字段就是 JWT payload 回抄）；列表 TTL 45s→120s 对齐上游 `s-maxage=120`；postMessage 快路径每登录省 ~30 次轮询；登出零请求；toggle 响应自带计数零回读；不引入上游自家的 `_=timestamp` 缓存破坏参数。前置小优化（已进 master `097b0e8`）：列表 45s TTL 缓存、安装不再 force 重下载荷、首装吃详情热缓存。

**验收:** 全量 **155 文件 / 5157 tests 全绿**；typecheck / vue-tsc / eslint 零错误。🔴 真机验证待做：真实 Discord OAuth（含不在服务器的 guild 门槛路径）需人工走一遍；社交字段零持久化（D13/D22 存储禁令不动，FullBackup 无变化）。

### 战斗 v3 M1 — 内核骨架：状态机 + 行动槽 + 原子提交 + 唯一终局 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§二 核心控制模型 / §三 CombatState 与原子提交 / §十三 DomainEvent）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §3。M0 的地基（分通道骰带 + replay harness）之上，把 v2 的「Agent 主持流程」翻转为「代码内核主持流程」的**内核骨架**——所有变更走 `CombatSession.dispatch(command)` 单一入口，v2 代码仍不删（flag 默认 `'v2'`）。

**新建内核文件（全部在 `combat-v3/`）:**

- `types.ts`（扩）— 追加 `CombatPhase`（10 相位）/ `CombatUnitState` / `CombatState` / `CombatView`（只读投影）/ `ResolutionFrame` / `JournalEntry` / `RequiredInput` / `CombatTransition` / `CombatSession` / `CommandRejection` / `TerminalReason` / `DomainEvent`（M1 子集）/ `ReactionWindow`（18 窗口）/ `ActiveEffectIndex` / `PendingChangeSet` / `CombatDefinitionBundle`。M0 类型保留不动
- `state.ts` — `createCombatState`（bundle→units + FP 快照 + provenance）/ `toView`（脱敏只读投影）/ `applyPending`（**唯一状态写入**，revision 单调递增、HP clamp `[0,maxHp]`）/ `applyOutcome`（把 `PhaseOutcome` 一次性落 state，rejection 时零变更）
- `kernel.ts` — `createSession`：持有 state + `Map<commandId, CombatTransition>` 幂等缓存 + dispatch（调 reduce，经 `transition.next` 采纳完整权威状态）+ 熔断 200 微步骤抛 `KernelStuckError`
- `reducer.ts` — `reduce` 唯一入口：stale revision / Terminal 只收 `RequestSettlement` / 目标在执行者早期校验（A1-2 拒绝须零事件）/ `AUTO_PHASES` 推进表（数据驱动非 if-else）/ `commandUsed` 标志（一次 dispatch 一个 PlayerCommand）/ SupplyDice 续杯 / 一次 Command 一次 revision
- `phases/round.ts` — 增益 tick（round.open）/ 减益+DoT（round.close）+ buff `remainingTime` 真实递减到期移除（**M-1**）
- `phases/initiative.ts` — initiative 通道掷骰 → v2 `rollInitiative` → 总值降序、平手字典序；**不调 `rollAndSortInitiative`**（避开其 `Math.random` 兜底）
- `phases/unit-turn.ts` — 开槽（`canAct && hp>0` 才发槽，**M-3**）/ `consumeSlot`（cost 验证+消费）/ 士气 d20 从 `statusContest` 通道取（**M-4**）/ 线性推进到下一单位或 RoundClose
- `phases/attack.ts` — 微步骤链 §3.4：① check.intent 取 `intentCheck` **两颗**独立骰 → resolveIntention（**C5**）→ ②③④ collect_mods/check.hit 窗口 → ⑤ damage.compute 管线 + clamp≥0（**C7**）→ ⑥ damage.preview 窗口（M1 空转）→ ⑦ checkNonLethal（**C6**，HP 锁 1 + 昏迷）→ ⑧⑨ beforeDown/damage.after 窗口 → ⑩ 攻守双方资源同批提交（**M-9**）
- `phases/action.ts` — DeclareAction（道具/移动/专注/防御）+ Flee（statusContest 检定）
- `phases/terminal.ts` — 终局四出口 `checkTerminal`（HP 全灭/士气溃逃/逃跑成功/forceTerminal）+ `settle` 按 `settlementId` **幂等**（**C3**，同 id 二次调用返回既有结果不产第二套奖励）
- `rule-keys.ts` — 只注册 `terminal.forceTerminal` RuleKey（divinity≥5），其余三个 M4 补
- `windows.ts` — **空转版** evaluator：遍历 `ActiveEffectIndex`（此时恒空）返回空 intent 数组；round/attack/unit-turn 各窗口**调用点全就位**，M3 接入时只填索引不用改调用点

**验收:** A1-1 ~ A1-10 全过（行动槽强制/非法命令零事件零骰/同 commandId 幂等/原子提交/round tick/终局四出口/settle 幂等/双意图骰/非致死锁1/负 modifier 不治疗）+ §3.9 熔断。全量 **4792 测试 / 149 文件全绿**；typecheck 零错误；lint 零 error（3 个 `prefer-const` 已 `--fix`）。combat-v3 新增 92 测试（kernel 24 + reducer 22 + phases 28 + terminal 9 + state 9）。

**M1 修复的 Critical/Major:** C3（settle 幂等）/ C5（意图双骰）/ C6（非致死锁 1）/ C7（伤害 clamp≥0）/ M-1（buff tick）/ M-3（行动槽强制）/ M-4（士气骰真源）/ M-9（攻守资源同批）。

**已知遗留（M2 对齐）:** `phases/action.ts` 的 DeclareAction 尚未实现「道具消耗/移动范围/专注」等子类型的具体效果（M1 只消费动作槽 + 产事件）；`fixtures/case-06` 的 command kind `UseSkill`（非架构 §二 2.2 枚举）留待 M2 改 `DeclareAction`；EXP/战利品结算在 `settle` 只算 FP 净值，M2 settlement.before 窗口补全。

### 战斗 v3 M0 — 地基：分通道骰带 + replay harness + 纯函数签名改造 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§四 DiceTape / §1.4 五处代码修正）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §2。把 v2 的「Agent 主持流程」翻转为「代码内核主持流程」的地基——所有新代码落 `src/sillytavern/combat-v3/`（deep module，唯一公共出口 `index.ts` 留待 M1），v2 代码 M5 前一行不删，靠 feature flag 整场切换。

**新建 `combat-v3/` deep module:**

- `types.ts` — DiceChannel / DiceEpoch / DiceTapeState / CombatProvenance + CombatFixture 全类型 + `DEFAULT_CHANNEL_SPLIT`（attackHit 32 / initiative 10 / intentCheck 7 / statusContest 6 / procCheck 5，D6 实测加权，RFC §5.7「各 12 颗均分」被推翻）+ CHANNEL_ORDER
- `dice-tape.ts` — `createTape` / `draw` / `beginEpoch` / `splitSixty` 纯函数（不可变更新）。draw 只推进目标通道 cursor，耗尽不推进任何 cursor；beginEpoch 旧 epoch 进 exhausted、cursor 归零；**不做通道间借用**（架构 §一 1.6 否决项，保 replay 干净）
- `replay.ts` — `replayCombat(fixture, reducer?)` 纯函数：validateFixture 结构校验 + buildTape 验证骰带可建 + hashFixture 规范化 djb2（忽略 `_synthetic`/`_provenance` 元数据）+ reducer 注入缝（M1 起驱动 commands）
- `fixtures/case-06-summon.fixture.json` / `case-24-reflection.fixture.json` — 两场简版 fixture，含 `_provenance` 骰值对照表（样本行号→fixture 骰值）+ `_synthetic` 标记

**v2 纯函数签名改造（差分测试地基，v2 行为零变化）:**

- `performAttackCheck`: `d20Roll: number` → `rolls: [number, number?]`，删除两处 `Math.random()` 模拟第二骰（修复架构 §1.4 M-5）
- `runMoraleCheckPipeline`: `d20Roll` 改必传（修复 M-4 战意骰恒 10）
- `combat-pipeline.ts` / `combat-resolver.ts` 调用点补传 `rolls:[d20,d20]` / `d20Roll:10`（v2 行为等价）；额外修复 `combat-resolver.ts:134` 守方意图骰的 `Math.random()` 统一为同值双喂
- `AppSettings.combatEngineVersion: 'v2'|'v3'` 默认 `'v2'`（feature flag，分支点唯一 `game-pipeline.handleCombatTrigger`，M5 才翻 v3）

**反非确定性守卫:** `no-nondeterminism.test.ts` 用 `import.meta.glob` + `?raw` 扫描 `combat-v3/` 全部 `.ts`（排除 test），断言零 `Math.random` / `new Function` / `eval`（铁律 1/2，全链路根除审查报告 C1）。

**验收:** A0-1 ~ A0-8 全过。全量 4757 测试 / 144 文件全绿；typecheck 零错误。combat-v3 新增 57 测试（dice-tape 35 + no-nondeterminism 4 + replay 22，含两场 fixture milestone 断言）；v2 战斗测试 177 个零行为变化。

**已知遗留（M1 对齐）:** fixture command kind 用了 `UseSkill`（非架构 §二 2.2 枚举），M0 replay 不校验 command kind，M1 内核 dispatch 时改 fixture 为 `DeclareAction`。

### 工坊 P2 — EJS 沙盒 + 只读 stats 投影（ADR-30）｜ ✅ 待真机（2026-07-31）

设计: `docs/planning/2026-07-31-workshop-phase2-ejs-design.md`（v1.2 拷问定稿，五轮）；实施计划: `docs/planning/2026-07-31-workshop-phase2-implementation-plan.md`（波次 T1-T6）。世界书条目正文的 EJS 从「原样进上下文」变成「**提示装配期求值**」。

**两轴契约**（自主设计，不承诺 MVU/酒馆助手兼容，上游函数名仅作别名层）: `stats` 是**只读**面，纯代码推导数值（主角资源/等级/五维/命运点数/`世界.时间` = `formatGameTime` 规范串）；`vars` 是**与 AI 共写**的叙事变量空间（= `variables.sys` 草稿），EJS 与 AI 双写同一棵树，**冲突 AI 赢**。

**模块**:

- `ejs-runtime.ts` **重写**为整片编译 —— 一个条目的全部 token 编进**同一个函数体**，跨块 `if`/`for` 由此成立（旧的逐块 `new Function` 做不到，这是重写的存在理由）。tokenizer 一并重写，顺带修掉 `<%= x _%>` 的切词缺陷；含 `print()` 与 `"use strict"`；API 为 `compileEjsEntry` / `executeEjsEntry`，执行失败**回滚草稿**不留半截写入
- 新增 `ejs-lodash-shim.ts`（`_` 纯读边 17 方法 + `chain`，无任何写方法）· `stat-projection.ts`（`buildStatData` 出只读快照）· `ejs-vars-diff.ts`（草稿深 diff → `{replace,remove}` 交给 var-resolver 的 `applyVarsPatch`；`EJS_DIFF_SIZE_LIMIT = 256KB`）
- `worldbook-loader.ts` 新增 `hasDynamic`（三根针 `<%` / `{{random` / `{{getvar`）+ `renderWorldBookEntries`

**缓存分层与回退**: 静态区在前、**动态条目沉底**，使静态前缀字节稳定、前缀缓存不被动态内容击穿；编译结果按条目缓存。求值失败**按条目隔离**并注入原文（零回归兜底）。全语料冒烟 509 条目 / 61 动态 / **8 条已知回退白名单**（uid 343·353·357·358·417·421·477·505 —— 6 条依赖本引擎没有的酒馆助手 API、1 条 `await`、1 条 `{{roll}}` 宏嵌在 EJS 代码块内）。⚠️ 最后一条推翻了设计 D1 的宏剥离顺序假设，已裁定接受。

**接线与提交仲裁**: `LORE_BOOK` resolver 走 `renderWorldBookEntries` 并新增 `section=static|dynamic` 参数，`buildFallbackMessages` 同步；`AgentContext` 加 `statData`/`ejsVarsDrafts`/`ejsPass`，`AgentConfig` 加 `ejsVarsCommit`（**默认仅 story 为 true**，per-Agent 声明是前瞻扩展设计）。orchestrator 新增 `onEjsVarsFlush` 事件，在**每个 stage 跑完、`processStageMarkers` 之前**触发 → game-pipeline 算差量/护栏/落库 → `commitChatState(patches, { ejsVarsDiffs })`：**EJS 差量先落、AI 补丁后落**，同路径 AI 赢。差量顺序 = 管线阶段序 + 同阶段 `agentId` 字典序（钉死可复现）。超限**整份拒绝不截断** + toast 一次（每存档每来源）+ game-store `ejsVarsRejections` 持久诊断（DebugPanel 展示并进导出）。

**测试**: 145 files / 4928 tests 全绿；`npm run typecheck` 与 `vue-tsc` 均 0 错误。

🔴 **真机走查尚未做** —— 回退率、`cacheHitTokens` 前后对比、story 首包延迟、冰之歌跨回合链四项均未验证，状态口径按「✅ 待真机」而非「已交付」。

### 工坊 P1 — 创意工坊（= Phase 7f） ｜ ✅ 真机走查已过（2026-07-31）

设计: `docs/planning/2026-07-31-creative-workshop-compat-design.md`（v2，D1-D17）；实施计划: `docs/planning/2026-07-31-workshop-phase0-1-implementation-plan.md`。上游是【命定之诗】创意工坊（角色卡内嵌酒馆助手脚本 + Cloudflare Worker 后端），本引擎**不嵌 iframe、不跑上游 JS**，只直连其公开 REST。

**新分区 `creative_workshop`**（`WorldBookPartition` 第 16 个成员）。**所有工坊条目一律归此分区**，无论上游标成系统/角色/事件/DLC —— 分区在本引擎是**信任域边界**，不是内容学分类；上游 `tags` 仅作展示与筛选，不参与判定。除分区外工坊条目与其它条目完全一视同仁（同表、同启用机制、同样可编辑、同样进备份），无门禁无特判。

**模块**（照素材系统「纯函数出计划 / 执行器只落库」分层）:

- 引擎纯函数层 `src/sillytavern/`: `workshop-types.ts` / `workshop-manifest.ts`（上游 JSON → 内部形状，容忍字段增删）/ `workshop-regex-map.ts`（ST 正则 → BeautifierRule）/ `workshop-install-plan.ts`（★ `planInstall` 纯同步出计划：发号/转换/匹配/冲突/丢弃全在无副作用函数里算完并可完整断言）
- UI 层 `src/ui/`: `lib/workshop-client.ts`（唯一网络接触点，判别联合永不抛穿 + 超时 + 取消）/ `lib/workshop-enable.ts`（启用展开纯函数）/ `stores/workshop-store.ts`（执行器，只落库）/ `components/workshop/` 6 组件 + `format.ts`·`failure-text.ts` / `shared/WorkshopEnableList.vue` / `game/WorkshopEnablePanel.vue`（每存档「内容启用」，建档后仍可改）；入口在首页「创意工坊」按钮 + 游戏页侧栏「工坊」 + 捏人页（原「角色启用」步骤改名「内容启用」）

**关键决策**:

- **一项目一本书** —— `worldBooks` 行 `id = workshop:${projectId}`，`partition = 'creative_workshop'`。这是**多本书共用一个分区的第一例**（内置书是 `id === partition` 一一对应）
- **uid 必须在分区内重新分配** ★否则数据损坏 —— `filterBooksByEnabledEntries()` 以 partition 为键建 uid 允许表，而上游每个项目 uid 都从 0 起编，跨项目撞号是必然。安装时由分区级分配器全局单调发号；上游 uid 降级为 `extra.workshop.sourceUid` 仅溯源
- **卸载不回收号段** —— 回收会让旧存档的 `enabledWorldBookEntries` 指向新项目的条目（静默内容错位）。游标地板取「在装项目 + 现有书 + **所有存档引用过的号**」三者最大
- **启用完全走既有机制** —— 写 `SaveSlot.metadata.enabledWorldBookEntries` 的 `creative_workshop:<uid>`，与 `system_core:413` 一视同仁；不新增 SaveSlot 字段、不改 `filterBooksByEnabledEntries`、不做分区特判。真正的闸门是 Agent 可见性（新装书不自动进任何 Agent 的 `worldBookIds`，这是既有规范非工坊特例）
- **UI 粒度是项目，不做命定核心冲突拦截** —— `tags` 是上游自由文本，无可靠机器信号，猜必误伤；显著展示 tags 与简介由用户判断
- **正则原样安装、默认启用、不剥离 `<script>`/`<style>`** —— 落进现有输出美化规则库，`group: '创意工坊 · <项目名>'` + `autoEnable.worldBookIds: ['workshop:<id>']`（装了才启用，卸载即失效）。⚠️ **已知并明确接受**: `<style>` 会全局泄漏样式进主题 token 体系；`<script>` 在 `v-html` 中不执行只占字节；内联 `onclick` 会触发
- **更新按名匹配、覆盖式** —— 存活条目 uid 不变（存档引用无需重写），删除的 uid 退休，新增的领新号；逐条比对 `sourceHash`，**改动过的先弹警告**（`WorkshopConflictModal`）再覆盖
- **丢弃必须 loud** —— `promptOnly`/`placement`/`minDepth`/`maxDepth`/`substituteRegex`/`runOnEdit`/`trimStrings` 及 `{{getvar::}}` 宏一律记 `droppedNotes`，项目卡片如实展示「N 项未导入」，静默截断会让用户以为装全了

**真机走查已过**: 真实上游 279 项目 14 页，完整跑通 浏览 → 筛选 → 详情 → 安装 → 启用 → 卸载。

🔴 **Phase 2（EJS 沙盒 + 只读 stats 投影）未做** —— 工坊装进来的世界书条目里的 **EJS 目前不会被求值**，正文原样进 Agent 上下文。这不是本次新增的缺陷（内置书今天就这样：`event.json` 297 个 EJS 块、`system_core.json` 252 个），但**工坊内容因此并未真正完整生效**。

**不做（Phase 3+）**: Discord 登录、点赞、订阅、投稿。

**测试**: 135 files / 4611 tests 全绿；`npm run typecheck` 与 `vue-tsc` 均 0 错误。

#### 工坊 P1 实施后修订（2026-07-31）｜ ✅ 真机已复验

真机走查后打的两处补丁。设计文档已同步：D16 追加「实施期修订」小节、D12 追加同屏并列条目。

**① `droppedNotes` 分三类 —— 原口径在撒谎**

装「艾莉亚核心先行版 v3.2.1」时 UI 顶部写「**34 项内容未导入**」，但那 34 条 note 里只有约 14 条是真丢弃；其余 20 条描述的是**已装且已启用、只是渲染受限或有副作用**的正则（Dexie 里 5 条正则全部 `enabled`，世界书也装得好好的）。用户读到只会以为安装失败。

| kind         | 含义                                  | 覆盖                                                                                                                         |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `dropped`    | ST 字段本引擎无对应物，**确实没导入** | `placement` · `maxDepth` · `minDepth` · `runOnEdit` · `promptOnly`（整条跳过）· `substituteRegex` · `trimStrings` · 退休条目 |
| `degraded`   | **已装**，但渲染不完整                | ` ```html ` 围栏无渲染器 · 完整 HTML 文档被解析器截断 · `<script>` 惰性 · `{{宏}}` 无替换环节 · 上游重名本地改名             |
| `sideEffect` | **已装**，且有规则自身之外的副作用    | `<style>` 全局生效、可能覆盖应用主题 token                                                                                   |

- `types.ts` 新增 `WorkshopNoteKind` / `WorkshopNote` / `WorkshopNoteLike`
- `workshop-types.ts` 新增纯函数 `workshopNote` / `normalizeWorkshopNote(s)` / `groupWorkshopNotes` —— ★**向后兼容**：已装项目在 Dexie 里存的是旧 `string[]`，裸字符串与脏 `kind` 一律退回 `dropped`，**绝不抛**
- `workshop-regex-map.ts` / `workshop-install-plan.ts` 打 kind；文案口径统一在 `components/workshop/format.ts`
- `WorkshopInstalledList.vue` 折叠行三段分计数（`sideEffect` 带 ⚠ 且最显眼）；`WorkshopPage.vue` toast 同口径
- **已知后果一条未变** —— 改的只是停止把「已装但受限」误报成「未导入」。「丢弃必须 loud」不变，但 loud 的对象要分得清：把不同性质的事混成一个数字本身就是另一种静默截断
- **真机复验**：同一批 note 现显示「14 项未导入 · 15 项已装但效果受限 · ⚠ 5 项有全局副作用」，合计仍是 34

**② 捏人页工坊选择挪到「命定核心」步骤**

原先工坊多选在后面的「内容启用」步骤，与命定核心单选隔了一屏。现把工坊区从 `CreateStepCharacters.vue` 挪到 `CreateStepDestinyCore.vue`，拆成并列两轴（`一 · 命定核心` 单选·必选 / `二 · 工坊项目` 多选·可选），步骤名「内容启用」改回「**角色启用**」（即上文 P1 条目中「原『角色启用』步骤改名『内容启用』」一句已被撤回）。

**纯 UI 位置调整** —— `create-store` 三条轴逻辑与 `buildEnabledWorldBookEntries()` 输出**逐字未变**（有测试钉住）。D12「不做命定核心冲突拦截、只显著展示 tags 由用户判断」不变；同屏之后反而更好落实：用户能同时看到两边的 tags 与简介。

🔴 **Phase 2 仍未做** —— 工坊条目正文里的 EJS 依然不求值，本次修订与之无关。

**测试**: 138 files / 4645 tests 全绿；`npm run typecheck` 与 `vue-tsc` 均 0 错误。

### 工坊 P0b — 美化规则迁出 localStorage ｜ ✅

**起因同 P0**: 内置美化规则 22 条 = 386,645 字符（≈378 KB）每次启动都从磁盘重算，却仍被完整写进 localStorage；工坊正则落地后还要再加 ≈494 KB。这一阶段是**实施期间新增的前置**，设计定稿（v2）时未预见。

- Dexie **v15** 新增 `beautifierRules` 表；新增 `beautifier-store.ts`（Dexie 唯一入口）+ `beautifier-migration.ts`（复用 P0 的六步迁移）
- **`AppSettings.beautifierPresetRules` 字段整个删除** —— 派生缓存不该有持久化字段位，改为纯内存 ref（启动时从磁盘算）
- `beautifierBuiltinDisabled` 体积小且是真用户意图，**留在 settings 不迁**
- `FullBackup` 新增 `beautifierRules`（只含用户规则，内置预设不进备份）
- `beautifier.ts` 的 `processRules` / `mergeRules` **一行未动** —— 换的是存储层，不是规则语义

### 工坊 P0 — 世界书迁出 localStorage ｜ ✅

设计: 同上文档 D1-D5。**起因是三个后果，其中第三个是真缺陷**:

| 问题             | 实测                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 配额压力         | 内置世界书紧凑序列化 889,962 字符（≈0.85 MB；localStorage 按 UTF-16 计约 1.7 MB），配额通常 5 MB，且溢出**静默 catch**             |
| 写放大           | deep watch 在**任何**设置变更时重新 `JSON.stringify` 整个 ≈2 MB 设置对象                                                           |
| **备份不覆盖** ★ | `exportAllData()` 只做 `db.*.toArray()`，**从不读 localStorage** —— 世界书根本不进备份，而设置页却标注「IndexedDB + localStorage」 |

- Dexie **v14** 新增 `worldBooks` / `workshopProjects` 两表。**死表 `lorebooks`/`settings` 原样保留不删** —— 删表要写 `表名: null`，会永久抹掉老用户可能仍存的 v1–v3 行；放着不花钱，导出也只是空数组
- 新增 `worldbook-store.ts`（Dexie 唯一入口）+ `worldbook-migration.ts`：**标志位判定**（`worldBooksMigratedAt`，不以「表里有没有行」判定——半失败会留下行看着像完成）→ 单事务 `bulkPut` → **回读逐本校验**（书数 + 条目数）→ 通过才删 localStorage 副本 → 任何一步失败**一律不动**、下次启动重试。不留 localStorage 回滚副本（留着就没释放配额，而释放配额正是迁移目的）
- 启动顺序：内置书合并必须在迁移**之后**、针对 Dexie 执行，否则源数组在迁移脚下漂移
- 消费端全部切换: `game-pipeline` / `SettingsPage` / `create-store` / `App.vue`；`filterBooksByEnabledEntries` 及下游不动，只是拿到的数组变长
- `FullBackup` 加 `worldBooks` + `workshopProjects` 两字段并递增版本，import 采**三态语义**: 字段缺席 → 整表不动（旧备份）· `[]` → 清空 · 有数据 → 覆盖

🔴 **独立审查发现并修复两个会丢数据的缺陷**:

1. **重复 id 的书在迁移中被静默合并** —— `bulkGet(['x','x'])` 对同一行返回两次，数量校验被骗过，`bulkPut` 只写进一行。已加 `dedupeIds`
2. **导入 pre-v14 旧备份会清空整张 worldBooks 表** —— `Array.isArray` 守卫写在 `clear()` 之后，旧备份没这个字段时表已经被清空了。已改为守卫先行（📌 加表进 FullBackup 时别照抄 clear-then-guard）

### 战斗 v2 — 战斗系统架构 v2 重构 ｜ ✅ M5 完成，待 M6 真机

战斗系统架构 v2 重构（管道+中间件+同构契约+6 大类效果对齐 #265160+buff 规则对齐 [状态规则]+19 event+Combat Agent+独立战斗面板+计算分工）。魔改不照抄世界书，趣味优先+代码兜底。架构: `docs/reference/combat-system-architecture.md`；计划: `docs/planning/2026-07-28-combat-system-v2-plan.md`。M1-M6 六批次，§十三 待确认清单已全收口。

- **M1 ✅**（emitChain + script-registry，130 tests）
- **M2 ✅**（modifier 6 大类 + buff 去重，~140 tests）
- **M3 ✅**（管道版 + 19event + 登神 + HP 红线，~80 tests）
- **M4 ✅**（combat systemPrompt + 13 工具注册 + executeCombatToolCall 独立通道（B 方案）+ combat-runner 跨回合循环 + item_gen 6 大类契约 + 校验纯函数 54 测 + combat-agent-api.md 接口规格文档；agent-tools 58 测）
- **M5 ✅**（runner 路径 X 回合调度: 按行动轴逐单位 + 敌方自主/我方暂停等玩家 + 激活死字段 currentTurnIndex + 7 类 CombatEvent 事件流 + pendingResolver 暂停恢复 + hp 同步修正 + combat-store（combatLog/awaiting/submit）+ pipeline 桥接（enter/exit/applyCombatEvent）+ CombatPanel 覆盖层 + 4 子组件（CombatUnitCard/CombatActionCard/CombatMessageFlow/CombatActionBar）B+C 按钮注入文本框 + CombatHeader + useBeautify composable 抽取；combat-runner 7 测；M5 plan+RFC 文档）｜ 待真机验证

### 素材 — 素材管理系统 v1.0 ｜ ✅ 已实现 + 渲染面接通 + 大画像/裁剪台/画像弹窗

设计: `docs/planning/2026-07-29-asset-management-system-design.md`（D1-D22 决策表 + §12 风险与已知缺陷 + §13 反转理由 + §14 审查记录 + §15 实现纪要/两轮审查/渲染面落地 §15.9/大画像与裁剪台 §15.10（🔴 其真机记录只对 `e818b61` 版有效）/画像弹窗与审查轮 §15.11）。**行为参考 RP Terminal 素材系统，但刻意不移植代码**（架构差异过大）。

**v1 范围**: 三类型 `头像/立绘/立绘bg` 全部可导入 + 一键 zip 导入（素材与音频同一个导入器，按扩展名分流；`.webm` 仍归音频）+ zip 导出（**仅 blob 源音频，内置 57 首与本地文件夹源刻意排除**）。

**关键决策**:

- **命名约定** `<name>[_<type>][_<variant>].<ext>`，type 可省默认头像（文件名即 zip 格式）
- **严格 `===` 匹配不归一化**（对齐 state-manager.findByName，刻意不用 audio 的 normalizeAudioName）
- **命名不变式**: name 与 variant 的任何分段都不得等于类型 token（否则 format→parse 不是双射，`(苏婉,头像,立绘)` 会回读成 `(苏婉_头像,立绘)`）
- **与存档/characters 表零耦合**（无角色名册、无覆盖率计、无未匹配列表）
- **单存储层 IndexedDB Blob** + 走 audio 的 loadBlob 注入缝
- **mp4 只准用在不需要 alpha 的类型**（头像圆形裁切/立绘bg 整屏 ✅；立绘是抠图要合成 ❌）
- **永不覆盖，冲突编号进 variant 槽**（编进 name 会脱钩角色）
- 导入哈希去重（素材按 `(name,type)`，音频按归一化名）
- plan/execute 拆分（纯 `asset-import-plan.ts` 出计划，store 只执行）

**已实现 (2026-07-29)**: 5 纯引擎模块（asset-types/filename/index/resolve/import-plan）+ Dexie v13 两表 + `src/ui/lib/` 三件（asset-zip/media-hash/asset-url）+ asset-store.ts + AssetSection.vue 及 4 子组件 + 存档数据文案。332 tests / 12 files 全绿。

**合并后审查轮 (§15.6)**: 对 `97e5900` 对抗式审查，查出 7 条缺陷全部收口，修的过程中又自查出 5 条。要点: ①`allocateSlot` 文件名往返有损 ②新增 D19（名字经 zip 条目名往返的门）③`buildAssetIndex` 原型污染改 `Object.create(null)` ④补单文件导入 ⑤音频批内去重 hash 键 ⑥toast 文案修正。

**渲染面落地 (2026-07-29，§15.9)**: D4「只管理不渲染」**正式反转** —— 新增 `useAssetImage.ts`（唯一渲染缝）与 `AssetMedia.vue`；五个渲染位接通（StatusOverview 玩家 1:1 方框 / CreateStepConfirm / CharacterListPanel ×2 / ScenePanel 46×58 立牌位），全部保留原首字母兜底。🔴 修掉两个 v1 看不见的缺陷: ①`resolveAsset` 死代码（显式类型不降级）→ 改两条相反链 ②`asset-url.ts` 无引用计数 → NPC 同时出现两面板会死图，已改引用计数。

**大画像 + 取景 + 裁剪台 (2026-07-29，§15.10 / D21·D22)**: ①右栏大画像 `CharacterPortrait.vue`（判据是链上命中的那一档，不是"有没有图"）②裁剪台 `AssetCropEditor.vue`：一张源图烘出 `立绘 + 头像` 两份真字节，每类型三态 裁剪/整图/不生成（D22 两字段必填）③framing 逐行持久化 + 进 zip manifest（D21，显示元数据，非对象丢弃不夹逼，只落新建行）。

**画像位收干净 + 身份条 (2026-07-30，§15.11)**: ①`ad612d5` 画像上不再有任何家具，旋钮与相机徽章全收进 `PortraitSettingsDialog.vue`，`CharacterPortrait.vue` 退化成纯呈现组件 ②`a2411f3` 身份条盖到大立绘顶端（scrim 恒黑、字恒浅、刻意不用主题变量）③`1875d1c` 裁剪台两栏靠拢 + dev.bat IPv6 修复 ④`96b87ce`+`a12926b` 🔴 首页 🧪 快速测试按钮一直在调 `clearAllData()` 清空整个 IndexedDB（连全局素材库/音频库一起没），已修。

🔴 **真机验证记录只对 `e818b61` 那一版有效，现行 UI（`ad612d5` 之后）未经真机走查**。仍未验: 带 framing 的 zip 真文件往返 / mp4 两条路 / 素材库裁剪再编辑 / 不生成档端到端 / 键盘调裁剪框 / 四个 NPC 渲染位真机出图。4259 passed / 1 failed（同一条 SelectableCard 基线，与素材无关）。

⚠️ **两个顺带发现、刻意只记不修的真缺陷** (§12): ①`asset-store.compareRows` 把变体当字符串排（`_10` 排在 `_2` 前），`AssetCharacterDrawer` 打了 `{numeric:true}` 本地补丁——本地补丁盖共享比较器是走散的标准剧本 ②`SettingsPage.vue` 独占全仓 32 条 vue-tsc 错误里的 18 条（`PresetItem.settings`/`.template` 类型上不存在），结构上对 `npm run typecheck` 隐形（裸 tsc 不解析 .vue）。

### 真机迭代 — debug loop ｜ 🔄 持续验证中

debug loop 5 轮修复: 物品/角色零落库根因链（AI 输出 JSON 形状漂移 → 解析器 XML+JSON 双兜底）/ 侧链 systemPrompt + 世界书注入根治（此前恒 stub 裸奔）/ maxTokens 2048 兜底截断 / 创角初始装备改走 item_gen 链（不直接落库，交 item_gen 生成 stats）+ 自定义装备战斗数值输入 + 自定义物品编辑管理 / characterName 属性传递 / 嵌套标签剥离 / activePresetId 运行时尊重 / 世界书 ST 宏噪音清理。ST 预设 setvar/getvar 配对机制排查经验见 debug 记录。story 正文救援兜底（rescueStoryOutput: 正文吞思维链 raw 空 → 从 reasoning 抠 / 思维链泄漏进正文 → 截 maintext 前；空门控 + 取最后 maintext + story 守卫）。

### Audio — 音频系统 v1.0 ｜ ✅

说明书: `docs/reference/audio_system.md`（← 改音频必读）。audio-channels.ts（MusicChannel 音序器 + SfxChannel 声池，69 tests）+ audio-manager.ts（音轨库注册表/主音量/手势解锁/playByTag AI 钩子，54 tests）+ audio-fakes.ts 测试替身 + Dexie 三表（audioTracks/audioBlobs/audioPlaylists，全局非存档级，排除于 FullBackup）+ types.ts 7 类型 + audio-singleton.ts/audio-store.ts 桥接 + AudioSection.vue/MiniPlayer.vue。v1 不做远程 URL 音源/解码缓存/真交叉淡入；**SFX 基建完备但刻意无触发方**；`public/audio/manifest.json` 内置库刻意空载（授权未清）。

**本地音乐文件夹增补 (2026-07-27)**: audio-folder.ts（File System Access 唯一接触点，27 tests）+ Dexie v12 audioHandles 表（持久化目录句柄）+ AudioSourceKind 增 `'file'`。三后端并存；权限不跨浏览器重启需每会话一次手势；扫描永不删行。**引擎零改动**——整个新存储后端由既有 loadBlob 注入缝吸收。增补: `docs/planning/2026-07-27-audio-local-files-addendum.md`

**按名称寻址 + 名称唯一性**: audio-names.ts（normalizeAudioName 四步归一化 / findByName 稳定取最早 / isNameTaken + uniqueAudioName，40 tests）。导入路径自动编号永不失败、手动录入拒绝重名；约束仅作用于新写入，存量重名不动。

**审查后修复 + 拆分 + 新功能 (2026-07-27)**: ①加载竞态收口（自增世代号 + 每个 await 后 isStale）②时长广播 ③store 错误处理族（forgetFolder 改返 boolean / rescanFolder / uploadFiles / markMissing 按 trackId 去重）④types-audio.ts 收纳 ⑤AudioSection.vue 1502 行拆壳层 + 5 子组件 ⑥播放列表拖拽排序 + 曲库多选与批量操作 ⑦database.ts 音频 reader 补 await。🔴 自动化测试全部跑在注入替身上。

**内置曲库上架 + 按地点选曲 (2026-07-27)**: `public/audio/bgm/` 收录 57 首（35 地点 A/B + 13 通用场景 + 9 人物主题，~267MB；无尽树海 B 源站 404 缺失），manifest 走 `source:'builtin'` 零代码改动上架；素材作者 Aoo；`license = PLACEHOLDER-PENDING-REVIEW`（测试占位，发布前需复核）。audio-tags.ts（四维标签，18 tests）+ audio-scene.ts（七段路径逐级回退 + 四维加权打分，42 tests）+ store playByScene()/playByLocation()（9 tests）。

**AI 接线 · Code 侧 (2026-07-27)**: `<play_audio situation mood variant action>` → marker-protocol 扫描 → orchestrator `onPlayAudio` → GamePipeline Stage1 只暂存、run() 末尾 refreshFromDb 后 flush → `playByScene`。AI 不写地点与在场角色；正文入库前 stripPlayAudioMarkers 剥标记。⚠️ AI 标记的 prompt 侧刻意留空。

**场景配乐接通 (v1 收尾)**: 三条来源——⓪界面切换（view-audio.ts + App.vue watch）①地点变化（主路径）②AI 标记。手势解锁监听上提到 main.ts。设置→音频→混音台「场景配乐」开关（`audioSceneAutoPlay`，默认开）。📌 免手势自动播放是平台约束非缺陷。✅ 真机验证已过（地点换歌/界面换歌/试听出声/手势解锁时机）；❌ 音效与 AI 标记无从验起。

**内置 mp3 移出仓库 (2026-07-28)**: 57 首（267MB）随音频系统误提交并推送。已 `git rm --cached public/audio/bgm/` + `.gitignore` 加音频扩展名规则；manifest.json 与 README.md 继续 tracked。后果: 全新 clone 会列出 57 首但点不响（文件 404）——把 mp3 放回即恢复。历史提交仍含字节，彻底瘦身需重写历史（本次刻意不做）。

### 10k — 快照面板 + 右键回退重发 ｜ ✅ 待真机验证

左侧 SideToolbar「快照」按钮（SnapshotPanel 历史快照恢复）+ 最新 AI 消息右键「回退本轮/复制」（回退 = restoreSnapshot 上一轮 + 回填本轮输入 → 重发即重生成 / 编辑重发）+ Snapshot 阶梯保留（trimSnapshots tiered: 最近 5 全留 + 旧层 4/8/10 稀疏，非 turn 档受保护）+ restoreSnapshot 增强（plotEvents 捕获 + 覆写 / memories 清理 / totalTurns 对齐）+ 设置「快照保留模式」可配置（pipeline 搭桥同步 AppSettings）。计划: `docs/planning/2026-07-23-snapshot-rollback-plan.md`

### 10j — 剧情系统接线 ｜ ✅ 待真机验证

9 断点收口 + 三 Agent systemPrompt 重写（含雷点注入 + 修改模式）。计划: `docs/planning/2026-07-19-plot-system-plan.md`；大纲仅捏人页生成（main + side），游戏内零生成，演化归 post_check.outlineChanges；plotYearlyGeneration 退役。

### 10i — 输出美化规则库 ｜ ✅

beautifier-rules.json 预设规则（22 条: 2 内置 + 20 远程）+ 世界书/角色 auto-enable 绑定 + BeautifierSection 三段式 UI + ChatFlow 合并规则渲染 + 远程 regex.json 导入脚本。

### 10h — ST 预设占位符适配 ｜ ✅

`{{setvar}}`/`{{getvar}}`/`{{random}}` 解析替换管线 + 前端条目开关可点自动保存。

### M1-M6 — 数据字段规范迁移 ｜ ✅（2787 tests 首次 100% 全绿）

52 项收口:

- **M1** 类型库层
- **M2** StateManager 按名寻址
- **M3** 翻译层零 id
- **M4** Prompt 契约对齐 + 过渡拆除
- **M5** SSOT（变量迁家 + 快照重建 + 新闻好感接线）
- **M6** 读方切换 + 双写退役 + 收官

规范: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md` + `2026-07-16-entity-field-audit.md`。核心铁律: 逻辑键=名字（AI 永不产 id）· 名字解析唯一入口 · AI 填叙事字段 Code 补账务字段 · 每类数据唯一真源 · 枚举中文集中定义。

---

### 2026-07-31 — 修复：选工坊命定核心卡在捏人第 3 步

**症状**：新建存档 → 命定核心步骤 → 选一个工坊的命定核心 → **下一步按钮永不亮起**，
且没有任何提示说明缺什么。

**根因**：`stepValid[2]` 只认 `selectedSystemCoreEntryUid`（内置 `system_core` 条目的
uid）。工坊项目走的是另一条轴（项目级多选 `enabledWorkshopProjectIds`），选中它不会
写那个 uid，闸门自然一直关着。上一轮把工坊多选挪到本步同屏时，只搬了位置，没有把
「工坊系统项目也是命定核心候选」这件事接进闸门。

**修法**（按主人指定）：标了「系统」标签的工坊项目**并入命定核心那份单选名单**，
与内置核心同等对待 —— 同一个单选槽、互斥、同样满足必选闸门。

- `workshopSystemOptions` / `workshopExtraOptions`：按 `tags.includes('系统')` 一分为二
- `selectedWorkshopCoreProjectId`：工坊核心的单选槽，与 `selectedSystemCoreEntryUid`
  **双向互斥**（命定核心只有一枚，选一个就清另一个）
- `stepValid[2]`：两者任一非空即放行
- `buildEnabledWorldBookEntries`：工坊核心与附加项目**合流**后交给
  `applyWorkshopSelection` —— 存储上二者没有区别（都是 `creative_workshop:<uid>`），
  区别只在捏人页的选择语义，下游 `filterBooksByEnabledEntries` 无需知情
- 下方多选区改用 `workshopExtraOptions`，同一个项目不会同屏出现两次

涉及文件: `create-store.ts` · `CreateStepDestinyCore.vue`（+ 两处测试）

验证: 141 文件 / 4700 测试全绿（+7）· typecheck & vue-tsc 0 错误 · lint 0 error。
🔴 仍未真机走查。

---

### 2026-07-31 — 工坊评审修复 + 减动效开关 + 工坊书对 Agent 可见

Fable 评审（`ed28320..107f80b`）的 7 项发现全部修掉，另加两个功能。

**🔴 三处「我说过的话是错的」**

1. `WorkshopDetailModal` 的 docblock 声称装前预告与装后报告「不可能分家」——**假的**。
   `mapWorkshopRegexes` 是**索引敏感**的（未命名正则兜底成 `未命名正则 ${序号+1}`），
   逐条单独调用时序号恒为 0，同一条正则装前显示「未命名正则 1」、装后显示
   「未命名正则 3」。修：`RegexMapContext` 加 `indexBase`，检视侧传真实序号。
   （评审用一个失败用例证明的，不是推测。）
2. 「防抖动」的 `gridKey` **自己就是抖动源**：它由 `sort|tag|search|page` 拼成，
   全是**输入**，在请求发出前就变了。打字（350ms 防抖）会在一发请求都没出去时
   重建网格三次并重放入场动画；翻页则先拿上一页卡片演一遍、数据到了再演一遍。
   修：改成结果落地时 +1 的 `renderSeq`。
3. 上一条 changelog 说全局减动效规则「兜住了」—— 只兜住一半。它没覆盖
   `animation-delay`，于是带 `both` 的交错入场在减动效下变成「隐身 280ms 再逐个弹出」，
   恰好砸在最不想看动效的人脸上。修：全局规则补 `animation-delay` /
   `transition-delay` / `scroll-behavior`。

**其余修复**

- 两个确认模态的忙碌态是**死代码**：`confirmOverwrite` / `confirmUninstall` 都先关模态
  再 await，「正在覆盖…」「卸载中…」永远没机会渲染。改成跑完再关，并在写入期间
  禁掉取消与遮罩关闭（写入不可中断，留个假出口不如禁掉）。
- 本地文件导入**绕过了忙碌闸门**，能在 60s 载荷下载途中并发跑第二个 commit，
  先收工的那个把忙碌态清掉、按钮提前解禁。补 `if (busyId) return`。
- 折叠行收起后**仍在无障碍树里**（0fr + overflow:hidden 只是视觉隐藏），且里面
  `overflow: auto` 的代码块在 Chrome 下可被 Tab 聚焦。补 `visibility`（延迟到动画
  结束）+ `aria-controls`。
- 上游正则 **id 可重复**（不可信输入）：撞号时 `workshopRuleId` 会让后一条静默盖掉
  前一条（「装了 5 条」实际只有 4 条）。`workshop-manifest` 加 `dedupeRegexIds`，
  首次出现者保留原 id。
- 详情模态主按钮不再「卸载时装按钮转圈」（补 `busyAction`）。

**🆕 减少动态效果开关**（设置 → 外观主题，**默认关**）

`settings.reducedMotion` → `<html data-reduced-motion>` → CSS 全站关动画。系统的
`prefers-reduced-motion` 仍**独立生效**，本开关只做「额外强制开启」，不做「强制关闭
系统偏好」。JS 侧不受 CSS 管辖的动作（平滑滚动）走 `lib/reduced-motion.ts` 同一判定。

**🆕 工坊书对所有 Agent 可见**

★ 此前是**装了等于没装**：Agent 只读 `AgentConfig.worldBookIds` 点过名的书，而工坊书
带的是新 id（`workshop:<projectId>`），不在任何 Agent 清单里 —— 于是「装了 + 存档里
勾了启用」的工坊内容，一个 Agent 都读不到。安装时 `grantWorkshopBookToAgents` 把书
挂进所有 Agent，卸载时 `revokeWorkshopBookFromAgents` 收回（不收回会积一串死 id）。

只动 `worldBookIds` 名单，**不碰** `agentWorldbookEnabled` —— 那是另一条轴（「这个
Agent 到底用不用世界书」），项目默认里 memory_recall / plot_pre_check / item_gen /
combat 是刻意关掉的，替用户翻开会让它们凭空吃下整包工坊内容。条目自身的 `enabled`
与存档级 `enabledWorldBookEntries` 仍照常过滤。

涉及文件: `workshop-regex-map.ts`(+`indexBase`) · `workshop-manifest.ts`(+去重) ·
`workshop-types.ts`(+两个 grant/revoke 纯函数) · `workshop-store.ts` ·
`WorkshopPage.vue` · `WorkshopBrowseModal.vue` · `WorkshopDetailModal.vue` ·
`WorkshopConflictModal.vue` · `settings-store.ts` · `SettingsPage.vue` · `App.vue` ·
`themes/variables.css` · 新增 `lib/reduced-motion.ts`

验证: 141 文件 / 4693 测试全绿（+26）· typecheck & vue-tsc 0 错误 · lint 0 error。
🔴 仍**未做真机走查**（预览面板不合成帧、Chrome 扩展未连接）。

---

### 2026-07-31 — 加载态动画：AppButton 忙碌态 + 水合骨架

补的是「按下去之后什么都没发生」的那段沉默。工坊一次安装要下几百 KB 载荷，
这段沉默可以长达几十秒。

**`AppButton` 新增 `loading`**（共享组件，可选 prop，不影响既有调用点）

- 转圈 + 自动禁用 + `aria-busy`；转圈用 `em` 与 `currentColor`，三档尺寸 ×
  四个 variant × 10 主题都不必另配
- ★ 与 `disabled` **语义不同**，别拿 disabled 顶替：disabled 是「不能做」，
  loading 是「正在做」。两者长一个样时，用户按下按钮后只看到它变灰，分不清是
  自己点漏了、还是被拒绝了、还是在跑。故 loading 有自己的压暗度（0.8，
  btn-disabled 的 0.5 会把转圈也压得看不清）

**转圈只落在按下的那个按钮上**：`WorkshopPage` 的 busy 状态从「项目 id」扩成
「id + 动作」（`beginBusy`/`endBusy` 成对）。一行并排三个按钮，只按 id 判定会三个
一起转，用户看不出跑的是「查更新」还是「卸载」—— 卸载不可逆，让它看起来在跑而
实际在跑别的是会吓到人的。

**🔴 水合骨架（顺带修掉一个真错）**：`WorkshopPage` 此前不看 `store.ready`，
于是每次进页面的头一瞬都渲染「尚未安装任何工坊项目」+「已安装（0）」——
对一个装了十个项目的用户来说这两句都是假的。现在水合中渲染骨架行。

**详情模态首屏骨架**替掉一行「正在取详情…」：文字态只有一行高，详情到位后整个模态
从一行猛涨到满屏，那一下窜动比等待本身更让人不适。

**减动效**：删掉本轮新写的 `animation: none` 局部覆盖，统一交给
`themes/variables.css` 的全局规则（`animation-duration: .01ms !important` +
`animation-iteration-count: 1 !important`）。★ 它比 `animation: none` 正确：后者会连
`both` 的终态一起撤销（卡片会停在 `opacity: 0`，减动效用户看到一片空网格），
前者是「瞬间跑完一轮」，天然停在终态。

涉及文件: `AppButton.vue`(+`loading`) · `WorkshopPage.vue` · `WorkshopInstalledList.vue`
(+`busyAction`/`hydrating`) · `WorkshopDetailModal.vue` · `WorkshopConflictModal.vue` ·
新增 `AppButton.test.ts`

验证: 140 文件 / 4667 测试全绿（+9）· typecheck & vue-tsc 0 错误 · lint 0 error。
🔴 同上：**未做真机走查**，动画观感待确认。

---

### 2026-07-31 — 工坊 P1 增补：装前检视 / 服务端排序 / 恒定标签条 + 抗抖动

对齐上游插件（`AkabaneSaki/myrepo`）功能盘点后补的三处差距，外加浏览模态的抖动治理。

**装前检视（详情模态）**

- 世界书条目与正则**逐条可展开**，不再只报一个总数。条目展开后给主/次关键词、
  匹配逻辑、order/position 与完整正文；正则给 pattern、replacement。
- ★ 每条正则带**处置预告**（不会生效 / 全局副作用），走的是安装时那个
  `mapWorkshopRegexes` —— 与装后已装列表**同源**。这是本屏比上游多出来的一件事：
  上游把 ST 字段搬进 ST，没有东西会丢，只需展示 pattern；我们的美化库不是 ST 正则
  引擎，与其装完再说「N 项未导入」，不如装之前就在每一条上标出来。
  🔴 若将来有人在这里另写一套判定，用户就会遇到「装前说好好的、装完说没导入」。
- 长列表先渲 25 行，其余按需 —— 上游有几百条目的项目，一次性展开会让模态卡一拍。

**服务端排序**：`WORKSHOP_SORT_MODES`（published/updated/likes/subscribes/downloads）。
排序必须服务端做且回到第 0 页，否则会排出「第 2 页的热门项目排在第 1 页的冷门项目之前」。
社交**计数**仍不消费（Phase 3+），按它们排序只是一个查询参数。

**恒定标签条**：`WORKSHOP_BASE_TAGS`（系统/扩展/角色/事件）替掉「从当前页现采」。
现采有两处害：翻到不含某标签的页时该标签会消失；条的行数随内容变化，每次翻页都把
下方整个网格顶上顶下。

**抗抖动 + 动画**（design.md §6.1 口径）

- 结果区 `min-height: 420px` —— 末页条数少时模态不再先塌后弹
- 首次加载用**骨架屏**替掉一行文字，先把最终布局占住
- 在飞时旧结果压暗（只动 opacity）而非抽走，屏幕上始终有内容
- 卡片入场 opacity + translateY(12px)/0.35s，逐格递延 40ms 至第 8 格封顶
- 折叠行展开走 `grid-template-rows: 0fr→1fr`（禁止 max-height 过渡）
- 翻页后滚回结果区顶部
- 全部配 `prefers-reduced-motion`（入场动画关掉时显式把卡片摁回可见，
  否则 `animation: none` 会连 `both` 的终态一起撤销 → 一片空网格）

涉及文件: `workshop-types.ts`(+`WORKSHOP_BASE_TAGS`) · `workshop-client.ts`
(+`WORKSHOP_SORT_MODES`) · `WorkshopBrowseModal.vue` · `WorkshopDetailModal.vue` ·
`format.ts` · 新增 `WorkshopDetailModal.test.ts`

验证: 139 文件 / 4658 测试全绿（+13）· typecheck & vue-tsc 0 错误 · lint 0 error。
🔴 **未做真机走查** —— 预览面板不合成帧（Vue `<Transition>` 依赖 rAF，导航卡在
leave 阶段），Chrome 扩展未连接。视觉与动画观感待真机确认。

---

## 历史速览

已完成且稳定的旧 Phase（1-9、10a-g、6x、Geography、Audit Fix）细节由 `docs/phases/` 各计划文档 + git log 承载，不再在此处展开。状态见 `AGENTS.md`「当前进度」速览表。

---

## 未来条目

新 PR 在此处按日期倒序追加，格式:

```
### YYYY-MM-DD — <PR 标题 / Phase>
- 变更内容
- 涉及文件
- 验证方式（测试 / 真机 / 仅编译）
```
