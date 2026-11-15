# 插件创作者指南

> 状态：对应插件系统 v1（ADR-36 暂定），2026-11-15 已实施 P1a/P1b/P2 的自动化部分。
> 设计契约见 [插件系统设计](../planning/2026-11-15-plugin-system-design.md)；本文写给插件作者，冲突时以设计文档和代码里的单一来源表为准（`src/core/plugins/plugin-surface.ts`）。
> 🔴 2026-11-15 现状：Chromium 上自检的 S7（文件选择器）尚待人工验证，在那之前插件在 Chromium 上保持禁用；创意工坊渠道（P3）未做，插件只能从本地文件夹安装。

## 1. 插件是什么

插件是一个目录，里面有 `manifest.json` 和若干 HTML、JS、CSS、图片等文件。插件的界面跑在一个 opaque origin 的沙盒 iframe 里，可以用完整的 JS、DOM 和任意 UI 框架。它和游戏之间只有一条通道：帧内的全局对象 `host`。

插件能做的事：

- 在游戏页的工具栏、游戏菜单、物品面板底部加入口，打开浮动窗、整层 overlay 或面板。
- 读游戏状态的只读投影，订阅变化和生命周期事件。
- 用声明式命令改状态（加物品、扣钱、改变量等），整批成功或整批失败。
- 存自己的数据：按存档的（随回退）和全局的（不随回退）。
- 让 AI 知道发生了什么：一次性告知、常驻提示块。
- 按 manifest 声明的域名联网（只能是 443 端口上的 `https://` 与 `wss://`）。

插件不能做的事：

- 拿到任何 API Key 或凭据，读宿主的设置、DOM、存储。
- 访问本机（`localhost`、`127.0.0.1` 等）和局域网上的服务，包括本应用自己的后端。
- 嵌入任何远程页面（`frame-src 'none'`）、弹新窗口、导航顶层页面、下载文件、用 `alert` / `prompt`。
- 改引擎流程、提示装配逻辑、世界书、预设、设置、素材库；推进时间、提交回合、直接写消息。

## 2. 包结构

```
poem-plugins/                 # 本地插件目录（见 §10）
└── shop/                     # 目录名就是插件 id
    ├── manifest.json         # 必需，≤64KB
    ├── shop.html             # 贡献点的 entry
    ├── shop.js
    ├── shop.css
    ├── stock.json
    └── icon.png
```

- 文件扩展名白名单：`html` `htm` `js` `mjs` `css` `json` `txt` `md` `svg` `png` `jpg` `jpeg` `gif` `webp` `avif` `woff` `woff2` `ttf` `otf` `mp3` `ogg` `wav`。其他扩展名不安装。
- 上限：单文件 5MB，整个插件 20MB，最多 1000 个文件，路径深度 16，单段 128 字符，整条路径 512 字符。
- 路径每段不许是 `.` / `..` / 空，不许含反斜杠、`:`、控制字符、尾随点或空格，不许是 Windows 保留设备名（`CON`、`NUL`、`COM1` 等）。符号链接和目录联接一律拒绝。

## 3. manifest.json

```json
{
  "manifestVersion": 1,
  "id": "shop",
  "name": "杂货铺",
  "version": "1.0.0",
  "author": "示例",
  "description": "读主角余额，花钱买货架上的物品。",
  "pluginApi": "^1.0",
  "contributions": [
    {
      "slot": "game.toolbar",
      "id": "shop",
      "label": "杂货铺",
      "icon": "icon.png",
      "surface": "window",
      "entry": "shop.html",
      "width": 420,
      "height": 520
    }
  ],
  "network": [],
  "capabilities": {
    "read": ["player"],
    "commands": ["money.spend", "item.grant"],
    "events": [],
    "ai": ["note"],
    "storage": ["save"]
  }
}
```

字段规则：

