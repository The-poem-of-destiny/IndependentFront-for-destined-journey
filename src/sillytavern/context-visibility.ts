/**
 * Phase 8: Variable Zone 可见性系统 — 核心模块
 *
 * 职责:
 * 1. 定义 11 Agent × 8 Zone 的可见性矩阵（单一真相来源）
 * 2. buildZoneContext() — 将 AgentContext 扁平字段组装为 8 个 VariableZone
 * 3. filterZoneContent() — 按可见性级别过滤/格式化 zone 内容
 * 4. buildZoneSection() — 为指定 Agent 构建注入 prompt 的 zone 段落
 *
 * 设计原则:
 * - 可见性矩阵是设计时决策，非运行时配置（不需要用户可调）
 * - FULL/NARRATIVE/SUMMARY/KEYS/NONE 五个级别，一个矩阵 + 四个格式化函数
 * - 向后兼容：ctx.zones 未定义时 buildZoneSection 返回空，调用方回退到旧 variableContext()
 */

import type {
  VisibilityLevel, ZoneId, ZoneVisibilityMatrix,
  VariableZone, ZoneConfig, AgentContext, CharacterState,
} from './types';

// ═══════════════════════════════════════════════════════════
// Group A: 可见性矩阵
// ═══════════════════════════════════════════════════════════

export const ZONE_IDS: ZoneId[] = [
  'memory', 'npc', 'world', 'quest', 'craft', 'combat', 'outline', 'variable',
];

/** 11 Agent + 2 v3 兼容 stub 的完整可见性矩阵 */
export const VISIBILITY_MATRIX: Record<string, ZoneVisibilityMatrix> = {
  memory_recall: {
    memory: 'FULL', npc: 'KEYS', world: 'KEYS', quest: 'KEYS',
    craft: 'NONE', combat: 'NONE', outline: 'NONE', variable: 'NONE',
  },
  plot_pre_check: {
    memory: 'SUMMARY', npc: 'FULL', world: 'FULL', quest: 'FULL',
    craft: 'NONE', combat: 'NONE', outline: 'FULL', variable: 'KEYS',
  },
  story: {
    memory: 'SUMMARY', npc: 'NARRATIVE', world: 'FULL', quest: 'SUMMARY',
    craft: 'SUMMARY', combat: 'FULL', outline: 'SUMMARY', variable: 'NONE',
  },
  vars_update: {
    memory: 'NONE', npc: 'KEYS', world: 'FULL', quest: 'NONE',
    craft: 'KEYS', combat: 'KEYS', outline: 'NONE', variable: 'FULL',
  },
  char_update: {
    memory: 'NONE', npc: 'FULL', world: 'FULL', quest: 'NONE',
    craft: 'KEYS', combat: 'FULL', outline: 'NONE', variable: 'NONE',
  },
  memory_summary: {
    memory: 'SUMMARY', npc: 'KEYS', world: 'SUMMARY', quest: 'KEYS',
    craft: 'NONE', combat: 'KEYS', outline: 'NONE', variable: 'NONE',
  },
  plot_post_check: {
    memory: 'SUMMARY', npc: 'SUMMARY', world: 'FULL', quest: 'FULL',
    craft: 'NONE', combat: 'SUMMARY', outline: 'FULL', variable: 'NONE',
  },
  plot_outline: {
    memory: 'NONE', npc: 'FULL', world: 'FULL', quest: 'KEYS',
    craft: 'NONE', combat: 'NONE', outline: 'FULL', variable: 'NONE',
  },
  craft_gen: {
    memory: 'NONE', npc: 'SUMMARY', world: 'FULL', quest: 'NONE',
    craft: 'FULL', combat: 'NONE', outline: 'NONE', variable: 'KEYS',
  },
  char_gen: {
    memory: 'NONE', npc: 'KEYS', world: 'FULL', quest: 'NONE',
    craft: 'NONE', combat: 'NONE', outline: 'NONE', variable: 'SUMMARY',
  },
  item_gen: {
    memory: 'NONE', npc: 'KEYS', world: 'FULL', quest: 'NONE',
    craft: 'NONE', combat: 'NONE', outline: 'NONE', variable: 'KEYS',
  },
  // v3 兼容 stub — 最小可见性
  plot_check: {
    memory: 'NONE', npc: 'NONE', world: 'NONE', quest: 'NONE',
    craft: 'NONE', combat: 'NONE', outline: 'NONE', variable: 'NONE',
  },
  plot_correct: {
    memory: 'NONE', npc: 'NONE', world: 'NONE', quest: 'NONE',
    craft: 'NONE', combat: 'NONE', outline: 'NONE', variable: 'NONE',
  },
};

