// tmp/chapter-config-assert.cjs
// Verify that the plot_outline systemPrompt was modified correctly.

const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'data', 'defaults', 'agent-config.json');
const raw = fs.readFileSync(filePath, 'utf-8');
const obj = JSON.parse(raw);
const prompt = obj.agents.plot_outline.systemPrompt;

let errors = [];

// Assert: old hardcoded ranges are gone
if (prompt.includes('3-5 章，每章 3-5 个关键事件')) {
  errors.push('FAIL: old hardcoded main chapter count still present');
}
if (prompt.includes('1-3 章，每章 2-4 个关键事件')) {
  errors.push('FAIL: old hardcoded side chapter count still present');
}

// Assert: new configurable text is present
if (!prompt.includes('用户配置（见 <剧情配置> 区块中的「章节数量」和「每章事件」参数）')) {
  errors.push('FAIL: new user-configurable chapter text not found');
}
if (!prompt.includes('「自动」模式下，你根据剧情复杂度和持续年份自行判断')) {
  errors.push('FAIL: auto-mode explanation not found');
}
if (!prompt.includes('用户未明确配置时（<剧情配置> 不含相关字段），主线默认 3-5 章每章 3-5 事件，支线默认 1-3 章每章 2-4 事件。')) {
  errors.push('FAIL: default fallback text not found');
}

// Assert: self-check item #7 updated
if (!prompt.includes('7. ☐ 章节数量在用户配置 / 自动判断的合理范围内？')) {
  errors.push('FAIL: self-check #7 was not updated');
}
if (prompt.includes('7. ☐ 章节数量在范围内（主线 3-5 / 支线 1-3）？')) {
  errors.push('FAIL: old self-check #7 still present');
}

if (errors.length === 0) {
  console.log('ALL ASSERTIONS PASSED');
} else {
  console.error(errors.join('\n'));
  process.exit(1);
}
