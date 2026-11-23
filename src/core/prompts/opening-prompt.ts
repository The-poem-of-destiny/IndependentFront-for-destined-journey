/**
 * opening-prompt.ts — 开局提示词（首轮玩家输入）的纯函数构造器
 *
 * 版式沿用 SillyTavern 开局模板：先指明结构化数据所在的区块，再列出需要创作的开局要素、
 * 第一轮必须同步的字段，最后给出开局剧情（预设 / 自定义 / 自由开局）。
 *
 * 🔴 角色、属性、金钱、装备、背包、技能都已写入结构化区块，这里**不再**复述金钱、
 *    装备 / 技能 / 背包清单，也不写「不可改变既定事实」之类的约束 —— 重复一遍只会让
 *    模型拿叙事值去覆盖面板数值。
 *
 * 区块名与第一轮更新口径按生成模式区分，必须对上各模式真实的写回机制：
 * - direct：`<direct_state>`，经 `direct_updates` 声明耗时与地点。措辞协议中立（不写字段路径）：
 *   旧协议（`time.delta_time` / `state.characters.replace path=location`）与状态树协议
 *   （`/世界/时间` / `/世界/地点`）共用这两行，开局提示词建档时落库，切协议也不会过期；
 * - direct_cached：`<direct_context>`，输出协议与 direct 相同；
 * - agent：`<角色状态>`。正文模型自己不输出数据，耗时与地点由请求调度器从正文读出后
 *   经 `delta_time` / `set_location` 写回（见 `vars-update-translator.ts`），所以这里只要求
 *   正文把这两件事写清楚、免掉为时间/地点额外输出数据；各 Agent 的输出格式照常（这段是首轮
 *   每个 Agent 的 `{{USER_INPUT}}`）。时间在 `<当前时空>`，主角位置在 `<角色状态>`。
 */

import type { GenerationMode } from '../story/generation-mode';

export interface OpeningScenario {
  /** 开局标题；自定义开局由调用方传「自定义开局」 */
  title: string;
  /** 开局描述；其中的 `<user>` 会替换为主角名 */
  text: string;
}

export interface OpeningPromptInput {
  generationMode: GenerationMode;
  name: string;
  identity: string;
  gender: string;
  age: number;
  /** 主角生日（月 1-12、日 1-30）；缺省或 null 时不写这一行 */
  birthday?: { month: number; day: number } | null;
  startLocation: string;
  /** 命定核心名；缺省或空串时不写这一行 */
  coreName?: string;
  /** 开局剧情；null 表示不选开局，改为自由开局 */
  scenario: OpeningScenario | null;
}

const STATE_BLOCK: Record<GenerationMode, string> = {
  agent: '<角色状态>',
  direct: '<direct_state>',
  direct_cached: '<direct_context>',
};

const DIRECT_UPDATE_LINES = [
  '* 时间：在 direct_updates 中声明开局这一幕实际经过的分钟数（非负），推进游戏时间。',
  '* 地点：在 direct_updates 中声明主角本轮结束时所在的地点。',
];

/** agent 模式：游戏时间在 `<当前时空>`，主角位置在 `<角色状态>`（见 story 预设的区块排布） */
const AGENT_UPDATE_LINES = [
  '* 时间：正文要交代开局这一幕经过了多长时间，<当前时空> 中的游戏时间据此推进。',
  '* 地点：正文要写明主角在本轮结束时身处何地，<角色状态> 中的主角位置据此更新。',
];

function updateSection(mode: GenerationMode): string[] {
  if (mode === 'agent') {
    // 🔴 这段会作为 {{USER_INPUT}} 进入首轮每个 Agent（story 仍要输出 <maintext>/<option>/<sum>，
    //    request_dispatcher 仍要输出 <json> 与请求标签），所以只能免掉「为时间/地点额外输出数据」，
    //    不能笼统地说「不要输出 JSON 或标签」。
    return [
      '【第一轮变量更新要求】',
      '第一轮剧情的正文必须写清以下内容，系统会据此更新状态（无需为时间/地点额外输出数据，输出格式照常）：',
      '',
      ...AGENT_UPDATE_LINES,
    ];
  }
  const block = STATE_BLOCK[mode];
  return [
    '【第一轮变量更新要求】',
    `第一轮 AI 回复必须同步更新 ${block} 中的以下字段：`,
    '',
    ...DIRECT_UPDATE_LINES,
  ];
}

export function buildOpeningPrompt(input: OpeningPromptInput): string {
  const name = input.name.trim() || '未命名';
  const block = STATE_BLOCK[input.generationMode];
  const lines: string[] = [
    '【剧情生成上下文】',
    `角色、属性、金钱、装备、背包、技能等结构化数据已写入 ${block}。`,
    '',
    '以下只提供需要创作的开局。',
    `姓名: ${name}`,
    `身份: ${input.identity}`,
    `性别: ${input.gender}`,
    `年龄: ${input.age}岁`,
  ];
  if (input.birthday) lines.push(`生日: ${input.birthday.month}月${input.birthday.day}日`);
  lines.push(`起始地点: ${input.startLocation}`);
  const coreName = input.coreName?.trim();
  if (coreName) lines.push(`命定核心: ${coreName}`);

  lines.push(...updateSection(input.generationMode), '', '【初始开局剧情】');

  if (input.scenario) {
    lines.push(
      input.scenario.title,
      `描述: ${input.scenario.text.replace(/<user>/g, name)}`,
      '根据以上内容，生成一个符合描述和情景的初始剧情！',
    );
  } else {
    lines.push(
      `未选择预设开局。请根据${name}的身份、起始地点与当前时间，自由构思一个合理的开局，生成初始剧情！`,
    );
  }
  lines.push(
    '（注意：生成初始剧情时，先检查上述内容是否完整，如不完整，必须参考相关设定进行完善。）',
  );

  return lines.join('\n');
}
