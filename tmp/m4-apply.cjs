// M4 (AI Prompt 契约对齐) Tasks 1-3
// - Task 1: vars_update systemPrompt — id→name 键 / quests+affections 教学 / 枚举取值表 / player_1 灭绝
// - Task 2: request_dispatcher systemPrompt — 示例 id→真实角色名 / owner 属性文档 / 意识体判定规则
// - Task 3: item_gen systemPrompt — slot/type 枚举对齐 field-enums.ts / 修复 U+FFFD mojibake（要素名）
//           char_gen systemPrompt — 仅验证（无 id= 属性，无需改动）
// 写回保持文件当前序列化风格: JSON.stringify(cfg, null, 2)，无尾随换行（round-trip 已验证 byte-identical）
const fs = require('fs');
const path = 'E:/code/fated_poem_independent/data/defaults/agent-config.json';
const raw = fs.readFileSync(path, 'utf8');
const cfg = JSON.parse(raw);

// 前置守卫: 确认当前文件是 pretty-2 round-trip 格式（防止序列化风格漂移）
if (JSON.stringify(cfg, null, 2) !== raw) {
  console.error('ABORT: file is not pretty-2 round-trip identical; inspect manually before editing');
  process.exit(1);
}

let totalEdits = 0;
function rep(sp, find, replace, expect, label) {
  const parts = sp.split(find);
  const n = parts.length - 1;
  if (n !== expect) {
    console.error('ABORT [' + label + ']: expected ' + expect + ' occurrence(s), found ' + n + ' for: ' + JSON.stringify(find.slice(0, 80)));
    process.exit(1);
  }
  totalEdits += n;
  return parts.join(replace);
}

// ============================================================
// Task 1: vars_update
// ============================================================
{
  let sp = cfg.agents.vars_update.systemPrompt;
  // vu 主体是 LF（341 LF vs 仅 5 处历史遗留 CRLF），锚点区域实测为 \n
  const EOL = '\n';
  const before = sp.length;

  // --- 1.1 id→name 键（示例 player_1 → 理查德）---
  sp = rep(sp, '"id": "player_1"', '"name": "理查德"', 8, 'vu id-space');
  sp = rep(sp, '"id":"player_1"', '"name":"理查德"', 2, 'vu id-nospace');
  sp = rep(sp, '"owner": "player_1"', '"owner": "理查德"', 6, 'vu owner-json');
  sp = rep(sp, '"from": "player_1", "to": "npc_001"', '"from": "理查德", "to": "汉斯"', 1, 'vu transfer');
  sp = rep(sp, 'target="player_1"', 'target="理查德"', 2, 'vu target-attr');
  sp = rep(sp, 'owner="player_1"', 'owner="理查德"', 4, 'vu owner-attr');
  sp = rep(sp, '**已有角色**: player_1（', '**已有角色**: 理查德（', 2, 'vu roster');

  // --- 1.2 格式说明占位符 角色ID → 角色名 / "id" 键 → "name" 键 ---
  sp = rep(sp, '{"id": "角色ID",', '{"name": "角色名",', 4, 'vu fmt-id-key');
  sp = rep(sp, '"owner": "角色ID"', '"owner": "角色名"', 4, 'vu fmt-owner');
  sp = rep(sp, '"from": "角色ID", "to": "角色ID"', '"from": "角色名", "to": "角色名"', 1, 'vu fmt-transfer');
  sp = rep(sp, 'owner="角色ID"', 'owner="角色名"', 1, 'vu fmt-effect-owner');

  // --- 1.3 quests + affections 教学块（插在 item 侧格式段之后、思考深度要求之前）---
  const teach = [
    '## quests（任务）',
    '',
    '{"quests":{"upsert":[{"name":"任务名","status":"进行中","objective":"任务目标","detail":"任务详情"}],"remove":[{"name":"任务名"}]}}',
    '',
    '- upsert: name 必填；status 取 "进行中"/"已完成"/"失败"/"搁置"；可选字段 priority("低"/"中"/"高")、progress、detail、objective、reward——只写调度器标签给到的信息，缺失字段不编造',
    '- remove: name 必填',
    '- 没有任务变化时省略 quests 键',
    '',
    '## affections（好感度）',
    '',
    '{"affections":{"set":[{"name":"角色名","value":50}],"delta":[{"name":"角色名","amount":5}]}}',
    '',
    '- set: 设绝对值，范围 [-100,100]',
    '- delta: 相对增减（正=提升，负=下降）',
    '- name 用角色名（不是 id）；仅当正文/调度器标签中出现好感度或关系变化时输出，无变化时省略 affections 键',
    '',
    '---',
    '',
    '# 思考深度要求',
  ].join(EOL);
  sp = rep(sp, '---' + EOL + EOL + '# 思考深度要求', teach, 1, 'vu insert-quests-affections');

  // --- 1.4 输出格式 <json> 骨架补 quests / affections 键 ---
  const jsonTail = [
    '不要在这里生成。',
    '  },',
    '  "quests": {',
    '    "upsert": [{"name": "任务名", "status": "进行中", "objective": "任务目标", "detail": "任务详情"}],',
    '    "remove": [{"name": "任务名"}]',
    '  },',
    '  "affections": {',
    '    "set": [{"name": "角色名", "value": 50}],',
    '    "delta": [{"name": "角色名", "amount": 5}]',
    '    // ⚠️ quests / affections 仅在有对应变化时输出，无变化时整键省略。',
    '  }',
    '}',
    '</json>',
  ].join(EOL);
  sp = rep(sp, '不要在这里生成。' + EOL + '  }' + EOL + '}' + EOL + '</json>', jsonTail, 1, 'vu json-skeleton');

  // --- 1.5 枚举取值表（格式参考末尾、完整示例之前）---
  const enumTable = [
    '## 枚举取值表（必须严格使用以下中文值）',
    '',
    '- 装备槽位(slot): 武器 / 副手 / 头部 / 身体 / 手部 / 脚部 / 腰带 / 饰品',
    '- 物品类型(type): 装备 / 消耗品 / 材料 / 任务物品 / 特殊',
    '- 品质(rarity): 普通 / 优良 / 稀有 / 史诗 / 传说 / 神话 / 唯一',
    '- 任务状态(status): 进行中 / 已完成 / 失败 / 搁置',
    '- 状态效果分类(category): 增益 / 减益 / 特殊',
    '',
    '---',
    '',
    '# 完整示例',
  ].join(EOL);
  sp = rep(sp, '---' + EOL + EOL + '# 完整示例', enumTable, 1, 'vu insert-enum-table');

  // --- 1.6 事后自检 ---
  if (sp.includes('player_1')) { console.error('ABORT: vu still has player_1'); process.exit(1); }
  if (sp.includes('npc_001')) { console.error('ABORT: vu still has npc_001'); process.exit(1); }
  if (sp.includes('"id"')) { console.error('ABORT: vu still has "id" json key'); process.exit(1); }

  cfg.agents.vars_update.systemPrompt = sp;
  console.log('vars_update: ' + before + ' -> ' + sp.length + ' chars');
}

