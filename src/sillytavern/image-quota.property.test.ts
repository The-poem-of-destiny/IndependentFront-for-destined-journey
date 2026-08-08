import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkQuota, type QuotaInput } from './image-quota';
import { IMAGE_QUOTA_WINDOW_MS } from './image-defaults';

/**
 * image-quota 的**属性测试**（既有的 `image-quota.test.ts` 是例子测试，两者互补）。
 *
 * 这个模块守的是**钱**：放行一张就是一次真实扣费。例子测试能钉住设计文档列举的那几行，
 * 属性测试钉的是「无论记录怎么排列、时间戳怎么分布，都不会多放行一张」——
 * 而记录顺序恰恰是模块注释点名的隐患（「裁决必须是确定的，否则 tooltip 会随记录顺序变脸」）。
 */

type Record_ = QuotaInput['records'][number];

const source = fc.constantFrom<'auto' | 'manual'>('auto', 'manual');

const recordArb = (now: number) =>
  fc.record({
    messageId: fc.constantFrom('m1', 'm2', 'm3'),
    turn: fc.integer({ min: 0, max: 5 }),
    source,
    // 覆盖窗口内、窗口外，以及时钟回拨造成的「未来」记录
    createdAt: fc.integer({
      min: now - IMAGE_QUOTA_WINDOW_MS * 3,
      max: now + IMAGE_QUOTA_WINDOW_MS,
    }),
  });

const NOW = 1_700_000_000_000;

const inputArb = fc.record({
  records: fc.array(recordArb(NOW), { maxLength: 40 }),
  target: fc.record({
    messageId: fc.constantFrom('m1', 'm2', 'm3'),
    turn: fc.integer({ min: 0, max: 5 }),
    source,
  }),
  now: fc.constant(NOW),
  limits: fc.record({
    maxPerMessage: fc.integer({ min: 1, max: 5 }),
    maxPerHour: fc.integer({ min: 1, max: 30 }),
  }),
  // 图像 v2 / C9：两种后端都要被这些不变式覆盖，所以它进采样空间而不是写死 'paid'
  costModel: fc.constantFrom<'paid' | 'local'>('paid', 'local'),
});

/** 独立重算三层判据 —— 与实现同源会让测试变成同义反复，所以照设计表重写一遍 */
function expectedReason(input: QuotaInput): string | null {
  const { records, target, now, limits, costModel } = input;
  // 🔴 L1/L2 只在付费后端启用（C9）；L3 与 costModel 无关，它是正确性规则
  if (costModel === 'paid') {
    const perMessage = records.filter((r) => r.messageId === target.messageId).length;
    if (perMessage >= limits.maxPerMessage) return 'per-message';
    const inWindow = records.filter((r) => now - r.createdAt < IMAGE_QUOTA_WINDOW_MS).length;
    if (inWindow >= limits.maxPerHour) return 'rolling-window';
  }
  if (
    target.source === 'auto' &&
    records.some((r) => r.turn === target.turn && r.source === 'auto')
  )
    return 'same-turn';
  return null;
}

describe('checkQuota 不变式', () => {
  it('裁决与三层判据逐条一致', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const verdict = checkQuota(input);
        const expected = expectedReason(input);
        if (expected === null) {
          expect(verdict.ok).toBe(true);
        } else {
          expect(verdict.ok).toBe(false);
          expect(verdict.ok === false && verdict.reason).toBe(expected);
        }
      }),
    );
  });

  it('裁决与记录顺序无关（否则 tooltip 会变脸）', () => {
    fc.assert(
      fc.property(inputArb, fc.integer({ min: 0, max: 1000 }), (input, rotate) => {
        const rotated = [...input.records];
        const k = rotated.length > 0 ? rotate % rotated.length : 0;
        rotated.push(...rotated.splice(0, k));
        expect(checkQuota({ ...input, records: rotated })).toEqual(checkQuota(input));
      }),
    );
  });

  it('拒绝时永远带可读中文 message，绝不是空串或错误码', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const verdict = checkQuota(input);
        if (verdict.ok) return;
        expect(verdict.message.trim().length).toBeGreaterThan(0);
        // 不是裸错误码：中文文案必须含中日韩字符
        expect(/[一-鿿]/.test(verdict.message)).toBe(true);
      }),
    );
  });

  it('加记录只会更严，绝不会把已拒的放行（单调性）', () => {
    // 这条是「钱」的核心保证：多一条在飞的记录，不可能让原本被拦的变成放行。
    fc.assert(
      fc.property(inputArb, recordArb(NOW), (input, extra) => {
        const before = checkQuota(input);
        if (before.ok) return;
        const after = checkQuota({ ...input, records: [...input.records, extra as Record_] });
        expect(after.ok).toBe(false);
      }),
    );
  });

  it('manual 永不因 same-turn 被拒（L3 只拦 auto）', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const verdict = checkQuota({ ...input, target: { ...input.target, source: 'manual' } });
        if (!verdict.ok) expect(verdict.reason).not.toBe('same-turn');
      }),
    );
  });

  it('空记录 + 至少 1 的阈值必定放行', () => {
    fc.assert(
      fc.property(
        fc.record({
          messageId: fc.string(),
          turn: fc.integer({ min: 0, max: 5 }),
          source,
        }),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 30 }),
        (target, maxPerMessage, maxPerHour) => {
          for (const costModel of ['paid', 'local'] as const) {
            expect(
              checkQuota({
                records: [],
                target,
                now: NOW,
                limits: { maxPerMessage, maxPerHour },
                costModel,
              }).ok,
            ).toBe(true);
          }
        },
      ),
    );
  });

  it('🔴 local 只可能因 same-turn 被拒 —— L1/L2 那两条花钱防线在本地整条不启用（C9）', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const verdict = checkQuota({ ...input, costModel: 'local' });
        if (!verdict.ok) expect(verdict.reason).toBe('same-turn');
      }),
    );
  });

  it('🔴 换成 local 只会更宽松，绝不会把 paid 放行的那一张拦下', () => {
    // 反过来说也成立：唯一同时命中两种后端的层是 L3，而它与 costModel 无关。
    fc.assert(
      fc.property(inputArb, (input) => {
        const paid = checkQuota({ ...input, costModel: 'paid' });
        const local = checkQuota({ ...input, costModel: 'local' });
        if (paid.ok) expect(local.ok).toBe(true);
      }),
    );
  });
});
