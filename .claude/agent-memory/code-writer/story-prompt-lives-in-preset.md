---
name: story-prompt-lives-in-preset
description: 改 story 提示词别写 agents.story.systemPrompt（它是空的且会被预设短路）；真源是预设条目，且启用位看条目自身 enabled 而不是 prompt_order
metadata:
  type: feedback
---

改 story agent 的系统提示词，**唯一有效的落点是 `agents.story.preset.settings.prompts[]` 里某个条目的 `content`**，不是 `agents.story.systemPrompt`。

**Why:** `agent-templates.buildAgentMessages` 对 story 先跑 `assemblePresetContent`，拿到内容就**短路**（`if (!sysPromptContent && config?.systemPrompt)`）。默认配置里 `agents.story.systemPrompt` 是空串，预设永远命中 → 往 systemPrompt 里写字是**死文本**。更糟的是反向：把内容写进去会在「用户没有预设」那条兜底路径上，用一句话**顶掉** `STORY_TEMPLATE.fixedSystem + fixedExamples` 整份兜底提示词。设计文档（2026-08-04 图像生成 §13）写的「story 的 systemPrompt 只加一句话」按字面执行是错的。

**How to apply:** 选条目前先算「哪些条目真的进了提示词」——`assemblePresetContent` 过滤的是**条目自身的 `enabled`**、排序用 `injection_order`，**完全不读 `prompt_order`**。默认 story 预设里两者有约 30 处不一致（例如 `⚙️SETTING`、`📑时间地点天气栏` 在 `prompt_order` 里是 true，条目 `enabled: false` → 实际没进提示词；101 个条目只有 32 个进）。写之前用脚本按 `enabled !== false` 列一遍，别照着预设 UI 的勾选状态判断。教 marker 的现役条目是 `🚫正文cot`（`<content_output>`，item_info/task_info 的触发规则在这里）与 `🌐COT`（craft_request/char_detect 在思维链 Step 5/7）。

文件是 400KB 单行 JSON —— 用 Edit 按转义后的原文（`\n`、`\"`）改，别 `json.load`+`json.dump` 往返，那会把整份重排。