// ============================================================
// Task 2: request_dispatcher
// ============================================================
{
  let sp = cfg.agents.request_dispatcher.systemPrompt;
  const EOL = sp.includes('\r\n') ? '\r\n' : '\n';
  const before = sp.length;

  // --- 2.1 规则/自检/格式行: target 用角色名 ---
  sp = rep(sp, '<char_update_request target="已有ID">', '<char_update_request target="已有角色名">', 1, 'rd rule-target');
  sp = rep(sp, '（记下 ID）', '（记下角色名）', 1, 'rd think-id');
  sp = rep(sp,
    '每个已有角色更新都用了正确的 target ID（与 <已有角色> 中的 ID 一致）？',
    '每个已有角色更新的 target 都是角色名（与 <已有角色> 中的 Name 一致，不是 ID）？',
    1, 'rd selfcheck');
  sp = rep(sp, '<char_update_request target="角色ID">', '<char_update_request target="角色名">', 1, 'rd fmt-char-update');

  // --- 2.2 owner 属性文档化（item_gen_request 明确"持有者的角色名（不是 id）"）---
  sp = rep(sp,
    '<item_gen_request itemType="equipment/skill/consumable/material/ascension" source="craft/loot/gift/story" owner="归属角色ID">',
    '<item_gen_request itemType="equipment/skill/consumable/material/ascension" source="craft/loot/gift/story" owner="持有者的角色名（不是 id）">',
    1, 'rd fmt-item-gen-owner');
  sp = rep(sp,
    '<item_update_request target="物品名" operation="consume/transfer/modify/equip/unequip" quantity="数量" owner="归属角色ID">',
    '<item_update_request target="物品名" operation="consume/transfer/modify/equip/unequip" quantity="数量" owner="归属角色名">',
    1, 'rd fmt-item-update-owner');
  sp = rep(sp, 'characterId="执行制作的角色ID"', 'characterId="执行制作的角色名"', 1, 'rd fmt-craft-charid');

  // --- 2.3 意识体/附灵 判定规则（角色判断 章节追加 bullet）---
  sp = rep(sp,
    '→ 视为同一人，走 char_update_request',
    '→ 视为同一人，走 char_update_request' + EOL + '- 有名字、会对话、会持续出场的意识体/附灵/器灵（如寄宿在物品中的人格）按新角色处理，输出 char_gen_request',
    1, 'rd yishiti-rule');

  // --- 2.4 示例 id → 真实角色名 ---
  sp = rep(sp, '**已有角色**: player_1（阿尔冯斯, T3），npc_guard_01（城门守卫, T1）', '**已有角色**: 理查德（玩家, T3），巴特（城门守卫, T1）', 1, 'rd ex1-roster');
  sp = rep(sp, '"你"即 player_1 在已有角色中', '"你"即玩家角色理查德，在已有角色中', 1, 'rd ex1-think-player');
  sp = rep(sp, '角色状态: player_1 花费50金币', '角色状态: 理查德 花费50金币', 1, 'rd ex1-think-state');
  sp = rep(sp, 'target="player_1"', 'target="理查德"', 1, 'rd ex1-target');
  sp = rep(sp, 'owner="player_1"', 'owner="理查德"', 3, 'rd ex1-owner');
  sp = rep(sp, 'characterId="player_1"', 'characterId="理查德"', 1, 'rd ex1-craft');
  sp = rep(sp, '**已有角色**: player_1, npc_guard_01（城门守卫, T1）', '**已有角色**: 理查德（玩家）, 巴特（城门守卫, T1）', 1, 'rd ex2-roster');
  sp = rep(sp, '**已有角色**: npc_001 (绮萝莉娅, T4, 古代教团圣女)', '**已有角色**: 绮萝莉娅 (T4, 古代教团圣女)', 1, 'rd ex3-roster');
  sp = rep(sp, 'target="npc_001"', 'target="绮萝莉娅"', 1, 'rd ex3-target');

  // --- 2.5 事后自检 ---
  if (sp.includes('player_1')) { console.error('ABORT: rd still has player_1'); process.exit(1); }
  if (sp.includes('npc_guard_01')) { console.error('ABORT: rd still has npc_guard_01'); process.exit(1); }
  if (sp.includes('npc_001')) { console.error('ABORT: rd still has npc_001'); process.exit(1); }

  cfg.agents.request_dispatcher.systemPrompt = sp;
  console.log('request_dispatcher: ' + before + ' -> ' + sp.length + ' chars');
}

