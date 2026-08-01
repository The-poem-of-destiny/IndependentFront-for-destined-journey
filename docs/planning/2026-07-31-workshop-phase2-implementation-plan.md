# 工坊 Phase 2 实施计划（lean-delegation 版）

> 设计真源：`docs/planning/2026-07-31-workshop-phase2-ejs-design.md`（v1.2 拷问定稿）· ADR-30（AGENTS.md）· 词汇 `CONTEXT.md`
> 执行模式：主会话只做计划/派单/验收；**全部实现由 Opus（medium effort）子 Agent 完成**，子 Agent 不得再派子 Agent。每单报告 ≤15 行（改了哪些文件一行一个 + 验证命令与结果 + 阻塞点），**不回贴代码/diff/文件内容**。
> 通用验收：`npm run typecheck` 0 错误；`npm run test -- --run` 全绿；新模块必须带 `*.test.ts`（仓库铁律）。

## 波次总览（依赖图）

```
波次1（并行×3）: T1 运行时重写   T2 stats 投影   T3 vars 差量
波次2:          T4 renderWorldBookEntries（分层+缓存+回退+全语料冒烟）   ← 依赖 T1/T2
波次3:          T5 装配接线（placeholder/fallback/types/game-pipeline 读侧）← 依赖 T1/T2/T4
波次4:          T6 提交接线（state-manager 仲裁顺序 + 护栏 UX）           ← 依赖 T3/T5
波次5:          T7 验收员（全量回归 + 文档同步核查）                      ← 依赖全部
```

---

## T1 — ejs-runtime 整片编译重写（纯函数域）

**目标**：重写 `src/sillytavern/ejs-runtime.ts` 执行层：一个条目的全部 token 编进**同一个函数体**（文本→`__out.push('…')`，`<%`/`<%_` 代码原样内联，`<%=`/`<%-`→`__out.push(String(expr))`，`undefined/null` 输出空串）。跨块 `if/for` 必须成立——这是重写的存在理由（设计 §1.4）。

**已知上下文**：现行文件 6.5KB，tokenizer（`<%_/<%=/<%-/%>/_%>` 识别）可保留；执行层逐块 `new Function` 是废的，全部推倒。返回形状改 `{ rendered, errors }` + 草稿由调用方持有。沙盒 = `new Function` 参数遮蔽（`globalThis/window/document/fetch/XMLHttpRequest/localStorage/indexedDB` 等传 `undefined`），对齐 `script-executor.ts:172` 的信任模型口径（失误防护，非安全边界）。

**注入面（设计 D4/D5 别名表为准）**：

- 两轴：`stats`（调用方传入的只读快照对象）、`vars`（调用方传入的可变草稿对象）
- 别名：`getMessageVar(path, opts?)`（剥 `stat_data.` 前缀；三种读形：叶子链 `stats??vars` / 子树（stats 骨架无此前缀→返回 vars 活引用；有→stats 克隆子树）/ 整树浅合并）、`setMessageVar`（写 vars）、`getvar/setvar`（带前缀同上，扁平键不剥前缀同链；opts 只支持 `defaults`，`scope/noCache` 忽略）、`getLocalVar/setLocalVar`（`vars._local.*`）、`variables`（`{ stat_data: 整树读视图 }`）、`matchChatMessages(pattern)`（对传入 history 文本做子串/正则命中）
- `_` shim：**另立文件** `src/sillytavern/ejs-lodash-shim.ts`，纯读边 17 方法（get/trim/isArray/isObject/isEmpty/isObjectLike/mapValues/find/flatMap/pick/pickBy/values/keys/has/uniq/keyBy/chain）；`_.chain` 若成本高可省（中招条目走回退），省了要在报告里说
- 原生直传：`Math/JSON/String/Number/Boolean/RegExp/Array/Object`
- 路径写入剔除 `__proto__/prototype/constructor` 段（参照 var-resolver 的 `DANGEROUS_PATH_SEGMENTS`）

**错误隔离（D8）**：`compile(content)` 与 `execute(...)` 分段 try/catch；执行失败时**该条目对 vars 草稿的写入整体回滚**（执行前浅/深快照，失败恢复），错误信息截断进 `errors`。不支持 `await`（同步编译，中招自然落错误分支）。

