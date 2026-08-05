/**
 * image-prompt-agent.test.ts — 侧链两个纯函数（设计 §8.5，测试清单 §14）
 *
 * 断言取自设计的测试表：
 *   三个标签正常抽出 · **模型在前面写了废话仍能抽到** · 缺 `<image_prompt>` →
 *   `prompt-agent` 失败而**不是**猜一个 · 输出已过 `normalizeTagString` ·
 *   `buildImagePromptInput` 带上地点与正文且**剥掉了全部标记**
 */

import { describe, expect, it } from 'vitest';

import {
  buildImagePromptInput,
  callImagePromptAgent,
  formatImagePromptRequest,
  parseImagePromptOutput,
} from './image-prompt-agent';
import type { ImagePromptAgentDeps, ImagePromptClient } from './image-prompt-agent';
import type { AgentConfig, AgentContext, ApiEndpoint } from './types';
import type { ImagePromptRequest, SceneImageMarker } from './types-image';

const marker = (over: Partial<SceneImageMarker> = {}): SceneImageMarker => ({
  type: 'scene_image',
  rawContent: '',
  position: 0,
  bodyText: '苏婉在篝火边说起家乡',
  title: '篝火夜话',
  characters: ['苏婉'],
  ...over,
});

// ═══════════════════════════════════════════════════════════
// buildImagePromptInput
// ═══════════════════════════════════════════════════════════

describe('buildImagePromptInput', () => {
  it('带上地点与所属消息正文', () => {
    const req = buildImagePromptInput(marker(), '篝火噼啪作响。', '风语村', 'general');
    expect(req.location).toBe('风语村');
    expect(req.narrative).toBe('篝火噼啪作响。');
    expect(req.intent).toBe('苏婉在篝火边说起家乡');
    expect(req.characters).toEqual(['苏婉']);
    expect(req.rating).toBe('general');
  });

  it('🔴 正文剥掉全部标记 —— 不只是 scene_image', () => {
    const text = [
      '篝火噼啪作响。',
      '<scene_image title="篝火夜话" characters="苏婉">苏婉在篝火边说起家乡</scene_image>',
      '<play_audio situation="日常"/>',
      '<combat_trigger>山贼三人</combat_trigger>',
      '她把手伸向火堆。',
    ].join('\n');

    const req = buildImagePromptInput(marker(), text, '风语村', 'general');

    expect(req.narrative).not.toContain('<');
    expect(req.narrative).not.toContain('scene_image');
    expect(req.narrative).not.toContain('combat_trigger');
    expect(req.narrative).not.toContain('play_audio');
    // 标记里的正文（"山贼三人"）也一并没了 —— 剥的是整块，不是只剥标签
    expect(req.narrative).not.toContain('山贼三人');
    expect(req.narrative).toContain('篝火噼啪作响。');
    expect(req.narrative).toContain('她把手伸向火堆。');
  });

  it('地点缺省 / 空串 / 纯空白 → 不占位', () => {
    expect(buildImagePromptInput(marker(), '正文', undefined, 'general').location).toBeUndefined();
    expect(buildImagePromptInput(marker(), '正文', '', 'general').location).toBeUndefined();
    expect(buildImagePromptInput(marker(), '正文', '   ', 'general').location).toBeUndefined();
  });

  it('intent 是那句中文原文 —— 全角标点不被归一化改坏', () => {
    const req = buildImagePromptInput(
      marker({ bodyText: '  苏婉低声说：「我很久没回去了。」  ' }),
      '正文',
      undefined,
      'sensitive',
    );
    // 只 trim，标点原样
    expect(req.intent).toBe('苏婉低声说：「我很久没回去了。」');
  });

  it('角色名原样、不去重不排序，且与标记数组不共享引用', () => {
    const m = marker({ characters: ['苏婉', '林越', '苏婉'] });
    const req = buildImagePromptInput(m, '正文', undefined, 'general');
    expect(req.characters).toEqual(['苏婉', '林越', '苏婉']);
    req.characters.push('入侵者');
    expect(m.characters).toEqual(['苏婉', '林越', '苏婉']);
  });

  it('rating 原样透传（钳位不在本层重算一份）', () => {
    expect(buildImagePromptInput(marker(), '正文', undefined, 'explicit').rating).toBe('explicit');
  });
});

