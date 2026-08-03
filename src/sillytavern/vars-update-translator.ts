/**
 * AI JSON → `StatePatch[]` 的**纯翻译层**（Q-19）。
 *
 * 这些规则此前挤在 `agent-orchestrator.processStageMarkers` 里 —— 一个从 765 行写到
 * 1327 行的私有方法，一并塞着 stage 归类、正则抠块、落库、marker 回调编排。
 * 翻译本身是纯函数（输入 parsed 对象，输出 patch 数组）却没有函数边界，于是
 * `agent-orchestrator.test.ts` 里想断言「AI 给 `path=equipment` 应该产一条
 * `add_item`」，得先搭一整条 pipeline + mock client + mock StateManager。
 *
 * 这条缝**不违反 ADR-21**：`commitChatState` 仍是唯一写入口，搬走的只是纯映射，
 * 反而让 ADR-21 更容易审计 —— 本文件没有任何 I/O，连 import 都只有类型。
 *
 * 🔴 留在 orchestrator 的：marker 的 position 偏移重算。它会 mutate
 * `this.pendingCraftMarkers` 与 `this.context.agentOutputs`，不是翻译。
 */
import type { StatePatch } from './types';
import { normalizeSlot } from './field-enums';

/** dispatcher <json> 的变量路径是否为世界新闻（含子路径，如 世界新闻.0） */
function isWorldNewsPath(path: unknown): boolean {
  return typeof path === 'string' && (path === '世界新闻' || path.startsWith('世界新闻.'));
}

/**
 * 世界新闻值 → add_news StatePatch 列表（#16 双轨退役: 变量路径退役，唯一真源 profile.news）
 *
 * AI 只填叙事字段 {title(必), content(必), category?}（铁律3，id/publishedAt/read 由 Code 补）。
 * 兼容 dispatcher 的输出形态（AI 实际形状不可控，宽容解析）:
 * - 字符串 → 作 content，标题取首句截断，category 兜底 '世界'
 * - 对象 {title?, content?, category?} → 直用，缺失侧互补
 * - 对象 {date?, event?/text?/news?} → 真机实测形状（2026-07-17）: event 作 content，date 拼前缀
 * - 数组 → 逐条按上述规则展开
 * 空串/null/不可识别值 → 丢弃（不产 patch，也不落变量）。
 */
function buildNewsPatches(
  raw: unknown,
  operation: 'replace' | 'insert',
): import('./types').StatePatch[] {
  const items = Array.isArray(raw) ? raw : [raw];
  const patches: import('./types').StatePatch[] = [];

  for (const item of items) {
    let title = '';
    let content = '';
    let category: string | undefined;

    if (typeof item === 'string') {
      content = item.trim();
      category = '世界';
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, any>;
      if (typeof obj.title === 'string') title = obj.title.trim();
      // content 候选键宽容: content > event > text > news（真机实测 AI 产 {date, event} 形状）
      const contentRaw = [obj.content, obj.event, obj.text, obj.news].find(
        (v) => typeof v === 'string' && v.trim(),
      );
      if (contentRaw) content = String(contentRaw).trim();
      if (typeof obj.category === 'string' && obj.category) category = obj.category;
      // 游戏内日期是叙事信息 → 拼 content 前缀（publishedAt 是 Code 补的现实时间戳，两者语义不同）
      const dateStr = typeof obj.date === 'string' ? obj.date.trim() : '';
      if (dateStr && content && !content.startsWith('【')) content = `【${dateStr}】${content}`;
    }

    // title/content 互补（applyAddNews 两者必填）
    if (!content && title) content = title;
    if (!title && content) {
      // 短标题: 取首句，截断 20 字（剥掉日期前缀再取）
      const bare = content.replace(/^【[^】]*】/, '');
      const firstSentence = bare.split(/[。！？!?\n]/)[0] || bare;
      title = firstSentence.slice(0, 20);
    }
    if (!title || !content) {
      console.warn('[Orchestrator] 世界新闻条目缺 title/content，跳过:', item);
      continue;
    }

    patches.push({
      op: 'add_news',
      target: 'news', // M2 约定: applyAddNews 落 profile.news，target 仅作标识
      value: category ? { title, content, category } : { title, content },
      metadata: { source: 'request_dispatcher', operation },
    });
  }

  return patches;
}

