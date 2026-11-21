/**
 * 开局装备 / 道具 / 技能 → 结构化落库形状（纯函数）。
 *
 * 捏人页选中的 `CatalogItem` 在建档时直接写进主角的 `inventory` / `skills`，
 * 字段形状对齐 `buildEntityGenPatches`（entity-gen-agent.ts）的 add_item / add_skill 值：
 *
 * - 装备：`type:'装备'`、数量 1、品质归一化；同槽第一件穿上（`equippedSlot` = 归一化槽位），
 *   同槽后来者与无法识别槽位的一律躺背包（`equippedSlot: null`）。
 * - 道具：数量取 `quantity ?? 1`，类型归一化，认不出兜底「特殊」。
 * - 技能：类型含「被动」即 passive，其余 active；`level: 1`；
 *   `consume` 能读出 HP/MP/SP + 数值时才给 `cost`。
 *
 * 战斗走协议沙盒，每件实体只读 `description` / `protocolText` / `tags`
 * （combat/sandbox/state.ts），所以这里给每一条合成一份可读的纯文本 `protocolText`
 * （描述、标签、效果词条、消耗、数值逐行列出）。
 *
 * 名字是逻辑键（规范铁律1）：背包同名条目合并数量（保留第一条的其余字段），同名技能保留第一条。
 */
import type { CatalogItem } from './start-catalog-mechanics';
import type { InventoryItem, Skill } from '../types/types';
import { normalizeItemType, normalizeRarity, normalizeSlot } from './field-enums';
import type { EquipSlot } from './field-enums';

export interface StartLoadoutInput {
  equipments: CatalogItem[];
  items: CatalogItem[];
  skills: CatalogItem[];
}

export interface StartLoadout {
  inventory: InventoryItem[];
  skills: Skill[];
}

/** 装备数值英文键 → 中文名（与捏人页开场提示词的写法一致；未知键原样输出） */
const STAT_LABELS: Record<string, string> = {
  atk: '攻击力',
  defense: '防御',
  penetration: '穿透',
  hit: '命中',
  dodge: '闪避',
  dr: '减伤',
};

/** consume 文本里的资源消耗：`MP 10` / `MP:10` / `10MP` 三种写法都认，取第一处 */
const COST_RE = /(HP|MP|SP)\s*[:：]?\s*(\d+)|(\d+)\s*(HP|MP|SP)/i;

/** 从 consume 描述解析技能消耗；读不出资源类型 + 数值时返回 undefined */
export function parseSkillCost(consume: string | undefined): Skill['cost'] {
  if (!consume) return undefined;
  const m = COST_RE.exec(consume);
  if (!m) return undefined;
  const type = (m[1] ?? m[4]).toUpperCase() as 'HP' | 'MP' | 'SP';
  const amount = Number(m[2] ?? m[3]);
  if (!Number.isFinite(amount)) return undefined;
  return { type, amount };
}

function hasEntries(obj: Record<string, unknown> | undefined): obj is Record<string, unknown> {
  return !!obj && Object.keys(obj).length > 0;
}

function cleanTags(tags: string[] | undefined): string[] {
  return (tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
}

/** 合成纯文本协议文本：描述 / 标签 / 效果 / 消耗 / 数值，逐行；全空返回 undefined */
function buildProtocolText(c: CatalogItem): string | undefined {
  const lines: string[] = [];
  const desc = c.description?.trim();
  if (desc) lines.push(desc);
  const tags = cleanTags(c.tag);
  if (tags.length > 0) lines.push(`标签：${tags.join('、')}`);
  if (hasEntries(c.effect)) {
    lines.push(
      `效果：${Object.entries(c.effect)
        .map(([k, v]) => `${k}（${v}）`)
        .join('；')}`,
    );
  }
  const consume = c.consume?.trim();
  if (consume) lines.push(`消耗：${consume}`);
  if (hasEntries(c.stats)) {
    lines.push(
      `数值：${Object.entries(c.stats)
        .map(([k, v]) => `${STAT_LABELS[k] ?? k} ${v}`)
        .join('、')}`,
    );
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** 两者共用的可选叙事字段：品质 / 效果 / 协议文本 / 标签，空则不写 */
function optionalFields(c: CatalogItem) {
  const rarity = normalizeRarity(c.rarity);
  const tags = cleanTags(c.tag);
  const protocolText = buildProtocolText(c);
  return {
    ...(rarity ? { rarity } : {}),
    ...(hasEntries(c.effect) ? { effects: { ...c.effect } } : {}),
    ...(protocolText ? { protocolText } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/** 把捏人页选中项转成主角初始 inventory + skills（纯函数，不碰输入） */
export function buildStartLoadout(input: StartLoadoutInput): StartLoadout {
  const inventory: InventoryItem[] = [];
  const byName = new Map<string, InventoryItem>();
  const occupied = new Set<EquipSlot>();

  const pushItem = (entry: InventoryItem) => {
    const existing = byName.get(entry.name);
    if (existing) {
      existing.quantity += entry.quantity;
      return;
    }
    byName.set(entry.name, entry);
    inventory.push(entry);
  };

  for (const e of input.equipments ?? []) {
    const name = e.name?.trim();
    if (!name) continue;
    // 同名装备合并数量，不再占第二个槽位
    if (byName.has(name)) {
      pushItem({ name, quantity: 1 });
      continue;
    }
    const slot = normalizeSlot(e.type);
    const equippedSlot = slot && !occupied.has(slot) ? slot : null;
    if (equippedSlot) occupied.add(equippedSlot);
    pushItem({
      name,
      description: e.description ?? '',
      quantity: 1,
      type: '装备',
      equippedSlot,
      ...(hasEntries(e.stats) ? { stats: { ...e.stats } } : {}),
      ...optionalFields(e),
    });
  }

  for (const i of input.items ?? []) {
    const name = i.name?.trim();
    if (!name) continue;
    pushItem({
      name,
      description: i.description ?? '',
      quantity: i.quantity ?? 1,
      type: normalizeItemType(i.type) ?? '特殊',
      ...optionalFields(i),
    });
  }

  const skills: Skill[] = [];
  const skillNames = new Set<string>();
  for (const s of input.skills ?? []) {
    const name = s.name?.trim();
    if (!name || skillNames.has(name)) continue;
    skillNames.add(name);
    const cost = parseSkillCost(s.consume);
    skills.push({
      name,
      description: s.description ?? '',
      type: (s.type ?? '').includes('被动') ? 'passive' : 'active',
      level: 1,
      ...(cost ? { cost } : {}),
      ...optionalFields(s),
    });
  }

  return { inventory, skills };
}