const DEFAULT_VISIBILITY: ZoneVisibilityMatrix = {
  memory: 'NONE', npc: 'NONE', world: 'NONE', quest: 'NONE',
  craft: 'NONE', combat: 'NONE', outline: 'NONE', variable: 'NONE',
};

/** 获取指定 Agent 的 Zone 可见性矩阵 */
export function getAgentZoneVisibility(agentId: string): ZoneVisibilityMatrix {
  return VISIBILITY_MATRIX[agentId] ?? DEFAULT_VISIBILITY;
}

// ═══════════════════════════════════════════════════════════
// Group B: Zone 组装 — 平面字段 → 8 Zone 字典
// ═══════════════════════════════════════════════════════════

/** 将 AgentContext 中的扁平字段映射为 8 个 VariableZone */
export function buildZoneContext(ctx: AgentContext): Record<ZoneId, VariableZone> {
  const zones: Record<string, VariableZone> = {};

  // --- memory zone ---
  zones.memory = {
    config: { limit: 50, injectAs: 'list' },
    visibility: [],
    content: {
      entries: (ctx.memories ?? []).map(m => ({
        id: m.id,
        content: m.content,
        hiddenLine: m.hiddenLine,
        keywords: m.keywords,
        importance: m.importance,
        timeRange: m.timeRange,
        relatedCharacterIds: m.relatedCharacterIds,
        relatedPlotEventId: m.relatedPlotEventId,
      })),
    },
  };

  // --- npc zone ---
  zones.npc = {
    config: { injectAs: 'list' },
    visibility: [],
    content: {
      characters: ctx.characters ?? [],
    },
  };

  // --- world zone ---
  const worldKeys = new Set([
    '时间', '位置', '天气', '季节', '月相', '纪元',
    'time', 'location', 'weather', 'season', 'moonPhase', 'era',
    'timeOfDay', 'currentRegion', 'currentFaction', 'dangerLevel',
  ]);
  const worldContent: Record<string, any> = {};
  for (const k of Object.keys(ctx.variables ?? {})) {
    if (worldKeys.has(k)) worldContent[k] = ctx.variables[k];
  }
  zones.world = {
    config: { injectAs: 'json' },
    visibility: [],
    content: worldContent,
  };

  // --- quest zone ---
  zones.quest = {
    config: { injectAs: 'list' },
    visibility: [],
    content: {
      events: (ctx.plotEvents ?? []).map(e => ({
        id: e.id,
        title: e.title,
        description: e.description,
        status: e.status,
        triggerCondition: e.triggerCondition,
        chapterGoal: e.description?.slice(0, 100),
        depth: e.depth,
        parentId: e.parentId,
        relatedCharacterIds: e.relatedCharacterIds,
      })),
    },
  };

  // --- craft zone ---
  // 占位 — 由 craft-resolver 在运行时填充
  zones.craft = {
    config: { limit: 10, injectAs: 'summary' },
    visibility: [],
    content: { projects: (ctx as any)._craftProjects ?? [] },
  };

  // --- combat zone ---
  // 占位 — 由 combat-resolver 在运行时填充
  zones.combat = {
    config: { injectAs: 'summary' },
    visibility: [],
    content: { active: (ctx as any)._activeCombat ?? null },
  };

  // --- outline zone ---
  // 占位 — 由 plot-engine 在运行时填充
  zones.outline = {
    config: { injectAs: 'summary' },
    visibility: [],
    content: { outline: (ctx as any)._plotOutline ?? null, chapters: [] },
  };

  // --- variable zone ---
  const sysVars: Record<string, any> = {};
  const userVars: Record<string, any> = {};
  for (const k of Object.keys(ctx.variables ?? {})) {
    if (k.startsWith('sys.') || k.startsWith('user.')) {
      if (k.startsWith('user.')) userVars[k] = ctx.variables[k];
      else sysVars[k] = ctx.variables[k];
    } else if (!worldKeys.has(k)) {
      // 不是世界键的自由变量 → 进合适的桶
      userVars[k] = ctx.variables[k];
    }
  }
  zones.variable = {
    config: { injectAs: 'json' },
    visibility: [],
    content: { sys: sysVars, user: userVars },
  };

  return zones as Record<ZoneId, VariableZone>;
}