| 字段              | 规则                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifestVersion` | 只认 `1`；不认识的版本显示为「不兼容」                                                                                                                       |
| `id`              | `^[a-z0-9][a-z0-9._-]{2,63}$`，全局唯一                                                                                                                      |
| `name`、`version` | 必填。`author`、`description` 可选                                                                                                                           |
| `pluginApi`       | 需要的宿主 API 版本范围，支持 `^` `~` `>=` 与精确版本，可写部分版本（`^1.0`）。当前宿主 `PLUGIN_API_VERSION = 1.0.0`；不满足显示为「不兼容」                 |
| `contributions`   | 贡献点列表，见 §8。`id` 为 `^[A-Za-z0-9._-]{1,64}$`；`entry` 必须是包内的 `.html` / `.htm`；`icon` 是包内栅格图（见 §8）                                      |
| `background`      | 可选，包内 `.html`，游戏页挂载期间在不可见的帧里常驻，用来响应事件。启用了后台页面的插件最多 8 个同时运行                                                     |
| `network`         | 可选，允许联网的主机名，见下                                                                                                                                 |
| `capabilities`    | 声明即契约：`read`（投影名）、`commands`（命令名）、`events`（事件名）、`ai`（`note` / `context`）、`storage`（`save` / `global`）。未声明的调用一律 `DENIED` |

`network` 规则（`src/core/plugins/plugin-network.ts`）：

- 只写主机名，不带协议、端口、路径。可以有一个前导 `*.`，通配后至少两段。
- 只收 ASCII 字母、数字、连字符组成的多段名字；国际化域名写 punycode 形式。至少两段，最后一段不能是纯数字。
- 拒绝 IP 字面量（含各种进制写法）、`localhost` 与 `*.localhost`、单段名、以 `local` `internal` `lan` `home` `corp` `intranet` `home.arpa` `test` `invalid` `example` `onion` `arpa` 结尾的名字，以及把公网名字解析到任意 IP 的已知服务（如 `nip.io`、`sslip.io`）。
- 最多 16 项（去重后）。
- 任何一项不合规，整个插件不可安装（不会丢掉坏项继续装）。
- 生成的 CSP 只放行 `https://<域名>` 与 `wss://<域名>`，不带端口，所以只连得上 443。没声明 `network` 的插件只能用 `blob:` / `data:` 资源。注意：没声明不等于离线，WebRTC 不受 CSP 约束（这一点写在玩家看到的风险说明里）。

认不出的字段会被丢弃并在插件管理里记一条说明，不会让插件装不上。旧版 manifest 里的 `remoteCode` 字段按未知字段丢弃。

## 4. 帧里的运行环境

- 每个界面是两层帧：外层牢笼帧只跑宿主脚本，内层是你的文档。两层用同一份 CSP。
- 沙盒标志只有 `allow-scripts allow-forms allow-pointer-lock`。表单 `submit` 事件会触发，但真正的提交被 `form-action 'none'` 挡住。
- CSP 允许 `'unsafe-inline'`、`'unsafe-eval'`、`'wasm-unsafe-eval'`、`blob:`、`data:` 以及声明的域名；`frame-src`、`object-src`、`base-uri`、`manifest-src` 都是 `'none'`。
- 帧内装载器把入口 HTML 里对包内文件的相对引用改写成帧内 `blob:` URL，并按顺序重新执行 `<script>`。CSS 里的相对 `url()` 尽力改写。多文件 ES 模块的相对导入不保证可用，**建议打包成单文件**。运行期取包内文件用 `host.assets`。
- 文档如果试图把自己导航走（`location=`、`meta refresh`、点链接），牢笼帧会拆掉它。
- 主题：宿主只下发 `--theme-*` CSS 变量。⚠️ 2026-11-15 已知缺口：玩家中途切换主题不会推给已打开的帧，重开界面才生效。
- 不要在插件里索要 API Key 或密码。宿主在每个插件界面外画一圈边框写明插件名（联网插件带「联网」标记），并在风险说明里告诉玩家本应用绝不会在插件窗口里要密钥。

## 5. `host` API

所有调用都是异步请求-响应。载荷必须能结构化克隆、单条序列化后不超过 256KB；每个插件每秒最多 60 条消息，超出回 `QUOTA`。

