import type { CharacterState, CombatParticipant } from '../types/types';
import type { EffectAutomaton } from './types';

/**
 * 从装备 stats 对象里按「英文键优先、中文键兜底」的顺序取数值。
 * 背景（2026-08-12）：item_gen 链路（char-gen-agent parseEquipmentXML）把 XML
 * `stats="攻击力:130"` 原样解析成中文键对象（{ 攻击力: 130 }）经 add_item patch 落库，
 * 真机数据里 `攻击`/`攻击力`/`防御`/`防御力` 并存；而本模块读取处此前只认英文键
 * （atk/defense/dr/...），导致 weaponAtk 恒 0、defense 恒 10。中文候选词与
 * effect-parser CHINESE_TO_KEY / describe-automaton SLOT_CN 的口径对齐
 * （攻击力/防御力/命中/闪避/穿透/减伤）。存量存档不动，只在读取处做多键兼容。
 */
function statNum(
  stats: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (!stats) return undefined;
  for (const k of keys) {
    const v = stats[k];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/**
 * 从 CharacterState 创建 CombatParticipant。
 * 填充战斗所需的衍生字段（M2：装备 = inventory 中 equippedSlot 非空的物品，规范 §3）。
 * 纯类型转换；不依赖任何 v2 战斗运行时。
 */
export function characterToCombatParticipant(
  char: CharacterState,
  side: 'ally' | 'enemy',
  overrides?: Partial<CombatParticipant>,
): CombatParticipant {
  // M2: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3，槽位为中文枚举 EQUIP_SLOTS）
  const weapon = char.inventory.find((i) => i.equippedSlot === '武器');
  const armor = char.inventory.find((i) => i.equippedSlot === '身体');

  // 🆕 战斗 v3 修复：收集全部已装备物品的 modifiers（词条效果）→ CombatParticipant.modifiers，
  //    由 createCombatState 编译进 activeEffects。v2 时代由 combat-resolver 消费，M5 后此链路曾断。
  const equippedModifiers = char.inventory
    .filter((i) => i.equippedSlot)
    .flatMap((i) => i.modifiers ?? []);

  // 🆕 战斗 v3 (S3 2026-08-01): 收集已装备物品 + 技能的 automata（AI 产的自由效果 DSL）
  //    → CombatParticipant.automata，由 createCombatState 编译进 activeEffects。
  //    装备 automata 直接收；技能只收被动（主动技能在战斗中由 $combat action 触发，不在被动效果里）。
  const equippedAutomata: EffectAutomaton[] = [
    ...char.inventory.filter((i) => i.equippedSlot).flatMap((i) => i.automata ?? []),
    ...(char.skills ?? []).filter((s) => s.type === 'passive').flatMap((s) => s.automata ?? []),
  ];

  // 🆕 skillPower 链路修复 (2026-08-04): 摘主动技能的最小战斗集（skillPower/relevantAttribute/
  //    damageType/divinity），供 v3 内核 declare_attack 时按 skillName 查主体威力填进 ability。
  //    被动技能不在这里（它们的 modifiers/automata 走 equippedAutomata/equippedModifiers 通道）。
  //    旧存档 Skill 无 skillPower 字段 → typeof 过滤掉，行为与现状一致（兜底 0，不退化）。
  const activeSkills = (char.skills ?? [])
    .filter((s) => s.type === 'active' && typeof s.skillPower === 'number')
    .map((s) => ({
      name: s.name,
      skillPower: s.skillPower as number,
      relevantAttribute: s.relevantAttribute,
      damageType: s.damageType,
      divinity: s.divinity,
    }));

  return {
    characterId: char.id,
    name: char.name,
    tier: char.tier,
    level: char.level,
    attributes: { ...char.attributes },
    hp: char.hp,
    maxHp: char.maxHp,
    mp: char.mp,
    maxMp: char.maxMp,
    sp: char.sp,
    maxSp: char.maxSp,
    defense: statNum(armor?.stats, 'defense', '防御', '防御力') ?? 10,
    dr: statNum(armor?.stats, 'dr', '减伤') ?? 0,
    penetration: statNum(weapon?.stats, 'penetration', '穿透') ?? 0,
    hitBonus: statNum(weapon?.stats, 'hit', '命中') ?? 0,
    dodgeBonus: statNum(armor?.stats, 'dodge', '闪避') ?? 0,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 1,
    actionsRemaining: 1,
    statusEffects: char.statusEffects,
    weaponAtk: statNum(weapon?.stats, 'atk', '攻击', '攻击力') ?? 0,
    modifiers: equippedModifiers.length > 0 ? equippedModifiers : undefined,
    automata: equippedAutomata.length > 0 ? equippedAutomata : undefined,
    activeSkills: activeSkills.length > 0 ? activeSkills : undefined,
    side,
    canAct: char.hp > 0,
    ...overrides,
  };
}
