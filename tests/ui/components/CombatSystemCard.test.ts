/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CombatSystemCard from '../../../src/ui/components/game/cards/CombatSystemCard.vue'
import type { CombatSystemEvent } from '../../../src/sillytavern/types'

describe('CombatSystemCard', () => {
  const mockWin: CombatSystemEvent = {
    type: 'combat', outcome: 'ally_win',
    narrative: '[战斗] 胜利 · 5回合 · EXP +180',
    details: {
      narrativeSummary: '你们击败了三头冰原狼。',
      patches: [], totalExp: 180, totalFp: 25,
      loot: [
        { name: '冰原狼牙', description: '锋利冰属性材料', quantity: 3, quality: '稀有' },
        { name: '狼皮披肩', description: '保暖披肩', quantity: 1, quality: '优良' },
      ],
      rounds: 5, outcome: 'ally_win',
    },
  }

  const mockNoLoot: CombatSystemEvent = {
    type: 'combat', outcome: 'draw',
    narrative: '[战斗] 平局',
    details: {
      narrativeSummary: '双方疲惫撤退。',
      patches: [], totalExp: 80, totalFp: 10,
      loot: [], rounds: 8, outcome: 'draw',
    },
  }

  it('renders outcome label', () => {
    const w = mount(CombatSystemCard, { props: { event: mockWin } })
    expect(w.text()).toContain('胜利')
    expect(w.text()).toContain('5 回合')
  })

  it('renders loot items with quantity', () => {
    const w = mount(CombatSystemCard, { props: { event: mockWin } })
    expect(w.text()).toContain('冰原狼牙')
    expect(w.text()).toContain('×3')
  })

  it('renders EXP and FP', () => {
    const w = mount(CombatSystemCard, { props: { event: mockWin } })
    expect(w.text()).toContain('180')
    expect(w.text()).toContain('25')
  })

  it('hides loot section when empty', () => {
    const w = mount(CombatSystemCard, { props: { event: mockNoLoot } })
    expect(w.text()).not.toContain('战利品')
  })

  it('starts expanded', () => {
    const w = mount(CombatSystemCard, { props: { event: mockWin } })
    expect(w.find('.sys-card-body').isVisible()).toBe(true)
  })

  it('click collapse button emits collapse', async () => {
    const w = mount(CombatSystemCard, { props: { event: mockWin } })
    await w.find('.sys-card-collapse').trigger('click')
    expect(w.emitted('collapse')).toBeTruthy()
  })
})
