/**
 * 状态树路径补丁 → StatePatch 的翻译层（状态树协议 T6，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §4.3–4.4、§5、§11.2、§12.2）
 *
 * 输入是 `parseTreePatchBlock` 规范化后的 op 列表（AI 写的，或变量修改器 / 更新块修订产生的），
 * 输出是交给 `StateManager` 的 `StatePatch[]`，外加本楼分钟数、新人物与逐条结果记录。
 *
 * 流程（每条 op，§5.1）：
 * 1. 解析路径（`resolveTreePath`，对的是工作状态 —— 完整内核状态，不是投影）。
 * 2. 按叶子类型纠正值（`state-tree-codecs.ts`）。
 * 3. 映射成 StatePatch（§5.3 全表）。
 * 4. `validateStatePatch` 核形状，再用 `state/patch-reducer.ts`（与 StateManager 提交时同一份纯变换，
 *    审查报告 R5c）作用到工作状态 —— 提交时会抛的补丁在这里同样抛、被丢；成组的补丁整组落或整组丢。
 * 5. 后面的 op 看得到前面的结果（「先 add 再穿戴」自然成立），记下的后值就是提交后真实落库的值。
 *
 * 顺序：按 AI 原顺序逐条作用；唯一例外是新建人物先落（§4.3）。翻译前先把同批的
 * 「删一边、加一边」（背包 ↔ 装备）折叠成一条 move（§5.3）。
 *
 * 每条 op 都产出一条 `StateUpdateOpRecord`：状态（已应用 / 已纠正 / 已丢弃）、说明、
 * 纠正后的写入值、前值与后值（取自工作状态的投影，§11 撤销与 §12 补差靠它）。
 *
 * 🔴 已裁定（§9）：不加 fitSlot（#9，穿戴槽位只从 op 自带或同批后续写入取）；不加槽位别名（#6）；
 *    从装备 remove = 物品离开人物（#11）；主角等级只读、NPC 等级可写（#2）；金钱钳到 0（#5）。
 * 🔴 本模块不碰 I/O：工作状态是入参的深拷贝，入参不被修改。新人物的 id 由 `createDefaultCharacterState` 生成。
 *
 * 📌 2026-11-25（审查报告 R6b）：实现按职责拆到 `translator/` 目录，本文件只留入口与对外导出（名字与路径不变）：
 * - `translator/core.ts`：翻译器本体（工作状态、落补丁、折叠、逐条记录、按根分派、整对象展开）
 * - `translator/working-state.ts`：经 patch-reducer 推进的写时复制与按分区投影的树视图
 * - `translator/rules.ts`：词表映射（路径模式 → 规则 / 内核字段、各实体形状）
 * - `translator/fields.ts`：树上的值 → 内核字段（物品 / 技能 / 状态 / 登神长阶）
 * - `translator/person.ts`：人物叶子与分派；`item.ts` / `skill-status.ts` / `create-character.ts`：
 *   物品、技能与状态、新建人物；`world-quest-vars.ts`：世界、命运点数、任务、新闻、变量
 * - `translator/host.ts`：各职责模块回调本体的接口（子模块之间因此不成环）
 */

import type { TreeOp } from './state-tree-patch';
import { TreeTranslator } from './translator/core';
import type {
  TreeTranslateOptions,
  TreeTranslateResult,
  TreeTranslateSnapshot,
} from './translator/types';

export type {
  TreeTranslateActor,
  TreeTranslateOptions,
  TreeTranslateResult,
  TreeTranslateSnapshot,
} from './translator/types';
export { readStateTreeValue } from './translator/common';
export { stateTreeKernelFieldOf, stateTreeTranslationRuleOf } from './translator/rules';

/**
 * 状态树 op 列表 → StatePatch 等（§5）。
 *
 * @param ops `parseTreePatchBlock` 产出的 op（或修改器 / 补差规划出的 op）
 * @param snapshot 当前内核状态（角色 + 档案），不会被修改
 * @param options `actor` 区分 AI 与玩家（玩家可删任意 NPC，§11.3）
 */
export function translateTreeOps(
  ops: readonly TreeOp[],
  snapshot: TreeTranslateSnapshot,
  options: TreeTranslateOptions,
): TreeTranslateResult {
  return new TreeTranslator(snapshot, options).run(ops);
}
