/**
 * NPC 生成随机表 — 对齐世界书 #865613 (角色生成) + #443 (命名指导) + #445 (辅助指导)
 *
 * 提供 code 层随机化工具，供 Agentic Agent (char_gen) 通过工具调用获取真实随机值。
 * 所有数据从世界书 extra_setting.json uid 443-445 提取。
 */

// ========== 通用随机工具 ==========

/** 从数组中随机取一个元素 */
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 在 [min, max] 范围内随机整数（两端包含） */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ═══════════════════════════════════════════════════════════
// 名称池 (按种族 + 性别)
// 对齐世界书 #443 角色命名指导
// ═══════════════════════════════════════════════════════════

interface NamePool {
  male: string[];
  female: string[];
  surnames: string[];
}

const NAME_POOLS: Record<string, NamePool> = {
  '人类': {
    male: [
      '艾德', '卡尔', '雷诺', '维克多', '塞巴斯蒂安', '路德维希', '马库斯',
      '奥利弗', '亨里克', '弗雷德', '阿瑟', '贝尔纳', '康拉德', '迪特里希',
      '埃德蒙', '弗里茨', '戈特弗里德', '海因里希', '伊格纳兹', '约阿希姆',
      '卡斯帕', '利奥波德', '曼弗雷德', '诺伯特', '奥斯瓦尔德', '菲利克斯',
      '雷金纳德', '西格弗里德', '提奥', '乌尔里希', '瓦尔特', '泽维尔',
    ],
    female: [
      '艾琳', '莉亚', '索菲亚', '伊莎贝拉', '奥莉维亚', '艾玛', '米娅',
      '夏洛特', '艾米莉亚', '维多利亚', '阿德莱德', '比阿特丽斯', '克拉拉',
      '多萝西娅', '伊迪丝', '芙蕾雅', '格蕾塔', '海伦娜', '伊丽莎白',
      '约瑟芬', '卡塔琳娜', '露易丝', '玛蒂尔达', '诺拉', '奥蒂莉',
      '佩特拉', '罗莎琳', '西尔维亚', '特蕾莎', '乌苏拉', '薇拉',
    ],
    surnames: [
      '铁锤', '风行者', '影步', '星辰', '黎明', '霜语', '火心', '暗影',
      '光翼', '石英', '钢盾', '银叶', '河风', '岩脊', '烽火', '霜刃',
      '橡木', '鹰眼', '狼牙', '炎铸', '海歌', '云梯', '金穗', '雪松',
    ],
  },
  '精灵': {
    male: [
      '艾隆', '瑟兰迪尔', '芬罗德', '莱戈拉斯', '凯勒布林博', '欧洛斐尔',
      '加尔多', '贝烈格', '埃克塞里安', '林迪尔', '希尔凡', '费诺',
      '阿姆拉斯', '达格尼尔', '洛林', '奈尔多', '凡雅罗', '辛格尔',
    ],
    female: [
      '阿尔玟', '伽拉德瑞尔', '露西恩', '伊缀尔', '宁洛丝', '埃尔温',
      '费瑞尔', '阿纳瑞恩', '凯勒布莉安', '弥瑞尔', '艾尔薇', '莉安娜',
      '西尔维亚', '艾莉西亚', '月华', '晨露', '银铃', '星眸',
    ],
    surnames: [
      '银叶', '星落', '月影', '晨光', '林语', '风吟', '水镜', '花冠',
      '金枝', '绿荫', '光翼', '云裳', '霜华', '春藤', '夜莺', '碧波',
      '日冕', '霞光', '空谷', '幻音',
    ],
  },
  '矮人': {
    male: [
      '索林', '巴林', '德瓦林', '格罗因', '欧因', '多瑞', '诺瑞', '比弗',
      '波弗', '邦伯', '基利', '菲力', '吉姆利', '弗拉尔', '索尔',
      '布洛克', '卡兹', '德鲁根', '莫拉丁', '钢拳',
    ],
    female: [
      '迪丝', '布伦希尔德', '格瑞塔', '赫尔加', '英格丽德', '斯瓦娜',
      '托芙', '弗蕾迪丝', '雅恩', '凯特琳', '莫拉', '娜拉', '茹娜',
    ],
    surnames: [
      '铁炉', '石拳', '钢胡', '铜盾', '金砧', '火锤', '岩足', '铁砧',
      '重锤', '深矿', '硬石', '熔炉', '锻钢', '银脉', '雷锤', '坚岩',
    ],
  },
  '翼民': {
    male: [
      '赛瑞斯', '加百列', '米迦勒', '拉斐尔', '乌列', '阿兹瑞尔',
      '泽菲', '艾里克', '阿奎拉', '法尔科', '奥雷利', '塞拉芬',
    ],
    female: [
      '安吉拉', '瑟拉芬娜', '艾莉尔', '加布莉', '奥罗拉', '塞莉丝',
      '菲尼克斯', '伊卡莉', '卢娜', '艾瑟琳', '天羽', '云雀',
    ],
    surnames: [
      '光翼', '天翔', '圣歌', '苍穹', '辉羽', '晨星', '耀日', '霜羽',
      '银翎', '烈风', '云翼', '穹顶', '神谕', '飞羽', '高天', '碧空',
    ],
  },
  '兽族': {
    male: [
      '洛戈什', '乌尔法', '卡尔格', '沃里克', '雷加', '芬里尔',
      '加尔姆', '斯卡', '塔洛', '格兰', '霍克', '巴鲁',
    ],
    female: [
      '费拉', '莎卡', '阿尔瓦', '莱卡', '基拉', '洛娜',
      '塞尔达', '弗雷娅', '希拉', '塔拉', '薇克丝', '桑德拉',
    ],
    surnames: [
      '霜狼', '碎牙', '血爪', '铁鬃', '怒角', '风蹄', '火鬃',
      '裂岩', '雷牙', '冰脊', '暗月', '赤鬃', '影爪', '破风',
    ],
  },
  '血族': {
    male: [
      '弗拉德', '拉兹洛', '阿利斯泰尔', '塞巴斯蒂安', '达米安',
      '路西安', '马库斯', '维克托', '康斯坦丁', '阿兹拉尔',
    ],
    female: [
      '卡蜜拉', '莉莉丝', '伊莎贝拉', '艾莉诺', '维多利亚',
      '瑟琳娜', '莫甘娜', '德古丽娜', '瓦伦蒂娜', '诺斯菲拉',
    ],
    surnames: [
      '诺斯费拉图', '血月', '暗夜', '赤红', '永夜', '血誓',
      '影裔', '猩红', '暮光', '血源', '黑玫瑰', '血蔷薇',
    ],
  },
  '巨龙': {
    male: [
      '阿卡托什', '奥杜因', '帕图纳克斯', '奈萨里奥', '玛里苟斯',
      '伊瑟兰', '诺兹多姆', '萨菲隆', '奥尼克希亚斯', '辛达苟萨',
    ],
    female: [
      '阿莱克丝塔萨', '希尔瓦娜', '奥妮克希亚', '辛萨莉亚',
      '伊瑟拉', '菲莉希亚', '墨菲斯托菲莉亚', '维拉诺斯',
    ],
    surnames: [
      '烬灭', '炎渊', '雷暴', '虚空', '熔岩', '飓风', '冰狱',
      '裂空', '永恒', '始源', '终焉', '天灾',
    ],
  },
};