/**
 * request_dispatcher 的 `<json>` → 全局变量补丁。
 *
 * `delta_time` 不在这里落地（它走 `applyTimeAdvance` 而非 patch），原样带出去由
 * 调用方处理 —— 那一步有 I/O，不属于纯翻译。
 */
export function buildDispatcherPatches(parsed: Record<string, any>): {
  patches: StatePatch[];
  deltaTime: number | undefined;
} {
  const patches: StatePatch[] = [];

  for (const r of parsed.replace ?? []) {
    // M5: 世界新闻 → add_news（#16 双轨退役）— 不再写 variables.世界新闻，改落 profile.news
    if (isWorldNewsPath(r.path)) {
      patches.push(...buildNewsPatches(r.value, 'replace'));
      continue;
    }
    patches.push({
      op: 'set_variable',
      target: `variables.${r.path}`,
      value: r.value,
      metadata: { source: 'request_dispatcher', operation: 'replace' },
    });
  }
  for (const ins of parsed.insert ?? []) {
    // M5: 世界新闻 → add_news（#16 双轨退役）— insert 路径同样拦截
    if (isWorldNewsPath(ins.path)) {
      patches.push(...buildNewsPatches(ins.value, 'insert'));
      continue;
    }
    patches.push({
      op: 'insert_variable',
      target: `variables.${ins.path}`,
      value: ins.value,
      metadata: { source: 'request_dispatcher', operation: 'insert', index: ins.index },
    });
  }

  const deltaTime =
    typeof parsed.delta_time === 'number' && parsed.delta_time > 0 ? parsed.delta_time : undefined;
  return { patches, deltaTime };
}

