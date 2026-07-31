/**
 * 图片压缩脚本（治理规范 §7：交付资产 ≤500KB 红线）
 *
 * 用 sharp 对 src/ui/assets/themes 下 >500KB 的 PNG 做 palette 量化 + 高压缩。
 * 保持 .png 格式（不改引用），只在压缩更小时替换。
 *
 * 用法: node scripts/compress-images.mjs
 * 一次性工具，D 批后可删；保留以便将来新图复用。
 */
import sharp from 'sharp'
import { readdirSync, readFileSync, statSync, renameSync, unlinkSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

function walkPngs(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkPngs(p))
    else if (e.name.toLowerCase().endsWith('.png')) out.push(p)
  }
  return out
}

const themesDir = join(root, 'src/ui/assets/themes')
const files = walkPngs(themesDir).filter((f) => statSync(f).size > 500 * 1024)
console.log(`找到 ${files.length} 个 >500KB 的 PNG，开始压缩…\n`)

let totalBefore = 0
let totalAfter = 0
for (const f of files) {
  const before = statSync(f).size
  totalBefore += before
  const tmp = f + '.tmp'
  await sharp(readFileSync(f))
    .png({ palette: true, quality: 78, compressionLevel: 9, effort: 10 })
    .toFile(tmp)
  const after = statSync(tmp).size
  if (after < before) {
    unlinkSync(f)
    renameSync(tmp, f)
    totalAfter += after
    console.log(
      `  ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB  ${f.replace(root + '/', '')}`,
    )
  } else {
    unlinkSync(tmp)
    totalAfter += before
    console.log(`  ${(before / 1024).toFixed(0)}KB (无改善)  ${f.replace(root + '/', '')}`)
  }
}

console.log(
  `\n总计: ${(totalBefore / 1024 / 1024).toFixed(1)}MB → ${(totalAfter / 1024 / 1024).toFixed(1)}MB` +
    ` (-${((1 - totalAfter / totalBefore) * 100).toFixed(0)}%)`,
)