/** 默认名称池（未定义的种族回退到人类） */
const DEFAULT_NAME_POOL: NamePool = NAME_POOLS['人类'];

// ========== 发色池 ==========

const HAIR_COLORS: Record<string, string[]> = {
  '人类': [
    '黑色', '棕色', '金色', '红色', '灰色', '白色', '栗色', '深棕色',
    '亚麻色', '褐色', '银灰色', '蜂蜜色', '深褐色', '赤褐色',
  ],
  '精灵': [
    '银色', '金色', '白色', '淡金色', '浅绿色', '浅蓝色', '月光银',
    '铂金色', '淡紫色', '冰蓝色', '翡翠绿', '星空银',
  ],
  '矮人': [
    '棕色', '红色', '黑色', '灰色', '姜黄色', '深棕', '赤褐色',
    '铜色', '暗金色', '灰白',
  ],
  '翼民': [
    '白色', '金色', '银色', '淡蓝', '淡粉', '铂金', '珍珠白',
    '浅紫', '天蓝', '玫瑰金',
  ],
  '兽族': [
    '灰色', '棕色', '白色', '黑色', '斑纹棕', '赤色', '暗灰',
    '银灰', '深棕', '虎斑色',
  ],
  '血族': [
    '银白', '黑色', '深紫', '暗红', '灰白', '墨黑', '血色红',
    '冷灰', '深蓝黑',
  ],
  '巨龙': [
    '熔金', '赤红', '墨黑', '银白', '深蓝', '青铜', '紫晶',
    '翡翠绿', '暗金',
  ],
  '默认': [
    '樱粉', '紫红', '桃红', '酒红', '泰尔紫', '姜黄色', '玫瑰红',
    '墨绿', '熔金', '碧绿', '浅金', '月白', '品红', '象牙白',
    '矢车菊蓝', '椰棕色', '银红', '朱砂红', '橘黄', '橙红',
    '米黄', '小麦色', '紫丁香', '茶色', '珍珠白', '石青', '金赭',
    '宝石绿', '翡翠绿', '灰绿', '黑色', '棕色', '金色',
  ],
};

