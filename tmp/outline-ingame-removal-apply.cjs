// 大纲改为仅开局生成 — agent-config.json 手术
const fs = require('fs')

// 1. 备份
fs.copyFileSync('data/defaults/agent-config.json', 'tmp/agent-config.pre-outline-ingame-removal.bak')
console.log('backup: tmp/agent-config.pre-outline-ingame-removal.bak')

const cfg = JSON.parse(fs.readFileSync('data/defaults/agent-config.json', 'utf-8'))

// ===== plot_outline =====
const po = cfg.agents.plot_outline

// 改 template → 裸 {{SYS_PROMPT}}
const oldTemplate = po.template
po.template = '{{SYS_PROMPT}}'
console.log('template: "' + oldTemplate.replace(/\n/g, '\\n') + '" → "' + po.template + '"')

// 改 systemPrompt: 替换场景描述段
const oldSceneBlock = '你会在三种场景下被调用：\n1. **初次生成**（捏人页/游戏内支线年度生成）——从零创作一份新大纲\n2. **世界线重生成**——剧情发生重大变动后，基于新的世界状态重写大纲\n3. **修改模式（重 roll）**——用户对上一版大纲提出修改要求，你在保留其余部分的基础上定向重写（见下方「修改模式」区块）'
const newSceneBlock = '你只在捏人页（角色创建时）被调用，游戏内不再调用本 Agent。大纲只在开局生成一次，后续大纲演化由 plot_post_check 的 outlineChanges 维护。你会在两种场景下被调用：\n1. **初次生成**——从零创作一份新大纲（主线/支线均在捏人页生成）\n2. **修改模式（重 roll）**——用户对上一版大纲提出修改要求，你在保留其余部分的基础上定向重写（见下方「修改模式」区块）'

if (po.systemPrompt.includes(oldSceneBlock)) {
  po.systemPrompt = po.systemPrompt.replace(oldSceneBlock, newSceneBlock)
  console.log('plot_outline sp: replaced scene block')
} else {
  console.error('ERROR: old scene block not found in plot_outline systemPrompt!')
  console.log('First 350 chars:', po.systemPrompt.slice(0, 350))
  process.exit(1)
}

// ===== plot_post_check =====
const ppc = cfg.agents.plot_post_check

// 强化 outlineChanges 章节 — 在 "# outlineChanges 规则" 后插入唯一维护者注记
const oldOutlineChangesHeader = '# outlineChanges 规则\n\n- action 只有 none / update 两种'
const newOutlineChangesHeader = '# outlineChanges 规则\n\n> ⚠️ **大纲演化唯一维护者**: 从游戏开始后，大纲不再由 plot_outline 在游戏内重新生成——你是唯一能修改大纲的 Agent。当世界线发生变动时，你**必须**主动通过 outlineChanges 保持大纲与现实一致。不要等待或假设大纲会被他人重新生成。\n\n- action 只有 none / update 两种'

if (ppc.systemPrompt.includes(oldOutlineChangesHeader)) {
  ppc.systemPrompt = ppc.systemPrompt.replace(oldOutlineChangesHeader, newOutlineChangesHeader)
  console.log('plot_post_check sp: strengthened outlineChanges section')
} else {
  console.error('ERROR: outlineChanges section not found in plot_post_check systemPrompt!')
  console.log('Searching for outlineChanges:')
  let idx = ppc.systemPrompt.indexOf('outlineChanges')
  console.log('First occurrence at:', idx, 'context:', ppc.systemPrompt.slice(Math.max(0, idx - 40), idx + 100))
  process.exit(1)
}

// 写回
fs.writeFileSync('data/defaults/agent-config.json', JSON.stringify(cfg, null, 2), 'utf-8')
console.log('written data/defaults/agent-config.json')
console.log('DONE')
