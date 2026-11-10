/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import AboutSection from '../../../../src/ui/components/settings/AboutSection.vue';

vi.mock('../../../../src/ui/branding-defaults', async () => {
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
  it('展示制作人员、项目、技术与许可证信息，不展示世界概览', () => {
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
    for (const contributor of ['Richardoooo', 'December-17th', 'Hilo114']) {
      expect(text).toContain(contributor);
    }
    expect(text).not.toContain('AI 开发协作');
    expect(text).not.toContain('世界观设定');
    expect(text).not.toContain('测试世界观作者');
    expect(text).toContain('项目信息');
    expect(text).toContain('1.0.0');
    expect(text).not.toContain('项目名称');
    expect(text).not.toContain('项目类型');
    expect(text).not.toContain('纪元');
    expect(text).toContain('测试项目说明');
    expect(text).toContain('技术信息');
    expect(text).toContain('Vue 3 + Pinia');
    expect(text).toContain('Dexie.js (IndexedDB)');
    expect(text).not.toContain('测试世界');
    expect(text).not.toContain('第一行概览');
    expect(text).not.toContain('第二行概览');
    expect(text).toContain('Font Awesome Free 6.7.2');
    expect(text).toContain('测试版权信息');
  });
});
