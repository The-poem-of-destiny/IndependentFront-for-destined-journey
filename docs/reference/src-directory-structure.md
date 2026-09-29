# src 目录与模块归属

`src/` 按运行层划分：`core/` 为独立引擎，`ui/` 为 Vue 前端。`env.d.ts`
保留在根目录，承载构建环境声明。自动化测试统一放在独立的 `tests/` 目录。

## 引擎目录

`src/core/index.ts` 保留为公共导出入口。实现文件按职责放入下列目录。

| 目录             | 职责                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| `agents/`        | Agent 客户端、编排、工具、输出解析与角色/物品生成侧链                       |
| `api/`           | API 配置、协议适配、传输、连接工具与 RPM 限流                               |
| `prompts/`       | 提示词模板、预设、占位符、上下文可见性及 Delta 会话装配/投影/持久化适配     |
| `state/`         | 状态提交、存档写队列与 SaveProfile                                          |
| `persistence/`   | IndexedDB、单存档备份与新旅程创建                                           |
| `types/`         | 唯一类型来源 `types.ts` 及 `types-*.ts` 分册                                |
| `character/`     | 角色查询、外貌、血脉、属性分配、资源、经验、层级与校验                      |
| `combat/`        | 统一战斗内核、会话协调、阶段、EffectAutomaton DSL、基础规则、内容校验与投影 |
| `crafting/`      | 制作请求、侧链、DC、品质推导与结算                                          |
| `effects/`       | 事件、状态效果、订阅与效果接线                                              |
| `scripting/`     | 脚本执行、注册与 QuickJS 隔离后端                                           |
| `ejs/`           | 世界书 EJS 求值、能力、随机源与变量差量                                     |
| `content/`       | 内容来源、注册表、安装计划、世界书、开局目录与占位内容哈希清单              |
| `workshop/`      | 工坊清单、类型、安装计划、差异与正则映射                                    |
| `assets/`        | 素材路径、索引、解析、导入、哈希与远程素材目录                              |
| `audio/`         | 音频管理、声道、场景、名称与标签                                            |
| `image/`         | 图像提示词、方言、配额、分段与默认参数；后端适配器位于 `providers/`         |
| `map/`           | 位置目录、地图包、投影、寻路、天气、地块动态与上下文                        |
| `random-events/` | 随机事件包、调度、运行态、快照与上下文                                      |
| `plot/`          | 剧情引擎、大纲、角色计划与主线细化节点                                      |
| `memory/`        | 记忆存储、检索与摘要                                                        |
| `variables/`     | 变量命名空间、路径解析与 AI 补丁翻译                                        |
| `story/`         | 正文输出、救援、标记协议与美化                                              |
| `time/`          | 游戏时间与回合驱动时间账本                                                  |
| `runtime/`       | 引擎设置注入                                                                |
| `utils/`         | 通用骰子与模型 JSON 解析                                                    |

## 前端目录

沿用既有分类：`components/` 放页面及组件，`stores/` 放 Pinia 状态，`composables/`
放组合式逻辑，`lib/` 放应用服务，`utils/` 放辅助函数，`styles/`、`themes/`、`assets/`
放样式、主题与静态素材。`main.ts`、`App.vue` 是应用入口；`branding-defaults.ts` 是应用级默认配置。

## 新文件与引用约定

- 新文件放入所属职责目录，避免恢复引擎根目录平铺。已有目录能承载时直接复用。
- 同模块优先相对路径；前端引用引擎使用 `@engine/<目录>/<模块>`，例如
  `@engine/state/state-manager`、`@engine/types/types`。
- 类型继续统一在 `types/types.ts` 与分册定义；目录整理不引入第二份类型定义或兼容转发文件。
- 依赖方向仍为前端 → 引擎；注入缝、唯一状态写入口及持久化契约保持原有规则。
- 移动文件时同步更新 import/export、动态 import、mock、`import.meta.glob`、夹具引用、
  生成脚本输出路径、CODEOWNERS 与 Knip 已有问题的路径身份。Knip 基线迁移不得增加豁免项。
- 验证使用 `npm run gates`；文件归类不涉及存档 schema 或业务规则迁移。

## 独立测试目录

- `tests/core/<模块>/` 对应引擎模块；原 `__tests__/` 中的跨模块集成测试位于
  `tests/core/integration/`。
- `tests/ui/` 对应前端分类；既有 `tests/contract/` 与仓库级结构闸门继续保留。
- Vitest 仅发现 `tests/**/*.test.ts`，公共初始化为 `tests/setup.ts`。
- 引擎共享夹具位于 `tests/core/fixtures/`，战斗夹具位于
  `tests/core/combat/fixtures/`，音频测试替身位于 `tests/core/audio/audio-fakes.ts`。
- 战斗测试构造、回放 harness 与里程碑断言也位于 `tests/core/combat/`。
- 应用中可调用的测试存档与场景预览功能仍属于运行时代码，保留在 UI 的服务和工具目录；
  它们与 Vitest 测试、专用替身不同。
- 新测试与专用夹具不得放回 `src/`。类型检查由 `typecheck:tools` 覆盖独立测试目录；
  分层闸门同时检查引擎源码和独立引擎测试。