```
host.pluginId / host.apiVersion / host.env       // env：{ hasSaveFilePicker, hasOpenFilePicker, hasDirectoryPicker }
host.read(view)                     → Promise<unknown>
host.subscribe(view, cb)            → Promise<Unsubscribe>   // 不推初始值，先自己 read 一次
host.unsubscribe(view, cb)
host.on(event, cb)                  → Promise<Unsubscribe>
host.off(event, cb)
host.commit({ commands, expect? })  → Promise<CommitResult>  // 永不 reject
host.storage.save.get(key) / set(key, value) / remove(key)
host.storage.global.get(key) / set(key, value) / remove(key)
host.assets.read(path)              → Promise<ArrayBuffer>    // 帧内完成，不经宿主
host.assets.readText(path)          → Promise<string>
host.assets.url(path)               → string（帧内 blob: URL；不存在时同步抛错）
host.ui.close()
host.ui.resize(width, height)       // 浮动窗限 240×160 至 1600×1200
host.ui.toast(text)
host.ui.fillInput(text)             // 只填进输入框，不发送
host.ui.openExternal(url)           // 宿主弹窗显示完整地址 + 「复制链接」，宿主不打开
host.ai.note(text, { visible? })
host.ai.context.set(text | null)
```

返回与失败语义：

- `commit` 一定 resolve：`{ ok: true }` 或 `{ ok: false, code, message, index? }`。`index` 指向出错的命令或前置条件。
- 其他方法失败时 reject 一个 `Error`，带 `code`（下表）和可能的 `index`。`host.assets.*` 找不到文件时 `code` 是 `NOT_FOUND`。
- `storage.*.get` 取不存在的键得到 `undefined`。

错误码：

| 码                    | 含义                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `BUSY`                | 正在生成回合、润色或恢复时间线；或本标签页没拿到存档锁（另一个标签页开着同一存档，或浏览器不支持 Web Locks，比如经局域网 IP 用 HTTP 打开） |
| `IN_COMBAT`           | 战斗中                                                                                                                                   |
| `DENIED`              | 调了 manifest 没声明的命令、投影、事件、AI 手段或存储；或 `target` 写的是主角的其他别名，由引擎解析后才发现要删除 / 改名的是主角 |
| `INVALID`             | 载荷形状不对、命令或方法名不认识、字段不合规、超过 256KB、宿主处理失败；`character.remove` / `character.rename` 的 `target` 直接写主角名、「主角」或「玩家」（翻译时就拒） |
| `PRECONDITION_FAILED` | `expect` 里某一条不满足，`index` 是它的下标                                                                                              |
| `NOT_FOUND`           | 目标不存在                                                                                                                               |
| `QUOTA`               | 超频（每秒 60 条）或超存储配额                                                                                                           |
| `NO_SAVE`             | 当前没有载入存档，或存档已切换                                                                                                           |

写入（`commit`、`storage.save.*`、`ai.note`、`ai.context.set`）受 `BUSY` / `IN_COMBAT` / `NO_SAVE` 约束；读取和 `storage.global.*` 不受生成中、战斗中限制。恢复时间线（回退、恢复快照、重开战斗）期间宿主处在「生成中」状态，所以同样回 `BUSY`。

## 6. 读投影

`host.read(view)` 和 `host.subscribe(view, cb)` 可用的 `view`（需在 `capabilities.read` 里声明）：

| view                                                        | 内容                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `player`                                                    | 主角的非账务字段（含 `money`、五维、资源、位置）                              |
| `player.inventory`、`player.skills`、`player.statusEffects` | 对应数组                                                                      |
| `characters`                                                | 全部角色，同上口径                                                            |
| `stats`                                                     | 与世界书 EJS `stats` 面同一份推导                                             |
| `vars`                                                      | 叙事变量整棵树                                                                |
| `quests`、`affections`、`news`、`fp`、`time`                | 对应字段                                                                      |
| `plot`                                                      | 剧情事件列表（带 `id`，`plot.updateEvent` 按它寻址）。⚠️ 目前包含隐藏事件     |
| `map`                                                       | 落位与地块事实的只读快照                                                      |
| `messages`                                                  | 最近 50 条已接纳的玩家 / 正文消息：`id` `role` `content` `turn` `timestamp`，正文经过脱敏 |
| `run`                                                       | `{ generating, inCombat, turn, mode }`；`turn` 是最近一个已完成的回合         |