// ═══════════════════════════════════════════════════════════
// Group C: Zone 过滤 — 可见性级别分发
// ═══════════════════════════════════════════════════════════

/**
 * 按可见性级别过滤/格式化一个 zone 的内容。
 * @returns 格式化后的字符串，visibility === 'NONE' 时返回 null
 */
export function filterZoneContent(
  zoneId: ZoneId,
  content: Record<string, any>,
  visibility: VisibilityLevel,
  _agentId: string,
  ctx?: AgentContext,
): string | null {
  switch (visibility) {
    case 'NONE': return null;
    case 'FULL': return formatZoneFull(zoneId, content);
    case 'NARRATIVE': return formatZoneNarrative(zoneId, content, ctx);
    case 'SUMMARY': return formatZoneSummary(zoneId, content);
    case 'KEYS': return formatZoneKeys(zoneId, content);
    default: return null;
  }
}

// ═══════════════════════════════════════════════════════════
// Group D: 四个格式化级别
// ═══════════════════════════════════════════════════════════

// ========== FULL ==========

function formatZoneFull(zoneId: ZoneId, content: Record<string, any>): string {
  const zoneHeaders: Record<string, string> = {
    memory: '📜 记忆库 (完整)',
    npc: '👥 角色 (完整)',
    world: '🌍 世界状态 (完整)',
    quest: '📖 剧情事件 (完整)',
    craft: '⚒️ 制作项目 (完整)',
    combat: '⚔️ 战斗状态 (完整)',
    outline: '📚 剧情大纲 (完整)',
    variable: '📦 自由变量 (完整)',
  };
  const header = zoneHeaders[zoneId] ?? zoneId;
  return `${header}\n${JSON.stringify(content, null, 2)}`;
}

// ========== NARRATIVE (story Agent 专用) ==========

/** NARRATIVE 级别 — story Agent 专用，给足叙事信息但剥离数值设计细节 */
function formatZoneNarrative(
  zoneId: ZoneId,
  content: Record<string, any>,
  ctx?: AgentContext,
): string {
  if (zoneId !== 'npc') {
    // 非 npc zone 走 FULL 路径
    return formatZoneFull(zoneId, content);
  }

  const characters: CharacterState[] = content.characters ?? [];
  if (characters.length === 0) return '';

  const parts: string[] = ['## 👥 在场角色\n'];

  for (const char of characters) {
    parts.push(formatCharacterNarrative(char));
    parts.push(''); // blank line between characters
  }

  parts.push(
    '> ⚠️ 以上角色的装备精确数值、技能资源消耗与回合限制、物品效果数值均已剥离。',
    '> 请用自然语言描述效果——描写剑刃的寒光而非其攻击加值，描述伤势的疼痛而非HP数值。',
  );

  return parts.join('\n');
}

