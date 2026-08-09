/**
 * 图像设置形状迁移（图像 v2 / C8）—— 17 个平铺 `image*` → per-provider 袋子。
 *
 * 四条错了会让用户当场吃亏的性质，各有一组用例：
 *
 * 1. **老档案的值一个都不许丢**。端点 id / 模型 / 限额搬错格的症状是「设置还在界面上，
 *    出图却按默认值发」—— 而默认端点是 `null`，也就是每次都报「还没选出图端点」。
 * 2. **全默认的老档案不许产出任何覆盖**（C6）。落一份等于今天的默认值的覆盖，
 *    会把它永久钉死在这个档案上，日后方言 JSON 改了默认再也够不到他。
 * 3. **幂等**。迁移每次启动都跑；第二次必须是彻底的空转，否则会把用户在新界面上
 *    改的东西按旧规则再搬一次。
 * 4. **垃圾值不许抛**。settings 来自 localStorage，那是用户能手改、也能被别的版本
 *    写坏的地方；这里抛一次 = 整个应用起不来。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_IMAGE_BASE_NEGATIVE,
  DEFAULT_IMAGE_PROMPT_SYSTEM,
  DEFAULT_IMAGE_QUALITY_SUFFIX,
} from '@engine/image-defaults';
import { migrateImageSettings, normalizeImageSettings } from './image-settings-migration';
import type { ImageNovelaiSettings } from './settings-types';

const DIALECT = 'danbooru-anime';

/** 新形状的空袋子 —— 生产上由 `{ ...getDefaults(), ...saved }` 铺好 */
function freshBags() {
  return {
    imageProvider: 'novelai',
    imageDialectId: DIALECT,
    imageDialectOverrides: {} as Record<string, Record<string, string>>,
    imageNovelai: {
      endpointId: null as string | null,
      model: 'nai-diffusion-4-5-full',
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      ucPreset: 0,
      tier: 'unset',
      maxPerMessage: 2,
      maxPerHour: 20,
    },
    imageComfy: {
      baseUrl: 'http://127.0.0.1:8188',
      workflowJson: '',
      timeoutMs: 600_000,
      pollIntervalMs: 1_500,
    },
  };
}

/** 图像 v1 时代真实存在过的那一份平铺形状（全部默认值） */
function legacyDefaults(): Record<string, unknown> {
  return {
    imageGenMode: 'manual',
    imageEndpointId: null,
    imageModel: 'nai-diffusion-4-5-full',
    imageQualitySuffix: DEFAULT_IMAGE_QUALITY_SUFFIX,
    imageBaseNegative: DEFAULT_IMAGE_BASE_NEGATIVE,
    imageExtraNegative: '',
    imageMaxRating: 'general',
    imageBlurByDefault: false,
    imageAutoConfirmed: false,
    imageWidth: 1216,
    imageHeight: 832,
    imageSteps: 23,
    imageScale: 4.5,
    imageSampler: 'k_euler_ancestral',
    imageNoiseSchedule: 'karras',
    imageUcPreset: 0,
    imageNaiTier: 'unset',
    imageMaxPerMessage: 2,
    imageMaxPerHour: 20,
  };
}

function makeBag(legacy: Record<string, unknown> = legacyDefaults()): Record<string, unknown> {
  return { ...freshBags(), ...legacy };
}

// ═══ 搬运 ═══

