/**
 * portrait-messages.test.ts — 画像文案层（Q-25）
 *
 * 收发都是普通值，所以**一行 mount 都没有**：没有 Pinia、没有 game store、
 * 没有 jsdom。同级的 `StatusOverview.assets.test.ts` 仍在，从组件那头把同一批
 * 判据再验一遍 —— 它是搬迁"行为等价"的证据，这里补的是判据本身的穷举。
 */
import { describe, it, expect } from 'vitest';
import {
  describeCropSaved,
  describePortraitWrite,
  portraitMessage,
  type PortraitToast,
} from './portrait-messages';
import type { AssetMetaRecord } from '@engine/types';
import type { AssetMutationOutcome } from '../../stores/asset-store';

function row(over: Partial<AssetMetaRecord> = {}): AssetMetaRecord {
  return {
    id: 'a1',
    name: '苏婉',
    type: '立绘',
    variant: undefined,
    mime: 'image/png',
    bytes: 1024,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as AssetMetaRecord;
}

describe('portraitMessage — 每种结局一句属于它自己的话', () => {
  it('ok → info，且点名是谁的画像', () => {
    expect(portraitMessage('ok', '苏婉')).toEqual<PortraitToast>({
      text: '已把这张图设为「苏婉」的画像。',
      type: 'info',
    });
  });

  it('🔴 naming-invariant 必须归因到**角色名**，不能含糊报成导入失败', () => {
    const { text, type } = portraitMessage('naming-invariant', '苏婉头像');
    expect(type).toBe('error');
    expect(text).toContain('苏婉头像');
    expect(text).toContain('角色名');
    expect(text).toContain('请先改角色名');
    // 这条路径上文件名只贡献扩展名 —— 不该把用户引去改文件名
    expect(text).not.toContain('换一张');
  });

  it('🔴 unrepresentable-name 同样归因到角色名（D19），且与 D16 那句可区分', () => {
    const d19 = portraitMessage('unrepresentable-name', 'a/b');
    const d16 = portraitMessage('naming-invariant', 'a/b');
    expect(d19.type).toBe('error');
    expect(d19.text).toContain('请先改角色名');
    expect(d19.text).not.toBe(d16.text);
    // D19 说的是路径/隐藏文件，D16 说的是类型词
    expect(d19.text).toContain('导出成素材包');
    expect(d16.text).toContain('类型词');
  });

  it('media-rule → 让用户换图片，不谈名字', () => {
    const { text, type } = portraitMessage('media-rule', '苏婉');
    expect(type).toBe('error');
    expect(text).toContain('mp4');
    expect(text).not.toContain('角色名');
  });

  it('其余结局归到"没能存进素材库"这一句', () => {
    for (const o of ['not-found', 'failed', 'already-base', 'no-crops'] as AssetMutationOutcome[]) {
      const { text, type } = portraitMessage(o, '苏婉');
      expect(type).toBe('error');
      expect(text).toContain('没能存进素材库');
    }
  });

  it('🔴 busy 走的也是兜底句 —— 调用方必须在到这里之前就返回', () => {
    // 互斥闸自己已经播报过「已有一个导入正在进行」；本表**刻意**不为它留分支，
    // 所以真让 busy 走到这里会说错话。这条断言把那个约定钉死：口径变了就红。
    expect(portraitMessage('busy', '苏婉').text).toContain('没能存进素材库');
  });
});

describe('describePortraitWrite — 判据是"这一格现在显示的是不是刚写的那一行"', () => {
  const base = { name: '苏婉', slot: '立绘bg' as const };

  it('写进去且链正好命中它 → info，说"已设为画像"', () => {
    const r = describePortraitWrite({
      ...base,
      outcome: 'ok',
      id: 'new1',
      shown: row({ id: 'new1', type: '立绘bg' }),
    });
    expect(r).toEqual<PortraitToast>({ text: '已把这段视频设为「苏婉」的画像。', type: 'info' });
  });

  it('链上什么都没命中（shown = null）→ 仍按成功说', () => {
    expect(describePortraitWrite({ ...base, outcome: 'ok', id: 'new1', shown: null }).type).toBe(
      'info',
    );
  });

  it('🔴 被前面的档位压住 → warning，照实说没变化 + 谁压着 + 去哪解决', () => {
    const { text, type } = describePortraitWrite({
      ...base,
      outcome: 'ok',
      id: 'new1',
      shown: row({ id: 'old0', type: '立绘' }),
    });
    expect(type).toBe('warning');
    expect(text).toContain('没有任何变化');
    expect(text).toContain('立绘'); // 谁压着
    expect(text).toContain('设置 → 素材'); // 去哪解决
    // 绝不能冒充成功
    expect(text).not.toContain('已把这段视频设为「苏婉」的画像。');
  });

  it('写进的那一格出现在文案里（slot 是参数，不是本层硬写的常量）', () => {
    const { text } = describePortraitWrite({
      name: '苏婉',
      slot: '头像',
      outcome: 'ok',
      id: 'new1',
      shown: row({ id: 'old0', type: '立绘' }),
    });
    expect(text).toContain('「头像」');
  });

  it('outcome 不是 ok → 原样委托给 portraitMessage（不再自造一套说法）', () => {
    for (const o of ['failed', 'media-rule', 'naming-invariant'] as AssetMutationOutcome[]) {
      expect(describePortraitWrite({ ...base, outcome: o, id: undefined, shown: null })).toEqual(
        portraitMessage(o, '苏婉'),
      );
    }
  });

  it('🔴 outcome 说 ok 但没拿到 id → 当失败处理，不报成功', () => {
    // store 返回 ok 却没有 id 是自相矛盾的；宁可说没存进去，也不要弹一句
    // 「已设为画像」然后画面纹丝不动。
    expect(describePortraitWrite({ ...base, outcome: 'ok', id: undefined, shown: null })).toEqual(
      portraitMessage('ok', '苏婉'),
    );
  });
});

describe('describeCropSaved — 数出来几张就念几张', () => {
  it('两半都落地 → 「立绘与头像」', () => {
    expect(describeCropSaved({ portraitId: 'p', avatarId: 'a' }, '苏婉')).toEqual<PortraitToast>({
      text: '已把这张图设为「苏婉」的立绘与头像。',
      type: 'info',
    });
  });

  it('只落地立绘 → 只说立绘（部分成功不冒充全成功）', () => {
    expect(describeCropSaved({ portraitId: 'p' }, '苏婉')?.text).toBe(
      '已把这张图设为「苏婉」的立绘。',
    );
  });

  it('只落地头像 → 只说头像', () => {
    expect(describeCropSaved({ avatarId: 'a' }, '苏婉')?.text).toBe(
      '已把这张图设为「苏婉」的头像。',
    );
  });

  it('🔴 一半都没落地 → null，一句都不说（编辑器已经就地说明过）', () => {
    expect(describeCropSaved({}, '苏婉')).toBeNull();
  });
});
