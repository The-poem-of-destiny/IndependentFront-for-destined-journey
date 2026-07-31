# 战斗系统 · 修复/验证/真机压测 交接报告(2026-07-31)

> 本文件是跨会话交接文档。上一会话完成了三轮工作:全量 bug 排查修复 → 多 agent 对抗性验证 → DeepSeek 真机压测+审计+第三轮修复。**下一步工作:进一步压力测试**(见 §6 执行清单)。

## 1. 背景与当前状态

- 仓库: `D:\Games\IndependentFront-for-destined-journey`(克隆自 GitHub The-poem-of-destiny/IndependentFront-for-destined-journey,master @9967184)
- **所有改动未提交**(用户未要求 commit)。`git status`:约 20 个修改文件 + 2 个新文件(回归测试、压测脚本)
- 引擎测试基线: `npx vitest run src/sillytavern/` → **3480/3480 全绿**;全仓库 vitest 有 2-4 个 UI 层失败(SelectableCard 边框色、game-store/create-store 并发抖动),**与战斗无关,原代码即失败**,已用 git stash 对照验证过
- 依赖已 npm install;tsx 可用(node 22);控制台是 GBK,python 处理中文输出需 `io.TextIOWrapper(...encoding='utf-8')`

## 2. 三轮工作摘要

### 第一轮:排查+修复(~25 项,12 个源文件)

高危代表:意图对抗攻守同骰(同层级必败)、管线版非致死缺失(打晕会打死)、非致死 patch 与 finalHp 不一致(显示锁1落库死亡)、伪造优势第二骰(r1±3)、buff effects 无消费方(格挡/专注是空气)、buff 永不 tick、战意 d20 恒缺省(低阈值必崩溃)、玩家输入死锁、roll_d20 被 combat 工具通道拒绝、costs.hp 白嫖、守方闪避 mod 死代码。

### 第二轮:对抗性验证(12 agent workflow)+整改(~24 项)

10 维度怀疑者+回归测试员+完整性批评者,40 条发现全部裁决。高危确认并修:runner buff 同步 stacks 双计(根治:status-api patch 改携带**增量**,与 state-manager 累加语义对齐)、非致死"打尸体复活"、行动经济初始化阶段旁路、经济预扣改成功后扣、fled 敌人误发 EXP、inferOutcome 正则跨句借词/复合词裸字、get_*/status_query 委托名→id 映射+战中数据直读+白名单、combat_start 重开拒绝、专注/昏迷失能恢复、过期 buff 补偿性 remove patch、multiHitCount 负数消毒、骰值 clamp[1,20]、意图幽灵掷骰、'制服'关键词误报等。
回归测试: `src/sillytavern/combat-bugfix-regression.test.ts`(40+ 用例,含两轮全部修复行为)。

### 第三轮:DeepSeek 真机压测 + 11-agent 审计 + 修复

见 §4/§5。新修 4 项:意图骰引擎 clamp(resolveIntention 入口)、专注 rt=1→2+攻击后消耗(runner)、inferOutcome 按名主语绑定+deriveWinnerFromState 终局状态推导、combat_end winner 与状态矛盾软告警。另:combat systemPrompt 追加 7 条"战斗纪律"硬规则(data/defaults/agent-config.json,3819→4670 字)。

### 文档同步(CLAUDE.md 纪律)

- combat-system-architecture.md §6.3:collect_defender_mods 提前到检定前(2026-07-31 修正说明)
- combat-agent-api.md:combat_attack 新参数(relevantAttribute/d20Attack2/d20IntentionDefender)、19-event 表序、roll_d20 战意骰说明

## 3. 压测基础设施(下一步直接复用)

**脚本**: `scripts/combat-stress-test.ts`

```bash
DEEPSEEK_API_KEY=<key> npx tsx scripts/combat-stress-test.ts [并发数=3] [场景前缀过滤]
# 例: 只跑 S02:  ... combat-stress-test.ts 1 S02
```

- 全真链路 runCombat→executeCombatToolCall→19-event 管线,零 mock;唯一注入点是直连 DeepSeek 的 CombatClient(重试 4 次退避/150s 超时/预算护栏:单场 120 次 LLM 调用+12 分钟)
- **密钥只从环境变量读,不落盘。原对话中用户提供过 key(sk-7771…2740, api.deepseek.com),已建议轮换;继续压测需用户重新提供或确认。模型 `deepseek-v4-flash`(实测支持 function calling + thinking),另有 `deepseek-v4-pro` 可做对照组**
- 场景矩阵 10 个(S01-S10):6 战斗类型/1v1~2v3/跨层级优劣势/法系/受伤逃跑/活捉非致死;角色资源用引擎公式 calcResources(体质×100×层级乘数)——**不要手配 HP**(第一次冒烟就是手配 300 被一刀秒)
- 输出: `tmp/stress/<时间戳>/S*.json`(工具调用史/事件时间线/落库补丁/不变量)+ `_summary.json`;上轮数据在 `tmp/stress/2026-07-31T03-22-45-690Z/`

