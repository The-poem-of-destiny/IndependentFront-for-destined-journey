/**
 * PointsBar.vue — 转生点数消耗条测试
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PointsBar from './PointsBar.vue'

describe('PointsBar', () => {
  it('渲染剩余/总量点数', () => {
    const wrapper = mount(PointsBar, {
      props: { total: 1000, used: 200 },
    })
    expect(wrapper.text()).toContain('800')
    expect(wrapper.text()).toContain('1000')
  })

  it('渲染难度标签', () => {
    const wrapper = mount(PointsBar, {
      props: { total: 1000, used: 200, difficultyLabel: '普通' },
    })
    expect(wrapper.text()).toContain('普通')
  })

  it('无难度标签时不渲染括号', () => {
    const wrapper = mount(PointsBar, {
      props: { total: 1000, used: 200 },
    })
    const tag = wrapper.find('.difficulty-tag')
    expect(tag.exists()).toBe(false)
  })

  it('剩余=0 时显示 0 / total', () => {
    const wrapper = mount(PointsBar, {
      props: { total: 500, used: 500 },
    })
    expect(wrapper.text()).toContain('0 / 500')
  })
})
