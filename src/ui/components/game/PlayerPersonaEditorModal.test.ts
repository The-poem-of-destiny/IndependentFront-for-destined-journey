/**
 * PlayerPersonaEditorModal — 本地草稿、费用警告与保存/关闭契约。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import PlayerPersonaEditorModal from './PlayerPersonaEditorModal.vue';

const PERSONA = {
  personality: '天真',
  appearance: '身形纤细',
  background: '来自异世界',
};

function mountModal(overrides: Record<string, unknown> = {}) {
  return mount(PlayerPersonaEditorModal, {
    props: {
      open: true,
      persona: PERSONA,
      saving: false,
      error: '',
      ...overrides,
    },
    global: {
      stubs: {
        AppModal: {
          props: ['open', 'title', 'size', 'closable'],
          emits: ['update:open'],
          template:
            '<section v-if="open" class="modal-stub" :data-closable="String(closable)"><slot/><footer><slot name="footer"/></footer></section>',
        },
        AppButton: {
          props: ['disabled', 'loading'],
          template: '<button :disabled="disabled || loading"><slot/></button>',
        },
      },
    },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('PlayerPersonaEditorModal', () => {
  it('打开时带入三项权威人设，并显示缓存与费用警告', () => {
    const wrapper = mountModal();

    const fields = wrapper.findAll('textarea');
    expect(fields.map((field) => field.element.value)).toEqual(['天真', '身形纤细', '来自异世界']);
    expect(wrapper.text()).toContain('可能降低提示词缓存命中');
    expect(wrapper.text()).toContain('额外模型费用');
    expect(wrapper.text()).toContain('不会改写已经发生的剧情');
    expect(wrapper.text()).toContain('不会修改画像生成使用的外貌预设');
  });

  it('未修改时保存禁用；修改后提交完整草稿', async () => {
    const wrapper = mountModal();
    const buttons = wrapper.findAll('button');
    expect(buttons[buttons.length - 1].attributes('disabled')).toBeDefined();

    await wrapper.find('#persona-personality').setValue('冷静但心软');
    const dirtyButtons = wrapper.findAll('button');
    expect(dirtyButtons[dirtyButtons.length - 1].attributes('disabled')).toBeUndefined();
    await dirtyButtons[dirtyButtons.length - 1].trigger('click');

    expect(wrapper.emitted('save')).toEqual([
      [
        {
          personality: '冷静但心软',
          appearance: '身形纤细',
          background: '来自异世界',
        },
      ],
    ]);
  });

  it('保存后以最新人设重新打开时恢复为非脏状态', async () => {
    const wrapper = mountModal();
    await wrapper.find('#persona-personality').setValue('冷静但心软');
    const dirtyButtons = wrapper.findAll('button');
    expect(dirtyButtons[dirtyButtons.length - 1].attributes('disabled')).toBeUndefined();

    await wrapper.setProps({ open: false });
    await wrapper.setProps({
      persona: { ...PERSONA, personality: '冷静但心软' },
      open: true,
    });

    expect((wrapper.find('#persona-personality').element as HTMLTextAreaElement).value).toBe(
      '冷静但心软',
    );
    const reopenedButtons = wrapper.findAll('button');
    expect(reopenedButtons[reopenedButtons.length - 1].attributes('disabled')).toBeDefined();
  });

  it('脏草稿关闭前确认，拒绝确认则保持打开', async () => {
    const wrapper = mountModal();
    await wrapper.find('#persona-background').setValue('新的背景');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await wrapper.findAll('button')[0].trigger('click');
    expect(confirm).toHaveBeenCalledWith('放弃未保存的人设修改？');
    expect(wrapper.emitted('close')).toBeUndefined();

    confirm.mockReturnValue(true);
    await wrapper.findAll('button')[0].trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('保存中不可关闭，失败原因在弹窗内播报', async () => {
    const wrapper = mountModal({ saving: true, error: '人设保存失败，请重试' });

    expect(wrapper.find('.modal-stub').attributes('data-closable')).toBe('false');
    expect(wrapper.find('[role="alert"]').text()).toContain('人设保存失败，请重试');
    expect(wrapper.text()).toContain('保存中…');
    await wrapper.findAll('button')[0].trigger('click');
    expect(wrapper.emitted('close')).toBeUndefined();
  });
});
