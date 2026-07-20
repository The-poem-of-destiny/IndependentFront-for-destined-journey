// M4 Tasks 1-3 assertion check (strict: fails => exit 1)
const cfg = JSON.parse(require('fs').readFileSync('E:/code/fated_poem_independent/data/defaults/agent-config.json', 'utf8'));
const vu = cfg.agents.vars_update.systemPrompt;
const rd = cfg.agents.request_dispatcher.systemPrompt;
const ig = cfg.agents.item_gen.systemPrompt;
const cg = cfg.agents.char_gen.systemPrompt;

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error('ASSERT FAIL: ' + msg); }
}

// vars_update checks
assert(vu.includes('"name":'), 'vars_update: missing "name": key');
assert(!vu.includes('"id": "player_1"'), 'vars_update: player_1残留');
assert(vu.includes('quests'), 'vars_update: missing quests');
assert(vu.includes('affections'), 'vars_update: missing affections');
assert(vu.includes('枚举取值'), 'vars_update: missing enum table');
// extra hardening
assert(!vu.includes('player_1'), 'vars_update: player_1 anywhere');
assert(!vu.includes('npc_001'), 'vars_update: npc_001残留');
assert(!vu.includes('"id"'), 'vars_update: "id" json key残留');
assert(vu.includes('upsert'), 'vars_update: missing quests upsert');
assert(vu.includes('进行中') && vu.includes('搁置'), 'vars_update: quest status enum incomplete');
assert(vu.includes('[-100,100]'), 'vars_update: affection range missing');

// dispatcher checks
assert(!rd.includes('player_1'), 'dispatcher: player_1残留');
assert(rd.includes('owner='), 'dispatcher: missing owner attr');
assert(rd.includes('意识体'), 'dispatcher: missing 意识体 rule');
// extra hardening
assert(!rd.includes('npc_guard_01') && !rd.includes('npc_001'), 'dispatcher: npc id残留');
assert(rd.includes('持有者的角色名（不是 id）'), 'dispatcher: owner attr doc wording missing');
assert(rd.includes('理查德'), 'dispatcher: player name missing');

// item_gen checks
assert(ig.includes('武器') && ig.includes('饰品'), 'item_gen: slot enum incomplete');
assert(!ig.includes('<item id='), 'item_gen: id attr残留');
assert(!ig.includes('<skill id='), 'item_gen: skill id残留');
// extra hardening
assert(ig.includes('手部') && ig.includes('脚部') && ig.includes('副手'), 'item_gen: canonical slots missing');
assert(!ig.includes('惯用手') && !ig.includes('主手') && !ig.includes('鞋子'), 'item_gen: legacy slot values残留');
assert(ig.includes('type="装备|消耗品|材料|任务物品|特殊"'), 'item_gen: type enum not aligned');
assert(!ig.includes('�'), 'item_gen: mojibake残留');

// char_gen checks
assert(!cg.includes('<item id='), 'char_gen: id attr残留');
assert(!/ id=/.test(cg), 'char_gen: any id= attr残留');

if (failed > 0) { console.error(failed + ' assertion(s) failed'); process.exit(1); }
console.log('All M4 prompt assertions passed!');