// ========== 瞳色池 ==========

const EYE_COLORS: Record<string, string[]> = {
  '人类': [
    '棕色', '蓝色', '绿色', '灰色', '淡褐色', '深棕', '蓝灰',
    '琥珀色', '翠绿', '天蓝',
  ],
  '精灵': [
    '翠绿', '银灰', '天蓝', '紫罗兰', '金色', '深绿', '浅蓝',
    '月光银', '星空紫', '碧绿',
  ],
  '矮人': [
    '棕色', '深棕', '灰色', '琥珀', '暗绿', '铜色',
  ],
  '翼民': [
    '金色', '天蓝', '银白', '淡紫', '琥珀', '碧空蓝',
  ],
  '兽族': [
    '金色', '琥珀', '暗绿', '橙黄', '冰蓝', '血红',
  ],
  '血族': [
    '深红', '暗金', '紫罗兰', '冰蓝', '漆黑', '猩红',
  ],
  '巨龙': [
    '熔金', '竖瞳金', '竖瞳赤', '竖瞳蓝', '竖瞳绿', '竖瞳紫',
  ],
  '默认': [
    '棕色', '蓝色', '绿色', '灰色', '淡褐色', '琥珀色', '金色',
    '紫色', '红色', '银色', '异色瞳(左蓝右绿)', '翠绿', '天蓝',
  ],
};

// ========== 性格池 ==========

const PERSONALITY_POOL = {
  // w/W vs d/D: 亲 vs 疏
  warmth: [
    { code: 'w', desc: '轻度亲近 — 主动关心，容易交心，喜欢热闹' },
    { code: 'W', desc: '重度亲近 — 热情洋溢，社交核心，极其健谈' },
    { code: 'd', desc: '轻度疏离 — 保持距离，不轻易交心，享受独处' },
    { code: 'D', desc: '重度疏离 — 孤僻避世，极度内向，抗拒社交' },
  ],
  // o/O vs h/H: 显 vs 隐
  openness: [
    { code: 'o', desc: '轻度坦露 — 心思直白，情绪外露，有话直说' },
    { code: 'O', desc: '重度坦露 — 毫无城府，情绪完全写在脸上' },
    { code: 'h', desc: '轻度内敛 — 深藏不露，喜怒不形于色，话留三分' },
    { code: 'H', desc: '重度内敛 — 密不透风，永远无法被读懂' },
  ],
  // a/A vs l/L: 急 vs 缓
  urgency: [
    { code: 'a', desc: '轻度急切 — 性急冲动，想到就做，闲不住' },
    { code: 'A', desc: '重度急切 — 暴风骤雨，无法等待一秒' },
    { code: 'l', desc: '轻度从容 — 不紧不慢，从容不迫，耐得住' },
    { code: 'L', desc: '重度从容 — 泰山崩于前而色不变' },
  ],
  // g/G vs r/R: 刚 vs 柔
  firmness: [
    { code: 'g', desc: '轻度刚硬 — 寸步不让，宁折不弯，硬碰硬' },
    { code: 'G', desc: '重度刚硬 — 绝对不妥协，宁死不屈' },
    { code: 'r', desc: '轻度柔韧 — 以柔克刚，善于妥协，顺势而为' },
    { code: 'R', desc: '重度柔韧 — 随波逐流，极度灵活' },
  ],
  // z/Z vs y/Y: 执 vs 逸
  persistence: [
    { code: 'z', desc: '轻度执着 — 认准不放，死磕到底，放不下' },
    { code: 'Z', desc: '重度执着 — 偏执到疯狂，不达目的誓不罢休' },
    { code: 'y', desc: '轻度超逸 — 随遇而安，拿得起放得下，不强求' },
    { code: 'Y', desc: '重度超逸 — 一切皆空，万物不挂心' },
  ],
  // 稳定性 S/A/F
  stability: [
    { code: 'S', desc: '稳固 — 行为可预测，性格不易随环境改变' },
    { code: 'A', desc: '可塑 — 随环境调整行为模式' },
    { code: 'F', desc: '流动 — 性格不稳定，难以捉摸' },
  ],
};

// ═══════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════

/** 随机生成角色名称（名+姓，中间阶层格式） */
export function randomName(race: string, gender: '男' | '女' = '男'): string {
  const pool = NAME_POOLS[race] ?? DEFAULT_NAME_POOL;
  const givenNames = gender === '男' ? pool.male : pool.female;
  const given = pick(givenNames);

  // 50% 概率有姓氏（中层阶级）
  if (Math.random() < 0.5) {
    const surname = pick(pool.surnames);
    return `${given}·${surname}`;
  }
  return given;
}