**范围栅栏**：不碰 worldbook-loader / placeholder-registry / 任何接线；不实现分层与缓存（T4 的事）。旧测试文件按新 API 重写。

**验证**：`npm run test -- --run ejs-runtime` + typecheck。测试须覆盖：跨块 if/for、trim 语义、三种读形、别名全表、失败回滚、污染段剔除。

## T2 — stat-projection（纯函数域）

**目标**：新建 `src/sillytavern/stat-projection.ts`：`buildStatData({ characters, gameTime?, fp? })` → 深拷贝孤儿快照。范围**严格**按设计 D4 表：`主角.生命值/生命值上限/法力值/法力值上限/体力值/体力值上限/等级/生命层级/累计经验值/升级所需经验/属性.力量|敏捷|体质|智力|精神/属性.属性点`（玩家 = `characters.find(c => c.type==='player')`，无玩家返回 `{}` 底座仍含时间/命运点数）、`命运点数`（fp）、`世界.时间`（`formatGameTime(gameTime)`，函数在 `time-system.ts`）。**不含**背包/技能/装备/状态效果/任务/关系（设计 §5 挂起项，别自作主张加）。

**范围栅栏**：只建这一个模块 + 测试；不接线。

**验证**：`npm run test -- --run stat-projection` + typecheck。覆盖：完整映射、无玩家、无 gameTime、深拷贝隔离（改返回值不脏入参）。

## T3 — ejs-vars-diff（纯函数域）

**目标**：新建 `src/sillytavern/ejs-vars-diff.ts`：`diffVars(base, draft)` 深比较 → `{ sets: Array<{path, value}>, dels: string[] }`（路径为 `sys.` 命名空间下点路径，形状与现有 VarsPatch 应用入口兼容——先读 `vars-merger.ts`/`applyVarsPatch` 确认 op 形状再定返回类型）；`measureDiff(diff)` 序列化体积；`DIFF_SIZE_LIMIT = 256 * 1024`。diff 遍历只走自有可枚举键，**跳过** `__proto__/prototype/constructor`。数组按值整体替换（不做数组内细粒度 diff——语料写数组都是整根赋值）。

**范围栅栏**：纯函数 + 测试；不碰 state-manager。

**验证**：`npm run test -- --run ejs-vars-diff` + typecheck。覆盖：新增/修改/删除/嵌套/数组整体替换/危险键跳过/体积测量。

## T4 — renderWorldBookEntries：分层 + 缓存 + 回退 + 全语料冒烟

**目标**：`src/sillytavern/worldbook-loader.ts` 新增（`formatWorldBookEntries` 保持不动）：

- `hasDynamic(content)` ≡ `/<%|\{\{random|\{\{getvar/.test(content)`
- `renderWorldBookEntries(entries, ejsCtx)` → `{ staticText, dynamicText, fallbackCount }`：静态区按 order 拼接；动态区按 order 逐条 compile（**session 级缓存** `Map<content, CompiledFn>`）+ execute（共享 ejsCtx 的 stats/vars/history），失败条目**原文注入**并计数；两区内部各自保序
  **已知上下文**：T1 的运行时 API；ejsCtx 形状 `{ stats, vars, history }`。条目类型 `WorldBookEntry`（content/order/uid 字段）。
  **全语料冒烟测试**（本单核心交付）：测试里加载 `data/worldbooks/*.json` 全部条目 + `buildStatData` fixture + 空 vars 草稿 → `renderWorldBookEntries` 全跑：不抛、断言回退率 ≤5%、断言静态区不含 `<%`。golden 用例：从 event.json 抽斯芬克斯支线（信号守卫初始化→写→读回）与冰之歌（触发时间写 vars）两个真实条目，fixture 断言渲染结果与 vars 写入。**测试读磁盘 JSON 的方式参考现有测试对 data/ 的读法**（如无先例，用 Node `fs` 直读，报告里注明）。

**范围栅栏**：不碰 placeholder-registry / agent-templates / game-pipeline（T5）。

**验证**：`npm run test -- --run worldbook-loader` + typecheck。

## T5 — 装配接线（读侧）

**目标**：

