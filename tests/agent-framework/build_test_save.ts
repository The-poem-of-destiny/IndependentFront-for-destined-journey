/**
 * 构建测试存档 — 使用引擎类型和函数生成，保证字段完全匹配
 * 运行: npx tsx tests/agent-framework/build_test_save.ts
 */
import { createDefaultCharacterState, type CharacterState } from '../../src/sillytavern/types.js';
import { createDefaultTime, type GameTime } from '../../src/sillytavern/time-system.js';
import { calcHP, calcMP, calcSP } from '../../src/sillytavern/tier-constants.js';
import { createDefaultSaveProfile } from '../../src/sillytavern/database.js';
import fs from 'fs';

function loadWorldBooks(ids: string[]): any[] {
  const books: any[] = [];
  for (const id of ids) {
    const path = `data/worldbooks/${id}.json`;
    if (fs.existsSync(path)) {
      try {
        const data = JSON.parse(fs.readFileSync(path, 'utf-8'));
        if (Array.isArray(data)) {
          books.push({ id, name: id, entries: data });
        } else if (data && typeof data === 'object') {
          books.push(data.id ? data : { id, name: id, entries: data.entries || [] });
        }
      } catch {}
    }
  }
  return books;
}

const SAVE_ID = 'save-progressive';
const NOW = Date.now();

/**
 * 真实游戏实例对话源 (reference/游戏实例_对话.json): SillyTavern 导出的完整对话 (98 条 mes),
 * 每条 AI mes 的 <gametxt> 内含 Recorder 思维链 + 叙事正文 + <!-- ..Think --> 注释 + 面板 XML.
 * extractNarrative 把某条 AI mes 清洗为纯叙事正文: 删注释、删所有面板标签、按起点锚截取正文段.
 */
