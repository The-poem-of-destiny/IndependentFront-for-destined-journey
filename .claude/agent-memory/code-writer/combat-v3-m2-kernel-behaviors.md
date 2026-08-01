---
name: combat-v3-m2-kernel-behaviors
description: 战斗 v3 M2 coordinator 必须知道的 M1 内核行为（SupplyDice 不 auto-advance / unit 需消费两槽 / settle 不产 SettlementCommitted 事件 / completed 在 Terminal 就 true）
metadata:
  type: project
---

战斗 v3 M2（coordinator）实现时踩到的 4 个 M1 内核行为，写 coordinator 前必知：

1. **`SupplyDice` 不触发 auto-advance**：reducer.ts 的 `reduceSupplyDice` 短路返回（phase 仍 CombatOpen、revision 不递增）。coordinator 喂完骰后必须**再 dispatch 一个真实动作 Command**，由 kernel 在 `runDispatch` 里 auto 推进 CombatOpen→…→SlotConsume 并消费它。M2 用 `decideForUnit(firstInitiative())` 按阵营分流产 Command。
2. **单位必须消费两槽才推进**：攻击杀死目标后 kernel 仍返回 `PlayerCommand`（本轮动作槽未消费），`checkTerminal` 延后到单位补完动作槽才跑。A2-1 测试要给玩家「攻击 + pass 动作」完整回合。
3. **`terminal.ts settle` 不产 `SettlementCommitted` DomainEvent**：只产 `CombatEnded` + FP `NarrativeCue`。coordinator 的 `toPatches` 不能依赖该事件，直接按 `fpDelta = finalFP − 初始FP` 生成 FP patch。
4. **`session.completed` 在 phase=Terminal 就返回 true**：kernel.ts 的 `completed` getter 把 Terminal 也算完成。coordinator 的 while 条件必须用 `phase !== 'SettlementCommitted'` 而非 `!session.completed`，否则会漏掉 Terminal→settle 那一步。

另有：`projectToAgent` 只能拿 `session.snapshot().snapshot()`（CombatView），拿不到内部 CombatState（kernel 闭包藏 state），投影 B 必须基于 CombatView 形状写。FP 净变动进 `CombatV3Result.totalFp` + 一次 `commitChatState`（A2-1）。相关：[[combat-v3-m0-signature-refactor]] [[combat-v3-m1-kernel-architecture]]
