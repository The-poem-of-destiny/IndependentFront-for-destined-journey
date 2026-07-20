const fs = require('fs');
const cur = JSON.parse(fs.readFileSync('data/defaults/agent-config.json', 'utf8'));
const bak = JSON.parse(fs.readFileSync('tmp/agent-config.pre-plot-prompts.bak', 'utf8'));

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + msg); if (!cond) fail++; };

// 1. JSON valid (parse already succeeded)
ok(true, 'agent-config.json JSON.parse OK');

// 2. Only the three plot agents' systemPrompt changed
for (const [id, agent] of Object.entries(cur.agents)) {
  const bakAgent = bak.agents[id];
  for (const key of new Set([...Object.keys(agent), ...Object.keys(bakAgent)])) {
    const same = JSON.stringify(agent[key]) === JSON.stringify(bakAgent[key]);
    const isTarget = ['plot_outline', 'plot_pre_check', 'plot_post_check'].includes(id) && key === 'systemPrompt';
    if (!same && !isTarget) { ok(false, `unexpected change: ${id}.${key}`); }
    if (isTarget && same) { ok(false, `target NOT changed: ${id}.${key}`); }
  }
}
ok(true, 'no unexpected changes outside the 3 target systemPrompts');

const o = cur.agents.plot_outline.systemPrompt;
const pre = cur.agents.plot_pre_check.systemPrompt;
const post = cur.agents.plot_post_check.systemPrompt;

// 3. Lengths
ok(o.length > 4000, `plot_outline length ${o.length} (>4000)`);
ok(pre.length > 2200, `plot_pre_check length ${pre.length} (>2200)`);
ok(post.length > 4000, `plot_post_check length ${post.length} (>4000)`);

// 4. Anchors — plot_outline
for (const a of ['雷点', '修改模式', 'tabooContent', 'durationYears', 'difficultyTier', 'genrePreference', 'customPreference', 'allowNonWorldbookNpc', 'selfCritique', 'triggerHint', 'keyEvents', '复兴纪元', '奥古斯提姆帝国', '兽族联盟', '<json>', '输出完整大纲 JSON']) {
  ok(o.includes(a), `plot_outline anchor: ${a}`);
}
// 8 genres
for (const g of ['combat', 'mystery', 'social', 'romance', 'exploration', 'politics', 'survival', 'tragedy']) {
  ok(o.includes(g), `plot_outline genre: ${g}`);
}

// 5. Anchors — plot_pre_check
for (const a of ['triggeredEvents', 'relevantBackground', 'directive', '300字', '100字', '宁缺毋滥', '只用标题', '<json>', '剧透']) {
  ok(pre.includes(a), `plot_pre_check anchor: ${a}`);
}
ok(!pre.includes('outlineRelevance'), 'plot_pre_check no legacy field outlineRelevance');

// 6. Anchors — plot_post_check
for (const a of ['worldLineChanged', 'changeLevel', 'eventUpdates', 'newChildEvents', 'parentTitle', 'triggerCondition', 'outlineChanges', 'quest_update_request', 'vars_update', 'request_dispatcher', 'minor', 'moderate', 'major', '<json>']) {
  ok(post.includes(a), `plot_post_check anchor: ${a}`);
}

// 7. No id-based addressing taught anywhere
for (const [name, sp] of [['outline', o], ['pre', pre], ['post', post]]) {
  ok(!sp.includes('evt_0'), `${name}: no evt_0 id examples`);
  ok(!sp.includes('"id"'), `${name}: no "id" field in output format`);
}

// 8. No leaked escapes
for (const [name, sp] of [['outline', o], ['pre', pre], ['post', post]]) {
  ok(!sp.includes('u0060') && !sp.includes('\\n\\n\\n\\n'), `${name}: no leaked escapes`);
}

// 9. Roundtrip formatting stable
const raw = fs.readFileSync('data/defaults/agent-config.json', 'utf8');
ok(raw === JSON.stringify(cur, null, 2), 'file formatting = JSON.stringify(obj, null, 2)');

console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECKS FAILED`);
process.exit(fail === 0 ? 0 : 1);