## 4. 上轮压测基线(对比用)

- 10/10 完成,0 崩溃/0 HTTP 错误/0 重试;时延 p50 5.7s / p90 10.6s / p99 17s;281 次调用,prompt 240 万 token(**缓存命中 94.6%**),completion 13.6 万;单场约 28 调用/2.5 分钟
- 胜负 4 ally/3 enemy/3 draw;不变量零违例(无 HP 越界/无反向加血)
- 护栏实战触发全部正确:经济拦截 5 次、寻址自纠 1 次、fled 不给 EXP、agent 代打降级无死锁
- **注意**: 上轮 3 个 draw 里 S01/S02 是 agent 漏调 combat_end + 摘要用角色名导致误判——这两个问题的修复(状态推导+按名绑定+prompt)是**压测后**打的,复跑时这两场应变为 ally_win

## 4b. 第四轮:修复验证复跑结果(2026-07-31,§6.1 已完成)

数据: `tmp/stress/2026-07-31T04-01-44-468Z/`(主轮 10 场)+ `tmp/stress/2026-07-31T04-17-49-060Z/`(S01 复跑)。模型 deepseek-v4-flash,并发 3。

- **胜负**: 5 ally / 4 enemy / 1 ERROR;S01 复跑后 ally_win → 全部 10 场有效结果 **0 draw**。**S01/S02 误判修复确认**(上轮 draw → 本轮均 ally_win,combat_end 10/10 全部调用)
- **叙事越权大幅下降**: 捏造战利品 9 场中仅 S04 确认(獠牙+胃石无 item 补丁)+ S02 疑似(摘要 400 字截断处),其余 7 场明确声明"无战利品",S05 甚至出现"战场遗落战斧,但未及搜检"的模范表述。上轮 7/10 → 本轮 ~1.5/9
- **专注 buff 闭环验证 ✅**(靠新加的 toolHistory.result): S01 复跑中罗兰基线 hitBonus=2,focus 后两次攻击 hitBonus=7(**+5 生效**),消耗后回落 2;补丁流 add → focus-consumed remove 全正确
- **摘要数字对账全对**: S02 卡恩 5383/6063、S03 艾拉 184/1053、S06 皮特 381-381=0 等与 delta_hp 累计逐位吻合
- **不变量零违例**(两轮 invariantViolations=[]),意图骰越界(21 类)消失;经济拦截 5+3 次、寻址自纠 1 次照常工作
- **性能**: 323+41 次调用,p50 5.0s / p90 8.9s / p99 13.2s,缓存命中 94.7%,0 次 429/HTTP 错误
- **发现并修复 harness 缺陷**: S01 首跑死于 `TypeError: terminated`(undici 网络中断)——callApi 的 catch 只重试 AbortError,网络层 TypeError 直接 rethrow 杀死整场。已修:TypeError 同样退避重试并记入 httpErrors(scripts/combat-stress-test.ts)
- **§6.2 观测盲区部分收口**(脚本侧): toolHistory 现在记录工具**返回值**(roll_d20 骰面 / combat_attack 结算含 checkValue/hitBonus,>4KB 截断)——"传参=骰面"与 buff 生效已可闭环审计。引擎事件(subscribeChain morale.*)仍未入日志
- 长战斗观察: S05 打满 8 回合 102 次调用 570s(接近但未触发 120 次预算),是 §6.3 长战斗压测的天然样本

## 4c. 第五轮:规模压测结果(2026-07-31,§6.2 收口 + §6.3 部分完成)

数据: `tmp/stress/2026-07-31T04-38-02-700Z/`。30 场(10 场景矩阵 ×3,`STRESS_REPEAT=3` 每份独立角色对象)× 并发 8,deepseek-v4-flash。

