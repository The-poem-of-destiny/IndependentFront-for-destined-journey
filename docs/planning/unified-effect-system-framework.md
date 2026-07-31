# 统一效果系统框架（制造 + 战斗）· v2

> **状态**：v2，已自审一轮（修正 v1 的机制描述错误 + 补 AI 介入模式 + 加天马行空测试场景）
> **日期**：2026-07-30
> **变更**：v1 误把机制描述成"modifier 字段 vs script 两套"，实际是**统一 subscribeChain 链式管道 + 两个注册 facade（ScriptRegistry 声明式 / SubscriptionManager 动态）**；v1 漏了战斗 v2 已验证的"纯函数兜底 + AI subscribeChain 覆盖"模式

---

## 一、设计理念（ADR-28）

世界书是给纯文本 AI 的协议（骰子池/action_info 面板/`{{roll}}` 都是文本妥协）。我们**只模仿输入→流程→结果**，中间用工程手段。流程对齐世界书（制作三阶段/战斗六阶段/品质继承/伤害管线/状态规则），效果分类对齐[品质效果限定]6 大类。

---

## 二、核心机制：统一的 subscribeChain 链式管道

**战斗 v2 (M1-M5) 已实现一套统一机制**，制造系统直接复用，不发明第二套：

```
EventBus.emitChain(type, params, ctx)
  ├─ 按 (priority, order, 注册序) 稳定排序订阅者
  ├─ 在场过滤（ctx.combatants + subscription.owner）
  ├─ 链式变换（前一个返回 params 作后一个输入）
  ├─ 条件过滤（subscription.condition）
  ├─ 错误隔离（单 handler 抛错不中断）
  └─ 递归保护（chainDepth + maxDepth，默认 10，战斗可收紧 5）
```

**两个注册 facade（各走各的注册表，互不干扰）**：
| Facade | 用途 | 触发时机 | 状态 |
|---|---|---|---|
| **ScriptRegistry**（声明式） | 物品/技能的**静态脚本清单** → subscribeChain handler | 装备时 `registerAll`，卸下时 `unregisterOwner` | ✅ 实现，❌ 生产未接线 |
| **SubscriptionManager**（动态） | AI script 运行时 `$event.on` | script 执行期间注册 | ✅ 实现，❌ 生产未接线 |

**关键认知**：modifier 字段、script、$event.on **不是三套并存**，而是——物品的"效果声明"在装备时经 ScriptRegistry 注册成 subscribeChain handler；handler 内可以 push modifier 数据、可以调 $ API、可以读 params 做条件判断。**一条管道，多种 payload**。

---

## 三、现状（战斗 v2 已验证，对齐真实代码）

### ✅ 已实现且生产接通
- **EventBus.emitChain / subscribeChain**（game-event.ts）—— 链式管道核心
- **combat-pipeline.ts**（M3）—— 调 `collectAttackerMods`/`collectDefenderMods` 收集 modifier（已接通）
- **modifier-collector.ts**（M2）—— collect_mods 走 emitChain
- **combat-damage.ts:runDamagePipeline**（纯函数 8 步）+ **combat-modifier-inject.ts**（modifier 折叠 + 登神压制）
- **effect-types.ts** —— Modifier 6 大类 + `condition` 字段 + 聚合工具
- **combat-morale-pipeline / combat-settlement-pipeline** —— **"纯函数兜底 + AI subscribeChain 覆盖"模式**

### ✅ 已实现但生产未接线（= P1-11 的真相）
- **ScriptRegistry**（script-registry.ts）—— 装备时 `registerAll` 把脚本清单注册成 handler。**装备/卸下时没人调用** → 战斗 collect_mods 收到空列表（handler 没注册）
- **executeInit / executeCleanup**（script-executor.ts）—— 生命周期钩子。**装备/卸下时没人调用**
- **SubscriptionManager**（subscription-manager.ts）—— `$event.on` 动态订阅。**没接通**

