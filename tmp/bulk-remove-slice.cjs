// Bulk replace {{NARRATIVE:layers=N:slice=N}} → {{NARRATIVE:layers=N}} in all source files
// Excludes tmp/ backups and docs/
const fs = require('fs')
const path = require('path')

const regex = /\{\{NARRATIVE:layers=(\d+):slice=\d+\}\}/g
const replacement = '{{NARRATIVE:layers=$1}}'

const files = [
  'data/defaults/agent-config.json',
  'src/sillytavern/placeholder-registry.ts',
  'src/sillytavern/placeholder-registry.test.ts',
  'src/sillytavern/template-resolver.test.ts',
  'src/sillytavern/agent-templates.test.ts',
]

// Also handle the case where template strings use \n (agent-config.json has real newlines in template)
const multiLineRegex = /\{\{NARRATIVE:layers=(\d+):slice=\d+\}\}/g

for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8')
  const newContent = content.replace(multiLineRegex, '{{NARRATIVE:layers=$1}}')
  if (content !== newContent) {
    fs.writeFileSync(file, newContent, 'utf-8')
    const count = (content.match(multiLineRegex) || []).length
    console.log(`[OK] ${file}: ${count} replacements`)
  } else {
    console.log(`[--] ${file}: no matches`)
  }
}

console.log('Done')