// ═══════════════════════════════════════════════════════════
// parseImagePromptOutput
// ═══════════════════════════════════════════════════════════

describe('parseImagePromptOutput', () => {
  it('三个标签正常抽出', () => {
    const raw = [
      '<image_prompt>tavern interior, warm candlelight, sitting, campfire</image_prompt>',
      '<image_negative>modern clothing</image_negative>',
      '<image_desc>苏婉第一次说起她的家乡</image_desc>',
    ].join('\n');

    const result = parseImagePromptOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenePrompt).toBe('tavern interior, warm candlelight, sitting, campfire');
    expect(result.value.sceneNegative).toBe('modern clothing');
    expect(result.value.desc).toBe('苏婉第一次说起她的家乡');
  });

  it('★模型在前面写了一段废话，仍然抽得到', () => {
    const raw = [
      '好的，我来把这个场景转换成标签：',
      '首先确认出场角色是苏婉，时间是夜晚，所以我会用 campfire 和 night。',
      '',
      '<image_prompt>campfire, night, 2girls</image_prompt>',
      '<image_desc>篝火边的夜话</image_desc>',
    ].join('\n');

    const result = parseImagePromptOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenePrompt).toBe('campfire, night, 2girls');
    expect(result.value.desc).toBe('篝火边的夜话');
  });

  it('★废话里复述了一遍格式 → 锚在最后一处真正的答案上', () => {
    const raw = [
      '我会把结果用 <image_prompt>标签名写在这里</image_prompt> 这样的形式包裹起来。',
      '<image_prompt>forest, rain, 1girl</image_prompt>',
    ].join('\n');

    const result = parseImagePromptOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenePrompt).toBe('forest, rain, 1girl');
  });

  it('代码块围栏包着也照样抽得到', () => {
    const raw = '```xml\n<image_prompt>snow, mountain</image_prompt>\n```';
    const result = parseImagePromptOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenePrompt).toBe('snow, mountain');
  });

  it('漏写闭合标签也认（下一个已知开标签就是右边界）', () => {
    const raw = '<image_prompt>tavern, night\n<image_desc>酒馆之夜</image_desc>';
    const result = parseImagePromptOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenePrompt).toBe('tavern, night');
    expect(result.value.desc).toBe('酒馆之夜');
  });

  it('大小写与属性都容忍', () => {
    const raw = '<IMAGE_PROMPT lang="en">tavern, night</IMAGE_PROMPT>';
    const result = parseImagePromptOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenePrompt).toBe('tavern, night');
  });

  it('★输出已过 normalizeTagString（全角逗号 / 换行 / 《》/ 首尾逗号）', () => {
    const raw = [
      '<image_prompt>tavern interior，warm candlelight、sitting,',
      'campfire,,  night, 《lora:foo:0.8》,</image_prompt>',
      '<image_negative>modern clothing，text</image_negative>',
    ].join('\n');

    const result = parseImagePromptOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenePrompt).toBe(
      'tavern interior, warm candlelight, sitting, campfire, night, <lora:foo:0.8>',
    );
    expect(result.value.sceneNegative).toBe('modern clothing, text');
  });

  it('权重语法在归一化之后一个字符不改', () => {
    const raw = '<image_prompt>{{campfire}}, [[blur]], -0.8::feet::</image_prompt>';
    const result = parseImagePromptOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenePrompt).toBe('{{campfire}}, [[blur]], -0.8::feet::');
  });

  it('缺 <image_negative> / <image_desc> 不影响成功，各自退化成空串', () => {
    const result = parseImagePromptOutput('<image_prompt>campfire, night</image_prompt>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sceneNegative).toBe('');
    expect(result.value.desc).toBe('');
  });

  it('desc 走 sanitizeCaption：折叠空白 + 按码位截断，且中文标点保留', () => {
    const long = '苏'.repeat(80);
    const result = parseImagePromptOutput(
      `<image_prompt>a</image_prompt><image_desc>  她说：「回不去了」\n\n${long}</image_desc>`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.desc.startsWith('她说：「回不去了」 苏')).toBe(true);
    expect([...result.value.desc].length).toBe(60);
  });

  // ── 明确失败，不猜 ──────────────────────────────────────

  it('★抽不到 <image_prompt> → prompt-agent 失败，而不是猜一个出来', () => {
    const raw = '好的，场景标签是：tavern interior, warm candlelight, sitting';
    const result = parseImagePromptOutput(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('prompt-agent');
    expect(result.retryable).toBe(true);
    expect(result.message).toBe('提示词生成失败了，点重试；或自己写一份');
    // detail 只进 console 与记录，但要能看出模型说了什么
    expect(result.detail).toContain('tavern interior');
  });

  it('只有别的标签、唯独没有 <image_prompt> → 一样是明确失败', () => {
    const raw = '<image_negative>modern clothing</image_negative><image_desc>篝火夜话</image_desc>';
    const result = parseImagePromptOutput(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('prompt-agent');
  });

  it('标签在但正文为空 / 只有标点 → 明确失败（归一化之后是空串）', () => {
    for (const raw of [
      '<image_prompt></image_prompt>',
      '<image_prompt>   \n  </image_prompt>',
      '<image_prompt>，、；</image_prompt>',
    ]) {
      const result = parseImagePromptOutput(raw);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.kind).toBe('prompt-agent');
    }
  });

  it('空输出不抛异常，走同一条失败路径', () => {
    const result = parseImagePromptOutput('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('prompt-agent');
  });
});

// ═══════════════════════════════════════════════════════════
// formatImagePromptRequest（② 的入参装配，纯函数）
// ═══════════════════════════════════════════════════════════

describe('formatImagePromptRequest', () => {
  const req = (over: Partial<ImagePromptRequest> = {}): ImagePromptRequest => ({
    intent: '苏婉在篝火边说起家乡',
    characters: ['苏婉', '林越'],
    narrative: '篝火噼啪作响。',
    rating: 'general',
    ...over,
  });

  it('短字段在前、正文在最后', () => {
    const text = formatImagePromptRequest(req({ location: '风语村' }));
    expect(text.indexOf('画面意图')).toBeLessThan(text.indexOf('所属正文'));
    expect(text).toContain('出场角色: 苏婉、林越');
    expect(text).toContain('当前地点: 风语村');
    expect(text).toContain('篝火噼啪作响。');
  });

  it('没有地点 / 没有角色 / 没有正文时不留空行占位', () => {
    const text = formatImagePromptRequest(req({ characters: [], narrative: '  ' }));
    expect(text).not.toContain('当前地点');
    expect(text).not.toContain('出场角色');
    expect(text).not.toContain('所属正文');
  });

  it('分级出现的是中文说明，不是 rating:* 标签（标签由 Code 追加）', () => {
    expect(formatImagePromptRequest(req({ rating: 'explicit' }))).toContain('分级: 成人向');
    expect(formatImagePromptRequest(req({ rating: 'explicit' }))).not.toContain('rating:');
  });
});

// ═══════════════════════════════════════════════════════════
// callImagePromptAgent（② 中间那次调用）
// ═══════════════════════════════════════════════════════════

describe('callImagePromptAgent', () => {
  const context = (): AgentContext => ({
    userInput: '',
    history: [],
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
  });

  const endpoint = (): ApiEndpoint =>
    ({ id: 'ep', name: 'ep', baseUrl: '', apiKey: '', defaultModel: 'cheap-model' }) as ApiEndpoint;

  const config = (over: Partial<AgentConfig> = {}): AgentConfig =>
    ({
      agentId: 'image_prompt',
      enabled: true,
      apiEndpointId: 'ep',
      model: '',
      temperature: 0.3,
      maxTokens: 1024,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      retryOnFail: false,
      timeout: 0,
      userId: '',
      promptTemplate: { fixedSystem: '', fixedExamples: '' },
      worldBookIds: [],
      systemPrompt: '把中文场景转成 danbooru 标签。',
      ...over,
    }) as AgentConfig;

  function client(impl: ImagePromptClient['chat']): {
    deps: ImagePromptAgentDeps;
    seen: Array<{ agentId: string; request: Parameters<ImagePromptClient['chat']>[0] }>;
  } {
    const seen: Array<{ agentId: string; request: Parameters<ImagePromptClient['chat']>[0] }> = [];
    return {
      seen,
      deps: {
        clientFactory: (agentId) => ({
          chat: (request, signal) => {
            seen.push({ agentId, request });
            return impl(request, signal);
          },
        }),
      },
    };
  }

  const baseReq = () => ({
    saveId: 'save-1',
    request: {
      intent: '苏婉在篝火边说起家乡',
      characters: ['苏婉'],
      narrative: '篝火噼啪作响。',
      rating: 'general' as const,
    },
    context: context(),
    endpoint: endpoint(),
    configs: [config()],
  });

  it('装配 → 调用 → 抽取，三步走通', async () => {
    const { deps, seen } = client(async () => ({
      output:
        '<image_prompt>campfire, night, 1girl</image_prompt><image_desc>篝火夜话</image_desc>',
      rawResponse: '',
    }));

    const result = await callImagePromptAgent(baseReq(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenePrompt).toBe('campfire, night, 1girl');
    expect(result.value.desc).toBe('篝火夜话');

    // 用的是 image_prompt 这个 agentId（→ 设置页那份配置、那个 API 池）
    expect(seen[0].agentId).toBe('image_prompt');
    // systemPrompt 与本次需求都进了消息体
    const sent = JSON.stringify(seen[0].request.messages);
    expect(sent).toContain('把中文场景转成 danbooru 标签。');
    expect(sent).toContain('苏婉在篝火边说起家乡');
    // 采样参数取自该 agent 的配置，不是写死的
    expect(seen[0].request.temperature).toBe(0.3);
    expect(seen[0].request.maxTokens).toBe(1024);
  });

  it('🔴 普通补全，不带 tools（非 Agentic，§8.5）', async () => {
    const { deps, seen } = client(async () => ({
      output: '<image_prompt>campfire</image_prompt>',
      rawResponse: '',
    }));
    await callImagePromptAgent(baseReq(), deps);
    expect(seen[0].request).not.toHaveProperty('tools');
  });

  it('客户端抛错 → prompt-agent 失败值，不抛穿', async () => {
    const { deps } = client(async () => {
      throw new Error('网络断了');
    });
    const result = await callImagePromptAgent(baseReq(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('prompt-agent');
    expect(result.detail).toContain('网络断了');
  });

  it('客户端返回 error 字段 → 同一条失败路径', async () => {
    const { deps } = client(async () => ({ output: null, rawResponse: '', error: '429 限流' }));
    const result = await callImagePromptAgent(baseReq(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('prompt-agent');
  });

  it('模型只写废话（抽不到标签）→ 明确失败，绝不猜一个出来', async () => {
    const { deps } = client(async () => ({
      output: '好的，我这就把这个场景转换成标签。',
      rawResponse: '',
    }));
    const result = await callImagePromptAgent(baseReq(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('prompt-agent');
  });

  it('signal 原样透传给客户端（切存档要能取消）', async () => {
    let seenSignal: AbortSignal | undefined;
    const { deps } = client(async (_req, signal) => {
      seenSignal = signal;
      return { output: '<image_prompt>campfire</image_prompt>', rawResponse: '' };
    });
    const ac = new AbortController();
    await callImagePromptAgent({ ...baseReq(), signal: ac.signal }, deps);
    expect(seenSignal).toBe(ac.signal);
  });
});
