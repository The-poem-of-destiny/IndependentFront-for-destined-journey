# 全仓库综合审查报告

> ⚠️ **本文已被 [`2026-08-01-repository-review.md`](2026-08-01-repository-review.md) 取代**（2026-08-18 标注）：
> 那份的 SEC-01..05 继承并追踪了本文的未决项。本文**没有自带的修复状态表**，
> 所以别拿这里的条目当「还没修」读 —— 修复状态以 08-01 及其后续审查为准。
> 本文保留为当时的审查记录。

## 1. 审查信息

| 项目     | 内容                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 审查日期 | 2026-07-27                                                                                                                          |
| 审查基线 | `242942f3277f483e66f13af5fa2b3ffdd60540b5`                                                                                          |
| 默认分支 | `master`                                                                                                                            |
| 仓库规模 | 529 个追踪文件，约 271,821 行新增内容                                                                                               |
| 审查范围 | 引擎、前端、数据层、Agent 编排、世界观规则对齐、安全、可靠性、性能、无障碍、响应式、测试、依赖、发布、许可与文档                    |
| 审查方式 | 静态代码审查、规范/规格双轴审查、可达性分析、精确安全探针、类型检查、构建、全量测试、依赖审计、npm 打包预检、桌面与移动端浏览器检查 |

## 2. 结论摘要

当前仓库不具备安全发布或接入真实付费 API 的条件。

本次审查确认 4 个发布阻断项：

1. 仓库提交并打包了一个非占位 API 密钥。
2. Agent 工具契约要求 UUID，但提示词按规范传入角色名称，正常制作流程可直接失败。
3. Agent 失败或中止后，游戏管线仍可能推进回合并保存快照。
4. 任意空对象备份都能触发全库清空，且导入无法原子回滚。

此外还确认了模型响应 XSS、两个不安全的 JavaScript 求值入口、开发服务器 SSRF/越界写、原型污染、中止竞态、制作结算不一致、持久骰池缺失、脚本生命周期未接通、移动端不可用、共享组件无障碍缺口、发布包失控和许可声明冲突等问题。

最紧急的行动是立即吊销并轮换 `tests/agent-framework/.api-config-siliconflow.json:3` 中的密钥。该密钥自提交 `f5c241c` 起存在于 Git 历史，且 `npm pack` 会将其收入发布包。本报告不会展示或验证该密钥。

## 3. 严重度定义

| 级别 | 定义                                                                     |
| ---- | ------------------------------------------------------------------------ |
| P0   | 发布阻断；可直接造成凭据泄露、数据毁损或核心流程失败                     |
| P1   | 高优先级；存在可达安全风险、可靠性缺陷、关键规格违约或主要用户路径不可用 |
| P2   | 中优先级；影响维护性、发布质量、测试可信度或次要功能                     |
| P3   | 低优先级；已知未完成项或非阻断型完善工作                                 |

## 4. P0 发布阻断项

### P0-01：真实 API 密钥已提交并进入发布包

证据：

- `tests/agent-framework/.api-config-siliconflow.json:3` 存在一个非占位、51 字符的 `apiKey`。
- 文件从提交 `f5c241c` 起进入 Git 历史。
- 当前树的 secret-like 扫描只发现该文件。
- `npm pack --dry-run` 明确将该文件收入包内容。
- `.gitignore` 只忽略 `.api-config.json`，没有覆盖 `.api-config-siliconflow.json` 等变体。

影响：

- 任何拥有仓库、历史或发布包访问权限的人都可能使用该凭据。
- 可能造成额度消耗、费用、配额耗尽或提供商侧数据访问。

建议：

1. 立即在提供商控制台吊销并轮换该密钥。
2. 从当前树和全部 Git 历史清除密钥。
3. 仅提交 `.example` 配置。
4. 增加 pre-commit 与 CI secret scanning。
5. 使用 `package.json.files` 或 `.npmignore` 建立发布白名单。

### P0-02：角色名称与 UUID 契约断裂

证据：

- `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md:16-18` 要求 AI 只使用名称，UUID 不进入 Agent 契约。
- `src/sillytavern/agent-tools.ts:94-131,175-189,295-328` 的 schema 要求 `characterId`。
- `src/sillytavern/agent-tools.ts:443-459,506-520,589-639` 只按 `CharacterState.id` 查找角色。
- `data/defaults/agent-config.json:1955` 的正常示例传入名字“理查德”。

