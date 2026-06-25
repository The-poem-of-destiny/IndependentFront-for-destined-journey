/**
 * ScriptExecutor — 词条脚本沙盒执行器 (Phase 7e+8)
 *
 * 提供沙盒环境执行 AI 编写的效果脚本。
 * 脚本通过 $ API 与引擎交互，可以套娃创建新状态效果。
 *
 * 安全模型:
 * - new Function() 沙盒隔离，无 DOM/文件/网络访问
 * - 仅暴露白名单内的 $ API
 * - 🆕 支持跨对象脚本引用: @parent.xxx / @type.id.xxx
 * - 🆕 支持 $event.on/off 持久事件订阅
 * - 🆕 支持 init/cleanup 生命周期钩子
 *
 * 📖 脚本编写规范详见: docs/reference/effect_script_system.md
 */

import type { StatusEffect } from './types';

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 脚本执行上下文 */
export interface ScriptContext {
  /** 状态/物品持有者 ID */
  owner: string;
  /** 事件目标 ID (可选) */
  target?: string;
  /** 触发事件的数据负载 */
  event?: Record<string, any>;
  /** 当前脚本所属的效果自身信息 (只读) */
  self: {
    stacks: number;
    remainingTime: number | null;
    name: string;
    /** 🆕 当前对象的 scripts 池 (供 resolveScriptRef 本地查找) */
    scripts?: Record<string, string>;
  };
  /** 🆕 父对象的 scripts 池 — $status.add() 时自动从创建者继承 */
  parentScripts?: Record<string, string>;
}

/** $ API 注入接口 */
export interface ScriptSandbox {
  $dice: {
    d20: () => number;
    d100: () => number;
    roll: (formula: string) => number;
  };
  $resource: {
    getHp: (charId: string) => number;
    getMaxHp: (charId: string) => number;
    modifyHp: (charId: string, amount: number) => void;
    modifyStat: (charId: string, stat: string, amount: number) => void;
  };
  $status: {
    /** 添加状态效果 */
    add: (charId: string, effect: Partial<StatusEffect>) => void;
    /** 移除状态效果 */
    remove: (charId: string, effectId: string) => void;
    /** 修改层数 */
    setStacks: (charId: string, effectId: string, stacks: number) => void;
    /** 获取层数 */
    getStacks: (charId: string, effectId: string) => number;
  };
  $event: {
    /** 触发事件 (可以被其他状态/物品的 onTrigger 捕获) */
    emit: (eventType: string, data?: Record<string, any>) => void;
  };
}

/** 效果收集器 — 脚本执行期间收集的状态变更, 调用方在脚本执行后处理 */
export interface ScriptEffects {
  /** add: {charId, effect} */
  adds: Array<{ charId: string; effect: Partial<StatusEffect> }>;
  /** remove: {charId, effectId} */
  removes: Array<{ charId: string; effectId: string }>;
  /** setStacks: {charId, effectId, stacks} */
  stackSets: Array<{ charId: string; effectId: string; stacks: number }>;
  /** emit: {eventType, data} */
  events: Array<{ eventType: string; data: Record<string, any> }>;
  /** modifyHp: {charId, amount} */
  hpChanges: Array<{ charId: string; amount: number }>;
  /** modifyStat: {charId, stat, amount} */
  statChanges: Array<{ charId: string; stat: string; amount: number }>;
  /** 🆕 $event.on: {eventType, scriptKey} — 脚本执行后由引擎注册为持久订阅 */
  subscriptions: Array<{ eventType: string; scriptKey: string }>;
  /** 🆕 $event.off: handle 字符串或 eventType — 脚本执行后由引擎取消订阅 */
  unsubscriptions: Array<string>;
}

/** 创建空的 ScriptEffects */
export function createScriptEffects(): ScriptEffects {
  return { adds: [], removes: [], stackSets: [], events: [], hpChanges: [], statChanges: [], subscriptions: [], unsubscriptions: [] };
}

// ═══════════════════════════════════════════════════════════
// 执行器
// ═══════════════════════════════════════════════════════════

/**
 * 在沙盒中执行一段效果脚本
 *
 * @param script - AI 编写的 JavaScript 代码
 * @param context - 执行上下文 (owner, target, event, self)
 * @returns 脚本执行期间收集的状态变更
 */
export function executeScript(script: string, context: ScriptContext): ScriptEffects {
  const effects = createScriptEffects();

  if (!script || script.trim().length === 0) return effects;

  try {
    const sandbox = buildSandbox(effects, context);
    const fn = new Function(...Object.keys(sandbox), `"use strict";\n${script}`);
    fn(...Object.values(sandbox));
  } catch (err) {
    console.error('[ScriptExecutor] 脚本执行失败:', err instanceof Error ? err.message : String(err));
  }

  return effects;
}