describe('migrateImageSettings —— 平铺键搬进 provider 袋', () => {
  it('用户改过的 NAI 参数与限额逐项落进 imageNovelai，旧键随即消失', () => {
    const bag = makeBag({
      ...legacyDefaults(),
      imageEndpointId: 'ep_nai',
      imageModel: 'nai-diffusion-3',
      imageSampler: 'k_dpmpp_2m',
      imageNoiseSchedule: 'native',
      imageUcPreset: 2,
      imageNaiTier: 'opus',
      imageMaxPerMessage: 5,
      imageMaxPerHour: 7,
    });

    const res = migrateImageSettings(bag);

    expect(bag.imageNovelai).toEqual({
      endpointId: 'ep_nai',
      model: 'nai-diffusion-3',
      sampler: 'k_dpmpp_2m',
      noiseSchedule: 'native',
      ucPreset: 2,
      tier: 'opus',
      maxPerMessage: 5,
      maxPerHour: 7,
    });
    // 🔴 旧键必须真的删掉：留着会被 deep watch 永久写回 localStorage 成幽灵键
    for (const key of [
      'imageEndpointId',
      'imageModel',
      'imageSampler',
      'imageNoiseSchedule',
      'imageUcPreset',
      'imageNaiTier',
      'imageMaxPerMessage',
      'imageMaxPerHour',
      'imageQualitySuffix',
      'imageBaseNegative',
    ]) {
      expect(key in bag).toBe(false);
      expect(res.removedKeys).toContain(key);
    }
    expect(res.migrated).toBe(true);
  });

  it('共享字段（档位/尺寸/分级/打码）一个都不动 —— 它们本来就在正确的位置', () => {
    const bag = makeBag({ ...legacyDefaults(), imageGenMode: 'auto', imageSteps: 28 });
    migrateImageSettings(bag);

    expect(bag.imageGenMode).toBe('auto');
    expect(bag.imageSteps).toBe(28);
    expect(bag.imageWidth).toBe(1216);
    expect(bag.imageMaxRating).toBe('general');
    expect(bag.imageExtraNegative).toBe('');
  });

  it('端点 null 是有意义的值（「还没选」），不许被当垃圾丢掉', () => {
    const bag = makeBag();
    migrateImageSettings(bag);
    expect((bag.imageNovelai as { endpointId: unknown }).endpointId).toBeNull();
  });
});

// ═══ 方言覆盖（C6）═══

describe('migrateImageSettings —— 画质后缀 / 基础负向 → 方言覆盖', () => {
  it('🔴 全默认的老档案产出**零**覆盖（相等 = 回落方言默认，别钉死今天的值）', () => {
    const bag = makeBag();
    const res = migrateImageSettings(bag);

    expect(bag.imageDialectOverrides).toEqual({});
    expect(res.dialectOverrideFields).toEqual([]);
    // 但旧键照样删掉 —— 「没产出覆盖」不等于「什么都没做」
    expect('imageQualitySuffix' in bag).toBe(false);
    expect('imageBaseNegative' in bag).toBe(false);
  });

  it('改过的画质后缀落进 imageDialectOverrides[当前方言]', () => {
    const bag = makeBag({ ...legacyDefaults(), imageQualitySuffix: 'my aesthetic, masterpiece' });
    const res = migrateImageSettings(bag);

    expect(bag.imageDialectOverrides).toEqual({
      [DIALECT]: { qualitySuffix: 'my aesthetic, masterpiece' },
    });
    expect(res.dialectOverrideFields).toEqual(['qualitySuffix']);
  });

  it('两个都改过 → 同一格里两项并存', () => {
    const bag = makeBag({
      ...legacyDefaults(),
      imageQualitySuffix: 'mine',
      imageBaseNegative: 'no hands',
    });
    migrateImageSettings(bag);

    expect(bag.imageDialectOverrides).toEqual({
      [DIALECT]: { qualitySuffix: 'mine', baseNegative: 'no hands' },
    });
  });

  it('清空过的输入框（空串）不算覆盖 —— 那表达的是「用默认」', () => {
    const bag = makeBag({ ...legacyDefaults(), imageQualitySuffix: '' });
    migrateImageSettings(bag);
    expect(bag.imageDialectOverrides).toEqual({});
  });

  it('🔴 落点是**常量** danbooru-anime，不是用户当前选的那条方言', () => {
    // v1 那三个串**全是照 danbooru 调的**（画质后缀是 danbooru 画质词、基础负向是
    // danbooru 负向词、侧链提示词整篇在教模型「只输出 danbooru 标签」）。
    // 把落点改成 `bag.imageDialectId` 看起来更「贴心」，实际是把一条动漫尾巴焊死在
    // 散文方言上 —— 而全套用例此前都用 danbooru-anime 当当前方言，那个改动一条都不会红。
    const bag = makeBag({
      ...legacyDefaults(),
      imageQualitySuffix: 'mine',
      imageBaseNegative: 'no hands',
    });
    bag.imageDialectId = 'natural-prose';
    bag.agents = { image_prompt: { systemPrompt: '我自己写的' } };

    migrateImageSettings(bag);

    expect(bag.imageDialectOverrides).toEqual({
      'danbooru-anime': {
        qualitySuffix: 'mine',
        baseNegative: 'no hands',
        systemPrompt: '我自己写的',
      },
    });
    // 用户选的方言原样保留 —— 迁移不替他换方言
    expect(bag.imageDialectId).toBe('natural-prose');
  });
});

