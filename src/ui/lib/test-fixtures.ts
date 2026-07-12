/**
 * ChatFlow 测试夹具 — 覆盖全部 7 种系统事件卡片 + user/assistant 消息流
 *
 * 使用方式: 在浏览器控制台调用 window.__injectChatFlowFixtures__()
 */

import type { ChatMessage } from '@engine/types'
import { toSystemMessage } from './toSystemEvent'
import type {
  CraftGenOutput, CharGenOutput, ItemGenOutput, CombatSummaryResult,
} from '@engine/types'

// ========== Mock 数据构造 ==========

function makeCraftOutput(): CraftGenOutput {
  return {
    success: true,
    productName: '霜月之刃',
    quality: '传说',
    rating: '成功',
    checkSummary: 'DC18，d20掷出15+5(力量)+2(锻造技能)+3(材料加成)=25，总检定值25 vs DC18，评级: 成功',
    perfectionBonus: '单件-获得额外词条: 冰焰共鸣',
    itemRequests: [
      { type: 'equipment' as const, slot: '武器', quality: '传说', description: '以月光钢锭和龙息余烬在深夜锻造的长剑。剑身同时缠绕寒气与烈焰，每次攻击交替造成冰霜或灼烧伤害。' },
    ],
    narrative: '锤落下最后一击时，炉火中腾起一道蓝白相间的光柱。剑身从赤红渐渐冷却为银白，刃面上浮现出霜花与火焰交织的纹路。你拿起剑的瞬间，一股冰冷的灼烧感从掌心传入骨髓——这把剑认得你了。',
    craftParams: {
      industry: '锻造',
      targetQuality: '传说',
      stage: '成品',
      quantity: 1,
      materials: '月光钢锭×3, 霜狼之牙×2, 龙息余烬×1, 极北寒铁×2',
      expGained: 4000,
      fpGained: 50,
    },
  }
}

function makeCraftOutputExcellent(): CraftGenOutput {
  return {
    success: true,
    productName: '翠绿回复药剂×3',
    quality: '优良',
    rating: '精益求精',
    checkSummary: 'DC8，d20掷出18+3(智力)+2(炼金技能)=23，总检定值23 vs DC8，评级: 精益求精',
    perfectionBonus: '品质跃升-从优良跃升至稀有',
    itemRequests: [
      { type: 'inventory' as const, quality: '优良', description: '翠绿色的回复药剂，瓶底沉淀着细小的金色颗粒。饮用后恢复80HP并在3回合内持续恢复。' },
    ],
    narrative: '你将草药研磨成细粉，混合入基础溶剂中。液体在瓶中缓缓变成翠绿色，散发出清新的药草香气。瓶底沉淀着细小的金色颗粒——这是品质超乎预期的标志。',
    craftParams: {
      industry: '炼金',
      targetQuality: '优良',
      stage: '成品',
      quantity: 3,
      materials: '月光草×4, 生命之泉×1, 水晶瓶×3',
      expGained: 800,
      fpGained: 20,
    },
  }
}