/** 格式化单个角色为 NARRATIVE 视图 */
function formatCharacterNarrative(char: CharacterState): string {
  const cf = char.customFields ?? {};
  const typeLabel = char.type === 'player' ? '你' : (char.type === 'monster' ? '敌人' : char.name);

  const lines: string[] = [];

  // 基础信息行
  const tierLabel = `T${char.tier} ${char.tierName || ''}`;
  const occupationStr = char.occupation?.length ? ` · 职业: ${char.occupation.join(', ')}` : '';
  const identityStr = char.identity?.length ? `  身份: ${char.identity.join(', ')}${occupationStr}` : '';
  const backgroundStr = cf.background ? `  背景: ${cf.background}` : '';
  const personalityStr = cf.personality ? `  性格: ${cf.personality}` : '';
  const appearanceStr = cf.appearance ? `  外貌: ${cf.appearance}` : '';

  lines.push(`[${typeLabel}] ${char.name} · ${char.race} · ${tierLabel} · Lv.${char.level}`);

  if (appearanceStr) lines.push(appearanceStr);
  if (identityStr) lines.push(identityStr);
  if (backgroundStr) lines.push(backgroundStr);
  if (personalityStr) lines.push(personalityStr);

  // 五维
  const attr = char.attributes;
  lines.push(`  五维: 力量${attr.str} 敏捷${attr.dex} 体质${attr.con} 智力${attr.int} 精神${attr.spi}`);

  // 资源
  lines.push(`  HP: ${char.hp}/${char.maxHp}  MP: ${char.mp}/${char.maxMp}  SP: ${char.sp}/${char.maxSp}`);

  // 位置 & 状态
  const statusStr = char.statusEffects?.length
    ? ` · 状态效果: ${char.statusEffects.map(s => {
        const effDesc = s.effectDescriptions
          ? ` [${Object.entries(s.effectDescriptions).map(([k, v]) => `${k}: ${v}`).join(', ')}]`
          : '';
        return `${s.name} — ${s.description || ''}${effDesc}${s.remainingTime != null ? ` (剩余${s.remainingTime}${s.timeUnit || '分钟'})` : ''}`;
      }).join('; ')}`
    : ' · 状态效果: 无';
  lines.push(`  位置: ${char.location || '未知'} · 状态: ${char.currentAction || '待机中'}${statusStr}`);

  // 金钱
  if (char.money != null) lines.push(`  金钱: ${char.money}G`);

  // 装备 — 剥离 stats 数值，保留 effects 描述
  if (char.equipment?.length) {
    lines.push('');
    lines.push('  装备:');
    for (const eq of char.equipment) {
      const desc = eq.description ? ` — ${eq.description}` : '';
      const effs = eq.effects ? ` [${Object.entries(eq.effects).map(([k, v]) => `${k}: ${v}`).join(', ')}]` : '';
      lines.push(`    [${eq.slot}] ${eq.name}${desc}${effs}`);
      // 不显示 eq.stats (数值设计)
      // 不显示 eq.scripts (JS 代码)
    }
  }

  // 技能 — 剥离 cost/cooldown，保留 effects 描述
  if (char.skills?.length) {
    lines.push('');
    lines.push('  技能:');
    for (const sk of char.skills) {
      const typeLabel = sk.type === 'active' ? '主动' : '被动';
      const effs = sk.effects ? ` [${Object.entries(sk.effects).map(([k, v]) => `${k}: ${v}`).join(', ')}]` : '';
      lines.push(`    [${typeLabel}] ${sk.name} — ${sk.description || ''}${effs}`);
      // 不显示 sk.cost (SP消耗:15)
      // 不显示 sk.cooldown (冷却:3回合)
      // 不显示 sk.scripts (JS 代码)
    }
  }

  // 背包 — 剥离 stats，保留 effects 描述
  if (char.inventory?.length) {
    const items = char.inventory.map(item => {
      const rarityStr = item.rarity ? `, ${item.rarity}` : '';
      const typeStr = item.type ? ` (${item.type}${rarityStr})` : '';
      const desc = item.description ? ` — ${item.description}` : '';
      const effs = item.effects ? ` [${Object.entries(item.effects).map(([k, v]) => `${k}: ${v}`).join(', ')}]` : '';
      return `    ${item.name} ×${item.quantity}${typeStr}${desc}${effs}`;
    });
    lines.push('');
    lines.push('  背包:');
    lines.push(...items);
    // 不显示 item.data.stats (数值效果)
    // 不显示 item.scripts (JS 代码)
  }

  // 登神长阶 — 仅 enabled + 要素/权能/法则名称列表
  if (char.ascension?.enabled) {
    lines.push('');
    lines.push('  登神长阶:');
    const elementNames = Object.keys(char.ascension.elements ?? {});
    const authorityNames = Object.keys(char.ascension.authority ?? {});
    const lawNames = Object.keys(char.ascension.law ?? {});
    if (elementNames.length) lines.push(`    要素: ${elementNames.join(', ')}`);
    if (authorityNames.length) lines.push(`    权能: ${authorityNames.join(', ')}`);
    if (lawNames.length) lines.push(`    法则: ${lawNames.join(', ')}`);
    // 不展开 elements/authority/law 内部的 scripts
  }

  // 关系 — 仅在场角色
  const relationships = cf.relationships as Record<string, any> | undefined;
  if (relationships && Object.keys(relationships).length > 0) {
    lines.push('');
    lines.push('  关系:');
    for (const [targetId, rel] of Object.entries(relationships)) {
      if (typeof rel === 'object' && rel !== null) {
        const affinity = rel.affinity != null ? ` (好感度:${rel.affinity})` : '';
        const bond = rel.bond ? `, ${rel.bond}` : '';
        lines.push(`    ${rel.name ?? targetId} — ${rel.status ?? '中立'}${affinity}${bond}`);
      } else {
        lines.push(`    ${targetId} — ${rel}`);
      }
    }
  }

  return lines.join('\n');
}

