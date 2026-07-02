# Agent 测试工具 Level 1 (Phase 10 适配)

调提示词专用。加载测试存档 → 构建 Agent 上下文 → 调 LLM → 校验输出格式。

## Phase 10 变更

- **统一模板解析**: `buildAgentMessages()` 通过 `{{PLACEHOLDER}}` 模板系统解析，返回**单条 system 消息**
- **链式 localParams 注入**: craft_gen/char_gen/item_gen 的链数据 (CRAFT_REQUEST/CHAR_DETECT/ITEM_REQUEST) 通过 `localParams` 参数注入
- **模板来源追踪**: `--dry-run` 显示模板来源 (agent-config.json / placeholder-registry 默认 / legacy fallback)
- **SYS_PROMPT 来源追踪**: 显示 SYS_PROMPT 来自 preset / systemPrompt / fixedSystem 兜底
- **preset 加载**: story Agent 自动从 `data/defaults/agent-config.json` 加载 preset 数据

## 快速开始

```bash
# 干跑 — 看构建的 prompt（不调 LLM）
npx tsx test_agent.ts -a vars_update -s fixtures/test_save_progressive.json --dry-run

# 调 LLM
npx tsx test_agent.ts -a vars_update -s fixtures/test_save_progressive.json \
  --api-url https://api.deepseek.com --api-key sk-xxx -m deepseek-v4-flash -v

# 上游注入 — 先跑 story 再跑 vars_update（自动注入存档中最后一条 assistant 消息）
# Phase 10: 上游完成后重新提取 localParams 注入下游
npx tsx test_agent.ts -a vars_update --upstream -s fixtures/test_save_progressive.json -v

# 链式 Agent 测试 (story → char_gen → item_gen)
npx tsx test_agent.ts -a item_gen --upstream -s fixtures/item_gen_input_fixture.json -v

# 保存结果到文件
npx tsx test_agent.ts -a vars_update -s fixtures/test_save_progressive.json -v -o result.json

# 使用存档中的 apiEndpoints（--endpoint-id 0 取第 0 个）
npx tsx test_agent.ts -a char_gen -s fixtures/test_save_progressive.json --endpoint-id 0 -v
```

## 特性

- **自动读浏览器配置**: 从 `data/defaults/agent-config.json` 读取主人保存为默认的 worldBookIds/model/presetId/systemPrompt/template
- **自动加载世界书**: 根据 agent 配置的 worldBookIds，从 `data/worldbooks/` 加载对应文件注入 prompt
- **DeepSeek 思考模式**: 自动传 `thinking: { type: 'enabled' }`，返回的推理链注入 `response.reasoning`
- **上游注入**: `--upstream` 自动跑上游链 (story→downstream / char_gen→item_gen)；上游完成后重新提取 localParams 注入下游
- **链式 localParams**: craft_gen/char_gen/item_gen 自动从 story 输出提取 markers，不传 `--upstream` 时从存档最后一条 assistant 消息提取
- **模板元数据**: `--output` 保存的 JSON 包含 templateMetadata (来源/未解析占位符)

## 支持的 Agent

| Agent | 类型 | --upstream 跑什么 | localParams 注入 | 工具数 |
|-------|------|------------------|-----------------|--------|
| story | 常规 | 无 | 无 (SYS_PROMPT via preset) | - |
| vars_update | 常规 | story | 无 (使用 AGENT.STORY) | - |
| char_update | 常规 | story | 无 (使用 AGENT.STORY) | - |
| memory_summary | 常规 | story | 无 (使用 AGENT.STORY) | - |
| craft_gen | Agentic | story (提取 CRAFT_REQUEST) | CRAFT_REQUEST | 10 |
| char_gen | Agentic | story (提取 CHAR_DETECT) | CHAR_DETECT | 10 |
| item_gen | Agentic | char_gen (提取 ITEM_REQUEST+CHAR_GEN_RESULT) | ITEM_REQUEST, CHAR_GEN_RESULT | 6 |

## 存档生成

```bash
# 重新生成测试存档（含世界书数据 + story preset）
npx tsx tests/agent-framework/build_test_save.ts
```

## 文件结构

```
tests/agent-framework/
├── test_agent.ts              ← CLI 入口 (Phase 10 适配)
├── build_test_save.ts         ← 生成测试存档（含 worldbooks + preset）
├── fixtures/
│   ├── test_save_progressive.json   ← 5轮渐进存档（含世界书 + story preset）
│   ├── craft_gen_test.json          ← 制作测试存档
│   ├── item_gen_input_fixture.json  ← item_gen 测试存档（含 char_gen 注入数据）
│   └── vars_update_result.json      ← 测试结果样例
├── .api-config.json           ← 本地 API 配置 (不提交 git)
└── README.md
```
