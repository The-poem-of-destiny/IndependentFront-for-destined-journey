import type { AgentToolActivity } from '@engine/types';

const AGENT_ACTIVITY_LABELS: Record<string, string> = {
  memory_recall: '追忆相关经历',
  plot_pre_check: '推演剧情脉络',
  story: '书写此刻',
  request_dispatcher: '辨认后续事件',
  vars_update: '更新世界状态',
  memory_summary: '封存本回合记忆',
  plot_post_check: '校准未来走向',
  craft_gen: '处理制作请求',
  char_gen: '塑造新登场角色',
  item_gen: '准备新物品',
  image_prompt: '构思场景画面',
  combat_v3: '推演战局',
  plot_outline: '编织剧情大纲',
};

const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  roll_d20: '掷出命运之骰',
  roll_d100: '掷出命运之骰',
  roll_dice: '掷出命运之骰',
  craft_check: '进行制作检定',
  craft_get_base_dc: '衡量制作难度',
  craft_get_production_bonus: '查阅制作加成',
  craft_settle: '结算制作成果',
  random_name: '为角色定名',
  random_hair_color: '选定发色',
  random_eye_color: '选定瞳色',
  random_personality: '勾勒人物性格',
  random_appearance: '勾勒人物外貌',
  roll_attributes: '生成角色属性',
  get_character: '查看角色状态',
  get_unit_detail: '查看参战者状态',
  get_hp_percent: '查看角色伤势',
  get_inventory: '查看随身物品',
  get_script_reference: '查阅世界规则',
  get_combat_state: '观察当前战局',
  declare_attack: '决定攻击方式',
  declare_action: '决定战斗行动',
  pass_slot: '保留当前行动',
  flee: '判断撤离时机',
  end_turn: '结束当前行动',
  submit_adjudication: '裁定战斗结果',
  write_summary: '记录战况',
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function agentActivityLabel(agentId: string): string {
  return AGENT_ACTIVITY_LABELS[agentId] ?? '处理世界变化';
}

/** 把原始工具往返压成玩家可读的一句话；未知工具也绝不回退到技术名。 */
export function presentToolActivity(
  toolName: string,
  args: unknown,
  result: unknown,
  id: string,
  completedAt = Date.now(),
): AgentToolActivity {
  const input = recordOf(args);
  const output = recordOf(result);
  const failed = Boolean(textOf(output?.error));
  let detail: string | undefined;

  if (!failed) {
    switch (toolName) {
      case 'craft_check': {
        const rating = textOf(output?.rating);
        if (rating) detail = `结果：${rating}`;
        break;
      }
      case 'craft_settle': {
        const product = textOf(output?.productName);
        const quality = textOf(output?.outputQuality);
        detail = [product, quality].filter(Boolean).join(' · ') || undefined;
        break;
      }
      case 'get_inventory': {
        const owner = textOf(output?.characterName);
        const count = numberOf(output?.itemCount);
        detail = [owner, count === undefined ? undefined : `${count} 件`]
          .filter(Boolean)
          .join(' · ');
        break;
      }
      case 'random_name': {
        const name = textOf(output?.name);
        if (name) detail = `名字：${name}`;
        break;
      }
      case 'get_character':
      case 'get_unit_detail': {
        detail = textOf(output?.name);
        break;
      }
      case 'declare_attack': {
        const actor = textOf(input?.actorName);
        const target = textOf(input?.targetName);
        detail = actor && target ? `${actor} → ${target}` : (actor ?? target);
        break;
      }
      case 'declare_action': {
        detail = textOf(input?.actionType);
        break;
      }
    }
  }

  return {
    id,
    label: TOOL_ACTIVITY_LABELS[toolName] ?? '处理世界规则',
    ...(detail ? { detail } : {}),
    status: failed ? 'failed' : 'completed',
    completedAt,
  };
}
