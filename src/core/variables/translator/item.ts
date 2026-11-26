/**
 * 物品（背包与装备，§5.3）的翻译（自 `state-tree-translator.ts` 拆出，行为不变）。
 */

import type { EquipSlot } from '../../content/field-enums';
import { findByName } from '../../state/patch-reducer';
import type { CharacterState, InventoryItem, StatePatch } from '../../types/types';
import {
  clampQuantityDecrease,
  coerceNumber,
  coerceQuantity,
  coerceSlot,
  pickKnownKeys,
  type SlotValue,
} from '../state-tree-codecs';
import type { ResolvedTreePath } from '../state-tree-patch';
import { stateTreeChildKeys, stateTreeKernelOf } from '../state-tree-spec';
import { isPlainObject, jsonClone } from '../state-tree-utils';
import { Drop, charTarget, editKeyed, hasOwn, numberWrite, take, type OpContext } from './common';
import { buildItemFields } from './fields';
import type { TranslatorHost } from './host';
import { BAG_ITEM_SPEC, EQUIP_ITEM_SPEC, SLOT_KEY, childOf } from './rules';

/** 穿戴槽位：op 自带 → 同批后续对 `<P>/装备/<物>/位置` 的写入 → 丢「缺少位置」。 */
function slotFor(
  h: TranslatorHost,
  ctx: OpContext,
  person: string,
  item: string,
  own: SlotValue | undefined,
): EquipSlot {
  if (own) {
    if (own.kind === 'unequip') throw new Drop('穿戴的位置不能为空');
    return own.slot;
  }
  const pos = h.queue.findIndex((q) => q.index === ctx.op.index);
  for (const later of h.queue.slice(pos + 1)) {
    if (h.consumed.has(later.index) || ctx.consumed.includes(later.index)) continue;
    if (later.op !== 'replace' && later.op !== 'add') continue;
    let lt: ResolvedTreePath;
    try {
      lt = h.resolve(later.segments, later.style, []);
    } catch {
      continue;
    }
    const e = lt.entry;
    if (!lt.person || lt.person.name !== person || !e || e.record !== '装备' || e.name !== item)
      continue;
    if (lt.subPath.length !== 1 || lt.subPath[0] !== '位置') continue;
    const s = coerceSlot(later.value);
    if (!s.ok || s.value.kind !== 'equip') continue;
    ctx.consumed.push(later.index);
    ctx.notes.push(`位置取自第 ${later.index + 1} 条的写入`);
    return s.value.slot;
  }
  throw new Drop('缺少位置');
}

/** 同槽顶替说明（§5.3）。 */
function displacementNote(
  ctx: OpContext,
  char: CharacterState,
  item: string,
  slot: EquipSlot,
): void {
  const other = char.inventory.find((i) => i.name !== item && i.equippedSlot === slot);
  if (other) ctx.notes.push(`「${other.name}」已自动卸回背包`);
}

