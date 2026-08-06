---
name: preset-setvar-value-no-braces
description: story 预设里 {{setvar::名::值}} 的「值」不能含 }，所以不能嵌 {{user}}/{{char}} —— 而官方创作指南给的正是这个坏例子
metadata:
  type: project
---

写 story 预设条目时，`{{setvar::变量名::变量值}}` 的**变量值里不许出现 `}`**，因此
**不能把 `{{user}}` / `{{char}}` 嵌进 setvar 的值**。要嵌就用纯文字改写。

**Why:** `preset-loader.ts` 的 parseSetvars 正则把值写成 `([^}]*)` —— 遇到 `{{user}}` 的第一个
`}` 就收尾，于是 setvar 记下一个被腰斩的值，`}做选择和行动}}` 那截残骸留在提示词里原样发给模型。
**不报错、测试不会红**，症状只是提示词里多出一行乱码、`{{getvar}}` 取到半句话。
坑在于 `docs/reference/story_preset_format.md` 的示例写的正是
`{{setvar::抢话::允许代替{{user}}做选择和行动}}` —— **文档给的就是坏例子**，照抄即中招。

**How to apply:** 新写或修改 story 预设条目（含 D27 占位预设
`data/placeholder/defaults/story-preset.json`）时，setvar 的值保持纯文字。改完用
「排序 → 逐条 preprocessEntry → 看还剩哪些 `{{...}}`」跑一遍模拟即可验证：
残留应当**只有**系统占位符（大写那批，见 preprocessEntry 的 SYSTEM_RE 白名单），
setvar/getvar 一个都不该剩。

相关：[[story-prompt-lives-in-preset]]（story 的行为真源是预设条目，不是 systemPrompt）。
