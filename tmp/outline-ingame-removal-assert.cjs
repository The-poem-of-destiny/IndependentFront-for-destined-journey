// 大纲改为仅开局生成 — assert 脚本
const fs = require('fs')
const cfg = JSON.parse(fs.readFileSync('data/defaults/agent-config.json', 'utf-8'))
let ok = 0, fail = 0

function assert(cond, msg) {
  if (cond) { ok++; console.log('  PASS:', msg) }
  else { fail++; console.error('  FAIL:', msg) }
}

const po = cfg.agents.plot_outline

// 1. template
assert(po.template === '{{SYS_PROMPT}}', 'plot_outline template === {{SYS_PROMPT}}')

// 2. sp contains new note
assert(po.systemPrompt.includes('只在捏人页'), 'plot_outline sp: 只在捏人页')
assert(po.systemPrompt.includes('plot_post_check'), 'plot_outline sp: mentions plot_post_check')
assert(po.systemPrompt.includes('两种场景'), 'plot_outline sp: 两种场景（非三种）')

// 3. sp does NOT contain deleted text
assert(!po.systemPrompt.includes('世界线重生成'), 'plot_outline sp: no 世界线重生成')
assert(!po.systemPrompt.includes('三种场景'), 'plot_outline sp: no 三种场景')
assert(!po.systemPrompt.includes('游戏内支线年度生成'), 'plot_outline sp: no 游戏内支线年度生成')
assert(!po.systemPrompt.includes('年度生成'), 'plot_outline sp: no 年度生成')

// 4. sp still contains essentials
assert(po.systemPrompt.includes('修改模式'), 'plot_outline sp: 修改模式 preserved')
assert(po.systemPrompt.includes('雷点'), 'plot_outline sp: 雷点 preserved')
assert(po.systemPrompt.includes('selfCritique'), 'plot_outline sp: selfCritique preserved')

// 5. plot_post_check
const ppc = cfg.agents.plot_post_check
assert(ppc.systemPrompt.includes('大纲演化唯一维护者'), 'plot_post_check sp: 大纲演化唯一维护者 note')
assert(ppc.systemPrompt.includes('**必须**主动'), 'plot_post_check sp: 必须主动 via outlineChanges')
assert(ppc.systemPrompt.includes('quest_update_request'), 'plot_post_check sp: quest_update_request preserved')
assert(ppc.systemPrompt.includes('outlineChanges'), 'plot_post_check sp: outlineChanges field preserved')

console.log(`\n${ok} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
