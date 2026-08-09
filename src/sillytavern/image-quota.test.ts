/**
 * image-quota.test.ts — 三层限额判定的守卫测试（设计 §5.3 / D20–D24）
 *
 * 这里钉住的每一条，错了都不会报错，只会**静默花钱**（或静默拦掉玩家自己想要的图）。
 * 阈值一律从 `image-defaults.ts` 取，不在本文件另抄一份字面值 ——
 * 否则改默认值时测试仍然绿，而生产已经变了。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  DEFAULT_IMAGE_MAX_PER_HOUR,
  DEFAULT_IMAGE_MAX_PER_MESSAGE,
  IMAGE_QUOTA_WINDOW_MS,
} from './image-defaults';
import { checkQuota, type QuotaInput } from './image-quota';
import type { ImageProviderId, SceneImageRecord, SceneImageStatus } from './types-image';

const NOW = 1_700_000_000_000;

const DEFAULT_LIMITS = {
  maxPerMessage: DEFAULT_IMAGE_MAX_PER_MESSAGE,
  maxPerHour: DEFAULT_IMAGE_MAX_PER_HOUR,
};

/**
 * 造一条**完整的** SceneImageRecord，而不是只造 checkQuota 用到的四个字段。
 *
 * 理由：`status` 正是「在飞的也要计入」那一条要验的东西，而 `QuotaInput.records`
 * 的 `Pick` 里刻意没有它 —— 用完整记录传参，才证明真实调用方的形状能直接喂进去。
 */
function makeRecord(over: Partial<SceneImageRecord> = {}): SceneImageRecord {
  return {
    id: `img-${Math.random().toString(36).slice(2)}`,
    saveId: 'save-1',
    messageId: 'msg-1',
    anchorKind: 'marker',
    occurrence: 0,
    take: 0,
    turn: 1,
    status: 'done',
    source: 'auto',
    title: '篝火旁的低语',
    description: '',
    intent: '苏婉在篝火旁说起家乡',
    scenePrompt: 'campfire, night',
    sceneNegative: '',
    characters: ['苏婉'],
    rating: 'general',
    positive: 'campfire, night',
    negative: '',
    model: 'nai-diffusion-4-5-full',
    params: {},
    createdAt: NOW - 1000,
    ...over,
  };
}

/**
 * 缺省 `costModel: 'paid'` —— 既有全部用例写的都是付费后端那条路（图像 v1 的唯一后端），
 * 于是它们一个字节都不用改。本地后端那半在文件末尾单开一节。
 */
function input(over: Partial<QuotaInput> = {}): QuotaInput {
  return {
    records: [],
    target: { messageId: 'msg-1', turn: 1, source: 'auto' },
    now: NOW,
    limits: DEFAULT_LIMITS,
    costModel: 'paid',
    ...over,
  };
}

/** 造 n 条落在窗口内的记录，分散在各自的消息/回合上，好让它们只触发 L2 */
function spreadRecords(n: number, source: 'auto' | 'manual' = 'auto'): SceneImageRecord[] {
  return Array.from({ length: n }, (_, i) =>
    makeRecord({
      messageId: `spread-${i}`,
      turn: 100 + i,
      source,
      createdAt: NOW - 1000 * (i + 1),
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('放行的基线', () => {
  it('没有任何记录时两种 source 都放行', () => {
    expect(checkQuota(input())).toEqual({ ok: true });
    expect(
      checkQuota(input({ target: { messageId: 'msg-1', turn: 1, source: 'manual' } })),
    ).toEqual({ ok: true });
  });

  it('低于每消息上限时放行（默认 2 → 已有 1 条仍可再画）', () => {
    const records = [makeRecord()];
    expect(DEFAULT_IMAGE_MAX_PER_MESSAGE).toBeGreaterThan(1); // 这条用例的前提
    expect(
      checkQuota(input({ records, target: { messageId: 'msg-1', turn: 9, source: 'auto' } })),
    ).toEqual({ ok: true });
  });
});

describe('L1 每条消息上限', () => {
  it('同 messageId 的记录数达到上限即拒', () => {
    const records = Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE }, (_, i) =>
      makeRecord({ turn: 50 + i }),
    );
    const verdict = checkQuota(input({ records }));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('per-message');
  });

  it('别的消息上的记录不计进 L1', () => {
    const records = Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE * 3 }, (_, i) =>
      makeRecord({ messageId: `other-${i}`, turn: 50 + i }),
    );
    expect(
      checkQuota(input({ records, target: { messageId: 'msg-1', turn: 9, source: 'auto' } })),
    ).toEqual({ ok: true });
  });

  it('🔴 auto 与 manual 都计进 L1 —— 一个 UI bug 造成的连点也该被拦', () => {
    const records = Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE }, (_, i) =>
      makeRecord({ source: 'manual', turn: 50 + i }),
    );
    for (const source of ['auto', 'manual'] as const) {
      const verdict = checkQuota(
        input({ records, target: { messageId: 'msg-1', turn: 9, source } }),
      );
      expect(verdict.ok, source).toBe(false);
      expect(verdict.ok === false && verdict.reason, source).toBe('per-message');
    }
  });
});