export function translateItem(
  h: TranslatorHost,
  ctx: OpContext,
  t: ResolvedTreePath,
  f: ResolvedTreePath | undefined,
  char: CharacterState,
): void {
  const w = ctx.op;
  const e = t.entry!;
  const dict = e.record as '背包' | '装备';
  const name = e.name;
  const target = charTarget(char.name);
  const item = findByName(char.inventory, name);
  if (w.op === 'move') {
    if (t.subPath.length > 0 || t.leafKey !== undefined) throw new Drop('move 只用于物品条目');
    return itemMove(h, ctx, t, f!, char);
  }
  if (t.subPath.length === 0 && t.leafKey === undefined) {
    // ---- 整条 ----
    if (w.op === 'remove') {
      if (!item) throw new Drop(`物品「${name}」不存在`);
      if (dict === '背包' && item.equippedSlot) ctx.notes.push('物品在装备中，已一并移除');
      h.commit([{ op: 'remove_item', target, value: { name, quantity: item.quantity } }]);
      return;
    }
    if (w.op === 'delta') throw new Drop('物品条目不能 delta');
    let raw: unknown = w.value;
    if (dict === '装备' && typeof raw === 'string') raw = { [SLOT_KEY]: raw };
    if (!isPlainObject(raw)) throw new Drop('写入物品条目需要对象');
    const picked = take(
      pickKnownKeys(raw, stateTreeChildKeys(dict === '装备' ? EQUIP_ITEM_SPEC : BAG_ITEM_SPEC)),
      ctx.notes,
    );
    if (dict === '背包' && hasOwn(raw, SLOT_KEY) && raw[SLOT_KEY] !== null && raw[SLOT_KEY] !== '')
      ctx.notes.push('背包物品不记位置，已忽略；穿戴请 move 到装备并写位置');
    const built = buildItemFields(picked, ctx.notes, true);
    ctx.value = picked;
    const changes = built.fields;
    const hasChanges = Object.keys(changes).length > 0;
    if (dict === '背包') {
      if (!item) {
        h.commit([
          {
            op: 'add_item',
            target,
            value: { name, ...changes, quantity: built.quantity ?? 1, equippedSlot: null },
          },
        ]);
        return;
      }
      if (w.op === 'add') {
        if (hasChanges) ctx.notes.push('同名物品已存在，只叠数量；改字段请写叶子');
        const quantity = built.quantity ?? 1;
        if (item.equippedSlot) {
          // 背包投影里没有这件（它在装备里）：记录改成 `装备/<物>/数量` 的 delta，前后值才对得上，
          // 撤销 / 改值只动叠加的那几件，不会把这行当成新建物品
          ctx.notes.push('同名物品已穿戴，数量叠在装备上');
          const leaf = h.resolve([...t.segments.slice(0, -2), '装备', name, '数量'], 'array', []);
          ctx.pointer = leaf.pointer;
          ctx.segments = leaf.segments;
          ctx.recordOp = 'delta';
          ctx.value = quantity;
        }
        h.commit([{ op: 'add_item', target, value: { name, quantity } }]);
        return;
      }
      // replace 已有物品：改字段 + 调数量；在装备中则卸回背包
      const group: StatePatch[] = [];
      if (item.equippedSlot) {
        ctx.notes.push('物品原在装备，已卸回背包');
        group.push({ op: 'unequip_item', target, value: { name } });
      }
      if (hasChanges) group.push({ op: 'update_item', target, value: { name, changes } });
      if (built.quantity !== undefined)
        group.push(...quantityPatches(target, name, item.quantity, built.quantity));
      h.commit(group);
      return;
    }
    // dict === '装备'
    const group: StatePatch[] = [];
    if (!item) {
      if ((built.quantity ?? 1) > 1) throw new Drop('堆叠物品不能穿戴（数量要为 1）');
      const slot = slotFor(h, ctx, char.name, name, built.slot);
      displacementNote(ctx, char, name, slot);
      group.push(
        { op: 'add_item', target, value: { name, ...changes, quantity: 1, equippedSlot: null } },
        { op: 'equip_item', target, value: { name, slot } },
      );
    } else if (!item.equippedSlot) {
      if (item.quantity > 1) throw new Drop(`堆叠物品不能穿戴：「${name}」数量 ${item.quantity}`);
      const slot = slotFor(h, ctx, char.name, name, built.slot);
      displacementNote(ctx, char, name, slot);
      if (hasChanges) group.push({ op: 'update_item', target, value: { name, changes } });
      group.push({ op: 'equip_item', target, value: { name, slot } });
    } else {
      if (built.quantity !== undefined) ctx.notes.push('装备条目的数量请写 数量 叶子，已忽略');
      if (hasChanges) group.push({ op: 'update_item', target, value: { name, changes } });
      if (built.slot?.kind === 'equip' && built.slot.slot !== item.equippedSlot) {
        displacementNote(ctx, char, name, built.slot.slot);
        group.push({ op: 'equip_item', target, value: { name, slot: built.slot.slot } });
      } else if (built.slot?.kind === 'unequip') {
        group.push({ op: 'unequip_item', target, value: { name } });
      }
    }
    h.commit(group);
    return;
  }
  // ---- 叶子 ----
  if (!item) throw new Drop(`物品「${name}」不存在`);
  const fieldRule = childOf(EQUIP_ITEM_SPEC, t.subPath[0] ?? '')?.rule;
  if (fieldRule === 'itemQuantity') {
    if (w.op === 'remove') throw new Drop('数量不能删除，请写 0 或删条目');
    const op = w.op === 'add' ? 'replace' : w.op;
    if (op !== 'replace' && op !== 'delta') throw new Drop('数量只能 replace 或 delta');
    const n = take(coerceNumber(w.value, { integer: true }), ctx.notes);
    const want = op === 'delta' ? item.quantity + n : n;
    // delta 恰好减到 0 是正常消耗（用掉最后一件），不是纠正；显式写 ≤0 的 replace、超扣才记纠正
    const q = take(coerceQuantity(want), op === 'delta' && want === 0 ? [] : ctx.notes);
    if (q.count > item.quantity && item.equippedSlot)
      ctx.notes.push('同名物品已穿戴，数量叠在装备上');
    ctx.value = op === 'delta' ? (q.remove ? -item.quantity : q.count - item.quantity) : q.count;
    h.commit(
      quantityPatches(
        target,
        name,
        item.quantity,
        q.remove ? 0 : q.count,
        ctx.notes,
        op === 'delta' ? -n : undefined,
      ),
    );
    return;
  }
  if (fieldRule === 'itemSlot') {
    const slot =
      w.op === 'remove' ? ({ kind: 'unequip' } as SlotValue) : take(coerceSlot(w.value), ctx.notes);
    if (w.op !== 'remove' && w.op !== 'replace' && w.op !== 'add')
      throw new Drop('位置只能 replace');
    ctx.value = slot.kind === 'equip' ? slot.slot : '';
    if (slot.kind === 'unequip') {
      if (!item.equippedSlot) {
        ctx.notes.push('物品本就在背包');
        return;
      }
      h.commit([{ op: 'unequip_item', target, value: { name } }]);
      return;
    }
    if (item.equippedSlot === slot.slot) return;
    if (item.quantity > 1) throw new Drop(`堆叠物品不能穿戴：「${name}」数量 ${item.quantity}`);
    if (!item.equippedSlot) ctx.notes.push('物品原在背包，已按穿戴处理');
    displacementNote(ctx, char, name, slot.slot);
    h.commit([{ op: 'equip_item', target, value: { name, slot: slot.slot } }]);
    return;
  }
  const changes = itemLeafChanges(ctx, t, item);
  h.commit([{ op: 'update_item', target, value: { name, changes } }]);
}