// ═══ agents 袋里的侧链提示词（C5）═══

describe('migrateImageSettings —— image_prompt.systemPrompt 退役成方言覆盖', () => {
  it('用户改过的侧链提示词搬进方言覆盖，并从 agents 袋里清掉（不留第三份拷贝）', () => {
    const bag = makeBag();
    bag.agents = {
      image_prompt: { model: 'gpt-x', systemPrompt: '把中文转成 danbooru 标签。' },
      story: { systemPrompt: '别动我' },
    };

    const res = migrateImageSettings(bag);

    expect(bag.imageDialectOverrides).toEqual({
      [DIALECT]: { systemPrompt: '把中文转成 danbooru 标签。' },
    });
    expect(res.movedAgentPrompt).toBe(true);
    // 🔴 只清 systemPrompt 一个字段，model 这类旋钮原样留着（C5 只让提示词退役）
    expect(bag.agents).toEqual({
      image_prompt: { model: 'gpt-x' },
      story: { systemPrompt: '别动我' },
    });
  });

  it('🔴 覆写层里那份是**出厂原文**时直接丢弃，不许搬成覆盖', () => {
    // PR #29（boot 播种默认值进 settings.agents）→ PR #42（D44 删播种）之间建的档案，
    // 覆写层里躺的正是这段出厂原文 —— 用户一个字都没写过。搬成覆盖 = 把他永久钉死在
    // 今天这段文本上（日后方言 JSON / pack 更新一个字节也够不到他），
    // 设置页还会显示一个他从没填过的、填满的覆盖框。
    const bag = makeBag();
    bag.agents = {
      image_prompt: { model: 'gpt-x', systemPrompt: DEFAULT_IMAGE_PROMPT_SYSTEM },
    };

    const res = migrateImageSettings(bag);

    expect(res.droppedFactoryAgentPrompt).toBe(true);
    expect(res.movedAgentPrompt).toBe(false);
    expect(bag.imageDialectOverrides).toEqual({});
    // 覆写层里那个字段照样清掉（丢弃与搬走都不留第三份拷贝）
    expect(bag.agents).toEqual({ image_prompt: { model: 'gpt-x' } });
  });

  it('出厂原文被丢弃后整条覆写只剩空壳时，连壳一起删', () => {
    const bag = makeBag();
    bag.agents = { image_prompt: { systemPrompt: DEFAULT_IMAGE_PROMPT_SYSTEM } };

    migrateImageSettings(bag);

    expect(bag.agents).toEqual({});
  });

  it('手改过一个字的提示词照常搬 —— 判据是逐字节相同，不是「长得像」', () => {
    const bag = makeBag();
    bag.agents = {
      image_prompt: { systemPrompt: `${DEFAULT_IMAGE_PROMPT_SYSTEM}\n6. 永远画成黄昏。` },
    };

    const res = migrateImageSettings(bag);

    expect(res.movedAgentPrompt).toBe(true);
    expect(res.droppedFactoryAgentPrompt).toBe(false);
    expect(bag.imageDialectOverrides).toEqual({
      [DIALECT]: { systemPrompt: `${DEFAULT_IMAGE_PROMPT_SYSTEM}\n6. 永远画成黄昏。` },
    });
  });

  it('agents 袋里没有 image_prompt / 没有提示词时不报错也不产覆盖', () => {
    const bag = makeBag();
    bag.agents = { image_prompt: { model: 'gpt-x' } };
    const res = migrateImageSettings(bag);

    expect(res.movedAgentPrompt).toBe(false);
    expect(bag.imageDialectOverrides).toEqual({});
  });

  it('🔴 旧平铺键一个都不在时，连 agents 袋那步都不做 —— 否则会偷走用户新写的提示词', () => {
    const bag: Record<string, unknown> = { ...freshBags() };
    bag.agents = { image_prompt: { systemPrompt: '我是在新界面上写的' } };

    const res = migrateImageSettings(bag);

    expect(res.migrated).toBe(false);
    expect(bag.agents).toEqual({ image_prompt: { systemPrompt: '我是在新界面上写的' } });
    expect(bag.imageDialectOverrides).toEqual({});
  });
});

