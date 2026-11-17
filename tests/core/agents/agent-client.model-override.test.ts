/**
 * agent-client.ts — Agent 级模型覆写在三协议下都真的打到上游（回归测试）。
 *
 * 缺陷：Gemini 请求体里没有 `model`，BFF 只从 `X-Model-ID` 头拼上游 URL，
 * 而这个头此前写死 `endpoint.defaultModel` —— 给 Agent 单独指定的模型在 Gemini 下
 * 静默落回源默认模型。OpenAI 兼容 / Anthropic 把模型写在请求体里，不受影响。
 *
 * 这里把 AgentClient 实际发出的请求原样交给真实 BFF（`buildHonoApp`），
 * 再由本地回显服务报告上游收到的 URL 与请求体，断言整条链路用的是覆写模型。
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../../../src/core/agents/agent-client';
import type { ApiEndpoint } from '../../../src/core/types/types';
import type { LlmProtocol } from '../../../src/core/types/types-api';
import { buildHonoApp } from '../../../server/app';

const DEFAULT_MODEL = 'source-default-model';
const OVERRIDE_MODEL = 'agent-override-model';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

/** 上游替身：回显收到的路径与请求体 */
async function echoUpstream(): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({ url: request.url, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function makeEndpoint(protocol: LlmProtocol, baseUrl: string): ApiEndpoint {
  return {
    id: `ep_${protocol}`,
    name: `Test ${protocol}`,
    provider: 'custom',
    kind: 'llm',
    protocol,
    baseUrl,
    apiKey: 'sk-model-override',
    defaultModel: DEFAULT_MODEL,
    models: [DEFAULT_MODEL, OVERRIDE_MODEL],
    timeout: 60000,
  } as ApiEndpoint;
}

const JSON_RESPONSES: Record<LlmProtocol, unknown> = {
  'openai-chat': { choices: [{ message: { content: '好' }, finish_reason: 'stop' }] },
  gemini: {
    candidates: [{ content: { role: 'model', parts: [{ text: '好' }] }, finishReason: 'STOP' }],
  },
  'anthropic-messages': { content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn' },
};

const SSE_TEXT: Record<LlmProtocol, string> = {
  'openai-chat':
    'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  gemini:
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"好"}]},"finishReason":"STOP"}]}\n\n',
  'anthropic-messages': [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join(''),
};

/** 截获 AgentClient 发往 BFF 的请求，回一个协议对应的成功响应 */
function captureFetch(protocol: LlmProtocol, stream: boolean) {
  return vi.fn(async (_url: string, _init: RequestInit) => {
    if (!stream) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async (): Promise<unknown> => JSON_RESPONSES[protocol],
        text: async (): Promise<string> => JSON.stringify(JSON_RESPONSES[protocol]),
      };
    }
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(SSE_TEXT[protocol]));
          controller.close();
        },
      }),
      text: async (): Promise<string> => '',
    };
  });
}

/** 把截获的请求原样交给真实 BFF，返回上游回显 */
async function replayThroughBff(url: string, init: RequestInit) {
  const response = await buildHonoApp().request(url, {
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body as string,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { url: string; body: string };
}

const MESSAGES = [
  { role: 'system' as const, content: '你是叙事者' },
  { role: 'user' as const, content: '走进铁匠铺' },
];

describe('Agent 级模型覆写打到上游', () => {
  for (const protocol of ['gemini', 'openai-chat', 'anthropic-messages'] as const) {
    for (const stream of [false, true]) {
      it(`${protocol} ${stream ? '流式' : '非流式'}：上游用的是覆写模型而不是源默认`, async () => {
        const upstream = await echoUpstream();
        const fetchMock = captureFetch(protocol, stream);
        vi.stubGlobal('fetch', fetchMock);
        const client = new AgentClient({
          endpoint: makeEndpoint(protocol, upstream),
          agentId: 'story',
          saveId: 'save-model-override',
          maxRetries: 0,
        });

        if (stream) {
          await new Promise<void>((resolve, reject) => {
            void client.chatStream(
              { messages: MESSAGES, model: OVERRIDE_MODEL },
              {
                onChunk: () => {},
                onComplete: () => resolve(),
                onError: (error) => reject(new Error(error)),
              },
            );
          });
        } else {
          await client.chat({ messages: MESSAGES, model: OVERRIDE_MODEL });
        }

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];

        // 放开真实 fetch，让 BFF 去打回显上游
        vi.unstubAllGlobals();
        const echoed = await replayThroughBff(url, init);
        if (protocol === 'gemini') {
          // Gemini 的模型只在 URL 里，BFF 从 X-Model-ID 头取
          expect((init.headers as Record<string, string>)['X-Model-ID']).toBe(OVERRIDE_MODEL);
          expect(echoed.url).toContain(`/models/${OVERRIDE_MODEL}:`);
          expect(echoed.url).not.toContain(DEFAULT_MODEL);
        } else {
          // 另两种协议的模型在请求体里，BFF 原样转发
          expect(JSON.parse(echoed.body).model).toBe(OVERRIDE_MODEL);
        }
      });
    }
  }

  it('gemini 未覆写时仍用源默认模型', async () => {
    const upstream = await echoUpstream();
    const fetchMock = captureFetch('gemini', false);
    vi.stubGlobal('fetch', fetchMock);
    const client = new AgentClient({
      endpoint: makeEndpoint('gemini', upstream),
      agentId: 'story',
      saveId: 'save-model-override',
      maxRetries: 0,
    });

    await client.chat({ messages: MESSAGES });

    const [url, init] = fetchMock.mock.calls[0];
    vi.unstubAllGlobals();
    const echoed = await replayThroughBff(url, init);
    expect(echoed.url).toBe(`/models/${DEFAULT_MODEL}:generateContent`);
  });
});
