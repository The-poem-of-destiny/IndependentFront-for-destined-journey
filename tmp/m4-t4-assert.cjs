// M4 T4 assertion: fixedExamples 改名 + story char_detect 教学删除
const fs = require('fs');
let fail = 0;

// --- Part A: agent-templates.ts ---
const tpl = fs.readFileSync('E:/code/fated_poem_independent/src/sillytavern/agent-templates.ts', 'utf8');
if (tpl.includes('player_1')) { console.error('FAIL: agent-templates.ts 残留 player_1'); fail++; }
else console.log('OK: agent-templates.ts 无 player_1');

// 角色引用上下文（characters/owner 块）中不得再有 "id": 键；
// memories(MEM000001)/plotEvents(evt_01) 是引擎生成 id 的回显选择，保持 id 寻址（规范铁律1 例外面）
const exampleLits = [...tpl.matchAll(/fixedExamples:\s*'([^']*)'/g)].map(m => m[1]);
const charCtxWithId = exampleLits.filter(s => (s.includes('"characters"') || s.includes('"owner"')) && s.includes('"id":'));
if (charCtxWithId.length) { console.error('FAIL: fixedExamples 角色引用上下文残留 "id": 键:', charCtxWithId); fail++; }
else console.log('OK: fixedExamples 角色引用上下文无 "id": 键');

if (!tpl.includes('"name": "理查德"')) { console.error('FAIL: fixedExamples 缺 "name": "理查德" 示例'); fail++; }
else console.log('OK: fixedExamples 含 "name": "理查德"');

// --- Part B: agent-config.json story ---
const cfg = JSON.parse(fs.readFileSync('E:/code/fated_poem_independent/data/defaults/agent-config.json', 'utf8'));
const storyStr = JSON.stringify(cfg.agents.story);
if (storyStr.includes('char_detect')) { console.error('FAIL: story agent(含预设) 仍含 char_detect'); fail++; }
else console.log('OK: story agent(含预设) 无 char_detect');

// story systemPrompt 本体（可能为空）也不得含 char_detect
if ((cfg.agents.story.systemPrompt || '').includes('char_detect')) { console.error('FAIL: story.systemPrompt 含 char_detect'); fail++; }
else console.log('OK: story.systemPrompt 无 char_detect');

// 结构完整性: COT 条目仍在且 Step 7 其余行未误删
const cot = (cfg.agents.story.preset?.settings?.prompts || []).find(p => p.name === '🌐COT');
if (!cot) { console.error('FAIL: 🌐COT 预设条目丢失'); fail++; }
else {
  if (!cot.content.includes('Step 7:角色相关')) { console.error('FAIL: COT Step 7 标题被误删'); fail++; }
  else console.log('OK: COT Step 7 标题仍在');
  if (!cot.content.includes('是否有已有角色出场')) { console.error('FAIL: COT 已有角色行被误删'); fail++; }
  else console.log('OK: COT 已有角色行仍在');
}

process.exit(fail ? 1 : 0);
