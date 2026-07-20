// M4 T4 edit: 从 story 预设 COT 条目中删除 char_detect 输出教学
// （M3 已删代码路径 onCharDetect；新角色检测走 request_dispatcher 的 char_gen_request）
// 写回保持原序列化风格: JSON.stringify(obj, null, 2)，无尾随换行（round-trip 已验证 byte-identical）
const fs = require('fs');
const path = 'E:/code/fated_poem_independent/data/defaults/agent-config.json';
const raw = fs.readFileSync(path, 'utf8');
const cfg = JSON.parse(raw);

const prompts = cfg.agents.story.preset?.settings?.prompts || [];
let removed = 0;

for (const p of prompts) {
  if (typeof p.content !== 'string' || !p.content.includes('char_detect')) continue;
  const before = p.content;
  // 删除整条 bullet 行:
  // "- 是否有新角色？→若<CHARACTER_STATE>中不存在该角色，在</option>后生成 <char_detect ...>...</char_detect>"
  // 行首含前导换行一并删除，避免留空行
  p.content = p.content.replace(/\r?\n- 是否有新角色？→[^\r\n]*char_detect[^\r\n]*/g, () => {
    removed++;
    return '';
  });
  if (p.content.includes('char_detect')) {
    console.error('ERROR: 条目 "' + p.name + '" 删除后仍残留 char_detect，中止不写回');
    process.exit(1);
  }
  console.log('条目 "' + p.name + '" 删除 char_detect 教学行，内容长度', before.length, '->', p.content.length);
}

if (removed === 0) {
  console.error('ERROR: 未找到可删除的 char_detect 教学行，中止');
  process.exit(1);
}

// 全 story 对象终检
if (JSON.stringify(cfg.agents.story).includes('char_detect')) {
  console.error('ERROR: story 对象仍含 char_detect（预设外位置），中止不写回');
  process.exit(1);
}

fs.writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
console.log('写回完成，删除行数:', removed);