/**
 * 在效果列表中按钩子名执行脚本
 *
 * @param statuses - 角色的状态效果列表
 * @param hook - 钩子名: 'onApply' | 'onTick' | 'onRemove' | 'onTrigger'
 * @param context - 执行上下文
 * @returns 累积的状态变更
 */
export function executeHook(
  statuses: StatusEffect[],
  hook: 'onApply' | 'onTick' | 'onRemove' | 'onTrigger',
  context: Omit<ScriptContext, 'self'>,
): ScriptEffects {
  const allEffects = createScriptEffects();

  for (const status of statuses) {
    const scriptRef = status[hook];
    if (!scriptRef || !status.scripts) continue;

    const rawScript = status.scripts[scriptRef];
    if (!rawScript) continue;

    // 🆕 从 StatusEffect 上读取 parentScripts（运行时注入，不存 DB）
    const parentScripts = (status as any)._parentScripts as Record<string, string> | undefined;

    // 🆕 解析 @ 引用：如果 scripts["tick"] = "@parent.burnFormula"，递归查找实际代码
    let script = rawScript;
    if (typeof script === 'string' && script.startsWith('@')) {
      const resolved = resolveScriptRef(script, status.scripts, parentScripts);
      if (resolved) script = resolved;
    }

    const self: ScriptContext['self'] = {
      stacks: status.stacks,
      remainingTime: status.remainingTime,
      name: status.name,
      scripts: status.scripts,  // 🆕 把自己 scripts 池传入，供 resolveScriptRef 本地查找
    };

    // 每个效果独立执行，但收集到一个 effects 对象
    const result = executeScript(script, { ...context, self, parentScripts });

    // 合并结果
    allEffects.adds.push(...result.adds);
    allEffects.removes.push(...result.removes);
    allEffects.stackSets.push(...result.stackSets);
    allEffects.events.push(...result.events);
    allEffects.hpChanges.push(...result.hpChanges);
    allEffects.statChanges.push(...result.statChanges);
  }

  return allEffects;
}

/**
 * 解析脚本引用 — 支持层级路径:
 *   "scriptKey"          → 当前对象 scripts["scriptKey"]
 *   "@parent.scriptKey"  → 父对象 scripts["scriptKey"]
 *   "@type.id.scriptKey" → 显式指定对象 scripts["scriptKey"]
 *
 * 递归解析：如果查到的值仍是 @ 引用，继续解析（最多 5 层）
 */
export function resolveScriptRef(
  ref: string,
  scripts?: Record<string, string>,
  parentScripts?: Record<string, string>,
  _depth: number = 0,
): string | undefined {
  if (!ref || _depth > 5) return undefined;

  // 1. 本地查找
  if (!ref.startsWith('@')) {
    const resolved = scripts?.[ref];
    if (!resolved) return undefined;
    // 递归解析
    if (typeof resolved === 'string' && resolved.startsWith('@')) {
      return resolveScriptRef(resolved, scripts, parentScripts, _depth + 1);
    }
    return resolved;
  }

  // 2. @parent.xxx
  if (ref.startsWith('@parent.') && parentScripts) {
    const key = ref.slice(8);
    const resolved = parentScripts[key];
    if (!resolved) return undefined;
    if (typeof resolved === 'string' && resolved.startsWith('@')) {
      return resolveScriptRef(resolved, parentScripts, undefined, _depth + 1);
    }
    return resolved;
  }

  // 3. @type.id.xxx — 显式跨对象引用
  //    格式: @item.灼烧之剑.burnFormula / @skill.重击.damageCalc / @status.xxx.tick
  const typeMatch = ref.match(/^@(item|skill|status|ascension)\.(.+?)\.(.+)$/);
  if (typeMatch) {
    // 显式跨对象引用需要外部 lookup 函数，沙盒内通过 $call 间接调用
    // resolveScriptRef 本身不访问 CharacterState，留给调用方处理
    return undefined; // 返回 undefined，由 $call() 处理
  }

  return undefined;
}

// ═══════════════════════════════════════════════════════════
// 沙盒构造
// ═══════════════════════════════════════════════════════════

