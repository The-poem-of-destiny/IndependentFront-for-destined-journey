import { describe, expect, it } from 'vitest';
import type { SceneImageRecord } from '@engine/types-image';
import {
  missingPresetHint,
  resolveSceneImageView,
  SCENE_IMAGE_FAILED_FALLBACK,
  SCENE_IMAGE_UNTITLED,
} from './scene-image-view';

const NOW = 1_700_000_000_000;

function record(over: Partial<SceneImageRecord> = {}): SceneImageRecord {
  return {
    id: 'simg_1',
    saveId: 'save_1',
    messageId: 'msg_1',
    anchorKind: 'marker',
    occurrence: 0,
    take: 0,
    turn: 3,
    status: 'done',
    source: 'auto',
    title: '雨夜的酒馆',
    description: '苏婉第一次说起她的家乡',
    intent: '苏婉坐在壁炉旁，窗外下着雨',
    scenePrompt: 'tavern interior',
    sceneNegative: '',
    characters: ['苏婉'],
    rating: 'general',
    positive: '',
    negative: '',
    model: 'nai-diffusion-4-5-full',
    params: {},
    createdAt: NOW - 60_000,
    ...over,
  };
}

const MARKER = { title: '雨夜的酒馆', bodyText: '苏婉坐在壁炉旁，窗外下着雨' };

