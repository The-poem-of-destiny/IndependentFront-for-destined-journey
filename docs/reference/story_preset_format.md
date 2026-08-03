# Story Agent 预设编写指南

本文档面向**预设编写者**——你只需要知道预设长什么样、AI 会输出什么、以及你可以往预设里塞什么占位符。不需要了解引擎内部实现。

---

## 什么是预设

预设（Preset）是 Story Agent 的 System Prompt。它由若干条**条目**按顺序拼接而成。

每个条目就是一个开关：

```
条目名: "⚙️字数设置"     ← 人类看的名字
内容:   "正文不少于 1200 字"  ← 实际发给 AI 的文本
开关:   开启 / 关闭          ← 前端勾选
```

所有开启的条目按顺序拼接，就是发给 AI 的完整 System Prompt。

---

## 预期输出 — AI 必须输出的 XML 标签

AI 每回合的输出必须按以下**固定顺序**排列：

```
① <thinking>
   （思维链，可选）
   </thinking>

② <maintext>
   （本回合剧情正文，必填。第二人称"你"叙事）
   </maintext>

③ <option>
   选项A标题
   选项B标题
   选项C标题
   （行动选项，必填。至少 2 个，每行一个，纯文本）
   </option>
```

此外，AI 可在需要时输出以下**子系统标记**（不强制，仅在触发制作/战斗/新角色时使用）：

```
<c‎raft_request expects="用户期望">制作意图</c‎raft_request>
<combat_trigger combatType="标准" environment="场景">战斗描述</combat_trigger>
<char_detect characterName="角色名" characterType="npc">角色描述</char_detect>
```

> 子系统标记的解析、执行由引擎负责，预设编写者不需要关心其内部流程。

---

## 预期输入 — 可用占位符及其顺序

预设中可以嵌入以下**系统占位符**。引擎在运行时会把它们替换成真实数据后，再发给 AI。

**推荐排列顺序：**

```
{{AGENT.MEMORY_RECALL}}
{{AGENT.PLOT_PRE_CHECK}}
{{LORE_BOOK}}
{{CHARACTER_STATE}}
{{GAME_TIME}}
{{NARRATIVE}}
{{USER_INPUT}}
```

**每个占位符的含义：**

| 占位符 | 运行时替换为 | 用途 |
|--------|-------------|------|
| `{{AGENT.MEMORY_RECALL}}` | memory_recall 的输出 | 与当前剧情相关的历史记忆 |
| `{{AGENT.PLOT_PRE_CHECK}}` | plot_pre_check 的输出 | 应该触发的剧情事件 |
| `{{LORE_BOOK}}` | 世界书关键词匹配的条目 | 当前场景的世界观设定 |
| `{{LORE_BOOK_STATIC}}` | 世界书**静态区**（字节稳定的条目） | 想把静态区单独放在预设靠前位置时用（缓存友好） |
| `{{LORE_BOOK_DYNAMIC}}` | 世界书**动态区**（含 EJS 的条目，装配时求值） | 想把动态区单独放在预设靠后位置时用 |
| `{{CHARACTER_STATE}}` | 主角 + NPC 状态快照 | 角色属性、装备、技能、状态效果 |
| `{{GAME_TIME}}` | 时间 / 位置 / 天气 / 纪元 | 当前时空信息 |
| `{{NARRATIVE}}` | 最近 N 轮对话历史 | 保持剧情连续性 |
| `{{USER_INPUT}}` | 当前轮用户输入 | 玩家本回合的指令或对话 |

> **不需要放 `{{SYS_PROMPT}}`**——预设本身就已经是 System Prompt，不需要再自引用。

### 世界书静/动分区（可选）

`{{LORE_BOOK}}` 内部本来就分两区：**静态区**（正文字节每回合都一样的条目）排在前、**动态区**（正文含 EJS，装配时才求值）沉在后。默认写 `{{LORE_BOOK}}` 一个占位符即可，两区会连着一起注入，普通预设无需关心。

只有当你想把两区**放在预设的不同位置**时（例如静态区顶到最前面吃满缓存前缀、动态区压到贴近用户输入处），才改用 `{{LORE_BOOK_STATIC}}` + `{{LORE_BOOK_DYNAMIC}}` 两个占位符。两者同时出现也只会求值一次 EJS，不会重复触发条目里的写操作。

```
{{LORE_BOOK_STATIC}}     ← 放在预设靠前的稳定区
...
{{LORE_BOOK_DYNAMIC}}    ← 放在预设靠后的动态区
```

> ⚠️ **拆开的代价**：两区各自是一次独立的宏作用域——静态区条目里 `{{setvar}}` 定义的变量，动态区条目的 `{{getvar}}` **读不到**。世界书条目里有跨区的 setvar/getvar 配对时，就别拆。

### 占位符的参数

