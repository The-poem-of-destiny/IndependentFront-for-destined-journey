# Agent 测试工具 Level 1

调提示词专用。加载测试存档 → 构建 Agent 上下文 → 调 LLM → 校验输出格式。

## 快速开始

```bash
# 干跑 — 看构建的 prompt（不调 LLM）
npx tsx test_agent.ts -a vars_update -s fixtures/test_save_progressive.json --dry-run

# 调 LLM
npx tsx test_agent.ts -a story -s fixtures/test_save_progressive.json \
  --api-url https://api.deepseek.com/v1 --api-key sk-xxx -m deepseek-chat -v

# 上游注入 — 先跑 story 再跑 vars_update
npx tsx test_agent.ts -a vars_update --upstream -s fixtures/test_save_progressive.json -v --api-url ... --api-key ...

# 保存结果
npx tsx test_agent.ts -a vars_update -s fixtures/test_save_progressive.json -v -o result.json
```

## 支持的模式

| Agent | 类型 | --upstream 跑什么 |
|-------|------|------------------|
| story | 常规 | 无 |
| vars_update | 常规 | story |
| char_update | 常规 | story |
| memory_summary | 常规 | story |
| craft_gen | Agentic (10 tools) | 无 |
| char_gen | Agentic (10 tools) | 无 |
| item_gen | Agentic (6 tools) | char_gen |

## 文件结构

```
tests/agent-framework/
├── test_agent.ts              ← CLI 入口
├── build_test_save.ts         ← 生成测试存档
├── fixtures/
│   └── test_save_progressive.json
└── README.md
```