影响：

- 制作、物品与角色相关工具会在正常提示词输入下返回“未找到角色”。
- 工具 schema、系统提示词、执行器和数据规范互相矛盾。

建议：

- 统一对外名称契约，在 Code 层集中完成名称到 ID 的解析。
- 禁止 Agent 工具返回内部 ID。
- 为同名角色建立显式消歧规则。
- 增加覆盖提示词示例的端到端工具测试。

### P0-03：失败或中止的回合仍可能被提交

证据：

- `docs/fated-poem-engine-prd.md:141-142` 要求 Agent 失败不阻塞，并使用 1/2/4 秒重试和备用端点切换。
- `src/sillytavern/agent-orchestrator.ts:643-654` 会因上游失败跳过 Story。
- 流式调用路径没有同等重试保证。
- `src/ui/lib/game-pipeline.ts:191-208` 忽略 `OrchestratorRun` 结果并继续 `advanceTurn`、保存状态和快照。
- `src/ui/lib/game-pipeline.ts:312-315` 在旧管线完全停止前立即解除 `isGenerating`，允许新一轮进入。

影响：

- 玩家输入可能被消耗，但没有有效助手回复。
- 中止后仍可能提交部分状态、推进回合或生成快照。
- 新旧管线可竞争共享 controller、context、pending task 和 UI 状态。

建议：

- 引入 run generation token 或互斥锁。
- 仅在当前 token 的必需阶段成功后推进回合。
- Abort 后保持 UI 锁定，直到旧运行完全 settle。
- 为失败、重试、中止和快速重发建立集成测试。

### P0-04：空备份可清空数据库，导入无法原子回滚

证据：

- `src/sillytavern/database.ts:402-405` 只验证输入是否为对象，因此 `{}` 合法。
- `src/sillytavern/database.ts:409-465` 会清空全部数据表。
- 导入分为六个独立事务；后段失败时，前段已经永久替换。
- `src/ui/components/settings/SettingsPage.vue:1284` 将该行为描述为“合并到现有数据库”，与实际全量替换相反。

影响：

- 空文件、错误文件或部分损坏备份可删除全部本地数据。
- quota、结构错误或 IndexedDB 异常可留下半恢复状态。

建议：

- 导入前完整验证版本、必需字段、实体关系和数组结构。
- 先在内存或临时数据库中完成 staging。
- 在一个可回滚事务边界内执行替换。
- 导入前自动生成可恢复备份。
- UI 明确说明这是“替换”而不是“合并”。

## 5. 安全与隐私

### P1-01：默认模型消息渲染存在存储型与流式 XSS

证据：

- `src/ui/stores/settings-store.ts:162` 默认启用 beautifier。
- `src/sillytavern/beautifier.ts:258-280` 从原始模型文本开始处理，未匹配 HTML 保持不变。
- `src/ui/components/game/ChatFlow.vue:261` 和 `:314` 使用 `v-html` 渲染存储与流式模型输出。
- 精确探针输入 `<img onerror=...>` 后，`processRules` 原样返回恶意标签。
- `src/ui/stores/settings-store.ts:175-227` 同源 `localStorage` 中保存原始 API 密钥。

影响：

- 恶意或被提示注入的模型响应可执行应用同源 JavaScript。
- 可读取 API 密钥、存档、IndexedDB，并调用开发代理访问本地网络。

建议：

- 先对全部模型文本做 HTML escaping。
- 只将可信内置替换规则生成的片段标记为 HTML。
- 最终输出经过严格 allowlist sanitizer。
- 禁止事件属性、脚本、SVG、活动 URL 和危险 style。
- 增加存储与流式 XSS 回归测试。

### P1-02：两个 JavaScript“沙箱”允许访问全局环境

证据：

- `src/sillytavern/script-executor.ts:108-117` 使用 `new Function` 注入白名单参数，但未隐藏 `globalThis`、`window`、`document`、`fetch`、IndexedDB 或 localStorage。
- 精确探针成功从 `executeScript` 修改 `globalThis`。
- `src/sillytavern/state-manager.ts:1333-1343` 在状态过期路径执行持久化 hook。
- `src/sillytavern/plot-engine.ts:37-51` 使用 `new Function` 执行剧情条件。
- `src/sillytavern/plot-outline.ts:512` 将模型生成的 `triggerHint` 保存为可执行 `triggerCondition`。

影响：

