# 主线细化层 · 本轮角色计划（castPlan）设计 v1

> **状态**：已实施（2026-09-12），真机待验证。
> **关系**：ADR-35 主线细化层（`docs/planning/2026-09-07-mainline-refinement-layer-design.md`）
> 之增量。§3.4（侧链角色实体化的可见性与一致性）是**历史节点投影**，本轮补的是**同轮计划投影**。
> 契约词汇沿用根 `CONTEXT.md`「地图系统 / 随机事件系统 / 主线细化」节。

## 0. 背景与目标

现状断点（2026-09-12 排查）：

```
pre_check（正文前）产出 directive / threadDeclarations
  ├─▶ story：经 <剧情导演>（AGENT.PLOT_PRE_CHECK）看到
  └─✂─ dispatcher / char_gen：看不到本轮这些
dispatcher（正文后）只看得到 {{PLOT_THREAD_SURFACE}} =「已揭示 + 已提交」的旧节点表层
char_gen 只认「已提交节点 involvedNpcs 精确同名」的旧投影（§3.4）
```

于是 pre_check 的**本轮选角意图**在 story 之后断链：想引入谁、以什么身份/行为出场，dispatcher
收不到、char_gen 更收不到。目标两条：

1. **pre_check 多思考、多透漏**：把它「本轮想让谁出场、以什么身份/行为出场」结构化说清。
2. **dispatcher 尽量完整复述**：正文里真出现的计划角色，`<char_gen_request>` 原样沿用引用键、
   完整复述行为；**Code 另开直注 char_gen 兜底**，不赌 AI 转述。

## 1. 契约：pre_check 新增 `castPlan`

`plot_pre_check` 输出 JSON 增加可选字段 `castPlan`（同轮计划，**ephemeral，不落库**）：

```jsonc
"castPlan": [
  {
    "ref": "奥古斯都家的使者",          // 稳定引用键：全链按它称呼/对账（必填，唯一）
    "nodeRef": "章节/事件/节点名",       // 可选，挂靠的主线锚（须与事件线标题逐字一致）
    "role": "身份定位（面向叙事与档案，玩家可感知）",
    "behavior": "本轮要求的行为（要做什么/以什么态度）",
    "surface": "可展示的外在信息：外貌/身份线索（供 char_gen 建档案）",
    "nameConstraint": { "mode": "segment", "value": "奥古斯都" }, // 可选，仅「名字是线索」时
    "secret": "幕后真相/动机 —— 永不下发，只进结构化字段"
  }
]
```

- `ref` 必填且同轮唯一；坏条目（无 ref）逐条丢弃，不连坐。
- `nameConstraint.mode` 二值：`full`（全名必须等于 value）/ `segment`（value 必须作为「·」分隔的一段
  出现 —— 覆盖家族姓/氏族名/共名词）。

### 1.1 命名约束是「名字即线索」的明确例外（🔴）

数据字段规范铁律①「逻辑键=名字，AI 永不产 id」。默认新角色名字**仍由 `random_name_seed` 生成**。
`nameConstraint` 只在**名字本身是线索 / 名字错了线索对不上**时使用（如同一家族成员须共享姓氏）。
它是本条契约有意开的一个窄口，不得被用成「pre_check 随便指定名字」。

### 1.2 可下发面（防剧透）

| 字段                                                       | story | dispatcher | char_gen | 说明                                       |
| ---------------------------------------------------------- | ----- | ---------- | -------- | ------------------------------------------ |
| `ref` / `role` / `behavior` / `surface` / `nameConstraint` | ✅    | ✅         | ✅       | 玩家可感知的安全面                         |
| `secret`                                                   | ❌    | ❌         | ❌       | 永不外发（同 §3.4「motive 本体不进档案」） |

身份型伏笔**不许**把真身写进 `role`/`nameConstraint`（那会落进角色档案剧透）；真身在揭示动作时
由 pre/post 补（沿用 §3.4 裁定 3）。

## 2. 数据流（同轮）