// ========== SUMMARY ==========

function formatZoneSummary(zoneId: ZoneId, content: Record<string, any>): string {
  switch (zoneId) {
    case 'memory':
      return formatMemorySummary(content);
    case 'npc':
      return formatNpcSummary(content);
    case 'world':
      // world zone is small, FULL ≈ SUMMARY
      return formatZoneFull(zoneId, content);
    case 'quest':
      return formatQuestSummary(content);
    case 'craft':
      return formatCraftSummary(content);
    case 'combat':
      return formatCombatSummary(content);
    case 'outline':
      return formatOutlineSummary(content);
    case 'variable':
      return formatVariableSummary(content);
    default:
      return '';
  }
}

function formatMemorySummary(content: Record<string, any>): string {
  const entries = content.entries ?? [];
  if (entries.length === 0) return '';
  const lines = ['📜 相关记忆'];
  for (const m of entries.slice(0, 10)) {
    const timeStr = m.timeRange ? `${m.timeRange.start}~${m.timeRange.end}` : '';
    const contentPreview = typeof m.content === 'string' ? m.content.slice(0, 200) : '';
    lines.push(`[${m.id}] ${timeStr} | 重要度:${m.importance}`);
    lines.push(`关键词: ${(m.keywords ?? []).join(', ')}`);
    if (contentPreview) lines.push(`正文: ${contentPreview}...`);
    lines.push('');
  }
  // 不显示 hiddenLine
  return lines.join('\n');
}

function formatNpcSummary(content: Record<string, any>): string {
  const characters = content.characters ?? [];
  if (characters.length === 0) return '';
  const lines = ['## 👥 在场角色 (摘要)'];
  for (const char of characters) {
    const statusEffects = char.statusEffects?.map((s: any) =>
      `${s.name}(${s.remainingTime != null ? `剩余${s.remainingTime}${s.timeUnit || '分钟'}` : '永久'})`,
    ).join(', ') || '无';
    lines.push(
      `[${char.type === 'player' ? '你' : char.name}] ${char.race} · T${char.tier} ${char.tierName || ''} · Lv.${char.level}`,
      `  HP: ${char.hp}/${char.maxHp}  MP: ${char.mp}/${char.maxMp}  SP: ${char.sp}/${char.maxSp}`,
      `  位置: ${char.location || '未知'} · 状态: ${char.currentAction || '待机中'}`,
      `  状态效果: ${statusEffects}`,
    );
  }
  // 排除: attributes, equipment详情, skills详情, inventory详情, ascension, money
  return lines.join('\n');
}

function formatQuestSummary(content: Record<string, any>): string {
  const events = (content.events ?? []).filter((e: any) => e.status === 'active');
  if (events.length === 0) return '';
  const lines = ['📖 活跃剧情'];
  for (const e of events) {
    const chapterGoal = e.chapterGoal ?? e.description?.slice(0, 100);
    lines.push(`[${e.id}] ${e.title} (${e.status})`);
    if (chapterGoal) lines.push(`  目标: ${chapterGoal}`);
  }
  // 排除 pending 事件、triggerCondition
  return lines.join('\n');
}

function formatCraftSummary(content: Record<string, any>): string {
  const projects = (content.projects ?? []).filter(
    (p: any) => p.status === 'completed' || p.status === 'in_progress',
  );
  if (projects.length === 0) return '';
  const lines = ['⚒️ 制作项目'];
  for (const p of projects) {
    lines.push(`[${p.id ?? ''}] ${p.product ?? ''} — ${p.quality ?? ''} (${p.status})`);
    if (p.resultNarrative) lines.push(`  ${p.resultNarrative}`);
  }
  return lines.join('\n');
}

