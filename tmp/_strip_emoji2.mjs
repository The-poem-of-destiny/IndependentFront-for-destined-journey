import { readFileSync, writeFileSync } from 'fs';

const files = [
  'src/ui/components/create/PlotOutlinePreview.vue',
  'src/ui/components/create/CreateStepConfirm.vue',
  'src/ui/components/create/CreateFooter.vue',
  'src/ui/components/settings/BeautifierSection.vue',
  'src/ui/components/settings/SettingsPage.vue',
  'src/ui/components/game/ItemsPanel.vue',
  'src/ui/components/game/CharacterListPanel.vue',
  'src/ui/components/game/ChatFlow.vue',
  'src/ui/components/game/DebugPanel.vue',
  'src/ui/components/game/PlotPanel.vue',
  'src/ui/components/shared/ToastContainer.vue',
  'src/ui/components/home/HomePage.vue',
];

// target replacements
const reps = [
  // PlotOutlinePreview — section titles
  ['🔍 自检', '—— 自检'],
  ['📖 叙事大纲', '—— 叙事大纲'],
  ['📑 章节总览', '—— 章节总览'],
  ['📅 ', ''],
  // event conditions
  ['⚡ ', ''],
  ['✅ ', ''],
  ['❌ ', ''],
  // loading
  ['⏳ ', ''],
  ['🎭 ', ''],
  
  // CreateStepConfirm
  ['⚠ ', ''],
  ['💡 ', ''],
  ['✅ ', ''],
  
  // BeautifierSection
  ['🔒', '—'],
  
  // SettingsPage
  ['🔍 解析预览', '解析预览'],
  ['⚠ ', ''],
  
  // ItemsPanel / CharacterListPanel
  ['📜 ', ''],
  
  // ChatFlow
  ['▶', '▸'],
  ['●', '·'],
  
  // DebugPanel
  ['📥 ', ''],
  ['📋 ', ''],
  ['📁 ', ''],
  ['🤖 ', ''],
  ['❌ ', ''],
  ['✅ ', ''],
  ['📤 ', ''],
  ['🧠 ', ''],
  
  // PlotPanel events
  ['⚡', ''],
  ['⏳', ''],
  ['✅', ''],
  ['✖', ''],
  ['⏭', ''],
  
  // ToastContainer
  ['ℹ', 'i'],
  ['✓', '✓'],  // ✓ is a typographic check mark, keep as-is per design
  ['✕', '✕'],  // ✕ is typographic, keep
  
  // HomePage
  ['📜', ''],
  ['👈', ''],
  ['📖 ', ''],
  ['⚙ ', ''],
  ['♫ ', ''],
];

let changed = 0;
for (const file of files) {
  let content;
  try { content = readFileSync(file, 'utf-8'); } catch { continue; }
  let modified = false;
  for (const [from, to] of reps) {
    if (content.includes(from)) {
      content = content.split(from).join(to);
      modified = true;
    }
  }
  if (modified) { writeFileSync(file, content); changed++; console.log('  ✓ ' + file); }
}
console.log('Changed ' + changed + ' files');
