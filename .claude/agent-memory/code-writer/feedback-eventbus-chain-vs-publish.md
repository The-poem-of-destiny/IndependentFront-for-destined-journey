---
name: feedback-eventbus-chain-vs-publish
description: EventBus emitChain 只触发 chainHandlers，不触发 subscribeAll/subscribe；监听 emitChain 事件必须用 subscribeChain
metadata:
  type: feedback
---

EventBus 有两套互相独立的订阅注册表：`chainHandlers`（链式，emitChain 触发）和 `handlers`/`globalHandlers`（普通，publish 触发）。

**用 `subscribeAll` / `subscribe` 监听 `emitChain` 发出的事件，永远收不到。** 必须用 `subscribeChain({ type, handler })`。

**Why:** 2026-07-29 写 combat-settlement-pipeline.test.ts 时，本喵用 `subscribeAll` 监听 `combat.end`/`combat.settle.loot`/`combat.settle.complete` 三个 emitChain 事件做计数断言，结果 counts 全是 0、triggered 永远空数组。看 game-event.ts 源码才发现 emitChain 只遍历 `this.chainHandlers`，publish 才遍历 `handlers`/`globalHandlers`，两套互不干扰（源码注释明确写了 "与 subscribe 走独立注册表，两套互不干扰"）。

**How to apply:**
- 写测试断言 emitChain 事件触发时，用 `subscribeChain({ type: evType, handler })` 注册计数器，**不要**用 `subscribeAll`
- 多个事件类型分别 subscribeChain，handler 里闭包累加各自计数
- 同理：`??` 对空字符串不走默认分支（空字符串是 falsy 但非 nullish），需要"空值走默认"时用 `||` 或显式 `.length > 0` 检查（如 AI 写的 summary 为 `''` 时应回退默认摘要）
- 排序断言中文字符串顺序时，`.sort()` 结果依赖 Unicode 编码不可预测，比较两个集合用 `a.sort()` vs `b.sort()` 都排序后比较，或转 Set
