/**
 * 测试存档生成器 (Phase 7e 开发用，正式版移除)
 *
 * 创建包含完整游戏数据的测试存档:
 * - 1 个玩家角色 (亚瑟, T4, Lv.12)
 * - 3 个 NPC
 * - SaveProfile: FP 500 + 3 quests + 1 contract + 2 news
 * - 基础装备/技能/背包物品
 */

import {
  initializeDatabase,
  clearAllData,
  saveSaveSlot,
  saveCharacters,
  saveSaveProfile,
  savePlotEvents,
  saveMemory,
} from '@engine/database';
import { createDefaultCharacterState } from '@engine/types';
import type {
  SaveSlot,
  CharacterState,
  SaveProfile,
  PlotEvent,
  MemoryRecord,
  Quest,
  NewsItem,
} from '@engine/types';

let initialized = false;
let clearedThisLoad = false;

/**
 * 准备数据库。`reset` 决定要不要**先把整个库清空**。
 *
 * 🔴 **`reset: true` 清的是整个 Dexie 库，不只是存档。** `assetMeta` /
 * `assetBlobs` / `audioTracks` / `audioBlobs` / `audioPlaylists` 是**全局库、
 * 刻意不随存档隔离**的（见 CLAUDE.md 的 Dexie 段），所以它们一并没。
 * 真实表现是: 导入好的立绘/头像/音乐，点一下「🧪 快速测试」就全没了 ——
 * 而**存档看起来还在**，因为本模块清完紧接着又造了一个新的测试存档。
 * 丢的东西和幸存的东西都各自"看起来合理"，这就是它极难自查的原因。
 *
 * 两个开关分别记账，缺一不可:
 * - `initialized`: `initializeDatabase()` 负责播下默认预设/设置，正常情况下每次页面
 *   加载只需跑一次。**但 `clearAllData()` 是 `db.delete()`，会把它播下的东西一并删掉**，
 *   所以清库成功后必须把这个开关**重置回 `false` 强制补种**。少了这一步就会落进
 *   "库清空了、默认数据却再也没回来"的状态 —— 只在特定点击顺序下发作:
 *   先点「保留数据」（`initialized` 置真），再点「清空重建」，清是清了，播种被跳过。
 * - `clearedThisLoad`: 清库**每次页面加载最多一次**（保持原行为 —— 同一次加载里
 *   点第二下不再清，这正是会攒出两个「测试冒险」存档的原因）。
 *   **只在 `clearAllData()` 真正成功之后才置位**: 失败时保持 `false`，下次点击仍会
 *   重试，而不是把一次失败的清空记成"已经清过了"。
 *
 * 清库失败时**不静默吞掉**: 会 `console.warn` 并如实说明"这次是在未清空的库上继续
 * 造存档"，因为按钮标题承诺的是「清空重建」，不吭声会让用户看到的和实际发生的对不上。
 *
 * 想要"造存档但别动我的素材/音乐"，用 {@link createTestSavePreservingData}。
 */
async function ensureDb(reset: boolean) {
  if (reset && !clearedThisLoad) {
    try {
      await clearAllData();
      clearedThisLoad = true;
      // 整个库连同默认预设/设置都没了，必须重新播种。
      initialized = false;
    } catch (err) {
      // 常见真实成因: 另一个标签页还占着 Dexie 连接，`db.delete()` 被 blocked。
      console.warn(
        '[test-save] 清空数据库失败，本次将在**未清空**的库上继续创建测试存档' +
          '（按钮承诺的「清空重建」这次没有兑现）。常见原因: 另一个标签页占着 Dexie 连接。',
        err,
      );
    }
  }
  if (!initialized) {
    await initializeDatabase();
    initialized = true;
  }
}

/**
 * 创建完整测试存档，返回 saveId。
 *
 * ⚠️ **默认会先清空整个数据库**（每次页面加载最多清一次）—— 包括**不随存档隔离**的
 * 素材库与音频库。想留着它们请用 {@link createTestSavePreservingData}。
 *
 * @param options.reset 默认 `true`（保持原有的"干净重来"语义）
 */