function makeCharGenOutput(): CharGenOutput {
  return {
    name: '艾琳·霜语',
    race: '极北精灵',
    gender: '女',
    faction: '诺斯加德联盟',
    tier: 3,
    level: 12,
    attributes: { str: 5, dex: 8, con: 4, int: 9, spi: 10 },
    identity: ['霜语者', '冰原巡行者', '龙族后裔'],
    occupation: ['元素法师', '符文工匠'],
    background: '艾琳出身于极北冰原的霜语氏族，自幼便能听见寒风中传来的古老低语。她在十二岁那年独自穿越冰龙谷，与一头垂死的远古霜龙签订了灵魂契约，获得了操控冰元素的力量。从此她背负着龙族的遗愿，在冰原上巡行，寻找能够终结永恒寒冬的预言之火。',
    appearance: '银白色的长发如瀑布般垂至腰际，发梢泛着淡蓝色的冰晶光泽。皮肤苍白如雪，眼角微挑的冰蓝色瞳孔中闪烁着古老的龙纹。左臂上蔓延着霜蓝色的纹身，那是与霜龙签订契约时留下的印记。身形纤细但线条流畅，指尖常年凝结着细小的冰霜。',
    clothing: '身着一袭冰蓝色的丝绸长袍，外罩一件用霜狼皮毛缝制的白色斗篷。腰间系着一条镶有月光石的符文腰带，每颗符文石都在微微发光。脚穿一双轻便的冰蜥皮靴，行走时几乎不会留下足迹。',
    personality: '冷静、内敛，话语间带着古老的优雅。对陌生人保持距离，但一旦建立信任便会展现出守护者般的温柔。偶尔会在不经意间流露出龙族血脉带来的傲慢与孤寂。喜爱在雪中独行，习惯用诗歌记录所见所闻。',
    likes: '冰雪、月光、古老的诗歌、龙族遗物、极光之夜',
    ascension: {
      enabled: false,
      path: '',
      description: '',
      elements: [],
      authorities: [],
      laws: [],
      deityPosition: '',
      divineKingdom: { name: '', description: '' },
    },
    skills: [
      {
        name: '冰霜箭矢',
        description: '凝聚空气中的水汽形成冰箭射向敌人，造成冰霜伤害并降低目标移动速度。',
        type: 'active',
        cost: { type: 'MP', amount: 15 },
        cooldown: 2,
      },
      {
        name: '霜龙之息',
        description: '释放体内霜龙的吐息之力，对前方锥形范围造成大量冰霜伤害并冻结敌人。',
        type: 'active',
        cost: { type: 'MP', amount: 40 },
        cooldown: 6,
      },
      {
        name: '寒冰护体',
        description: '被动凝聚周围寒气形成护盾，受到攻击时减免 20% 伤害，并对攻击者造成轻微冰霜反弹。',
        type: 'passive',
      },
    ],
    equipment: [
      {
        slot: '主手',
        name: '霜语法杖',
        description: '用千年冰晶雕刻而成的法杖，杖顶镶嵌着一颗永不融化的冰核。提升冰系技能威力。',
        stats: { int: 4, spi: 3 },
        quality: '稀有',
      },
      {
        slot: '身体',
        name: '极光长袍',
        description: '用极光丝绸缝制的法袍，在暗处会散发出微弱的极光色彩。',
        stats: { con: 2, spi: 2 },
        quality: '优良',
      },
    ],
    inventory: [
      {
        name: '极北冰晶',
        description: '只有在极北冰原深处才能找到的稀有晶体，是强大的冰系施法材料。',
        quantity: 5,
        type: '材料',
        rarity: '稀有',
      },
      {
        name: '远古龙鳞碎片',
        description: '从远古霜龙身上脱落的鳞片碎片，蕴含微弱的龙族力量。',
        quantity: 2,
        type: '材料',
        rarity: '史诗',
      },
    ],
  }
}

function makeCharGenOutputSimple(): CharGenOutput {
  return {
    name: '铁锤·灰炉',
    race: '矮人',
    gender: '男',
    faction: '索伦蒂斯王国',
    tier: 2,
    level: 8,
    attributes: { str: 8, dex: 3, con: 7, int: 5, spi: 3 },
    identity: ['铁匠学徒', '矿山守卫'],
    occupation: ['铁匠', '战士'],
    background: '灰炉氏族世世代代在索伦蒂斯的矿山中开采矿石、锻造武器。铁锤是族中最年轻的铁匠，但他对矿石的感知力却远超前辈。他坚信每一块矿石都有自己的灵魂，都值得被淬炼成最好的兵器。',
    appearance: '身材矮壮，肌肉结实，一头火红色的乱发总是沾着煤灰。浓密的胡须编成了三股辫子，末端系着铁环。脸上有几道被火花溅伤留下的疤痕，笑起来时眼睛眯成一条缝。',
    clothing: '穿着一件沾满烟灰的皮围裙，内搭粗糙的麻布衬衫。手上戴着厚厚的防火手套，脚上是一双沉重的铁头靴。脖子上挂着一串用废铁打的小护身符。',
    personality: '直爽、豪迈，嗓门大且爱笑。干活时全神贯注，休息时最爱大口喝酒大口吃肉。对矿石和金属有着近乎偏执的热爱，能对着锻造炉看一整天火焰的颜色变化。',
    likes: '好酒、矿石标本、锻造、赌石、矿工歌谣',
    ascension: {
      enabled: false,
      path: '',
      description: '',
      elements: [],
      authorities: [],
      laws: [],
      deityPosition: '',
      divineKingdom: { name: '', description: '' },
    },
    skills: [
      {
        name: '重锤猛击',
        description: '用锻造锤全力砸向敌人，造成大量物理伤害并降低目标护甲值。',
        type: 'active',
        cost: { type: 'SP', amount: 20 },
        cooldown: 4,
      },
      {
        name: '矿石感知',
        description: '被动感知周围 15 米范围内的矿石和金属物品，对隐藏的宝藏和矿脉有天然的嗅觉。',
        type: 'passive',
      },
    ],
    equipment: [
      {
        slot: '主手',
        name: '淬火锻造锤',
        description: '灰炉家传的锻造锤，经过三代人的淬炼与强化，既是工具也是武器。',
        stats: { str: 3, con: 1 },
        quality: '优良',
      },
    ],
    inventory: [
      { name: '精炼铁锭', description: '高纯度铁锭，适合锻造中档装备。', quantity: 10, type: '材料', rarity: '普通' },
      { name: '地底蘑菇汤', description: '矮人矿工的必备口粮，浓郁鲜香让人恢复体力。', quantity: 3, type: '消耗品', rarity: '普通' },
    ],
  }
}