describe('L2 滚动时间窗', () => {
  it('窗口内记录达到每小时上限即拒（跨消息累计）', () => {
    const records = spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR);
    const verdict = checkQuota(
      input({ records, target: { messageId: 'fresh-msg', turn: 999, source: 'auto' } }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('rolling-window');
  });

  it('窗口外的记录不计 —— 判据是 now - createdAt < 窗口长度，正好落在边界上算窗口外', () => {
    const records = spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR).map((r) =>
      makeRecord({ ...r, createdAt: NOW - IMAGE_QUOTA_WINDOW_MS }),
    );
    expect(
      checkQuota(input({ records, target: { messageId: 'fresh-msg', turn: 999, source: 'auto' } })),
    ).toEqual({ ok: true });
  });

  it('窗口内差一条不拒，补上第 N 条就拒', () => {
    const nearly = spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR - 1);
    const target = { messageId: 'fresh-msg', turn: 999, source: 'auto' as const };
    expect(checkQuota(input({ records: nearly, target }))).toEqual({ ok: true });
    const full = [...nearly, makeRecord({ messageId: 'one-more', turn: 998, createdAt: NOW - 5 })];
    expect(checkQuota(input({ records: full, target })).ok).toBe(false);
  });

  it('时钟回拨造成的「未来」记录照样计入 —— 宁可多拦一张，不可漏掉一轮风暴', () => {
    const records = spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR).map((r) =>
      makeRecord({ ...r, createdAt: NOW + 60_000 }),
    );
    expect(
      checkQuota(input({ records, target: { messageId: 'fresh-msg', turn: 999, source: 'auto' } }))
        .ok,
    ).toBe(false);
  });

  it('🔴 auto 与 manual 都计进 L2', () => {
    const records = spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR, 'manual');
    for (const source of ['auto', 'manual'] as const) {
      const verdict = checkQuota(
        input({ records, target: { messageId: 'fresh-msg', turn: 999, source } }),
      );
      expect(verdict.ok, source).toBe(false);
      expect(verdict.ok === false && verdict.reason, source).toBe('rolling-window');
    }
  });
});

