# API 池默认采样参数 + 自定义请求头设计 v1（参数跟随模型）

> **状态**：已实施（2026-09-30），真机待验证。
> **起因**：两条真机 / 群反馈 ——
> ① 「LLM 参数能不能跟随模型走？不然每次换模型都要手动一个个 Agent 设置一遍，好麻烦」；
> ② 用 opencode go 的 OpenAI 兼容端点报 `HTTP 400 MissingSessionID`，需附带 `x-opencode-session`
> 请求头，而 API 配置里根本没有加请求头的地方。

---

## 0. 问题与设计缺口

| #   | 反馈                            | 现有设计缺口                                                                                                                                                                                 |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 换模型要逐个 Agent 重设采样参数 | 所有采样参数（temperature/topP/freqPen/presPen/maxTokens）**只挂在 Agent 上**；「模型」不是一等公民（Agent 设置里叫 `model` 的键实际存 **API 池 id**），没有任何 `源/模型 → 参数` 的层可挂。 |
| ②   | 需要给非标准网关附自定义请求头  | 请求体侧早有 `bodyOverrides` / `bodyOmitPaths`，**请求头侧完全空白**：类型、传输、BFF 白名单、CORS 四层都没有入口。                                                                          |

两条指向同一个根：配置模型「Agent 一枝独大」，缺**源/模型层**的参数与请求头。

---

## 1. 源级默认采样参数（1A）

### 1.1 数据模型

```ts
// types-api.ts
interface LlmDefaultParameters {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
}
interface LlmApiSource {
  defaultParameters?: LlmDefaultParameters; /* ... */
}
interface ApiEndpoint {
  defaultParameters?: LlmDefaultParameters; /* ... */
} // types.ts 同字段
```

只含真正的采样 / 长度五参。**重试次数、历史层数、末尾指令不在此列** —— 它们跟人不跟模型。

### 1.2 优先级（承重决策）

```
Agent 显式覆写  >  API 池默认  >  内容包/占位默认层  >  硬兜底(AGENT_SETTINGS_DEFAULTS)
```

🔴 **池默认刻意压过内容包默认层**。`agent-config.json` 给**每个** Agent 都写了
`temperature=0.7 / maxTokens=65536`；若池默认排在默认层之下，它就**永远轮不到生效** ——
用户配了却毫无变化、且无任何报错。用户对设备本地池的显式配置优先于内容出厂默认。

判据「Agent 是否显式覆写」= 覆写层 `settings.agents[agentId]` 里该键是否存在（与
`getAgentSettings` 同源），`undefined` = 未覆写。

### 1.3 接线点

| 位置                                   | 作用                                              |
| -------------------------------------- | ------------------------------------------------- |
| `agent-settings.resolveAgentLlmParams` | **唯一解析入口**，返回五参有效值                  |
| `game-pipeline.buildAgentConfigs`      | 主 DAG + 侧链 + 战斗的 `AgentConfig` 五参从这里出 |
| `create-store`（plot_outline 大纲）    | 同一解析，避免两套口径                            |
| `AgentClient.buildRequestBody`         | 池默认作为**请求缺值兜底**                        |

🔴 为什么要最后一层 `AgentClient` 兜底：侧链（char_gen / item_gen / craft_gen）与战斗走的是
`client.chatWithTools({ messages, ... })`，**根本不读 `AgentConfig.temperature`**；不兜底它们就
吃不到池默认。兜底后它们至少跟随模型（Agent 覆写对它们仍不生效 —— 见 §4 已知限制）。

---

## 2. 源级自定义请求头（2A）

### 2.1 数据模型与传输

```ts
// types-api.ts
type HeaderOverrides = Record<string, string>;
interface ApiSourceBase {
  headerOverrides: HeaderOverrides; /* ... */
}
```

前端把 `headerOverrides` 打成单个载荷头 `X-Custom-Headers`（`encodeURIComponent(JSON.stringify(...))`，
保证 ASCII 头值）发给 BFF。**不是**把每个自定义头直接当请求头发 —— 那样 CORS 无法白名单、
BFF 也无法区分合法/注入。

### 2.2 安全边界（两层各验一次）

**受保护头名**（大小写不敏感，填了即拒，不给静默忽略）：`authorization` / `api-key` /
`x-api-key` / `x-goog-api-key` / `anthropic-version` / `anthropic-beta` / `content-type` /
`content-length` / `host` / `accept` / `accept-encoding` / `connection` / `transfer-encoding` /
`x-target-base-url` / `x-model-id` / `x-llm-stream` / `x-custom-headers`。

- 引擎 `src/core/api/header-overrides.ts`：**用户面**（保存 / 连接测试时抛清晰错误）。
- BFF `server/routes/proxy.ts`：**权威面**（不 import 前端代码，前端自证作废），非法/受保护项静默丢弃。
- 头名须过 RFC 7230 token 字符集；头值禁 CR/LF 与控制字符（header injection）。
- `server/app.ts` CORS `allowHeaders` 增加 `X-Custom-Headers`（跨端口预检放行）。

请求头面与请求体面（`bodyOverrides`）**同构**，保护字段的思路也一致
（`body-parameters.ts` 的 `PROTECTED_ROOT_FIELDS`）。

---

## 3. UI 变更（ApiSection）

1. 添加/编辑弹窗 `size` `md` → **`lg`**（表单变宽，缓解原先的窄）。
2. 新增「默认采样参数」分组（仅 LLM 源，添加与编辑共用同一弹窗）：五个输入框，默认预填
   **temperature 1 / Top P 1 / 频率·存在惩罚 0**（maxTokens 留空）；**清空某一格 = 不设置该键**，
   回落到内容包默认层。因为是共用弹窗，LLM 源的编辑里同样可改。
3. 新增高级项「自定义请求头（JSON）」文本框。
4. 🔴 **API Key 遮蔽修复**：编辑已有连接时输入框装**掩码**（`sk-***abcd`），真 key 只留在
   `_realKey`；明文显示改为显式 `showKey` 开关。此前 `:type` 表达式把编辑态判成 `text`，
   弹窗一开密钥就明文暴露。

---

## 4. 已知限制（未在本次范围）

- **侧链 / 战斗不读 Agent 覆写**：它们的调用点不传采样参数，只经 `AgentClient` 兜底吃到
  **池默认**。要让 Agent 级覆写对它们也生效，需要逐个把 `config.temperature` 传进
  `chatWithTools`（char_gen / item_gen / craft_gen / combat coordinator 数处），是独立的既有缺口。
- **重试 / 历史层数 / 末尾指令不跟随模型**：刻意留在 Agent 设置。
- `bodyOverrides` 仍最后生效（会盖过池默认与 Agent 值）—— 它是逃生口，语义未变。

---

## 5. 验证

- 新增测试：`header-overrides`（校验 / 编码 / 保护名单）、`source-config`（解析）、`transport`
  （`X-Custom-Headers` 载荷）、`agent-client`（兜底 + 请求值优先）、`agent-settings.resolveAgentLlmParams`
  （四层优先级）、`server-custom-headers`（BFF 透传 + 保护 + CRLF + 坏载荷）、`ApiSection.llm-defaults`
  （源码契约）。
- `npm run gates` 八道全绿（410 文件 / 9603 通过 / 8 跳过）；Knip 保持 135 项无新增。