返回值都是深拷贝的纯数据。订阅的投影变化时宿主推送新值（宿主做浅比较）。

## 7. 命令

### 7.1 提交形状

```js
const r = await host.commit({
  commands: [
    { type: 'money.spend', amount: 30 },
    { type: 'item.grant', item: { name: '治疗药水', quantity: 1, rarity: '普通', description: '……' } },
  ],
  expect: [{ var: 'shop.stock.potion', gte: 1 }],
});
if (!r.ok) showError(r.code, r.message);
```

- 每条命令是 `{ type, ...字段 }`（注意是 `type`，不是 `name`）。
- 一次 `commit` 的全部命令翻译成一批状态补丁，在存档写锁和一个事务里应用：整批成功或整批失败。
- `target` 是角色**名字**，缺省为主角。不许出现 `id`、`saveId`（任意深度），也不许出现 `__proto__`、`prototype`、`constructor` 键，否则 `INVALID`。
- 命令名必须在 `capabilities.commands` 里，否则 `DENIED`（带 `index`）。
- 整次提交序列化后不超过 256KB。
- 成功后宿主立即把本轮快照补写一遍、刷新界面并推送新的投影。回退到更早的回合会连带撤销这些写入。

### 7.2 命令表

| 命令                                           | 字段                                                                                     | 说明                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `vars.set`                                     | `path`、`value`                                                                          | 写 `variables.<path>`；`value` 是 JSON                    |
| `vars.delta`                                   | `path`、`amount`                                                                         | 数值增减                                                  |
| `vars.remove` / `vars.move` / `vars.insert`    | `path`；`move` 另需 `toPath`；`insert` 需 `value`，可选 `index`（非负整数）              |                                                           |
| `fp.add` / `fp.spend`                          | `amount`（正数）                                                                         | 命运点数；余额不足整批失败                                |
| `character.update`                             | `target?`、`changes`、`delta?`                                                           | 字段白名单；`delta: true` 时只能改数值字段                |
| `money.add`                                    | `target?`、`amount`（正数）                                                              |                                                           |
| `money.spend`                                  | `amount`（正数）                                                                         | 只能花主角的钱；自动附带前置条件「余额 ≥ 本批总额」       |
| `resource.set` / `resource.delta`              | `target?`、`resource`（`hp` / `mp` / `sp`）、`value` 或 `amount`                         | 引擎钳到 `[0, 上限]`                                      |
| `character.add`                                | `character`                                                                              | 宿主补 id、存档归属与年龄锚点，不能给账务字段             |
| `character.remove`                             | `target`                                                                                 | 不能删除主角                                              |
| `character.rename`                             | `target`（必填）、`name`                                                                 | 不能给主角改名；新名字必须唯一                            |
| `status.add`                                   | `target?`、`status`                                                                      |                                                           |
| `status.update`                                | `target?`、`name`、`remainingTime?`、`stacks?`                                           | 后两个至少给一个                                          |
| `status.remove`                                | `target?`、`name`                                                                        |                                                           |
| `item.grant`                                   | `target?`、`item`（`name` 必填）                                                         | 同名只累加数量，其他字段被忽略                            |
| `item.remove`                                  | `target?`、`name`、`quantity?`（默认 1）                                                 | 不存在或数量不足即失败                                    |
| `item.update`                                  | `target?`、`name`、`changes`                                                             | 不能改 `name`、`quantity`                                 |
| `item.transfer`                                | `target?`（来源）、`name`、`to`、`quantity?`                                             | 两端角色都要存在                                          |
| `item.equip`                                   | `target?`、`name`、`slot`                                                                | 槽位按中文枚举归一；堆叠数 > 1 不能直接穿                 |
| `item.unequip`                                 | `target?`，`name` 与 `slot` 二选一                                                       |                                                           |
| `skill.add` / `skill.update` / `skill.remove`  | `target?`；`add` 给 `skill`（含 `name`）；`update` 给 `name` + `changes`；`remove` 给 `name` | 按名寻址；`update` 不能改名                             |
| `location.set`                                 | `target?`、`location`                                                                    | 位置路径文本；地图落位由引擎做                            |
| `quest.upsert` / `quest.remove`                | `quest`（含 `name`）/ `name`                                                             |                                                           |
| `affection.set` / `affection.delta`            | `name`（角色名）、`value` / `amount`                                                     | 引擎钳到 ±100                                             |
| `news.add`                                     | `title`、`content`、`category?`                                                          |                                                           |
| `memory.add`                                   | `content`（1–2000 字）、`keywords?`（≤16 个，每个 ≤32 字）、`importance?`（1–10 整数，默认 5） | 记忆 id 由引擎分配                                   |
| `plot.updateEvent`                             | `eventId`、`changes`                                                                     | 按 `plot` 投影里的 `id` 寻址，只开放叙事字段              |
| `map.tile.statusAdd` / `map.tile.statusRemove` | `tile`、`title`；`statusAdd` 另有 `description?` `effects?` `durationDays?` `reason?`     | `tile` 是地块名                                           |
| `map.tile.buildingAdd`                         | `tile`、`name`、`description?` `ownerFlavor?` `playerOwned?` `income?` `reason?`          | 不能新建主建筑                                            |
| `map.tile.buildingUpdate`                      | `tile`、`name`（或 `main: true` 改主建筑）及同上可选字段                                  |                                                           |
| `map.tile.devProgressAdd`                      | `tile`、`amount`（非 0）、`reason?`                                                      |                                                           |
| `map.tile.historyNote`                         | `tile`、`text`                                                                           |                                                           |

