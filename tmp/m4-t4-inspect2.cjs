// M4 Task 4 inspection v2: drill into story.preset.settings
const fs = require('fs');
const path = 'E:/code/fated_poem_independent/data/defaults/agent-config.json';
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));

const preset = cfg.agents.story.preset;
const settings = preset.settings || {};
console.log('settings keys:', Object.keys(settings).join(', '));

function walk(obj, pathStr) {
  if (typeof obj === 'string') {
    if (obj.includes('char_detect')) {
      console.log('=== char_detect in string at:', pathStr, '| length:', obj.length);
      let idx = obj.indexOf('char_detect');
      let n = 0;
      while (idx >= 0 && n < 10) {
        console.log('  --- occurrence @' + idx + ' ---');
        console.log(JSON.stringify(obj.slice(Math.max(0, idx - 500), idx + 500)));
        idx = obj.indexOf('char_detect', idx + 1);
        n++;
      }
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      // label prompts by name if possible
      const label = (v && typeof v === 'object' && (v.name || v.identifier))
        ? `[${i}:${v.name || v.identifier}]` : `[${i}]`;
      walk(v, pathStr + label);
    });
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) walk(obj[k], pathStr + '.' + k);
  }
}

walk(settings, 'settings');