// ═══ 幂等与容错 ═══

describe('migrateImageSettings —— 幂等与容错', () => {
  it('第二次运行是彻底的空转（旧键在不在就是信号，不需要标志位）', () => {
    const bag = makeBag({
      ...legacyDefaults(),
      imageEndpointId: 'ep_nai',
      imageQualitySuffix: 'mine',
    });
    migrateImageSettings(bag);
    const snapshot = JSON.stringify(bag);

    const second = migrateImageSettings(bag);

    expect(second.migrated).toBe(false);
    expect(second.removedKeys).toEqual([]);
    expect(JSON.stringify(bag)).toBe(snapshot);
  });

  it('全新用户（没有任何旧键）什么都不发生', () => {
    const bag: Record<string, unknown> = { ...freshBags() };
    const before = JSON.stringify(bag);
    expect(migrateImageSettings(bag).migrated).toBe(false);
    expect(JSON.stringify(bag)).toBe(before);
  });

  it('🔴 垃圾值不抛：认不出的旧值一律留袋子里的默认，坏袋子整只重建', () => {
    const bag: Record<string, unknown> = {
      // 袋子本身被写坏（别的版本 / 手改 localStorage）
      imageNovelai: 5,
      imageComfy: null,
      imageDialectOverrides: 'nope',
      imageDialectId: 42,
      imageProvider: 'midjourney',
      // 旧键类型全错
      imageEndpointId: 12,
      imageModel: { oops: true },
      imageUcPreset: 'two',
      imageNaiTier: 'platinum',
      imageMaxPerHour: Number.NaN,
      imageQualitySuffix: 99,
    };

    expect(() => migrateImageSettings(bag)).not.toThrow();

    expect(bag.imageNovelai).toEqual({
      endpointId: null,
      model: '',
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      ucPreset: 0,
      tier: 'unset',
      maxPerMessage: 2,
      maxPerHour: 20,
    });
    expect(bag.imageDialectOverrides).toEqual({});
    expect(bag.imageDialectId).toBe(DIALECT);
    expect(bag.imageProvider).toBe('novelai');
    expect('imageEndpointId' in bag).toBe(false);
  });

  it('只搬了一半的档案（部分旧键在）也能收尾', () => {
    const bag: Record<string, unknown> = { ...freshBags(), imageMaxPerHour: 3 };
    const res = migrateImageSettings(bag);

    expect(res.removedKeys).toEqual(['imageMaxPerHour']);
    expect((bag.imageNovelai as { maxPerHour: number }).maxPerHour).toBe(3);
    // 没出现的旧键不影响袋子里其余默认
    expect((bag.imageNovelai as { model: string }).model).toBe('nai-diffusion-4-5-full');
  });
});

