/**
 * 直接从 v4.2.1 角色卡的原始 JSON 字符串中提取 map_markers，
 * 保持原始 \\n 不被 JSON.parse 吞掉。
 *
 * 策略: 正则定位 map_markers 数组段落 → 逐个提取 description 字段 →
 * 通过 JSON.parse 把 \\n 变成真正的换行符。
 *
 * 用法: node scripts/extract-map-markers.cjs
 */
const fs = require('fs');
const path = require('path');

const CHARA_CARD = path.join(__dirname, '..', 'reference', 'v4.2.1_chara_card.json');
const OUTPUT = path.join(__dirname, '..', 'data', 'defaults', 'map-marker-presets.json');

const raw = fs.readFileSync(CHARA_CARD, 'utf8');

// 方法: 先正常 parse，description 字段已由 JSON.parse 处理
// 检查描述中的 \\n 是否都变成了真正的换行
const card = JSON.parse(raw);
const markers =
  card?.data?.extensions?.tavern_helper?.variables?.map_markers ||
  card?.data?.extensions?.tavern_helper?.variables?.map_markers ||
  [];

if (!Array.isArray(markers) || markers.length === 0) {
  console.error('❌ 未找到 map_markers');
  process.exit(1);
}

console.log(`找到 ${markers.length} 个标记 (JSON.parse 后)`);

// 关键: JSON.parse 应该已经把 \\n → \n 了
// 但前面验证发现它还是字面量 \\n，说明原版 JSON 里存了 \\\\n (四个字符: \\\n)
// 也就是 SillyTavern 做了双重转义
// 我们再做一次 replace
const cleaned = markers.map((m, i) => {
  let desc = m.description || '';
  // 把 \\n (字面量反斜杠+n) 替换为真正的换行
  desc = desc.replace(/\\n/g, '\n');

  return {
    id: m.id || `marker-${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${i}`,
    name: m.name || '未命名',
    group: m.group || '',
    description: desc,
    icon: m.icon || 'fa-solid fa-location-dot',
    color: m.color || '#ffcc66',
    position: { nx: m.position?.nx ?? 0.5, ny: m.position?.ny ?? 0.5 },
    imageUrls: m.imageUrls || [],
  };
});

fs.writeFileSync(OUTPUT, JSON.stringify(cleaned, null, 2), 'utf8');

const max = Math.max(...cleaned.map((m) => m.description.length));
const avg = Math.round(cleaned.reduce((s, m) => s + m.description.length, 0) / cleaned.length);
const withNewline = cleaned.filter((m) => m.description.includes('\n')).length;

console.log(`✅ 完成: ${cleaned.length} 标记, 最长 ${max} chars, 平均 ${avg} chars`);
console.log(`   含真正换行: ${withNewline} 个`);
console.log(`   输出: ${OUTPUT}`);
