/**
 * ItemSystemCard 组件渲染测试
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ItemSystemCard from '../../../src/ui/components/game/cards/ItemSystemCard.vue'
import type { ItemGenSystemEvent } from '@engine/types'

describe('ItemSystemCard', () => {
  const mockEquip: ItemGenSystemEvent = {
    type: 'item_gen',
    itemName: '霜语者之冠',
    quality: '稀有',
    itemType: '装备',
    narrative: '[获得] 霜语者之冠',
    details: {
      skills: [],
      inventory: [],
      equipment: [{
        slot: '头部',
        name: '霜语者之冠',
        description: '冰晶头冠，增幅冰系法术',
        stats: { int: 4 },
        quality: '稀有',
      }],
    },
  }

  const mockSkill: ItemGenSystemEvent = {
    type: 'item_gen',
    itemName: '极光闪现',
    quality: '优良',
    itemType: '技能',
    narrative: '[获得] 极光闪现',
    details: {
      equipment: [],
      inventory: [],
      skills: [{
        name: '极光闪现',
        description: '瞬移20米',
        type: 'active',
        cost: { type: 'MP', amount: 25 },
      }],
    },
  }

  const mockInv: ItemGenSystemEvent = {
    type: 'item_gen',
    itemName: '远古魔力水晶',
    quality: '史诗',
    itemType: '物品',
    narrative: '[获得] 远古魔力水晶',
    details: {
      equipment: [],
      skills: [],
      inventory: [{
        name: '远古魔力水晶',
        description: '紫色水晶',
        quantity: 1,
        type: '材料',
        rarity: '史诗',
      }],
    },
  }

  it('renders item name', () => {
    expect(mount(ItemSystemCard, { props: { event: mockEquip } }).text()).toContain('霜语者之冠')
  })

  it('renders quality', () => {
    expect(mount(ItemSystemCard, { props: { event: mockEquip } }).text()).toContain('稀有')
  })

  it('shows equipment section with slot', async () => {
    const w = mount(ItemSystemCard, { props: { event: mockEquip } })
    // Expand first
    await w.find('.sys-card-header').trigger('click')
    expect(w.text()).toContain('头部')
  })

  it('shows skill section', async () => {
    const w = mount(ItemSystemCard, { props: { event: mockSkill } })
    await w.find('.sys-card-header').trigger('click')
    expect(w.text()).toContain('极光闪现')
  })

  it('shows inventory with quantity', async () => {
    const w = mount(ItemSystemCard, { props: { event: mockInv } })
    await w.find('.sys-card-header').trigger('click')
    expect(w.text()).toContain('远古魔力水晶')
    expect(w.text()).toContain('×1')
  })

  it('starts collapsed', () => {
    const w = mount(ItemSystemCard, { props: { event: mockEquip } })
    expect(w.find('.sys-card-body').exists()).toBe(false)
  })

  it('click header to expand', async () => {
    const w = mount(ItemSystemCard, { props: { event: mockEquip } })
    await w.find('.sys-card-header').trigger('click')
    expect(w.find('.sys-card-body').exists()).toBe(true)
  })
})