- 有效持久化脚本或模型生成的剧情条件可以执行任意同源 JavaScript。
- 参数遮蔽并不构成安全沙箱。

建议：

- 使用声明式 DSL 或白名单 AST 解释器。
- 禁止任意 JavaScript 求值。
- 在迁移完成前禁用脚本执行和动态剧情条件。

### P1-03：开发服务器暴露 SSRF 和越界文件写

证据：

- `vite.config.ts:77-100` 接受任意 HTTP/HTTPS 目标。
- 实际探针通过 `/api/proxy` 成功获取 localhost 应用。
- `vite.config.ts:29-43,54-66` 的写入接口只拒绝 `..`。
- Windows 绝对路径经过 `path.resolve` 后可逃离 `data/worldbooks` 或 `data/defaults`。
- 接口没有认证、Origin 校验、请求大小限制和 JSON schema 验证。

影响：

- 可探测开发机内部服务。
- 可向项目目录或其他可写位置写入任意内容。
- 与模型 XSS 组合后，同源攻击代码可直接读取代理响应。

建议：

- 将控制接口从常规 Vite server 移除。
- 使用固定文件名 allowlist 和 canonical containment 检查。
- 拒绝私有、loopback 和 link-local 目标，并在 DNS 解析后再次校验。
- 增加认证、同源保护和 body 上限。

### P1-04：模型控制的变量路径可触发原型污染

证据：

- `src/sillytavern/agent-orchestrator.ts:729-752` 将 Dispatcher 路径传入变量补丁。
- `src/sillytavern/var-resolver.ts:33-47` 接受任意路径段。
- `src/sillytavern/var-resolver.ts:82-104` 遍历继承属性并写入目标。
- 精确探针通过 `sys.__proto__.x` 在新对象上观察到污染属性。

建议：

- 在所有路径读写入口拒绝 `__proto__`、`prototype` 和 `constructor`。
- 只遍历 own property。
- 可变字典使用 null prototype。
- 在 StateManager 层再次执行统一路径校验。

### P1-05：API 密钥存储与系统命名空间保护不符合 PRD

证据：

- `docs/fated-poem-engine-prd.md:185-188` 要求密钥存 IndexedDB，且 AI 不可写 `sys.*`。
- `src/ui/stores/settings-store.ts:171-181,224-228` 将完整 settings，包括密钥，序列化到 localStorage。
- `src/sillytavern/state-manager.ts:359-375` 未拒绝 `sys.*` 路径。

影响：

- 任意同源 XSS 都能同步读取全部 API 密钥。
- Agent 可越过系统命名空间边界。

建议：

- 将 API 凭据迁移至独立 IndexedDB 表，并避免进入通用 settings JSON。
- 对导出、日志和 UI 状态实施脱敏。
- 在唯一状态入口执行命名空间权限控制。

## 6. 数据完整性与可靠性

### P1-06：快照恢复同样缺少原子性

`src/sillytavern/state-manager.ts:1229-1269` 顺序恢复角色、档案、剧情、消息、记忆和存档；任一后段错误都会留下部分恢复状态。恢复前应完整验证、创建回滚点并使用统一事务。

### P1-07：制作结算结果与实际补丁不一致

证据：

- `src/sillytavern/craft-resolver.ts:202-215` 为失败制作计算受保护的部分材料损失。
- `src/sillytavern/craft-resolver.ts:331-342` 构造补丁时删除完整请求数量。
- `src/sillytavern/state-manager.ts:668-685` 未在删除前验证库存总量。
- `src/sillytavern/agent-tools.ts:536-554` 返回计划补丁数而非实际 `patchesApplied`。
- `src/sillytavern/craft-gen-chain.ts:473-479` 将 FP 写入普通变量路径，而非 `SaveProfile.fp`。

建议让确定性 settlement 成为材料与奖励的唯一来源，在提交前验证完整库存事务，并返回真实 commit 结果。

### P1-08：最新剧情大纲存在毫秒级排序竞态

证据：

- `src/sillytavern/database.ts:786-788` 每次保存都用 `Date.now()` 覆盖 `updatedAt`。
- 同一毫秒连续保存会产生并列时间戳。
- `src/sillytavern/database.ts:777-783` 只按 `updatedAt` 排序，并列时可返回旧记录。
- 全量测试实际返回“旧版”，目标测试单独运行时通过。

建议使用单调版本、复合排序键或数据库生成的严格顺序字段。

