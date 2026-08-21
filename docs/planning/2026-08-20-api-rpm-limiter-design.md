# API 凭据级 RPM 限流设计（2026-08-20）

> **状态：已实施（2026-08-21）；设置页宽屏与窄屏已真机走查，等待弹窗由组件测试覆盖。**
>
> 适用范围：API 池里的 Chat、Embedding 与 NovelAI 图像端点。修改 API 请求发送链、API
> 池设置或限流等待提示前，先读本文。

## 0. 一句话架构

在所有带 API 凭据的真实网络发送前收口到一个应用级 `ApiRpmLimiter` 深模块；模块按“归一化端点
与 API Key”共享一个先进先出配额桶，达到用户配置的 RPM 后暂停该桶 60 秒、发布一份全局等待快照，
到时自动放行，无需调用方捕获或重试。

## 1. 需求与验收口径

### 1.1 必须做到

1. 设置页提供一个全局 RPM 管理面，用户可为每个“API 端点 + API Key”组合设置限制。
2. 同一组合无论被多少 Agent、模型、存档或请求类型使用，都共享同一个计数器。
3. 达到限制后的下一次请求不发往上游，而是进入等待队列。
4. 第一次溢出时显示全局弹出提示，明确端点、限制值、排队数和剩余时间。
5. 等待满 60 秒后自动继续；用户无需重新点击发送，也不会因等待本身触发网络超时。
6. 自动重试、工具调用后续轮次、Embedding 和图像请求都按一次真实 HTTP 发送计数。
7. 默认“不限”，因此升级后不改变现有用户行为。

### 1.2 非目标

- 不替服务商发现真实额度；RPM 数值由用户自行填写。
- 不管理 TPM、并发数、每日额度或费用预算。
- 不把本地 ComfyUI、工坊、远程素材等无 API 池凭据的网络请求纳入。
- 不把本地限流命中伪装成 HTTP 429；请求根本尚未发送。
- 不保证其他浏览器标签页或其他应用进程共享同一计数器。v1 的“全局”指当前应用运行实例内的全部请求。
- 不改变上游真实 429 的现有错误语义。服务商仍可能因 TPM、其他客户端或账户级规则返回 429。

## 2. 现状证据与必须收口的请求面

当前没有 RPM 字段或限流模块：

- `ApiEndpoint` 只有地址、密钥、模型、超时和 thinking 开关（`src/sillytavern/types.ts`）。
- `AgentOrchestrator` 会并行执行同 stage 的 Agent（`src/sillytavern/agent-orchestrator.ts`）。
- `AgentClient.postCompletions()` 直接请求 `/api/chat/completions`（`src/sillytavern/agent-client.ts`）。
- BFF `forward()` 只透传请求与响应，不做计数或排队（`server/routes/proxy.ts`）。

v1 必须覆盖以下生产发送点：

| 请求面                            | 现行发送点                        | 是否计 RPM | 说明                                   |
| --------------------------------- | --------------------------------- | ---------- | -------------------------------------- |
| Chat completion / 流式 completion | `AgentClient.postCompletions()`   | 是         | 每次重试、每个工具调用轮次各计一次     |
| Embedding                         | `memory-store.computeEmbedding()` | 是         | 与相同端点和 Key 的 Chat 共桶          |
| 连接测试                          | `ApiSection` / `api-tools`        | 是         | 它确实向上游发 completion 或 embedding |
| 模型列表                          | `api-tools.fetchModels()`         | 是         | 保守地计入同一凭据总 RPM               |
| NovelAI 图像                      | `ui/lib/image-client.ts`          | 是         | 端点来自 API 池，按相同凭据规则管理    |
| ComfyUI                           | `image-providers/comfyui.ts`      | 否         | 无 API Key 且不属于 API 池             |

所有调用点必须复用同一个调度接口。只给 `AgentClient` 加等待会让 Embedding、测试连接和图像生成
绕过配额，不满足“每个端点 + Key 组合”的契约。

## 3. 统一语言

| 术语         | 精确定义                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| **API 凭据** | 归一化上游基础地址与完整 API Key 的组合；它是 RPM 策略与计数的身份单位。 |
| **RPM 策略** | 用户为一份 API 凭据配置的每分钟最多真实发送次数；缺席表示不限。          |
| **配额桶**   | 当前应用实例内，一份 API 凭据对应的已发送时间戳、等待队列与暂停状态。    |
| **配额占位** | 一次真实 HTTP 发送前原子登记一个名额；获得名额不等于请求成功。           |
| **等待请求** | 已提出发送意图、尚未获得配额占位的请求；取消等待不消耗名额。             |