```
pre_check ──castPlan──▶ Code（parsePlotCastPlan）
   ├─ story    ：<剧情导演> 追加「本轮角色规划」（安全面）
   ├─ dispatcher：{{PLOT_CAST_PLAN}} 占位符（安全面）→ 提示词要求复述进 <char_gen_request>
   └─ char_gen ：buildCharGenPlotInjection 命中 ref → 直注 role/behavior/nameConstraint（Code 背书）
```

- **不持久化**：plan 是计划不是事实；成功回合也不写 `worldFlags`。
- **是预测不是命令**：正文没引入的角色不得凭空生成；dispatcher 只在正文真出现且发 request 时才用。
- **story 也吃名字约束**：名字是线索时，正文须用同一称呼，否则 dispatcher 匹配不上、读者也读不出线索。
- **优先级**：`castPlan 名字约束 > 描述性称呼→生成真名 > 默认随机`。

## 3. 实现落点

| 层     | 文件                                                      | 改动                                                                                                                            |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 领域   | `src/core/plot/plot-threads.ts`                           | `PlotCastPlanEntry` 类型 + `parsePlotCastPlan` / `projectPlotCastPlan` / `findCastPlanEntry` / `formatPlotCastPlanLines` 纯函数 |
| 解析   | `src/core/plot/plot-engine.ts`                            | `PreCheckResult.castPlan` + 归一化接线                                                                                          |
| 上下文 | `src/core/types/types.ts`                                 | `AgentContext.plotCastPlan?`                                                                                                    |
| 注入   | `src/core/prompts/placeholder-registry.ts`                | `{{PLOT_CAST_PLAN}}` resolver（dispatcher）+ 默认模板                                                                           |
| 组装   | `src/core/prompts/prompt-session-assembler.ts`            | `PLOT_CAST_PLAN` 进 ephemeral 正则                                                                                              |
| 编排   | `src/ui/lib/game-pipeline.ts`                             | `handlePlotPreCheck` 落 `currentContext.plotCastPlan` + story 导演块 + `buildCharGenPlotInjection` 扩展                         |
| 配置面 | `src/ui/components/settings/agent/placeholder-catalog.ts` | 徽章目录 `PLOT_CAST_PLAN`（request_dispatcher）                                                                                 |
| 内容   | 私有仓 `agent-config.json`                                | pre_check 输出契约/工作流；dispatcher 复述规则；char_gen 命名约束优先级；dispatcher 模板加占位符                                |

## 4. 与 §3.4 的关系

两条通道**互补**，都保留：

- §3.4 历史节点投影：读 `worldFlags.plotThreads` 已提交节点，按 `involvedNpcs` 精确同名注入 motive
  行为化 —— 管「这个角色与既有主线节点有关」。
- 本设计同轮计划投影：读 `currentContext.plotCastPlan`，按 `ref` 精确同名注入 role/behavior/
  nameConstraint —— 管「本轮 pre 计划了这个角色」。

命中可同时发生，注入内容拼接；`secret` 两路都不带。

## 5. 验证计划

- 纯函数：`parsePlotCastPlan` 容错（坏条目丢弃 / mode 归一化）、`projectPlotCastPlan` 无 secret、
  `formatPlotCastPlanLines` 空计划返空串。
- 占位符：`{{PLOT_CAST_PLAN}}` 有值时出 `<plot_cast_plan>` 外壳、空值零 token。
- 会话：`PLOT_CAST_PLAN` 归 ephemeral（进 turn_context，两轮之间随值变化更新）。
- 编排：story 导演块含规划；char_gen 注入命中 ref 时带名字约束、不命中不加戏。
- 真机：真实 LLM 回合验证留待真机（本轮不做付费调用）。

## 6. 已知取舍

- 无 `ref` 的角色（不约束名字）Code 无法按名兜底，`behavior` 只能靠 dispatcher 复述（best-effort）。
- `nameConstraint.mode=segment` 时，`ref` 是引用键而非最终名；char_gen 生成的真名与 ref 不同，
  后续轮次按真名对账（本设计不做 ref→真名的持久映射；需要时另开设计）。
- 战斗名单按 `characterName` 精确匹配：名字约束角色若参战，宜用 `mode=full` 且 `ref` 即最终名。