不开放：快照与回退、时间推进、回合提交、消息直写、世界书、预设、设置、素材、地图标记。

### 7.3 前置条件 `expect`

在写锁和事务内求值，任一条不满足则整批不落，返回 `PRECONDITION_FAILED` 和下标：

```
{ view: 'player.money', gte: 30 }
{ item: '治疗药水', owner?: '角色名', gte: 1 }
{ var: 'shop.stock.potion', gte: 1 }
{ var: 'shop.opened', eq: true }
{ var: 'shop.visited', exists: true }
```

## 8. 贡献点

| slot                 | 位置                                                         |
| -------------------- | ------------------------------------------------------------ |
| `game.toolbar`       | 游戏页侧栏工具列末尾的按钮                                   |
| `game.menu`          | 游戏菜单（Esc 呼出）末尾的项                                 |
| `game.overlay`       | 侧栏按钮打开的整层 overlay，盖住游戏区，同一时刻只显示一个   |
| `panel.items.footer` | 物品面板底部的「插件」一节；`surface: 'panel'` 时就地内联渲染 |

`surface` 取 `window`（可拖动、可调大小的浮动窗，不占页面级弹窗位）、`overlay` 或 `panel`。在别的贡献点上声明 `panel` 会退化成浮动窗。按钮的 `label` 只按纯文本显示。

`icon`：只收 PNG、JPEG、WebP、GIF（按文件头判断），宿主解码后缩到 256 像素以内、重编码成 PNG 再用。不收 SVG。

键盘：插件界面获得过焦点后，焦点在宿主页面上时按 Esc 会关掉它；焦点在你的帧里面时，Esc 归你自己处理。

## 9. 事件、存储与 AI

### 9.1 生命周期事件

`host.on(name, cb)`，需要在 `capabilities.events` 里声明。全部是通知，不能否决，宿主不等回调。

| 事件                         | 触发                                                    |
| ---------------------------- | ------------------------------------------------------- |
| `save.enter` / `save.leave`  | 进入启用了插件的存档；离开或切档                        |
| `turn.start`                 | 回合开始生成；此后写入回 `BUSY`                         |
| `turn.end` / `turn.failed`   | 回合被接纳；失败或取消                                  |
| `combat.start` / `combat.end` | 进入、离开战斗                                         |
| `timeline.restored`          | 回退或恢复快照完成；应重读状态与存档数据                |
| `state.changed`              | 订阅的投影变了，载荷 `{ views: [...] }`                 |

⚠️ 2026-11-15 已知缺口：`save.leave` 发出时帧正在被拆掉，可能收不到；不要依赖它做收尾。

### 9.2 存储

