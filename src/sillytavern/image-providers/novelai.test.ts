/**
 * novelai.test.ts — NAI V4.5 请求体装配 / 响应 zip 解包
 *
 * 这一份测试里真正承重的只有一条: **三重冗余一致**（设计 §5.4 / §6.1）。
 * V4 把同一份内容要在三处各写一遍，只填一处**不会报错，只会静默产出不对的图** ——
 * 没有断言的话，这种缺陷得靠肉眼看图才发现。
 *
 * 🔴 zip fixture 是**自造的**（`fflate.zipSync` + PNG 魔数），不是真 NAI 响应样本 ——
 *    手头没有实测响应（§6.3 的真机 curl 还没打）。它验证的是「我们的解包对一个合法 zip
 *    的行为」，**不能**用来证明 NAI 的 zip 里长什么样（条目命名、是否带目录项）。
 *    拿到真样本后请把它加成第二个 fixture，别替换这个。
 */

import { zipSync, strToU8 } from 'fflate';
import { describe, it, expect, vi } from 'vitest';

import type { ComposedPrompt } from '../types-image';

import { buildNaiRequest, parseNaiZip, type NaiOptions } from './novelai';

// ═══ 夹具 ═══

const OPTS: NaiOptions = {
  model: 'nai-diffusion-4-5-full',
  width: 1216,
  height: 832,
  steps: 23,
  scale: 4.5,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  ucPreset: 0,
};

function makePrompt(over: Partial<ComposedPrompt> = {}): ComposedPrompt {
  return {
    base: '1girl, tavern interior, warm candlelight, rating:general, location, very aesthetic, masterpiece, no text',
    baseNegative: 'lowres, aliasing, blurry, bad hands',
    characters: [],
    warnings: [],
    ...over,
  };
}

const TWO_CHARACTERS = [
  { name: '苏婉', positive: 'girl, silver hair, golden eyes', negative: 'blue eyes, hat' },
  { name: '雷恩', positive: 'boy, black hair, scar', negative: 'long hair' },
];

/** 最小合法 PNG 头 + 一点载荷。只要求「认得出是 PNG」，不要求能解码 */
function fakePng(tag: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag, tag]);
}

const ZIP_CONTENT_TYPE = 'application/x-zip-compressed';

// ═══ buildNaiRequest ═══

