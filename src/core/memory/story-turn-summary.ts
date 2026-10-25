/**
 * Story 上下文新模式（v2）的**每回合总结**契约：给 memory_summary Agent 的提示词与模板，
 * 以及对应的解析器（计划 D28 / D29 / §7.2 / §8，Q13）。
 *
 * 每轮一次调用完成两件事，**顺序固定**：
 *   ① 先做归档判断 —— 对照本轮开始时的未结事件，判断本回合正文是否让某个事件结束
 *      （成功完成 / 放弃 / 失败）；结束的事件写出第 2 区概括记录与事件详细记录。
 *   ② 再写本回合短期摘要 —— 可按事件分段，继续未结事件时沿用其名字。
 * 归档判断由代码二次把关（`story-archive.ts`），模型的判断不直接生效。
 *
 * 🔴 **格式定义与解析器同源**：提示词教它写什么、解析器就只认什么，两者住在同一个文件，
 *    改一边必须改另一边（先例 character/character-appearance-agent.ts）。
 * 🔴 只在 v2 测试档使用。旧模式的 memory_summary 提示词与输出契约（agent-config.json +
 *    memory-summarizer.ts）原样不动 —— 新格式绝不交给旧处理器（计划 §11.2）。
 * 🔴 不设最低字数：短回合允许短摘要，判据是信息完整、忠于来源（§7.2）。
 */
import type { StoryArchiveDetail, StoryArchiveOutcome } from '../types/types';
import { parseModelJson } from '../utils/model-json';

/** v2 每回合总结的 systemPrompt（覆盖 memory_summary 在 v2 回合中的提示词）。 */
export const STORY_TURN_SUMMARY_SYSTEM_PROMPT = [
  '你是叙事记忆整理员。每回合按顺序做两件事：先判断有没有事件在本回合结束，再写本回合的短期摘要。',
  '',
  '【第一步：归档判断】',
  '对照 <未结事件>，只根据 <本回合正文> 判断其中哪些事件在本回合真正结束。结束只有三种：',
  '- completed：目标达成、委托交付、事情有了明确的好结局；',
  '- abandoned：角色明确放弃、拒绝继续、主动离开不再追究；',
  '- failed：目标无法再达成（期限已过、关键人物死亡、东西被毁等）。',
  '本回合开始又在本回合结束的事件也可以归档，事件名与第二步摘要里用的名字一致。',
  '以下都**不是**结束的证据：回合多了、换了地点、过了一天、话题转移、摘要写得很长、事件暂时搁置。',
  '拿不准就不要归档。每条归档必须给出 evidence：从 <本回合正文> 里摘录一句能证明结局的原文，尽量照抄原句。',
  '归档事件要写：',
  '- overview：一两句话，写这个事件在长期经历中的位置与结果，作为历史年表的一行；',
  '- detail：cause（起因）、process（关键经过）、ending（怎样结束）、promises（重要约定、承诺、交易条件，数字与期限照原文）、impact（仍在持续的影响或尚待处理的后果）；没有的项写空串。引擎随后会对照事件原文重写详细记录，这里写简要版本即可。',
  '',
  '【第二步：本回合摘要】',
  '必须保留：实际发生的行动与结果；新出现的约定、承诺、交易条件、关键信息（数字、地点、期限照原文写）；',
  '人物关系的变化及其原因；仍未解决的事项。',
  '必须区分：计划、猜测、传闻与已经证实的事实，按原文的语气写明是哪一种。',
  '不要写：正文没有演绎出来的计划或真相、幕后信息、世界设定全文、你自己的推测与评价。',
  '人物与地点使用正文里的名字，不写 ID。',
  '每段给出 characters（人物名）、locations（地点名）、topics（主题词）数组，只提取已发生的语义，没有则空数组，不猜测。游戏时间范围由引擎绑定原回合事实，不输出或猜测时间。',
  '一回合里涉及几件互不相干的事时，按事件拆成多段；每段写清它属于哪件事。',
  '继续 <未结事件> 里的事件时，event 必须与那里的名字**逐字一致**；新事件用简短名词短语命名。',
  '日常闲聊、过场等不属于任何事件的内容可以单独成段，event 留空。',
  '篇幅随内容走：没什么事发生的回合写一两句即可，不要凑字数。',
  '',
  '只输出一个 <json> 块，archives 在前，没有结束的事件时给空数组：',
  '<json>',
  '{',
  '  "archives": [ { "event": "事件名", "outcome": "completed", "evidence": "正文原句", "overview": "一两句概括",',
  '    "detail": { "cause": "", "process": "", "ending": "", "promises": "", "impact": "" } } ],',
  '  "segments": [ { "event": "事件名或空串", "content": "这一段的摘要", "characters": [], "locations": [], "topics": [] } ]',
  '}',
  '</json>',
].join('\n');

/** v2 每回合总结的上下文模板（覆盖 memory_summary 在 v2 回合中的模板）。 */
export const STORY_TURN_SUMMARY_TEMPLATE = [
  '{{SYS_PROMPT}}',
  '',
  '<当前时间>',
  '{{GAME_TIME}}',
  '</当前时间>',
  '',
  '<角色状态>',
  '{{CHARACTER_STATE}}',
  '</角色状态>',
  '',
  '<未结事件>',
  '{{STORY_OPEN_EVENTS}}',
  '</未结事件>',
  '',
  '<本回合玩家输入>',
  '{{USER_INPUT}}',
  '</本回合玩家输入>',
  '',
  '<本回合正文>',
  '{{AGENT.STORY}}',
  '</本回合正文>',
].join('\n');

interface ParsedStoryTurnSummarySegment {
  content: string;
  /** 事件名；空串 / 缺席 = 不属于任何事件 */
  eventName?: string;
  characters?: string[];
  locations?: string[];
  topics?: string[];
}