function makeCombatResult(): CombatSummaryResult {
  return {
    narrativeSummary: '你和艾琳在冰狼谷的狭窄通道中遭遇了三头冰原狼的伏击。艾琳第一时间释放了「冰霜箭矢」击退了领头的白狼，但侧面扑来的灰狼咬伤了你的左臂。你忍着疼痛挥剑反击，与艾琳配合默契——她用「寒冰护体」为你挡下致命一击，你趁机一剑刺穿了最后一头狼的咽喉。战斗结束后，艾琳用冰元素为你冻结了伤口止血，并默默地从狼身上收集了几颗冰牙。',
    patches: [
      { op: 'delta_hp' as const, target: 'characters/player', amount: -35 },
      { op: 'delta_sp' as const, target: 'characters/player', amount: -10 },
      { op: 'delta_mp' as const, target: 'characters/艾琳·霜语', amount: -25 },
    ],
    totalExp: 180,
    totalFp: 25,
    loot: [
      { name: '冰原狼牙', description: '锋利无比的冰属性狼牙，是锻造冰系武器的上等材料。', quantity: 3, quality: '稀有' },
      { name: '狼皮披肩', description: '用冰原狼皮缝制的披肩，具有天然的保暖效果和冰抗性。', quantity: 1, quality: '优良' },
      { name: '冰晶碎片', description: '狼体内凝结的冰元素结晶，可用于附魔或炼金。', quantity: 5, quality: '普通' },
    ],
    rounds: 5,
    outcome: 'ally_win',
  }
}

function makeCombatResultDraw(): CombatSummaryResult {
  return {
    narrativeSummary: '和铁锤在矿山深处与一群岩石傀儡激战，双方打得难分难解，最终精疲力竭各自撤退。',
    patches: [
      { op: 'delta_hp' as const, target: 'characters/player', amount: -60 },
      { op: 'delta_hp' as const, target: 'characters/铁锤·灰炉', amount: -45 },
    ],
    totalExp: 80,
    totalFp: 10,
    loot: [{ name: '岩石核心碎片', description: '傀儡残骸中的能量核心碎片。', quantity: 2, quality: '普通' }],
    rounds: 8,
    outcome: 'draw',
  }
}

function makeItemGenOutputEquipment(): ItemGenOutput {
  return {
    skills: [],
    equipment: [
      {
        slot: '头部',
        name: '霜语者之冠',
        description: '以极北冰晶和月光银丝编织成的头冠，能增幅佩戴者的冰系法术威力，并在月夜下自动吸收月光能量转化为魔法回复。',
        stats: { int: 4, spi: 3 },
        durability: 80,
        quality: '稀有',
      },
    ],
    inventory: [],
  }
}

function makeItemGenOutputSkills(): ItemGenOutput {
  return {
    skills: [
      {
        name: '极光闪现',
        description: '化作一道极光瞬间移动到 20 米内的任意可见位置，并在原位置留下一片持续 2 回合的冰霜薄雾区域，踏入的敌人移动速度降低 30%。',
        type: 'active',
        cost: { type: 'MP', amount: 25 },
        cooldown: 4,
      },
    ],
    equipment: [],
    inventory: [],
  }
}

function makeItemGenOutputInventory(): ItemGenOutput {
  return {
    skills: [],
    equipment: [],
    inventory: [
      { name: '远古魔力水晶', description: '蕴含庞大魔力的紫色水晶，据说是上古魔法帝国的能源核心碎片。可以用来强化装备或作为高级炼金材料。', quantity: 1, type: '材料', rarity: '史诗' },
      { name: '冰龙鳞片', description: '从远古霜龙身上脱落的完整鳞片，具有极强的冰元素亲和力和物理防御力。', quantity: 3, type: '材料', rarity: '传说' },
      { name: '冒险者口粮套装', description: '包含干肉、奶酪、硬面包和一小壶葡萄酒的标准旅行补给包。', quantity: 5, type: '消耗品', rarity: '普通' },
    ],
  }
}