/** 物品叶子写入 → update_item 的 changes。 */
function itemLeafChanges(
  ctx: OpContext,
  t: ResolvedTreePath,
  item: InventoryItem,
): Partial<InventoryItem> {
  const w = ctx.op;
  const field = t.subPath[0] ?? '';
  const node = childOf(EQUIP_ITEM_SPEC, field);
  if (node?.type === 'branch') {
    // 耐久：整份 {当前, 上限} 或其中一个数值叶子
    const sub = t.subPath[1];
    const kernels = node.children.map((c) => c.kernel as keyof InventoryItem);
    if (sub === undefined) {
      if (w.op === 'remove') return Object.fromEntries(kernels.map((k) => [k, undefined]));
      if (!isPlainObject(w.value))
        throw new Drop(`${field}要写成 {${stateTreeChildKeys(node).join(', ')}}`);
      const built = buildItemFields({ [field]: w.value }, ctx.notes, false).fields;
      ctx.value = w.value;
      return built;
    }
    const kernel = stateTreeKernelOf(node, sub) as 'durability' | 'maxDurability';
    if (w.op === 'remove') return { [kernel]: undefined };
    const cur = typeof item[kernel] === 'number' ? item[kernel] : 0;
    const next = numberWrite(ctx, w.op === 'add' ? 'replace' : w.op, cur, field);
    ctx.value = w.op === 'delta' ? next - cur : next;
    return { [kernel]: next };
  }
  const kernel = node?.rule === 'itemField' ? (node.kernel as keyof InventoryItem) : undefined;
  if (!kernel) throw new Drop(`「${field}」不可写`);
  if (w.op === 'remove' && t.leafKey === undefined) {
    if (kernel === 'rarity' || kernel === 'type' || kernel === 'description')
      throw new Drop(`${field}不能删除，请用 replace`);
    return { [kernel]: undefined };
  }
  if (w.op === 'delta' && t.leafKey === undefined) throw new Drop(`${field}不能 delta`);
  let raw: unknown = w.value;
  if (t.leafKey !== undefined) {
    if (w.op === 'delta' && kernel !== 'stats') throw new Drop(`${field}不能 delta`);
    raw = editKeyed(
      item[kernel],
      w.op,
      t.leafKey,
      w.op === 'remove' ? undefined : w.value,
      kernel === 'tags',
    );
  }
  const built = buildItemFields({ [field]: raw }, ctx.notes, false).fields;
  ctx.value = t.leafKey !== undefined ? w.value : raw;
  return built;
}

