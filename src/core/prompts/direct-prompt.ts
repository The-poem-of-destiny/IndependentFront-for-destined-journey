import type { AgentPreset, ChatPreset } from '../types/types';
import {
  CRAFT_DC_BASE,
  CRAFT_PRODUCTION_BONUSES,
  CRAFT_QUALITY_EXP,
  CRAFT_INDUSTRY_ATTRIBUTE,
  HIT_RATINGS,
} from '../types/types';
import { TIER_CONFIGS } from '../character/tier-constants';
import { EQUIP_SLOTS, ITEM_TYPES, QUEST_STATUSES, RARITY_LEVELS } from '../content/field-enums';
import {
  DIRECT_CHARACTER_FIELDS,
  DIRECT_DELTA_PATHS,
  DIRECT_EFFECT_CATEGORIES,
  DIRECT_EFFECT_TIME_UNITS,
  DIRECT_EFFECT_UPDATE_KEYS,
  DIRECT_ENTITY_OUTER_KEYS,
  DIRECT_ITEM_MODIFY_KEYS,
  DIRECT_REMOVE_PATHS,
  DIRECT_STRIPPED_KEYS,
  DIRECT_WORLD_RESERVED_SEGMENTS,
} from '../agents/direct-contract';

export const DIRECT_PRESET_ID = 'direct-generation-v1';
export const DIRECT_CACHED_PRESET_ID = 'direct-generation-cache-v1';
export const DIRECT_STYLE =
  '你是文字角色扮演的主叙事者。在同一次回复中完成场景推进、人物塑造、规则裁定和状态更新。尊重玩家的行动意图，不替玩家决定下一步、不替玩家说话。正文以自然语言呈现感官、情绪和行动后果，规则计算放在简洁的行动或物品面板。战斗停在下一处需要玩家选择的位置。延续原有角色的声音、关系和世界事实。';
export const DIRECT_TEMPLATE =
  '{{SYS_PROMPT}}\n{{LORE_BOOK_STATIC}}\n{{LORE_BOOK_DYNAMIC}}\n{{AGENT.MEMORY_RECALL}}\n{{NARRATIVE}}\n{{MAP_CONTEXT}}\n{{RANDOM_EVENTS}}\n{{USER_INPUT}}';

/**
 * 结构化战斗开启时的 combat 契约行（源自旧版 DIRECT_PROTOCOL 该行；
 * 📌 2026-11-21 补了 round 取值与 statusEffects 条目形状，行首不变）。
 */
const DIRECT_COMBAT_STRUCTURED_LINE = `combat:null 表示无在办战斗；否则 {meta:{round:≥1 整数,combatType,environment,phase:"active"|"ended",outcome?:"ally_win"|"enemy_win"|"draw"|"fled",notes?,summary?},units:[{name,origin:"save"|"temp",side:"ally"|"enemy",hp,mp,sp,statusEffects:[{name,…同 effects add 字段}],pos?,facing?}]}。持续战斗每楼包含全部单位，更新当前数值；存档角色先通过 entities 创建，temp 仅用于临时单位且需 tier,level,race,attributes,maxHp,maxMp,maxSp。战斗资源和状态只在 combat 写，不在 state/effects 重复写同一参与者。终局写 ended 和 outcome，资源由代码白名单写回；EXP/FP 在 state 统一声明，不能依赖自动战斗奖励。`;
/** 结构化战斗关闭时的 combat 契约行：战斗写在正文里，资源与状态走 state / effects。 */
const DIRECT_COMBAT_PROSE_LINE =
  'combat：恒填 null，不写任何战斗内容。当前未启用结构化战斗：战斗直接写在正文里推进（combat 里写了内容也会被忽略，不会入库）。参战者的 HP/MP/SP 变化用 state.characters 的 replace 或 delta 声明，状态效果的获得、变化与解除用 effects 声明；没有存档实体的临时敌人不建档，其伤势与状态在正文或 action_info 中交代清楚，供后续楼延续。EXP/FP 同样在 state 声明。战斗逐拍：一名角色的一次行为单独成一节，按行动顺序排列；每节一两句叙述加至多一个 action_info，前三行固定为 |行动者|名字|、|目标|名字或无|、|行动|技能或动作名|，其后按需写 |判定|、|伤害|（或 |恢复|）、|消耗|、|状态|（受影响者资源现值与状态增减）。名字与实体名逐字一致，临时敌人称呼前后一致。';