- **30/30 全部成功,0 崩溃**;18 ally / 11 enemy / 1 draw;998 次调用,987 万 prompt token,时延 p50 5.0s / p90 9.6s / p99 16.7s——并发 8 相比并发 3 时延几乎无劣化
- **网络重试修复实战验证 ✅**: 1 次 `network: terminated (read ECONNRESET)` 被捕获重试,战斗存活(上一轮同类错误直接杀死 S01)
- **并发 8 未触发 429**——DeepSeek 限流阈值高于本档并发,§6.3 的 429/重试路径需更高并发或更大规模才能实测
- **唯一 draw 是正确判定**: S05#1 打满 11 回合被 MAX_TURNS 强制收场,终局四单位全部存活(战意全 steady/无人逃跑),draw 合理;**MAX_TURNS 极限路径验证通过**(无挂死/不变量零违例/未生成 AI 摘要属预期)。最长场次 105 次调用,未触发 120 次预算护栏
- **§6.2 引擎事件日志已收口**(harness subscribeChain passthrough): combat.dice.roll(骰面/purpose/attackerId)+ morale.check/result 全部入 `engineEvents` 字段,规模压测下工作正常(S05#1 记录 34 掷骰+14 战意)
- 不变量零违例(30 场),经济拦截 20 次(与 10 场时 5 次成比例),寻址错误 0(比上轮更好)
- harness 新增: `STRESS_REPEAT` 环境变量(场景矩阵重复,每份独立 buildScenarios() 避免并发共享可变状态)

## 4d. 第六轮:定向场景压测(2026-07-31,§6.4 完成)+ 1 个引擎 bug 修复

数据: `tmp/stress/2026-07-31T05-08-30-007Z/`(S11-S16 六场)+ `05-02-12-794Z`(S15 冒烟)+ `05-28-59-229Z`(S12 修复复跑)。harness 新增 `STRESS_SET=directed` 场景集与 Scenario.playerScript/preRun 两个定向注入点。

**机制验证结果(6/6 全过,0 崩溃)**:

- **多段攻击 ✅**: multiHitCount=2/3 的分伤正确(518÷2=259、716÷3=238,floor)
- **登神压制 ✅**: harness subscribeChain 声明 divinity=3 modifier → penetrationRate=0.7(武器0.1+压制0.6)、守方防御 450→134、DR 0.25 被清零(drReduction=0)、固伤+60 进管线——§13c 全链活的
- **玩家输入通道 ✅**: registerSubmitter 提供后 awaiting_player_input 暂停/恢复全程正确(6 暂停 6 提交零死锁);「举盾观察不要冒进」被 AI 正确翻译为 combat_block(意图理解)
- **status_apply DoT 流 ✅(施加面)**: 上轮 0 次 → 本轮 8 次;同源刷新/流血过期 combat-buff-expired 补偿 remove 全正确
- **战意**: S11 打出完整 morale.check(hpRatio 0.067,routing,溃逃)→ morale.result 事件链(engineEvents 可审计)

**🐛 修复: clusterCount 全链断线**(集群机制真实链路死代码)——`characterToCombatParticipant` 不拷贝 clusterCount,而管线 Step 8(×1.5)与结算 EXP 衰减都从 participant 读 → 恒 undefined。只在手工构造 participant 的单测里活着(第五轮 S12 首跑实锤: 打集群 afterDr==finalDamage)。修复: types.ts CombatParticipant 增 `clusterCount?` + combat-resolver.ts 转换拷贝 + pipeline/settlement 去 cast。回归 +2 用例(拷贝+全链×1.5),全量 3482/3482 绿。S12 复跑真机确认: 集群受击 ×1.5✓(601→901 等三刀)、EXP 22→11(0.5 衰减生效)、单体不受影响✓

**🔍 发现(未修,待产品决策): DoT 无消费方**——引擎 buff effects 只认 7 个键(hit/dodge/defense/dr/penetration/damage/fixedDamage,collectBuffCombatMods),**没有任何周期伤害 tick 机制**;S11 中 AI 给 effects 自由发明了 6 种形状(dotPoison:90/poison:1/dot:60/attack:-3/hp:0…)全是死数据——中毒/流血永远不会真扣血,纯叙事 buff。两层缺口: ①引擎缺 DoT tick(与 §8 checkStatusTrigger 未接线同族,需技能系统立项) ②status_apply 工具 schema 的 effects 字段自由形状,应枚举可消费键,否则连 attack:-3 这类非 DoT 减益也静默无效

**已知残留**: budget_exceeded(120 调用)仍未触发——S16 双高防低攻 2v2 只打到 79 调用就被 AI 按"胜负已定即 end"纪律提前收尾(守门方守住判 ally_win,语义合理),prompt 纪律与消耗战设定天然互斥,不值得对抗性逼出

## 4e. 第七轮:DoT 机制接线(2026-07-31,§4d 发现的修复)

架构 §5.4 的空承诺("回合结束后结算减益 DoT")正式落地:

- **引擎**: `buff-registry.collectDotTicks`(纯函数,可消费键 `dot` 固定值×stacks / `dotPercent` maxHp 比例×stacks 封顶1,仅减益/特殊,非有限数按 0)+ runner `tickRoundBuffs` 在时长递减前逐 buff 结算(delta_hp patch `source=combat-dot-tick` 带 buff 名溯源、HP clamp≥0、归零置 canAct=false 交 deriveWinnerFromState)+ CombatEvent 新增 `dot_tick`(UI switch 对未知类型静默,追加安全)
- **契约**: status_apply 工具 schema 的 effects 描述枚举全部 9 个可消费键(§4d 发现的自由形状缺口一并收口);combat-agent-api.md / combat-system-architecture.md §5.4 已同步
- **测试**: buff-registry +4(层数/封顶/增益不消费/杂键忽略/混合叠加)、combat-runner +1(全链: tick→patch→事件→引擎态),全量 **3487/3487 绿**
- **S11 真机复跑全通**: AI 在新 schema 引导下 12 次 status_apply 全用标准 `dot` 键(此前 6 种杜撰形状归零);6 回合 dot_tick 各扣 中毒150+流血90;摘要"毒性每回合吞噬 240 点生命"与引擎真值分毫不差;终局毒到战意溃逃 ally_win——施加→结算→落库→叙事四层对齐

## 5. 审计结论要点(11-agent workflow)

- agent 评级 3A/5B/2C。过硬:掷骰纪律 1:1(10/10)、数字对账、拦截后自纠 6/6。**最大缺口:叙事越权(7/10 场)**——捏造未结算的命中/死亡/战利品(落库数据未被污染,补丁是权威真值,但摘要与引擎态分叉)
- 审计的 3 条"engine-bug"是误诊,勿再修:先攻含敏捷项(不只比裸骰)、S05"优势取低"实为劣势(低打高)、缺第二骰时引擎自掷均匀骰(设计行为)
- "伤害与骰值弱耦合"是设计(d20 只定评级档 0.3~2.0,同档伤害确定),已写进 prompt 第 7 条

## 6. 下一步压测执行清单(按优先级)

1. ~~**修复验证复跑**~~ ✅ **2026-07-31 第四轮已完成,全部验证点通过**(见 §4b)
2. ~~**可观测性补强**~~ ✅ **全部收口**(§4b toolHistory.result + §4c engineEvents subscribeChain)
3. **规模/极限压测**:~~并发 8 × 30 场~~ ✅(§4c);~~MAX_TURNS 路径~~ ✅;剩余:并发 8 未压出 429,如需实测限流需并发 12+ 或 STRESS_REPEAT=5+;budget_exceeded 判定为不值得逼出(§4d 已知残留)
4. ~~**未覆盖机制的定向场景**~~ ✅ **2026-07-31 第六轮完成**(§4d): DoT 施加面/集群(发现并修复断线 bug)/多段/登神/玩家输入全验;非致死+暴击失手致死路径未单独立场景(S03/S10 已覆盖非致死主路径)
5. **模型对照**:deepseek-v4-pro 同场景对照(纪律/成本/时延),或加大 temperature 测鲁棒性
6. **产品决策后再做**:摘要硬闸(战斗未 end 拒收 <combat_summary> 退回重试——审计强推,拦截自纠已被证明 6/6 有效)、战意事件入 runner 事件流、miss 的 amount=0 补丁过滤

## 7. 关键文件索引

| 文件                                                                                 | 说明                       |
| ------------------------------------------------------------------------------------ | -------------------------- |
| scripts/combat-stress-test.ts                                                        | 压测 harness(§3 用法)      |
| src/sillytavern/combat-bugfix-regression.test.ts                                     | 两轮修复的回归测试(新文件) |
| src/sillytavern/combat-{pipeline,runner,resolver,damage,intention}.ts                | 主要修复载体               |
| src/sillytavern/{status-api,buff-registry,agent-tools,combat-settlement-pipeline}.ts | 第二轮整改                 |
| data/defaults/agent-config.json → agents.combat.systemPrompt                         | 7 条战斗纪律(压测后新增)   |
| tmp/stress/2026-07-31T03-22-45-690Z/                                                 | 上轮压测原始数据           |
| docs/reference/combat-{system-architecture,agent-api}.md                             | 已同步的文档               |

## 8. 已知遗留(已在代码/报告中声明)

- ~~DoT 无消费方~~ ✅ **2026-07-31 第七轮已修复**(§4e): collectDotTicks + runner 回合结算 + schema 键枚举,S11 真机四层对齐
- checkStatusTrigger/d20Status 未接线(状态施加仍是暴击占位,等技能系统)
- state-manager 落库按裸名索引且不持久化 sourceKey,与战斗内 buffId 颗粒度有差(需存储层改造,单独立项)
- runRoundPipeline 生产零调用方(runner 自带 tick+round 事件;导出函数已修好供外部用)
- 战意 outcome(投降/溃逃)落 morale 字段但不自动移出行动轴(AI 叙事驱动 combat_end)
