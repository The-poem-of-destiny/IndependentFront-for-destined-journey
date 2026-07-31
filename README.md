# 命定之诗

> AI 驱动的文字角色扮演游戏 · 兼容 SillyTavern 生态
>
> 你创造角色，引擎保证规则，AI 编织故事，世界自行运转。

<!-- TODO: 放 1-2 张游戏内截图（捏人页 / 游戏页叙事+状态栏），能极大提升吸引力 -->

---

## 这是什么

命定之诗是一个**文字 RPG 游戏引擎**。你创建一名角色，之后由多 Agent 编排引擎驱动一轮又一轮的叙事：

- **确定性游戏系统**——战斗、制作、角色生成、数值、状态都由引擎严格计算，不靠 AI 瞎编。你看到的 HP、伤害、品质、好感度都是真实可供游玩的数据。
- **AI 叙事创造性**——故事正文、角色对白、剧情演化由 AI 生成。引擎负责"规则对不对"，AI 负责"故事好不好"。
- **开放世界剧情**——AI 构造世界初始态（各方 NPC 有自己的议程，世界在自行运转），主角是自由介入的变量。没有预设的 A/B/C 分支，你想做什么就输入什么。

> ⚠️ **当前为开发版**。需自备 AI API，暂无独立安装包。详见下方[快速开始](#快速开始)。

---

## 快速开始

### 方式一：下载 Release（推荐 · 待发布）

桌面安装包（Windows 可执行文件，双击即玩，无需 Node.js）正在准备中。发布后可从 [Releases 页](../../releases) 下载。

> 在此之前，请用方式二从源码运行。

### 方式二：从源码运行（当前可用）

**前置**：[Node.js](https://nodejs.org/) 18+（LTS 推荐）

```bash
# 1. 下载源码
git clone https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey.git
cd IndependentFront-for-destined-journey

# 2. 安装依赖
npm install

# 3. 启动开发服务器
npm run dev
```

启动后浏览器自动打开 `http://localhost:5173`。

> Windows 用户也可直接双击 `dev.bat`（自动清理旧进程 + 固定端口启动）。

---

## 首次游玩配置（重要）

启动后先进入**设置页**，完成以下配置才能正常游玩。

### 1. 创建 3 个 AI API（必须 ⚡）

游戏需要 3 个 API：两个 DeepSeek（主力叙事）+ 一个 Embedding（记忆召回）。

**设置页 → 🔌 API 配置 → 新建**，依次创建：

**① DeepSeek V4 Flash**（便宜 · 用于大部分 Agent）

- Endpoint：`https://api.deepseek.com`
- API Key：在 [DeepSeek 平台](https://platform.deepseek.com/) 注册后获取
- 默认模型：选 **DeepSeek V4 Flash**

**② DeepSeek V4 Pro**（更聪明 · 推荐用于正文，稍贵）

- Endpoint：同上
- API Key：同一个 Key 即可
- 默认模型：选 **DeepSeek V4 Pro**

**③ Embedding 模型**（用于记忆召回 · 硅基流动）

- Endpoint：`https://api.siliconflow.cn/v1`
- API Key：在[硅基流动](https://cloud.siliconflow.cn/)注册后获取
- 默认模型：`Qwen/Qwen3-VL-Embedding-8B`

每个创建后点「**连接测试**」确认通过。配完 API 列表应有 **3 个**。

> 也支持任何 OpenAI 兼容的 API（OpenAI 官方、Kimi、智谱、本地 Ollama 等），上述只是推荐组合。

### 2. 绑定 Agent 模型（必须）

**设置页 → 🤖 Agent 配置**：

- **记忆召回** Agent → 选择上面创建的 **Embedding** 模型
- **其余所有 Agent** → 选择 **DeepSeek V4 Flash**

> 💡 **正文推荐 V4 Pro**：把 `story`（叙事）Agent 换成 Pro，文笔更好。Pro 比 Flash 贵，所以只给正文用，其他全用 Flash 性价比最高。

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
- 🔌 **SillyTavern 兼容**——支持世界书 / 预设格式，可导入既有生态资源（角色卡导入尚未实现）
- 💾 **本地存档**——IndexedDB 本地存储，你的存档在你自己的机器上

---

## 文档

| 文档                             | 给谁             | 内容                                 |
| -------------------------------- | ---------------- | ------------------------------------ |
| [CLAUDE.md](CLAUDE.md)           | 开发者 / AI 助手 | 架构、命令、规范、Phase 进度（最全） |
| [PRODUCT.md](PRODUCT.md)         | 产品 / 设计      | 用户画像、品牌、设计原则             |
| [docs/](docs/)                   | 深度阅读         | PRD、架构文档、Phase 计划、设计规范  |
| [docs/design.md](docs/design.md) | 前端开发         | 排版 / 间距 / 组件 / 动画设计规范    |

---

## 技术栈

- **引擎**：TypeScript（`src/sillytavern/`，30+ 模块）
- **前端**：Vue 3 + Pinia + Vite（`src/ui/`）
- **存储**：IndexedDB（Dexie）
- **AI**：OpenAI 兼容 API + function calling

---

## 授权

- **代码部分**（`src/`）：MIT License
- **世界观与叙事内容**：受 [《命定之诗》内容二创与素材使用授权协议](《命定之诗》内容二创与素材使用授权协议.md) 约束

> 两者不可混淆——引擎代码可自由修改分发；世界观、角色、设定的复用须遵守独立授权协议。

---

## 进度

开发中。Phase 1–10j + M1–M6 已完成（引擎核心 + 前端主框架 + 数据规范迁移），真机迭代调试中。

完整进度表见 [CLAUDE.md](CLAUDE.md#当前进度)。

<!-- TODO: 放一个简单的进度看板（✅ 已完成 / 🔄 进行中 / ⬜ 待做）让玩家知道离能玩还差多远 -->