describe('L3 同回合去重（D23）', () => {
  it('同 turn 已有 auto 记录 → 自动档拒', () => {
    const records = [makeRecord({ messageId: 'earlier-msg', turn: 7, source: 'auto' })];
    const verdict = checkQuota(
      input({ records, target: { messageId: 'msg-1', turn: 7, source: 'auto' } }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('same-turn');
  });

  it('🔴 L3 只对 auto 生效 —— 玩家想为同一段剧情多画几张是他的钱、他的选择', () => {
    const records = [makeRecord({ messageId: 'earlier-msg', turn: 7, source: 'auto' })];
    expect(
      checkQuota(input({ records, target: { messageId: 'msg-1', turn: 7, source: 'manual' } })),
    ).toEqual({ ok: true });
  });

  it('同 turn 只有 manual 记录时，自动档仍可开火（去重键是 turn + auto）', () => {
    const records = [makeRecord({ messageId: 'earlier-msg', turn: 7, source: 'manual' })];
    expect(
      checkQuota(input({ records, target: { messageId: 'msg-1', turn: 7, source: 'auto' } })),
    ).toEqual({ ok: true });
  });

  it('不同 turn 的 auto 记录不触发 L3', () => {
    const records = [makeRecord({ messageId: 'earlier-msg', turn: 6, source: 'auto' })];
    expect(
      checkQuota(input({ records, target: { messageId: 'msg-1', turn: 7, source: 'auto' } })),
    ).toEqual({ ok: true });
  });
});

describe('🔴 在飞的与失败的都要计入 —— 否则连点能绕过限额', () => {
  const flying: SceneImageStatus[] = ['queued', 'generating', 'failed'];

  it.each(flying)('status=%s 的记录计进 L1', (status) => {
    const records = Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE }, (_, i) =>
      makeRecord({ status, turn: 50 + i }),
    );
    const verdict = checkQuota(input({ records }));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('per-message');
  });

  it.each(flying)('status=%s 的记录计进 L2', (status) => {
    const records = spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR).map((r) =>
      makeRecord({ ...r, status }),
    );
    const verdict = checkQuota(
      input({ records, target: { messageId: 'fresh-msg', turn: 999, source: 'auto' } }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('rolling-window');
  });

  it.each(flying)('status=%s 的 auto 记录计进 L3', (status) => {
    const records = [makeRecord({ messageId: 'earlier-msg', turn: 7, source: 'auto', status })];
    const verdict = checkQuota(
      input({ records, target: { messageId: 'msg-1', turn: 7, source: 'auto' } }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('same-turn');
  });

  it('连点场景：三条在飞的 queued 记录足以拦下第四次点击', () => {
    const records = Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE }, (_, i) =>
      makeRecord({ status: 'queued', source: 'manual', turn: 50 + i }),
    );
    expect(
      checkQuota(input({ records, target: { messageId: 'msg-1', turn: 9, source: 'manual' } })).ok,
    ).toBe(false);
  });
});

describe('🔴 手动永不被判成不可用，最多是「要确认」（D24 / §9.3）', () => {
  const target = { messageId: 'msg-1', turn: 7, source: 'manual' as const };

  const scenarios: Array<{ name: string; records: SceneImageRecord[] }> = [
    { name: '空记录', records: [] },
    {
      name: '本条消息已爆 L1',
      records: Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE * 5 }, (_, i) =>
        makeRecord({ turn: 50 + i }),
      ),
    },
    { name: '本小时已爆 L2', records: spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR * 3) },
    {
      name: '同回合已自动生成过（L3 对手动不生效）',
      records: [makeRecord({ messageId: 'earlier-msg', turn: 7, source: 'auto' })],
    },
    {
      name: '三层同时爆',
      records: [
        ...Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE * 5 }, () => makeRecord({ turn: 7 })),
        ...spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR * 3),
      ],
    },
  ];

  it.each(scenarios)('$name：手动档从不因 same-turn 被拒', ({ records }) => {
    const verdict = checkQuota(input({ records, target }));
    expect(verdict.ok === false && verdict.reason).not.toBe('same-turn');
  });

  it.each(scenarios)(
    '$name：手动档的拒绝文案说的是「确认后仍可生成」，不是「不许」',
    ({ records }) => {
      const verdict = checkQuota(input({ records, target }));
      if (verdict.ok) return; // 放行也满足「永不不可用」
      expect(verdict.message).toContain('确认后仍可生成');
      // 反向：不该出现把按钮说死的字眼，否则玩家会以为按钮坏了
      expect(verdict.message).not.toMatch(/不可|无法|禁止|已停用/);
    },
  );

  it('自动档在同样的状态下才是硬停 —— 两档的差别只在文案与调用方处置，判定共用一条', () => {
    const records = spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR);
    const auto = checkQuota(
      input({ records, target: { messageId: 'fresh', turn: 999, source: 'auto' } }),
    );
    const manual = checkQuota(
      input({ records, target: { messageId: 'fresh', turn: 999, source: 'manual' } }),
    );
    if (auto.ok || manual.ok) throw new Error('两档都应被同一层拦下');
    // 同一层拦下，reason 相同（判定共用）
    expect(auto.reason).toBe('rolling-window');
    expect(manual.reason).toBe('rolling-window');
    // 文案不同（处置不同）
    expect(auto.message).not.toBe(manual.message);
  });
});

