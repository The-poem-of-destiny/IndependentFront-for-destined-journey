import { describe, it, expect } from 'vitest';
import { rescueStoryOutput } from './story-rescue';
import type { AgentResult } from './types';

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    agentId: 'story',
    output: '',
    rawResponse: '',
    reasoning: '',
    tokensUsed: 0,
    cacheHit: false,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    completionTokens: 0,
    duration: 0,
    ...overrides,
  };
}

describe('rescueStoryOutput', () => {
  describe('场景 1: 正文吞进思维链 (raw 空)', () => {
    it('reasoning 含 <maintext> → 救回正文 + options', () => {
      const r = makeResult({
        rawResponse: '',
        reasoning:
          'Step 0: 思考...\n\n<maintext>你走进了森林。</maintext>\n<options>\n1. 前进\n</options>',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).toContain('<maintext>你走进了森林。</maintext>');
      expect(r.rawResponse).toContain('<options>');
      expect(r.rawResponse).not.toContain('Step 0');
      expect(r.output).toBe(r.rawResponse);
    });

    it('思维链前部提及 <maintext> 格式词 → 取最后一个，不误切', () => {
      const r = makeResult({
        rawResponse: '',
        reasoning:
          'Step 1: 记得用 <maintext> 标签包裹正文\nStep 2: ...\n\n<maintext>真正文</maintext>',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).toBe('<maintext>真正文</maintext>');
      expect(r.rawResponse).not.toContain('Step 1');
      expect(r.rawResponse).not.toContain('标签');
    });

    it('raw 空 + reasoning 无 <maintext> → 不救', () => {
      const r = makeResult({ rawResponse: '', reasoning: '纯思维链，没有任何 maintext 标签' });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toBe('');
    });

    it('清洗结尾代码块围栏', () => {
      const r = makeResult({
        rawResponse: '',
        reasoning: 'Final step:\n<maintext>正文</maintext>\n```',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).toBe('<maintext>正文</maintext>');
    });

    it('真实坏轮样本（思维链 15 步 + 正文吞尾部）→ 救回完整正文', () => {
      const reasoning =
        '首先确认Recorder身份...\nStep 1: 分析输入...\nStep 14: 格式回顾\nFinal step: 闭合\n\n```\n\n<maintext>你站在通往地面的石阶前，深吸了一口气。</maintext>\n<options>\n1. 继续前进\n2. 加快脚步\n</options>';
      const r = makeResult({ rawResponse: '', reasoning });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse.startsWith('<maintext>')).toBe(true);
      expect(r.rawResponse).toContain('石阶前');
      expect(r.rawResponse).toContain('<options>');
      expect(r.rawResponse).not.toContain('Recorder');
      expect(r.rawResponse).not.toContain('Step 1');
    });
  });

  describe('场景 2: 思维链泄漏进正文 (raw 非空)', () => {
    it('raw 开头是思维链 → 截掉 <maintext> 之前', () => {
      const r = makeResult({
        rawResponse:
          '首先确认Recorder身份，回顾规则。\n然后开始写。\n<maintext>你走进了森林。</maintext>\n<options>\n1. 前进\n</options>',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).not.toContain('首先确认');
      expect(r.rawResponse).not.toContain('回顾规则');
      expect(r.rawResponse.startsWith('<maintext>')).toBe(true);
      expect(r.output).toBe(r.rawResponse);
    });

    it('思维链里提及 <maintext> 格式词 → 取最后一个', () => {
      const r = makeResult({
        rawResponse: '用 <maintext> 包裹正文哦\n然后开始写\n<maintext>真正文</maintext>',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).toBe('<maintext>真正文</maintext>');
      expect(r.rawResponse).not.toContain('包裹正文');
    });

    it('raw 无标签（裸正文）→ 不动', () => {
      const r = makeResult({ rawResponse: '一段没有标签的裸正文' });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toBe('一段没有标签的裸正文');
    });

    it('<maintext> 已在最开头 → 不动', () => {
      const raw = '<maintext>正文</maintext>';
      const r = makeResult({ rawResponse: raw });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toBe(raw);
    });

    it('raw 仅空白 → 走场景 1 逻辑', () => {
      const r = makeResult({
        rawResponse: '   \n  ',
        reasoning: '<maintext>正文</maintext>',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).toBe('<maintext>正文</maintext>');
    });
  });

  describe('场景 3: 思维链混进 <maintext> 内部 (--- 分隔的计划块)', () => {
    it('<maintext> 内部有 --- 分隔的计划块 → 剥掉计划，保留正文', () => {
      const raw =
        '<maintext>\n' +
        '2. 转述融入：输入需在正文中体现。\n' +
        '3. 货币单位：无涉及。\n\n' +
        'Final step: 生成思维链闭合标签，开始正文。\n\n' +
        '---\n\n' +
        '我将严格将叙事停止在生产/战斗开始的前一刻，随后在后生成 <craft_request> 制作意图。\n\n' +
        '---\n\n' +
        '卡牌在你掌心微微发烫，那道裂纹无声地嘲笑着你的无力。\n</maintext>';
      const r = makeResult({ rawResponse: raw });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse.startsWith('<maintext>')).toBe(true);
      expect(r.rawResponse).toContain('卡牌在你掌心');
      expect(r.rawResponse).not.toContain('转述融入');
      expect(r.rawResponse).not.toContain('Final step');
      expect(r.rawResponse).not.toContain('我将严格');
    });

    it('<maintext> 内部无 --- 分隔 → 无法安全判定，不动', () => {
      const raw = '<maintext>一段开头带数字"2."的叙事正文，但没有 --- 分隔。</maintext>';
      const r = makeResult({ rawResponse: raw });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toBe(raw);
    });

    it('顶部第一个块就是正文（不含思维链元语言）→ 不动', () => {
      const raw =
        '<maintext>\n叙事第一段。\n\n---\n\n叙事第二段（场景切换）。\n</maintext>';
      const r = makeResult({ rawResponse: raw });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toBe(raw);
    });
  });

  describe('场景 4: CoT 思考注释残留', () => {
    it('剥掉 <!-- itemThink: ... --> 注释', () => {
      const raw =
        '<maintext>你抓住那颗光点。\n\n<!-- itemThink:\n- 实体类型: 技能\n- 品质: 传说\n-->\n<item_info>技能卡片</item_info>\n</maintext>';
      const r = makeResult({ rawResponse: raw });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).not.toContain('itemThink');
      expect(r.rawResponse).not.toContain('实体类型');
      expect(r.rawResponse).toContain('<item_info>');
      expect(r.rawResponse).toContain('你抓住那颗光点');
    });

    it('剥掉多种 Think 注释 (itemThink/taskThink/charThink/actionThink)', () => {
      const raw =
        '<maintext>正文。\n<!-- charThink: 角色思考 -->\n<!-- taskThink: 任务思考 -->\n<!-- actionThink: 行动思考 -->\n结尾。\n</maintext>';
      const r = makeResult({ rawResponse: raw });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).not.toContain('Think');
      expect(r.rawResponse).toContain('正文');
      expect(r.rawResponse).toContain('结尾');
    });

    it('不误剥非 Think 的 HTML 注释 (如 <!-- craft_request expects="..." -->)', () => {
      const raw = '<maintext>正文。\n<!-- craft_request expects="修补封印" -->\n结尾。\n</maintext>';
      const r = makeResult({ rawResponse: raw });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toContain('craft_request');
    });
  });

  describe('真实坏轮样本 (场景 3 + 4 组合)', () => {
    it('用户反馈: maintext 内计划块 + CoT 注释 + 正文 → 全部清理', () => {
      const raw =
        '<maintext>\n' +
        '2. 转述融入：Participant输入需在正文中体现。\n' +
        '3. 货币单位：无涉及。\n\n' +
        'Final step: 生成思维链闭合标签，开始正文。\n\n' +
        '---\n\n' +
        '我将严格将叙事停止，随后生成 <craft_request>。\n\n' +
        '---\n\n' +
        '卡牌在你掌心微微发烫。\n\n' +
        '<!-- itemThink:\n- 实体类型: 技能\n-->\n' +
        '<item_info>神代魔法知识</item_info>\n\n' +
        '知识涌入你的脑海。\n' +
        '<!-- taskThink: 不涉及任务 -->\n' +
        '<!-- craft_request expects="修补封印" -->';
      const r = makeResult({ rawResponse: raw });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse.startsWith('<maintext>')).toBe(true);
      // 计划块剥掉了
      expect(r.rawResponse).not.toContain('转述融入');
      expect(r.rawResponse).not.toContain('Final step');
      expect(r.rawResponse).not.toContain('我将严格');
      // CoT 注释剥掉了
      expect(r.rawResponse).not.toContain('itemThink');
      expect(r.rawResponse).not.toContain('taskThink');
      // 正文与结构标签保留
      expect(r.rawResponse).toContain('卡牌在你掌心');
      expect(r.rawResponse).toContain('<item_info>');
      expect(r.rawResponse).toContain('知识涌入你的脑海');
      // 非 Think 的标记注释保留
      expect(r.rawResponse).toContain('craft_request');
    });
  });

  describe('正常轮不受影响', () => {
    it('完整正常输出 → 不动', () => {
      const raw = '<maintext>正文</maintext>\n<options>\n1. A\n</options>';
      const r = makeResult({ rawResponse: raw, output: raw });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toBe(raw);
    });
  });
});