1. `types.ts`：`AgentContext.statData?: Record<string, any>`；`AgentConfig.ejsVarsCommit?: boolean`
2. `placeholder-registry.ts` `LORE_BOOK` resolver：改调 `renderWorldBookEntries`；支持 `{{LORE_BOOK:section=static}}` / `section=dynamic`（无参 = static+dynamic 连拼）；**既有 `parseSetvars/resolveGetvars/resolveRandoms` 链保持原位不动**（对拼接结果继续跑，顺序：EJS 先、宏剥离后）
3. `agent-templates.ts` `buildFallbackMessages`：同步改调
4. `game-pipeline.ts`：组装 ctx 处调 `buildStatData`（fp 从 `this.game.saveProfile?.fp` 取）注入 `statData`；每个装配 pass 开始 `vars = deepClone(variables.sys)` 传入 ejsCtx；**持权 pass（config.ejsVarsCommit===true）的「回合开始克隆 + 最终草稿」暂存**供 T6 结算（本单只暂存，不提交）
5. `data/defaults/agent-config.json`：story 置 `"ejsVarsCommit": true`

**已知上下文**：LORE_BOOK resolver 现于 `placeholder-registry.ts:106` 附近（含 params?.limit 先例可仿）；story 规范预设会经 `resolveTemplateWithGlobals` 预解析预设内占位符（`agent-templates.ts:584` 附近），LORE_BOOK 只会被解析一次，无双跑问题。ejsCtx 的 history 用 ctx.history，matchChatMessages 窗口对齐该 Agent historyLayers。

**范围栅栏**：不碰 state-manager / commitChatState（T6）；不做 UI。现有测试若因签名变化破损，修到绿。

**验证**：`npm run test -- --run` 全量 + typecheck（接线单必须跑全量）。

## T6 — 提交接线（写侧）+ 护栏 UX

**目标**：

1. `state-manager.ts` `commitChatState`：payload 加可选 EJS 差量（来自 T5 暂存 → `diffVars`）；应用顺序**钉死**「持权 pass 差量（多持权者按管线阶段序、同阶段 agentId 字典序）→ vars_update AI 补丁」——同路径 AI 终值
2. 体积护栏：超限**整份拒绝** + `console.warn`；拒绝事件上抛给 game-pipeline
3. UX：走既有系统通知/toast 通道提示一次（**每存档每来源一次**，去重标记放 SaveProfile 的 UI 辅助字段或内存即可——先看 `ui-store`/`toSystemEvent.ts` 的系统事件先例，选阻力最小的既有通道）；拒绝计数+最近时间落一条可查的诊断（位置自选：快照面板或设置页关于/诊断区，报告里说明选了哪）
4. 测试：仲裁顺序（同路径 EJS+AI 双写→AI 终值）、多持权者顺序、护栏拒绝、快照回退后 sys 树含已提交 EJS 写

**已知上下文**：ADR-21 唯一写入口；P1-09 受控例外先例（UI 辅助字段走统一写入函数）。vars_update 补丁现有应用路径在 commitChatState 内——先找到它再插入 EJS 差量于其**前**。

**范围栅栏**：不动 vars_update Agent 的 prompt/解析；不做设置页新分区。

**验证**：`npm run test -- --run` 全量 + typecheck。

## T7 — 验收员（verifier）

**目标**：干净跑 `npm run typecheck` + `npm run test -- --run`（报告用例总数）；`git diff --stat master@{u}` 核对改动面没溢出计划清单；核对文档同步义务：AGENTS.md 进度表（工坊 P2 → ✅ 待真机）、AGENTS.md 架构图加新模块行、`docs/CHANGELOG.md` 追加「工坊 P2」条目、设计文档状态行改「已实施」。缺哪个报哪个，**不自己改**——主会话派补丁单。

**报告**：≤10 行。

---

## 派单纪律（主会话自用备忘）

- 每单附上设计文档对应小节原文引用（D 编号），不让子 Agent 自己找设计
- 波次 1 三单**一条消息并行发**；后续波次逐单
- 返工优先 SendMessage 原 Agent（上下文还热），不冷启新 Agent
- 主会话不读实现文件、不跑测试——一切以子 Agent 报告 + T7 验收员为准
- 真机走查（设计 §7 切片 6：回退率/cacheHitTokens 前后对比/冰之歌跨回合链）在 T7 全绿后由主人在真机做，不在本计划内