### P1-09：StateManager 唯一写入入口被 UI 绕过

- `src/ui/components/game/QuestsPanel.vue:15-20` 直接修改并保存 `SaveProfile`。
- `src/ui/components/game/ScenePanel.vue:121-133` 直接修改新闻状态并持久化。

该路径绕过 StateManager 的事件、验证和原子边界。应增加语义级 patch op，或在 ADR 中明确并约束例外。

## 7. 规格与世界观规则对齐

### P1-10：持久 60 枚 d20 骰池未实现

- `reference/world_book_index.md:375-380` 要求预生成 60 枚并严格按顺序消耗。
- `reference/audit_report.md:22-26` 将其列为关键修复。
- `src/sillytavern/dice.ts:18-25`、`combat-resolver.ts:140`、`craft-resolver.ts:661-663` 仍调用 `Math.random()`。

这破坏了可复现性、存档回滚一致性与世界书规则。

### P1-11：脚本生命周期被标记完成，但生产链路未接通

- `docs/ARCHITECTURE.md:356-357` 声明脚本生命周期与持久订阅完成。
- `src/sillytavern/char-gen-agent.ts:1018-1083` 保存脚本文本但不生成 hook 引用。
- `executeInit`、`executeCleanup` 和 `SubscriptionManager` 没有生产调用。

应完成完整 wiring 和集成测试，或撤回文档中的“已完成”状态。

### P2-01：SillyTavern 角色卡兼容声明失实

`README.md:102-107` 声明支持世界书、预设和角色卡格式，但 `src/sillytavern/importer.ts:43-164` 只实现世界书和预设。

## 8. 前端 UI、无障碍与性能

### 8.1 评分

| 维度          |  分数 | 结论                               |
| ------------- | ----: | ---------------------------------- |
| Accessibility |   2/4 | 共享组件语义与键盘支持不足         |
| Performance   |   2/4 | 游戏页首包过大，面板同步加载       |
| Responsive    |   1/4 | 设置页与游戏页在手机宽度不可用     |
| Theming       |   3/4 | 主题令牌、对比度和减弱动画支持较好 |
| Anti-patterns |   3/4 | 视觉身份清晰，但卡片和模态层偏重   |
| 总分          | 11/20 | 视觉基础良好，需要结构性 hardening |

界面具有清晰的暗色奇幻身份、克制的视觉层级和一致主题，没有明显的通用 AI 模板感。

### P1-12：关键页面缺少移动端适配

- `src/ui/components/settings/SettingsPage.vue:1385-1405` 固定 180px 主导航、170px 子导航和 40px 内容边距；390×844 视口中正文被压成逐字换行。
- `src/ui/components/game/GamePage.vue:247` 强制 `min-width: 900px`，移动端必然横向溢出。
- `src/ui/components/create/CreateSteps.vue:47-55` 对超宽步骤条使用居中 flex，当前步骤可落到负向不可滚动区域。
- CreateSteps 的已完成步骤呈现 pointer 光标和可聚焦状态，但没有点击处理器。

### P1-13：共享组件存在系统性无障碍缺口

- `src/ui/components/shared/AppCard.vue:13-23` 始终渲染 `div`，可点击难度/选择卡没有 button 语义、键盘处理或 focus 状态。
- `src/ui/components/shared/AppModal.vue:43-56` 缺少 `role="dialog"`、`aria-modal`、焦点捕获、初始焦点、焦点返回和背景 inert。
- `src/ui/components/shared/form/FormInput.vue:21-44` 的 label 未通过嵌套或 `for`/`id` 关联输入控件。
- Tabs 缺少 tablist/tab/aria-selected 与方向键行为。
- Toast 没有 `aria-live` 或 status/alert 语义。

### P1-14：生产构建保留测试与调试入口

- `src/ui/components/home/HomePage.vue:93-98,196-200` 在悬停后显示快速测试按钮，可创建测试存档。
- `src/ui/components/game/GamePage.vue:73-117` 暴露 `window.__injectChatFlowTest__`、`Ctrl+Shift+T` 测试数据注入和调试面板。
- `src/ui/components/game/GamePage.vue:7` 同步导入生产 test fixtures。

这些入口没有 `import.meta.env.DEV` 保护，可污染真实存档并增加包体。

### P1-15：游戏页 JavaScript chunk 过大

