/**
 * SelectableCard.vue — 物品选择卡片测试
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SelectableCard from './SelectableCard.vue'
import type { CatalogItem } from '@engine/start-catalog'

const testItem: CatalogItem = {
  id: 'test_sword',
  name: '测试剑',
  category: 'equipment',
  type: '武器',
  rarity: 'epic',
  tag: ['力量', '单体', '物理'],
  effect: { '物理伤害': '攻击力+30', '流血': '命中后每回合损失50HP' },
  consume: '攻击: 400MP',
  description: '一把用于测试的史诗长剑',
  cost: 50,
}

describe('SelectableCard', () => {
  it('渲染物品名称', () => {
    const wrapper = mount(SelectableCard, {
      props: { item: testItem, selected: false },
    })
    expect(wrapper.text()).toContain('测试剑')
  })

  it('渲染稀有度徽章', () => {
    const wrapper = mount(SelectableCard, {
      props: { item: testItem, selected: false },
    })
    expect(wrapper.text()).toContain('史诗')
  })

  it('未选中时显示"选择"按钮', () => {
    const wrapper = mount(SelectableCard, {
      props: { item: testItem, selected: false },
    })
    expect(wrapper.text()).toContain('选择')
  })

  it('已选中时显示"移除"按钮', () => {
    const wrapper = mount(SelectableCard, {
      props: { item: testItem, selected: true },
    })
    expect(wrapper.text()).toContain('移除')
  })

  it('整卡点击时 emit select 事件', async () => {
    const wrapper = mount(SelectableCard, {
      props: { item: testItem, selected: false },
    })
    await wrapper.find('.selectable-card').trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual([testItem])
  })

  it('已选中时不 emit select', async () => {
    const wrapper = mount(SelectableCard, {
      props: { item: testItem, selected: true },
    })
    await wrapper.find('.selectable-card').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('disabled 时不应响应点击', async () => {
    const wrapper = mount(SelectableCard, {
      props: { item: testItem, selected: false, disabled: true },
    })
    await wrapper.find('.selectable-card').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('显示 consume 信息', () => {
    const wrapper = mount(SelectableCard, {
      props: { item: testItem, selected: false },
    })
    expect(wrapper.text()).toContain('攻击: 400MP')
  })

  it('显示转生点消耗', () => {
    const wrapper = mount(SelectableCard, {
      props: { item: testItem, selected: false },
    })
    expect(wrapper.text()).toContain('50')
  })

  it('稀有度边框色正确', () => {
    const wrapper = mount(SelectableCard, {
      props: { item: testItem, selected: false },
    })
    const card = wrapper.find('.selectable-card')
    // epic → 经主题令牌 var(--theme-quality-epic) 注入到 --q-color（不再写死 hex，主题可换色）
    expect(card.attributes('style')).toContain('--q-color: var(--theme-quality-epic)')
  })
})
