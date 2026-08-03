# 重构路线图

> 本文是《[代码质量与重构审查报告（2026-08-03）](README.md)》的一部分。返回 [索引与优先级总表](README.md) · [健康面与覆盖缺口](health-and-gaps.md)

排序有硬约束：删尸体必须先于巨石拆分（否则死类型会被一起搬进新的 `types-*.ts`），能力面收口必须先于 Legacy 退役（退役会带走唯一的 parity 差分守卫），品质/设置建类型必须先于 `SettingsPage` 拆分（否则拆完的分区还要按新类型再改一遍）。标注「需裁定」的步骤在开工前需要 owner 拍板。

## 步骤 1 — 清尸体 + 把工具链的网补齐（S）

- **包含**：[Q-04](findings-t4-corpses.md#q-04)、[Q-15](findings-t6-safety-net.md#q-15)
- **做什么**：删除五处零引用僵尸（v3 世界书栈 `lorebook-engine` / `prompt-assembler` / `editor-utils` / index 桶、v2 战斗遗留、`stream-parser`、`agent-templates` 里失效的 `variableContext` / `variableInstruction` 闭包）及其只测彼此的测试；把 `tests/`、`server/`、`scripts/`、根配置纳入 tsc / ESLint / Prettier；清掉 59 个 tracked 临时脚本与 ~120MB 参考大文件。
- **为何在此**：死代码必须先于任何巨石拆分——否则 v3 的 `Lorebook` 死类型会被一起搬进新的 `types-*.ts`，`tmp/` 的 `.bak` 会继续污染每一次全仓 grep。工具链先补齐，后面每一步才有编译期保护。删除面已由排除测试文件的全仓 grep 逐个反证。

## 步骤 2 — 修两处已经在生产里静默出错的路径（S）

- **包含**：[Q-01](findings-t1-wiring-gap.md#q-01)、[Q-02](findings-t1-wiring-gap.md#q-02)
- **做什么**：把真骰子源接进 v3 coordinator 的注入点（消灭恒定 10）；接住 `applyTimeAdvance` 返回的 patches，让状态到期的 remove/hp/stat 与 `onRemove` 脚本真正落库。
- **为何在此**：两条都是「代码看起来完全正常、行为静默退化」的缺陷，改动面小、不依赖任何裁定，应当最先兑现。骰子那条建议先真机打一场确认现象，再合入。

## 步骤 3 — 三处去留裁定：效果层 / 记忆层 / start-catalog（L，需裁定）

- **包含**：[Q-07](findings-t1-wiring-gap.md#q-07)、[Q-03](findings-t1-wiring-gap.md#q-03)、[Q-30](findings-t3-single-source.md#q-30)
- **做什么**：由 owner 拍板并落地：(a) emitChain 事件效果层与 13 个惰性 ReactionWindow 是接线还是删除（连带修订 ADR-29 的措辞）；(b) 记忆落库以引擎 `memory-summarizer` 还是 UI 侧实现为准，并给出两套 MEM 编号的兼容方案；(c) `start-catalog` 的 8752 行数据外置成 JSON 资产还是保留为模块。
- **为何在此**：这三条都需要人拍板、周期长，越早开始越好；而且步骤 8 的 `types.ts` 拆分必须知道效果层是否留下，否则会围绕一批可能要删的类型划域。裁定可与步骤 4-5 并行推进。

## 步骤 4 — AI 输出编解码收口（M）

- **包含**：[Q-05](findings-t2-ai-boundary.md#q-05)、[Q-13](findings-t2-ai-boundary.md#q-13)、[Q-14](findings-t2-ai-boundary.md#q-14)、[Q-17](findings-t2-ai-boundary.md#q-17)
- **做什么**：新建一个被测试钉住的模型输出解析模块（XML 标签 / marker 扫描 / JSON 抢救 / 子元素，统一容忍度：单引号属性、markdown 包裹、缺闭合、前后解说文字），把 15+ 份拷贝换成调用；统一写入失败的回执与日志口径（落库失败不得伪装成解析失败）；去掉 `assembleCharacterState` 的 14 处 `as any`；合并 `agent-client` 流式/非流式的请求体装配。
- **为何在此**：这是真机 debug loop 每天在踩的地方，收敛后每修一次惠及六条链。不依赖任何裁定，且做完之后 Q-19 的翻译层抽取会容易得多（解析已经在缝后面）。

## 步骤 5 — 数据路径去重：六步迁移 + store 工具层 + 拆掉同名 applyVarsPatch 陷阱（M）

- **包含**：[Q-08](findings-t3-single-source.md#q-08)、[Q-16](findings-t3-single-source.md#q-16)、[Q-12](findings-t3-single-source.md#q-12)
- **做什么**：把三份「六步迁移」抽成一个带策略参数的骨架（回读校验强度作为参数传入），合并三套测试；抽出 store 层公共工具（Vue Proxy detach、配额判据、素材路径判据），统一 `game-store` 三个存档 metadata 写函数的乐观更新与回滚纪律；删掉 `variables.ts` / `vars-merger.ts` 两个僵尸宿主并让 `applyVarsPatch` 只剩一个语义。
- **为何在此**：迁移是仓库里唯一「搞砸即用户数据不可恢复」的路径，第三次迁移会复制出第四份，抽取越早越省；detach helper 与 metadata 写法的收口会直接降低后面所有 store 拆分的成本。

## 步骤 6 — 品质体系与设置的单一真源（L，需裁定）

- **包含**：[Q-11](findings-t3-single-source.md#q-11)、[Q-18](findings-t6-safety-net.md#q-18)、[Q-06](findings-t3-single-source.md#q-06)
- **做什么**：把 7 级品质的类型/序号/颜色收成一张表（以 `field-enums.ts` 为准），删掉 5 份颜色映射与 5 处 `as any`，把视图层的 `inferQuality` 搬回引擎并补测；给 `AppSettings` / `UISettings` 建真类型，把 13 张并行 `Record<agentId, T>` 收成一个 `AgentSettings` 对象；确定设置的唯一真源并删掉那段两字段手写桥。
- **为何在此**：要先于步骤 8 的 `SettingsPage` 拆分——否则拆完的分区还要再按新类型改一遍。需要拍板两件事：设置真源归 Dexie 还是 localStorage（涉及 FullBackup 与异步化），以及品质表的落点。

## 步骤 7 — EJS 能力面契约单一真源 + Legacy 退役（L，需裁定）

- **包含**：[Q-09](findings-t3-single-source.md#q-09)、[Q-10](findings-t4-corpses.md#q-10)、[Q-27](findings-t5-layering.md#q-27)
- **做什么**：用一份 manifest 生成 TS 侧与 guest 字符串侧的符号表、`engine.has` 名单与原型污染键集（消灭 6 处手记），给 `world` / `engine` 两个 namespace 补接口类型；把现成的编译缓存接到生产的 QuickJS 路径上；删掉生产恒回退的同步渲染路径并退役 `LegacyBackend`；顺带把 iframe 内联运行时按四个职责切开。
- **为何在此**：顺序是硬约束：Legacy 退役会带走唯一的 parity 差分守卫，所以能力面必须先收成单一真源。缓存接上后可直接削掉一块主线程占用，也是把 `passTimeoutMs` 从 5000 调回来的前提。需要拍板 Legacy 的退役时机与替代守卫方案（备忘录里的计划仍卡在真机走查）。

## 步骤 8 — 巨石拆分第一刀：types.ts 域拆分 + 翻译/提交层抽成模块（L，需裁定）

- **包含**：[Q-23](findings-t5-layering.md#q-23)、[Q-19](findings-t2-ai-boundary.md#q-19)
- **做什么**：按域把 `types.ts` 拆成 `types-*.ts` 并把常量/函数移出类型文件，修正 `combat-v3/types.ts` 的反向依赖；把 orchestrator 那个 560 行私有翻译方法抽成可单测的纯函数模块，把 `state-manager` 的 14 处非必要动态 import 改回静态、拆掉 30 分支 switch 的装配层。
- **为何在此**：必须在步骤 1（删尸体）与步骤 3（效果层裁定）之后，否则会把死类型和未定去留的效果层一起划进新文件。域边界本身要拍板（`QualityLevel` 被 craft 与 item 共用，应留主干而非下沉）。

## 后续批次（不进前八步）

以下 9 条被刻意排在路线图之后，原因各不相同，列出以免被当成遗漏：

| ID                                        | 为何延后                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Q-25](findings-t5-layering.md#q-25)      | 前端最大的一刀，但抽取模式已由 `AudioSection` / `AssetSection` 证明，且必须等步骤 6 的类型落地 |
| [Q-29](findings-t5-layering.md#q-29)      | 与 Q-25 同理，且拆 GamePipeline 与 create-store 的 seam 依赖步骤 4 的解析缝先就位              |
| [Q-28](findings-t5-layering.md#q-28)      | 319 条主题选择器需先逐条验证是否仍匹配活 DOM（可能已有一部分是死的），属独立调查               |
| [Q-24](findings-t5-layering.md#q-24)      | 与 Q-25 同批处理更划算，单独做会重复走一遍 store 测试的改造                                    |
| [Q-20](findings-t6-safety-net.md#q-20)    | 测试底盘整理宜在生产代码形状稳定后一次做完，否则夹具要跟着改两轮                               |
| [Q-21](findings-t3-single-source.md#q-21) | 战斗/制作结算层去重风险偏高（涉及平衡数值），建议配合 audit-code workflow 与世界书对账后再动   |
| [Q-22](findings-t4-corpses.md#q-22)       | 纯签名收敛，无阻塞关系，任何一个 combat-v3 的 PR 可顺手带走                                    |
| [Q-26](findings-t3-single-source.md#q-26) | Dexie schema 重述是机械噪音，但改动触及迁移链，宜在步骤 5 的迁移骨架稳定后再做                 |
| [Q-31](findings-t3-single-source.md#q-31) | 局部语义不一致，顺路修即可                                                                     |
