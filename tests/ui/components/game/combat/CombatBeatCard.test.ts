/** @vitest-environment jsdom */
/**
 * CombatBeatCard.test.ts — 直出战斗逐拍行为卡的渲染。
 *
 * 头像位的 AssetMedia 用替身（真组件要连素材 store）：替身只渲染插槽，
 * 于是「没有素材 → 名字首字题签」这条兜底能直接断言。
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import CombatBeatCard from '../../../../../src/ui/components/game/combat/CombatBeatCard.vue';
import type { CombatBeat } from '../../../../../src/ui/components/game/combat/combat-view';

const AssetMediaStub = {
  name: 'AssetMedia',
  props: ['name', 'type', 'variant'],
  template: '<span class="am-stub" :data-name="name"><slot /></span>',
};

function beat(over: Partial<CombatBeat> = {}): CombatBeat {
  return {
    actor: '艾琳',
    target: '灰狼',
    targets: ['灰狼'],
    action: '裂风斩',
    roll: '14 命中',
    damage: '36',
    heal: null,
    cost: 'SP 12',
    status: ['灰狼 HP 40/76'],
    rest: [{ label: '备注', value: '风声' }],
    ...over,
  };
}

function mountCard(b: CombatBeat) {
  return mount(CombatBeatCard, {
    props: { beat: b },
    global: { stubs: { AssetMedia: AssetMediaStub } },
  });
}

describe('CombatBeatCard', () => {
  it('头部给行动者与目标头像位，名字首字作兜底题签', () => {
    const w = mountCard(beat());
    const faces = w.findAll('.am-stub');
    expect(faces.map((f) => f.attributes('data-name'))).toEqual(['艾琳', '灰狼']);
    expect(w.findAll('.beat-initial').map((n) => n.text())).toEqual(['艾', '灰']);
    expect(w.find('.beat-action-name').text()).toBe('裂风斩');
    expect(w.find('.beat-arrow').exists()).toBe(true);
  });

  it('按协议顺序列出判定 / 伤害 / 消耗 / 状态 / 其余行，伤害带语气标记', () => {
    const w = mountCard(beat());
    expect(w.findAll('dt').map((n) => n.text())).toEqual(['判定', '伤害', '消耗', '状态', '备注']);
    expect(w.find('[data-tone="harm"] dd').text()).toBe('36');
  });

  it('无目标时不画箭头与目标位；恢复行用 heal 语气', () => {
    const w = mountCard(
      beat({ target: null, targets: [], damage: null, heal: '24', status: [], rest: [] }),
    );
    expect(w.find('.beat-arrow').exists()).toBe(false);
    expect(w.find('.beat-party--target').exists()).toBe(false);
    expect(w.find('[data-tone="heal"] dd').text()).toBe('24');
  });

  it('多目标最多三枚头像，名字原文照写', () => {
    const w = mountCard(beat({ target: '甲、乙、丙、丁', targets: ['甲', '乙', '丙', '丁'] }));
    expect(w.findAll('.beat-party--target .am-stub')).toHaveLength(3);
    expect(w.find('.beat-party--target .beat-name').text()).toBe('甲、乙、丙、丁');
  });

  it('模型文本只当文本渲染', () => {
    const w = mountCard(beat({ action: '<img src=x onerror=alert(1)>' }));
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('.beat-action-name').text()).toContain('<img');
  });
});
