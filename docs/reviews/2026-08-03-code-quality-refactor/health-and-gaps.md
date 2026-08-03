# 健康面与覆盖缺口

> 本文是《[代码质量与重构审查报告（2026-08-03）](README.md)》的一部分。返回 [索引与优先级总表](README.md) · [重构路线图](roadmap.md)

## 健康面

审查同时记录了这个仓库做得确实好的地方，这些不是客套——它们是上面那些重构可以安全进行的前提。

- **工坊纯函数链是全仓最干净的一段，且设计取舍写在注释里且成立**：`manifest` → `regex-map` → `install-plan` → `diff` 四个模块无 I/O、无 Dexie、无 Vue、无浏览器全局；`hashWorkshopContent` 刻意用同步 FNV 而非异步 `crypto.subtle`，就是为了不把纯同步契约传染成 async；`planInstall` 六步线性，首装与更新走同一条路，没有 `if (isInstall)` 分叉。测试量匹配（manifest 609 行 / install-plan 532 行 / regex-map 438 行）。**该切片未提出任何 finding。**
- **combat-v3 的确定性纪律有源码级守卫，而且源码真的守住了**：`no-nondeterminism.test.ts` 用 `import.meta.glob` + `?raw` 扫描 combat-v3 下的 `Math.random` / `new Function` / `eval`，源码用 `_idSeq` 计数器代替随机命令 id；reducer 是原子提交形状——一条命令一次 revision、拒绝路径绝不改状态、`MAX_STEPS_PER_DISPATCH` 断路器、按 `commandId` 幂等的重放缓存。契约 fixture 断言的是投影出的 DomainEvent 与里程碑而非内部结构，测试高度合适。
- **两套效果系统的边界是结构性的，不靠口头约定**：combat-v3 不 import `script-executor` / `game-event` / `subscription-manager`，全仓 grep 证明内核内部到任意 JS 没有通路；automata DSL 也不是过度设计——`char-gen-agent.ts:802-842` 与 item/skill/inventory 的四处透传证明 AI 写的 automata 确实流进 `compileEffectProgram`，7 个契约 fixture 覆盖召唤/免死/反射路径。
- **`database.ts` 的数据安全语义写得扎实，注释保留了「为什么」**：v14/v15/v16 导入的三态区分（`undefined` 保留整表 / `[]` 才 clear，751-797）、`importAllData` 的预备份 + 回滚（664-684）、`validateBackupOrThrow`（629）、`deleteSaveSlot` 的级联事务（1077）、`trimSnapshots` 的阶梯淘汰 + 最近 5 轮铁律保护（989-1049）。Q-26 只针对 schema 重述的机械噪音，刻意不碰这部分。
- **ADR-21 的状态写入纪律经反证成立，类型逃逸没有走 `@ts-ignore` 这条捷径**：搜 `commitChatState` / `updateProfile` / `markNewsRead` / `saveCharacters` / `db.*.put` 的未 await 调用，零命中；唯一的 fire-and-forget（`game-store.ts:644/658` 的 `persistMessage`）自带 try/catch + 空 saveId 拒写并注明理由。全仓 `@ts-ignore` / `@ts-expect-error` 0 次，非空断言在引擎侧只有个位数，逃逸集中在 `as any` 且高度聚集于两个游戏面板组件。
- **`workshop-client.ts` 的「永不抛穿」在新增的 P4 写侧同样均匀**：所有网络出口收在 `fetchJson` 一个漏斗（`:735`）：fetch 抛错 / 响应不可读 / `!res.ok` / `text()` 失败 / `JSON.parse` 失败五条分支各返判别联合，finally 里 dispose 超时守卫；`createProject` / `updateProject` / `setProjectVisibility` / `deleteProject` / 上传三口 / 审核五口没有一处 throw。
- **前端有一份真正可执行的设计规范，且减少动态比文档写得还好**：`docs/design.md` 有字号层级、`--theme-spacing-*` token、「绝对禁令」表与 §8 检查清单；`themes/variables.css:139` 的全局 `prefers-reduced-motion` 块附带「为何归零 `animation-delay` 而不用 `animation: none`」的论证，并由 `:root[data-reduced-motion]` 镜像，`lib/reduced-motion.ts` 是唯一 JS 判据（刻意不依赖 Pinia 以便测试）。`AppModal` 被 19 个组件复用，201 个 `v-for` 全部带 `:key`。

## 本轮的覆盖缺口

审查者自陈的未覆盖面，列出以免这份报告被当成「全仓已清点完毕」：

