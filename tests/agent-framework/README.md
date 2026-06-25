# Agent 测试工具 Level 1

调提示词专用。加载测试存档 → 构建 Agent 上下文 → 调 LLM → 校验输出格式。

## 快速开始

```bash
# 干跑 — 看构建的 prompt（不调 LLM）
npx tsx test_agent.ts -a vars_update -s fixtures/test_save_progressive.json --dry-run

# 调 LLM
npx tsx test_agent.ts -a vars_update -s fixtures/test_save_progressive.json \
  --api-url https://api.deepseek.com --api-key sk-xxx -m deepseek-v4-flash -v

# 上游注入 — 先跑 story 再跑 vars_update（自动注入存档中最后一条 assistant 消息）
npx tsx test_agent.ts -a vars_update --upstream -s fixtures/test_save_progressive.json -v

# 保存结果到文件
npx tsx test_agent.ts -a vars_update -s fixtures/test_save_progressive.json -v -o result.json

# 使用存档中的 apiEndpoints（--endpoint-id 0 取第 0 个）
npx tsx test_agent.ts -a char_gen -s fixtures/test_save_progressive.json --endpoint-id 0 -v
```

## 特性

- **自动读浏览器配置**: 从 `data/defaults/agent-config.json` 读取主人保存为默认的 worldBookIds/model/presetId
- **自动加载世界书**: 根据 agent 配置的 worldBookIds，从 `data/worldbooks/` 加载对应文件注入 prompt
- **DeepSeek 思考模式**: 自动传 `thinking: { type: 'enabled' }`，返回的推理链注入 `response.reasoning`
- **上游注入**: `--upstream` 自动跑 story→下游链；不传 `--upstream` 时自动从存档最后一条 assistant 消息注入 story 输出

## 支持的 Agent

| Agent | 类型 | --upstream 跑什么 | 工具数 |
|-------|------|------------------|--------|
| story | 常规 | 无 | - |
| vars_update | 常规 | story | - |
| char_update | 常规 | story | - |
| memory_summary | 常规 | story | - |
| craft_gen | Agentic | 无 | 10 |
| char_gen | Agentic | 无 | 10 |
| item_gen | Agentic | char_gen | 6 |

## 存档生成

```bash
# 重新生成测试存档（含世界书数据）
npx tsx tests/agent-framework/build_test_save.ts
```

## 文件结构

```
tests/agent-framework/
├── test_agent.ts              ← CLI 入口
├── build_test_save.ts         ← 生成测试存档（含世界书）
├── fixtures/
│   ├── test_save_progressive.json   ← 5轮渐进存档（含世界书）
│   └── vars_update_result.json      ← 测试结果样例
└── README.md
```