/**
 * 直出协议正文。两种口径都带「正文分节」（`<beat/>`）一行；
 * `structuredCombat` 为假时只替换 combat 那一行（追加战斗逐拍要求），骨架里的 `"combat":null` 保留。
 */
export function buildDirectProtocol(structuredCombat: boolean): string {
  return `你正在使用直出 v1。以下为必须满足的输出与状态契约，不受文风预设覆盖。
本次只有一次主请求，无工具、无后续实体／制作／战斗／日常／剧情 Agent。记忆由独立系统处理，不输出摘要。
依据本轮权威状态和规则完成演算，再叙述一致的结果。不要输出思维链；action_info 只展示必要的掷骰、成本、结果和可见后果。
基础规则参考（数值表取自 app；详细效果以获准注入的世界书、技能和物品协议为准）：
层级表：${JSON.stringify(TIER_CONFIGS.map(({ tier, levelRange, attributeCap, combatCoefficient, qualityCap }) => ({ tier, levelRange, attributeCap, combatCoefficient, qualityCap })))}。
战斗先攻=敏捷+d20+明确修正；命中评级表=${JSON.stringify(HIT_RATINGS)}。伤害先算关联属性×10×层级战斗系数+技能威力+武器攻击力；多段先均分向下取整。有效防御=防御×(1-穿透率)，装备减伤量向下取整(伤害×有效防御/(有效防御+2000))；类型减免：物理(体质+力量+敏捷)×0.25%，能量(精神+智力)×0.4%，精神×0.8%，真实类型此项为0，上限95%。再按评级、意图和明确词条修正，固定伤害加回，恢复多段总量，再扣 DR，集群目标最后×1.5取整。技能消耗逐次扣除，行动停在下一次玩家决策处。
制作基础 DC=${JSON.stringify(CRAFT_DC_BASE)}；产业核心属性=${JSON.stringify(CRAFT_INDUSTRY_ATTRIBUTE)}；产能表=${JSON.stringify(CRAFT_PRODUCTION_BONUSES)}；基础经验=${JSON.stringify(CRAFT_QUALITY_EXP)}。
制作检定=核心属性+技能+工具+身份+设施加值+d20；DC=max(1,基础DC+材料修正总和-设施加值-品质DC减免区间中点向下取整)。工具加值不再次减DC。层级高于目标品质对应层级用优势2d20取高，低于则劣势取低。品质对应层级：普通/优良1、稀有2、史诗3、传说4、神话5。至少两种对应品质投入物才保有该品质，否则降级；唯一品质不能制作。基础加工无检定无经验，成品需图纸。普通失败材料损耗50%，大失败100%，受产能失败保护限制；没有产物也声明实际消耗。日常恢复/消耗与状态到期必须根据实际时间和效果文本声明，不做无依据的满血恢复。
仅用提供的骰池进行需要的随机判定。骰池按骰式分行，每行形如 d20: {12, 5, 17}，依次为 d4、d6、d8、d10、d12、d20、d100；每种骰式在本行花括号内从左到右依次取用，每个位置至多消费一次，并在 diceUsed 记录 sides（骰面数）与 index（该骰在本行花括号内从 0 起的位置）。所需骰式用尽就停在尚未解决的行动前，不编造骰值。
输出顺序：恰好一个 <maintext>正文，可含 <action_info>简洁行动面板</action_info> 和 <item_info>物品面板</item_info></maintext>；可选 <options>编号建议</options>；恰好一个 <character_updates>角色协议 JSON</character_updates>；最后恰好一个 <direct_updates>JSON</direct_updates>。两个 JSON 标签内都直接写 JSON，不加代码围栏、不加注释或说明文字。
action_info 面板每行用 |名称|值|，例如 |检定|d20=12，成功|；只呈现可核对的结果，不展示内部推理。
正文分节：<maintext> 内用独占一行的 <beat/> 把正文切成节，玩家每次推进一节。一节是一个完整拍点，通常 1–3 段，全篇约 4–10 节；首尾不写，不写在 action_info／item_info 内。本楼经 entities 新建实体的人物，在其首次现身那一节之前写 <beat enter="人物名"/>（在第一节也写）；已有实体的人物不写 enter。
direct_updates 所有顶层键都必需，无变化使用空对象、空数组或 null：
{"version":1,"world":{},"time":{"delta_time":0},"entities":[],"state":{},"effects":[],"plot":{},"combat":null,"diceUsed":[]}
禁止输出裸 StatePatch、数据库路径、任何 ${DIRECT_STRIPPED_KEYS.join('/')}；所有对象按名字引用。展示卡片不能代替结构化入库。
world：可含 replace:[{path,value}]、insert:[{path,value,index?}]、tile_ops:[地块事实操作]，沿用世界变量词汇；不写时间、人物、库存、命运点或模式：path 按「.」分段，任一段不能是 ${DIRECT_WORLD_RESERVED_SEGMENTS.join('/')}（如「势力.profile.口号」也会被拒）；value 里同样不写上述账务键。
tile_ops 每项含 op 与 tile（地图已有地块名）。支持 tile_status_add/tile_status_remove（title），tile_building_add（name），tile_building_update（name；更新主建筑可改用 main:true），tile_dev_progress_add（amount，非零进度），tile_history_note（text）。不生成地块 ID，不新建地图拓扑；新增地点只能引用地图已知名称。
time.delta_time：本楼耗时的非负有限分钟，唯一时间推进来源。天气、地图周期收益由本地代码处理，不能再重复奖励；日常消耗、恢复、状态到期由你依据楼初状态与耗时在 state/effects 声明，新状态不扣创建前的耗时。
entities 项只有两种：
1. {kind:"character",placement:{location:"本楼结束时地点",present:true},output:完整实体}。作者目录里尚未有存档实体的人物首次实际登场也需完整机械数据。已有角色不能重建。仅提及名字不必创建。角色档案／经历另外遵守 character_updates 协议。
人物必须带 ascension（凡人写下方 enabled:false 默认对象）。character_updates 里的每个 name 必须已有实体或由本楼 entities 新建，否则整楼作废（该块任一警告同样作废）。
2. {kind:"loadout",owner:"人物名",output:实体}。所有者必须已存在或本楼已创建。output.ascension 可选：写了即整份替换该人物登神状态，不写即不改。
实体结构：{skills:[],equipment:[],inventory:[],statuses:[],character?:人物,ascension?:登神,elements?,authorities?}。kind 为 character 时人物字段全部写进 output.character，不平铺在 output 上（output 顶层只放 ${DIRECT_ENTITY_OUTER_KEYS.join('/')} 与 skills/equipment/inventory），ascension 也写在 character 里，顶层 ascension 只给 loadout 用；output 顶层的 skills/equipment/inventory 仍必填（通常为 []）。顶层 elements/authorities 可省略：按下标对应登神的要素／权能条目，只用来补 effectDescriptions:{词条名:效果文本}，也可直接写在条目里。loadout 的 output 不含 character。statuses 项 {name,owner,…同 effects add 字段}，owner 必须等于本实体人物名（loadout 为其 owner）。输入状态区块（direct_state；缓存直出为 direct_context）里的人物用存档字段名（outfit、statusEffects、ascension.authority/law、带 equippedSlot 的 inventory），新建实体用本协议字段名，不要照抄。例：{kind:"character",placement:{location:"…",present:true},output:{skills:[],equipment:[],inventory:[],statuses:[],character:{name:"…",race:"…",…,skills:[],equipment:[],inventory:[],ascension:{…}}}}。
人物字段除 thoughts 外全部必填：name,race,gender,tier(1..7),level(1..25),attributes:{str,dex,con,int,spi},identity:文本数组,occupation:文本数组,background,appearance,clothing,personality,likes,thoughts?,skills:[],equipment:[],inventory:[],ascension:{enabled:false,path:"",description:"",elements:[],authorities:[],laws:[],deityPosition:"",divineKingdom:{name:"",description:""}}。登神条目是对象，不能只写名字：elements 项 {name,description,effects:[]}；authorities 项 {name,description,effects:[],costDescription}；laws 项 {name,description,passiveEffects:[],activeEffects:[],costDescription}。资源上限由代码按现行规则初始化；需要受伤登场时用 state 声明当前资源。
技能：{name,description,type:"active"或"passive",quality?,cost?:{type:"HP"或"MP"或"SP",amount},cooldown?,skillPower?,relevantAttribute?,damageType?,effects?:{词条名:效果文本},protocolText?,tags?:文本数组,replace?:旧条目名}。
装备：{name,description,slot:${EQUIP_SLOTS.join('/')}之一,quality?,stats:{属性:数值},durability?,effects?,protocolText?,tags?,replace?}。
物品：{name,description,quantity:正整数,type:${ITEM_TYPES.join('/')}之一,rarity?,effects?,protocolText?,tags?,replace?}。quality/rarity 取 ${RARITY_LEVELS.join('/')}。完整保存规则文本，不只给展示描述。replace 明确替换旧条目；同名新增物品仅叠数量。给已有角色的新装备先入背包，明确穿戴另写 state.items.equip。
state 可含：
characters:{replace:[{name,path,value}],delta:[{name,path,amount}],remove:[{name,path:${DIRECT_REMOVE_PATHS.map((path) => `"${path}"`).join('或')},target:"条目名"}]}。replace 允许 ${DIRECT_CHARACTER_FIELDS.join('/')}（hp/mp/sp/money/totalExp 为非负数值，present 为布尔，其余为文本）；delta 仅 ${DIRECT_DELTA_PATHS.join('/')}，amount 为数值。不要同时 replace 和 delta 同一字段。经验只给 totalExp，升级和奖励属性点由代码处理。人物的 age／birthday 由代码按游戏时间与生日现算，只读，不要在任何补丁里写年龄。
items:{consume:[{owner,target,quantity}],equip:[{owner,target,slot}],unequip:[{owner,target}],transfer:[{from,to,target,quantity}],modify:[{owner,target,changes}]}。consume/transfer 的 quantity 为正整数；equip 的 slot 取装备槽之一；changes 只含 ${DIRECT_ITEM_MODIFY_KEYS.join('/')}。制作材料扣除和完整产物必须同楼声明，失败也明确实际成本。不得透支库存。
affections:{set:[{name,value}],delta:[{name,amount}]}、fp:{delta:数值}、quests:{upsert:[{name,status?:${QUEST_STATUSES.join('/')},priority?:低/中/高,progress?,detail?,objective?,reward?}],remove:[{name}]}，upsert 只写变化的字段。任务完成不自动发奖励，奖励在所属字段只声明一次。
effects:[{owner,action:"add"|"update"|"remove",value:{name,...}}]，效果字段必须包在 value 里。add 必填 description,category(${DIRECT_EFFECT_CATEGORIES.join('/')}),stacks(>0),remainingTime(null 为永久，否则 ≥0),timeUnit(${DIRECT_EFFECT_TIME_UNITS.join('/')})，可选 maxStacks,effects,effectDescriptions,protocolText,tags；update 只给 ${DIRECT_EFFECT_UPDATE_KEYS.join(',')}；remove 只给 name。同一角色的同名效果在本楼只写一行（实体初始 statuses 与 effects 合计）：不要对同名效果先 remove 再 add；改时长或层数用 update，对已有效果再 add 会按叠层规则累加层数、时长取较长者。
${structuredCombat ? DIRECT_COMBAT_STRUCTURED_LINE : DIRECT_COMBAT_PROSE_LINE}
plot:{} 或 {pre:{triggeredEvents:[{title,reason}],relevantBackground?:文本,outlineRelevance?:文本},post:{worldLineChanged:布尔,changeLevel:"none"|"minor"|"moderate"|"major",outlineChanges:{action:"none"|"update"|"addChapter"|"removeChapter",changes:文本},eventUpdates:[{title,action:"complete"|"fail"|"skip"|"update",changes?:对象}],newChildEvents:[{title,description,parentTitle?,triggerCondition?,depth?}]}}。按事件标题引用。剧情开关看输入状态区块的 plotSettings.mode（direct_state.plotSettings；缓存直出为 direct_context 的 plotSettings 分区）：为 off 时 plot 写 {}；pre/post 不需要就省略，不写 null。幕后动机只用于裁定，不泄露进正文或角色档案。
diceUsed:[{sides:骰面数,index:该骰式行内从 0 起的位置,purpose:"判定用途",target:"对象名"}]，purpose 与 target 不能为空。角色、物品、任务、地图与叙事必须描述同一件事。
若提供随机事件候选，本楼至多演绎一个并用 <event_trigger name="候选名"/> 回执。可以用已有 play_audio 标记，但不要发起图片、工具、entity_gen、craft、combat_trigger 或任何后续请求。`;
}

export function createDirectPreset(): AgentPreset & ChatPreset {
  return {
    id: DIRECT_PRESET_ID,
    name: '直出 · 角色卡体验',
    fixedSystem: DIRECT_STYLE,
    fixedExamples: '',
    settings: {
      prompts: [
        {
          identifier: 'direct-style',
          name: '叙事风格',
          enabled: true,
          content: DIRECT_STYLE,
          role: 'system',
          injection_order: 0,
        },
      ],
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

export function createCachedDirectPreset(): AgentPreset & ChatPreset {
  return {
    ...createDirectPreset(),
    id: DIRECT_CACHED_PRESET_ID,
    name: '直出 · 缓存优化',
    description: '单次主生成，独立记忆，旧原文在缓存会话重建时折叠。',
  };
}