describe('buildNaiRequest —— 三重冗余（★ 本文件的要害）', () => {
  it('正向: input ≡ v4_prompt.caption.base_caption（逐字相同）', () => {
    const prompt = makePrompt();
    const body = buildNaiRequest(prompt, OPTS);

    expect(body.input).toBe(prompt.base);
    expect(body.parameters.v4_prompt.caption.base_caption).toBe(prompt.base);
    expect(body.parameters.v4_prompt.caption.base_caption).toBe(body.input);
  });

  it('负向: negative_prompt ≡ v4_negative_prompt.caption.base_caption（逐字相同）', () => {
    const prompt = makePrompt();
    const body = buildNaiRequest(prompt, OPTS);

    expect(body.parameters.negative_prompt).toBe(prompt.baseNegative);
    expect(body.parameters.v4_negative_prompt.caption.base_caption).toBe(prompt.baseNegative);
    expect(body.parameters.v4_negative_prompt.caption.base_caption).toBe(
      body.parameters.negative_prompt,
    );
  });

  it('角色: characterPrompts[i] ≡ 两处 char_captions[i]，且**顺序一致**', () => {
    const prompt = makePrompt({ characters: TWO_CHARACTERS });
    const { parameters } = buildNaiRequest(prompt, OPTS);

    expect(parameters.characterPrompts).toHaveLength(2);
    expect(parameters.v4_prompt.caption.char_captions).toHaveLength(2);
    expect(parameters.v4_negative_prompt.caption.char_captions).toHaveLength(2);

    for (let i = 0; i < TWO_CHARACTERS.length; i++) {
      const src = TWO_CHARACTERS[i];

      expect(parameters.characterPrompts[i].prompt).toBe(src.positive);
      expect(parameters.characterPrompts[i].uc).toBe(src.negative);
      expect(parameters.v4_prompt.caption.char_captions[i].char_caption).toBe(src.positive);
      expect(parameters.v4_negative_prompt.caption.char_captions[i].char_caption).toBe(
        src.negative,
      );
    }
  });

  it('角色顺序不被排序/去重动过 —— 数组顺序 = 阅读顺序（§6.2）', () => {
    // 名字倒序、正向串首字母倒序，任何一次"顺手排序"都会让这条红
    const characters = [
      { name: 'z', positive: 'zebra girl', negative: 'a' },
      { name: 'a', positive: 'apple boy', negative: 'z' },
      { name: 'm', positive: 'apple boy', negative: 'm' }, // 与上一条 positive 相同: 别去重
    ];
    const { parameters } = buildNaiRequest(makePrompt({ characters }), OPTS);

    expect(parameters.characterPrompts.map((c) => c.prompt)).toEqual([
      'zebra girl',
      'apple boy',
      'apple boy',
    ]);
    expect(parameters.v4_prompt.caption.char_captions.map((c) => c.char_caption)).toEqual([
      'zebra girl',
      'apple boy',
      'apple boy',
    ]);
    expect(parameters.v4_negative_prompt.caption.char_captions.map((c) => c.char_caption)).toEqual([
      'a',
      'z',
      'm',
    ]);
  });

  it('角色负向进各自的槽，**不**混进全局 negative_prompt', () => {
    const { parameters } = buildNaiRequest(makePrompt({ characters: TWO_CHARACTERS }), OPTS);

    expect(parameters.negative_prompt).not.toContain('blue eyes');
    expect(parameters.negative_prompt).not.toContain('long hair');
    expect(parameters.characterPrompts[0].uc).toBe('blue eyes, hat');
  });

  it('0 角色时三个数组都是 []（v4_* 信封照发，§6.3）', () => {
    const { parameters } = buildNaiRequest(makePrompt({ characters: [] }), OPTS);

    expect(parameters.characterPrompts).toEqual([]);
    expect(parameters.v4_prompt.caption.char_captions).toEqual([]);
    expect(parameters.v4_negative_prompt.caption.char_captions).toEqual([]);
    // 信封本身仍在
    expect(parameters.v4_prompt.use_order).toBe(true);
    expect(parameters.v4_negative_prompt.legacy_uc).toBe(false);
  });

  it('坐标恒 {0,0}，且每个槽位是**独立实例**（改一个不串改其它）', () => {
    const { parameters } = buildNaiRequest(makePrompt({ characters: TWO_CHARACTERS }), OPTS);

    expect(parameters.characterPrompts[0].center).toEqual({ x: 0, y: 0 });
    expect(parameters.v4_prompt.caption.char_captions[0].centers).toEqual([{ x: 0, y: 0 }]);

    parameters.characterPrompts[0].center.x = 3;
    expect(parameters.characterPrompts[1].center.x).toBe(0);
    expect(parameters.v4_prompt.caption.char_captions[0].centers[0].x).toBe(0);
  });

  it('🔴 不在这一层截断角色 —— 「最多 6 个」是 composePrompt 的事（截断 + 告警）', () => {
    const characters = Array.from({ length: 7 }, (_, i) => ({
      name: `c${i}`,
      positive: `p${i}`,
      negative: `n${i}`,
    }));
    const { parameters } = buildNaiRequest(makePrompt({ characters }), OPTS);

    expect(parameters.characterPrompts).toHaveLength(7);
    expect(parameters.v4_prompt.caption.char_captions).toHaveLength(7);
    expect(parameters.v4_negative_prompt.caption.char_captions).toHaveLength(7);
  });
});

