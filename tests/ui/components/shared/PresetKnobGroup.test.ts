/**
 * PresetKnobGroup.vue —— 预设互斥组单选（纯呈现）：
 * 原生 radio 同 name、radiogroup 无障碍关联、token 显示、none / conflict 提示与不选中、
 * allowNone 的「不使用」、disabled 下不发 select。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import PresetKnobGroup from '../../../../src/ui/components/shared/PresetKnobGroup.vue';

enableAutoUnmount(afterEach);

const options = [
  { id: 'first', label: '第一人称', tokens: 120 },
  { id: 'second', label: '第二人称' },
  { id: 'third', label: '第三人称', tokens: 0 },
];

interface GroupProps {
  selected?: string | null;
  status?: 'ok' | 'none' | 'conflict';
  description?: string;
  disabled?: boolean;
  allowNone?: boolean;
}

function mountGroup(props: GroupProps = {}) {
  return mount(PresetKnobGroup, {
    props: {
      label: '叙事人称',
      options,
      selected: 'second',
      status: 'ok',
      ...props,
    },
    attachTo: document.body,
  });
}

function radios(w: ReturnType<typeof mountGroup>) {
  return w.findAll('input[type="radio"]').map((r) => r.element as HTMLInputElement);
}

describe('PresetKnobGroup', () => {
  it('radiogroup 由标题标注，所有 radio 共用同一 name（方向键原生切换）', () => {
    const w = mountGroup({ description: '决定正文的视角' });
    const group = w.get('[role="radiogroup"]');
    const labelId = group.attributes('aria-labelledby')!;
    expect(document.getElementById(labelId)?.textContent).toBe('叙事人称');
    const descId = group.attributes('aria-describedby')!;
    expect(document.getElementById(descId)?.textContent).toBe('决定正文的视角');

    const rs = radios(w);
    expect(rs).toHaveLength(3);
    expect(new Set(rs.map((r) => r.name)).size).toBe(1);
    expect(rs[0].name).not.toBe('');
  });

  it('同一应用内两个实例的 name 互不相同（否则两组 radio 会互相取消）', () => {
    const w = mount(
      defineComponent({
        components: { PresetKnobGroup },
        setup: () => ({ options }),
        template: `
          <div>
            <PresetKnobGroup label="甲" :options="options" selected="first" status="ok" />
            <PresetKnobGroup label="乙" :options="options" selected="first" status="ok" />
          </div>
        `,
      }),
    );
    const names = w.findAll('input[type="radio"]').map((r) => (r.element as HTMLInputElement).name);
    expect(new Set(names).size).toBe(2);
  });

  it('ok 态选中 selected 对应项；tokens 有值时显示 ≈N tokens', () => {
    const w = mountGroup();
    expect(radios(w).map((r) => r.checked)).toEqual([false, true, false]);
    const labels = w.findAll('.pk-option');
    expect(labels[0].text()).toContain('≈120 tokens');
    expect(labels[1].text()).not.toContain('tokens');
    expect(labels[2].text()).toContain('≈0 tokens');
    expect(w.find('[role="status"]').exists()).toBe(false);
  });

  it('点选一项发 select(id)', async () => {
    const w = mountGroup();
    await w.findAll('input[type="radio"]')[2].setValue(true);
    expect(w.emitted('select')).toEqual([['third']]);
  });

  it('none 态：不选中任何项，提示「未选择」', () => {
    const w = mountGroup({ status: 'none', selected: null });
    expect(radios(w).every((r) => !r.checked)).toBe(true);
    expect(w.get('[role="status"]').text()).toBe('未选择');
  });

  it('conflict 态：即使 selected 有值也不选中，提示修正文案；点一项即发 select', async () => {
    const w = mountGroup({ status: 'conflict', selected: 'first' });
    expect(radios(w).every((r) => !r.checked)).toBe(true);
    expect(w.get('[role="status"]').text()).toBe('同时启用了多项，选一项即可修正');
    await w.findAll('input[type="radio"]')[0].setValue(true);
    expect(w.emitted('select')).toEqual([['first']]);
  });

  it('allowNone：多一个「不使用」，ok + selected=null 时选中它，选它发 select(null)', async () => {
    const w = mountGroup({ allowNone: true, selected: null });
    const rs = radios(w);
    expect(rs).toHaveLength(4);
    expect(w.findAll('.pk-option')[3].text()).toBe('不使用');
    expect(rs.map((r) => r.checked)).toEqual([false, false, false, true]);

    await w.setProps({ selected: 'first' });
    expect(radios(w).map((r) => r.checked)).toEqual([true, false, false, false]);
    await w.findAll('input[type="radio"]')[3].setValue(true);
    expect(w.emitted('select')).toEqual([[null]]);
  });

  it('allowNone + none 态：「不使用」也不选中', () => {
    const w = mountGroup({ allowNone: true, status: 'none', selected: null });
    expect(radios(w).every((r) => !r.checked)).toBe(true);
  });

  it('disabled：radio 全部禁用，不发 select', async () => {
    const w = mountGroup({ disabled: true, allowNone: true });
    expect(radios(w).every((r) => r.disabled)).toBe(true);
    await w.findAll('input[type="radio"]')[0].trigger('change');
    expect(w.emitted('select')).toBeUndefined();
  });
});