// ============================================================
// Task 3a: item_gen — slot/type 枚举对齐 field-enums.ts + mojibake 修复
// ============================================================
{
  let sp = cfg.agents.item_gen.systemPrompt;
  const before = sp.length;

  sp = rep(sp,
    'valid slot: 武器, 护甲, 头部, 身体, 饰品, 腰带, 鞋子, 主手, 副手, 惯用手',
    'valid slot: 武器, 副手, 头部, 身体, 手部, 脚部, 腰带, 饰品',
    1, 'ig valid-slot');
  sp = rep(sp,
    'slot="武器|护甲|身体|头部|饰品|腰带|鞋子|主手|副手|惯用手"',
    'slot="武器|副手|头部|身体|手部|脚部|腰带|饰品"',
    1, 'ig fmt-slot');
  sp = rep(sp, '类型标注（消耗品/材料/任务物品/特殊）', '类型标注（装备/消耗品/材料/任务物品/特殊）', 1, 'ig type-note');
  sp = rep(sp, 'type="消耗品|材料|任务物品|特殊"', 'type="装备|消耗品|材料|任务物品|特殊"', 1, 'ig fmt-type');
  // 修复既有 mojibake: <element name="��素名"> → 要素名
  sp = rep(sp, 'name="��素名"', 'name="要素名"', 1, 'ig mojibake');

  // 事后自检: 无 id 属性、无旧槽位残留
  if (/<(item|skill|equip|equipment)\s+id=/.test(sp)) { console.error('ABORT: ig has id= attr'); process.exit(1); }
  for (const bad of ['惯用手', '主手', '鞋子', '�']) {
    if (sp.includes(bad)) { console.error('ABORT: ig still contains ' + JSON.stringify(bad)); process.exit(1); }
  }

  cfg.agents.item_gen.systemPrompt = sp;
  console.log('item_gen: ' + before + ' -> ' + sp.length + ' chars');
}

// ============================================================
// Task 3b: char_gen — 仅验证（XML 示例无 id= 属性）
// ============================================================
{
  const sp = cfg.agents.char_gen.systemPrompt;
  if (/ id=/.test(sp) || sp.includes('<item id=') || sp.includes('<skill id=') || sp.includes('player_1')) {
    console.error('ABORT: char_gen unexpectedly contains id= attr or player_1 — needs manual edit');
    process.exit(1);
  }
  console.log('char_gen: verified clean (no id= attributes, no player_1), no edit needed');
}

// ============================================================
// 终检 + 写回
// ============================================================
// 不破坏并行 T4 已完成的 story preset 修改（char_detect 教学已删）
if (JSON.stringify(cfg.agents.story).includes('char_detect')) {
  console.error('ABORT: story preset regained char_detect?! refusing to write');
  process.exit(1);
}

const out = JSON.stringify(cfg, null, 2);
JSON.parse(out); // 可解析性终检
fs.writeFileSync(path, out, 'utf8');
console.log('DONE: ' + totalEdits + ' replacements applied. File written (' + Buffer.byteLength(out) + ' bytes, pretty-2, no trailing newline).');