function formatCombatSummary(content: Record<string, any>): string {
  const active = content.active;
  if (!active) return '';
  const lines = ['⚔️ 战斗状态'];
  lines.push(`战斗ID: ${active.combatId ?? ''} | 类型: ${active.combatType ?? ''} | 状态: ${active.status ?? ''}`);
  if (active.participants?.length) {
    lines.push('参战方:');
    for (const p of active.participants) {
      lines.push(`  [${p.side}] ${p.name} — HP: ${p.hp}/${p.maxHp}`);
    }
  }
  if (active.summary) lines.push(`摘要: ${active.summary}`);
  return lines.join('\n');
}

function formatOutlineSummary(content: Record<string, any>): string {
  const outline = content.outline;
  const chapters = content.chapters ?? [];
  if (!outline && chapters.length === 0) return '';

  // Only show current chapter's title + ~100 char goal
  const currentChapter = chapters.find((c: any) => c.status === 'active' || c.status === 'in_progress')
    ?? chapters[0];
  if (currentChapter) {
    const lines = ['📚 剧情大纲 (当前章节)'];
    lines.push(`当前进度: ${currentChapter.title ?? ''}`);
    if (currentChapter.summary) lines.push(`目标: ${currentChapter.summary.slice(0, 100)}`);
    return lines.join('\n');
  }
  return '';
}

function formatVariableSummary(content: Record<string, any>): string {
  const sys = content.sys ?? {};
  const factionKeys = Object.keys(sys).filter(k =>
    k.startsWith('sys.faction_standing') || k.startsWith('sys.region_state'),
  );
  if (factionKeys.length === 0) return '';
  const lines = ['📦 世界观变量'];
  for (const k of factionKeys) {
    lines.push(`  ${k}: ${JSON.stringify(sys[k])}`);
  }
  return lines.join('\n');
}

// ========== KEYS ==========

function formatZoneKeys(zoneId: ZoneId, content: Record<string, any>): string {
  switch (zoneId) {
    case 'memory':
      return formatMemoryKeys(content);
    case 'npc':
      return formatNpcKeys(content);
    case 'world':
      return formatWorldKeys(content);
    case 'quest':
      return formatQuestKeys(content);
    case 'craft':
      return formatCraftKeys(content);
    case 'combat':
      return formatCombatKeys(content);
    case 'outline':
      return formatOutlineKeys(content);
    case 'variable':
      return formatVariableKeys(content);
    default:
      return '';
  }
}

function formatMemoryKeys(content: Record<string, any>): string {
  const entries = content.entries ?? [];
  if (entries.length === 0) return '';
  const lines = ['📜 记忆索引'];
  for (const m of entries) {
    lines.push(`[${m.id}] 重要度:${m.importance} | 关键词: ${(m.keywords ?? []).join(', ')}`);
  }
  return lines.join('\n');
}

function formatNpcKeys(content: Record<string, any>): string {
  const characters = content.characters ?? [];
  if (characters.length === 0) return '';
  return [
    '=== 已有角色 (npc zone — KEYS only) ===',
    '',
    '以下角色已存在于当前存档。新生成角色名必须与此列表无冲突。',
    '',
    '| ID | Name | Race | Type | Tier | Location |',
    '|----|------|------|------|------|----------|',
    ...characters.map((c: CharacterState) =>
      `| ${c.id} | ${c.name} | ${c.race} | ${c.type} | T${c.tier} | ${c.location || '未知'} |`,
    ),
    '',
    '注意: 上述角色的五维/技能/装备/背包已被安全屏蔽。此列表仅用于重名检查和关系判断。',
  ].join('\n');
}

function formatWorldKeys(content: Record<string, any>): string {
  const time = content.time ?? content['时间'] ?? '';
  const location = content.location ?? content['位置'] ?? '';
  return `🌍 当前世界: 时间=${time}  位置=${location}`;
}

function formatQuestKeys(content: Record<string, any>): string {
  const events = content.events ?? [];
  if (events.length === 0) return '';
  const lines = ['📖 剧情事件索引'];
  for (const e of events) {
    lines.push(`[${e.id}] ${e.title} | ${e.status}`);
  }
  return lines.join('\n');
}

