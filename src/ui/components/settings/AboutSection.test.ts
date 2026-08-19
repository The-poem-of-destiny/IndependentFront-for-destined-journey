/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import AboutSection from './AboutSection.vue';

vi.mock('@engine/index', () => ({ VERSION: '9.8.7' }));
vi.mock('../../branding-defaults', async () => {
  const { ref } = await import('vue');
  return {
    useBranding: () => ({
      branding: ref({
        shortName: '测试项目',
        credits: '测试世界观作者',
        about: '测试项目说明',
        copyright: '测试版权信息',
        era: '测试纪元',
        worldSummary: { title: '测试世界', lines: ['第一行概览', '第二行概览'] },
      }),
    }),
  };
});

describe('AboutSection', () => {
  it('统一展示制作人员、项目、技术、世界概览与许可证信息', () => {
    const wrapper = shallowMount(AboutSection, {
      global: {
        stubs: {
          AppCard: { template: '<article><slot /></article>' },
        },
      },
    });
    const text = wrapper.text();

    expect(text).toContain('关于测试项目');
    expect(text).toContain('制作人员');
    expect(text).toContain('Richard');
    expect(text).toContain('Claude Code');
    expect(text).toContain('测试世界观作者');
    expect(text).toContain('项目信息');
    expect(text).toContain('9.8.7');
    expect(text).toContain('测试项目说明');
    expect(text).toContain('技术信息');
    expect(text).toContain('测试世界');
    expect(text).toContain('第一行概览');
    expect(text).toContain('第二行概览');
    expect(text).toContain('Font Awesome Free 6.7.2');
    expect(text).toContain('测试版权信息');
  });
});