部分占位符支持参数控制注入量：

```
{{LORE_BOOK:limit=800}}           限制字符数
{{NARRATIVE:layers=3:slice=1000}} 注入最近 3 轮（每轮截断至 1000 字）
{{MEMORY_ENTRIES:top_k=5}}        限制记忆召回条数（story 不常用）
```

---

## 可用宏 — setvar / getvar / random / 注释

预设条目中可以使用以下**宏**来实现条件内容。这些宏在引擎发送给 AI **之前**就被预处理了，AI 不会看到宏本身。

### 1. `{{setvar::变量名::变量值}}` — 声明变量

声明一个变量并赋值。同类条目互斥时，开启哪个条目就生效哪个值（同名后者覆盖）。

```
条目A: {{setvar::抢话::允许代替{{user}}做选择和行动}}
条目B: {{setvar::抢话::禁止替{{user}}做重要决定}}
```

> 只开 A → 变量"抢话" = "允许代替..."。只开 B → 覆盖为"禁止..."。两个都不开 → 无此变量。

### 2. `{{getvar::变量名}}` — 读取变量

在别处引用之前 setvar 的值。引擎会替换为对应的变量值。

```
某条目: 行为准则：{{getvar::抢话}}
→ 预处理后: 行为准则：允许代替{{user}}做选择和行动
```

> 查不到的变量 → 替换为空字符串。

### 3. `{{random::A,B,C}}` — 随机选择

从逗号分隔的选项中随机选一个替换。

```
天气：{{random::晴朗,多云,细雨,薄雾}}
→ 可能变为: 天气：薄雾
```

### 4. `{{//注释内容}}` — 注释

完全不会被发给 AI，仅给预设作者看。

```
{{//这条很重要，不要关}}
```

### 5. `{{char}}` / `{{user}}` — 角色名/用户名

替换为当前角色名和用户名。引擎在运行时自动替换。

```
{{char}} 对 {{user}} 说道
→ 替换为: 艾丽莎 对 冒险者 说道
```

> 如果引擎未提供角色名/用户名，会保留为 `{{CHARACTER_NAME}}` / `{{USER_NAME}}` 作为兜底。

---

## 预设中不应该出现的内容

以下限制只针对 **Story preset 本体**。世界书条目可以使用 EJS，输出美化库可以使用正则和 HTML/CSS/JS；其契约见[世界书 EJS 与输出美化正则创作指南](./worldbook-ejs-regex-authoring-guide.md)。

以下内容源自旧 SillyTavern 角色卡体系，**不应直接塞进 Story preset**：

- **EJS 条件块** `<% if (...) { %>` — 本引擎不区分模型，不需要多模型适配
- **HTML 美化** `<style>` / `<item_info>` / `<task_info>` / 技能异域字符 / emoji / 文字发光 — 不需要
- **防截断免责** `<disclaimer>` — 不需要
- **ST RP 角色扮演框架** `Participant:` / `Recorder:` / `<Participant_input>` — 不需要
- **老格式标签** `UpdateVariable` 块 / `<gametxt>` / `<action_options>` / `<summary>` — 已替换为 `<maintext>` / `<option>`，`<sum>` 和 `<vars>` 由其他 Agent 负责
- **`{{lastUsermessage}}`** 等未注册占位符 — 会被引擎剥离
- **正则脚本 / ChatSquash 配置** — 不需要

---

## 完整示例：一个最小预设

```
条目 1 | ⚙️叙事规则
正文语言：简体中文
叙事人称：第二人称"你"
正文最少 1200 字

条目 2 | ⚙️行为准则
{{setvar::抢话::允许代替{{user}}做选择和行动}}

条目 3 | 🎨文风
{{getvar::抢话}}
避免过度文学化，以事件驱动叙事

条目 4 | 📥上下文注入
{{AGENT.MEMORY_RECALL}}
{{AGENT.PLOT_PRE_CHECK}}
{{LORE_BOOK}}
{{CHARACTER_STATE}}
{{GAME_TIME}}
{{NARRATIVE}}
{{USER_INPUT}}
```

---

## 快速检查清单

写完预设后对照：

- [ ] 是否让 AI 输出 `<thinking>` → `<maintext>` → `<option>` 这个顺序？
- [ ] 上下文占位符是否按推荐顺序排列？
- [ ] 有没有漏掉 `{{AGENT.MEMORY_RECALL}}` 或 `{{CHARACTER_STATE}}`？
- [ ] 有没有 `{{SYS_PROMPT}}`？（应该没有）
- [ ] 有没有 EJS `<%` 或 `%>`？（应该没有）
- [ ] 有没有 `<gametxt>` / `<action_options>` / `<summary>` 等老标签？（应该没有）
- [ ] `{{setvar}}` 的变量名有无拼写错误？（否则 `{{getvar}}` 取不到值）
