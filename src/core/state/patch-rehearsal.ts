/**
 * patch-rehearsal.ts — 建补丁预演（纯内存，无 I/O）
 *
 * 给一份角色快照 + 一串 StatePatch，按顺序逐条判定能否在提交时落下，并更新影子状态
 * （各角色持有的物品数量与技能名）。提交时注定抛错的补丁在这里先被判出来，由调用方丢掉。
 * 直出建补丁（agents/direct-output.ts）与将来的翻译层共用这一份；静态形状与按名寻址
 * 仍走 patch-rules.ts，报错文案对齐提交时（StateManager）。
 */
import type { CharacterState, StatePatch } from '../types/types';
import { isRecord } from '../character/character-updates';
import { normalizeSlot } from '../content/field-enums';
import { characterKeyOfTarget, resolveCharacterByName, validateStatePatch } from './patch-rules';

type Row = Record<string, unknown>;

/** 本楼补丁逐条落下时，各角色持有的物品数量与技能名（只用于预判，不改真实角色） */
export interface Holdings {
  items: Map<string, number>;
  skills: Set<string>;
}

/**
 * 按补丁顺序预演物品 / 技能的增减，提前找出提交时必抛的补丁（物品不存在、数量不足、
 * 自我转移、槽位无法识别、堆叠穿戴、技能不存在）。预演只读角色快照，不改它们。
 */
export class PatchRehearsal {
  private readonly holdings = new Map<CharacterState, Holdings>();

  constructor(private readonly characters: readonly CharacterState[]) {}

  private holdingOf(character: CharacterState): Holdings {
    let holding = this.holdings.get(character);
    if (!holding) {
      const items = new Map<string, number>();
      for (const item of character.inventory ?? [])
        if (!items.has(item.name)) items.set(item.name, item.quantity);
      holding = { items, skills: new Set((character.skills ?? []).map((skill) => skill.name)) };
      this.holdings.set(character, holding);
    }
    return holding;
  }

  /** 记下当前预演进度，供一组补丁（替换的删旧 + 加新）失败时整组回滚 */
  snapshot(): Map<CharacterState, Holdings> {
    const copy = new Map<CharacterState, Holdings>();
    for (const [character, holding] of this.holdings)
      copy.set(character, { items: new Map(holding.items), skills: new Set(holding.skills) });
    return copy;
  }

  restore(snapshot: Map<CharacterState, Holdings>): void {
    this.holdings.clear();
    for (const [character, holding] of snapshot) this.holdings.set(character, holding);
  }

  private resolve(key: string): CharacterState {
    return resolveCharacterByName(this.characters, key);
  }

  /** 检查一条补丁；能落就返回「落下」的预演动作，不能落就抛错（文案对齐提交时的报错） */
  vet(patch: StatePatch): () => void {
    validateStatePatch(patch);
    const key = characterKeyOfTarget(patch.target);
    if (key === undefined) return () => undefined;
    const owner = this.resolve(key);
    const holding = this.holdingOf(owner);
    const value = (isRecord(patch.value) ? patch.value : {}) as Row;
    const name = typeof value.name === 'string' ? value.name : undefined;
    const need = (op: string) => {
      if (!name) throw new Error(`${op} 需要 value.name`);
      return name;
    };
    const positive = (raw: unknown) => (typeof raw === 'number' && raw > 0 ? raw : 1);
    switch (patch.op) {
      case 'add_item': {
        const item = need('add_item');
        const qty = positive(value.quantity);
        return () => holding.items.set(item, (holding.items.get(item) ?? 0) + qty);
      }
      case 'remove_item': {
        const item = need('remove_item');
        const qty = typeof value.quantity === 'number' ? value.quantity : 1;
        const have = holding.items.get(item);
        if (have === undefined) throw new Error(`物品不存在: ${item}`);
        if (have < qty) throw new Error(`物品「${item}」库存不足: 持有 ${have}，需要 ${qty}`);
        return () => {
          if (have - qty === 0) holding.items.delete(item);
          else holding.items.set(item, have - qty);
        };
      }
      case 'transfer_item': {
        const item = need('transfer_item');
        if (typeof value.to !== 'string' || !value.to)
          throw new Error('transfer_item 需要 value.to（接收方名字）');
        const to = this.resolve(value.to);
        if (to === owner) throw new Error(`transfer_item 不允许自我转移: ${owner.name}`);
        const qty = positive(value.quantity);
        const have = holding.items.get(item);
        if (have === undefined) throw new Error(`物品不存在: ${item}`);
        if (have < qty) throw new Error(`物品数量不足: ${item}（持有 ${have}，需 ${qty}）`);
        const receiver = this.holdingOf(to);
        return () => {
          if (have - qty <= 0) holding.items.delete(item);
          else holding.items.set(item, have - qty);
          receiver.items.set(item, (receiver.items.get(item) ?? 0) + qty);
        };
      }
      case 'equip_item': {
        const item = need('equip_item');
        if (typeof value.slot !== 'string' || !value.slot)
          throw new Error('equip_item 需要 value.slot');
        if (!normalizeSlot(value.slot)) throw new Error(`无法识别的装备槽位: ${value.slot}`);
        const have = holding.items.get(item);
        if (have === undefined) throw new Error(`物品不存在: ${item}`);
        if (have > 1)
          throw new Error(`堆叠物品不可直接穿戴: ${item}（数量 ${have}），请先拆分为单件`);
        return () => undefined;
      }
      case 'unequip_item':
      case 'update_item':
        if (name !== undefined && !holding.items.has(name)) throw new Error(`物品不存在: ${name}`);
        if (patch.op === 'update_item') need('update_item');
        return () => undefined;
      case 'add_skill': {
        const skill = need('add_skill');
        return () => holding.skills.add(skill);
      }
      case 'remove_skill':
      case 'update_skill': {
        const skill = need(patch.op);
        if (!holding.skills.has(skill)) throw new Error(`技能不存在: ${skill}`);
        return patch.op === 'remove_skill' ? () => holding.skills.delete(skill) : () => undefined;
      }
      default:
        return () => undefined;
    }
  }
}