function makeItemGenOutputHybrid(): ItemGenOutput {
  return {
    skills: [
      {
        name: '铁壁守护',
        description: '进入防御姿态，本回合受到的伤害减少 50%，并嘲讽周围敌人强制其攻击自己。',
        type: 'active',
        cost: { type: 'SP', amount: 30 },
        cooldown: 5,
      },
    ],
    equipment: [
      {
        slot: '身体',
        name: '矿坑守护者铠甲',
        description: '用深铁矿铸造的重型铠甲，表面镶嵌有吸收冲击的符文。穿戴时移动速度略微降低，但极大地增强防御力。',
        stats: { con: 6, str: 2 },
        durability: 150,
        quality: '稀有',
      },
    ],
    inventory: [
      { name: '深铁矿石', description: '从索伦蒂斯矿山深处开采的高品质铁矿石。', quantity: 8, type: '材料', rarity: '优良' },
    ],
  }
}

// ========== 组装完整的 ChatMessage 列表 ==========

export function buildTestMessages(): ChatMessage[] {
  const msgs: ChatMessage[] = []

  // 开场：AI 叙事 — 使用 dialogue format [角色名]{sprite}("对话")
  msgs.push({
    id: 'test-intro',
    role: 'assistant',
    content: '风雪呼啸着掠过冰狼谷的峭壁，你紧了紧斗篷，脚下的积雪已经没过了膝盖。远处，一座孤零零的石塔矗立在风雪之中——那是霜语者最后的据点。\n\n[艾琳·霜语]{sprite:ice_elf}("到了。")',
    timestamp: Date.now() - 120000,
    parsed: {
      thinking: '场景在极北冰原，需要营造寒冷孤寂的氛围。艾琳作为引路人，先让玩家感受到环境和同伴的压迫感。',
      maintext: '风雪呼啸着掠过冰狼谷的峭壁，你紧了紧斗篷，脚下的积雪已经没过了膝盖。远处，一座孤零零的石塔矗立在风雪之中——那是霜语者最后的据点。\n\n[艾琳·霜语]{sprite:ice_elf}("到了。")',
      options: ['推开塔门，环顾四周', '先问艾琳关于霜语者的事', '在塔外观察一下再进入'],
      sum: '抵达霜语者据点，艾琳轻声提醒到了',
      varsRaw: '',
      varsCommands: { merge: {} },
      unknown: {},
    },
  })

  // 用户行动
  msgs.push({
    id: 'test-user-1',
    role: 'user',
    content: '我推开塔门，环顾四周看看有没有危险。',
    timestamp: Date.now() - 110000,
  })

  // AI 叙事 + 战斗前兆 — 更多对话
  msgs.push({
    id: 'test-narr-1',
    role: 'assistant',
    content: '沉重的石门在刺耳的嘎吱声中缓缓打开。塔内出人意料地温暖——大厅中央的地面上刻着一个复杂的霜蓝色魔法阵，阵中悬浮着三颗缓缓旋转的冰晶。\n\n[艾琳·霜语]{sprite:alert}("小心——有什么东西在盯着我们。")',
    timestamp: Date.now() - 100000,
    parsed: {
      thinking: '引入战斗前兆。艾琳的冰元素感知在提醒危险。',
      maintext: '沉重的石门在刺耳的嘎吱声中缓缓打开。塔内出人意料地温暖——大厅中央的地面上刻着一个复杂的霜蓝色魔法阵，阵中悬浮着三颗缓缓旋转的冰晶。\n\n[艾琳·霜语]{sprite:alert}("小心——有什么东西在盯着我们。")',
      options: ['拔剑准备战斗', '先观察魔法阵的图案', '让艾琳用冰元素探测'],
      sum: '进入冰塔大厅，发现有魔法阵和冰晶悬浮',
      varsRaw: '',
      varsCommands: { merge: {} },
      unknown: {},
    },
  })

  // 战斗卡片 — ally_win
  msgs.push(toSystemMessage({
    type: 'combat',
    outcome: 'ally_win',
    narrative: '[战斗] 胜利 · 5回合 · EXP +180',
    details: makeCombatResult(),
  }))

  // AI 继续叙事
  msgs.push({
    id: 'test-narr-2',
    role: 'assistant',
    content: '战斗的余波散去，艾琳收起法杖，从狼身上取下了几枚冰牙。"这些可以做很好的施法材料。"她淡淡地说，语气中听不出刚才经历过生死搏斗。你环顾大厅，注意到了魔法阵中央冰晶下的石台上放着一件闪闪发光的东西。',
    timestamp: Date.now() - 90000,
  })

  // 用户输入
  msgs.push({
    id: 'test-user-2',
    role: 'user',
    content: '我走近石台，仔细查看那个发光的物品。',
    timestamp: Date.now() - 80000,
  })

  // AI 叙事
  msgs.push({
    id: 'test-narr-3',
    role: 'assistant',
    content: '你走近石台，光芒逐渐收敛，露出一顶精致的头冠——以冰晶和银丝编织而成，在月光透过塔窗洒落时散发出柔和的蓝色辉光。石台上刻着一行古老的精灵文字："霜语者之证——继承吾等遗志者，冠冕自现。"',
    timestamp: Date.now() - 70000,
  })

  // 物品获得卡片 — equipment
  msgs.push(toSystemMessage({
    type: 'item_gen',
    itemName: '霜语者之冠',
    quality: '稀有',
    itemType: '装备',
    narrative: '[获得] 霜语者之冠',
    details: makeItemGenOutputEquipment(),
  }))

  // AI 叙事
  msgs.push({
    id: 'test-narr-4',
    role: 'assistant',
    content: '艾琳站在你身后，目光复杂地看着那头冠。"这是……我族先人的遗物。"她的声音微微发颤。就在此时，魔法阵的光芒突然大盛，冰晶加速旋转，一道银白色的传送门在阵中央缓缓展开——那边连接着极北冰原深处的某处。',
    timestamp: Date.now() - 60000,
  })

  // 用户输入
  msgs.push({
    id: 'test-user-3',
    role: 'user',
    content: '"看来我们的旅程还没有结束。"我说道，然后和艾琳一起踏入传送门。',
    timestamp: Date.now() - 50000,
  })

  // AI 叙事 — 到达新场景
  msgs.push({
    id: 'test-narr-5',
    role: 'assistant',
    content: '传送的光芒消散后，你们发现自己站在一座巨大的冰窟之中。冰壁上倒映着幽蓝的光辉，洞穴深处传来叮叮当当的敲击声。一个矮壮的矮人正蹲在一块巨大的矿石前，专注地用锤子敲打着。"嘿！没看到我正在工作吗？"他不满地抬起头，但看到艾琳的瞬间，眼睛亮了——"霜语氏族的后人？老铁匠灰炉一直在等你们。"',
    timestamp: Date.now() - 40000,
  })

  // 新角色加入卡片 — char_gen (艾琳已经在队伍中，这里是铁锤)
  msgs.push(toSystemMessage({
    type: 'char_gen',
    characterName: '铁锤·灰炉',
    race: '矮人',
    tier: 2,
    narrative: '[新角色] 铁锤·灰炉 (矮人, T2)',
    details: makeCharGenOutputSimple(),
  }))

  // AI 叙事 — 铁锤加入
  msgs.push({
    id: 'test-narr-6',
    role: 'assistant',
    content: '铁锤拍了拍手上的灰，豪迈地大笑起来。"终于等到你们了！老灰炉说霜语的后人会在月圆之夜带着极光出现在冰窟，还真给他算准了。来吧，我带你们去铁匠铺——他有一件传说的兵器要请你帮忙锻造。"',
    timestamp: Date.now() - 30000,
  })

  // 用户输入
  msgs.push({
    id: 'test-user-4',
    role: 'user',
    content: '跟着铁锤前往他的锻造铺。',
    timestamp: Date.now() - 20000,
  })

  // AI 叙事 — 锻造场景
  msgs.push({
    id: 'test-narr-7',
    role: 'assistant',
    content: '锻造炉的火焰跳跃着呈现出少见的蓝白双色。铁锤将月光钢锭和霜狼之牙整齐地摆在工作台上，又从一口旧箱子里小心翼翼地取出了一块鳞片——"这是老灰炉从远古龙墓里带出来的，整个大陆不会超过三片。"他用粗糙的手指抚过鳞片表面。"现在，就看你的手艺了。"',
    timestamp: Date.now() - 15000,
  })

  // 制作卡片 — craft 传说
  msgs.push(toSystemMessage({
    type: 'craft',
    productName: '霜月之刃',
    quality: '传说',
    rating: '成功',
    narrative: '[制作] 传说级 霜月之刃',
    details: makeCraftOutput(),
  }))

  // AI 叙事 — 锻造完成
  msgs.push({
    id: 'test-narr-8',
    role: 'assistant',
    content: '霜月之刃在手中微微颤动，仿佛它有自己的心跳。铁锤盯着剑看了好一会儿，然后郑重地点了点头。"这是灰炉这辈子见过的最好的刀。"他拍了拍你的肩膀，转身从架子上取下一副泛着暗光的铠甲，"这是我当年在矿坑守卫时穿的，现在该交给更需要它的人了。"',
    timestamp: Date.now() - 10000,
  })

  // 物品获得 — 混合型 (装备+技能+物品)
  msgs.push(toSystemMessage({
    type: 'item_gen',
    itemName: '矿坑守护者铠甲',
    quality: '稀有',
    itemType: '装备',
    narrative: '[获得] 矿坑守护者铠甲 + 铁壁守护技能 + 材料',
    details: makeItemGenOutputHybrid(),
  }))

  // 角色微调 — character_update
  msgs.push(toSystemMessage({
    type: 'character_update',
    characterName: '铁锤·灰炉',
    narrative: '[角色变动] 铁锤·灰炉: 好感度 +5，解锁技能「铁壁守护」，体质 +1',
  }))

  // 物品变动 — item_update
  msgs.push(toSystemMessage({
    type: 'item_update',
    itemName: '深铁矿石×3',
    operation: 'consume',
    narrative: '[消耗] 深铁矿石×3: 用于锻造霜月之刃的附加材料',
  }))

  // 任务更新 — quest_update
  msgs.push(toSystemMessage({
    type: 'quest_update',
    questName: '霜语者的遗愿',
    status: 'progress',
    narrative: '[任务] 霜语者的遗愿: 进度 2/4 — 已获得霜语者之冠和霜月之刃',
  }))

  // 第二场战斗 — draw
  msgs.push({
    id: 'test-narr-9',
    role: 'assistant',
    content: '铁锤正要把铠甲递给你，冰窟深处突然传来一阵震动。几头岩石傀儡从墙壁中脱出，朝你们冲来！铁锤咒骂了一声，迅速戴上了锻造手套。',
    timestamp: Date.now() - 5000,
  })

  msgs.push(toSystemMessage({
    type: 'combat',
    outcome: 'draw',
    narrative: '[战斗] 平局 · 8回合 · EXP +80',
    details: makeCombatResultDraw(),
  }))

  // 炼金制作 — craft 优良
  msgs.push({
    id: 'test-narr-10',
    role: 'assistant',
    content: '战斗结束后，虽然双方都疲惫不堪，但铁锤还是坚持先帮你们补充物资。"打仗归打仗，药还是得备足的。"他从柜子里翻出几束月光草和几瓶生命之泉，"看看这些能炼出什么来？"',
    timestamp: Date.now() - 3000,
  })

  msgs.push(toSystemMessage({
    type: 'craft',
    productName: '翠绿回复药剂×3',
    quality: '优良',
    rating: '精益求精',
    narrative: '[制作] 优良级 翠绿回复药剂×3',
    details: makeCraftOutputExcellent(),
  }))

  // AI 叙事收尾
  msgs.push({
    id: 'test-narr-final',
    role: 'assistant',
    content: '三瓶翠绿的药剂整齐地排在桌上，金色的沉淀物在瓶底闪烁着微光。铁锤满意地点头，艾琳则默默将其中一瓶收进了腰间的小袋。窗外的极光开始在天际舞动——那是冰原之夜最美的景象。你坐在锻造炉旁，感受着火焰的温暖，思考着明天应该去向何方。',
    timestamp: Date.now() - 1000,
  })

  return msgs
}

/**
 * 注入测试数据到指定 store。
 * 调用前确保 settings.systemEventFilters 包含所有类型。
 * 注意: Pinia store 在组件中已自动解包 ref，所以这里接收的是原始值。
 */
export function injectTestData(store: {
  messages: ChatMessage[]
  isGenerating: boolean
}) {
  // 直接用 splice + push 替换，避免直接赋值覆盖 Pinia 的 getter/setter
  store.messages.splice(0, store.messages.length, ...buildTestMessages())
  store.isGenerating = false
}
