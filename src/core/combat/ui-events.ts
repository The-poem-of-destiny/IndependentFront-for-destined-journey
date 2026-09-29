import type { CombatUnitView } from './types';

/** Combat events projected to the game UI. */
export type CombatEvent =
  | {
      type: 'combat_started';
      combatId: string;
      round: number;
      unitNames: string[];
    }
  /** 🆕 T13（设计 2026-08-09 §3.1）：开局单位字典整体快照 —— CombatOpened 投影时补发，让面板有数据 */
  | { type: 'units_snapshot'; units: Record<string, CombatUnitView> }
  | { type: 'turn_started'; unit: string; unitId: string; round: number }
  | { type: 'turn_ended'; unit: string; unitId: string; round: number }
  | { type: 'round_started'; round: number }
  | { type: 'round_ended'; round: number }
  | { type: 'initiative'; round: number; order: string[] }
  | { type: 'action'; toolName: string; result: Record<string, any>; text?: string }
  | {
      type: 'unit_state_changed';
      unitId: string;
      unitName: string;
      hp: number;
      maxHp: number;
      side: 'player' | 'enemy';
    }
  | { type: 'status_changed'; unitId: string; statusId: string; op: 'applied' | 'removed' }
  | { type: 'morale_changed'; unitId: string; state: string }
  | { type: 'roster_changed'; op: 'summoned' | 'despawned'; unitId: string; unitName: string }
  | { type: 'special_damage'; targetId: string; final: number; kind: string }
  | { type: 'rule_override'; effectDescription: string; reason?: string }
  | { type: 'effect_rejected'; code: string; detail: string }
  | { type: 'dice_epoch'; outputId: string }
  | { type: 'settlement'; fpDelta: number; reason: string; winner?: string }
  | { type: 'narrative'; text: string; round: number }
  | { type: 'awaiting_player_input'; unit: string; unitId: string; round: number }
  | {
      type: 'agent_paused';
      role: 'combat_host' | 'combat_enemy';
      message: string;
      unit: string;
      unitId: string;
      round: number;
    }
  | { type: 'agent_resumed'; role: 'combat_host' | 'combat_enemy' }
  | {
      /**
       * 🆕 2026-08-12（Bug 2 修复）：玩家侧命令被内核 rejection 的友好提示。
       * 典型场景：玩家攻击槽已耗尽仍再点攻击 → SLOT_EXHAUSTED。这是**玩家误操作**，
       * 不是系统故障 —— 此前 coordinator 走熔断（steps>3 → break → abandon）会毁掉
       * 整场战斗。现在 emit 本事件：store 在 combatLog 推一条提示行 + 重新亮
       * awaiting_player_input，玩家可换动作或点「结束回合」。
       */
      type: 'rejection_notice';
      code: string;
      message: string;
      unit: string;
      unitId: string;
    }
  | { type: 'combat_ended'; reason: string; winner?: string }
  /**
   * 🆕 F2（2026-08-10）：就绪面板事件 —— combat_trigger 检出后由 game-pipeline 直接
   * 构造（不经过 projection-ui，无对应 DomainEvent）。载荷 = marker 快照，就绪面板
   * 据此展示参战方/类型/环境/起因；玩家点「开始战斗」才 openCombat + runCombat。
   */
  | {
      type: 'combat_ready';
      combatType?: string;
      environment?: string;
      allies?: string[];
      enemies?: string[];
      bodyText?: string;
      brief?: string;
    };
