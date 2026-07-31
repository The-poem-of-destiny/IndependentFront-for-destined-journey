# 变更记录 (CHANGELOG)

> **本文件承载「进行中 + 近期交付」Phase 的详细记录。**
> Append-only，新条目加在顶部。已完成且稳定的旧 Phase（1-9、10a-h）细节见 `docs/phases/` + git log，不在此处重复。
>
> 指令文件（`AGENTS.md`）只保留 ≤30 行的 Phase 速览表，不写历史——历史在这里。

---

## 进行中 / 近期交付（按交付时间倒序）

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

| kind | 含义 | 覆盖 |
| --- | --- | --- |
| `dropped` | ST 字段本引擎无对应物，**确实没导入** | `placement` · `maxDepth` · `minDepth` · `runOnEdit` · `promptOnly`（整条跳过）· `substituteRegex` · `trimStrings` · 退休条目 |
| `degraded` | **已装**，但渲染不完整 | ` ```html ` 围栏无渲染器 · 完整 HTML 文档被解析器截断 · `<script>` 惰性 · `{{宏}}` 无替换环节 · 上游重名本地改名 |
| `sideEffect` | **已装**，且有规则自身之外的副作用 | `<style>` 全局生效、可能覆盖应用主题 token |

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

| 问题 | 实测 |
| --- | --- |
| 配额压力 | 内置世界书紧凑序列化 889,962 字符（≈0.85 MB；localStorage 按 UTF-16 计约 1.7 MB），配额通常 5 MB，且溢出**静默 catch** |
| 写放大 | deep watch 在**任何**设置变更时重新 `JSON.stringify` 整个 ≈2 MB 设置对象 |
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
