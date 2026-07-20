// M4 T4: JSON round-trip stability check for agent-config.json
const fs = require('fs');
const path = 'E:/code/fated_poem_independent/data/defaults/agent-config.json';
const raw = fs.readFileSync(path, 'utf8');
const obj = JSON.parse(raw);
const re2 = JSON.stringify(obj, null, 2);

console.log('raw length:', raw.length);
console.log('restringify(2) length:', re2.length);
console.log('raw endsWith \\n:', /\n$/.test(raw));
console.log('raw has CRLF file-level:', raw.includes('\r\n  "'));
console.log('roundtrip identical (ignoring trailing newline):', raw.replace(/\r?\n$/, '') === re2);

if (raw.replace(/\r?\n$/, '') !== re2) {
  // find first diff position
  const a = raw.replace(/\r?\n$/, '');
  let i = 0;
  while (i < Math.min(a.length, re2.length) && a[i] === re2[i]) i++;
  console.log('first diff at char', i);
  console.log('raw   around:', JSON.stringify(a.slice(Math.max(0, i - 80), i + 80)));
  console.log('restr around:', JSON.stringify(re2.slice(Math.max(0, i - 80), i + 80)));
}
