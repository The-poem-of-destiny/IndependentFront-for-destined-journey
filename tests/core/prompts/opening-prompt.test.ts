/**
 * opening-prompt.test.ts — 开局提示词构造器
 */
import { describe, expect, it } from 'vitest';
import {
  buildOpeningPrompt,
  type OpeningPromptInput,
  type OpeningScenario,
} from '../../../src/core/prompts/opening-prompt';
import type { GenerationMode } from '../../../src/core/story/generation-mode';

const MODES: GenerationMode[] = ['agent', 'direct', 'direct_cached'];
const BLOCKS: Record<GenerationMode, string> = {
  agent: '<角色状态>',
  direct: '<direct_state>',
  direct_cached: '<direct_context>',
};

const SCENARIOS: Array<[string, OpeningScenario | null]> = [
  ['预设开局', { title: '边境驿站', text: '<user>在驿站醒来，<user>的行囊还在身边。' }],
  ['自定义开局', { title: '自定义开局', text: '<user>站在港口。' }],
  ['自由开局', null],
];

function base(
  generationMode: GenerationMode,
  scenario: OpeningScenario | null,
  coreName?: string,
): OpeningPromptInput {
  return {
    generationMode,
    name: '艾琳',
    identity: '流浪佣兵',
    gender: '女',
    age: 24,
    startLocation: '灰石镇',
    coreName,
    scenario,
  };
}

const DROPPED = [
  '帝冕币',
  '身无分文',
  '不可改变既定事实',
  '天赋水平',
  '上限.额外',
  '带着这些装备',
  '已经掌握这些本领',
  '行囊里还有这些东西',
];

describe('buildOpeningPrompt', () => {
  for (const mode of MODES) {
    for (const [label, scenario] of SCENARIOS) {
      for (const core of [undefined, '星辉之心']) {
        it(`${mode} · ${label} · ${core ? '有命定核心' : '无命定核心'}`, () => {
          const out = buildOpeningPrompt(base(mode, scenario, core));
          const block = BLOCKS[mode];

          expect(out.startsWith('【剧情生成上下文】\n')).toBe(true);
          expect(out).toContain(`结构化数据已写入 ${block}。`);
          expect(out).toContain(
            '以下只提供需要创作的开局。\n姓名: 艾琳\n身份: 流浪佣兵\n性别: 女\n年龄: 24岁\n起始地点: 灰石镇',
          );
          if (core)
            expect(out).toContain('起始地点: 灰石镇\n命定核心: 星辉之心\n【第一轮变量更新要求】');
          else {
            expect(out).not.toContain('命定核心');
            expect(out).toContain('起始地点: 灰石镇\n【第一轮变量更新要求】');
          }

          // 第一轮更新：区块名与真实写回机制按模式区分
          const updateHead = out.slice(
            out.indexOf('【第一轮变量更新要求】'),
            out.indexOf('【初始开局剧情】'),
          );
          expect(updateHead).toContain(block);
          if (mode === 'agent') {
            // 首轮 USER_INPUT 进每个 Agent：只免时间/地点的额外数据，不能让 Agent 丢掉自己的输出格式
            expect(updateHead).toContain('无需为时间/地点额外输出数据，输出格式照常');
            expect(updateHead).not.toContain('不要输出 JSON');
            expect(updateHead).not.toContain('标签');
            expect(updateHead).toContain('* 时间：正文要交代开局这一幕经过了多长时间，<当前时空>');
            expect(updateHead).toContain('* 地点：正文要写明主角在本轮结束时身处何地，<角色状态>');
            expect(updateHead).not.toContain('delta_time');
            expect(updateHead).not.toContain('direct_updates');
            expect(updateHead).toContain('* 时间：');
            expect(updateHead).toContain('* 地点：');
          } else {
            expect(updateHead).toContain('第一轮 AI 回复必须同步更新');
            expect(updateHead).toContain('time.delta_time');
            expect(updateHead).toContain('state.characters.replace');
            expect(updateHead).toContain('path=location');
          }

          // 开局剧情
          if (scenario) {
            expect(out).toContain(`【初始开局剧情】\n${scenario.title}\n描述: `);
            expect(out).toContain('根据以上内容，生成一个符合描述和情景的初始剧情！');
            expect(out).not.toContain('<user>');
            expect(out).toContain('描述: 艾琳');
          } else {
            expect(out).not.toContain('描述:');
            expect(out).toContain('自由构思');
            expect(out).toContain('身份、起始地点与当前时间');
          }
          expect(
            out.endsWith(
              '（注意：生成初始剧情时，先检查上述内容是否完整，如不完整，必须参考相关设定进行完善。）',
            ),
          ).toBe(true);

          for (const phrase of DROPPED) expect(out).not.toContain(phrase);
        });
      }
    }
  }

  it('<user> 全部替换为主角名', () => {
    const out = buildOpeningPrompt(base('direct', SCENARIOS[0][1]));
    expect(out).toContain('描述: 艾琳在驿站醒来，艾琳的行囊还在身边。');
  });

  it('自定义开局沿用调用方给的标题', () => {
    const out = buildOpeningPrompt(base('direct_cached', SCENARIOS[1][1]));
    expect(out).toContain('【初始开局剧情】\n自定义开局\n描述: 艾琳站在港口。');
  });

  it('命定核心为空白时不写该行', () => {
    const out = buildOpeningPrompt(base('agent', null, '  '));
    expect(out).not.toContain('命定核心');
  });

  it('未给生日（缺省或 null）时与原版式逐字节一致', () => {
    const expected = [
      '【剧情生成上下文】',
      '角色、属性、金钱、装备、背包、技能等结构化数据已写入 <direct_state>。',
      '',
      '以下只提供需要创作的开局。',
      '姓名: 艾琳',
      '身份: 流浪佣兵',
      '性别: 女',
      '年龄: 24岁',
      '起始地点: 灰石镇',
      '命定核心: 星辉之心',
      '【第一轮变量更新要求】',
      '第一轮 AI 回复必须同步更新 <direct_state> 中的以下字段：',
      '',
      '* 时间：在 direct_updates 的 time.delta_time 中写入开局这一幕实际经过的分钟数（非负有限数）。',
      '* 地点：在 direct_updates 的 state.characters.replace 中以 path=location 写入主角本轮结束时所在的地点。',
      '',
      '【初始开局剧情】',
      '边境驿站',
      '描述: 艾琳在驿站醒来，艾琳的行囊还在身边。',
      '根据以上内容，生成一个符合描述和情景的初始剧情！',
      '（注意：生成初始剧情时，先检查上述内容是否完整，如不完整，必须参考相关设定进行完善。）',
    ].join('\n');
    const input = base('direct', SCENARIOS[0][1], '星辉之心');
    expect(buildOpeningPrompt(input)).toBe(expected);
    expect(buildOpeningPrompt({ ...input, birthday: null })).toBe(expected);
    expect(buildOpeningPrompt({ ...input, birthday: undefined })).toBe(expected);
  });

  it('给了生日时紧跟年龄行写入「生日: M月D日」', () => {
    for (const mode of MODES) {
      const out = buildOpeningPrompt({ ...base(mode, null), birthday: { month: 3, day: 15 } });
      expect(out).toContain('年龄: 24岁\n生日: 3月15日\n起始地点: 灰石镇');
      expect(out.match(/生日:/g)).toHaveLength(1);
    }
  });

  it('姓名为空时兜底为「未命名」', () => {
    const out = buildOpeningPrompt({ ...base('agent', null), name: '  ' });
    expect(out).toContain('姓名: 未命名');
  });
});