生产构建生成 641.75 kB 的 GamePage JavaScript chunk。`src/ui/components/game/GamePage.vue:9-24` 同步导入全部模态面板、地图、调试面板和播放器。应使用异步组件按需加载非首屏面板，并移除生产 fixture。

正面项：

- 全局存在 `:focus-visible`。
- 实现 `prefers-reduced-motion`。
- 10 套主题共享语义令牌。
- 抽样桌面页面未发现低于 4.5:1 的正文对比度。
- 首页与设置页桌面视觉层级清晰。

## 9. 架构与可维护性

### P1-16：类型单一来源规则未落实

项目规范要求 `types.ts` 是唯一类型来源，但许可文件之外仍有约 86 个导出类型，分布在 `agent-client.ts`、`craft-gen-chain.ts`、`script-executor.ts` 等模块。`types.ts:7` 还反向导入 `time-system.ts:14` 的 `GameTime`，形成方向倒置。

### P1-17：安全关键生产模块缺少直接测试

至少 12 个生产模块没有规定的同名测试，包括：

- `agent-tools.ts`
- `beautifier.ts`
- `importer.ts`
- `stream-parser.ts`
- `vars-merger.ts`

其中 beautifier、importer 和 agent-tools 已在本次审查中出现 P0/P1 缺陷。

### P2-02：重复解析逻辑形成 shotgun surgery

`src/sillytavern/char-gen-agent.ts:1092-1175` 与 `craft-gen-chain.ts:623-675` 分别复制 XML/JSON 提取与容错逻辑，且行为不同。协议变化必须多点同步。

### P2-03：create-store 与 SettingsPage 承担过多职责

- `src/ui/stores/create-store.ts` 同时负责目录选择、AI 大纲调用、建档、草稿和预设。
- `src/ui/components/settings/SettingsPage.vue` 超过 100 kB，包含多个设置域、导入导出、API 管理、Agent 编辑与复杂样式。

建议按创建状态、剧情服务、持久化服务和设置域拆分，同时保持 StateManager 等深模块的稳定接口。

### P2-04：异步 Dexie 写入未等待并吞错

`src/ui/components/settings/SettingsPage.vue:567` 使用动态 import 的 Promise 链写入 Dexie，没有 `await`，并以空 catch 吞掉错误。刷新或页面销毁时可能丢失恢复的预设。

## 10. 测试与构建

### 10.1 实际结果

| 命令                 | 结果                                     |
| -------------------- | ---------------------------------------- |
| `npm run typecheck`  | 通过，TypeScript 0 错误                  |
| `npm run build`      | 通过，存在大 chunk 与混合导入警告        |
| `npm run test:run`   | 3332/3334 通过，81/83 测试文件通过       |
| 两个失败文件定向复测 | game-store 通过；SelectableCard 稳定失败 |

### 10.2 失败分析

1. `src/ui/stores/game-store.test.ts:239` 在全量运行中返回旧大纲，根因是 P1-08 的毫秒级时间戳并列。
2. `src/ui/components/create/SelectableCard.test.ts:97` 仍断言旧的 `#9c27b0`，组件已迁移到 `var(--theme-quality-epic)`；这是稳定的陈旧测试。

测试环境还持续输出 jsdom 未实现媒体播放与 canvas context 的噪声，建议统一 mock，避免真实错误被大量控制台输出淹没。

## 11. 依赖与供应链

`npm audit` 当前报告：

- 全部依赖链节点：17 个 high。
- `--omit=dev`：7 个 high。
- 主要根源是 PostCSS source map 路径遍历和 brace-expansion DoS 公告。

参考：

- <https://github.com/advisories/GHSA-r28c-9q8g-f849>
- <https://github.com/advisories/GHSA-3jxr-9vmj-r5cp>
- <https://github.com/advisories/GHSA-mh99-v99m-4gvg>

审计数字包含依赖链传播，不代表 17 条独立可利用路径，但必须在发布前逐项确认运行时可达性、升级路径和锁文件状态。

## 12. 发布、许可与仓库卫生

### P1-18：npm 发布配置不可用

`npm pack --dry-run` 结果：

- 469 个条目。
- 约 291.2 MB。
- 包含真实密钥、源码、测试、临时文件、备份、crash dump 和全部音频。
- 不包含 `package.json.main` 指向的 `dist/sillytavern/index.js`。
- 当前工作树中的非追踪文件也会因缺少白名单而被考虑进入包。

`package.json` 缺少：