/** vars_update 的 `<json>` → 角色 / 物品 / 好感度补丁 */
export function buildVarsUpdatePatches(parsed: Record<string, any>): StatePatch[] {
  const patches: StatePatch[] = [];

  // --- characters.replace → set_hp/set_mp/set_sp/set_location/update_character ---
  // M4: 名字寻址唯一化（铁律1）— key 只认 name，缺 name 跳过
  for (const r of parsed.characters?.replace ?? []) {
    const key = r.name;
    if (!key) {
      console.warn('[Orchestrator] characters.replace 条目缺 name，跳过');
      continue;
    }
    const { path, value } = r;
    switch (path) {
      case 'hp':
        patches.push({
          op: 'set_hp',
          target: `characters.${key}`,
          value,
          metadata: { source: 'vars_update' },
        });
        break;
      case 'mp':
        patches.push({
          op: 'set_mp',
          target: `characters.${key}`,
          value,
          metadata: { source: 'vars_update' },
        });
        break;
      case 'sp':
        patches.push({
          op: 'set_sp',
          target: `characters.${key}`,
          value,
          metadata: { source: 'vars_update' },
        });
        break;
      case 'location':
        patches.push({
          op: 'set_location',
          target: `characters.${key}`,
          value: value,
          metadata: { source: 'vars_update' },
        });
        break;
      case 'currentAction':
        // M3: currentAction 走 update_character，不再顶掉 location（#19 翻译侧收口）
        patches.push({
          op: 'update_character',
          target: `characters.${key}`,
          value: { currentAction: value },
          metadata: { source: 'vars_update', path },
        });
        break;
      default:
        patches.push({
          op: 'update_character',
          target: `characters.${key}`,
          value: { [path]: value },
          metadata: { source: 'vars_update', path },
        });
    }
  }

  // --- characters.delta → delta_hp/delta_mp/delta_sp/update_character(delta) ---
  // M4: 名字寻址唯一化（铁律1）— key 只认 name，缺 name 跳过
  for (const d of parsed.characters?.delta ?? []) {
    const key = d.name;
    if (!key) {
      console.warn('[Orchestrator] characters.delta 条目缺 name，跳过');
      continue;
    }
    const { path, amount } = d;
    switch (path) {
      case 'hp':
        patches.push({
          op: 'delta_hp',
          target: `characters.${key}`,
          amount,
          metadata: { source: 'vars_update' },
        });
        break;
      case 'mp':
        patches.push({
          op: 'delta_mp',
          target: `characters.${key}`,
          amount,
          metadata: { source: 'vars_update' },
        });
        break;
      case 'sp':
        patches.push({
          op: 'delta_sp',
          target: `characters.${key}`,
          amount,
          metadata: { source: 'vars_update' },
        });
        break;
      case 'money':
        // M3: money delta 走 update_character + metadata.delta=true（M2 Task 9 真加法承接 #20）
        patches.push({
          op: 'update_character',
          target: `characters.${key}`,
          value: { money: amount },
          metadata: { source: 'vars_update', path, delta: true },
        });
        break;
      default:
        patches.push({
          op: 'update_character',
          target: `characters.${key}`,
          value: { [path]: amount },
          metadata: { source: 'vars_update', path, delta: true },
        });
    }
  }

  // --- characters.add → add_status_effect/add_skill/add_item（M3: 零 id 生成，装备单 patch） ---
  // M4: 名字寻址唯一化（铁律1）— key 只认 name，缺 name 跳过
  for (const a of parsed.characters?.add ?? []) {
    const key = a.name;
    if (!key) {
      console.warn('[Orchestrator] characters.add 条目缺 name，跳过');
      continue;
    }
    const { path, value } = a;
    switch (path) {
      case 'statusEffects':
        patches.push({
          op: 'add_status_effect',
          target: `characters.${key}`,
          value,
          metadata: { source: 'vars_update' },
        });
        break;
      case 'skills':
        patches.push({
          op: 'add_skill',
          target: `characters.${key}`,
          value,
          metadata: { source: 'vars_update' },
        });
        break;
      case 'inventory': {
        // M3: 单 add_item，无 id 生成，equippedSlot 直传
        patches.push({
          op: 'add_item',
          target: `characters.${key}`,
          value: {
            name: value?.name ?? '未知物品',
            description: value?.description,
            quantity: value?.quantity ?? 1,
            type: value?.type,
            rarity: value?.rarity,
            equippedSlot: value?.equippedSlot ?? null,
          },
          metadata: { source: 'vars_update', path, add: true },
        });
        break;
      }
      case 'equipment': {
        // M3: 装备=带 equippedSlot 的物品，单 add_item 落库（不再 add_item+equip_item 两步）
        // M4: itemId 过渡读拆除（原 itemId 语义已废，只认 name）
        const eqName = value?.name ?? '未知装备';
        const eqSlot = normalizeSlot(value?.slot ?? '');
        patches.push({
          op: 'add_item',
          target: `characters.${key}`,
          value: {
            name: eqName,
            description: value?.description,
            quantity: 1,
            type: '装备',
            rarity: value?.rarity,
            equippedSlot: eqSlot, // null = 槽位不可识别，留背包
          },
          metadata: { source: 'vars_update', path, add: true },
        });
        break;
      }
      default:
        patches.push({
          op: 'update_character',
          target: `characters.${key}`,
          value: { [path]: value },
          metadata: { source: 'vars_update', path, add: true },
        });
    }
  }

  // --- characters.remove → remove_status_effect/unequip_item/remove_skill（M3: 统一 {name} 对象形态） ---
  // M4: 名字寻址唯一化（铁律1）— key 只认 name，缺 name 跳过
  for (const rm of parsed.characters?.remove ?? []) {
    const key = rm.name;
    if (!key) {
      console.warn('[Orchestrator] characters.remove 条目缺 name，跳过');
      continue;
    }
    const { path, target: rmTarget } = rm;
    switch (path) {
      case 'statusEffects':
        patches.push({
          op: 'remove_status_effect',
          target: `characters.${key}`,
          value: { name: rmTarget },
          metadata: { source: 'vars_update' },
        });
        break;
      case 'equipment':
        patches.push({
          op: 'unequip_item',
          target: `characters.${key}`,
          value: { name: rmTarget },
          metadata: { source: 'vars_update' },
        });
        break;
      case 'skills':
        patches.push({
          op: 'remove_skill',
          target: `characters.${key}`,
          value: { name: rmTarget },
          metadata: { source: 'vars_update', path, remove: true },
        });
        break;
    }
  }

  // --- items.consume → remove_item ---
  for (const c of parsed.items?.consume ?? []) {
    patches.push({
      op: 'remove_item',
      target: `characters.${c.owner}`,
      value: { name: c.target, quantity: c.quantity ?? 1 },
      metadata: { source: 'vars_update', operation: 'consume' },
    });
  }

  // --- items.equip → equip_item ---
  for (const e of parsed.items?.equip ?? []) {
    // M2: e.target 本来就是物品名 → {name, slot}（杀 #23）// M3 重写
    patches.push({
      op: 'equip_item',
      target: `characters.${e.owner}`,
      value: { name: e.target, slot: e.slot },
      metadata: { source: 'vars_update', operation: 'equip' },
    });
  }

  // --- items.unequip → unequip_item ---
  for (const u of parsed.items?.unequip ?? []) {
    // M2: u.target 是物品名 → {name} 对象形态（applyUnequipItem 按名脱）// M3 重写
    patches.push({
      op: 'unequip_item',
      target: `characters.${u.owner}`,
      value: { name: u.target },
      metadata: { source: 'vars_update', operation: 'unequip' },
    });
  }

  // --- items.transfer → transfer_item（M3: 单 patch 原子转移，杀 #5 transfer 断裂） ---
  for (const t of parsed.items?.transfer ?? []) {
    patches.push({
      op: 'transfer_item',
      target: `characters.${t.from}`,
      value: { name: t.target, to: t.to, quantity: t.quantity ?? 1 },
      metadata: { source: 'vars_update', operation: 'transfer' },
    });
  }

  // --- items.modify → update_item ---
  for (const m of parsed.items?.modify ?? []) {
    // M2: itemUpdate 假字段被 update_character 白名单拒 → 改专用 op update_item {name, changes} // M3 重写
    // changes 里的 name/quantity/id 是 update_item 禁改键 → 剥离（防 AI 夹带触发 throw）
    const { name: _n, quantity: _q, id: _i, ...changes } = (m.changes ?? {}) as Record<string, any>;
    patches.push({
      op: 'update_item',
      target: `characters.${m.owner}`,
      value: { name: m.target, changes },
      metadata: { source: 'vars_update', operation: 'modify' },
    });
  }

  // --- affections.set/delta → set_affection/delta_affection（M5: #15 #44 好感度接线，写 profile.affections） ---
  // M4 prompt 教的键格式: {"affections":{"set":[{name,value}],"delta":[{name,amount}]}}
  for (const s of parsed.affections?.set ?? []) {
    if (!s.name) {
      console.warn('[Orchestrator] affections.set 条目缺 name，跳过');
      continue;
    }
    patches.push({
      op: 'set_affection',
      target: `affections.${s.name}`,
      value: s.value,
      metadata: { source: 'vars_update' },
    });
  }
  for (const d of parsed.affections?.delta ?? []) {
    if (!d.name) {
      console.warn('[Orchestrator] affections.delta 条目缺 name，跳过');
      continue;
    }
    patches.push({
      op: 'delta_affection',
      target: `affections.${d.name}`,
      amount: d.amount,
      metadata: { source: 'vars_update' },
    });
  }

  return patches;
}

/** vars_update 的 `<json>.quests` → 任务补丁（Phase 10g） */
export function buildQuestPatches(quests: Record<string, any>): StatePatch[] {
  const patches: StatePatch[] = [];

  for (const q of quests.upsert ?? []) {
    const { name, ...questFields } = q;
    if (!name) continue;
    patches.push({
      op: 'update_quest',
      target: `quests.${name}`,
      value: { name, ...questFields },
      metadata: { source: 'vars_update', operation: 'upsert' },
    });
  }

  for (const q of quests.remove ?? []) {
    patches.push({
      op: 'remove_quest',
      target: `quests.${q.name}`,
      value: { name: q.name }, // #40: 形态统一为 {name} 对象
      metadata: { source: 'vars_update', operation: 'remove' },
    });
  }

  return patches;
}