describe('buildNaiRequest —— 请求体形状（照 §6.1 录制样本）', () => {
  it('🔴 正向在顶层 input；parameters.prompt 这个字段不存在', () => {
    const body = buildNaiRequest(makePrompt(), OPTS);

    expect(body.action).toBe('generate');
    expect(body.model).toBe('nai-diffusion-4-5-full');
    expect('prompt' in body.parameters).toBe(false);
    expect('uc' in body.parameters).toBe(false);
  });

  it('opts 逐项透传（含按模型各自编号的 ucPreset，§6.2）', () => {
    const { parameters } = buildNaiRequest(makePrompt(), {
      ...OPTS,
      model: 'nai-diffusion-4-full',
      width: 832,
      height: 1216,
      steps: 28,
      scale: 5,
      sampler: 'k_dpmpp_2m',
      noiseSchedule: 'native',
      ucPreset: 2,
    });

    expect(parameters.width).toBe(832);
    expect(parameters.height).toBe(1216);
    expect(parameters.steps).toBe(28);
    expect(parameters.scale).toBe(5);
    expect(parameters.sampler).toBe('k_dpmpp_2m');
    expect(parameters.noise_schedule).toBe('native');
    expect(parameters.ucPreset).toBe(2);
  });

  it('D9: n_samples 恒 1（多张靠多次请求，限额与计费按一次一张记账）', () => {
    expect(buildNaiRequest(makePrompt(), OPTS).parameters.n_samples).toBe(1);
    expect(
      buildNaiRequest(makePrompt({ characters: TWO_CHARACTERS }), OPTS).parameters.n_samples,
    ).toBe(1);
  });

  it('录制样本里那些固定值一个不少', () => {
    const { parameters } = buildNaiRequest(makePrompt(), OPTS);

    expect(parameters.params_version).toBe(3);
    expect(parameters.qualityToggle).toBe(true);
    expect(parameters.cfg_rescale).toBe(0);
    expect(parameters.dynamic_thresholding).toBe(false);
    expect(parameters.skip_cfg_above_sigma).toBeNull();
    expect(parameters.use_coords).toBe(false);
    expect(parameters.autoSmea).toBe(false);
    expect(parameters.prefer_brownian).toBe(true);
    expect(parameters.legacy).toBe(false);
    expect(parameters.legacy_uc).toBe(false);
    expect(parameters.legacy_v3_extend).toBe(false);
    expect(parameters.deliberate_euler_ancestral_bug).toBe(false);
    expect(parameters.add_original_image).toBe(true);
    expect(parameters.controlnet_strength).toBe(1);
    expect(parameters.normalize_reference_strength_multiple).toBe(true);
    expect(parameters.v4_prompt.use_coords).toBe(false);
    expect(parameters.v4_prompt.use_order).toBe(true);
  });

  it('整份 body 可 JSON 序列化且不含 undefined 洞', () => {
    const body = buildNaiRequest(makePrompt({ characters: TWO_CHARACTERS, seed: 7 }), OPTS);
    const round = JSON.parse(JSON.stringify(body)) as typeof body;

    expect(round).toEqual(body);
  });
});