> **结论**：基础设施全部就位（M1-M5 齐全），**唯一缺口是"装备/卸下/存档加载时调 executeInit → ScriptRegistry.registerAll"这一步接线**。通了之后，modifier 收集 + script 触发 + $event.on 动态订阅**全部自动生效**。
>
> **🔍 第三轮审核确认**：`combat-pipeline.ts:231` 生产调 `collectAttackerMods`，但因无装备 handler 注册，**返回空列表 → 管线已通但空转**（hitBonusFromMods 恒 0，foldMods 全 0）。证实 P1-11 缺口判断准确。
>
> **🎁 骰值操控的现成机制**：`combat-pipeline.ts:239` 已有 `COMBAT_EVENTS.DICE_ROLL` 事件节点（emitChain，script 可 subscribeChain 改 `params.dice`）——正是主人大人问的"重骰<5/骰值+5/优势"的现成实现路径，**制作侧加 `craft.dice.roll` 节点照搬即可**，不用新发明。

### ⚠️ emitChain 的两种用法（都要用到制作侧）
1. **数值收集**（collect_mods 模式）：handler 往 `params.mods.push(...)` 写数据。如 `combat.attack.collect_attacker_mods`
2. **AI 创造性介入**（morale/settlement 模式）：纯函数算基础 → emitChain 传给 AI → AI handler 改 `params.outcome`/返回 loot → 代码应用。如 `combat.morale.check` / `combat.settle.loot`

---

## 四、"纯函数兜底 + AI subscribeChain 覆盖"模式（核心设计模式）

战斗 v2 的 morale/settlement 已验证此模式（RFC Q6），**制作侧应照搬**：

```ts
// 制作示例：精益求精额外词条选择
async function settleCraftExcellence(craftCtx) {
  // 1. 纯函数算基础（确定性兜底）
  const baseBonus = calcPerfectionBonus(craftCtx);  // 如"获得1个额外词条槽"

  // 2. emitChain 代码→AI：AI 通过 subscribeChain(CRAFT_EXCELLENCE) 选具体词条
  const result = await bus.emitChain('craft.excellence.pick', {
    crafterId, product: craftCtx.product,
    baseBonus,           // 纯函数给的"1个词条槽"
    chosenAffix: undefined,  // AI 填
  }, { combatants: [crafterId], source: crafterId });

  // 3. AI 不响应 → 用 baseBonus 兜底；AI 响应 → 取 chosenAffix
  const finalAffix = result.chosenAffix ?? defaultAffix(baseBonus);
}
```

**意义**：数值/结构由 Code 算（严谨），具体内容由 AI 选（创意）。AI 不响应也能跑（兜底）。制作的多处可套用：精益求精词条、产物外观风格、失败叙事走向、管制物徽记设计。

---

## 五、制作侧落地（复用战斗 v2 全套机制）

### 5.1 制作管线节点（对齐世界书三阶段）
```
resolveCraft(request):
  ① 准备：批量/许可/品质/资源（纯函数）
  ② 检定：
     a. collectCraftMods(crafterId) → emitChain('craft.collect_mods')
        收集制作者装备/技能/buff 声明的 craft modifier（CheckModifier 生产检定 / 特殊机制 重骰/优势）
     b. 折叠成 checkMods（聚合工具，对齐 sumFixedDamage）
     c. calcCraftCheck(基础DC, materials, attrs, checkMods) → 评级
  ③ 结算：
     - 材料损耗 / 品质继承 / EXP / FP（纯函数，P1-07 已修）
     - 精益求精：emitChain('craft.excellence.pick') —— AI 选额外词条（§4 模式）
     - publish('craft_action') —— 触发灵感/召唤等 script
```

### 5.2 落地三步（按依赖排序）

**Step 1：接通装备级注册（P1-11 核心，解锁一切）**
- 装备/卸下/存档加载时调 `executeInit`/`executeCleanup`
- executeInit 内：`ScriptRegistry.registerAll(scripts, ownerKey)` 把物品脚本清单注册成 subscribeChain handler
- 同时注册 modifier handler（遍历 `item.modifiers`，为每个 push 到 params.mods）
- 这步通了，战斗 collect_mods 才不再空转

**Step 2：制作侧加 craft 事件节点**
- `CRAFT_MOD_EVENTS = { CRAFTER_MODS: 'craft.collect_mods' }` + `collectCraftMods(bus, crafterId, combatants)`
- `calcCraftCheck` 扩展 `checkMods` 参数（dcBonus/diceBonus/advantage/rerollBelow）
- 结算加 `emitChain('craft.excellence.pick')` + `publish('craft_action')`