function formatCraftKeys(content: Record<string, any>): string {
  const projects = content.projects ?? [];
  if (projects.length === 0) return '';
  const lines = ['⚒️ 制作项目索引'];
  for (const p of projects) {
    lines.push(`[${p.id ?? ''}] ${p.product ?? ''} | ${p.status ?? ''}`);
  }
  return lines.join('\n');
}

function formatCombatKeys(content: Record<string, any>): string {
  const active = content.active;
  if (!active) return '';
  const participantNames = (active.participants ?? []).map((p: any) => p.name).join(', ');
  return `⚔️ 活跃战斗: ${active.combatId ?? ''} | 状态:${active.status ?? ''} | 参战方: ${participantNames}`;
}

function formatOutlineKeys(content: Record<string, any>): string {
  const outline = content.outline;
  const chapters = content.chapters ?? [];
  if (chapters.length === 0) return '';
  const lines = ['📚 大纲索引'];
  if (outline?.version != null) lines.push(`版本: v${outline.version}`);
  for (const c of chapters) {
    lines.push(`  [${c.title ?? ''}] ${c.summary?.slice(0, 60) ?? ''}`);
  }
  return lines.join('\n');
}

function formatVariableKeys(content: Record<string, any>): string {
  const sys = content.sys ?? {};
  const user = content.user ?? {};
  const allKeys = [...Object.keys(sys), ...Object.keys(user)];
  if (allKeys.length === 0) return '';
  return `📦 自由变量索引: ${allKeys.join(', ')}`;
}

// ═══════════════════════════════════════════════════════════
// Group E: Zone Section 组装 — 替代 tpl.variableContext()
// ═══════════════════════════════════════════════════════════

/** 包装一个 zone 段落 */
function wrapZoneSection(zoneId: string, level: string, body: string): string {
  return `\n--- ${zoneId} (${level}) ---\n${body}`;
}

/**
 * 为指定 Agent 构建 zone 注入段落。
 * 如果 ctx.zones 未定义，返回空字符串（调用方应回退到旧的 variableContext()）。
 */
export function buildZoneSection(
  agentId: string,
  ctx: AgentContext,
): string {
  if (!ctx.zones) return '';

  const visibility = getAgentZoneVisibility(agentId);
  const sections: string[] = [];
  const headNote = ctx.targetCharacterId
    ? `> 目标角色: ${ctx.targetCharacterId}\n`
    : '';

  for (const zoneId of ZONE_IDS) {
    const level = visibility[zoneId];
    if (level === 'NONE') continue;

    const zone = ctx.zones[zoneId];
    if (!zone) continue;

    // char_update per-call 过滤
    let filteredContent = zone.content;
    if (zoneId === 'npc' && agentId === 'char_update' && ctx.targetCharacterId) {
      filteredContent = filterNpcForTarget(zone.content, ctx.targetCharacterId);
      const formatted = filterZoneContent(zoneId, filteredContent, 'FULL', agentId, ctx);
      if (formatted) {
        sections.push(wrapZoneSection(zoneId, 'FULL (目标角色)',
          formatNpcKeys({ characters: filterNonTargets(zone.content, ctx.targetCharacterId) }) +
          '\n\n' + formatted));
      }
      continue;
    }

    const formatted = filterZoneContent(zoneId, filteredContent, level, agentId, ctx);
    if (formatted) {
      sections.push(wrapZoneSection(zoneId, level, formatted));
    }
  }

  return headNote + sections.join('\n');
}

// ═══════════════════════════════════════════════════════════
// Group F: char_update 专用 per-call 过滤
// ═══════════════════════════════════════════════════════════

/** 从 npc zone 中提取目标角色的内容（用于 FULL 格式化） */
function filterNpcForTarget(
  content: Record<string, any>,
  targetId: string,
): Record<string, any> {
  const allChars = content.characters ?? [];
  const target = allChars.find((c: CharacterState) => c.id === targetId);
  return { characters: target ? [target] : [] };
}

/** 从 npc zone 中提取非目标角色的列表（用于 KEYS 显示） */
function filterNonTargets(
  content: Record<string, any>,
  targetId: string,
): CharacterState[] {
  const allChars = content.characters ?? [];
  return allChars.filter((c: CharacterState) => c.id !== targetId);
}
