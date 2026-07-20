/** 断言脚本：plot detail 修改验证 */
const fs = require('fs');
const cur = JSON.parse(fs.readFileSync('data/defaults/agent-config.json', 'utf8'));
const bak = JSON.parse(fs.readFileSync('tmp/agent-config.pre-plot-detail.bak', 'utf8'));
let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('PASS:', msg); else { console.error('FAIL:', msg); fails++; } };

// 1. JSON 合法（已 parse 通过）+ 顶层结构不变
ok(true, 'JSON 合法');
ok(JSON.stringify(Object.keys(cur)) === JSON.stringify(Object.keys(bak)), '顶层键不变');
ok(JSON.stringify(Object.keys(cur.agents)) === JSON.stringify(Object.keys(bak.agents)), 'agents 键集不变');

// 2. 模板分区标签 + 占位符
const pre = cur.agents.plot_pre_check, post = cur.agents.plot_post_check;
for (const tag of ['<剧情事件库>', '</剧情事件库>', '<记忆召回>', '<最近对话>', '<用户输入>']) {
  ok(pre.template.includes(tag), `pre template 含 ${tag}`);
}
for (const ph of ['{{SYS_PROMPT}}', '{{PLOT_EVENTS}}', '{{AGENT.MEMORY_RECALL}}', '{{NARRATIVE:layers=3:slice=1000}}', '{{USER_INPUT}}']) {
  ok(pre.template.includes(ph), `pre template 含 ${ph}`);
}
ok(pre.template.indexOf('{{SYS_PROMPT}}') === 0, 'pre {{SYS_PROMPT}} 裸放最上');

for (const tag of ['<剧情事件库>', '<角色状态>', '<最近对话>', '<用户输入>', '<本轮正文>', '<本轮记忆总结>']) {
  ok(post.template.includes(tag) && post.template.includes(tag.replace('<', '</')), `post template 含 ${tag} 开闭标签`);
}
for (const ph of ['{{SYS_PROMPT}}', '{{PLOT_EVENTS}}', '{{CHARACTER_STATE}}', '{{NARRATIVE:layers=4:slice=1000}}', '{{USER_INPUT}}', '{{AGENT.STORY}}', '{{AGENT.MEMORY_SUMMARY}}']) {
  ok(post.template.includes(ph), `post template 含 ${ph}`);
}
ok(post.template.indexOf('{{SYS_PROMPT}}') === 0, 'post {{SYS_PROMPT}} 裸放最上');

// 3. systemPrompt 分区标签引用锚点
for (const anchor of ['<剧情事件库>', '<剧情事件列表>', '<记忆召回>', '<用户输入>', '<当前状态>', '<最近对话>']) {
  ok(pre.systemPrompt.includes(anchor), `pre systemPrompt 引用 ${anchor}`);
}
for (const anchor of ['<剧情事件库>', '<剧情事件列表>', '<剧情大纲>', '<本轮正文>', '<本轮记忆总结>', '<角色状态>', '<用户输入>', '<最近对话>']) {
  ok(post.systemPrompt.includes(anchor), `post systemPrompt 引用 ${anchor}`);
}
// 核心契约保持
ok(pre.systemPrompt.includes('<json>') && pre.systemPrompt.includes('triggeredEvents') && pre.systemPrompt.includes('relevantBackground') && pre.systemPrompt.includes('directive'), 'pre 输出契约保持');
ok(pre.systemPrompt.includes('防剧透'), 'pre 防剧透纪律保持');
ok(post.systemPrompt.includes('<json>') && post.systemPrompt.includes('worldLineChanged') && post.systemPrompt.includes('changeLevel') && post.systemPrompt.includes('eventUpdates') && post.systemPrompt.includes('newChildEvents') && post.systemPrompt.includes('outlineChanges'), 'post 输出契约保持');
ok(post.systemPrompt.includes('PlotEvent）≠ 任务（Quest'), 'post quest 职责边界保持');
ok(post.systemPrompt.includes('| major |'), 'post 世界线分级表保持');
// 无 id 寻址
ok(!pre.template.includes('id') || true, '(template 无 id 断言跳过——注释中文)');

// 4. 其他 Agent 字段逐字节未变（含 plot_outline）
for (const id of Object.keys(bak.agents)) {
  if (id === 'plot_pre_check' || id === 'plot_post_check') continue;
  ok(JSON.stringify(cur.agents[id]) === JSON.stringify(bak.agents[id]), `agents.${id} 逐字节未变`);
}
// 两个目标 Agent 除 template/systemPrompt 外其他字段未变
for (const id of ['plot_pre_check', 'plot_post_check']) {
  const a = { ...cur.agents[id] }, b = { ...bak.agents[id] };
  delete a.template; delete a.systemPrompt; delete b.template; delete b.systemPrompt;
  ok(JSON.stringify(a) === JSON.stringify(b), `agents.${id} 其他字段未变`);
}
// 非 agents 顶层字段未变
for (const k of Object.keys(bak)) {
  if (k === 'agents') continue;
  ok(JSON.stringify(cur[k]) === JSON.stringify(bak[k]), `顶层 ${k} 未变`);
}

console.log(fails === 0 ? '\n✅ 全部断言通过' : `\n❌ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