export async function createTestSave(
  options: { reset?: boolean } = {},
): Promise<string> {
  await ensureDb(options.reset ?? true);

  const saveId = crypto.randomUUID();
  const playerId = crypto.randomUUID();

  // ═══ 1. SaveSlot ═══
  const saveSlot: SaveSlot = {
    id: saveId,
    name: '测试冒险',
    slot: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeSnapshotId: null,
    metadata: {
      characterName: '亚瑟',
      userName: '玩家',
      gameStartTime: new Date().toISOString(), // #42: 现实开档时间（ISO），游戏内时间走 SaveProfile.gameTime
      totalTurns: 3,
    },
  };
  await saveSaveSlot(saveSlot);

  // ═══ 2. Player Character ═══
  const player: CharacterState = createDefaultCharacterState({
    id: playerId,
    saveId,
    type: 'player',
    name: '亚瑟',
    race: '人类',
    identity: ['冒险者', '剑士'],
    occupation: ['战士'],
    tier: 4,
    tierName: '史诗',
    gender: '男',
    customFields: { age: 28 },  // M6 T2: saveId/gender 已升一等字段停写，只留真扩展数据
    level: 12,
    totalExp: 8500,
    expToNext: 1500,
    attributes: { str: 16, dex: 12, con: 14, int: 10, spi: 10 },
    freeAttrPoints: 2,
    hp: 380, maxHp: 400,
    mp: 100, maxMp: 100,
    sp: 140, maxSp: 150,
    money: 1250,
    location: '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德',
    adventurerRank: 'A',
    currentAction: '',
    bloodlineIds: ['human_imperial'],
    // M2: 装备并入 inventory（equippedSlot 非空 = 已穿戴，规范 §3）
    skills: [
      {
        id: crypto.randomUUID(), name: '十字斩', type: 'active', level: 3,
        description: '以十字剑势斩击目标两次，是帝国剑术的基础战技。',
        cost: { type: 'SP', amount: 15 }, cooldown: 2,
        effects: {
          '二连斩': '对目标造成两次斩击伤害',
          'SP消耗': '消耗 15 点体力',
        },
        scripts: {},
      },
      {
        id: crypto.randomUUID(), name: '铁壁防御', type: 'passive', level: 2,
        description: '通过严格的帝国军事训练获得的常驻防御姿态。',
        cost: undefined, cooldown: 0,
        effects: {
          '常驻防御': '防御力永久提升 5%',
        },
        scripts: {},
      },
    ],
    inventory: [
      // ═══ 已穿戴装备（equippedSlot 非空，规范 §3）═══
      {
        id: crypto.randomUUID(), name: '精钢长剑', type: '装备',
        description: '帝国军工厂出品的长剑，剑身上刻有奥古斯提姆的鹰徽。',
        quantity: 1, equippedSlot: '武器',
        stats: { atk: 24, str: 3 },
        durability: 80, maxDurability: 80,
        effects: {
          '锐利': '攻击力 +24',
          '力量加持': '力量 +3',
        },
        scripts: {},
      },
      {
        id: crypto.randomUUID(), name: '秘银锁子甲', type: '装备',
        description: '轻便而坚固的秘银甲，以精灵工艺锻造的秘银丝编织而成。',
        quantity: 1, equippedSlot: '身体',
        stats: { def: 18, con: 1 },
        durability: 65, maxDurability: 65,
        effects: {
          '坚韧': '防御 +18',
          '体质增幅': '体质 +1',
        },
        scripts: {},
      },
      {
        id: crypto.randomUUID(), name: '冒险者徽章', type: '装备',
        description: 'A级冒险者的身份象征，蕴含着微弱的魔力。',
        quantity: 1, equippedSlot: '饰品',
        stats: { int: 1, spi: 1 },
        durability: 100, maxDurability: 100,
        effects: {
          '智慧启迪': '智力 +1',
          '精神凝聚': '精神 +1',
        },
        scripts: {},
      },
      {
        id: crypto.randomUUID(), name: '治疗药水', type: '消耗品',
        description: '冒险者公会的标准配给品，能快速愈合轻伤。恢复 50 HP。',
        quantity: 3, rarity: '普通', data: {},
        effects: {
          '治愈': '恢复 50 点生命值',
        },
        scripts: {},
      },
      {
        id: crypto.randomUUID(), name: '解毒草', type: '材料',
        description: '生长在翡翠之心森林中的药草，可解除轻微中毒。',
        quantity: 5, rarity: '普通', data: {},
        effects: {
          '净化': '解除轻微中毒状态',
        },
        scripts: {},
      },
    ],
    statusEffects: [
      {
        id: 'buff_blessing', name: '战斗祝福', category: '增益' as const,
        description: '攻击力 +5%', stacks: 1, remainingTime: 999, timeUnit: '回合' as const,
        source: '冒险者公会支援', effects: { atk_pct: 5 },
        stackable: false,
        effectDescriptions: {
          '攻击增幅': '攻击力提升 5%',
        },
      },
    ],
  });

  // ═══ 3. NPCs ═══
  const npcs: CharacterState[] = [
    createDefaultCharacterState({
      id: crypto.randomUUID(),
      saveId,
      type: 'npc',
      name: '艾莉丝',
      race: '精灵',
      identity: ['酒馆老板'],
      occupation: ['商人'],
      tier: 1, level: 3,
      attributes: { str: 8, dex: 14, con: 8, int: 13, spi: 12 },
      money: 300,
      location: '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德',
      gender: '女',
      appearance: '银白长发如月光般垂至腰际，翠绿色的眼眸透着精灵族特有的灵气。五官精致而柔和，举手投足间带着千年寿命沉淀的优雅。',
      outfit: '一袭墨绿色的旅者长袍，袖口和领口绣有精灵族的藤蔓纹样。腰间系着一条深棕色皮革围裙，上面还沾着些许麦粉。',
      thoughts: '"最近商队失踪的事让人不安...卡尔的盗贼团越来越嚣张了。希望亚瑟能平安无事地查清真相。不过，那个蒙面人上周又来打听商队的事了，总觉得哪里不对劲..."',
      personality: '温柔善良，待客周到，是艾瑟嘉德最受欢迎的酒馆老板。偶尔会在打烊后独自对月抚琴，流露出不为人知的忧郁。能记住每一位常客的口味和故事。',
      background: '原是翡翠之心的精灵贵族之女，百年前因厌倦宫廷生活而离开故乡。辗转各地后定居艾瑟嘉德，开了这家"精灵之息"酒馆。虽表面与世无争，实则暗中帮助过许多冒险者。',
      customFields: {
        // M6 T2: 双写退役 — 已升一等字段（gender/appearance/outfit/personality/thoughts/background）停写
        age: 120, role: 'innkeeper',
      },
    }),
    createDefaultCharacterState({
      id: crypto.randomUUID(),
      saveId,
      type: 'npc',
      name: '暗影盗贼·卡尔',
      race: '暗精灵',
      identity: ['盗贼首领'],
      occupation: ['盗贼'],
      tier: 3, level: 8,
      attributes: { str: 10, dex: 18, con: 10, int: 12, spi: 8 },
      location: '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德-近郊森林',
      gender: '男',
      appearance: '暗紫色的皮肤是暗精灵血统的标记，猩红的双眼在黑暗中微微发光。削瘦的脸颊上有一道从额头斜跨至下颌的旧刀疤。',
      outfit: '一身漆黑的皮甲，表面经过特殊处理不会反光。腰间挂满了淬毒匕首和工具袋，行动时几乎不发出声响。',
      thoughts: '"亚瑟...那个帝国走狗。他以为自己在伸张正义，殊不知那些商队运送的是帝国的军需物资。等我再劫一票，就有足够的钱雇更多人...到时候，艾瑟嘉德就是我的了。"',
      personality: '冷酷无情，行事果断。对敌人毫不留情，但对追随自己的手下却异常护短。极度憎恨地表精灵，认为他们背叛了暗精灵一族。有轻微的偏执倾向。',
      background: '曾是暗精灵地下城邦的影刃特工，因一次任务失败被流放。流落到地表后在近郊森林建立了盗贼团，专门劫掠奥古斯提姆帝国的商队。与翡翠之心的某些势力有秘密联系。',
      customFields: {
        // M6 T2: 双写退役 — 已升一等字段停写
        age: 95, role: 'enemy',
      },
      // M2: 装备并入 inventory（equippedSlot 非空 = 已穿戴，规范 §3）
      inventory: [
        {
          id: crypto.randomUUID(), name: '淬毒匕首', type: '装备',
          description: '涂了暗精灵特制毒药的匕首，刀刃泛着幽绿色的光泽。',
          quantity: 1, equippedSlot: '武器',
          stats: { atk: 16, dex: 2 },
          durability: 50, maxDurability: 50,
          effects: {
            '暗精灵淬毒': '命中时有30%几率附加中毒状态，每回合失去10点生命值，持续3回合',
            '敏捷之刃': '敏捷 +2',
          },
          scripts: {
            'poison_hit': 'if($dice.d100()<=30){$status.add(target,{name:"暗精灵剧毒",category:"减益",description:"每回合失去10点生命值",stacks:1,remainingTime:3,timeUnit:"回合",source:"淬毒匕首",effects:{hp_per_turn:-10},scripts:{tick:"$resource.modifyHp(owner,-10)"},onTick:"tick"})}',
          },
        },
      ],
    }),
    createDefaultCharacterState({
      id: crypto.randomUUID(),
      saveId,
      type: 'npc',
      name: '大法师·梅林',
      race: '人类',
      identity: ['宫廷法师'],
      occupation: ['法师'],
      tier: 5, level: 18,
      attributes: { str: 8, dex: 10, con: 8, int: 20, spi: 18 },
      location: '翡翠之心-林歌城',
      gender: '男',
      appearance: '满头银发整齐地束在脑后，深邃的蓝色眼眸仿佛能看透人心。虽然年过六旬，但面容依然硬朗，只是眼角和额头的皱纹记录着岁月的痕迹。右手的食指上有一枚镶嵌着蓝宝石的秘银戒指。',
      outfit: '深蓝色的法师长袍，袍面上绣着银色的星座图案，随着魔力波动微微闪烁。肩披一件暗红色的天鹅绒斗篷，斗篷内侧缝满了各种防护符文。手持一根古朴的橡木法杖，杖头嵌着一颗拳头大小的魔力水晶。',
      thoughts: '"草药的事不急，但那孩子的剑术还得再练练...帝国最近在边境集结兵力，不是什么好兆头。还有那个失踪的商队，我总觉得背后有更大的阴谋，不仅仅是盗贼团这么简单。也许我该找人调查一下近郊森林里的那个废弃神殿..."',
      personality: '睿智而风趣，喜欢用谜语和比喻来教导学生。对魔法研究有着近乎偏执的热情，为了找到一本古籍可以整整三天不眠不休。外表严肃但内心温暖，对年轻冒险者格外关照。',
      background: '奥古斯提姆帝国的前任宫廷首席法师，因不满帝国日益扩张的军国主义政策而辞官隐居。现居于翡翠之心的林歌城，偶尔接受冒险者公会的委托，为有潜力的年轻冒险者提供指导。暗中在研究和对抗一个古老的预言。',
      customFields: {
        // M6 T2: 双写退役 — 已升一等字段停写
        age: 62, role: 'mentor',
      },
      skills: [
        {
          id: crypto.randomUUID(), name: '火球术', type: 'active', level: 5,
          description: '释放一颗巨大的火球，是大法师梅林最得意的法术。',
          cost: { type: 'MP', amount: 30 }, cooldown: 3,
          effects: {
            '火焰爆裂': '对目标造成巨额火焰伤害',
            '灼烧余烬': '40%几率附加灼烧状态，每回合失去5%生命值，持续3回合',
            'MP消耗': '消耗 30 点法力',
          },
          scripts: {
            'burn_check': 'if($dice.d100()<=40){$status.add(target,{name:"灼烧",category:"减益",description:"每回合失去5%生命值",stacks:1,maxStacks:3,remainingTime:3,timeUnit:"回合",source:"火球术",effects:{},scripts:{tick:"$resource.modifyHp(owner,-floor($resource.maxHp(owner)*0.05))"},onTick:"tick"})}',
          },
        },
      ],
    }),
  ];

  await saveCharacters([player, ...npcs]);

  // ═══ 4. SaveProfile ═══
  const { createDefaultTime } = await import('@engine/time-system');
  const profile: SaveProfile = {
    saveId,
    fp: 500,
    fpHistory: [
      { id: crypto.randomUUID(), timestamp: Date.now() - 86400000, amount: 500, reason: '初始命运点数', balance: 500, source: 'other' },
    ],
    contracts: [
      {
        id: crypto.randomUUID(), targetId: npcs[0].id, targetName: '艾莉丝',
        tier: 1, fpSpent: 50, affectionLevel: '友好', createdAt: Date.now() - 43200000,
      },
    ],
    achievements: [
      { id: crypto.randomUUID(), name: '初次冒险', description: '完成第一个任务', unlockedAt: Date.now(), fpReward: 100 },
    ],
    news: [
      {
        id: crypto.randomUUID(), title: '商队失踪事件', content: '近日艾瑟嘉德近郊频繁发生商队失踪事件，帝国已派遣调查队前往。', category: '阿斯塔利亚快讯', publishedAt: Date.now(), read: false,
      },
      {
        id: crypto.randomUUID(), title: '冒险者公会新任务', content: '冒险者公会发布了一批新的委托，包括讨伐近郊森林中的盗贼团。', category: '阿斯塔利亚快讯', publishedAt: Date.now() - 3600000, read: false,
      },
    ] as NewsItem[],
    focusQuest: '追查失踪商队',
    affections: {
      [npcs[0].id]: 45,   // 艾莉丝: 友好
      [npcs[2].id]: 80,   // 梅林: 深厚羁绊
    },
    quests: {
      '追查失踪商队': {
        status: '进行中',
        priority: '高',
        progress: '已在近郊森林发现商队遗落的货物',
        detail: '城外的商队已经失踪三天了，据最后目击者称他们进入了近郊森林。帝国要求调查真相。',
        objective: '找到失踪的商队，查明失踪原因',
        reward: '800G + 帝国勋章',
      },
      '讨伐盗贼团': {
        status: '进行中',
        priority: '中',
        progress: '',
        detail: '近郊森林中出现了盗贼团，袭击过往商旅。冒险者公会悬赏讨伐。',
        objective: '消灭盗贼团首领',
        reward: '500G + 经验',
      },
      '收集魔法草药': {
        status: '搁置',
        priority: '低',
        progress: '已收集 2/5 种',
        detail: '宫廷法师梅林需要五种稀有魔法草药用于研究。',
        objective: '收集 5 种魔法草药',
        reward: '300G + 梅林的好感',
      },
    } as Record<string, Quest>,
    gameTime: createDefaultTime(),
    variables: {},
    worldFlags: {
      mapMarkers: [],
    },
    updatedAt: Date.now(),
  };
  await saveSaveProfile(profile);

  // ═══ 5. PlotEvents ═══
  const plotEvent: PlotEvent = {
    id: crypto.randomUUID(),
    saveId,
    title: '商队失踪事件',
    description: '一队商人在艾瑟嘉德附近的森林中失踪。帝国派遣调查队，冒险者公会的悬赏吸引了各方势力。',
    status: 'active',
    childrenIds: [],
    order: 1,
    relatedCharacterIds: [playerId, npcs[0].id, npcs[1].id],
    location: '艾瑟嘉德近郊',
    worldLineChanged: false,
    visibility: 'revealed',
    depth: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await savePlotEvents([plotEvent]);

  // ═══ 6. Memory ═══
  const memory: MemoryRecord = {
    id: 'MEM000001',
    saveId,
    createdAt: Date.now(),
    realTimestamp: Date.now(),
    timeRange: { start: '复兴纪元·丰收之月·第15日', end: '复兴纪元·丰收之月·第15日' },
    content: '亚瑟在艾瑟嘉德的酒馆"精灵之息"中听说了商队失踪的消息。酒馆老板艾莉丝告诉他，最近已经有三个商队在近郊森林中失踪。冒险者公会的悬赏令贴在墙上，赏金不菲。一位神秘的蒙面人也曾在酒馆中打听商队的消息，似乎有着不为人知的目的。',
    hiddenLine: '蒙面人其实是盗贼团的眼线，正在为暗影盗贼·卡尔收集情报。',
    keywords: ['商队', '失踪', '艾瑟嘉德', '酒馆', '艾莉丝', '冒险者公会'],
    relatedCharacterIds: [playerId, npcs[0].id, npcs[1].id],
    importance: 7,
  };
  await saveMemory(memory);

  return saveId;
}

/**
 * 造一个同样的测试存档，但**一个字节都不清** —— 现有存档、素材库、音频库全留着。
 *
 * 为什么单独有这么一个口子: 素材/立绘/音乐是**手动导入、成本很高**的东西，而
 * {@link createTestSave} 的"干净重来"会连它们一起清掉（它们是全局库，不随存档隔离）。
 * 调试渲染面时想要的是"给我一个能进去的存档"，不是"把我刚导入的图全删了"。
 *
 * 代价是每点一次就多一个「测试冒险」存档 —— 这是有意的:
 * 与其猜哪个该删，不如让删除留给用户显式操作。
 */
export async function createTestSavePreservingData(): Promise<string> {
  return createTestSave({ reset: false });
}