- **全程只读，所有「零引用」结论来自 grep 而非构建工具**。未在审查过程中跑 build/bundle 分析。Q-01 的骰子结论纯由读代码得出——**建议先真机打一场确认现象再动手**。未跑 wasm 验证 QuickJS 与 Legacy 的实际渲染差异。Q-28 的 319 条主题选择器只证明「不受任何契约约束」，未逐条验证是否仍匹配活 DOM。
- **三处大文件与一个高复杂度函数未读透**：`types.ts` 3716 行只读了 export 清单与关键段（拆分前需再核对跨域引用）；`start-catalog.ts` 8600 行数据只抽样头尾，未与世界书数值表对账（属 `audit-code` workflow 职责）；`reducer.ts:500-919`、automata 的 parser/interpreter、`projection-ui`、`adjudication` 内部未逐行读。
- **`plot-outline.ts` 的 `parseOutlineXml`（226-406，180 行手写正则状态机）被判定复杂度偏高**，可能与 `parseOutlineJson` 构成第二条解析路径，但未读透到能给出重构切线，**建议单独安排一次审查**。
- **207 个测试文件只抽样约 14 份**，CI 无 coverage 配置，因此「测试覆盖是否充分」这一问题本轮无法回答，只能回答「哪些模块完全没有 sibling 测试」。

## 归并记录

70 条原始 finding 归并为 31 条。合并遵循一个判据：**如果两条应该在同一个 PR 里修，就合并**。分开列会让同一个 PR 被拆成多条待办，反而降低这份报告的可执行性。

| 最终 ID | 合并了                                         | 合并理由                                                                           |
| ------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Q-04    | WB-04、XCUT-03、CMBT-04、AGENT-07、AGENT-03    | 同属「退役时只断引用不删文件」，删除动作彼此无依赖，可在同一个 PR 做完             |
| Q-05    | AGENT-02、XCUT-02、AGENT-04、CORE-10、AGENT-09 | 同一件事的五个切面，系统性原因同为「模型输出没有共享解析缝」                       |
| Q-07    | CMBT-03、CMBT-02                               | 同一形状的两层，需要同一次「接线还是删除」的裁定                                   |
| Q-08    | STORE-02、XCUT-01                              | 指的是同一段被复制的六步迁移                                                       |
| Q-09    | WB-01、WB-02、WB-06、WB-05                     | 同为「沙盒契约在 TS 与 guest 字符串两侧各记一份」，修法都是从一份 manifest 生成    |
| Q-10    | WB-03、WB-07                                   | 同为 `LegacyBackend` 退役未竟的遗产，同一个退役 PR 一并处理                        |
| Q-11    | UI-02、XCUT-04、UI-06                          | 同为 7 级品质体系的多真源问题                                                      |
| Q-12    | CORE-03、CORE-06                               | 僵尸宿主存在的唯一后果就是让同名函数陷阱留在仓库里，删除与去重是同一个动作         |
| Q-14    | AGENT-06、STORE-06、AGENT-10                   | 同为「失败回执与日志没有统一口径」的三个位置                                       |
| Q-15    | XCUT-05、XCUT-08                               | 同为仓库与工具链卫生，都是纯配置/清理动作                                          |
| Q-16    | STORE-08、XCUT-07、XCUT-11、STORE-09           | 同为「store 层没有共享工具层，靠人记忆维持不变式」                                 |
| Q-18    | STORE-03、UI-05、UI-04                         | 同为设置面缺类型导致的连锁，一次建类型即可同时解决                                 |
| Q-19    | AGENT-01、CORE-09                              | AI→状态写入链上前后相邻的两个无缝巨型函数，抽 seam 时必须一起看                    |
| Q-20    | STORE-10、UI-08、XCUT-09、XCUT-06、XCUT-10     | 同属测试底盘账目，一次性整理更划算                                                 |
| Q-21    | CMBT-05、CMBT-09、CMBT-08、CMBT-10             | 同属战斗/制作结算层的复制与焊死                                                    |
| Q-22    | CMBT-06、CMBT-07                               | 同为 combat-v3 公共面上的装饰性字段，同一次签名收敛即可                            |
| Q-23    | CORE-04、CMBT-11                               | 同一条边界的两端：约定与实际反向依赖                                               |
| Q-25    | UI-01、UI-07                                   | 同为「组件承担无关职责」，抽取模式已被 `AudioSection` / `AssetSection` 证明        |
| Q-29    | STORE-01、STORE-04、STORE-07                   | 因果关系的两端：正因为没有可复用的装配出口，装配才被抄了第二份，拆 seam 必须一起动 |

**唯一被判为过于表层而剔除的原始 finding**：UI-09（关于分区硬编的引擎统计，测试数差约 800、版本与构建日期是冻结文案）。问题属实，但修法只是改成构建期注入，顺手在 Q-25 的 `SettingsPage` 拆分里做掉即可，单列会占掉一条名额而不带来任何排序信息。