/** 数量从 held 调到 want：增 add_item，减 remove_item（超扣钳到持有量，§5.2）。 */
function quantityPatches(
  target: string,
  name: string,
  held: number,
  want: number,
  notes?: string[],
  requestedDecrease?: number,
): StatePatch[] {
  if (want > held) return [{ op: 'add_item', target, value: { name, quantity: want - held } }];
  if (want < held) {
    let dec = held - want;
    if (requestedDecrease !== undefined && notes) {
      const c = clampQuantityDecrease(held, requestedDecrease);
      if (c.ok && c.note) notes.push(c.note);
      if (c.ok) dec = c.value;
    }
    return [{ op: 'remove_item', target, value: { name, quantity: dec } }];
  }
  return [];
}

function itemMove(
  h: TranslatorHost,
  ctx: OpContext,
  t: ResolvedTreePath,
  f: ResolvedTreePath,
  dstChar: CharacterState,
): void {
  const w = ctx.op;
  const fe = f.entry;
  if (
    !f.person ||
    !fe ||
    (fe.record !== '背包' && fe.record !== '装备') ||
    f.subPath.length > 0 ||
    f.leafKey !== undefined
  )
    throw new Drop('物品只能从 背包 / 装备 条目 move');
  if (!f.person.exists) throw new Drop(`人物「${f.person.name}」不存在`);
  const srcChar = h.character(f.person.name);
  const item = findByName(srcChar.inventory, fe.name);
  if (!item) throw new Drop(`物品「${fe.name}」不存在`);
  const dict = t.entry!.record as '背包' | '装备';
  const dstName = t.entry!.name;
  const srcTarget = charTarget(srcChar.name);
  const dstTarget = charTarget(dstChar.name);
  // value：装备一侧给位置（字符串或含 位置 的对象）；对象的其余字段并入 update_item；背包一侧可给数量
  let slotOwn: SlotValue | undefined;
  let extra: Partial<InventoryItem> = {};
  let qtyOwn: number | undefined;
  if (w.hasValue && w.value !== null && w.value !== undefined) {
    if (typeof w.value === 'string' && dict === '装备')
      slotOwn = take(coerceSlot(w.value), ctx.notes, '位置');
    else if (isPlainObject(w.value)) {
      const picked = take(pickKnownKeys(w.value, stateTreeChildKeys(EQUIP_ITEM_SPEC)), ctx.notes);
      const built = buildItemFields(picked, ctx.notes, true);
      extra = built.fields;
      slotOwn = built.slot;
      qtyOwn = built.quantity;
      if (dict === '背包' && built.slot) ctx.notes.push('卸下时的位置已忽略');
    } else if (typeof w.value === 'number' || typeof w.value === 'string') {
      const q = take(coerceQuantity(w.value), ctx.notes, '数量');
      if (q.remove) throw new Drop('数量 ≤ 0');
      qtyOwn = q.count;
    }
  }
  const hasExtra = Object.keys(extra).length > 0;
  const group: StatePatch[] = [];
  if (srcChar === dstChar) {
    if (dstName === item.name) {
      if (dict === '装备') {
        if (item.quantity > 1)
          throw new Drop(`堆叠物品不能穿戴：「${item.name}」数量 ${item.quantity}`);
        const slot = slotFor(h, ctx, dstChar.name, item.name, slotOwn);
        if (item.equippedSlot === slot && !hasExtra) throw new Drop('物品已穿在这个位置');
        displacementNote(ctx, dstChar, item.name, slot);
        if (hasExtra)
          group.push({
            op: 'update_item',
            target: dstTarget,
            value: { name: item.name, changes: extra },
          });
        if (item.equippedSlot !== slot)
          group.push({ op: 'equip_item', target: dstTarget, value: { name: item.name, slot } });
        ctx.value = slot;
      } else {
        if (!item.equippedSlot) throw new Drop('物品本就在背包');
        group.push({ op: 'unequip_item', target: dstTarget, value: { name: item.name } });
        if (hasExtra)
          group.push({
            op: 'update_item',
            target: dstTarget,
            value: { name: item.name, changes: extra },
          });
      }
      h.commit(group);
      return;
    }
    // 同一人物改名：删旧加新，字段与位置照搬
    if (findByName(dstChar.inventory, dstName)) throw new Drop(`物品「${dstName}」已存在`);
    const copy = jsonClone(item);
    delete copy.id;
    const fromDict = fe.record;
    group.push({
      op: 'remove_item',
      target: srcTarget,
      value: { name: item.name, quantity: item.quantity },
    });
    if (dict === fromDict || (dict === '背包' && !item.equippedSlot)) {
      group.push({
        op: 'add_item',
        target: dstTarget,
        value: {
          ...copy,
          ...extra,
          name: dstName,
          equippedSlot: dict === '背包' ? null : copy.equippedSlot,
        },
      });
    } else if (dict === '背包') {
      group.push({
        op: 'add_item',
        target: dstTarget,
        value: { ...copy, ...extra, name: dstName, equippedSlot: null },
      });
    } else {
      if (item.quantity > 1)
        throw new Drop(`堆叠物品不能穿戴：「${item.name}」数量 ${item.quantity}`);
      const slot = slotFor(h, ctx, dstChar.name, item.name, slotOwn);
      displacementNote(ctx, dstChar, item.name, slot);
      group.push(
        {
          op: 'add_item',
          target: dstTarget,
          value: { ...copy, ...extra, name: dstName, equippedSlot: null },
        },
        { op: 'equip_item', target: dstTarget, value: { name: dstName, slot } },
      );
    }
    h.commit(group);
    return;
  }
  // 跨人物：转移
  if (dstName !== item.name) throw new Drop('转移时不能改名');
  let qty = qtyOwn ?? item.quantity;
  if (qty > item.quantity) {
    const c = clampQuantityDecrease(item.quantity, qty);
    if (c.ok && c.note) ctx.notes.push(c.note);
    qty = item.quantity;
  }
  if (item.equippedSlot && qty >= item.quantity) ctx.notes.push('转出的物品已从装备卸下');
  group.push({
    op: 'transfer_item',
    target: srcTarget,
    value: { name: item.name, to: dstChar.name, quantity: qty },
  });
  if (dict === '装备') {
    const held = findByName(dstChar.inventory, item.name)?.quantity ?? 0;
    if (held + qty > 1) throw new Drop('接收方得到的是堆叠物品，不能直接穿戴');
    const slot = slotFor(h, ctx, dstChar.name, item.name, slotOwn);
    displacementNote(ctx, dstChar, item.name, slot);
    group.push({ op: 'equip_item', target: dstTarget, value: { name: item.name, slot } });
  }
  if (hasExtra)
    group.push({
      op: 'update_item',
      target: dstTarget,
      value: { name: item.name, changes: extra },
    });
  ctx.value = qty;
  h.commit(group);
}
