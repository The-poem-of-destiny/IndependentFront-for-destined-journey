/**
 * CraftSystemCard 组件渲染测试
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CraftSystemCard from '../../../src/ui/components/game/cards/CraftSystemCard.vue'
import type { CraftSystemEvent } from '@engine/types'

describe('CraftSystemCard', () => {
  const mockSuccess: CraftSystemEvent = {
    type: 'craft',
    productName: '精铁龙鳞长剑',
    quality: '稀有',
    rating: '精益求精',
    narrative: '你握紧铁锤，将烧红的铁块放在铁砧上...',
    details: {
      success: true,
      productName: '精铁龙鳞长剑',
      quality: '稀有',
      rating: '精益求精',
      checkSummary: 'DC16，d20掷出15+5(力量)+2(锻造技能)=22，总检定值22 vs DC16，评级: 精益求精',
      perfectionBonus: '单件-获得额外词条: 锻火余温',
      itemRequests: [
        { type: 'equipment', slot: '武器', quality: '稀有', description: '用精炼铁矿石与火龙鳞片锻造的长剑。剑身修长轻便。' },
        { type: 'inventory', quality: '普通', description: '锻造中残留的铁屑，可回收利用。' },
      ],
      narrative: '你握紧铁锤...',
      craftParams: {
        industry: '锻造', targetQuality: '稀有', stage: '成品',
        quantity: 1,
        materials: '精炼铁矿石×3, 火龙鳞片×1',
        expGained: 4000, fpGained: 20,
      },
    },
  }

  const mockFail: CraftSystemEvent = {
    type: 'craft',
    productName: '精铁长剑',
    quality: '普通',
    rating: '失败',
    narrative: '铁块出现了微小的裂纹...',
    details: {
      success: false,
      productName: '精铁长剑',
      quality: '普通',
      rating: '失败',
      checkSummary: 'DC6，d20掷出2+5(力量)=7，勉强成功但材料损耗严重',
      itemRequests: [],
      narrative: '铁块出现了微小的裂纹...',
      craftParams: {
        industry: '锻造', targetQuality: '普通', stage: '成品',
        quantity: 1, materials: '精炼铁矿石×3',
        expGained: 0, fpGained: 0,
      },
    },
  }

  it('renders product name and quality', () => {
    const w = mount(CraftSystemCard, { props: { event: mockSuccess } })
    expect(w.text()).toContain('精铁龙鳞长剑')
    expect(w.text()).toContain('稀有')
  })

  it('renders rating with icon', () => {
    const w = mount(CraftSystemCard, { props: { event: mockSuccess } })
    expect(w.text()).toContain('精益求精')
  })

  it('renders perfection bonus', async () => {
    const w = mount(CraftSystemCard, { props: { event: mockSuccess } })
    expect(w.text()).toContain('锻火余温')
  })

  it('renders check summary', async () => {
    const w = mount(CraftSystemCard, { props: { event: mockSuccess } })
    expect(w.text()).toContain('DC16')
    expect(w.text()).toContain('d20')
  })

  it('renders materials split from comma-separated string', async () => {
    const w = mount(CraftSystemCard, { props: { event: mockSuccess } })
    expect(w.text()).toContain('精炼铁矿石×3')
    expect(w.text()).toContain('火龙鳞片×1')
  })

  it('renders item requests with slot and quality', async () => {
    const w = mount(CraftSystemCard, { props: { event: mockSuccess } })
    expect(w.text()).toContain('武器')
  })

  it('renders industry in footer', async () => {
    const w = mount(CraftSystemCard, { props: { event: mockSuccess } })
    expect(w.text()).toContain('锻造')
  })

  it('renders EXP and FP in footer', async () => {
    const w = mount(CraftSystemCard, { props: { event: mockSuccess } })
    expect(w.text()).toContain('4000')
    expect(w.text()).toContain('20')
  })

  it('shows failure badge on fail', () => {
    const w = mount(CraftSystemCard, { props: { event: mockFail } })
    expect(w.text()).toContain('失败')
  })

  it('hides item requests on failure', async () => {
    const w = mount(CraftSystemCard, { props: { event: mockFail } })
    expect(w.text()).not.toContain('制品')
  })

  it('hides EXP/FP when zero', async () => {
    const w = mount(CraftSystemCard, { props: { event: mockFail } })
    // Should not show 0 EXP/FP badges
    expect(w.findAll('.stat-badge').filter(el => el.text().includes('EXP')).length).toBe(0)
  })

  it('body visible by default', () => {
    const w = mount(CraftSystemCard, { props: { event: mockSuccess } })
    expect(w.find('.sys-card-body').isVisible()).toBe(true)
  })

  it('click collapse button emits collapse', async () => {
    const w = mount(CraftSystemCard, { props: { event: mockSuccess } })
    await w.find('.sys-card-collapse').trigger('click')
    expect(w.emitted('collapse')).toBeTruthy()
  })
})