| 区                 | 位置                         | 配额     | 回退时 | 卸载时 |
| ------------------ | ---------------------------- | -------- | ------ | ------ |
| `storage.save`     | 当前存档的插件数据袋         | 每插件 256KB | 跟着回退 | 保留，重装后可续用；插件管理里可手动清除 |
| `storage.global`   | 全局表，跨存档               | 每插件 1MB   | 不回退   | 删除                                     |

键是非空字符串，值必须是 JSON。超配额返回 `QUOTA`。整库备份会带上全局数据，不带插件包本身。你发到自己服务器上的数据当然不随回退，两边不一致要自己处理。

### 9.3 让 AI 知情

| 手段         | 接口                                 | 效果                                                                                          |
| ------------ | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| 静默         | 不调用                               | AI 下一回合只看到状态变了                                                                     |
| 一次性告知   | `host.ai.note(text)`                 | 单条 ≤2000 字，进本存档的待告知队列（≤16 条），下一回合注入 `{{PLUGIN_NOTES}}`，回合接纳后清空 |
| 给玩家看     | `host.ai.note(text, { visible: true })` | 同上，另在对话流里落一条系统通知（纯文本）                                                  |
| 常驻提示块   | `host.ai.context.set(text)`          | ≤4000 字，每回合注入 `{{PLUGIN_CONTEXT}}`，传 `null` 清掉                                     |
| 回填输入框   | `host.ui.fillInput(text)`            | 只填不发，由玩家决定                                                                          |
| 经变量       | `vars.set`                           | 变量本来就在 AI 视野里，世界书 EJS 与 `{{getvar}}` 也能读                                     |

注入只发生在正文 AI（story）和直出主生成（direct_main），文本会转义；预设里没写这两个占位符时宿主会兜底追加。只有本机对该存档确认过、自检通过的插件的文本会注入。

## 10. 本地文件夹、安装与启用

1. 把插件目录放进插件文件夹。默认是仓库**上一级**的 `poem-plugins/`（可用环境变量 `POEM_PLUGINS_DIR` 覆盖）。它不能在仓库、`public/` 或 `dist-ui/` 里面，否则插件路由拒绝启用并在扩展管理页写明原因。
2. 打开「扩展管理 → 插件管理」，点「重新扫描」。宿主经 `/api/plugins` 读到清单，逐个比对内容哈希，标出「待安装 / 待更新 / 不可安装 / 不兼容」。
3. 安装或更新要过完整版风险确认（来源、文件数与体积、联网域名、固定风险说明、免责声明，勾选框全勾才能确认）。确认后宿主把文件读进浏览器的数据库。不做静默更新；联网域名变了必须重新确认，新增域名会高亮。
4. 在同一页为某个存档启用，要过短版确认。确认只记在本机：导入别人（或自己）导出的存档后，要在本机重新确认一次。
5. 插件管理里的启动自检必须通过，插件才会在游戏页出现。
6. 开发时可在开发者模式里打开「跟随文件夹自动重载」（默认关，只在开发者模式下生效）：重新扫描时，已装插件的更新直接装上；联网域名变了的更新仍要确认。

存档启用了本机没装的插件时，数据原样保留，界面不出现，扩展管理页会提示。

## 11. 示例：杂货铺

完整示例在 `tests/fixtures/plugins/shop/`（`manifest.json`、`shop.html`、`shop.js`、`shop.css`、`stock.json`、`icon.png`），端到端测试在 `tests/core/plugins/shop-example.e2e.test.ts`。它演示了：

- 用 `host.assets.readText('stock.json')` 读自带的货架；
- `host.read('player')` 取余额，再 `host.subscribe('player', …)` 跟踪变化；
- 一次 `commit` 里 `money.spend` + `item.grant`，余额不足时拿到 `PRECONDITION_FAILED`；
- 可选地 `host.ai.note(...)` 让叙事知道这笔交易；
- 用 `storage.save` 记限量库存，回退时与钱和物品一起回退。

试用：把 `tests/fixtures/plugins/shop` 复制到插件文件夹，按 §10 安装并在存档里启用，游戏页侧栏会出现「杂货铺」按钮。

联网版本只差两处：manifest 加 `"network": ["shop-api.example.com"]`，页面里用 `fetch('https://shop-api.example.com/stock')` 取货架。安装确认会列出这个域名并要求多勾一个框。