describe('resolveSceneImageView — §10.2 真值表', () => {
  it('无记录 + off：什么都不渲染，标记隐形', () => {
    expect(resolveSceneImageView({ mode: 'off', marker: MARKER, now: NOW })).toEqual({
      kind: 'hidden',
    });
  });

  it('无记录 + manual：出「生成插画」按钮，带标题与那句中文', () => {
    const view = resolveSceneImageView({ mode: 'manual', marker: MARKER, now: NOW });

    expect(view).toEqual({ kind: 'offer', title: MARKER.title, intent: MARKER.bodyText });
  });

  it('🔴 无记录 + auto：出的仍然是按钮，绝不解释成「没记录就去生成」', () => {
    // D15/D21：自动档只对编排器刚产出的那条消息开火。渲染层若把 auto 读成
    // 「补一张」，把开关从手动拨到自动、或滚回历史消息，都会追溯烧钱。
    const auto = resolveSceneImageView({ mode: 'auto', marker: MARKER, now: NOW });
    const manual = resolveSceneImageView({ mode: 'manual', marker: MARKER, now: NOW });

    expect(auto.kind).toBe('offer');
    expect(auto).toEqual(manual);
  });

  it('story 没写标题时按钮上仍有一个可读标签', () => {
    const view = resolveSceneImageView({
      mode: 'manual',
      marker: { title: '   ', bodyText: '街市' },
      now: NOW,
    });

    expect(view).toMatchObject({ kind: 'offer', title: SCENE_IMAGE_UNTITLED, intent: '街市' });
  });

  it('queued 与 generating 判成两个不同的态（D35）', () => {
    const queued = resolveSceneImageView({
      mode: 'manual',
      record: record({ status: 'queued' }),
      now: NOW,
    });
    const generating = resolveSceneImageView({
      mode: 'manual',
      record: record({ status: 'generating', startedAt: NOW - 12_000 }),
      now: NOW,
    });

    expect(queued.kind).toBe('queued');
    expect(generating.kind).toBe('generating');
  });

  it('queued 报队列位次，缺省按第 1 位', () => {
    const withPos = resolveSceneImageView({
      mode: 'auto',
      record: record({ status: 'queued' }),
      queuePosition: 3,
      now: NOW,
    });
    const without = resolveSceneImageView({
      mode: 'auto',
      record: record({ status: 'queued' }),
      now: NOW,
    });

    expect(withPos).toMatchObject({ kind: 'queued', position: 3 });
    expect(without).toMatchObject({ kind: 'queued', position: 1 });
  });

  it('🔴 已用秒数按 startedAt 算，不是 createdAt（D37）', () => {
    // createdAt 是入队时刻：拿它算的话，排在第三位的图一开始转圈就显示「已用 180 秒」
    const view = resolveSceneImageView({
      mode: 'auto',
      record: record({
        status: 'generating',
        createdAt: NOW - 180_000,
        startedAt: NOW - 7_400,
      }),
      now: NOW,
    });

    expect(view).toMatchObject({ kind: 'generating', elapsedSec: 7 });
  });

  it('startedAt 缺席时报 0 秒，而不是一个吓人的数字', () => {
    const view = resolveSceneImageView({
      mode: 'auto',
      record: record({ status: 'generating', createdAt: NOW - 900_000 }),
      now: NOW,
    });

    expect(view).toMatchObject({ kind: 'generating', elapsedSec: 0 });
  });

  it('三档开关不影响已有记录的渲染（真值表后四行都写着「任意」）', () => {
    for (const mode of ['off', 'manual', 'auto'] as const) {
      expect(resolveSceneImageView({ mode, record: record(), now: NOW }).kind).toBe('done');
    }
  });

  it('done：带说明与多 take 角标', () => {
    const view = resolveSceneImageView({
      mode: 'off',
      record: record(),
      takeIndex: 2,
      takeCount: 3,
      now: NOW,
    });

    expect(view).toMatchObject({
      kind: 'done',
      recordId: 'simg_1',
      title: '雨夜的酒馆',
      description: '苏婉第一次说起她的家乡',
      takeIndex: 2,
      takeCount: 3,
    });
  });

  it('🔴 blobDropped 的 done 记录不渲染成破图（D47）', () => {
    const view = resolveSceneImageView({
      mode: 'off',
      record: record({ blobDropped: true }),
      now: NOW,
    });

    expect(view.kind).toBe('dropped');
    // 这一格记的是「这张图存在过」，配方还在，随时能重画 —— 不是一个空洞
    expect(view).toMatchObject({ recordId: 'simg_1', title: '雨夜的酒馆' });
  });

  it('missing-preset 告警存在时把名字交出去（D41）', () => {
    const view = resolveSceneImageView({
      mode: 'off',
      record: record(),
      missingPresets: ['苏婉'],
      now: NOW,
    });

    expect(view).toMatchObject({ kind: 'done', missingPresets: ['苏婉'] });
  });

  it('failed：原样交出可读原因，绝不静默留白', () => {
    const view = resolveSceneImageView({
      mode: 'off',
      record: record({
        status: 'failed',
        error: 'NovelAI 限流了，过一会儿再试',
        errorKind: 'rate-limit',
      }),
      now: NOW,
    });

    expect(view).toMatchObject({
      kind: 'failed',
      message: 'NovelAI 限流了，过一会儿再试',
      retryable: true,
    });
  });

  it('failed：注定失败的那几类不给「重试」按钮', () => {
    for (const kind of ['auth', 'payment', 'bad-request'] as const) {
      const view = resolveSceneImageView({
        mode: 'off',
        record: record({ status: 'failed', error: '不行', errorKind: kind }),
        now: NOW,
      });
      expect(view).toMatchObject({ kind: 'failed', retryable: false });
    }
  });

  it('failed：没有原因文字也要说一句话', () => {
    const view = resolveSceneImageView({
      mode: 'off',
      record: record({ status: 'failed' }),
      now: NOW,
    });

    expect(view).toMatchObject({
      kind: 'failed',
      message: SCENE_IMAGE_FAILED_FALLBACK,
      // 分类缺席按「可以再试」处理：把能救的一格画成死路等于让玩家白丢一张图
      retryable: true,
    });
  });

  it('有记录时标题/那句中文取自记录，而不是标记', () => {
    const view = resolveSceneImageView({
      mode: 'manual',
      record: record({ status: 'queued', title: '记录里的标题', intent: '记录里的描述' }),
      marker: MARKER,
      now: NOW,
    });

    expect(view).toMatchObject({ title: '记录里的标题', intent: '记录里的描述' });
  });

  it('message-end 的图带没有标记也能渲染', () => {
    const view = resolveSceneImageView({
      mode: 'manual',
      record: record({ anchorKind: 'message-end', status: 'generating', startedAt: NOW - 3_000 }),
      now: NOW,
    });

    expect(view).toMatchObject({ kind: 'generating', title: '雨夜的酒馆', elapsedSec: 3 });
  });
});

describe('missingPresetHint', () => {
  it('没有缺席者时不出这一行', () => {
    expect(missingPresetHint([])).toBe('');
  });

  it('一个人时直接点名', () => {
    expect(missingPresetHint(['苏婉'])).toContain('苏婉');
    expect(missingPresetHint(['苏婉'])).toContain('随机');
  });

  it('多个人时只报第一个 + 总数（一行放得下才有人读）', () => {
    const hint = missingPresetHint(['苏婉', '林墨', '陈九']);

    expect(hint).toContain('苏婉');
    expect(hint).toContain('3 人');
    expect(hint).not.toContain('林墨');
  });
});