const RAW_CHAT_PATH = 'reference/游戏实例_对话.json';
const _rawChat = JSON.parse(fs.readFileSync(RAW_CHAT_PATH, 'utf-8')) as Array<any>;
// 真实游戏实例对话源 (reference/游戏实例_对话.json): SillyTavern 导出的完整对话 (98 条 mes),
// 每条 AI mes 的 <gametxt> 内含 [Recorder 思维链前缀 + <tp>时间戳 + 正文 + <!-- ..Think --> 注释 + <item_info>/<char_info> HTML 面板].
// extractNarrative: 思维链/面板/注释都在 <gametxt> 内, 但开标签常在思维链而闭标签在正文内, 若先做全段非贪婪 strip 会跨吞正文.
// 故采用「先按起点锚朴素切片 (丢弃思维链, 留正文段) → 再在正文段内删注释与成对面板」策略, 配对在正文段内必完整, 不会跨吞.
const _stripTags = [
  'item_info', 'char_info', 'status_current_variables', 'action_info', 'task_info',
  'sex_style', 'tp', 'summary', 'StatusPlaceHolderImpl', 'customized',
  'custom_start_data', 'UpdateVariable', 'Analysis', 'var', 'think',
  'maintext', 'option', 'sum', 'gametxt',
];
export function extractNarrative(aiMes: string, anchor: string): string {
  const full = (aiMes.match(/<gametxt>([\s\S]*?)<\/gametxt>/) || [])[1];
  if (!full) throw new Error('AI mes 中未找到 <gametxt>');
  const i = full.indexOf(anchor);                    // 按起点锚切片 (思维链在锚之前, 一并丢弃)
  if (i < 0) throw new Error('正文起点锚未命中: ' + anchor + ' (full len=' + full.length + ')');
  let t = full.slice(i);                              // 正文段
  t = t.replace(/<!--[\s\S]*?-->/g, '');             // 删 charThink/itemThink 等注释
  for (const tag of _stripTags) {                     // 删正文段内成对面板 + 孤立标签 (配对在段内完整, 非贪婪不会跨吞)
    t = t.replace(new RegExp('<' + tag + '[\\s\\S]*?</' + tag + '>', 'g'), '');
    t = t.replace(new RegExp('</?' + tag + '\\s*[^>]*>', 'g'), '');
  }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// ===== 柠萌茶 (Player T3 Lv.9) =====
const player = createDefaultCharacterState({
  id: 'char-player-001', type: 'player', name: '柠萌茶', race: '人类',
  identity: ['B级冒险者', '炼金专家'], occupation: ['炼金术师'],
  tier: 3, tierName: '精英', level: 9,
  attributes: { str: 5, dex: 5, con: 5, int: 12, spi: 8 },
}) as CharacterState;
player.maxHp = calcHP(3, player.attributes.con); player.hp = player.maxHp;
player.maxMp = calcMP(3, player.attributes.int); player.mp = player.maxMp;
player.maxSp = calcSP(3, player.attributes.spi); player.sp = player.maxSp;
player.money = 2500;
player.location = '中南部-瓦伦蒂亚公国-诺瓦·瓦伦蒂亚城-中城区-私人住宅-仓库';
player.adventurerRank = 'B';
player.currentAction = '在仓库中发现石棺中的少女';
player.equipment = [
  { slot: '腰部', itemId: 'eq-belt-001', name: '制式次元腰包', description: '冒险者标配的空间储物装备', stats: {}, durability: 100, maxDurability: 100,
    effects: { '便携空间': '提供额外储存空间，可存放体积不超过1立方米的物品' } },
  { slot: '头部', itemId: 'eq-hat-001', name: '法师之帽', description: '镶嵌蓝宝石的法师帽', stats: { '智力': 2 }, durability: 80, maxDurability: 80,
    effects: { '法力凝聚': '略微提升法力恢复速度' } },
  { slot: '身体', itemId: 'eq-robe-001', name: '奥术导师法袍', description: '绣有星辰图案的深蓝色华美法袍', stats: { '防御力': 45, '智力': 4 }, durability: 120, maxDurability: 120,
    effects: { '奥术亲和': '提升奥术法术伤害20%', '魔力护盾': '受到攻击时自动展开魔力护盾吸收100点伤害' },
    scripts: { 'init': '$event.on("combat_action", "onOwnerHit", function(ctx) { $resource.modifyHp(ctx.owner, Math.min(100, ctx.event.damage || 0)); });' } },
  { slot: '头部', itemId: 'eq-orb-001', name: '聚能魔晶法球', description: '一颗手掌大的透明水晶球，内部交织着各种元素的能量螺旋', stats: { '攻击力': 85, '智力': 5 }, durability: 100, maxDurability: 100,
    effects: { '魔力增幅': '提升法术伤害15%', '元素凝聚': '缩短法术吟唱时间20%' } },
];
player.customFields.saveId = SAVE_ID;

// ===== 绮萝莉娅 (NPC T5 Lv.19) =====
const qll = createDefaultCharacterState({
  id: 'char-npc-qll', type: 'npc', name: '绮萝莉娅', race: '人类(变异血脉)',
  identity: ['无尽树海教团圣女', '远古仪式的幸存者'], occupation: ['神术师', '灵体存在'],
  tier: 5, tierName: '传说', level: 19,
  attributes: { str: 6, dex: 6, con: 6, int: 11, spi: 12 },
}) as CharacterState;
qll.maxHp = calcHP(5, qll.attributes.con); qll.hp = qll.maxHp;
qll.maxMp = calcMP(5, qll.attributes.int); qll.mp = qll.maxMp;
qll.maxSp = calcSP(5, qll.attributes.spi); qll.sp = qll.maxSp;
qll.money = 0;
qll.location = player.location;
qll.adventurerRank = '未评级';
qll.currentAction = '刚刚苏醒，与柠萌茶以灵体对话';
qll.bloodlineIds = ['人类变异血脉'];
qll.customFields = {
  saveId: SAVE_ID,
  background: '绮萝莉娅曾是无尽树海深处某古代教团的圣女，数百年前在一次登神仪式中失败，灵魂与肉体分离，被封印于石棺中沉睡至今。',
  appearance: '冰蓝色及腰长发如冻结的瀑布，蓝粉混合色的双瞳透出非人的空灵。身材匀称但腹部异常隆起（仪式后遗症）。',
  personality: '外表疏离冷淡，内心情感深沉。对信任者展现意外温柔。性格编码: dOlgY(F)',
  innerThoughts: '无知又冒失的人类……但至少不是完全的蠢货。瓦伦蒂亚城，488年……一切都变了。',
  ascensionPath: '登神长阶·生命摇篮',
  ascensionDescription: '未完成的登神仪式使身体成为"生命摇篮"——一个能够孕育特殊存在的容器。',
  contractBond: true, affection: 49,
};
qll.ascension = {
  enabled: true,
  elements: { '频率': { name: '共鸣', description: '精神伤害攻击时10%几率与目标灵魂产生共鸣，无视20%精神抗性', effects: ['精神伤害共鸣', '抗性穿透20%'] } },
  authority: {}, law: {}, deityPosition: '', divineKingdom: { name: '', description: '' },
};
qll.equipment = [
  { slot: '武器', itemId: 'eq-qll-staff', name: '彼岸花法杖', description: '猩红水晶与未知枯木制成的法杖，顶端盛开永不凋零的彼岸花', stats: { '攻击力': 520, '精神': 8 }, durability: 999, maxDurability: 999,
    effects: { '凋零之蕊': '施展退场式战技时留下凋零旋律，下一位接替友军精神伤害+25%，持续15秒' },
    scripts: { 'onRetire': '$status.add(nextAlly, { name: "凋零旋律", category: "增益", stacks: 1, duration: 15, timeUnit: "秒", effects: { "精神伤害": 25 } });' } },
  { slot: '护甲', itemId: 'eq-qll-dress', name: '圣仪华裙', description: '无尽树海教团圣女的仪式礼服，嵌有自动修复法阵', stats: { '防御力': 120, '精神': 4 }, durability: 999, maxDurability: 999,
    effects: { '自动修复': '破损后自动复原，每回合恢复耐久度至满' },
    scripts: { 'onTick': '$resource.modifyHp(owner, 5);' } },
];
qll.skills = [
  { id: 'sk-qll-01', name: '序曲·止息', description: '挥动法杖发动至多四段连续攻击，造成精神伤害。命中敌人获得【乐章】灵感。可蓄力发动重击造成范围精神伤害。', type: 'active', level: 1,
    effects: { '连击': '至多四段攻击', '乐章积累': '每次命中获得【乐章】灵感' },
    scripts: { 'onHit': '$status.add(owner, { name: "乐章", category: "增益", stacks: 1, maxStacks: 100, stackable: true, effects: {} });' } },
  { id: 'sk-qll-02', name: '间奏·失调', description: '奏响刺耳乐章，对周围5米内敌人造成精神伤害，附加【失调】状态（精神抗性-10%，持续8秒）。', type: 'active', cost: { type: 'MP', amount: 300 }, cooldown: 0, maxCooldown: 8, level: 1,
    effects: { '范围': '5米半径', '失调': '精神抗性-10%，8秒', '乐章爆发': '获得大量【乐章】灵感' },
    scripts: { 'onCast': '$status.add(target, { name: "失调", category: "减益", stacks: 1, duration: 8, timeUnit: "秒", effects: { "精神抗性": -10 } });' } },
  { id: 'sk-qll-03', name: '终曲·赫卡忒', description: '消耗所有【协奏能量】，召唤猩红魔女人偶·赫卡忒登场协同攻击，造成大范围精神伤害。赫卡忒留在场上20秒，属性与召唤者一致。', type: 'active', cost: { type: 'MP', amount: 1200 }, cooldown: 0, maxCooldown: 20, level: 1,
    effects: { '召唤': '召唤赫卡忒人偶', '范围伤害': '大范围精神伤害', '持续时间': '20秒' },
    scripts: { 'onCast': '$status.add(owner, { name: "赫卡忒召唤", category: "增益", stacks: 1, duration: 20, timeUnit: "秒", effects: {} });', 'cleanup': '$status.remove(owner, "赫卡忒召唤");' } },
  { id: 'sk-qll-04', name: '华彩乐段', description: '战斗中积攒【乐章】灵感(上限100点)。灵感满溢时蓄力重击升华为【华彩·猩红回响】，转化所有灵感为【协奏能量】。', type: 'passive', level: 1,
    effects: { '乐章上限': '100点', '转化': '满溢时转为【协奏能量】' },
    scripts: { 'init': '$event.on("combat_action", "onFullStacks", function(ctx) { var s = $status.getStacks(ctx.owner, "乐章"); if (s >= 100) { $status.setStacks(ctx.owner, "乐章", 0); $status.add(ctx.owner, { name: "协奏能量", category: "增益", stacks: 1, maxStacks: 1, stackable: false, effects: {} }); } });' } },
  { id: 'sk-qll-05', name: '声骸共生', description: '受到致命伤害时免疫此次伤害，强制赫卡忒代为承受并毁灭。触发后进入70秒【寂静】状态无法施放。', type: 'passive', level: 1,
    effects: { '濒死保护': '受到致命伤害时免疫，赫卡忒代为承受', '寂静': '70秒无法施放' },
    scripts: {
      'init': '$event.on("combat_action", "onOwnerDamaged", function(ctx) { if ($resource.getHp(ctx.owner) <= 0) { $resource.modifyHp(ctx.owner, 1); $status.remove(ctx.owner, "赫卡忒召唤"); $status.add(ctx.owner, { name: "寂静", category: "减益", stacks: 1, duration: 70, timeUnit: "秒", stackable: false, maxStacks: 1, effects: {} }); } });',
      'cleanup': '$event.off("combat_action", "onOwnerDamaged");',
    } },
];
qll.statusEffects = [
  { id: 'se-soulsplit', name: '灵魂分离', description: '灵魂无法操控身体，只能以灵体对话。身体对外界指令有最低限度的自主反应。',
    category: '特殊', stacks: 1, maxStacks: 1, stackable: false, remainingTime: null, timeUnit: '小时',
    source: '登神仪式失败-[绮萝莉娅]; 未知解除条件',
    effects: {},
    effectDescriptions: { '灵体对话': '角色可以使用灵体进行交流，但无法通过身体施放技能或进行物理攻击', '自主反应': '身体对语言指令有最低限度的反应，可能自发执行简单动作' },
  },
];
qll.inventory = [
  { id: 'inv-qll-badge', name: '远古教团圣徽', description: '无尽树海古代教团的圣徽，其上镌刻着失传的仪式符文。可能在教团遗址触发隐藏事件。', quantity: 1, type: '任务物品', rarity: '传说' as const,
    effects: { '隐藏钥匙': '在教团遗址中使用可触发隐藏事件' } },
  { id: 'inv-qll-soul', name: '魂晶碎片', description: '封印灵魂能量的结晶体碎片，可用于临时强化灵体类技能或作为高级炼金材料。', quantity: 3, type: '消耗品', rarity: '稀有' as const,
    effects: { '灵体强化': '使用后30分钟内灵体类技能效果+50%' } },
];

const characters = [player, qll];

// ===== GameTime =====
const gameTime: GameTime = createDefaultTime('复兴纪元');
gameTime.year = 488; gameTime.month = 8; gameTime.day = 15;
gameTime.weekday = 3; gameTime.hour = 20; gameTime.minute = 30;

// ===== SaveProfile =====
const saveProfile = createDefaultSaveProfile(SAVE_ID);
saveProfile.fp = 200;
saveProfile.gameTime = gameTime;
saveProfile.affections = { 'char-npc-qll': 49 };
saveProfile.fpHistory = [{ id: 'fp-init', timestamp: NOW, amount: 200, reason: '初始命运点数', balance: 200, source: 'other' }];

// ===== Snapshots =====
const turnTimes = [
  { h: 20, m: 13, label: '初始' },
  { h: 20, m: 30, label: '发现绮萝莉娅' },
  { h: 20, m: 38, label: '初次交锋' },
  { h: 20, m: 45, label: '撒娇与契约' },
  { h: 21, m: 0, label: '圣女的过去' },
];
function makeGameTime(h: number, m: number): GameTime {
  const t = createDefaultTime('复兴纪元');
  t.year = 488; t.month = 8; t.day = 15; t.weekday = 3; t.hour = h; t.minute = m;
  return t;
}
const baseVars: Record<string, any> = {
  '世界': { '时间': '', '地点': '中南部-瓦伦蒂亚公国-诺瓦·瓦伦蒂亚城-中城区-私人住宅-仓库' },
  '主角': { '金钱': 2500, '生命层级': '第三层级/精英层级', '等级': 9 },
  '任务列表': { '深绿之心 (团队)': { '状态': '已结算', '详情': '受瓦伦蒂亚公国委托，深入无尽树海寻找古代遗物' } },
  '命运点数': 200,
};
const snapshots = turnTimes.map((tt, i) => {
  const t = makeGameTime(tt.h, tt.m);
  const vars = JSON.parse(JSON.stringify(baseVars)) as Record<string, any>;
  vars['世界']['时间'] = `复兴纪元488年-08月-15日-${t.hour}:${String(t.minute).padStart(2, '0')}`;
  if (i >= 1) {
    vars['关系列表'] = {
      '绮萝莉娅': {
        '在场': true, '生命层级': '第五层级/传说层级', '等级': 19,
        '好感度': [0, 10, 15, 23, 30][i] || 0,
        '心里话': ['', '无知的人类……', '他自称主人……', '和我想象的完全不一样', '有意思……'][i] || '',
      },
    };
  }
  return {
    id: 'snap-turn-' + (i + 1), saveId: SAVE_ID, index: i,
    timestamp: NOW + i * 60000,
    gameTime: `复兴纪元488年-08月-15日-${t.hour}:${String(t.minute).padStart(2, '0')}`,
    turnNumber: i + 1, label: tt.label,
    variables: vars, characters: [], plotEvents: [],
    memoryIds: i >= 1 ? ['mem-turn-' + (i + 1)] : [],
  };
});

// ===== Memories =====
const memTemplates = [
  null as any,
  { c: '柠萌茶将A级任务奖励古代石棺擦拭后，发现棺盖接缝。掀开石棺后发现里面沉睡着名叫绮萝莉娅的少女。少女拥有冰蓝色长发和蓝粉混合色异瞳，身着华丽白裙，腹部高高隆起却仍是处女。她以灵体对话与柠萌茶交流，自称是古老教团的圣女，数百年前在一次登神仪式中失败后被封印于此。', h: '石棺中沉睡的教团圣女苏醒，与柠萌茶建立初识关系', kw: ['石棺', '圣女', '苏醒', '灵体对话', '教团'], imp: 8 },
  { c: '绮萝莉娅对柠萌茶的冒犯感到愤怒，但柠萌茶以她身体无法动弹为由拒绝道歉，自称是她的主人。他介绍了瓦伦蒂亚城的所在地。绮萝莉娅震惊于自己被转移到大陆南部，距教团所在的无尽树海极远，时间已过去29年。两人发生口角，柠萌茶让绮萝莉娅明白自己已无依靠。', h: '柠萌茶与绮萝莉娅初次交锋确立主从关系', kw: ['主从关系', '瓦伦蒂亚城', '时间流逝', '冲突'], imp: 6 },
  { c: '绮萝莉娅改变策略用撒娇方式要求柠萌茶保护她的身体，建议对外伪装成炼金人偶。柠萌茶询问教团之事，她承认是教团最强圣女，但表示接受宠物身份，只要柠萌茶答应保护条件。两人关系开始缓和。', h: '绮萝莉娅接受宠物身份，与柠萌茶达成初步契约', kw: ['契约', '人偶伪装', '宠物', '教团'], imp: 7 },
  { c: '柠萌茶确认绮萝莉娅是教团最强者。绮萝莉娅表示从未想过当教主。柠萌茶带她去浴室清洗时，绮萝莉娅透露无法感知身体触觉，但身体对语言指令有反应。柠萌茶对这种灵肉分离的现象十分好奇。', h: '确认实力背景，发现身体对语言反应的现象', kw: ['教团最强', '身体反应', '浴室', '灵肉分离'], imp: 7 },
];
const memories = [];
for (let t = 2; t <= 5; t++) {
  const tpl = memTemplates[t - 1]; if (!tpl) continue;
  memories.push({
    id: 'mem-turn-' + t, saveId: SAVE_ID, createdAt: NOW + t * 60000, realTimestamp: NOW + t * 60000,
    timeRange: { start: `复兴纪元488年-08月-15日-${turnTimes[t-2].h}:${String(turnTimes[t-2].m).padStart(2,'0')}`, end: `复兴纪元488年-08月-15日-${turnTimes[t-1].h}:${String(turnTimes[t-1].m).padStart(2,'0')}` },
    content: tpl.c, hiddenLine: tpl.h, keywords: tpl.kw,
    relatedCharacterIds: ['char-player-001', 'char-npc-qll'], importance: tpl.imp,
  });
}

// ===== ChatSession =====
// 5 轮真实对话 — 提取自 reference/游戏实例_对话.json 的发现绮萝莉娅线 (user idx 3/5/7/9/11, ai idx 4/6/8/10/12).
// user 消息取源里 is_user 的 mes 原样 (口语化玩家意图含括号设定注解); assistant 用 extractNarrative 清洗后的纯叙事正文 (按起点锚截取思维链之后的正文段).
const roundAnchors: Record<number, string> = {
  4:  '仓库里的空气',
  6:  '面对那双冰冷',
  8:  '面对柠萌茶那混杂着得意',
  10: '他的手掌托在她的臀下',
  12: '浴缸里的热水满得快要溢出',
};
const roundUserMsg: Record<number, string> = {
  3: (_rawChat[3]?.mes || '').trim(),
  5: (_rawChat[5]?.mes || '').trim(),
  7: (_rawChat[7]?.mes || '').trim(),
  9: (_rawChat[9]?.mes || '').trim(),
  11: (_rawChat[11]?.mes || '').trim(),
};
const roundAiMsg: Record<number, string> = {
  4:  extractNarrative(_rawChat[4]?.mes || '',  roundAnchors[4]),
  6:  extractNarrative(_rawChat[6]?.mes || '',  roundAnchors[6]),
  8:  extractNarrative(_rawChat[8]?.mes || '',  roundAnchors[8]),
  10: extractNarrative(_rawChat[10]?.mes || '', roundAnchors[10]),
  12: extractNarrative(_rawChat[12]?.mes || '', roundAnchors[12]),
};
const rawMessages: Array<{ role: string; content: string }> = [
  { role: 'user', content: roundUserMsg[3] },
  { role: 'assistant', content: roundAiMsg[4] },
  { role: 'user', content: roundUserMsg[5] },
  { role: 'assistant', content: roundAiMsg[6] },
  { role: 'user', content: roundUserMsg[7] },
  { role: 'assistant', content: roundAiMsg[8] },
  { role: 'user', content: roundUserMsg[9] },
  { role: 'assistant', content: roundAiMsg[10] },
  { role: 'user', content: roundUserMsg[11] },
  { role: 'assistant', content: roundAiMsg[12] },
];
const messages = rawMessages.map((m, i) => ({ ...m, id: 'msg-' + (i + 1), timestamp: NOW + i * 30000 }));

const chatSession = {
  id: 'chat-test-progressive', name: '测试对话: 发现绮萝莉娅 (5轮)',
  messages, characterName: '柠萌茶', userName: '柠萌茶',
  presetId: null as string | null, lorebookIds: ['system_core', 'race', 'faction', 'character'],
  variables: JSON.parse(JSON.stringify(baseVars)), createdAt: NOW, updatedAt: NOW,
};
chatSession.variables['关系列表'] = snapshots[4]!.variables['关系列表'];

// ===== SaveSlot =====
const saveSlot = {
  id: SAVE_ID, name: '测试: 发现绮萝莉娅 (5轮渐进)', slot: 9,
  createdAt: NOW, updatedAt: NOW, activeSnapshotId: 'snap-turn-5', snapshots: [] as any[],
  metadata: { characterName: '柠萌茶', userName: '柠萌茶', gameStartTime: '复兴纪元488年-08月-15日-20:13', totalTurns: 5, description: '柠萌茶发现石棺中的教团圣女' },
};

// ===== FullBackup =====
const backup = {
  version: 7, exportedAt: NOW,
  lorebooks: loadWorldBooks(['system_core', 'race', 'faction', 'character', 'variable', 'world_setting']), presets: [], settings: [],
  chats: [chatSession], memories, plotEvents: [], characters, snapshots,
  saves: [saveSlot], apiEndpoints: [], plotOutlines: [],
  saveProfiles: [saveProfile], createPresets: [],
};

const outPath = 'tests/agent-framework/fixtures/test_save_progressive.json';
fs.writeFileSync(outPath, JSON.stringify(backup, null, 2), 'utf-8');
console.log('Written:', outPath, '(' + (fs.statSync(outPath).size / 1024).toFixed(0) + ' KB)');

// Quick verify effects/scripts coverage
const withEffects = (arr: any[]) => arr.filter(x => x.effects && Object.keys(x.effects).length > 0).length;
const withScripts = (arr: any[]) => arr.filter(x => x.scripts && Object.keys(x.scripts).length > 0).length;
console.log('Skills with effects:', withEffects(qll.skills), '/', qll.skills.length);
console.log('Skills with scripts:', withScripts(qll.skills), '/', qll.skills.length);
console.log('Equipment with effects:', withEffects([...player.equipment, ...qll.equipment]), '/', player.equipment.length + qll.equipment.length);
console.log('Equipment with scripts:', withScripts([...player.equipment, ...qll.equipment]), '/', player.equipment.length + qll.equipment.length);
console.log('StatusEffects with effectDescriptions:', qll.statusEffects.filter(s => s.effectDescriptions && Object.keys(s.effectDescriptions).length > 0).length);
console.log('Inventory with effects:', withEffects(qll.inventory), '/', qll.inventory.length);
