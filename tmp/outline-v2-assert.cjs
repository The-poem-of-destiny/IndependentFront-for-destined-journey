// outline-v2-assert.cjs — verify plot_outline systemPrompt + template anchors

const fs = require('fs');
const path = require('path');

const configPath = path.resolve(__dirname, '..', 'data', 'defaults', 'agent-config.json');
const raw = fs.readFileSync(configPath, 'utf8');
const cfg = JSON.parse(raw);

const plotOutline = cfg.agents.plot_outline;
if (!plotOutline) {
  console.error('FAIL: plot_outline not found in cfg.agents');
  process.exit(1);
}

const sp = plotOutline.systemPrompt || '';
const tpl = plotOutline.template || '';

let failures = 0;
function check(label, ok) {
  if (!ok) { console.error('FAIL:', label); failures++; }
  else { console.log('PASS:', label); }
}

// 1. systemPrompt contains 5 key sections
check('1a sp contains "核心原则"', sp.includes('核心原则'));
check('1b sp contains "创作规范"', sp.includes('创作规范'));
check('1c sp contains "工作流程"', sp.includes('工作流程'));
check('1d sp contains "输出格式"', sp.includes('输出格式'));
check('1e sp contains "绝对禁止"', sp.includes('绝对禁止'));

// 2. systemPrompt references context block names
check('2a sp references "角色背景"', sp.includes('角色背景'));
check('2b sp references "剧情配置"', sp.includes('剧情配置'));
check('2c sp references "世界设定"', sp.includes('世界设定'));
check('2d sp references "用户指令"', sp.includes('用户指令'));

// 3. systemPrompt must NOT contain old in-game generation references
check('3a sp does NOT contain "世界线重生成"', !sp.includes('世界线重生成'));
check('3b sp does NOT contain "年度生成"', !sp.includes('年度生成'));
check('3c sp does NOT contain "三种场景"', !sp.includes('三种场景'));
check('3d sp does NOT contain "游戏内"', !sp.includes('游戏内'));

// 4. systemPrompt contains output XML example tags
check('4a sp contains "outline"', sp.includes('outline'));
check('4b sp contains "self_critique"', sp.includes('self_critique'));
check('4c sp contains "timerange"', sp.includes('timerange'));

// 5. systemPrompt contains time format spec
check('5 sp contains "春、夏、秋、冬"', sp.includes('春、夏、秋、冬'));

// 6. template contains placeholder tags
check('6a tpl contains {{SYS_PROMPT}}', tpl.includes('{{SYS_PROMPT}}'));
check('6b tpl contains {{CHARACTER_STATE}}', tpl.includes('{{CHARACTER_STATE}}'));
check('6c tpl contains {{PLOT_EVENTS}}', tpl.includes('{{PLOT_EVENTS}}'));
check('6d tpl contains {{LORE_BOOK}}', tpl.includes('{{LORE_BOOK}}'));
check('6e tpl contains {{USER_INPUT}}', tpl.includes('{{USER_INPUT}}'));

// 7. template contains XML sections
check('7a tpl contains <角色背景>', tpl.includes('<角色背景>'));
check('7b tpl contains <剧情配置>', tpl.includes('<剧情配置>'));
check('7c tpl contains <世界设定>', tpl.includes('<世界设定>'));
check('7d tpl contains <用户指令>', tpl.includes('<用户指令>'));

// 8. template contains comment blocks
check('8 tpl contains <!-- markers', tpl.includes('<!--'));

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll assertions PASSED');
