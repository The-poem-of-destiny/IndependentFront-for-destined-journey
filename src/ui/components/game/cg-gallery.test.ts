/**
 * cg-gallery.test.ts — CG 图鉴纯逻辑层
 *
 * 钉的是三件**会静默出错**的事（§10.3）:
 *
 * 1. **收录判据** —— 只有 `done` 进图鉴。queued / generating / failed 一条都不进，
 *    否则图鉴从战利品陈列变成待办清单；而 `blobDropped` 的**要进**（它画出来过）。
 * 2. **折叠键是三段的** —— 漏掉 `anchorKind`，`marker#0` 与 `message-end#0`
 *    会被折成同一格，两个不同瞬间的图挤在一处。
 * 3. **兜底可见性的余量** —— 观察器不触发时全靠它，算错就是一屏空白框。
 */
import { describe, it, expect } from 'vitest';
import {
  anchorKeyOf,
  buildGalleryCells,
  canPinSeed,
  isGalleryVisible,
  isNearViewport,
  soleCharacterOf,
} from './cg-gallery';
import type { SceneImageRecord } from '@engine/types-image';

function rec(over: Partial<SceneImageRecord> = {}): SceneImageRecord {
  return {
    id: 'r1',
    saveId: 's1',
    messageId: 'm1',
    anchorKind: 'marker',
    occurrence: 0,
    take: 0,
    turn: 1,
    status: 'done',
    source: 'auto',
    title: '标题',
    description: '',
    intent: '一句中文',
    scenePrompt: 'tavern interior',
    sceneNegative: '',
    characters: [],
    rating: 'general',
    positive: '',
    negative: '',
    model: 'nai-diffusion-4-5-full',
    params: {},
    createdAt: 100,
    ...over,
  };
}

describe('isGalleryVisible', () => {
  it('只收 done —— 未生成与失败的都不进图鉴', () => {
    expect(isGalleryVisible(rec({ status: 'done' }))).toBe(true);
    expect(isGalleryVisible(rec({ status: 'queued' }))).toBe(false);
    expect(isGalleryVisible(rec({ status: 'generating' }))).toBe(false);
    expect(isGalleryVisible(rec({ status: 'failed' }))).toBe(false);
  });

  it('字节被清理过的照收 —— 这张图画出来过（D47）', () => {
    expect(isGalleryVisible(rec({ status: 'done', blobDropped: true }))).toBe(true);
  });
});

describe('buildGalleryCells', () => {
  it('按 turn 升序排列，剧情顺序而不是落库顺序', () => {
    const cells = buildGalleryCells([
      rec({ id: 'c', messageId: 'm3', turn: 9, createdAt: 1 }),
      rec({ id: 'a', messageId: 'm1', turn: 2, createdAt: 999 }),
      rec({ id: 'b', messageId: 'm2', turn: 5, createdAt: 500 }),
    ]);
    expect(cells.map((c) => c.turn)).toEqual([2, 5, 9]);
  });

  it('同一锚点的多 take 折成一格，格数不随重画次数增长', () => {
    const cells = buildGalleryCells([
      rec({ id: 'a0', take: 0, createdAt: 100 }),
      rec({ id: 'a1', take: 1, createdAt: 200 }),
      rec({ id: 'a2', take: 2, createdAt: 300 }),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0].takes.map((t) => t.id)).toEqual(['a0', 'a1', 'a2']);
    // 没钉住时显示 take 最大者
    expect(cells[0].displayed.id).toBe('a2');
  });

  it('钉住的那一 take 才是格子上显示的那张（D45）', () => {
    const cells = buildGalleryCells([
      rec({ id: 'a0', take: 0 }),
      rec({ id: 'a1', take: 1, pinned: true }),
      rec({ id: 'a2', take: 2 }),
    ]);
    expect(cells[0].displayed.id).toBe('a1');
  });

  it('🔴 anchorKind 不同就不是同一格 —— marker#0 与 message-end#0 各占一格', () => {
    const cells = buildGalleryCells([
      rec({ id: 'x', anchorKind: 'marker', occurrence: 0 }),
      rec({ id: 'y', anchorKind: 'message-end', occurrence: 0 }),
    ]);
    expect(cells).toHaveLength(2);
    expect(anchorKeyOf(rec({ anchorKind: 'marker', occurrence: 0 }))).not.toBe(
      anchorKeyOf(rec({ anchorKind: 'message-end', occurrence: 0 })),
    );
  });

  it('未生成 / 失败的记录一格都不产（图鉴不是待办清单）', () => {
    const cells = buildGalleryCells([
      rec({ id: 'q', messageId: 'm1', status: 'queued' }),
      rec({ id: 'g', messageId: 'm2', status: 'generating' }),
      rec({ id: 'f', messageId: 'm3', status: 'failed' }),
      rec({ id: 'd', messageId: 'm4', status: 'done' }),
    ]);
    expect(cells.map((c) => c.displayed.id)).toEqual(['d']);
  });

  it('已清理的格子照样在列，只是没有字节', () => {
    const cells = buildGalleryCells([rec({ id: 'd', blobDropped: true })]);
    expect(cells).toHaveLength(1);
    expect(cells[0].displayed.blobDropped).toBe(true);
  });

  it('同回合内按最早那张的时间排，输入顺序变了结果不变', () => {
    const a = rec({ id: 'a', messageId: 'm1', turn: 3, createdAt: 100 });
    const b = rec({ id: 'b', messageId: 'm2', turn: 3, createdAt: 200 });
    expect(buildGalleryCells([a, b]).map((c) => c.displayed.id)).toEqual(['a', 'b']);
    expect(buildGalleryCells([b, a]).map((c) => c.displayed.id)).toEqual(['a', 'b']);
  });
});

describe('soleCharacterOf / canPinSeed', () => {
  it('恰好一个角色才给名字', () => {
    expect(soleCharacterOf(rec({ characters: ['苏婉'] }))).toBe('苏婉');
    expect(soleCharacterOf(rec({ characters: [] }))).toBeNull();
    expect(soleCharacterOf(rec({ characters: ['苏婉', '林越'] }))).toBeNull();
  });

  it('名字原样返回，不 trim（预设按 === 查中）', () => {
    expect(soleCharacterOf(rec({ characters: ['苏婉 '] }))).toBe('苏婉 ');
  });

  it('随机 seed 的那次没有可钉的东西', () => {
    expect(canPinSeed(rec({ characters: ['苏婉'], seed: 12345 }))).toBe(true);
    expect(canPinSeed(rec({ characters: ['苏婉'] }))).toBe(false);
    expect(canPinSeed(rec({ characters: ['苏婉', '林越'], seed: 1 }))).toBe(false);
  });
});

describe('isNearViewport', () => {
  const vh = 800;

  it('视口内的算可见', () => {
    expect(isNearViewport({ top: 100, bottom: 300 }, vh)).toBe(true);
  });

  it('视口下方 1500px 之内的也算 —— 提前装好，滚过去时不是空白框', () => {
    expect(isNearViewport({ top: vh + 1000, bottom: vh + 1200 }, vh)).toBe(true);
  });

  it('超出余量的不装', () => {
    expect(isNearViewport({ top: vh + 1600, bottom: vh + 1800 }, vh)).toBe(false);
    expect(isNearViewport({ top: -2000, bottom: -1600 }, vh)).toBe(false);
  });

  it('余量可调，边界是闭的', () => {
    expect(isNearViewport({ top: vh + 100, bottom: vh + 200 }, vh, 100)).toBe(true);
    expect(isNearViewport({ top: vh + 101, bottom: vh + 200 }, vh, 100)).toBe(false);
  });
});