describe('层级独立且报第一条', () => {
  it('L1 与 L2 同时超时报 per-message（表的顺序 = 裁决的顺序，tooltip 不许随记录顺序变脸）', () => {
    const records = [
      ...Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE }, (_, i) =>
        makeRecord({ turn: 50 + i }),
      ),
      ...spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR),
    ];
    const verdict = checkQuota(input({ records }));
    expect(verdict.ok === false && verdict.reason).toBe('per-message');
  });

  it('L2 与 L3 同时超时报 rolling-window', () => {
    const records = [
      ...spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR),
      makeRecord({ messageId: 'earlier', turn: 7, source: 'auto' }),
    ];
    const verdict = checkQuota(
      input({ records, target: { messageId: 'fresh', turn: 7, source: 'auto' } }),
    );
    expect(verdict.ok === false && verdict.reason).toBe('rolling-window');
  });

  it('阈值从参数进：调小 maxPerMessage 立刻生效（不是写死在模块里）', () => {
    const records = [makeRecord({ turn: 50 })];
    const verdict = checkQuota(
      input({ records, limits: { maxPerMessage: 1, maxPerHour: DEFAULT_IMAGE_MAX_PER_HOUR } }),
    );
    expect(verdict.ok === false && verdict.reason).toBe('per-message');
  });
});