不要把“Endpoint ID”当作 API 凭据。两个 API 池条目只要地址与 Key 相同，即使名字、模型、类型或
Endpoint ID 不同，也必须共享一个桶。

## 4. 核心裁定

### D1：限流在浏览器请求发送缝，不放在 BFF

BFF 看得到目标地址与 Authorization，但设置和玩家提示都在浏览器。若在 BFF 排队，前端无法在请求
发出前稳定获知等待状态；若 BFF 返回自定义错误再让前端重试，又会把正常排队变成错误路径。

因此 BFF 继续做无状态透传。应用侧在 `fetch` 回调真正执行前完成配额占位，既能统一提示，也不会让
排队请求占住上游连接。

### D2：一个深模块拥有身份、计数、排队、计时和通知快照

新建 `src/sillytavern/api-rpm-limiter.ts`，对调用方只暴露三件事：

```ts
scheduleApiRequest<T>(
  credential: ApiCredentialRef,
  signal: AbortSignal | undefined,
  dispatch: () => Promise<T>,
): Promise<T>;

replaceApiRpmPolicies(policies: ApiRpmPolicy[]): void;

subscribeApiRpmWaits(listener: (snapshot: ApiRpmWaitSnapshot) => void): () => void;
```

`scheduleApiRequest()` 隐藏凭据指纹、桶查找、FIFO、60 秒计时器、动态配置和取消清理。调用方只描述
“用哪份凭据发送”，并提供真正的发送回调。删除该模块会迫使这些规则散回所有 fetch 调用点，因而该
模块具备足够深度与维护局部性。

模块不得 import Vue、Pinia 或 `src/ui/**`。前端通过订阅接口装展示适配器，保持“前端 → 引擎”的
单向分层。

### D3：身份按地址 + Key，持久层不保存第二份明文 Key

身份计算：

```text
credentialId = SHA-256("api-rpm-v1\0" + normalize(baseUrl) + "\0" + apiKey)
```

地址归一化只做不会改变上游身份的处理：`trim`、URL 标准化、去 query/fragment、去末尾 `/`。不合并
不同 path，因为 `https://host/v1` 与 `https://host/gateway/v1` 可能是不同账户或网关。

`credentialId` 只用于本地关联，策略记录不得保存完整 Key。界面上的 Key 仍使用现有 `maskedKey`。

### D4：真实发送才计数

- 请求获得占位、即将调用 `dispatch()` 时写入发送时间戳。
- HTTP 成功、4xx、5xx、网络中断都已消耗一次服务商请求，因此不退还名额。
- 自动重试再次进入 `scheduleApiRequest()`，再次计数。
- Agent 工具调用的下一轮 completion 再次计数。
- 排队时被取消的请求从 FIFO 删除，不计数。
- 获得占位后才取消的请求仍计数，因为字节可能已经到达上游。

### D5：第一次溢出触发完整 60 秒暂停

采用“溢出后冷却”而不是固定自然分钟或尽早滑窗放行：

1. 每次请求先删除 60 秒前的发送时间戳。
2. 若有效时间戳数量小于 RPM，立即占位并发送。
3. 若数量已达 RPM，当前请求入 FIFO，并把该桶设为 `pausedUntil = now + 60_000`。
4. 暂停期间同凭据的新请求继续入同一 FIFO，不发送。
5. 60 秒到期后清空上一窗口，按 FIFO 一次放行最多 RPM 条。
6. 若仍有等待请求，立即开始下一段 60 秒暂停；提示保持可见并更新下一次恢复时间。

这比“等最老时间戳满 60 秒就挤一个名额”更保守，但它逐字满足“达到限制后等待一分钟自动继续”，
倒计时不会在弹出后突然从 60 秒跳成 7 秒。代价是吞吐可能低于服务商允许值，属于用户主动设置安全
上限时可接受的取舍。

### D6：FIFO 且只阻塞命中的凭据

同一 API 凭据内严格先进先出，避免并行 Agent 后来的请求插队。不同凭据拥有独立桶：一个 Key 等待时，
其他 Key、其他端点和无凭据的本地功能照常运行。

### D7：网络超时从获得名额后开始

现有 `AgentClient` 会在发 fetch 前启动超时控制器。接入后必须把控制器和网络 timeout 的创建移动到
`dispatch()` 内；60 秒配额等待不属于网络超时。调用方的外部取消 signal 从入队时就生效。

## 5. 状态机

```text
             有空位
请求 ───────────────→ 占位并 dispatch
 │
 │ 已达 RPM
 ▼
FIFO 入队 → PAUSED（60 秒倒计时）
                 │
                 │ 到时
                 ▼
          按 FIFO 放行 ≤ RPM
              │       │
         队列已空   队列仍有
              │       │
              ▼       └──→ 再 PAUSED 60 秒
            READY
```

