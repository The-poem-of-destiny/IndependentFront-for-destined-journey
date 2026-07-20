// M4 Task 4 inspection: locate char_detect occurrences inside agent-config.json
const fs = require('fs');
const path = 'E:/code/fated_poem_independent/data/defaults/agent-config.json';
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));

console.log('top-level keys:', Object.keys(cfg).join(', '));
for (const k of Object.keys(cfg)) {
  if (k === 'agents') continue;
  const s = JSON.stringify(cfg[k]);
  if (s && s.includes('char_detect')) console.log('char_detect found in top-level:', k);
}

const story = cfg.agents.story;
console.log('story keys:', Object.keys(story).join(', '));
console.log('story.systemPrompt length:', (story.systemPrompt || '').length);

for (const k of Object.keys(story)) {
  const s = JSON.stringify(story[k]);
  if (s && s.includes('char_detect')) {
    console.log('char_detect found in story.' + k, '| type:', typeof story[k]);
  }
}

// Drill into preset prompts if present
const preset = story.preset;
if (preset) {
  console.log('preset keys:', Object.keys(preset).join(', '));
  const prompts = preset.prompts || [];
  prompts.forEach((p, i) => {
    const s = JSON.stringify(p);
    if (s.includes('char_detect')) {
      console.log('--- prompt[' + i + '] name:', p.name, '| role:', p.role,
        '| enabled:', p.enabled, '| identifier:', p.identifier,
        '| content length:', (p.content || '').length);
      const c = p.content || '';
      let idx = c.indexOf('char_detect');
      while (idx >= 0) {
        console.log('  context @' + idx + ':', JSON.stringify(c.slice(Math.max(0, idx - 400), idx + 400)));
        idx = c.indexOf('char_detect', idx + 1);
      }
    }
  });
}

// template field?
if (story.template && story.template.includes('char_detect')) {
  console.log('char_detect in story.template');
}