- `files` 白名单。
- `prepack`/`prepublishOnly` 构建和验证。
- 与实际应用/引擎发布方式一致的 exports/types 元数据。

### P2-05：许可声明冲突

- `package.json:22` 声明 ISC。
- `README.md:133` 声明 `src/` 为 MIT。
- 仓库根目录没有对应 LICENSE。
- README 的世界观授权链接指向根目录，但实际文件位于 `docs/《命定之诗》内容二创与素材使用授权协议.md`。

在发布、接受贡献或复用代码前必须统一代码许可并提供真实 LICENSE 文件。

### P2-06：缺少持续集成和静态质量门

仓库没有 `.github` CI 配置，也没有 lint、format、coverage 或 secret scanning 脚本。当前 3334 项测试只能依赖开发者本地主动运行。

### P2-07：追踪了大量临时与备份文件

仓库追踪 61 个 `tmp/`、`.bak` 或 crash dump 文件，包括：

- `bash.exe.stackdump`
- `data/defaults/agent-config.json.bak`
- 多个 `tmp/agent-config.pre-*.bak`
- 大量一次性迁移、修复和检查脚本

这些文件同时扩大 npm 包、增加审查噪声，并可能保留历史敏感内容。

### P3-01：产品路线仍存在明确占位项

- `src/ui/components/workshop/WorkshopPage.vue:7` 仍是 Phase 7f 占位页面。
- Phase 7g 和 Phase 9c 在进度表中未完成。
- README 明确将当前版本标记为开发版。

这不是意外回归，但意味着产品尚不满足公开发行的完整性要求。

## 13. 正面观察

1. TypeScript strict 模式已启用。
2. 83 个测试文件覆盖大量核心数值与流程逻辑。
3. StateManager 是清晰且有价值的统一状态写入深模块，主要问题是少数绕过路径。
4. 战斗、制作、时间、血脉和资源计算大多以纯函数组织。
5. 核心层级数值、10 势力位置数据和大部分世界书映射已经对齐。
6. Agent Orchestrator 的阶段顺序和同阶段并行总体符合架构。
7. 删除存档、音频 metadata/blob/list 等局部数据库操作已经使用原子事务。
8. 前端主题系统、视觉身份、减弱动画和桌面层级具有良好基础。

## 14. 建议整改顺序

### 第一阶段：立即止血

1. 吊销并轮换泄露密钥。
2. 清理 Git 历史并增加 secret scanning。
3. 暂停发布和真实 API 使用。
4. 禁用模型 `v-html`、`new Function` 脚本与动态剧情条件。

### 第二阶段：安全与数据边界

1. 修复 XSS、原型污染、开发 SSRF 与越界写。
2. 为导入和快照恢复增加完整验证、预备份与原子事务。
3. 将 API 密钥迁移出 localStorage。
4. 在 StateManager 强制 `sys.*` 权限和危险路径拒绝。

### 第三阶段：核心流程正确性

1. 统一名称到 ID 的 Code 层解析。
2. 修复失败/中止管线的回合推进与竞态。
3. 实现持久骰池。
4. 修复制作材料和 FP 结算。
5. 接通或撤回脚本生命周期。

### 第四阶段：用户体验与工程质量

1. 适配 Settings、Create 和 Game 移动端。
2. harden 共享 Modal、Card、Form、Tabs 与 Toast。
3. 移除生产测试钩子并拆分 GamePage chunk。
4. 修复全量测试、补齐安全关键模块测试。
5. 建立 CI、lint、coverage、dependency audit 与 secret scan。

### 第五阶段：发布治理

1. 确立 Web 应用、桌面应用和引擎库的独立发布边界。
2. 配置 npm 文件白名单和发布前验证。
3. 统一 MIT/ISC/世界观内容许可。
4. 清理临时文件、备份和 crash dump。
5. 完成 Workshop、Phase 7g 和 Phase 9c。

## 15. 审查限制

- 未调用或验证任何真实 API 密钥。
- 未执行会产生费用的远程 Agent 真机流程。
- 未进行长期负载、内存泄漏、弱网或跨浏览器矩阵测试。
- 未对部署后的服务器、CDN、域名、安全响应头或桌面安装包进行渗透测试。
- 无障碍检查包含静态语义、键盘路径与真实浏览器布局，但不等同于完整屏幕阅读器认证。

这些限制不影响本报告中已通过代码路径、实际构建、测试输出和精确探针确认的问题。
