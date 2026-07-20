const fs = require('fs');
const path = 'data/defaults/agent-config.json';
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
const bt = String.fromCharCode(96).repeat(3); // ```
const sp = cfg.agents.plot_outline.systemPrompt;
const bad = '（不要 \\u0060\\u0060\\u0060json）'; // literal backslash-u0060 x3
console.log('contains bad:', sp.includes(bad));
cfg.agents.plot_outline.systemPrompt = sp.replace(bad, '（不要 ' + bt + 'json 包裹）');
fs.writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
const check = JSON.parse(fs.readFileSync(path, 'utf8'));
const sp2 = check.agents.plot_outline.systemPrompt;
console.log('u0060 remaining:', sp2.includes('u0060'));
console.log('backtick phrase ok:', sp2.includes(bt + 'json 包裹'));
console.log('new len:', sp2.length);
