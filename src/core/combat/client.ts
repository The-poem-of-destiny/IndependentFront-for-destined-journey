/** Combat agent client contract. */

/** 抽象的 combat agent 调用客户端（生产用 AgentClient，测试用 mock） */
export interface CombatClient {
  chatWithTools?: (
    request: {
      /**
       * 完整对话历史（决策 1A 持久会话）：除 system/user/assistant 正文外还承载工具往返消息
       * （assistant.tool_calls + tool 结果）。形状对齐 agent-client ChatRequest.messages。
       */
      messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: unknown[];
        tool_call_id?: string;
        name?: string;
      }>;
      tools?: unknown;
      tool_choice?: string;
    },
    toolExecutor: (name: string, args: Record<string, any>) => Promise<unknown>,
    options?: { maxRounds?: number; signal?: AbortSignal },
  ) => Promise<CombatClientResult>;
  /**
   * 结算叙事短调用（narrateSettlement）——纯文本，不走工具。
   * 🔴 契约与 AgentClient.chat 对齐：**对象形状** `{ messages }`，不是裸数组。
   *    2026-08-12 真机 debug：此前接口声明数组、AgentClient.chat 收对象，
   *    于是 `request.messages` 是 undefined → ensureUserMessage 里 `messages.length`
   *    抛「Cannot read properties of undefined (reading 'length')」，结算叙事每次必败。
   */
  chat: (request: {
    messages: Array<{ role: string; content: string }>;
  }) => Promise<CombatClientResult>;
}

interface CombatClientResult {
  output: string | null;
  rawResponse: string;
  tokensUsed: number;
  cacheHit: boolean;
  duration: number;
  error?: string;
  /**
   * 🆕 决策 1A 持久会话：chatWithTools 回合内的工具往返历史（name/arguments/result 按执行序）。
   * 生产来自 agent-client 的 AgentResult.toolCalls；coordinator 用它把工具往返回流进
   * 持久消息数组（查询结果随之保留进历史）。仅 chatWithTools 路径填充。
   */
  toolCalls?: Array<{ name: string; arguments: unknown; result?: unknown }>;
  /** Successful tool-loop transcript delta with provider-native continuation blocks. */
  continuationMessages?: import('../types/types-api').LlmMessage[];
}