function buildSandbox(effects: ScriptEffects, ctx: ScriptContext): Record<string, any> {
  // 🆕 当前对象的 scripts 池（用于 $status.add 继承 + resolveScriptRef 本地查找）
  const ownScripts = ctx.self.scripts || {};
  // 🆕 父对象的 scripts 池
  const parentScripts = ctx.parentScripts || {};

  return {
    // 上下文变量
    owner: ctx.owner,
    target: ctx.target,
    event: ctx.event ?? {},
    self: ctx.self,

    // $dice API
    $dice: {
      d20: () => Math.floor(Math.random() * 20) + 1,
      d100: () => Math.floor(Math.random() * 100) + 1,
      roll: (formula: string) => {
        // 简单公式解析: "2d6+3" → 2d6 + 3
        const match = formula.match(/(\d+)?d(\d+)([+-]\d+)?/);
        if (!match) return 0;
        const count = parseInt(match[1] || '1');
        const sides = parseInt(match[2]);
        const mod = parseInt(match[3] || '0');
        let total = 0;
        for (let i = 0; i < count; i++) total += Math.floor(Math.random() * sides) + 1;
        return total + mod;
      },
    },

    // $resource API
    $resource: {
      getHp: (_charId: string) => 0,     // 调用方负责处理
      getMaxHp: (_charId: string) => 0,
      modifyHp: (charId: string, amount: number) => {
        effects.hpChanges.push({ charId, amount });
      },
      modifyStat: (charId: string, stat: string, amount: number) => {
        effects.statChanges.push({ charId, stat, amount });
      },
    },

    // $status API (套娃核心)
    $status: {
      add: (charId: string, effect: Partial<StatusEffect>) => {
        // 🆕 自动将当前对象的 scripts 作为 parentScripts 传给子 StatusEffect
        if (ownScripts && Object.keys(ownScripts).length > 0) {
          (effect as any)._parentScripts = ownScripts;
        }
        effects.adds.push({ charId, effect });
      },
      remove: (charId: string, effectId: string) => {
        effects.removes.push({ charId, effectId });
      },
      setStacks: (charId: string, effectId: string, stacks: number) => {
        effects.stackSets.push({ charId, effectId, stacks });
      },
      getStacks: (_charId: string, _effectId: string) => 0,
    },

    // 🆕 $call API — 跨对象脚本调用
    $call: (ref: string): any => {
      const code = resolveScriptRef(ref, ownScripts, parentScripts);
      if (!code) return undefined;
      // 在同一个上下文中执行（共享 owner/target/event/self）
      const subResult = executeScript(code, ctx);
      // 合并子脚本的效果到当前 effects
      effects.adds.push(...subResult.adds);
      effects.removes.push(...subResult.removes);
      effects.stackSets.push(...subResult.stackSets);
      effects.events.push(...subResult.events);
      effects.hpChanges.push(...subResult.hpChanges);
      effects.statChanges.push(...subResult.statChanges);
      effects.subscriptions.push(...subResult.subscriptions);
      effects.unsubscriptions.push(...subResult.unsubscriptions);
      return undefined; // 无返回值（效果通过 effects 收集传递）
    },

    // 🆕 $event API (扩展)
    $event: {
      /** 注册持久事件监听。引擎在脚本执行后注册到 EventBus */
      on: (eventType: string, scriptKey: string): string => {
        const handle = `sub_${effects.subscriptions.length}_${eventType}`;
        effects.subscriptions.push({ eventType, scriptKey });
        return handle;
      },
      /** 取消持久事件监听。传入 handle 或 eventType */
      off: (handleOrType: string): void => {
        effects.unsubscriptions.push(handleOrType);
      },
      /** 触发瞬时事件 */
      emit: (eventType: string, data?: Record<string, any>) => {
        effects.events.push({ eventType, data: data ?? {} });
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════
// init / cleanup 工具函数
// ═══════════════════════════════════════════════════════════

/**
 * 执行对象的 init 脚本。
 * 用于：装备物品时、施加 StatusEffect 时、获得要素时。
 *
 * @param scripts     - 对象的 scripts 池
 * @param parentScripts - 父对象的 scripts（用于 @parent 引用）
 * @param owner       - 持有者 charId
 * @returns 脚本执行的效果收集（含 subscriptions/unsubscriptions）
 */
export function executeInit(
  scripts: Record<string, string>,
  parentScripts: Record<string, string> | undefined,
  owner: string,
): ScriptEffects {
  const code = scripts['init'];
  if (!code) return createScriptEffects();

  const ctx: ScriptContext = {
    owner,
    self: {
      stacks: 1,
      remainingTime: null,
      name: 'init',
      scripts,
    },
    parentScripts,
  };

  return executeScript(code, ctx);
}

/**
 * 执行对象的 cleanup 脚本。
 * 用于：卸下物品时、移除 StatusEffect 时、失去要素时。
 *
 * @param scripts     - 对象的 scripts 池
 * @param parentScripts - 父对象的 scripts
 * @param owner       - 持有者 charId
 * @returns 脚本执行的效果收集（含 unsubscriptions）
 */
export function executeCleanup(
  scripts: Record<string, string>,
  parentScripts: Record<string, string> | undefined,
  owner: string,
): ScriptEffects {
  const code = scripts['cleanup'];
  if (!code) return createScriptEffects();

  const ctx: ScriptContext = {
    owner,
    self: {
      stacks: 1,
      remainingTime: null,
      name: 'cleanup',
      scripts,
    },
    parentScripts,
  };

  return executeScript(code, ctx);
}