describe('buildNaiRequest —— seed（本函数不产随机）', () => {
  it('opts.seed 优先于 prompt.seed', () => {
    const body = buildNaiRequest(makePrompt({ seed: 111 }), { ...OPTS, seed: 999 });
    expect(body.parameters.seed).toBe(999);
  });

  it('opts 没给时落到 prompt.seed（角色 pinnedSeed 不会被静默丢掉）', () => {
    const body = buildNaiRequest(makePrompt({ seed: 168874300 }), OPTS);
    expect(body.parameters.seed).toBe(168874300);
  });

  it('两处都没有 → **整个字段不发**（由 NAI 自己随机）', () => {
    const body = buildNaiRequest(makePrompt(), OPTS);
    expect('seed' in body.parameters).toBe(false);
  });

  it('🔴 同样的入参永远出同样的 body，且一次 Math.random 都不调', () => {
    const spy = vi.spyOn(Math, 'random');
    try {
      const prompt = makePrompt({ characters: TWO_CHARACTERS });
      const a = buildNaiRequest(prompt, OPTS);
      const b = buildNaiRequest(prompt, OPTS);

      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('不改动传进来的 ComposedPrompt', () => {
    const prompt = makePrompt({ characters: TWO_CHARACTERS });
    const before = JSON.stringify(prompt);
    buildNaiRequest(prompt, OPTS);
    expect(JSON.stringify(prompt)).toBe(before);
  });
});

// ═══ parseNaiZip ═══

describe('parseNaiZip', () => {
  it('合法 zip → 按条目顺序返回全部图片字节', () => {
    const png0 = fakePng(1);
    const png1 = fakePng(2);
    const zipped = zipSync({ 'image_0.png': png0, 'image_1.png': png1 });

    const result = parseNaiZip(zipped, ZIP_CONTENT_TYPE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(2);
    expect(Array.from(result.images[0])).toEqual(Array.from(png0));
    expect(Array.from(result.images[1])).toEqual(Array.from(png1));
  });

  it('单张（NAI 的常态: n_samples=1）', () => {
    const png = fakePng(9);
    const result = parseNaiZip(zipSync({ 'image_0.png': png }), ZIP_CONTENT_TYPE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
    expect(Array.from(result.images[0])).toEqual(Array.from(png));
  });

  it('没有扩展名但字节是 PNG 的条目照样认得', () => {
    const result = parseNaiZip(zipSync({ image_0: fakePng(3) }), ZIP_CONTENT_TYPE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
  });

  it('非图条目（说明文本 / 空条目）不计入', () => {
    const png = fakePng(4);
    const zipped = zipSync({
      'readme.txt': strToU8('not an image'),
      'empty.png': new Uint8Array(0),
      'image_0.png': png,
    });

    const result = parseNaiZip(zipped, ZIP_CONTENT_TYPE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
    expect(Array.from(result.images[0])).toEqual(Array.from(png));
  });

  /**
   * 🔴 2026-08-04 真机纠正：**字节是权威，content-type 只是线索**。
   *
   * 原实现先看 `contentType.includes('zip')`，不含就直接判失败。真机第一次成功出图时
   * NAI 报的是 `binary/octet-stream` —— 一张**已生成、已扣点数**的图被我们自己扔掉，
   * 还报成「返回了看不懂的内容」。下面这一组就是那次教训的回归。
   */
  it('🔴 content-type 是 binary/octet-stream（真机实测值）→ 照样解出图', () => {
    const result = parseNaiZip(zipSync({ 'image_0.png': fakePng(5) }), 'binary/octet-stream');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
  });

  it('🔴 content-type 说是 JSON 但字节确实是 zip → 信字节', () => {
    expect(parseNaiZip(zipSync({ 'image_0.png': fakePng(6) }), 'application/json').ok).toBe(true);
  });

  it('🔴 content-type 为空串也不影响 —— 缺个 header 不该毁掉一张付过钱的图', () => {
    expect(parseNaiZip(zipSync({ 'image_0.png': fakePng(7) }), '').ok).toBe(true);
  });

  it('content-type 大小写/带 charset 参数不影响判定', () => {
    const zipped = zipSync({ 'image_0.png': fakePng(8) });

    expect(parseNaiZip(zipped, 'Application/X-ZIP-Compressed').ok).toBe(true);
    expect(parseNaiZip(zipped, 'application/zip; charset=binary').ok).toBe(true);
  });

  it('zip 解不开 → bad-response 而不是抛穿', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = parseNaiZip(garbage, ZIP_CONTENT_TYPE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('bad-response');
    expect(result.detail).toContain('zip');
  });

  it('上游把错误体当 JSON 返回 → 仍是 bad-response，且 detail 带 content-type 与魔数', () => {
    const jsonBody = strToU8('{"statusCode":400,"message":"nope"}');
    const result = parseNaiZip(jsonBody, 'application/json');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('bad-response');
    expect(result.message).toBe('NovelAI 返回了看不懂的内容');
    expect(result.retryable).toBe(true);
    expect(result.detail).toContain('application/json');
    expect(result.detail).toContain('7b'); // '{' 的十六进制 —— 一眼看出上游返的是 JSON
  });

  it('zip 解出 0 张图 → bad-response', () => {
    const zipped = zipSync({ 'readme.txt': strToU8('nothing here') });
    const result = parseNaiZip(zipped, ZIP_CONTENT_TYPE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('bad-response');
    expect(result.retryable).toBe(true);
  });
});