**Step 3：item_gen 提示词**
- 教 craft modifier 写法（CheckModifier checkType:'生产检定' / 特殊机制）
- 教 craft script 写法（$event.on craft_action）
- 事件类型枚举加 craft.collect_mods / craft.excellence.pick / craft_action

---

## 六、AI / Code 边界（ADR-11 + ADR-19）

| 职责 | 归属 |
|---|---|
| 数值计算（DC/伤害/概率/品质数轴）| **Code**（纯函数管线）|
| 流程编排（制作三阶段/战斗六阶段 + emitChain 节点）| **Code** |
| 效果**数值**声明（modifier + condition）| **AI**（item_gen，受品质数轴约束）|
| 效果**触发逻辑**（scripts + $ API）| **AI**（item_gen，受 $ API 白名单约束）|
| AI 创造性介入（词条选择/叙事走向/战利品）| **AI**（subscribeChain handler）|
| 兜底（AI 不响应时的确定性结果）| **Code**（纯函数）|
| 校验（数轴 clamp / 五维铁律 / buff 字段齐全）| **Code**（提交前）|

---

## 七、天马行空测试场景（脑内验证框架兼容性）

逐个过：技能/装备塞稀奇古怪效果，框架能否吃下。

| # | 场景 | 机制 | 框架能否处理 | 风险/缺口 |
|---|---|---|---|---|
| T1 | 嗜血剑：攻击回复伤害10% HP | script: onHit `$resource.modifyHp(owner, event.damage*0.1)` | ✅ | 需 combat_action 事件带 damage 值 |
| T2 | 反伤甲：受击反伤20% | defender script: subscribeChain(DEFENDER_MODS) push ResourceModifier(-damage*0.2) | ✅ | 反伤是"对自己扣"还是"对攻方扣"语义要清 |
| T3 | 狂暴 buff：HP<30%伤害×2 | PercentageModifier condition `{{attacker.hpPercent}}<0.3` coefficient 1.0 | ✅ | condition 求值器需读 hp（readHooks）|
| T4 | 灵感护符：制作时10%产物升一级 | script: $event.on('craft_action') if $dice.d100()<=10 upgrade | ✅ | "升级产物"由 Code 按标记执行（script 不直改 DB）|
| T5 | 诅咒工具：制作DC+5但必精益求精 | 2个 modifier（CheckModifier +5 + 特殊机制 强制评级）| ⚠️ | "强制评级"超出 modifier 表达，需扩展或 script |
| T6 | 召唤骷髅王（技能）| 特殊机制 召唤 / script $summon | ⚠️ | $ API 没有 $summon，需扩展或用 status 标记 |
| T7 | 勇者之旗：范围友军+攻击 | 光环：init 时给范围内友军施加"攻击+"buff | ✅ | 光环的"范围/友军识别"需 context 支持 |
| T8 | 三连击计数：连续命中3次必暴击 | script $var 计数 + 强制评级 | ⚠️ | 跨事件计数 $var + "强制评级"扩展 |
| T9 | 以战养战：战斗胜利后下次制作DC-3 | combat_settle script 写 $var('sys.craftBonus',-3) → craft collect 读 | ✅ | 跨系统靠 $var 传递 |
| T10 | 破败之王：HP=1时不死（1次/战斗）| 特殊机制 死亡豁免（品质限定表已有）| ✅ | runDamagePipeline 后的 HP 结算要检查豁免 |
| T11 | 时停（神话）：跳过敌方回合 | 特殊机制 规则改写 | ⚠️ | "跳过回合"需 combat-turn 支持，规则改写最难 |
| T12 | 制作失败时5%概率不消耗材料 | craft_action script if 失败 and $dice<=5 refund | ✅ | refund 是反向 patch（需支持）|

**框架覆盖度结论**：
- ✅ 常规数值/触发/条件/计数/跨系统：**8/12 完全覆盖**
- ⚠️ "强制评级/召唤/规则改写"4 个边界 case 需 $ API 扩展或管线节点支持（不破坏框架，是已知的增量）

---

## 八、回答主人大人的问题（修正 v1）

### Q：数值操控（DC/重骰/优势）+ 复杂效果（灼烧/召唤）怎么统一？
**A**：都走 **subscribeChain handler**（不是 v1 说的"modifier 字段 vs script 两套"）：
- 物品装备时 `ScriptRegistry.registerAll` 把效果清单注册成 handler
- handler 在 emitChain 时被调用，可以：
  - push modifier 数据（数值操控：DC-3 / 重骰 / 优势）
  - 调 $ API（触发效果：$status.apply 灼烧）
  - 读 params 做条件判断（HP<30%）