// ═══ 归一化（每次加载都跑，与旧键无关）═══

const FALLBACK_NOVELAI = {
  endpointId: null,
  model: '',
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  ucPreset: 0,
  tier: 'unset',
  maxPerMessage: 2,
  maxPerHour: 20,
};

describe('normalizeImageSettings —— 袋子永远合法且不残缺', () => {
  it('🔴 已经迁过的坏档案照样修 —— 修复不许被旧键闸门挡住', () => {
    // 旧键一个都不在（早就迁完了），但袋子被手改 localStorage / 别的版本写坏。
    // 此前这段修复关在「至少有一个旧键」的闸门后面，于是这种档案永远修不好，
    // 而下游 `checkQuota` 读的是 `s.imageNovelai.maxPerMessage` —— 当场 TypeError。
    const bag: Record<string, unknown> = {
      ...freshBags(),
      imageNovelai: null,
      imageComfy: 5,
      imageDialectOverrides: 'nope',
    };

    const res = migrateImageSettings(bag);

    expect(res.migrated).toBe(false); // 没有旧键 → 确实没搬东西
    expect(bag.imageNovelai).toEqual(FALLBACK_NOVELAI);
    expect(bag.imageComfy).toEqual({
      baseUrl: 'http://127.0.0.1:8188',
      workflowJson: '',
      timeoutMs: 600_000,
      pollIntervalMs: 1_500,
    });
    expect(bag.imageDialectOverrides).toEqual({});
  });

  it('🔴 袋内缺字段从默认值补 —— store 的 `{ ...defaults, ...saved }` 只盖一层', () => {
    // 日后往 ImageNovelaiSettings 加一格，老用户的 saved.imageNovelai 整只盖掉 defaults 那只，
    // 新字段到手就是 undefined。「加新设置要改两处」在袋子内部会这样静默失效。
    const bag: Record<string, unknown> = {
      ...freshBags(),
      imageNovelai: { endpointId: 'ep', model: 'm' },
    };

    const res = normalizeImageSettings(bag);

    expect(res.filledFields).toContain('imageNovelai.tier');
    expect(res.filledFields).toContain('imageNovelai.maxPerHour');
    expect(bag.imageNovelai).toEqual({ ...FALLBACK_NOVELAI, endpointId: 'ep', model: 'm' });
  });

  it('defaults 参数优先于模块兜底（生产上传的是 getDefaults() 的那两只袋子）', () => {
    const bag: Record<string, unknown> = { imageNovelai: 'garbage' };
    const production: ImageNovelaiSettings = {
      endpointId: null,
      model: 'nai-diffusion-4-5-full',
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      ucPreset: 0,
      tier: 'unset',
      maxPerMessage: 2,
      maxPerHour: 20,
    };

    normalizeImageSettings(bag, { imageNovelai: production });

    // 兜底那份的 model 是空串；这里必须拿到生产默认值
    expect((bag.imageNovelai as { model: string }).model).toBe('nai-diffusion-4-5-full');
  });

  it('已经合法的袋子一个字节都不动，且第二次是彻底空转', () => {
    const bag: Record<string, unknown> = { ...freshBags() };
    const before = JSON.stringify(bag);

    const first = normalizeImageSettings(bag);
    expect(first).toEqual({ rebuilt: [], filledFields: [] });
    expect(JSON.stringify(bag)).toBe(before);

    const second = normalizeImageSettings(bag);
    expect(second).toEqual({ rebuilt: [], filledFields: [] });
    expect(JSON.stringify(bag)).toBe(before);
  });

  it('方言 id / 后端认不出时回落，且不抛', () => {
    const bag: Record<string, unknown> = { imageDialectId: 42, imageProvider: 'midjourney' };

    expect(() => normalizeImageSettings(bag)).not.toThrow();

    expect(bag.imageDialectId).toBe(DIALECT);
    expect(bag.imageProvider).toBe('novelai');
  });
});
