# 命定之诗

> AI 驱动的文字角色扮演游戏 · 兼容 SillyTavern 生态
>
> 你创造角色，引擎保证规则，AI 编织故事，世界自行运转。

<!-- TODO: 放 1-2 张游戏内截图（捏人页 / 游戏页叙事+状态栏），能极大提升吸引力 -->

---

## 快速开始

### 方式一：下载 Release（推荐 · 待发布）

桌面安装包（Windows 可执行文件，双击即玩，无需 Node.js）正在准备中。发布后可从 [Releases 页](../../releases) 下载。

> 在此之前，请用方式二从源码运行。

### 方式二：从源码运行（当前可用）

**前置**：[Node.js](https://nodejs.org/) 20.19+（Node 20 仅保留依赖兼容范围；推荐仍受上游支持的 Node 22.23+ 或 24+）和 npm 10.9.3

```bash
# 1. 下载源码
git clone https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey.git
cd IndependentFront-for-destined-journey

# 2. 按锁文件安装依赖
npm ci

# 3. 启动开发服务器
npm run dev
```

启动后浏览器自动打开 `http://localhost:5173`。

`npm run dev` 在 Windows / macOS / Linux 上通用（按平台自动转发到 `dev.bat` 或 `dev.sh`，
两者都会自动清理旧进程并固定端口启动）。也可以直接运行对应平台的启动器：Windows 双击
`dev.bat`，macOS / Linux 执行 `bash dev.sh`。

---

## 首次游玩配置（重要）

启动后先进入**设置页**，完成以下配置才能正常游玩。

### 1. 创建 2 个 AI API（必须 ⚡）

游戏需要 2 个 API：一个 DeepSeek（负责全部 Agent 的叙事与判断）+ 一个 Embedding（记忆召回）。

**设置页 → 🔌 API 配置 → + 添加 API**，依次创建：

**① DeepSeek**（主力 · 所有 Agent 都用它）

- 名称：`deepseek-flash`
- Endpoint：`https://api.deepseek.com`
- API Key：在 [DeepSeek 平台](https://platform.deepseek.com/) 注册后获取
- 默认模型：`deepseek-flash`

> 📌 名字虽然叫 `deepseek-flash`，用的其实是 **v4.1-flash** 模型。

**② Embedding 模型**（记忆召回 · 硅基流动）

- 名称：随意，如 `siliconflow-embedding`
- Endpoint：`https://api.siliconflow.cn/v1`
- API Key：在[硅基流动](https://cloud.siliconflow.cn/)注册后获取
- 默认模型：`Qwen/Qwen3-Embedding-8B`

每个创建后点「**连接测试**」确认通过。配完 API 列表应有 **2 个**。

> 也支持任何 OpenAI 兼容的 API（OpenAI 官方、Kimi、智谱、本地 Ollama 等），上述只是推荐组合。

### 2. 绑定模型（必须）

**① Agent 模型**：**设置页 → 🤖 Agent 配置**，把各 Agent 的「API 池选择」都选 **deepseek-flash**（默认全部用同一个池）。

> 💡 只想给正文换更强的模型时，单独改 `正文生成` 那个 Agent 即可。

**② 记忆召回**：**设置页 → 🧠 记忆 & 缓存**，召回模式选「Embedding 语义召回」，再在「**Embedding 源**」里选择上面创建的 Embedding。

> 📌 记忆召回已不再在 Agent 配置里绑定，挪到了「记忆 & 缓存」的「Embedding 源」。

### 3. 更新内容包（建议）

公开仓库只带**演示级占位内容**；完整的世界书、Agent 提示词、预设与目录通过**内容包**下发。

**设置页 → 💾 存档数据 → 内容包 → 点「检查更新」**，有新版时再点「**更新到 x.y.z**」。

### 4. 按需调整正文预设（可选）

**设置页 → 🤖 Agent 配置 → 正文生成 → 预设管理**：用开关启用 / 停用条目，或点条目上的铅笔（编辑）按钮自行修改提示词，以适配自己的配置。

---

## 开始游戏

配置完成后回到**首页**，按游戏内引导创建角色、生成剧情、进入游戏即可。

> 打字即游玩——在输入栏写出你的行动，AI 和引擎会一起回应。没有选项按钮限制你。

---

## 特性

- 🎭 **多 Agent 协作引擎**——10+ 个专职 Agent（叙事/记忆/剧情/战斗/制作/角色生成…）按 DAG 编排，各司其职
- ⚔️ **完整游戏系统**——T1→T7 力量层级、7 级品质、23 血脉、10 势力；战斗（8 步伤害管线）/ 制作（DC+骰检）/ 集群 / 士气 / 好感度
- 🌍 **开放世界剧情**——大事件 + NPC 议程去中心化演化；主角自由介入，粉碎一条议程线会涌现新的权力真空与势力博弈
- 🎨 **叙事优先 UI**——Vue 3 前端，10 主题，叙事正文是视觉主角，面板退后服务
- 🗺️ **地图系统**——真实地块 / 混合通行图寻路 / 路线与天数预览 / 天气，位置在叙事里说得通也走得通
- 🎲 **随机事件**——引擎按概率逐天掷骰产出候选事件，AI 在叙事方便的时机自然演绎，不打断节奏
- 🖼️ **情景插画**——NovelAI 云端或 ComfyUI 本地出图，插画就地嵌进正文，出过的图进 CG 图鉴
- 🛠️ **创意工坊**——浏览 / 安装 / 更新社区世界书与内容包，支持点赞订阅
- 🔌 **SillyTavern 兼容**——支持世界书 / 预设格式，可导入既有生态资源（角色卡导入尚未实现）
- 💾 **本地存档 & 互传**——IndexedDB 本地存储，存档在你自己的机器上；单存档可导出导入，换机迁移不丢进度

---

## 文档

| 文档                                                                               | 给谁             | 内容                                            |
| ---------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------- |
| [AGENTS.md](AGENTS.md)                                                             | 开发者 / AI 助手 | 指令正文：架构约定、命令、规范、进度（最全）    |
| [src/core/AGENTS.md](src/core/AGENTS.md)                                           | 引擎开发         | 引擎层架构分册（类型 / 数据库 / Agent / 战斗…） |
| [src/ui/AGENTS.md](src/ui/AGENTS.md)                                               | 前端开发         | 前端架构分册（stores / 组件 / 设置页 / 预设）   |
| [CLAUDE.md](CLAUDE.md)                                                             | Claude Code      | 薄壳：导入 AGENTS.md + skills / workflows 用法  |
| [CHANGELOG.md](CHANGELOG.md)                                                       | 玩家             | 面向玩家的更新日志                              |
| [PRODUCT.md](PRODUCT.md)                                                           | 产品 / 设计      | 用户画像、品牌、设计原则                        |
| [docs/](docs/)                                                                     | 深度阅读         | PRD、架构文档、Phase 计划、设计规范             |
| [docs/design.md](docs/design.md)                                                   | 前端开发         | 排版 / 间距 / 组件 / 动画设计规范               |
| [世界书 EJS 与正则创作指南](docs/reference/worldbook-ejs-regex-authoring-guide.md) | 内容创作者       | 世界书、EJS、输出美化与隔离运行契约             |

---

## 技术栈

- **引擎**：TypeScript（`src/core/`，160+ 模块）
- **前端**：Vue 3 + Pinia + Vite（`src/ui/`）
- **存储**：IndexedDB（Dexie）
- **AI**：OpenAI 兼容 API + function calling

---

## 授权

- **代码部分**（`src/`）：MIT License
- **世界观与叙事内容**：受 [《命定之诗》内容二创与素材使用授权协议](docs/《命定之诗》内容二创与素材使用授权协议.md) 约束

> 两者不可混淆——引擎代码可自由修改分发；世界观、角色、设定的复用须遵守独立授权协议。

---

## 进度

开发中。引擎核心、前端主框架与数据规范迁移已完成；此后陆续交付了战斗系统 v3（代码内核主持 + 战斗主持人）、创意工坊 P1–P4、图像生成 v1/v2、内容分离、地图系统 v1、存档互传、随机事件 v1、管线并行化、Agent 失败自动重试、远程素材 v1。目前处于真机迭代调试阶段。

完整进度表见 [AGENTS.md](AGENTS.md#当前进度速览)。

<!-- TODO: 放一个简单的进度看板（✅ 已完成 / 🔄 进行中 / ⬜ 待做）让玩家知道离能玩还差多远 -->