/** 随机生成发色 */
export function randomHairColor(race: string): string {
  const pool = HAIR_COLORS[race] ?? HAIR_COLORS['默认'];
  return pick(pool);
}

/** 随机生成瞳色 */
export function randomEyeColor(race: string): string {
  const pool = EYE_COLORS[race] ?? EYE_COLORS['默认'];
  return pick(pool);
}

/** 随机生成性格编码和描述（wOaGz 五维模型 + 稳定性） */
export function randomPersonality(): {
  code: string;          // 如 'wOaGz(A)'
  description: string;   // 人类可读描述
} {
  const w = pick(PERSONALITY_POOL.warmth);
  const o = pick(PERSONALITY_POOL.openness);
  const a = pick(PERSONALITY_POOL.urgency);
  const g = pick(PERSONALITY_POOL.firmness);
  const z = pick(PERSONALITY_POOL.persistence);
  const s = pick(PERSONALITY_POOL.stability);

  const code = `${w.code}${o.code}${a.code}${g.code}${z.code}(${s.code})`;
  const description = [
    `亲近度: ${w.desc}`,
    `坦露度: ${o.desc}`,
    `急切度: ${a.desc}`,
    `刚柔度: ${g.desc}`,
    `执着度: ${z.desc}`,
    `稳定性: ${s.desc}`,
  ].join('; ');

  return { code, description };
}

/** 按 Tier 获取属性随机范围（对齐世界书 #445） */
export function getTierAttributeCap(tier: number): number {
  const CAPS: Record<number, number> = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 16, 6: 18, 7: 20 };
  return CAPS[tier] ?? 8;
}

/**
 * 按 Tier 随机生成五维属性（三池分配模型，对齐世界书 #444 Step2）
 *
 * 公式: 每项 = [基础池分配] + [层级固定 tier-1] + {等级额外分配}
 * - 基础池: 0~25 点自由分配（代表天赋/种族优劣）
 * - 层级固定: 每属性固定获得 tier-1 点
 * - 等级额外: 每等级 1 点自由分配（共 level-1 点）
 * - 每项硬上限由 tier 决定（见 getTierAttributeCap）
 */
export function rollAttributes(tier: number, level: number = 1): {
  str: number; dex: number; con: number; int: number; spi: number;
  /** 三池分解信息 */
  breakdown: { basePool: number; tierFixed: number; levelExtra: number; cap: number };
} {
  const cap = getTierAttributeCap(tier);
  const tierFixed = Math.max(0, tier - 1);          // 每属性固定 +tier-1
  const basePool = randInt(0, 25);                   // 基础浮动池
  const levelExtra = Math.max(0, level - 1);          // 等级额外池

  // 初始化属性为层级固定值
  const attrs: Record<string, number> = {
    str: tierFixed, dex: tierFixed, con: tierFixed, int: tierFixed, spi: tierFixed,
  };

  // 随机分配基础池 + 等级额外点（优先随机到未达上限的属性）
  let remaining = basePool + levelExtra;
  const keys = ['str', 'dex', 'con', 'int', 'spi'] as const;
  while (remaining > 0) {
    const eligible = keys.filter(k => attrs[k] < cap);
    if (eligible.length === 0) break;
    const key = eligible[Math.floor(Math.random() * eligible.length)];
    attrs[key]++;
    remaining--;
  }

  return {
    str: attrs['str']!,
    dex: attrs['dex']!,
    con: attrs['con']!,
    int: attrs['int']!,
    spi: attrs['spi']!,
    breakdown: { basePool, tierFixed, levelExtra, cap },
  };
}

/** 随机生成外貌描述摘要 */
export function randomAppearanceSummary(race: string, gender: '男' | '女'): {
  hairColor: string;
  eyeColor: string;
  ageAppearance: string;    // 外观年龄范围
  build: string;            // 体型描述
} {
  const hairColor = randomHairColor(race);
  const eyeColor = randomEyeColor(race);

  const agePool = ['少年', '青年', '壮年', '中年'];
  const buildMale = ['瘦削', '精壮', '魁梧', '匀称', '健硕'];
  const buildFemale = ['纤细', '匀称', '丰满', '娇小', '高挑'];
  const buildGeneric = ['中等', '匀称', '偏瘦', '偏壮'];

  const ageAppearance = pick(agePool);
  const build = gender === '男' ? pick(buildMale)
    : gender === '女' ? pick(buildFemale)
    : pick(buildGeneric);

  return { hairColor, eyeColor, ageAppearance, build };
}
