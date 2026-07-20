// tmp/chapter-config-apply.cjs
// Reads data/defaults/agent-config.json, modifies plot_outline systemPrompt
// to use user-configurable chapter/event counts instead of hardcoded ranges.

const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'data', 'defaults', 'agent-config.json');
const raw = fs.readFileSync(filePath, 'utf-8');
const obj = JSON.parse(raw);

const prompt = obj.agents.plot_outline.systemPrompt;

// 1. Replace the "章节与事件数量" section
const oldSection = `## 章节与事件数量
- **主线（main）**: 3-5 章，每章 3-5 个关键事件
- **支线（side）**: 1-3 章，每章 2-4 个关键事件`;

const newSection = `## 章节与事件数量
- 章节数量和每章事件数由用户配置（见 <剧情配置> 区块中的「章节数量」和「每章事件」参数）。
  「自动」模式下，你根据剧情复杂度和持续年份自行判断：剧情越长、年份越久 → 章节和事件越多。
  用户未明确配置时（<剧情配置> 不含相关字段），主线默认 3-5 章每章 3-5 事件，支线默认 1-3 章每章 2-4 事件。`;

if (!prompt.includes(oldSection)) {
  console.error('ERROR: old "章节与事件数量" section not found!');
  process.exit(1);
}

let newPrompt = prompt.replace(oldSection, newSection);

// 2. Update the self-check item #7
const oldCheck = '7. ☐ 章节数量在范围内（主线 3-5 / 支线 1-3）？';
const newCheck = '7. ☐ 章节数量在用户配置 / 自动判断的合理范围内？';

if (!newPrompt.includes(oldCheck)) {
  console.error('ERROR: old self-check item #7 not found!');
  process.exit(1);
}

newPrompt = newPrompt.replace(oldCheck, newCheck);

obj.agents.plot_outline.systemPrompt = newPrompt;

fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
console.log('OK: agent-config.json updated successfully');