- 一条管道，handler 里做什么都行（受 $ API 白名单 + Code 校验约束）

### Q：作用域 / 顺序 / 循环 / 规则？
**A**：emitChain 全部内置解决：
- 作用域：`ctx.combatants` + `subscription.owner` 在场过滤
- 顺序：`(priority, order, 注册序)`
- 循环：collect_mods 是"收集 push"，不 emit 事件；触发型走 publish + maxDepth
- 规则：Code 在 handler 执行后/提交前校验（数轴 clamp / 五维铁律 / buff 字段）

---

## 九、已发现设计缺陷 + 修法（v2 审核，待落地）

### 缺陷 1：命中/闪避累加违反世界书"取最高"
- **现象**：`combat-modifier-inject.ts:61/64` 的 `collectChecks(...).reduce((sum,m)=>sum+m.bonus,0)` 把命中/闪避 bonus **累加**
- **世界书铁律**：[战斗协议]"命中加值 / 闪避减值 / 先攻固定修正 —— 多来源取最高值，**不叠加**"；[品质效果限定]检定修正表也标注"命中/闪避(多来源取最高值)"
- **修法**：`foldModsToPipelineModifiers` 按 checkType 分规则聚合：
  - 命中 / 闪避 / 先攻：`const list = checks.map(m=>m.bonus); list.length ? Math.max(...list) : 0`
  - 固伤 / 百分比 / 穿透 / DR：保持累加（世界书也是累加）
  - 属性 / 抵抗 / 逃跑：待确认（倾向 max，对齐"检定取最高"语义）
- **把握**：高。纯聚合规则改动，有战斗 v2 测试兜底

### 缺陷 2：跨实体 `@parent` 生命周期失效
- **现象**：`$status.apply(target, { scripts:{tick:'@parent.burnTick'} })` 把 buff 施加给 **target**，但 `@parent` 指向**攻击者装备**（灼烧之剑）；攻击者卸下/销毁装备 → `ScriptRegistry.unregisterOwner` 清理 parentScripts → target 身上的 buff 再 `onTick` 时 `@parent.burnTick` **指针悬空**
- **根因**：ADR-27 套娃 `@parent` 假设父子同实体生命周期（"装备者给自己加 buff"场景，父=装备/子=buff 都在装备者身上）；"施加给他人"时父（攻击者装备）子（target 身上 buff）生命周期不绑定
- **修法（方案 A：施加时值复制 snapshot）**：`$status.apply`/`$status.add` 收集时，调 `resolveScriptRef` 把 buff.scripts 里所有 `@parent.xxx` / `@item.xxx` 引用**解析成最终代码字符串**，写回 buff.scripts（指针 → 实际代码）。buff 独立持有代码副本，父级卸下/销毁/丢弃都不影响
- **代价**：失去"父级动态改公式、子跟变"（该特性本就是 bug 风险，几乎无用）；自施加/施他人**统一处理**，AI 无感
- **边界**：递归 @parent（≤5 层）照 resolveScriptRef 现有逻辑；`@item.xxx`/`@skill.xxx` 显式跨对象引用也值复制

## 十、待确认点（落地时验证）

1. **condition 求值器**：`ModifierBase.condition` 是 EJS 字符串（`{{target.hpPercent}}<0.5`）。`ejs-runtime.ts` 能力边界 + 安全性？AI 写的 condition 字符串需沙盒。
2. **$ API 白名单粒度**：触发 script 调 `$resource.modifyHp` / `$status.apply`，Code 收集后 apply 时校验到什么程度？（hp 变动上下限 / buff 数值范围）
3. **装备级注册的接线点**：executeInit 在哪里调？StateManager 的 equip_item op 处理时？还是 game-pipeline 加载存档时？
4. **"强制评级/规则改写"类**：T5/T8/T11 这类超出 modifier 数值的，是扩展管线节点（加"评级修正"step）还是全交 script？倾向前者（管线节点，Code 管控）。
5. **光环/召唤**：T6/T7 需 $ API 扩展（$summon）或 status 标记 + 引擎识别。优先级？