桶的最小内部状态：

```ts
type Bucket = {
  credentialId: string;
  rpmLimit: number;
  sentAt: number[];
  queue: Waiter[];
  pausedUntil: number | null;
  timer: ReturnType<typeof setTimeout> | null;
};
```

时间源与 timer 适配器作为模块内部测试缝注入；生产用 `Date.now` / `setTimeout`，单测用 fake clock。

## 6. 设置与持久化

### 6.1 数据模型

新增 Dexie 表 `apiRateLimitPolicies`，数据库从 v22 升到 v23：

```ts
export interface ApiRpmPolicy {
  credentialId: string; // 主键，SHA-256 指纹
  rpmLimit: number; // 正整数
  updatedAt: number;
}
```

策略与 `apiEndpoints` 分表，原因是 Endpoint ID 不是配额身份；相同地址 + Key 的重复池条目必须天然落到
同一条策略。该表进入 FullBackup，与 `apiEndpoints` 一同导入导出。策略行没有明文 Key。

数据库升级只加表，不需要扫描或重写现有端点。旧用户没有策略行，等价于不限。

### 6.2 全局管理面

在设置页“API 配置”分区的 API 池列表上方新增“全局 RPM 限制”卡，不另增第 15 个主导航分区。

- 水合 API secrets 后，按 `credentialId` 折叠当前 API 池条目。
- 每行显示：端点名称（重复组合显示多个名称）、归一化地址、masked Key、RPM 输入。
- 输入旁保留文字选项“无限制”，不要做 icon-only 控件。
- 合法值为正整数；空值表示无限制；`0`、负数、小数和非数字不允许保存。
- 使用显式“保存限制”按钮批量提交，成功后立即调用 `replaceApiRpmPolicies()`。
- 相同凭据只显示一行，因此不存在两个池条目给同一组合配置出冲突数值。
- 编辑地址或 Key 后形成新凭据。API 编辑弹窗保留当前 RPM 值并在保存时把策略迁到新指纹；旧指纹若已无
  其他端点引用则删除。
- 删除最后一个引用某凭据的 API 池条目时删除孤儿策略；若仍有重复条目引用则保留。

RPM 设置不放进脱敏 localStorage 快照，唯一真源是 Dexie 新表，避免出现与 API Key 存储相同的双真源。

## 7. 全局等待弹出提示

新增 `src/ui/components/shared/ApiRateLimitWaitPopup.vue`，在 `App.vue` 与 `ToastContainer` 同级挂载，确保
首页、捏人页、游戏页和设置页都可见。

这里的“弹出提示”裁定为**非阻塞、持续显示的状态浮层**，不是遮住应用 60 秒的 Modal：

- 标题：`API 请求已达到 RPM 限制`
- 正文：`DeepSeek 生产（60 RPM）已暂停；3 个请求正在等待，将在 00:47 后自动继续。`
- 多个凭据同时等待时，一个浮层内按凭据列多行，不连续弹多个 toast。
- 倒计时每秒更新；配额恢复后显示 `正在继续…`，队列清空即自动关闭。
- 浮层不提供“重试”按钮，因为队列本来就会自动继续。
- 用户取消整轮生成时，既有 AbortSignal 会移除对应等待项；没有等待项时浮层立即关闭。
- 使用完整文字按钮“打开 API 限制设置”跳到设置页 API 分区；不用单独齿轮图标。
- `role="status"` + `aria-live="polite"`，但无障碍播报只在进入等待、恢复、下一轮等待时触发，不每秒朗读。
- 视觉使用 `AppCard` / 主题 token / 36px 触摸目标，并遵守 `prefers-reduced-motion`。

现有 Toast 默认 3 秒自动消失，也无法原位更新倒计时，因此不承担这项状态。首次进入等待可以发一次
warning toast，但不是必要条件；v1 只实现持久浮层即可。

## 8. 配置热更新语义

| 用户动作         | 已发送请求           | 等待请求                                           |
| ---------------- | -------------------- | -------------------------------------------------- |
| 降低 RPM         | 不取消、不追溯       | 按新限制继续等待                                   |
| 提高 RPM         | 不变                 | 立即补放新增加的可用名额；队列空则关闭提示         |
| 改为无限制       | 不变                 | 立即按 FIFO 全部放行                               |
| 修改地址或 Key   | 旧凭据请求按旧桶收尾 | 新请求使用新凭据桶；策略按 §6.2 迁移               |
| 删除最后一个端点 | 不取消已发请求       | 对仍持有旧凭据的在途工作按“无限制”放行，随后回收桶 |