export interface ParsedStoryArchiveDecision {
  eventName: string;
  outcome: StoryArchiveOutcome;
  evidence: string;
  overview: string;
  detail: StoryArchiveDetail;
}

export interface ParsedStoryTurnSummary {
  archives: ParsedStoryArchiveDecision[];
  segments: ParsedStoryTurnSummarySegment[];
}

/** 结局值归一（模型偶尔写中文） */
const OUTCOME_ALIASES: Record<string, StoryArchiveOutcome> = {
  completed: 'completed',
  complete: 'completed',
  success: 'completed',
  成功完成: 'completed',
  成功: 'completed',
  完成: 'completed',
  abandoned: 'abandoned',
  abandon: 'abandoned',
  放弃: 'abandoned',
  failed: 'failed',
  fail: 'failed',
  failure: 'failed',
  失败: 'failed',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function names(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map(text).filter(Boolean))];
}

function parseArchive(item: unknown): ParsedStoryArchiveDecision | null {
  const o = (item ?? {}) as Record<string, unknown>;
  const eventName = text(o.event);
  const outcome = OUTCOME_ALIASES[text(o.outcome).toLowerCase()];
  const evidence = text(o.evidence);
  const overview = text(o.overview);
  if (!eventName || !outcome || !evidence || !overview) return null;
  const d = (o.detail ?? {}) as Record<string, unknown>;
  return {
    eventName,
    outcome,
    evidence,
    overview,
    detail: {
      cause: text(d.cause),
      process: text(d.process),
      ending: text(d.ending),
      promises: text(d.promises),
      impact: text(d.impact),
    },
  };
}

/**
 * 解析 v2 每回合总结输出。
 *
 * 没有任何非空摘要片段时返回 `null` —— 调用方必须当作「本回合摘要缺失」处理并明确提示，
 * 这时归档判断也一并作废（没有摘要就无法确认覆盖关系）。字段残缺的归档条目逐条丢弃。
 */
export function parseStoryTurnSummaryOutput(rawOutput: string): ParsedStoryTurnSummary | null {
  return parseModelJson<ParsedStoryTurnSummary>(rawOutput, (payload) => {
    const p = (payload ?? {}) as { segments?: unknown; archives?: unknown };
    if (!Array.isArray(p.segments)) return null;
    const segments: ParsedStoryTurnSummarySegment[] = [];
    for (const item of p.segments) {
      const content = text((item as { content?: unknown } | null)?.content);
      if (!content) continue;
      const event = text((item as { event?: unknown }).event);
      const fields = item as Record<string, unknown>;
      const semantic = Object.fromEntries(
        ['characters', 'locations', 'topics'].flatMap((key) => {
          const list = names(fields[key]);
          return list === undefined ? [] : [[key, list]];
        }),
      );
      segments.push({ content, ...(event ? { eventName: event } : {}), ...semantic });
    }
    if (segments.length === 0) return null;
    const archives = Array.isArray(p.archives)
      ? p.archives.map(parseArchive).filter((a): a is ParsedStoryArchiveDecision => a !== null)
      : [];
    return { archives, segments };
  });
}

// ========== 摘要补建（计划 Q10 / P4「针对性补建」）==========

/**
 * 补建较早回合摘要的 systemPrompt：只写摘要，不做归档判断。
 *
 * 归档判断必须在事件发生的那一轮、对照当时的未结事件作出；事后补建时那份对照表已经变了，
 * 在这里补判会把结局挂到错误的回合上。所以补建只产出片段，事件结束仍由之后的回合判断。
 */
const STORY_TURN_BACKFILL_SYSTEM_PROMPT = [
  '你是叙事记忆整理员。下面是较早的一个回合，当时没有生成摘要，现在为它补写短期摘要。',
  '只写这一回合发生的事，不做事件是否结束的判断。',
  '必须保留：实际发生的行动与结果；新出现的约定、承诺、交易条件、关键信息（数字、地点、期限照原文写）；',
  '人物关系的变化及其原因；仍未解决的事项。计划、猜测、传闻与已证实的事实要按原文语气分清。',
  '不要写正文没有演绎出来的内容、幕后信息或你自己的推测。人物与地点使用正文里的名字。',
  '一回合里涉及几件互不相干的事时按事件拆成多段；继续 <未结事件> 里的事件时，event 与那里的名字逐字一致；',
  '不属于任何事件的内容 event 留空。篇幅随内容走，不要凑字数。',
  '每段给出 characters（人物名）、locations（地点名）、topics（主题词）数组，正文没有则空数组。时间由引擎绑定原回合事实，不使用当前时间。',
  '',
  '只输出一个 <json> 块：',
  '<json>',
  '{ "archives": [], "segments": [ { "event": "事件名或空串", "content": "这一段的摘要", "characters": [], "locations": [], "topics": [] } ] }',
  '</json>',
].join('\n');

/**
 * 为一个缺摘要的较早回合构造补建请求。输出用 `parseStoryTurnSummaryOutput` 解析，
 * 调用方**丢弃其中的 archives**（见上面提示词的说明）。
 */
export function buildStoryTurnBackfillMessages(input: {
  userInput: string;
  storyText: string;
  /** 已渲染的未结事件清单（`renderOpenEventsForSummary`），用于沿用事件名 */
  openEvents: string;
}): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: STORY_TURN_BACKFILL_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `<未结事件>\n${input.openEvents}\n</未结事件>`,
        `<该回合玩家输入>\n${input.userInput}\n</该回合玩家输入>`,
        `<该回合正文>\n${input.storyText}\n</该回合正文>`,
      ].join('\n\n'),
    },
  ];
}
