# 战斗 v3 M3.5 — 开放性出口经验记忆

## 范围
M3.5 = CharGenRequest + BoundedAdjudication + prompt 改写。把 v3 内核从「封闭战斗」打开：召唤走 char_gen，创意效果走有界裁决。

## 关键决策记录

### 1. 裁决在 reducer 重锤，coordinator 只路由
coordinator 的 BoundedAdjudication 路由只做「调 evaluateAdjudication → reject 流回 / 通过提交 Adjudicate」，真正的验证消费在 reducer（持完整 CombatState，能验 target.divinity）。拒绝产 `EffectRejected(ADJUDICATION_REJECTED)`。

### 2. ProposedAdjudication.requestedRuleOverride 用 string 而非 rule-keys 联合
避免循环依赖（rule-keys import types）。六步验证照架构 §11.2。

### 3. joinTiming 恢复
- `this_round_tail` → `draw(initiative,1)` 掷 1 颗 + append 先攻序列尾部
- `next_round_head` → 追加 id（下轮 handleInitiative 统一掷）

### 4. 召唤池（§6.4 可选）做最小空池
`summon-pool.ts`：空 map + `summonPoolKey` 归一化 + `lookupSummon` 幂等查找 + 未命中回退走实时 char_gen。不做离线生成脚本（符合 plan「M3.5 不做也能验收」语气）。

### 5. EffectChoice 保留 UnsupportedInM2 throw
plan §6.7 只要求替换 CharGenRequest / BoundedAdjudication 两路，EffectChoice 归 M4/后续。测试断言更新为「EffectChoice 抛，另两路不抛」。

### 6. item_gen/char_gen prompt 采 additive（关键保守取舍）
新增 `<automaton>` / `combatParticipation` 为**可选段**，**保留现有 `<script>`($ API) 主链**。原因：删 `<script>` 会破坏 `assembleCharacterState` 与既有 5191 tests 的整条非战斗物品管线。`<automaton>` 由战斗 v3 DSL 编译链消费，M4 才接实装。

### 7. agent-config.json raw slicing
prompt 改写用 python 精确切片（禁 prettier，systemPrompt 含字面 `\r\n` 转义会 58KB 重排）。改完 diff 必须干净。

## 踩坑 / 修复

### applyPending 同名 buff tick 语义修
`remainingTime` 不同 = 覆盖（新 buff 替代旧），相同 = 叠层。这是 M3.5 顺手修的既有 bug。

### removeUnitIds / activeEffects 收进 applyOutcome
召唤物移除要原子：round.close 时找过期召唤物 → 产 UnitDespawned + 摘 automaton + 移除 unit，与当轮其他变更同一次提交。

## 遗留（归 M4）
- 第 06 场 fixture 端到端（A35-6）：fixture 是 concept 版（`_synthetic`，老 DeclareAction+summon payload），与 SpawnOrDespawnIntent 内核流不对接，M4 重做 fixture
- `<automaton>` JSON 实装消费（compile → windows 求值）归 M4
- `runCharGenForCombat` 召唤物防御/DR 用保守默认 0，后续精化

## 质量门
5191 tests / 169 files（新增 25：adjudication ~10 / spawn 5 / summon-pool 3 / coordinator +3 / char-gen +2）；typecheck 0；prettier 干净（CRLF 假象判断：LF 归一化 + 仓库 .prettierrc 验，5 个本地报格式文件实际 clean，CI Linux LF 一次过）。

相关：[[combat-v3-m1-kernel-architecture]] · [[combat-v3-m2-kernel-behaviors]]