配置更新不得让已经获得名额的请求重新计数，也不得重排既有 FIFO。

## 9. 取消、关闭与异常

- `AbortSignal` 在排队阶段触发：从队列删除并以现有取消语义结束，不显示 API 错误。
- 页面切换不取消等待；限流器是应用级单例，浮层挂在根组件。
- 应用关闭或刷新：内存队列随运行实例结束，不尝试恢复业务 Promise。
- v1 不持久化最近 60 秒发送账本；刷新后重新计数。若未来需要跨标签页严格共享，应另立
  BroadcastChannel/Web Locks 设计，不在本次偷偷扩大范围。
- Web Crypto 指纹计算失败属于本地基础设施错误：记录诊断并拒绝发送，不能悄悄降级成无限制。
- 策略表读取失败：沿用 API secrets 的安全口径，在 UI 明示“RPM 设置不可用”，本次会话默认不限；密钥
  本身仍按现有逻辑处理。此降级不写回或覆盖原策略。

## 10. 接线计划

### Wave 1：纯模块与存储

1. `types.ts` 增加 `ApiRpmPolicy`、凭据引用与等待快照类型。
2. `database.ts` 升 v23，新增策略表 CRUD、备份/恢复和 schema 回归测试。
3. 新建 `api-rpm-limiter.ts`，以 fake clock 完成身份、FIFO、60 秒暂停、取消和热更新测试。

### Wave 2：全部真实请求面

1. `AgentClient.postCompletions()` 通过 `scheduleApiRequest()` 执行；网络 timeout 移进 dispatch。
2. `memory-store.computeEmbedding()` 接入同一接口。
3. `api-tools` 的模型列表与连接测试接入；删除 `ApiSection` 的直写 fetch 分叉。
4. NovelAI `image-client` 接入；ComfyUI 明确保持不接入。
5. 给每条发送面写集成测试，证明重复调用共享同一 limiter fake，而非只测模块本身。

### Wave 3：设置与全局提示

1. Settings store 水合/保存策略并向 limiter 热更新。
2. `ApiSection` 增加按凭据折叠的全局 RPM 管理卡。
3. 新增等待 popup 与 UI adapter，在 `App.vue` 根挂载。
4. 跑响应式与无障碍走查：桌面、390px、1280×720、键盘、reduced motion。

## 11. 必测场景

### 11.1 纯逻辑

1. `N` 次立即发送，第 `N+1` 次入队且只启动一个 60 秒 timer。
2. 59,999ms 不放行，60,000ms 自动按 FIFO 放行。
3. 队列超过一个窗口容量时分批，每批之间再等 60 秒。
4. 同地址 + 同 Key + 不同 Endpoint ID/模型/Agent 共桶。
5. 同地址 + 不同 Key 分桶；不同 path + 同 Key 分桶；末尾 `/` 不分桶。
6. 排队取消不计数；获得名额后取消仍计数。
7. 提高、降低、设为无限制时符合 §8 真值表。
8. 策略与快照中不出现完整 API Key。

### 11.2 集成

1. 非流式、流式、tool-call 下一轮与自动重试每次都经过调度接口。
2. 配额等待 60 秒不会触发 Agent 网络 timeout。
3. Embedding 与 Chat 使用同凭据时共享额度。
4. 连接测试、模型列表和 NovelAI 请求计入同一凭据总数。
5. 用户取消生成会移除对应排队项，活动账本不会残留“运行中”。
6. 上游 HTTP 429 仍走既有错误/重试路径，不被误报成本地 RPM 命中。

### 11.3 UI

1. 首次溢出只出现一个 popup；队列增加时原位更新，不叠 toast。
2. 倒计时归零后请求自动继续，popup 自动关闭。
3. 两份凭据同时等待时同一 popup 展示两行且各自倒计时。
4. 390px 不横溢，所有控件有文字且至少容纳文字，键盘可达。
5. screen reader 不会每秒重复播报倒计时。

## 12. 完成定义

- 用户能在 API 配置页为每个去重后的“端点 + Key”组合保存正整数 RPM 或无限制。
- 同凭据的所有生产请求面共享计数，且没有已知绕过 fetch。
- 达限后零上游发送、全局提示出现、60 秒后自动继续。
- 等待不吃网络 timeout，取消不留悬挂 Promise 或 timer。
- 新表随全量备份导入导出，旧数据库无损升到 v23，策略中无明文 Key。
- 新模块、数据库、请求接线和 UI 测试通过；`npm run gates` 全绿并完成真机倒计时走查。
