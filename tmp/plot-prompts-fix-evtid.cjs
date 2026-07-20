const fs = require('fs');
const path = 'data/defaults/agent-config.json';
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
const sp = cfg.agents.plot_outline.systemPrompt;
const bad = '（evt_01、uuid 等都禁止）';
console.log('contains bad:', sp.includes(bad));
cfg.agents.plot_outline.systemPrompt = sp.replace(bad, '（任何编号、uuid 形式都禁止）');
fs.writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
console.log('fixed, new len:', cfg.agents.plot_outline.systemPrompt.length);
