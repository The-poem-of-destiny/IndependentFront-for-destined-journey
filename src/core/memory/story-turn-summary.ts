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
 * 🔴 示例只用〔〕占位的因果骨架，**不写具体人名、地名、物品与数字** —— 具体示例会被模型
 *    照搬进摘要（提示词污染）。占位符不用 `{{}}`（模板占位语法）也不用 `【】`（事件名标记）。
 * 🔴 不设最低字数：短回合允许短摘要，判据是信息完整、忠于来源（§7.2）。
 *    设单段篇幅锚点与禁写清单（2026-11 精简微调）：原文由引擎完整保存、召回可展开，
 *    摘要只做事实索引。`segments` 仍要求至少一段 —— 空数组会被解析成「本回合摘要缺失」。
 */
import type { StoryArchiveDetail, StoryArchiveOutcome } from '../types/types';
import { parseModelJson } from '../utils/model-json';

/** v2 每回合总结的 systemPrompt（覆盖 memory_summary 在 v2 回合中的提示词）。 */
export const STORY_TURN_SUMMARY_SYSTEM_PROMPT = [
  '你是叙事记忆整理员。每回合按顺序做两件事：先判断有没有事件在本回合结束，再写本回合的短期摘要。',
  '引擎完整保存了每回合原文，需要细节时会直接回查原文。你写的内容只做高浓缩的事实索引：写结论与变化，不写过程与修辞。',
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
  '- overview：一句话（30~50 字），只写事件的起因与最终结局，作为历史年表的一行；',
  '- detail：cause（起因）、process（关键经过）、ending（怎样结束）、promises（重要约定、承诺、交易条件，数字与期限照原文）、impact（仍在持续的影响或尚待处理的后果）；每项最多一句话，只列核心短语，没有的项写空串。引擎随后会对照事件原文重写详细记录，这里只是原文重写失败时的兜底稿。',
  '',
  '【第二步：本回合摘要】',
  '必须保留：实际发生的行动与结果；新出现的约定、承诺、交易条件、关键信息（数字、地点、期限照原文写）；',
  '人物关系的变化及其原因；仍未解决的事项。',
  '必须区分：计划、猜测、传闻与已经证实的事实，按原文的语气在括注里写明是哪一种。',
  '写法：短句结论 + 括号或分号列出硬参数（数字、地点、期限、条件），不要写成完整的叙事经过。',
  '不要写：环境渲染、心理活动、神态与动作细节、寒暄客套、战斗的具体招式往来；同一件事来回拉扯的过程（讨价还价、反复盘问）不写，只写最终达成的条件或得出的结论。',
  '也不要写：正文没有演绎出来的计划或真相、幕后信息、世界设定全文、你自己的推测与评价。',
  '人物与地点使用正文里的名字，不写 ID。',
  '篇幅：推进事件的一段写 1~2 句（约 30~80 字），只写「谁做了什么 → 结果、状态变化或新约定」；整回合没有实质新信息或状态变化时，只写 1 句（20 字以内）。不要凑字数。',
  '分段：一回合通常只输出 1 段。只有同一回合里同时推进了两件以上互相独立的事件，才按事件拆成多段，每段写清它属于哪件事。',
  '已有事件推进时，顺带的赶路、点餐、寒暄等没有实质影响的过场直接忽略，不要为它单独拆出 event 为空串的段落。',
  '只有整回合没有推进任何事件（或日常互动本身带来了显著的关系、约定或状态变化，且不属于既有事件）时，才输出 1 段 event 为空串的摘要。',
  'segments 至少一段：哪怕整回合只是过场，也写 1 句。',
  '继续 <未结事件> 里的事件时，event 必须与那里的名字**逐字一致**；新事件用简短而具体的名词短语命名。',
  '延续 <未结事件> 里的事件时，那里已经记录过的起因、背景、人物身份、地点和既有条件一律不再重复，用事件名指代即可，只写本回合新发生的行动、结果、新信息或状态变化。',
  '某个未结事件本回合只是被提起，没有新行动、新线索或新决定时，不为它写段落；如果整回合因此没有可写的进展，就写 1 句 event 为空串的过场（仍满足 segments 至少一段）。',
  '事件在本回合结束时，结局本身就是新进展，照常为它写一段。',
  '每段给出 characters（人物名）、locations（地点名）、topics（主题词）数组，只提取已发生的语义，没有则空数组，不猜测。游戏时间范围由引擎绑定原回合事实，不输出或猜测时间。',
  '',
  '浓缩程度示例（〔〕是结构占位符，只示意因果骨架；摘要里写正文中的实际内容，不照抄示例措辞，也不输出〔〕）：',
  '- 过细：〔人物〕向〔对方〕提出〔请求〕，〔对方〕以〔理由〕提出〔条件〕，双方来回商议后〔人物〕〔行动〕，〔对方〕承诺〔期限〕内〔兑现〕，否则〔违约后果〕。',
  '- 精简：〔人物〕与〔对方〕约定〔事项〕（已〔行动〕；〔期限〕内〔兑现〕，否则〔违约后果〕）。',
  '- 传闻与计划：得知〔消息〕（传闻，未证实）；计划〔时间〕〔行动〕。',
  '- 延续事件（<未结事件> 里已记录〔起因〕与〔既有条件〕）：',
  '  过细：此前因〔起因〕而〔既有条件〕的〔事项〕，本回合〔经过〕……',
  '  精简：〔本回合行动〕，〔结果或状态变化〕。',
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
  '引擎完整保存了每回合原文，需要细节时会直接回查原文。摘要只做高浓缩的事实索引：写结论与变化，不写过程与修辞。',
  '必须保留：实际发生的行动与结果；新出现的约定、承诺、交易条件、关键信息（数字、地点、期限照原文写）；',
  '人物关系的变化及其原因；仍未解决的事项。计划、猜测、传闻与已证实的事实要按原文语气分清，在括注里写明是哪一种。',
  '写法：短句结论 + 括号或分号列出硬参数（数字、地点、期限、条件）。不要写环境渲染、心理活动、神态与动作细节、寒暄客套、战斗招式往来，来回拉扯的过程只写最终结论。',
  '不要写正文没有演绎出来的内容、幕后信息或你自己的推测。人物与地点使用正文里的名字。',
  '篇幅：推进事件的一段写 1~2 句（约 30~80 字）；整回合没有实质新信息时只写 1 句（20 字以内）。不要凑字数。',
  '分段：通常只输出 1 段；同一回合同时推进了两件以上互相独立的事件，才按事件拆成多段。顺带的过场直接忽略，不单独成段；',
  '整回合不属于任何事件时输出 1 段 event 为空串的摘要。segments 至少一段。继续 <未结事件> 里的事件时，event 与那里的名字逐字一致。',
  '延续 <未结事件> 里的事件时，已经记录过的起因、背景、人物身份、地点和既有条件不再重复，只写这一回合的新进展；只是被提起、没有新进展的事件不写段落。',
  '写法骨架：〔结论〕（〔硬参数〕；〔约定或期限〕）。〔〕只示意结构，写正文中的实际内容，不输出〔〕。',
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
