const fs = require('fs')
const path = require('path')
const cfg = JSON.parse(fs.readFileSync('data/defaults/agent-config.json', 'utf-8'))

const po = cfg.agents.plot_outline
const ppc = cfg.agents.plot_post_check

console.log('=== plot_outline template ===')
console.log(po.template)
console.log('')
console.log('=== plot_outline systemPrompt (first 500 chars) ===')
console.log(po.systemPrompt.slice(0, 500))
console.log('...')
console.log('=== plot_outline systemPrompt (last 300 chars) ===')
console.log(po.systemPrompt.slice(-300))
console.log('')
console.log('=== plot_post_check: outlineChanges section ===')
const ppcSP = ppc.systemPrompt
// Find outlineChanges mentions
let idx = 0
let count = 0
while ((idx = ppcSP.indexOf('outlineChanges', idx)) !== -1 && count < 10) {
  console.log(`  at ${idx}: ...${ppcSP.slice(Math.max(0, idx - 30), idx + 80)}...`)
  idx += 14
  count++
}
console.log('')
console.log('=== plot_outline: searching for yearly/年度/世界线 ===')
['年度', '支线', '世界线', '重生成', '初次'].forEach(term => {
  let i = 0, c = 0
  while ((i = po.systemPrompt.indexOf(term, i)) !== -1 && c < 5) {
    console.log(`  "${term}" at ${i}: ...${po.systemPrompt.slice(Math.max(0, i - 20), i + 60)}...`)
    i += term.length
    c++
  }
})