describe('纯度与文案', () => {
  it('🔴 不碰 Date.now() —— now 从参数进，否则快照重放与测试都不可复现', () => {
    const spy = vi.spyOn(Date, 'now');
    checkQuota(input({ records: spreadRecords(3) }));
    checkQuota(
      input({
        records: spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR),
        target: { messageId: 'fresh', turn: 999, source: 'manual' },
      }),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('同样的输入永远给同样的裁决', () => {
    const args = input({ records: spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR) });
    expect(checkQuota(args)).toEqual(checkQuota(args));
  });

  it('now 决定窗口：同一批记录，把 now 往后推一小时就不再计入', () => {
    const records = spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR);
    const target = { messageId: 'fresh', turn: 999, source: 'auto' as const };
    expect(checkQuota(input({ records, target })).ok).toBe(false);
    expect(checkQuota(input({ records, target, now: NOW + IMAGE_QUOTA_WINDOW_MS }))).toEqual({
      ok: true,
    });
  });

  it('🔴 message 是可读中文 tooltip，不是错误码', () => {
    const cases: QuotaInput[] = [
      input({
        records: Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE }, (_, i) =>
          makeRecord({ turn: 50 + i }),
        ),
      }),
      input({
        records: spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR),
        target: { messageId: 'fresh', turn: 999, source: 'auto' },
      }),
      input({ records: [makeRecord({ messageId: 'earlier', turn: 1, source: 'auto' })] }),
    ];
    for (const args of cases) {
      const verdict = checkQuota(args);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.message).toMatch(/[一-龥]/); // 有中文
      expect(verdict.message).not.toContain(verdict.reason); // 不是把 reason 直接贴上去
      expect(verdict.message).not.toMatch(/[_A-Z]{4,}/); // 不是错误码
      expect(verdict.message.length).toBeGreaterThan(8);
    }
  });

  it('被 L1/L2 拦下时，文案里带得出「用了几张 / 上限几张」', () => {
    const perMessage = checkQuota(
      input({
        records: Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE }, (_, i) =>
          makeRecord({ turn: 50 + i }),
        ),
      }),
    );
    expect(perMessage.ok === false && perMessage.message).toContain(
      `${DEFAULT_IMAGE_MAX_PER_MESSAGE}/${DEFAULT_IMAGE_MAX_PER_MESSAGE}`,
    );

    const hourly = checkQuota(
      input({
        records: spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR),
        target: { messageId: 'fresh', turn: 999, source: 'auto' },
      }),
    );
    expect(hourly.ok === false && hourly.message).toContain(
      `${DEFAULT_IMAGE_MAX_PER_HOUR}/${DEFAULT_IMAGE_MAX_PER_HOUR}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// costModel 分层（图像 v2 / C9）
// ═══════════════════════════════════════════════════════════

describe('costModel: local —— L1/L2 是花钱防线，本地后端不设上限', () => {
  it('L1 每消息：paid 拦、local 放行（同一份记录、同一份阈值）', () => {
    const records = Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE }, (_, i) =>
      makeRecord({ turn: 50 + i }),
    );
    // 目标是 manual，避开 L3（L3 只拦 auto）—— 这里要单独看 L1
    const target = { messageId: 'msg-1', turn: 999, source: 'manual' as const };

    const paid = checkQuota(input({ records, target, costModel: 'paid' }));
    expect(paid.ok === false && paid.reason).toBe('per-message');

    const local = checkQuota(input({ records, target, costModel: 'local' }));
    expect(local.ok).toBe(true);
  });

  it('L2 滚动一小时：paid 拦、local 放行', () => {
    const records = spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR);
    const target = { messageId: 'fresh', turn: 999, source: 'manual' as const };

    const paid = checkQuota(input({ records, target, costModel: 'paid' }));
    expect(paid.ok === false && paid.reason).toBe('rolling-window');

    expect(checkQuota(input({ records, target, costModel: 'local' })).ok).toBe(true);
  });

  it('🔴 L3 同回合去重对 local **照样开火** —— 它是正确性规则，不是花钱规则', () => {
    // 一回合自动开火两次产出两张近乎相同的图 + 图鉴里两条重复条目，
    // 这件事与谁付钱无关。本地后端照样难看，所以这一条与 costModel 无关。
    const records = [makeRecord({ messageId: 'other', turn: 7, source: 'auto' })];
    const target = { messageId: 'msg-1', turn: 7, source: 'auto' as const };

    for (const costModel of ['paid', 'local'] as const) {
      const verdict = checkQuota(input({ records, target, costModel }));
      expect(verdict.ok, `costModel=${costModel} 应被 L3 拦下`).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('same-turn');
    }
  });

  it('local 下手动开火不受任何张数限制（用户裁定：本地免费就该无上限）', () => {
    // 远超两条阈值的记录堆在同一条消息、同一小时里
    const records = [
      ...Array.from({ length: 50 }, () => makeRecord({ messageId: 'msg-1' })),
      ...spreadRecords(50),
    ];
    const verdict = checkQuota(
      input({
        records,
        target: { messageId: 'msg-1', turn: 4242, source: 'manual' },
        costModel: 'local',
      }),
    );
    expect(verdict.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 记录按各自盖的章算账（图像 v2 / C9，2026-08-08 评审补）
// ═══════════════════════════════════════════════════════════

/** 与 `scene-image-seams.ts` 的 `PROVIDER_CAPABILITIES` 同口径：只有 NAI 收钱 */
const costModelOf = (provider: ImageProviderId | undefined): 'paid' | 'local' =>
  provider === 'comfyui' ? 'local' : 'paid';

describe('🔴 L1/L2 只算付费记录 —— 本地画的图不许去啃付费预算', () => {
  it('切回 NAI 的第一张付费图不该被一堆本地图拦下（评审复现的那一幕）', () => {
    // 本地免费连画 25 张（超过每小时 20 的阈值），然后切回 NovelAI 画第一张
    const records = spreadRecords(25).map((r) => makeRecord({ ...r, provider: 'comfyui' }));
    const verdict = checkQuota(
      input({
        records,
        costModelOf,
        target: { messageId: 'fresh-msg', turn: 999, source: 'auto' },
        costModel: 'paid',
      }),
    );
    // 修之前这里报的是 rolling-window「已达本小时上限（25/20）」，而付费的一张都没画过
    expect(verdict).toEqual({ ok: true });
  });

  it('同一条消息上的本地图不占 L1', () => {
    const records = Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE * 3 }, (_, i) =>
      makeRecord({ provider: 'comfyui', turn: 50 + i }),
    );
    expect(
      checkQuota(
        input({
          records,
          costModelOf,
          target: { messageId: 'msg-1', turn: 999, source: 'manual' },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('混着算：只有付费那几条计数，够数了照拦', () => {
    const paid = Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE }, (_, i) =>
      makeRecord({ provider: 'novelai', turn: 50 + i }),
    );
    const local = Array.from({ length: 20 }, (_, i) =>
      makeRecord({ provider: 'comfyui', turn: 80 + i }),
    );
    const target = { messageId: 'msg-1', turn: 999, source: 'manual' as const };

    // 付费的那几条刚好顶满 L1
    const full = checkQuota(input({ records: [...paid, ...local], costModelOf, target }));
    expect(full.ok === false && full.reason).toBe('per-message');
    // 文案里的分子只数付费那几条 —— 把本地图算进去会说出一个用户对不上的数字
    expect(full.ok === false && full.message).toContain(
      `${DEFAULT_IMAGE_MAX_PER_MESSAGE}/${DEFAULT_IMAGE_MAX_PER_MESSAGE}`,
    );

    // 去掉一条付费的就该放行（证明差别真的来自付费那几条，不是本地那堆）
    const nearly = checkQuota(
      input({ records: [...paid.slice(1), ...local], costModelOf, target }),
    );
    expect(nearly).toEqual({ ok: true });
  });

  it('🔴 没盖章的老记录**照样计入** —— 它们全是 NAI 画的（缺席读作 novelai）', () => {
    const records = Array.from({ length: DEFAULT_IMAGE_MAX_PER_MESSAGE }, (_, i) =>
      makeRecord({ turn: 50 + i }),
    );
    expect(records.every((r) => r.provider === undefined)).toBe(true);
    const verdict = checkQuota(
      input({ records, costModelOf, target: { messageId: 'msg-1', turn: 999, source: 'manual' } }),
    );
    expect(verdict.ok === false && verdict.reason).toBe('per-message');
  });

  it('🔴 没交 costModelOf 时一律按付费计 —— 缺省只会多拦，不会多花', () => {
    const records = spreadRecords(DEFAULT_IMAGE_MAX_PER_HOUR).map((r) =>
      makeRecord({ ...r, provider: 'comfyui' }),
    );
    // 刻意不传 costModelOf（`input()` 也不带）：本地记录被当成付费的，拦下
    const verdict = checkQuota(
      input({ records, target: { messageId: 'fresh', turn: 999, source: 'auto' } }),
    );
    expect(verdict.ok === false && verdict.reason).toBe('rolling-window');
  });

  it('🔴 L3 照样看全部记录 —— 本地画过一张，这一回合就已经有插画了', () => {
    // L3 是正确性规则：同一回合再自动开一张，产出的是两张近乎相同的图，与谁付钱无关
    const records = [
      makeRecord({ messageId: 'earlier', turn: 7, source: 'auto', provider: 'comfyui' }),
    ];
    const verdict = checkQuota(
      input({
        records,
        costModelOf,
        target: { messageId: 'msg-1', turn: 7, source: 'auto' },
        costModel: 'paid',
      }),
    );
    expect(verdict.ok === false && verdict.reason).toBe('same-turn');
  });

  it('🔴 目标档与记录档是两件事：目标 local 时，一堆付费记录照样不拦', () => {
    // 反向那半在上面几条里 —— 这一条钉的是「两个方向互不牵连」
    const records = [
      ...Array.from({ length: 50 }, () => makeRecord({ provider: 'novelai' })),
      ...spreadRecords(50).map((r) => makeRecord({ ...r, provider: 'novelai' })),
    ];
    expect(
      checkQuota(
        input({
          records,
          costModelOf,
          target: { messageId: 'msg-1', turn: 4242, source: 'manual' },
          costModel: 'local',
        }),
      ),
    ).toEqual({ ok: true });
  });
});
