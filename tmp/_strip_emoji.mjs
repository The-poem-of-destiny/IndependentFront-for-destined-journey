// 移除 src/ui/components/ 下所有 Vue 文件中的 emoji，保持玄墨古籍风
import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

const files = globSync('src/ui/components/**/*.vue');

// 替换表：[匹配模式, 替换文本] — 只替换实际 emoji，保留 typographic symbols(▸ ▾ ▶ ◀ ▼ ★ ©等)
const replacements = [
  // === 按钮/标签 emoji → 纯文本 ===
  ['🤖 ', ''], ['🤖', ''],
  ['🎲 ', ''], ['🎲', ''],
  ['✏️ ', ''], ['✏️', ''],
  ['↩ ', ''], ['↩', ''],
  ['📖 ', ''], ['📖', ''],
  ['⚙ ', ''], ['⚙', ''],
  ['♫ ', ''], ['♫', ''],
  ['📥 ', ''], ['📥', ''],
  ['📋 ', ''], ['📋', ''],
  ['📤 ', ''], ['📤', ''],
  ['🗑 ', ''], ['🗑', ''],
  ['📝 ', ''], ['📝', ''],
  ['📁 ', ''], ['📁', ''],
  ['📅 ', ''], ['📅', ''],
  ['📑 ', ''], ['📑', ''],
  ['🧠 ', ''], ['🧠', ''],
  ['📦 ', ''], ['📦', ''],
  ['🔗 ', ''], ['🔗', ''],
  ['🛠 ', ''], ['🛠', ''],
  ['🗺 ', ''], ['🗺', ''],
  ['🐛 ', ''], ['🐛', ''],
  ['🔧 ', ''], ['🔧', ''],
  ['💡 ', ''], ['💡', ''],
  ['🧬 ', ''], ['🧬', ''],
  ['🎭 ', ''], ['🎭', ''],
  ['📍 ', ''], ['📍', ''],
  ['⭐ ', ''], ['⭐', ''],
  
  // === 状态标记 emoji → 文本 ===
  ['⚡ ', ''], ['⚡', ''],
  ['✅ ', ''], ['✅', ''],
  ['❌ ', ''], ['❌', ''],
  ['✖ ', ''], ['✖', ''],
  ['⏳ ', ''], ['⏳', ''],
  ['⏭ ', ''], ['⏭', ''],
  
  // === 特殊：BeautifierSection 折叠箭头（已是 typographic ▼ ▶，不动）===
  // === 特殊：CreateStepConfirm ✅ ⚠ 行内标记 → 保留为纯文本状态 ===
];

let changed = 0;
for (const file of files) {
  let content = readFileSync(file, 'utf-8');
  let modified = false;
  for (const [from, to] of replacements) {
    if (content.includes(from)) {
      content = content.split(from).join(to);
      modified = true;
    }
  }
  if (modified) {
    writeFileSync(file, content, 'utf-8');
    changed++;
    console.log(`  ✓ ${file}`);
  }
}
console.log(`\nChanged ${changed} files`);
