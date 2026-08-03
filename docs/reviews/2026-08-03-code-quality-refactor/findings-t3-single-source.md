# T3 真源分裂：同一份事实被抄成 2-6 份

> 本文是《[代码质量与重构审查报告（2026-08-03）](README.md)》的一部分。返回 [索引与优先级总表](README.md) · [重构路线图](roadmap.md) · [健康面与覆盖缺口](health-and-gaps.md)

## 成因

仓库反复出现同一模式：一条规则（品质映射、能力面符号表、六步迁移、设置、邻接语义、平衡阈值、Dexie schema）没有可复用出口时，第二个调用点就整段复制。复制发生的当天两份等价，编译器对二者是否仍等价零意见，于是漂移只能靠差分测试或真机撞见。多处漂移已经发生并造成静默降级或数据丢失。

## 本主题的发现

| ID            | 严重度 | 问题                                                                                                                                                                                                             |
| ------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Q-06](#q-06) | 中     | 设置有两个真源（localStorage 与 Dexie settings 表），只有两个字段被手写桥搬运，引擎侧读到的是永远停在默认值的影子配置                                                                                            |
| [Q-08](#q-08) | 中     | 「六步迁移」在三个模块复制了三遍且已开始漂移——仓库里唯一「搞砸即用户数据不可恢复」的路径是复制粘贴                                                                                                               |
| [Q-09](#q-09) | 高     | EJS 能力面契约被记在 6 处（TS 一份、guest 字符串一份、4 张手工名单），已发生 8 次静默渲染漂移，engine.has 已经在说谎，原型污染键集另有 5 份                                                                      |
| [Q-11](#q-11) | 中     | 7 级品质体系有 4 套类型/序号/映射与 5 份颜色表，靠 4 处 as QualityLevel 粘合；ScenePanel 的 TIER_COLOR 缺「唯一」项，T7 角色渲染成灰色                                                                           |
| [Q-12](#q-12) | 中     | 两个同名 applyVarsPatch 契约互斥、types.ts 的 VarsPatch 类型两边都不兑现，而其中一份的宿主已是零引用僵尸                                                                                                         |
| [Q-16](#q-16) | 中     | store 层没有共享工具层：detach helper 复制 8 份、配额判据与素材路径工具各两份、game-store 三个 metadata 写函数纪律不一                                                                                           |
| [Q-21](#q-21) | 中     | 战斗/制作结算层的四处复制：集群攻击次数与 AoE 两份逐字实现（注释自陈分叉）、17 参数的 runDamagePipeline 调用两份、15 字段的 CraftActionRequest 装配两份且各自掷骰、craft-resolver 把世界书文本面板焊在结算数学上 |
| [Q-26](#q-26) | 中     | database.ts 里 16 个 Dexie 版本各自全量重述整份 schema，约 390 行是同一张表清单的拷贝                                                                                                                            |
| [Q-30](#q-30) | 中     | start-catalog.ts：8752 行从 CDN 抓来的数据硬编成 TS 模块塞在引擎目录，并顺手第二次定义了 Rarity 与品质映射                                                                                                       |
| [Q-31](#q-31) | 低     | location-db 的邻接关系有两套语义：buildAdjacency 双向对称化，而同一命名空间下的 areAdjacent/getEdge 只看单向                                                                                                     |

<a id="q-06"></a>

### Q-06 设置有两个真源（localStorage 与 Dexie settings 表），只有两个字段被手写桥搬运，引擎侧读到的是永远停在默认值的影子配置

- **严重度**：中
- **主题**：真源分裂：同一份事实被抄成 2-6 份，每份都是一条静默漂移线
- **位置**：`src/ui/stores/settings-store.ts:74`、`src/sillytavern/database.ts:518`、`src/sillytavern/database.ts:586`、`src/sillytavern/state-manager.ts:1353`、`src/ui/lib/game-pipeline.ts:158`、`AGENTS.md:364`
- **工作量**：M　**风险**：中
- **来源**：CORE-08

**证据**

AGENTS.md 架构图第 364 行写：「lorebooks 是 v3 遗留 `Lorebook` 类型的**死表**，生产代码零读写 …… settings 同为死表。」

`lorebooks` 确实死透（`getLorebooks` / `saveLorebook` / `deleteLorebook` 全仓零非测试调用），但 `settings` 不是，它至少有三处活引用：

- database.ts:518 `initializeDatabase()` 首启时 `db.settings.put({ ...DEFAULT_SETTINGS, key: 'settings' })` 播种；
- state-manager.ts:1353 每次打快照时 `const settings = await getSettings()`，取 `maxSnapshotsPerSave` / `snapshotRetentionMode`；
- database.ts:586 与 :692-698 的 FullBackup 导出/导入也读写这张表。

与此同时前端设置存在 localStorage：settings-store.ts:74 `const STORAGE_KEY = 'fated-poem-settings'`，一个 ref 全量 deep watch 写盘。两侧靠 game-pipeline.ts:158 的 `private async syncSnapshotSettings()` 搭桥，函数注释自陈「createSnapshot/restoreSnapshot 读数据库 AppSettings 而非 settings-store → 此处搭桥」，函数体只搬两个字段，且以 `catch { console.warn(...) }` 静默失败。

**影响**

`AppSettings` 有几十个字段，只有两个被搬过去。引擎侧任何新增的「读 settings」都会读到一份永远停留在 `DEFAULT_SETTINGS` 的影子配置，症状是「设置页明明改了，引擎行为没变」；而桥接失败时只 warn 不报，用户完全无感。文档把这张表记成死表，会让下一个排查的人直接跳过它——三处活引用（尤其 FullBackup）使这句文档比缺失更有害。

**重构建议**

选一侧当真源，推荐把引擎侧的读取口收成一个注入缝：

1. 新增 `src/sillytavern/engine-settings.ts`，暴露 `getEngineSettings(): EngineSettings` 与 `setEngineSettingsProvider(fn)`；`state-manager.createSnapshot` 改调它。
2. `main.ts` 启动时用 settings-store 注册 provider（settings-store 继续持久化到 localStorage 是刻意的——按 AGENTS.md，应用 localStorage 现在只存无密钥设置元数据，所以 provider 是正确的缝而不是把设置搬进 Dexie）。
3. 删掉 `game-pipeline.syncSnapshotSettings` 与 database.ts `initializeDatabase` 里的 settings 播种。表本身按数据安全约定保留不删，仅停止读写。
4. FullBackup 侧要单独确认：当前导入会 `bulkPut` 一行 settings，去掉播种后这行会恢复进一张没人读的表——要么同步删掉导入分支，要么在注释里写明它只为老备份兼容而保留。
5. 最后把 AGENTS.md:364 那句改成事实描述。

<a id="q-08"></a>

### Q-08 「六步迁移」在三个模块复制了三遍且已开始漂移——仓库里唯一「搞砸即用户数据不可恢复」的路径是复制粘贴

- **严重度**：中
- **主题**：真源分裂：同一份事实被抄成 2-6 份，每份都是一条静默漂移线
- **位置**：`src/ui/stores/worldbook-migration.ts:113`、`src/ui/stores/beautifier-migration.ts:138`、`src/ui/stores/beautifier-migration.ts:233`、`src/ui/stores/beautifier-migration.ts:241`、`src/ui/stores/beautifier-migration.ts:252`、`src/ui/stores/api-key-migration.ts:115`
- **工作量**：M　**风险**：中
- **来源**：STORE-02, XCUT-01

**证据**

`beautifier-migration.ts:4` 的文件头自称与 `worldbook-migration.ts`「同一套六步机制」，但实现是整份复制而非复用。`dedupeIds` 两份逐字符相同，只有 `book`→`rule`、`WorldBookIdRename`→`BeautifierRuleIdRename` 的差别：

```ts
const taken = new Set<string>(rows.map((b) => b.id));
const seen = new Set<string>();
// ...
let n = 2;
let candidate = `${book.id}__dup${n}`;
while (taken.has(candidate) || seen.has(candidate)) {
  n += 1;
  candidate = `${book.id}__dup${n}`;
}
```

主流程骨架同样逐字重复：`readSource`（:75 / :108）→ 标志位判定 → `db.transaction('rw', table, ...)` + `if (rows.length > 0) bulkPut` → `bulkGet(ids)` 回读 + `new Set(ids).size !== ids.length` 不变式守卫 + 逐行 id 比对 + 三条 failed 分支文案（:185-215 / :231-265）→ `delete settings[LEGACY_KEY]; settings[FLAG] = Date.now(); persistSettings();`，连「从 settings 对象上删键、而不是只改 localStorage 字符串」那段注释都一样。`api-key-migration.ts:115` 的 `migrateApiKeysToDexie` 是第三份，形状相同但注释换成英文、回读失败走 `throw` + 外层 catch 而非直接返回 outcome。

漂移已经发生，而且分两类。校验强度那类是真漂移：worldbook 版回读只比 `entries.length`、beautifier 版比 `pattern`/`replacement`、api-key 版比 `apiKey`。模块内不对称那类也在：beautifier 的 catch 分支都会 `if (presetCacheDropped) persistSettings();`，而 try 内三条 verify 早退（:233/:241/:252）漏了这一句。

> 复核修正：两点需要下调。（1）「worldbook 版 verify catch 不调 persistSettings、另两份调」不成立——beautifier 只在 `presetCacheDropped` 时调（那是与迁移状态无关的预设缓存清理），api-key 的 verify catch（:181-192）根本不调。（2）beautifier 内部那处不对称在效果上是无害的：`settings-store.ts:258` 装了 `watch(settings, saveNow, { deep: true })`，删掉的键下一 tick 必然落盘——它是拷贝气味而非数据 bug。另外「291 行里约 200 行是拷贝」偏高：beautifier 有约 60 行 worldbook 没有的内容（`pruneLegacyBuiltinOverrides` :57-71、`dropPresetCache` :176-180、贯穿每个 outcome 变体的 `presetCacheDropped` 字段），共享部分约 150 行。

api-key 那份的差异则大半是**刻意**的：它没有 dedupe（直接以 "IDs are missing or duplicated" 判失败，:120-128）、不把标志位当充分条件（`&& !legacyKeysRetained`，:146）、多一个带标志位回滚的第 4 阶段 scrub（:194-206）、还要把本地条目 merge 回去。

**影响**

这是仓库里唯一「用户唯一副本 + 校验通过就删源」的数据销毁路径，文件头自己写着「宁可迁移永不成功，也不能半成功」，却存在三份可以各自漂移的实现。以后要修 dedupe 规则、加一个 stage、或提升回读校验强度，必须记得改三处；漏一处的代价不是编译错误，而是用户世界书或美化规则静默永久丢失。第三次迁移（工坊/正则 KV 再迁）一定会复制出第四份。缓解事实是三份各有 sibling 测试（`worldbook-migration.test.ts` / `beautifier-migration.test.ts` / `api-key-migration.test.ts`），漂移目前至少是按模块守住的——这也是严重度停在「中」而不是「高」的原因。

**重构建议**

**只合并 worldbook + beautifier 这一对**，api-key 明确留在外面。理由是上面列的四条差异（无 dedupe、非标志位闸门、第 4 阶段 scrub + 回滚、merge 回本地）要塞进同一个泛型签名，等于把泛型骨架撑成一个带四个开关的怪物，风险大于收益。

新建 `src/ui/stores/legacy-dexie-migration.ts`，导出：

- `dedupeById<T extends { id: string }>(rows: T[], nameOf: (row: T) => string): { rows: T[]; renames: IdRename[] }`——就是现在那两份逐字相同的实现，只此一份。
- `runLegacyMigration<T>(opts): Promise<LegacyMigrationOutcome<T>>`，opts = `{ flagKey, legacyKey, table: Dexie.Table<T, string>, idOf, nameOf, toRow(src): T, verifyRow(expected: T, actual: T | undefined): string | null, preStep?(): boolean, settings, persistSettings }`，返回 `{ status: 'already-migrated' | 'migrated' | 'failed', stage?, message?, rows?, renames?, preStepResult? }`。

六步流程、dedupe、回读骨架、第 4 步销毁顺序全部收敛到这一份。两个调用方退化成回调：`worldbook-migration.ts` 的 `toRow = 盖 updatedAt`、`verifyRow = 比 entries.length`；`beautifier-migration.ts` 的 `toRow = 删 locked`、`verifyRow = 比 pattern/replacement`。

注意两条实现约束，不满足就别动：（1）beautifier 有一个 worldbook 没有的**第 0 步无条件副作用** `dropPresetCache`，它必须在标志位判定之前执行，并且要在每一条失败分支上都被如实报出——所以签名需要 `preStep` 加一个贯穿所有 outcome 变体的旁路字段，不能只有 `toRow`/`verifyRow`。（2）抽完后不要把 verifyRow 强度「统一」成较弱的那份；两个 verifyRow 各自保留现有强度，抽取本身不改变行为。测试上，把两份现有测试合成一份泛型流程测试（覆盖六步的每条失败分支与 dedupe 改名）+ 两份薄的 adapter 测试（只断 toRow/verifyRow 语义），`api-key-migration.test.ts` 原样不动。

<a id="q-09"></a>

### Q-09 EJS 能力面契约被记在 6 处（TS 一份、guest 字符串一份、4 张手工名单），已发生 8 次静默渲染漂移，engine.has 已经在说谎，原型污染键集另有 5 份

- **严重度**：高
- **主题**：真源分裂：同一份事实被抄成 2-6 份，每份都是一条静默漂移线
- **位置**：`src/sillytavern/ejs-runtime.ts:555`、`src/sillytavern/ejs-runtime.ts:646`、`src/sillytavern/ejs-quickjs-backend.ts:841`、`src/sillytavern/ejs-quickjs-backend.ts:939`、`src/sillytavern/ejs-quickjs-backend.ts:1036`、`src/sillytavern/ejs-quickjs-backend.ts:949`、`src/sillytavern/ejs-quickjs-backend.ts:442`、`src/sillytavern/ejs-capabilities.ts:96`、`src/sillytavern/ejs-capabilities.ts:405`、`src/sillytavern/ejs-capabilities.ts:425`、`src/sillytavern/ejs-capabilities.ts:607`、`src/sillytavern/ejs-preflight.ts:60`、`src/sillytavern/ejs-vars-diff.ts:48`、`src/sillytavern/var-resolver.ts:43`、`src/sillytavern/ejs-lodash-shim.ts:370`
- **工作量**：L　**风险**：中
- **来源**：WB-01, WB-02, WB-06, WB-05

**证据**

同一套 EJS 注入面被写了两遍，且「面里有哪些名字」另由四张手工名单各记一遍。

宿主侧 `buildSandboxArgs`（`ejs-runtime.ts:555-719`，TypeScript）实现 getMessageVar/setMessageVar/getvar/setvar/getLocalVar/setLocalVar/variables/matchChatMessages/`__roll`/`__random`/getChatMessage/getChatMessages/getwi/YAML/TavernHelper/toastr/alert/message_id/lastMessageId/localStorage/console 共 21 个别名符号，外加 splitPath/getByPath/readPath/writePath/mergeVarsWithClonedStats/stripStatDataPrefix/hasStatDataPrefix 7 个私有辅助。guest 侧 `GUEST_FACADE`（`ejs-quickjs-backend.ts:841-1052`，210 行 JS 字面量字符串）把这 21 个符号与 9 个辅助逐条重写一遍，再加 chat/char/quest/lore/local/ui/fmt/rng/`_` 九个 namespace 门面。对照两处 localStorage shim 即可看出逐字同构：

```ts
// ejs-runtime.ts:646
getItem: (k) => {
  const v = caps.local.get(String(k ?? ''), null);
  /* … */ return typeof v === 'string' ? v : JSON.stringify(v);
};
```

```js
// ejs-quickjs-backend.ts:1037（字符串内）
getItem: function (k) { var v = globalThis.local.get(String(k), null); /* … */ return typeof v === 'string' ? v : JSON.stringify(v); }
```

文件注释自己登记了 8 次已发生的漂移：trim 未吞空白（DEFECT A，scrambled 语料 107/109 命中）、`__proto__` 漏判（DEFECT B）、`_.chain` 整表漏掉（`CHAIN_METHODS`，`ejs-lodash-shim.ts:370` 与 `ejs-quickjs-backend.ts:918` 两张手抄表）、别名层「整个漏了」（:940）、正则编组退化成 includes、`world.isDaytime` 被 JSON 吃掉、能力面预算从条目级变 pass 级、rng 播种粒度不同。guest 那一份不过 tsc、不过 eslint、不进覆盖率。

「沙盒里存在哪些符号」由四处独立维护：① `SANDBOX_PARAM_NAMES`（`ejs-runtime.ts:281-331`，43 个形参名，顺序还必须与 `buildSandboxArgs` 的返回数组一一对应）；② `CAPABILITY_PATHS`（`ejs-capabilities.ts:530-605`，供 `engine.has()` 探测的 70 条路径）；③ `CAPABILITY_SYMBOLS` + `ALIAS_SYMBOLS`（`ejs-preflight.ts:60-99`）；④ guest 侧的 `fmtNames`/`rngNames` 字符串数组（`ejs-quickjs-backend.ts:892`、:896）。已经对不上：`world.isDaytime` 在 `ejs-capabilities.ts:261` 是真实能力（QuickJS 后端还为它专门补了 shim，:452），但 `CAPABILITY_PATHS` 的 world 段（548-552）只有时间/时间详情/地点/天气/回合，创作者写 `engine.has('world.isDaytime')` 拿到 `false`；`engine.name`（:609）同样有实现而不在表内。

类型面同样有洞：`EjsCapabilities`（`ejs-capabilities.ts:623-634`）里 chat/char/quest/lore/local/ui 都有具名接口，唯独 `world: Record<string, any>`（:626）与 `engine: Record<string, any>`（:631），其构造函数 `buildWorld`(:240)/`buildEngine`(:607) 返回类型也是 `Record<string, any>`。后果直接写在 `ejs-quickjs-backend.ts:437-443` 的注释里——`world.isDaytime` 是函数，JSON 编组会整个丢掉，guest 里调用抛 TypeError 整条目回退原文，而 Legacy 下工作正常；修法是字符串索引加断言。

安全不变式也散成 5 份。权威定义是 `var-resolver.ts:43` 的 `export const DANGEROUS_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__','prototype','constructor'])`（`ejs-runtime.ts:37` 正确 import），但另有四份副本：`ejs-capabilities.ts:96`/:405/:425 三处内联布尔表达式（同一文件、判定顺序还各不相同）、`ejs-vars-diff.ts:48` 的 `DANGEROUS_KEYS`、`ejs-quickjs-backend.ts:949` guest 字符串内的 `var DANGER_SEGMENTS = ['__proto__','prototype','constructor'];`（:945-947 注释记录了这里曾因写成对象字面量而漏判 `__proto__` 的 DEFECT B）。

> 复核修正：三点收窄。① `engine.has` 的谎是单向的——`getLocalVar`/`setLocalVar`/`charLoreBook`/顶层 `stats`/`vars` 都在表内，失效模式是「静默禁用可用能力」而非崩溃。② WB-06 原文称「直接导致 4 处 as any」，实数不足，且 `isDaytime` 已被 shim 覆盖，当前无 live 缺陷，故该子项按低严重度处理。③ 五份原型污染键集目前语义等价，无 live bug；其严重性来自 DEFECT B 的先例。

**影响**

每加一个能力面符号、每改一次读写优先级，都必须同时改两处，其中一处编译器完全不看。已付出的代价是 8 个只能靠差分测试发现的静默渲染分叉——不报错，只是两个后端渲染出不同字节。唯一的守卫是依赖 LegacyBackend 存在的 `ejs-backend-parity.test.ts`，而备忘录里的 Legacy 退役计划会把它一并删掉，届时 `GUEST_FACADE` 完全无人看守。`engine.has()` 是文档承诺给创作者的能力探测口，它说谎会让创作者的守卫分支反过来禁用可用能力，且完全无声。原型污染键集分散在 5 处，任何一次收紧（比如将来要加 `valueOf` 或 Symbol 键）都必然遗漏几处，而遗漏的后果只会在别处以奇怪现象冒出来。

**重构建议**

必须在 Legacy 退役之前或同时做，否则失去唯一的差分护栏。顺序如下：

1. **别名层单一源码**。新建 `src/sillytavern/ejs-alias-source.ts`，导出纯字符串常量 `ALIAS_LAYER_SOURCE`（用标准 ES5 写别名层与 splitPath/readPath/writePath/isDanger），并**参数化根对象**——宿主侧别名闭包在 `ctx`/`caps` 上（readPath/writePath 直接改 `ctx.vars`，setLocalVar 走 `caps.local`），guest 侧读 `globalThis.vars`/`globalThis.local`，共享源码必须把这个根作为入参而非硬写。guest 侧直接 `evalCode` 它，宿主 Legacy 侧用 `new Function('ctx', ALIAS_LAYER_SOURCE + ';return __aliases;')` 装配同一份。删掉 `GUEST_FACADE` 的 939-1050 那 110 行手抄；`CHAIN_METHODS` 从 `ejs-lodash-shim.ts` 导出成数据由两侧共读。**不要**用 `?raw` import 真 .js 文件的方案——`src/sillytavern/` 由裸 `tsc` 编译（`npm run build` → `dist/`，package.json 声明 `main: dist/sillytavern/index.js`），tsc 不认 `?raw`，会直接打断库构建。Legacy 退役前不要先删 parity 测试。
2. **能力面 SSOT**。在 `ejs-capabilities.ts` 导出 `export const EJS_SURFACE: { namespaces: Record<string, readonly string[]>; aliases: readonly string[] }`，从它派生 `CAPABILITY_PATHS`（展平 namespaces）、`ejs-preflight.ts` 的两张 Set（直接 import，删掉 60-99 手抄）、guest 的 fmtNames/rngNames（注入 JSON 而非硬写数组）。`SANDBOX_PARAM_NAMES` 与 `buildSandboxArgs` 的位置对应改成「名字→值」的对象，用 `Object.keys()` 取形参名，消灭顺序不变式（该不变式仅限 `ejs-runtime.ts` 内部，AGENTS.md 未约束）。SSOT 落地后再补测试：遍历每个 namespace 的每个 key 断言 `engine.has('<ns>.<key>')` 为真——这条测试今天直接加会在 `charLoreBook` 这类合法未入表的字段上误报，必须等 SSOT。
3. **补两个接口**。加 `export interface EjsWorld { 时间: string; 时间详情: EjsWorldTimeDetail | null; 地点: string; 天气: string; 回合: number; isDaytime(): boolean }` 与 `export interface EjsEngine { name: string; version: string; has(path: string): boolean }`，`buildWorld`/`buildEngine`/`EjsCapabilities` 三处改用。**中文字段名必须逐字保留**——它们是两个后端与 `CAPABILITY_PATHS` 共同认定的创作者契约，加接口时改名是静默破坏。再立一条显式编组分界 `function marshalWorld(w: EjsWorld): { data: Omit<EjsWorld,'isDaytime'>; isDaytime: boolean }`，把「哪些字段过 JSON、哪些降成常量 shim」写成有类型的函数，取代散在 `installCapabilities` 里的两段注释。
4. **收口危险键集**。`ejs-capabilities.ts` 与 `ejs-vars-diff.ts` 一律改 `import { DANGEROUS_PATH_SEGMENTS } from './var-resolver'`，三处内联表达式换成 `DANGEROUS_PATH_SEGMENTS.has(k)`（`ejs-capabilities.ts` 里可再抽一个局部 `isSafeKey(key: unknown): string | null` 收掉 safeKey/bucket 两处）。guest 那份只能靠第 1 步的共享源码或由宿主 `JSON.stringify([...DANGEROUS_PATH_SEGMENTS])` 注入数据轴解决——这一项是第 1 步的依赖项，不是独立的 S 级收益。

<a id="q-11"></a>

### Q-11 7 级品质体系有 4 套类型/序号/映射与 5 份颜色表，靠 4 处 as QualityLevel 粘合；ScenePanel 的 TIER_COLOR 缺「唯一」项，T7 角色渲染成灰色

- **严重度**：中
- **主题**：真源分裂：同一份事实被抄成 2-6 份，每份都是一条静默漂移线
- **位置**：`src/sillytavern/field-enums.ts:30`、`src/sillytavern/field-enums.ts:90`、`src/sillytavern/types.ts:2195`、`src/sillytavern/types.ts:2197`、`src/sillytavern/start-catalog.ts:5`、`src/sillytavern/start-catalog.ts:8744`、`src/ui/lib/quality-colors.ts:2`、`src/ui/lib/quality-colors.ts:15`、`src/ui/components/game/ScenePanel.vue:133`、`src/ui/components/game/ScenePanel.vue:142`、`src/ui/components/create/SelectableCard.vue:12`、`src/ui/components/create/SelectableCard.vue:15`、`src/ui/components/create/QualityFilter.vue:7`、`src/ui/components/create/CreateStepConfirm.vue:103`、`src/ui/components/create/CreateStepConfirm.vue:113`、`src/ui/components/create/SelectedPanel.vue:32`、`src/ui/components/game/cards/CharGenSystemCard.vue:10`、`src/ui/components/game/cards/CharGenSystemCard.vue:20`、`src/ui/components/game/combat/CombatUnitCard.vue:34`、`src/ui/components/game/ItemsPanel.vue:19`、`src/ui/components/game/ItemsPanel.vue:37`、`src/ui/components/game/ItemsPanel.vue:52`、`src/ui/components/game/ItemsPanel.vue:68`、`src/ui/components/game/ItemsPanel.vue:84`、`src/ui/components/game/ItemsPanel.vue:132`、`src/ui/components/game/CharacterListPanel.vue:14`
- **工作量**：M　**风险**：中
- **来源**：UI-02, XCUT-04, UI-06

**证据**

**类型层：同一个 7 元集合有三个导出类型名。** `field-enums.ts:30` `export type Rarity = (typeof RARITY_LEVELS)[number]`（中文，铁律 5 指定的 SSOT）；`types.ts:2195` `export type QualityLevel = '普通' | '优良' | ... | '唯一'`（同一个联合，另一个名字，13 个文件在用）；`start-catalog.ts:5` `export type Rarity = 'common' | ... | 'only'`（英文，**与 field-enums 的 `Rarity` 同名不同义**）。

**转换与序号层：各两份且已分叉。** `field-enums.ts:90` 的 `RARITY_ALIASES` 同时收 `unique` 与 `only`，:100 的注释「start-catalog 池的第七级英文名（CDN 数据遗留）」证明它知道另一张表存在却没合并；`start-catalog.ts:8744` 的 `RARITY_TO_QUALITY: Record<string, string>` 只有 `only`。序号表 `types.ts:2197` `QUALITY_RANK`（0 起，`craft-quality.ts` 在用）对 `ItemsPanel.vue:84-92` 内联的 `rank`（1 起、字面倒序）。因为 `RARITY_TO_QUALITY` 的值类型是裸 `string`，捏人页只能强转：`CreateStepConfirm.vue:103`/`:113`、`SelectableCard.vue:12`、`SelectedPanel.vue:32`。

**颜色层：canonical 一份 + 平行四份。** `lib/quality-colors.ts:2` 的 `QUALITY_TO_VAR` 是 design.md §5.3 指定的唯一入口，但另有：

- `ScenePanel.vue:133` `TIER_COLOR` —— **只有六项，缺 `唯一`**，`tierColor()`（:142）落到 `var(--theme-text-muted)`
- `SelectableCard.vue:15` `RARITY_QUALITY_VAR` —— 同样七个 var，按英文 rarity 键
- `QualityFilter.vue:7` `FILTER_OPTIONS` —— 又一遍，内联在选项列表里
- `CharGenSystemCard.vue:10` `TIER_COLORS: Record<number, string> = { 1: '#57595D', ..., 7: '#00FFFF' }` 外加 :20 一张 40 项 `RACE_COLORS` 裸 hex 表——主题无关，直接违反 design.md §1 与 §8 检查项，也是 components/ 里 144 个 hex 字面量的最大来源

**外溢的游戏规则。** `inferQuality(stats)`（按 50/30/20/10 阈值把属性总和推成品质）在 `ItemsPanel.vue:19` 与 `CharacterListPanel.vue:14` 逐字重复两份，`grep -rn "inferQuality\|deriveQuality" src/` 在引擎侧零命中——一条确定性游戏规则住在两个视图组件里，无测试，且两份都封顶在 `传说`，永远返回不了 `神话`/`唯一`。同一文件 `ItemsPanel.vue:37` 的 `computed<any[]>` 又逼出 18 处 `as any`（全 slice 最高）。

> 复核修正（两处，标题据此收窄）：（1）标题里的「5 处 as any」实为 4 处，且都不是 `as any` 而是 `as QualityLevel`（`CreateStepConfirm.vue` 一个文件两处，加 `SelectableCard.vue:12`、`SelectedPanel.vue:32`）。（2）「`normalizeRarity('unique')` 已在静默降级成普通」**当前不成立**：`grep -o "rarity: '[a-z]*'" start-catalog.ts | sort -u` 只有 common/uncommon/rare/epic/legendary/mythic/only，池子里根本没有 `unique`，这是潜在分叉而非已发生的 bug。**已发生的是另一条**：ScenePanel 的 `TIER_COLOR` 缺 `唯一`，本次已开文件核对确认。

**影响**

加第八级品质、改名、或重排调色板，要同时改 4 张类型/序号表 + 5 张颜色表，任何一处 grep 关键字都盖不全，编译器一处都拦不住。已经可见的后果有两条：ScenePanel 里 `唯一` 角色渲染成静音灰、别处渲染成金色，没有任何东西会失败；`CharGenSystemCard` 的 hex 表让该卡片完全不跟随主题，在 `indigo`/`ivory` 等浅色主题下 `#FFD700`/`#00FFFF` 徽章不可读。`|| '普通'` 这类兜底会把未来的数据错误直接变成静默降级。`inferQuality` 的阈值要改就得记住两份，今天它俩一致纯属运气；`any[]` 擦除让模板不受检——引擎里改名 `equippedSlot` 会在 typecheck 全绿的情况下让背包面板运行时炸掉。

**重构建议**

按下面顺序，每步可独立开 PR。

1. **类型收敛。** `types.ts` 的 `QualityLevel` 与 field-enums 的 `Rarity` 只留一个，另一个改成 `export type X = Y` 别名并标 `@deprecated`。`start-catalog.ts` 的英文 `Rarity` 改名 `CatalogRarityCode`（**该文件由 CDN 生成，生成器必须同步改，否则下次重生成会回退**），删掉 `RARITY_TO_QUALITY`，捏人页四处 cast 改调 `normalizeRarity(code)`——返回类型就是 `Rarity`，cast 自然消失。
2. **补齐并上闸。** `RARITY_ALIASES` 收全 start-catalog 池里出现过的所有编码，加一条测试断言「start-catalog 里出现过的每个 rarity 码都能被 `normalizeRarity` 认出」——这条测试就是防再次分叉的闸门。
3. **序号派生。** `QUALITY_RANK` 改由 `RARITY_LEVELS.indexOf` 派生（不影响 `craft-quality.ts`），删掉 `ItemsPanel.vue` 的内联 `rank` 改 import。
4. **颜色收敛。** `lib/quality-colors.ts` 成为唯一品质呈现模块：`QUALITY_TO_VAR` 改由 `RARITY_LEVELS` 构建（新增等级不可能漏），:15 的兜底从硬编码 `#9ca3af` 改成 `var(--theme-quality-common)`；新增 `qualityVarFromRarity(code)` 取代 `SelectableCard` 与 `QualityFilter` 的两张表；新增 `quality-colors.test.ts` 断言 `RARITY_LEVELS` 每一项都映射到互不相同的非兜底 var。
5. **tier 那条线要单独裁定，不能顺手并进品质表。** `ScenePanel` 传进 `tierColor()` 的是 tier 名，而 `tier-constants.ts` 的 `TIER_CONFIG` 名称（中坚/精英/神祗等）与品质名不是同一套词汇——直接换成 `qualityVar(tierName)` 会把同一个 bug 搬个家。正确做法是在 `quality-colors.ts` 里另建一张由 `TIER_CONFIG` 派生的 tier→var 映射（或先定 tier→quality 的官方对应关系），`ScenePanel.TIER_COLOR`、`CharGenSystemCard.TIER_COLORS`、`CombatUnitCard.TIER_TO_QUALITY` 三处一起指过去。`RACE_COLORS` 需要一个真决定：要么在 `themes/variables.css` 加 `--theme-race-*` token，要么去掉种族着色、名字走 `--theme-text-primary`。
6. **规则下沉。** 新建 `src/sillytavern/quality-inference.ts` 导出 `inferQualityFromStats(stats?: Record<string, number>): Rarity`，基于 `RARITY_LEVELS` 构建（并在那里裁定 `神话`/`唯一` 是否可达），配 `quality-inference.test.ts`；两个组件 import，删掉两份本地副本。这符合 ADR-11（阈值规则属确定性 Code）与「必须写测试」约定。
7. **顺带消掉 `ItemsPanel` 的 `any[]`：** 引入局部视图模型判别联合 `type PanelEntry = { kind: 'item'; row: InventoryItem } | { kind: 'skill'; row: Skill }`，`currentItems` 改 `computed<PanelEntry[]>`，模板按 `entry.kind` 收窄，18 处 cast 归零。三处分类三元表达式只把 `filterOptions`/`filteredItems` 两处提成共享的 `facetOf(entry): string`；**`selTypeLabel`（:132-141）不要并进去**——它返回的是 `主动技能`/`被动技能` 并对缺失值回退 `装备`/`物品`，是展示层映射，合并会改掉详情头的文案。

<a id="q-12"></a>

### Q-12 两个同名 applyVarsPatch 契约互斥、types.ts 的 VarsPatch 类型两边都不兑现，而其中一份的宿主已是零引用僵尸

- **严重度**：中
- **主题**：真源分裂：同一份事实被抄成 2-6 份，每份都是一条静默漂移线
- **位置**：`src/sillytavern/vars-merger.ts:17`、`src/sillytavern/var-resolver.ts:195`、`src/sillytavern/types.ts:770`、`src/sillytavern/state-manager.ts:208`、`src/sillytavern/variables.ts:50`、`src/sillytavern/index.ts:10`
- **工作量**：S　**风险**：低
- **来源**：CORE-03, CORE-06

**证据**

仓库里有两个导出名都叫 `applyVarsPatch` 的函数，契约互斥：

`vars-merger.ts:17` `export function applyVarsPatch(existing, patch: VarsPatch)` 的函数体是 `return deepMerge(existing, patch.merge);`——只看 `merge`，把 `VarsPatch` 上声明的 `replace`/`delta`/`insert` 三个字段静默丢掉。

`var-resolver.ts:195` `export function applyVarsPatch(variables, patch: { replace?; delta?; insert?; remove?; move? })` 反过来只处理这五项，且形参用的是就地写死的匿名结构而非 `types.ts` 的 `VarsPatch`——它认识 `remove`/`move`（`VarsPatch` 上没有），不认识 `merge`（`VarsPatch` 上有）。

`types.ts:770` 的 `VarsPatch { merge; replace?; delta?; insert? }` 注释写着「支持 mvu_update 协议的 replace/delta/insert」，但**没有任何一个实现兑现这份声明**。`state-manager.ts:208` 的 `vars = applyVarsPatch(vars, diff)` 走的是 var-resolver 那份，EJS 差量（`ejs-vars-diff` 出的 `{replace, remove}`）能过；若有人照 `types.ts` 的类型签名构造一个带 `merge` 的 `VarsPatch` 交给它，`merge` 会被无声吞掉。

而 vars-merger 那份的宿主已经死了。逐个 grep（`src/` 与 `tests/` 全域，含 `.vue`、含测试文件）：`extractVariables` 仅命中定义行 `variables.ts:8`、`mergeVariables` 仅 `:27`、`USER_ROLE` 仅 `:41`、`applyParsedToChat` 仅 `:46`、`parseVarsBlock` 仅 `vars-merger.ts:3`——零调用零测试。`vars-merger.applyVarsPatch` 的唯一消费方是 `variables.ts:50` 里的 `applyParsedToChat`，而后者本身零调用，所以 `vars-merger.ts` 整模块在生产与测试里都不可达。`variables.ts` 唯一活着的导出是 `formatVariablesForPrompt`，消费方是 `prompt-assembler.ts:7/163/169`——那正是 Q-04 要删的死模块。两个文件都没有 sibling 测试；`variables.ts:43` 的注释还记着「v3 遗留的 truncateChatAt / branchChat / aggregateEvents 已随 M1 #48/#33 删除」，说明这批遗留只清了一半。

> 复核修正：名字撞车目前是**潜伏陷阱而非现行缺陷**——merge 那条路径在生产中不可达（宿主 `applyParsedToChat` 零引用），auto-import 也只在文件还留在树里时才可能点错。因此严重度从高下调到中。残留的真实问题是 `types.ts:770` 那三个从未被兑现的可选字段。

**影响**

两个语义不同的函数共用一个名字、靠 import 路径区分，是 auto-import 最容易点错的一类。类型给出的承诺比任一实现都大，编译器不会拦；错配的后果是变量补丁部分丢失且无任何日志。变量是存档唯一真源（M5），静默丢补丁在真机上极难自查。删掉僵尸宿主就顺手拆掉了这个陷阱——S 级投入、几乎零风险的清障。

**重构建议**

按下面顺序做，前两步做完陷阱就没了。

1. 删 `src/sillytavern/vars-merger.ts` 整个文件；删 `variables.ts` 的 `extractVariables`/`mergeVariables`/`USER_ROLE`/`applyParsedToChat` 四个导出与随之无用的 `ParsedTags` import。**同一 commit 内删掉 `index.ts:10` 的 `export * from './variables'`**——本仓库同时被描述为可复用的 ST 兼容引擎库，从 barrel 摘导出是对外 API 变更，宁可连 barrel 那一行一起删，也别假设没有外部消费者（若 Q-04 第三批已把 barrel 整个删掉，这一步自动消解）。
2. `variables.ts` 只剩 `formatVariablesForPrompt` 一个函数时，直接把它并进它唯一的调用方 `prompt-assembler.ts` 并删掉 `variables.ts`；若 Q-04 已删 `prompt-assembler.ts`，则 `variables.ts` 整个随之删除。
3. 让类型与实现对齐：`var-resolver.ts:195` 那份改名 `applyPathOps(variables, ops: VarPathOps)`，在 `types.ts` 新增导出类型 `VarPathOps { replace?; delta?; insert?; remove?; move? }`（放 `types.ts` 符合「唯一类型来源」约定），`state-manager.ts:208` 与 `ejs-vars-diff` 的产物都对准它。
4. 删掉 `types.ts:770` 的 `VarsPatch`——它的两个实现都已消失或改名，留着只会继续做出没人兑现的承诺。若有外部形状依赖不能删，则只保留 `merge` 一个字段，去掉三个从未被实现的可选字段。

<a id="q-16"></a>

### Q-16 store 层没有共享工具层：detach helper 复制 8 份、配额判据与素材路径工具各两份、game-store 三个 metadata 写函数纪律不一

- **严重度**：中
- **主题**：真源分裂：同一份事实被抄成 2-6 份，每份都是一条静默漂移线
- **位置**：`src/ui/stores/worldbook-store.ts:22`、`src/ui/stores/beautifier-store.ts:30`、`src/ui/stores/workshop-store.ts:136`、`src/ui/stores/settings-store.ts:90`、`src/ui/stores/worldbook-migration.ts:87`、`src/ui/stores/game-store.ts:463`、`src/ui/stores/game-store.ts:466`、`src/ui/stores/game-store.ts:481`、`src/ui/stores/game-store.ts:489`、`src/ui/stores/game-store.ts:512`、`src/ui/stores/game-store.ts:520`、`src/ui/stores/asset-store.ts:89`、`src/ui/stores/asset-store.ts:341`、`src/ui/stores/asset-store.ts:347`、`src/ui/stores/audio-store.ts:137`、`src/ui/stores/audio-store.ts:143`、`src/sillytavern/asset-import-plan.ts:207`、`src/ui/lib/asset-zip.ts:258`、`src/sillytavern/asset-types.ts:109`、`src/ui/lib/asset-zip.ts:293`
- **工作量**：M　**风险**：中
- **来源**：STORE-08, XCUT-07, XCUT-11, STORE-09

**证据**

store 层没有共享工具层，四类工具因此各自复制。

**（一）切断 Vue Proxy 的 detach，8 份。** 同一条不变式在八处各写各的名字：`worldbook-store.ts:22` 是 `/** 落库前统一盖 updatedAt 戳 + 深拷贝（切断 Vue Proxy，否则 structured clone 抛错） */ function toRow(book)`；`beautifier-store.ts:30` 也叫 `toRow`，但语义是深拷贝 + 删 `locked`；`workshop-store.ts:136` 叫 `detach<T>(value: T): T`，注释「切断 Vue Proxy —— 否则 structured clone 抛 DataCloneError」；`settings-store.ts:90` 内联在 `serializeSettingsForLocalStorage` 里；`game-store.ts:466/489/520` 三处裸写 `const clean = JSON.parse(JSON.stringify(current));`；`worldbook-migration.ts:87` 的 `toRows` 第三次重复同一段注释。全仓 `JSON.parse(JSON.stringify(` 出现 30+ 次。这条约束由 Dexie 的 structured clone 强制，类型系统完全看不见——`db.worldBooks.put(reactiveBook)` 类型完全合法，只在运行时炸 `DataCloneError`。

**（二）配额判据与 notify，各 2 份。** `isQuotaError` 与 `notify` 在 `asset-store.ts:341-353` 与 `audio-store.ts:137-149` 逐字相同，asset-store 的注释直接写：「这四行刻意在本地重写而不是从 audio-store 导出：那边没导出它，而本任务的范围栅栏禁止改 audio-store。两处判据必须一致，**改一处记得改另一处**」。同时 `asset-store.ts:89` `import type { AudioBatchResult } from './audio-store'`——素材域的批量回执类型定义在音频 store 里，两个平级 store 之间产生了类型依赖方向。

**（三）素材路径工具，引擎与 UI 各一份。** `asset-import-plan.ts:207-219` 与 `asset-zip.ts:258-268` 逐字符相同，连注释都一样（唯一差别是引擎侧多个 `?? ''` 兜底）：

```ts
/** 斜杠归一化: 部分 Windows 工具会写反斜杠分隔符 */
function normalizeSlashes(path: string) {
  /* ... */
}

/** 取 basename（拍平嵌套目录）；纯路径返回空串 */
function basenameOf(path: string) {
  const norm = normalizeSlashes(path);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}
```

扩展名归一化是第三份：`asset-types.ts:109` 的私有 `normalizeExtension` 对 `asset-zip.ts:293` 的 `normalizedExtensionOf`（都是 trim + 小写 + 去点）。`asset-zip.ts:277-284` 的注释亲口记录这份重复已经咬过一次：`"苏婉_头像.png "` 的字面扩展名是 `"png "`，直接查表查不着，整条被当噪音丢掉——「引擎的 `isAssetExtension` 内部本来就 trim，本模块曾经比它更严，**那是漂移**」。

**（四）game-store 三个 metadata 写函数纪律不一。** `setEnabledWorldBookEntries(:463)`、`markOpeningPromptConsumed(:481)`、`releaseOpeningPromptClaim(:512)` 骨架相同（取 `activeSave` → 深拷贝 → 覆盖 `clean.metadata` 一个键 → `clean.updatedAt = Date.now()` → `await saveSaveSlot(clean)` → 同步 `saves.value[idx]` → catch 打 log 返 false），但后两个**在 await 之前**写内存（:493 注释「阻止共享 Store 的第二条管线重复启动」）并在失败时用 `saves.value[idx]?.updatedAt === clean.updatedAt` 守卫回滚，第一个则是 await 成功后才写内存、失败不回滚。

**影响**

「忘了 detach 就是运行时 `DataCloneError`」是新增写路径时最容易踩的坑，而它今天只靠每个 store 自己记得；两个同名 `toRow` 语义还不同（一个盖时间戳、一个删字段），复制粘贴时很容易搬错那份。配额判据一旦要加新的浏览器错误名（Safari 的 `QUOTA_EXCEEDED_ERR`），漏掉一处的表现是「素材导入把配额撑满却报成普通失败」。素材导入是把用户真实文件名映射成库内主键的地方，路径解析口径分叉的表现是「导入了但库里查不到」，排查成本很高。metadata 那条路径是 ADR-21 明文的受控例外（P1-09），要求「必须走统一写入函数 + try/catch」——现在有三个各写各的统一写入函数，其中两个有并发保护一个没有，下一个 UI 辅助字段抄到哪份全看运气。

**重构建议**

四个独立的小 PR，互不阻塞。

1. **`src/ui/stores/db-write.ts`**：唯一实现 `export function detach<T>(value: T): T` 与 `export function stamped<T extends { updatedAt?: number }>(row: T): T`。八处私有 helper 全删改 import：`worldbook-store.toRow` → `stamped(detach(book))`，`beautifier-store.toRow` → `omit(detach(rule), 'locked')`。**两条实现约束**：（a）`detach` 内部**保持 JSON 往返**，不要换成 `toRaw` + `structuredClone`——`toRaw` 只解顶层代理，嵌套 reactive 子对象会存活并让 `structuredClone` 照样抛 `DataCloneError`，而且它会改变落库形状（Date 存成 Date 对象而非 ISO 串、undefined 键被保留），那是存储迁移不是重构；（b）两个 `toRow` 是**刻意不同**的（盖戳 vs 剥字段），不要收敛成同一个名字，就用上面的 `stamped(detach(x))` / `omit(detach(x), 'locked')` 分解。若要把约束从「记得调」升级成「编译器拦」，可加品牌类型，但写法必须是 `declare const brand: unique symbol` + `type DbRow<T> = T & { readonly [brand]: true }`——`T & { readonly __detached: unique symbol }` 不是合法 TypeScript（`unique symbol` 只允许出现在 const / readonly static 声明上）。
2. **`src/ui/stores/store-utils.ts`**：搬 `isQuotaError` 与 `notify`（务必保留 `notify` 在无 Pinia 上下文时静默的语义，若干 store 测试依赖「没有 toast 目标时 mutation 照样成功」），两个 store 删本地副本改 import。`AudioBatchResult` 更名 `BatchMutationResult` 移到共享的 `store-result.ts`，取消 asset→audio 的方向依赖（该依赖是 `import type`、运行时零成本，动它的理由是重构卫生而非耦合代价）。
3. **`src/sillytavern/asset-path.ts`**：导出 `normalizeSlashes` / `basenameOf` / `extensionOf`（保留原样大小写）/ `normalizedExtensionOf`，配 `asset-path.test.ts`，用例直接照抄注释里那两个真机案例（反斜杠路径、`"...png "` 带尾空格）。`asset-import-plan.ts` 与 `asset-zip.ts` 的私有 helper 删掉改 import。**注意**：两份 `extensionOf` 并不等价（引擎侧小写、zip 侧刻意不小写，把归一化推迟给 `normalizedExtensionOf`），不能合成一个函数——导出「保留原样」与「已归一化」两个，引擎侧原本的即时小写行为改由调用点显式用 `normalizedExtensionOf` 表达，否则抽取本身就会引入它要消灭的漂移。`asset-types.ts` 的私有 `normalizeExtension` 改为 re-export 同一实现。规则写死：素材命名不变式 `<name>[_<type>][_<variant>].<ext>` 只允许有一个解析实现。`asset-zip.ts` 已经从 `@engine/asset-types` import，新建引擎侧文件不产生新的依赖方向。
4. **game-store**：抽私有 `async function patchSaveMetadata(patch: Partial<SaveSlot['metadata']>, opts: { optimistic: boolean }): Promise<boolean>`，把深拷贝/时间戳/落库/内存同步/回滚收进去。三个公开函数各缩成一行调用 + 各自的前置条件判断。**`optimistic` 必须在每个调用点显式给值，不要默认 true**——给 `setEnabledWorldBookEntries` 加上乐观写是行为变更而非等价重构：该路径没有重入风险，乐观写只会让面板短暂显示一个尚未落库的启用轴。

<a id="q-21"></a>

### Q-21 战斗/制作结算层的四处复制：集群攻击次数与 AoE 两份逐字实现（注释自陈分叉）、17 参数的 runDamagePipeline 调用两份、15 字段的 CraftActionRequest 装配两份且各自掷骰、craft-resolver 把世界书文本面板焊在结算数学上

- **严重度**：中
- **主题**：真源分裂：同一份事实被抄成 2-6 份，每份都是一条静默漂移线
- **位置**：`src/sillytavern/combat-damage.ts:473`、`src/sillytavern/cluster-system.ts:97`、`src/sillytavern/cluster-system.ts:113`、`src/sillytavern/cluster-system.ts:157`、`src/sillytavern/combat-v3/phases/attack.ts:209`、`src/sillytavern/combat-v3/phases/attack.ts:522`、`src/sillytavern/agent-tools.ts:655`、`src/sillytavern/agent-tools.ts:718`、`src/sillytavern/craft-resolver.ts:80`、`src/sillytavern/craft-resolver.ts:410`、`src/sillytavern/craft-resolver.ts:487`、`src/sillytavern/craft-resolver.ts:596`
- **工作量**：M　**风险**：低
- **来源**：CMBT-05, CMBT-09, CMBT-08, CMBT-10

**证据**

**其一，集群规则两份。** `combat-damage.ts:472-477`：

```ts
export function getClusterAttackCount(currentHp, maxHp) {
  const hpPercent = maxHp > 0 ? currentHp / maxHp : 0;
  if (hpPercent >= 0.8) return 3;
  if (hpPercent >= 0.5) return 2;
  return 1;
}
```

`cluster-system.ts:107-110` 是同名函数委托给 :97-101 的同一条 0.8/0.5 阈值梯，其 :105 的注释自陈「(与 combat-damage.ts 的 getClusterAttackCount 等效，集群模块提供权威版本)」。`calcAoEClusterDamage` 是逐字复制：`combat-damage.ts:483-489` 与 `cluster-system.ts:157-163` 同为 `singleTargetDamage * Math.min(aoeRange, clusterCount)`。`cluster-system.ts:113-117` 还把同一条梯子发布成第三份表示 `CLUSTER_ATTACK_COUNT_THRESHOLDS`，其第三行标为「HP < 50% → 1次」，而同文件 :95 的函数注释写「HP < 30% → 1次」——漂移已经开始。两份都在编码同一条世界书规则（#837805 §6）。

**其二，17 参数的伤害管线调用两份。** `attack.ts:208-210` 先算 `const coeff = getCombatCoefficient(attacker.tier); const initialDamage = ability.relevantAttribute * 10 * coeff + ability.skillPower + attacker.weaponAtk;`，再在 213-232 展开 17 字段的 `runDamagePipeline({...})`。`attack.ts:523-543` 用 `recompute.*` 替换 `ability.*` 逐字重复一遍：同样的 `getCombatCoefficient`、同样的公式、同样 17 个键同样顺序。两份已在两个字段上分叉：`damageType` 是 `ability.damageType` 对 `attacker.ability?.damageType ?? '物理'`，`fixedDamageBonus` 是 `0` 对 `recompute.fixedDamageAdjust`，且无注释说明是否有意。架构上格挡必须「重算管线」而非折扣终值（:500-503 的注释写得很明确），这条规则如今靠两个调用点手工保持一致。`DamageRecomputeCtx` 本是为携带冻结输入而存在，却只携带了一部分，第二处只好回头去读 `attacker`/`defender`。

**其三，15 字段的 `CraftActionRequest` 装配两份且各自掷骰。** `agent-tools.ts:654-673`（`craft_check`）与 :717-734（`craft_settle`）逐字段构建同一对象，连中文注释「CraftActionRequest 沿用历史字段名，但 StatePatch 的逻辑键必须是角色名。」与「🆕 制造反向链路 S2+S4（2026-08-01）…」都一样，`materials` 映射（`itemId: \`mat_${i}\``、`dcModifier: 0`）、六个 `??` 兜底（'锻造'/'成品'/'未命名制品'/'普通'/1/'未知材料'）、`...collectCraftBonuses(character)`展开全部重复。两处都写`d20Rolls: []`，由 `craft-dc.ts:75`的`rollCraftDice`在结算时补——于是`craft_check`展示给 AI 的 DC/评级与`craft_settle` 真正落库的结果来自不同的骰。而 AI 被提示先 check 再 settle，这是常规路径不是边缘情况。

**其四，`craft-resolver.ts` 把文本面板焊在结算数学上。** 696 行覆盖三件不相干的事：确定性三阶段结算（`resolvePreparation` :80、`resolveCheck` :140、`resolveSettlement` :188、`resolveCraft` :305）、AI 面向的门面（`interface CraftAPI` :410、`const $craft` :422）、以及展示层（`buildCraftPanelLines` :487-593，110 行输出 SillyTavern `<action_info>` 竖线表文本，如 `lines.push('{生产准备}')` / `| 掷骰: ${advStr} |`，加 `buildCraftDescription` :596）。战斗 v3 已经做过同一刀——`projection-agent.ts`/`projection-ui.ts` 在内核之外把 `DomainEvent[]` 转成文本与 UI 事件，`index.ts:8-11` 明写投影是「内部但分离」的。制作从未做这一刀，于是规则改动与措辞改动落在同一个文件。

> 复核修正：三点。① 集群那两份**都没有生产调用者**——在两个定义文件与测试之外 grep `getClusterAttackCount`/`calcAoEClusterDamage` 无命中，属重复的死代码，所以「调错文件」的场景在 v3 长出集群路径之前咬不到人。这也反转了重构方向：把死代码搬进 v3 真正 import 的 `combat-damage.ts` 反而更糟。② `attack.ts` 的 `damageType` 分叉很可能是 live bug 而非单纯坏味：常规路径用技能声明的伤害类型，格挡重算路径回落到攻击者默认档，格挡一个伤害类型异于攻击者基础档的技能会改变抗性/减伤处理。③ CMBT-10 的两条论据不成立：`buildCraftPanelLines`/`buildCraftDescription` 是模块私有（非 export），搬出去意味着新增导出而非「纯搬移」；且 `craft-resolver.test.ts` 并不构造 `CraftPrepResult`/`CraftCheckResult`/`CraftSettleResult` 来测格式化，而是经 `resolveCraft` 断言 `result.panelLines`/`result.description`（测试 222-223、229-230、266、283-284），拆分不会降低这份 setup 成本。剩下的是纯可读性论据。

**影响**

阈值梯是注定要调的平衡数值，调一份就静默分叉，而自称「权威版本」的那份恰恰是生产不用的那份。伤害管线的两个调用点已在 17 个字段中的 2 个上无声分叉，其中 `damageType` 那一处在改变格挡后的抗性处理。制作侧的重复更贵：AI 看到的 DC 与实际落库的结果来自不同骰值，AI 在为一个从未发生的结果做推理——叠加 Q-01 的骰源缺口，生产环境每次制作检定其实都是 d20=10，大失败与精益求精不可达。ADR-28 已经说明文本面板是给无 Code 层 AI 的遗留手段，是最该切开的一刀，却和结算数学焊在一起。

**重构建议**

四刀彼此独立，可分四个 PR：

1. **集群**：不要向 `combat-damage.ts` 合并。先只改一行——修正 `cluster-system.ts:113-117` 第三行的错误标注（50% vs 30%）；随后删掉两处死实现中的一处（保留 `cluster-system.ts` 那份，因为 v3 尚无集群路径），并把 `getClusterAttackCountByRatio` 改写成对 `CLUSTER_ATTACK_COUNT_THRESHOLDS` 的 fold，使表与函数不可能再分歧。等 v3 真正长出集群路径时再决定它落在哪个模块。
2. **伤害管线**：在 `combat-damage.ts` 中（紧邻 :188 的 `DamagePipelineInput`，该模块本就拥有这条公式）新增 `export function buildDamageInput(attacker: CombatUnitState, defender: CombatUnitState, spec: { relevantAttribute; skillPower; multiHitCount; damageType; ratingCoefficient; intentionCoefficient; fixedDamageBonus }): DamagePipelineInput`，把 `coeff`/`initialDamage` 一并折进去作为返回的 `preReduction`。`attack.ts` 两处改为 `runDamagePipeline(buildDamageInput(attacker, defender, spec))`，两处剩余差异变成 `spec` 的显式字段。**在同一 PR 内对 `damageType` 分叉作出裁决并补一条格挡回归测试**，不要留作「强制作出决定」。
3. **制作请求**：在 `craft-resolver.ts` 增加 `export function buildCraftRequest(character: CharacterState, args: CraftToolArgs): CraftActionRequest`（紧邻既有但未被工具使用的 `createCraftRequest` :652），`craft_check` 与 `craft_settle` 均调用它——兜底默认值、「名字即逻辑键」铁律、bonus 收集从此只有一处。再把骰子显式化：`buildCraftRequest` 接收 `d20Rolls`，`craft_check` 返回它用过的骰带，`craft_settle` 接收同一条带，对齐 combat-v3「骰子是显式输入而非环境副作用」的做法。该改动变更 AI 可见的工具返回 schema，按 AGENTS.md 必须同步 `agent-config.json` 与 `reference/agent流程测试/agent预期分析.md`。注意 `createCraftRequest`（:678-680）内部用 `Math.random` 掷骰，与 combat-v3 铁律 1 的确定性约定相悖，本次一并处理。
4. **制作投影**：新建 `src/sillytavern/craft-projection.ts`，`buildCraftPanelLines` 与 `buildCraftDescription` 改为导出后移入，签名 `(request, prep, check, settle)`（它们本就是这四个值的纯函数），`resolveCraft`（:375）改为调用。`craft-resolver.ts` 余下约 460 行做结算 + 门面。新建 `craft-projection.test.ts` 承接格式化断言（按同级测试约定），但不要指望这能减少 `resolveCraft` 的构造成本。

<a id="q-26"></a>

### Q-26 database.ts 里 16 个 Dexie 版本各自全量重述整份 schema，约 390 行是同一张表清单的拷贝

- **严重度**：中
- **主题**：真源分裂：同一份事实被抄成 2-6 份，每份都是一条静默漂移线
- **位置**：`src/sillytavern/database.ts:105`、`src/sillytavern/database.ts:337`、`src/sillytavern/database.ts:358`、`src/sillytavern/database.ts:371`、`src/sillytavern/database.ts:439`、`src/sillytavern/database.ts:466`
- **工作量**：M　**风险**：中
- **来源**：CORE-07

**证据**

105-490 行共 16 个 `this.version(n).stores({...})`，v13 起每版都把 19-23 张表原样再抄一遍。`lorebooks: 'id, name, updatedAt'` 这一行在文件里出现 16 次，`messages: 'id, saveId, [saveId+turn]'` 出现 9 次。

文件自己已经承认这是纯约定而非必要：v13 的注释（:358-364）写「照本文件惯例重述全部 17 张旧表 —— 这是**约定**，不是 Dexie 的硬要求：Dexie 4 的 `Version.stores()` 跨版本**累加** schema …… 漏写的表会从上一版继承下来」，并明确指出「上方 v12 注释说『漏写即删表』—— 那句对 Dexie 4 不成立」。也就是说 v12 的注释（:337）至今仍在给出被证伪的指导，而这条重述约定正是那句错误注释的产物。

**影响**

每加一张表要在最后一版抄 23 行、并保证与前一版逐字符一致；抄错一个索引名不会报错，只会在真机上变成一次静默的索引重建或查询失效。这 390 行噪音还淹没了这个文件里真正重要的东西：v9 的 `chats: null`（真正的删表）、以及 v14/v15/v16 的三态导入语义。

**重构建议**

保守改，只动 v13 以后：

1. 引入 `const SCHEMA_V16: Record<string, string>` 与一个纯函数 `withSchema(base, delta)`（`delta` 里 `null` 表示删表），把 v13-v16 写成 `this.version(16).stores(withSchema(SCHEMA_V15, { regexStorage: 'key' }))`。此后新增版本一律走 `withSchema`，一版一行 delta。
2. v1-v12 已经出厂、任何改动都有风险，原样冻结不动，只在其上方补一条注释指向新写法，并删掉 v12 那句被证伪的「漏写即删表」（它现在是反向指导）。
3. 两条硬约束：`withSchema` 生成的 schema 字符串必须与改前**逐字节相同**——Dexie 会比对已存储的 schema，任何差异都会在用户既有库上触发真正的索引重建；v9 的 `chats: null` 删表语义必须在 delta 编码下存活（`null` 约定覆盖了它，但要对着 v9 单独验一次）。database.test.ts 里由 v13 注释引用的升级回归测试必须保持全绿。

<a id="q-30"></a>

### Q-30 start-catalog.ts：8752 行从 CDN 抓来的数据硬编成 TS 模块塞在引擎目录，并顺手第二次定义了 Rarity 与品质映射

- **严重度**：中
- **主题**：真源分裂：同一份事实被抄成 2-6 份，每份都是一条静默漂移线
- **位置**：`src/sillytavern/start-catalog.ts:5`、`src/sillytavern/start-catalog.ts:91`、`src/sillytavern/start-catalog.ts:5470`、`src/sillytavern/start-catalog.ts:8039`、`src/sillytavern/start-catalog.ts:8733`、`src/sillytavern/start-catalog.ts:8744`、`src/sillytavern/field-enums.ts:30`、`src/sillytavern/field-enums.ts:92`、`src/sillytavern/types.ts:2249`
- **工作量**：L　**风险**：中
- **来源**：CORE-05

**证据**

文件头写着「捏人页数据目录 — 从 CDN 自动生成」，328 KB。其中 `DEFAULT_EQUIPMENT_POOL`(:91) → `DEFAULT_ITEM_POOL`(:5470) → `DEFAULT_BACKGROUNDS`(:8039) 约 8600 行是纯数据字面量，只有末尾约 50 行是映射常量。消费方全部在 UI 捏人页（CreateStep\*/SelectableCard/SelectedPanel/CustomItemForm/create-store），`src/sillytavern/` 下零引用——它放错了目录。

三处与 field-enums.ts（「枚举中文集中定义」这条铁律的指定单点）撞车：

- start-catalog.ts:5 `export type Rarity = 'common' | 'uncommon' | … | 'only'` vs field-enums.ts:30 `export type Rarity = (typeof RARITY_LEVELS)[number]`（`'普通' | '优良' | …`）——同名类型两套取值域，谁 import 到哪个全看路径。
- start-catalog.ts:8744 `RARITY_TO_QUALITY: Record<string, string> = { common: '普通', uncommon: '优良', … only: '唯一' }` 与 field-enums.ts:92 的 `RARITY_ALIASES` 是同一张表；后者多一个 `unique: '唯一'` 且经 `normalizeRarity` 做 lowercase 兜底，前者是裸下标查表。四个 .vue（SelectableCard/SelectedPanel/CustomItemForm/CreateStepConfirm）直接下标 `RARITY_TO_QUALITY[item.rarity]`，绕开归一化入口。
- start-catalog.ts:8733 `QUALITY_BASE_DC` 与 types.ts:2249 `CRAFT_DC_BASE` 是同一个概念的两份定义（前者生产零引用）。

> 复核修正：两处措辞需要收紧。(a) `QUALITY_BASE_DC` 不是 `CRAFT_DC_BASE` 的拷贝——取值已经不同（稀有 14 vs 16、史诗 18 vs 22、传说 24 vs 30、神话 32 vs 40、唯一 40 vs 0）；它是同一概念的过期分叉，这更支持「删掉」的结论，但削弱「两份拷贝」的说法。(b) `RARITY_TO_QUALITY` 与 `RARITY_ALIASES` 目前不会真的映射错：catalog 数据里的 rarity 全部是那 7 个小写码，所以四个 .vue 的下标查表现在不会失败，风险是前瞻性的。另外 `RARITY_ALIASES` 是模块私有常量、并未导出，重构必须让 .vue 走已导出的 `normalizeRarity()`，不能直接引别名表。

**影响**

改一次品质体系要同时改 field-enums、start-catalog、types.ts 三处，漏一处就是「捏人页显示对、结算算错」这类最难查的偏差。328 KB 数据编进 TS 还意味着每次 `tsc` 都要类型检查 8600 行字面量；而这批本来就「从 CDN 自动生成」的数据，无法在不改代码、不重新构建的前提下更新。

**重构建议**

按下列顺序拆，前三步各自可独立合入：

1. 删重复定义（先做，收益最大风险最小）：删掉 start-catalog 的 `Rarity` 类型与 `RARITY_TO_QUALITY`；四个 .vue 改调 field-enums 导出的 `normalizeRarity()`；`CatalogItem.rarity` 的英文取值保留为一个不与 `Rarity` 撞名的新类型 `CatalogRarityCode`。
2. 删 `QUALITY_BASE_DC`（生产零引用且已与 `CRAFT_DC_BASE` 分叉），制作 DC 只留 types.ts 的 `CRAFT_DC_BASE`。
3. 模块整体从 `src/sillytavern/` 移到 `src/ui/lib/`——它是捏人页数据，不是引擎。
4. 数据出 TS：把三个池 + `DEFAULT_BACKGROUNDS` + `START_LOCATIONS` 导成 `data/defaults/start-catalog.json`，start-catalog.ts 缩成一个 loader（`loadStartCatalog(): Promise<StartCatalog>`），照 beautifier 内置预设「派生缓存、纯内存持有、不落库」的既有先例办。这一步涉及加载时机与离线可用性的取舍（外置成资产 vs 保留为模块），应先拍板再动手。

<a id="q-31"></a>

### Q-31 location-db 的邻接关系有两套语义：buildAdjacency 双向对称化，而同一命名空间下的 areAdjacent/getEdge 只看单向

- **严重度**：低
- **主题**：真源分裂：同一份事实被抄成 2-6 份，每份都是一条静默漂移线
- **位置**：`src/sillytavern/location-db.ts:773`、`src/sillytavern/location-db.ts:864`、`src/sillytavern/location-db.ts:870`、`src/sillytavern/location-db.ts:878`
- **工作量**：S　**风险**：低
- **来源**：CORE-11

**证据**

`buildAdjacency`(773) 显式补反向边：

```ts
const revList = adj.get(edge.targetId);
if (revList && !revList.some((e) => e.targetId === node.id))
  revList.push({
    targetId: node.id,
    fromDirection: edge.toDirection,
    toDirection: edge.fromDirection,
  });
```

但 `areAdjacent`(864) 是 `const nodeA = getLocationNode(nodes, a); return nodeA.neighbors.some(e => e.targetId === b);`，`getEdge`(870) 同理只查 `nodeFrom.neighbors`，两者都不看反向。于是同一对节点可能出现 `areAdjacent(A, B) === true` 而 `areAdjacent(B, A) === false`，同时 `buildAdjacency` 认为两边都通。三个函数都从 `$location` 命名空间（878）一起对外暴露。

> 复核修正：原始发现的两处措辞偏重。（1）「边只声明在一侧是常态」经实测不成立——`DEFAULT_LOCATIONS` 全表只有 1 对是非对称的，被点名的那些 `neighbors: []` 的 region/city 节点是**未连通**，不是半连通。（2）`$location` 虽然语法上导出了这三个函数，但 grep 显示它在 `location-db.ts` 及其测试之外没有任何 importer，`areAdjacent`/`getEdge`/`buildAdjacency` 也都是生产零调用方——所以「NPC 走过去就回不来了」这个叙事失效今天不可能发生。低严重度是准确的，甚至偏宽松。

**影响**

两个函数挂在同一个命名空间下一起对外暴露，调用方无从知道该信哪个。一旦这条线接进生产，「A 能到 B 但 B 回不来」这类拓扑事实错误会以「NPC 走过去就回不来了」的形态出现在叙事里，排查时几乎不会怀疑到查询函数身上。当前影响面窄，适合搭车修。

**重构建议**

必须让三个函数共用同一个邻接真源，二选一：

- **方案 A（推荐，代价最小）：** 修掉 `DEFAULT_LOCATIONS` 里那唯一一行非对称数据，并给 `buildAdjacency` 加一条「输入已对称」的断言。
- **方案 B：** 把 `buildAdjacency` 的结果在模块内 memo 成 `const DEFAULT_ADJACENCY = buildAdjacency(DEFAULT_LOCATIONS)`（数据是静态常量，算一次即可），`areAdjacent` / `getEdge` / `getNeighbors` 三个都改成先查邻接表、查不到再回落 `node.neighbors`。

无论选哪个，都补一条测试断言 `areAdjacent(a, b) === areAdjacent(b, a)` 对全表成立——这条测试是两个方案共同的回归闸门。
