import { readFileSync, writeFileSync } from 'fs';

const files = {
  'src/ui/components/create/BackgroundList.vue': [
    ['⚠️ ', ''],
  ],
  'src/ui/components/create/CreateStepPlot.vue': [
    ['⚠ ', ''],
  ],
  'src/ui/components/home/HomePage.vue': [
    ['<span class="btn-icon">⚔</span> ', ''],
  ],
};

for (const [file, reps] of Object.entries(files)) {
  let content = readFileSync(file, 'utf-8');
  let modified = false;
  for (const [from, to] of reps) {
    if (content.includes(from)) {
      content = content.split(from).join(to);
      modified = true;
    }
  }
  if (modified) { writeFileSync(file, content); console.log('  ✓ ' + file); }
}
console.log('done');
