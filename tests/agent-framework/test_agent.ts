/**
 * Agent 测试工具 Level 1 — 调提示词
 *
 * 用法:
 *   npx tsx tests/agent-framework/test_agent.ts --agent vars_update --save fixtures/test_save_progressive.json --dry-run
 *   npx tsx tests/agent-framework/test_agent.ts --agent story --save fixtures/test_save_progressive.json -v --api-url https://... --api-key sk-xxx --model deepseek-chat
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { buildAgentMessages } from '../../src/sillytavern/agent-templates.js';
import { AgentClient, type ChatRequest } from '../../src/sillytavern/agent-client.js';
import { getToolsForAgent, executeToolCall } from '../../src/sillytavern/agent-tools.js';
import type { AgentContext, ToolExecutionContext, CharacterState } from '../../src/sillytavern/types.js';

// ═══════════════════════════════════════
// CLI 参数
// ═══════════════════════════════════════
const { values: args } = parseArgs({
  options: {
    agent:    { type: 'string', short: 'a' },
    save:     { type: 'string', short: 's' },
    'api-url':  { type: 'string' },
    'api-key':  { type: 'string' },
    model:    { type: 'string', short: 'm' },
    'endpoint-id': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    verbose:  { type: 'boolean', short: 'v', default: false },
    upstream: { type: 'boolean', default: false },
    output:   { type: 'string', short: 'o' },
    'help':   { type: 'boolean', short: 'h' },
  },
});

if (args.help || !args.agent || !args.save) {
  console.log(`
Agent 测试工具 — 加载测试存档, 构建上下文, 调用 LLM, 校验输出格式

用法:
  npx tsx test_agent.ts --agent <id> --save <path> [options]

必填:
  --agent, -a     Agent ID (story|vars_update|char_update|memory_summary|craft_gen|char_gen|item_gen)
  --save, -s      测试存档 JSON 文件

API 配置:
  --api-url       LLM API 地址 (默认 http://localhost:1234/v1)
  --api-key       API Key (默认 not-needed)
  --model, -m     模型名 (默认 gpt-3.5-turbo)
  --endpoint-id   从存档 apiEndpoints 取第 N 个 (0-based), 与上述三个互斥

模式:
  --dry-run       只构建并打印 prompt, 不调 LLM
  --verbose, -v   打印工具调用追踪和详细输出
  --upstream      先跑 upstream agent 再跑目标 agent (如 vars_update 依赖 story)
  --output, -o    保存结果到 JSON 文件

示例:
  npx tsx test_agent.ts -a vars_update -s fixtures/test_save_progressive.json --dry-run
  npx tsx test_agent.ts -a story -s fixtures/test_save_progressive.json -v --api-url https://api.deepseek.com/v1 --api-key sk-xxx -m deepseek-chat
  npx tsx test_agent.ts -a vars_update --upstream -s fixtures/test_save_progressive.json -v
`);
  process.exit(0);
}

const API_URL = args['api-url'] || 'http://localhost:1234/v1';
const API_KEY = args['api-key'] || 'not-needed';
const MODEL = args.model || 'gpt-3.5-turbo';
const SAVE_PATH = args.save;
const AGENT_ID = args.agent;
const DRY_RUN = args['dry-run'];
const VERBOSE = args.verbose;
const DO_UPSTREAM = args.upstream;
const OUTPUT_PATH = args.output;

// ═══════════════════════════════════════
// 校验函数（内联，纯正则/JSON）
// ═══════════════════════════════════════
interface ValidationResult { valid: boolean; errors: string[]; warnings: string[] }

function validateOutput(agentId: string, output: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = output.trim();

  switch (agentId) {
    case 'vars_update': {
      try {
        const d = JSON.parse(text);
        if (d.replace && !Array.isArray(d.replace)) errors.push('replace 应为数组');
        if (d.delta && !Array.isArray(d.delta)) errors.push('delta 应为数组');
        if (d.insert && !Array.isArray(d.insert)) errors.push('insert 应为数组');
        if (d.delta_time !== undefined && typeof d.delta_time !== 'number') warnings.push('delta_time 不是数字');
      } catch { errors.push('JSON 解析失败'); }
      break;
    }
    case 'char_update': {
      try {
        const d = JSON.parse(text);
        if (!d.characters || !Array.isArray(d.characters)) errors.push('缺少 characters 数组');
        else d.characters.forEach((c: any, i: number) => {
          if (!c.id) errors.push(`characters[${i}] 缺 id`);
          if (!c.changes || typeof c.changes !== 'object') errors.push(`characters[${i}] 缺 changes`);
        });
      } catch { errors.push('JSON 解析失败'); }
      break;
    }
    case 'memory_summary': {
      try {
        const d = JSON.parse(text);
        if (!d.content) errors.push('缺 content');
        else if (d.content.length < 200) warnings.push(`content 长度 ${d.content.length} < 200 字`);
        if (!d.hiddenLine) errors.push('缺 hiddenLine');
        if (!Array.isArray(d.keywords)) errors.push('keywords 应为数组');
        if (d.importance !== undefined && (d.importance < 1 || d.importance > 10)) warnings.push('importance 不在 1-10');
        if (!d.timeRangeStart) warnings.push('缺 timeRangeStart');
        if (!d.timeRangeEnd) warnings.push('缺 timeRangeEnd');
      } catch { errors.push('JSON 解析失败'); }
      break;
    }
    case 'story':
      for (const tag of ['maintext', 'option', 'sum']) {
        if (!text.includes(`<${tag}>`)) errors.push(`缺 <${tag}> 标签`);
      }
      break;
    case 'craft_gen':
      if (!/<craft_result>/.test(text)) errors.push('未找到 <craft_result>');
      else for (const tag of ['success', 'product_name', 'quality', 'check_summary', 'creative_effects', 'narrative']) {
        if (!new RegExp(`<${tag}>`).test(text)) errors.push(`缺 <${tag}> 标签`);
      }
      break;
    case 'char_gen':
      if (!/<char_result>/.test(text)) errors.push('未找到 <char_result>');
      else for (const tag of ['name', 'race', 'tier', 'attributes', 'background', 'appearance', 'personality']) {
        if (!new RegExp(`<${tag}[^>]*>`).test(text)) errors.push(`缺 <${tag}> 标签`);
      }
      break;
    case 'item_gen':
      if (!/<item_result>/.test(text)) errors.push('未找到 <item_result>');
      else for (const tag of ['skills', 'equipment', 'inventory']) {
        if (!new RegExp(`<${tag}>`).test(text)) errors.push(`缺 <${tag}> 标签`);
      }
      break;
    default:
      warnings.push(`未知 agent: ${agentId}, 跳过校验`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

// ═══════════════════════════════════════
// 上下文构建
// ═══════════════════════════════════════
function buildContextFromSave(backup: any, overrideUserInput?: string): AgentContext {
  const chat = backup.chats?.[0];
  if (!chat) throw new Error('存档中没有 ChatSession');

  const messages = chat.messages || [];
  // 最后一条 user 消息作为当前输入，其余为历史
  const lastUserIdx = [...messages].reverse().findIndex((m: any) => m.role === 'user');
  const lastUserMsg = lastUserIdx >= 0 ? messages[messages.length - 1 - lastUserIdx] : null;
  const userInput = overrideUserInput || (lastUserMsg?.content || '');
  const history = lastUserMsg
    ? messages.slice(0, messages.indexOf(lastUserMsg))
    : messages.slice(0, -1);

  return {
    userInput,
    history: history.map((m: any) => ({ role: m.role, content: m.content })),
    lorebookMatches: [],
    worldBooks: [],
    characters: (backup.characters || []) as CharacterState[],
    variables: chat.variables || {},
    plotEvents: backup.plotEvents || [],
    memories: backup.memories || [],
    agentOutputs: new Map(),
    saveId: backup.saves?.[0]?.id || 'test-save',
  };
}

function log(verbose: boolean, msg: string) {
  if (verbose) console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
}

// ═══════════════════════════════════════
// 主流程
// ═══════════════════════════════════════
async function main() {
  // 1. 加载存档
  log(VERBOSE, `Loading save: ${SAVE_PATH}`);
  const backup = JSON.parse(fs.readFileSync(SAVE_PATH, 'utf-8'));
  const ctx = buildContextFromSave(backup);

  log(VERBOSE, `Context: ${ctx.characters.length} chars, ${ctx.memories.length} memories, ${ctx.plotEvents.length} plot events, ${backup.chats?.length || 0} chats`);

  // 2. 如果 --endpoint-id，从存档取 API 配置
  let apiUrl = API_URL;
  let apiKey = API_KEY;
  let model = MODEL;
  if (args['endpoint-id'] !== undefined) {
    const idx = parseInt(args['endpoint-id']);
    const ep = backup.apiEndpoints?.[idx];
    if (ep) {
      apiUrl = ep.baseUrl; apiKey = ep.apiKey; model = ep.defaultModel || model;
      log(VERBOSE, `Using endpoint[${idx}]: ${ep.name || apiUrl}`);
    } else {
      console.error(`apiEndpoints[${idx}] 不存在, 使用 CLI 默认值`);
    }
  }

  if (DRY_RUN) {
    // 3a. 干跑模式：构建并打印
    const msgs = buildAgentMessages(AGENT_ID, ctx);
    if (!msgs) { console.error(`未知 Agent: ${AGENT_ID}`); process.exit(1); }
    for (const m of msgs) {
      console.log(`\n=== ${m.role.toUpperCase()} (${m.content.length} chars) ===`);
      console.log(m.content.substring(0, 4000));
      if (m.content.length > 4000) console.log(`... [截断, 总长 ${m.content.length} chars]`);
    }
    // 也打印工具（如果是 Agentic agent）
    const tools = getToolsForAgent(AGENT_ID);
    if (tools.length > 0) console.log(`\n=== TOOLS (${tools.length}) ===\n${tools.map(t => t.function.name).join(', ')}`);
    return;
  }

  // 3b. --upstream: 先跑 story
  if (DO_UPSTREAM) {
    const upstreamId = AGENT_ID === 'vars_update' || AGENT_ID === 'char_update' || AGENT_ID === 'memory_summary' ? 'story'
      : AGENT_ID === 'item_gen' ? 'char_gen' : null;
    if (upstreamId) {
      log(VERBOSE, `[upstream] Running ${upstreamId} first...`);
      const upClient = new AgentClient({ endpoint: { baseUrl: apiUrl, apiKey, defaultModel: model, id: 'up', name: 'up', provider: 'custom', models: [model], timeout: 120 }, agentId: upstreamId, saveId: ctx.saveId || 'test' });
      const upMsgs = buildAgentMessages(upstreamId, ctx);
      if (upMsgs) {
        const upReq: ChatRequest = { messages: upMsgs, temperature: 0.7, maxTokens: 4096 };
        const upResult = await upClient.chat(upReq);
        if (upResult.output) {
          ctx.agentOutputs!.set(upstreamId, upResult.output);
          log(VERBOSE, `[upstream] ${upstreamId}: tokens=${upResult.tokensUsed} cache=${upResult.cacheHit} duration=${upResult.duration}ms`);
          if (VERBOSE) console.log(`[upstream output, ${upResult.output.length} chars]:\n${upResult.output.substring(0, 500)}\n...`);
        }
      }
    }
  }

  // 4. 构建目标 Agent 的消息
  log(VERBOSE, `Agent: ${AGENT_ID} | API: ${model} @ ${apiUrl}`);
  const msgs = buildAgentMessages(AGENT_ID, ctx);
  if (!msgs) { console.error(`未知 Agent: ${AGENT_ID}`); process.exit(1); }
  log(VERBOSE, `System prompt: ${msgs[0]?.content.length || 0} chars`);
  if (msgs.length > 1) log(VERBOSE, `User message: ${msgs[1]?.content.length || 0} chars`);

  // 5. 创建 client 并调用
  const client = new AgentClient({
    endpoint: { id: 'test', name: 'test', baseUrl: apiUrl, apiKey, defaultModel: model, provider: 'custom', models: [model], timeout: 120 },
    agentId: AGENT_ID,
    saveId: ctx.saveId || 'test',
  });

  const tools = getToolsForAgent(AGENT_ID);
  const isAgentic = tools.length > 0;
  if (isAgentic) log(VERBOSE, `Agentic mode: ${tools.length} tools (${tools.map(t => t.function.name).join(', ')})`);

  const result = isAgentic
    ? await (async () => {
        const toolCtx: ToolExecutionContext = { characters: ctx.characters, variables: ctx.variables, saveId: ctx.saveId || 'test-save' };
        const req: ChatRequest = { messages: msgs, temperature: 0.7, maxTokens: 4096, tools };
        return client.chatWithTools(req, (name, args) => {
          const r = executeToolCall(name, args, toolCtx);
          if (VERBOSE) {
            const a = JSON.stringify(args).substring(0, 120);
            const res = JSON.stringify(r).substring(0, 200);
            log(VERBOSE, `  [TOOL] ${name}(${a}) → ${res}`);
          }
          return Promise.resolve(r);
        }, { maxRounds: 5 });
      })()
    : await (async () => {
        const req: ChatRequest = { messages: msgs, temperature: 0.7, maxTokens: 4096 };
        return client.chat(req);
      })();

  // 6. 校验 + 打印结果
  const validation = validateOutput(AGENT_ID, result.output || '');
  const status = validation.valid ? '✅' : '❌';
  if (VERBOSE) {
    console.log(`\n--- LLM Response (${(result.output || '').length} chars) ---`);
    console.log(result.output?.substring(0, 3000));
    if ((result.output || '').length > 3000) console.log('... [截断]');
  }
  if (VERBOSE) {
    console.log(`\n--- Validation ---`);
    console.log(`${status} ${AGENT_ID}: valid=${validation.valid}`);
    for (const e of validation.errors) console.log(`  ❌ ${e}`);
    for (const w of validation.warnings) console.log(`  ⚠️ ${w}`);
  }
  console.log(`${status} ${AGENT_ID}: tokens=${result.tokensUsed} cache=${result.cacheHit} duration=${(result.duration / 1000).toFixed(1)}s errors=${validation.errors.length} warnings=${validation.warnings.length}`);
  if (result.error) console.log(`  Error: ${result.error}`);

  // 7. 保存输出
  if (OUTPUT_PATH) {
    const outputData = {
      agentId: AGENT_ID, saveFile: SAVE_PATH, model,
      messages: msgs,
      response: { output: result.output, rawResponse: result.rawResponse, tokensUsed: result.tokensUsed, cacheHit: result.cacheHit, duration: result.duration, error: result.error },
      validation,
      toolCalls: result.toolCalls || [],
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outputData, null, 2), 'utf-8');
    log(VERBOSE, `Output saved: ${OUTPUT_PATH}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
