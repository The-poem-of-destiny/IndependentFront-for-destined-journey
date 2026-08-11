/**
 * AppModal — 弹窗外壳
 *
 * 本文件是**审查催生的**: 这个组件有约 15 个调用方、却一条测试都没有，而本轮给它加了
 * 两个档（`size="full"` / `bare`）。最要紧的一条是 `bare` 与 `closable` **必须互不干涉** ——
 * 组件注释里那句「Esc 与点遮罩照旧生效」此前没有任何东西保证它。
 *
 * 顺带把它一直以来的两条不变式也钉住（都属于"坏了不会有人发现"那一类）:
 * - 滚动锁: 带着 `open === true` 被销毁时必须把 `body.overflow` 还回去，
 *   否则整页从此滚不动直到刷新（组件里那段长注释讲的就是这个）。
 * - 点遮罩才关，点内容不关。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import AppModal from './AppModal.vue';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

function modal(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
  wrapper?.unmount();
  wrapper = mount(AppModal, {
    props: { open: true, ...props },
    slots: { default: '<p class="probe">内容</p>', ...slots },
    attachTo: document.body,
  });
  return wrapper;
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

/**
 * 弹窗 `Teleport` 到 body，**`wrapper.find` 够不到它** —— 一律在 document 上找。
 * 点遮罩必须点在遮罩**本身**（`onOverlayClick` 比对 target === currentTarget）。
 */
function clickInDocument(selector: string) {
  (document.querySelector(selector) as HTMLElement).click();
}

describe('AppModal — bare 档', () => {
  it('bare 不画页头（连关闭 × 也不画），内容照旧渲染', () => {
    modal({ bare: true, title: '标题' });
    expect(document.querySelector('.modal-header')).toBeNull();
    expect(document.querySelector('.modal-close')).toBeNull();
    expect(document.querySelector('.probe')).not.toBeNull();
  });

  it('不传 bare 时页头照旧（回归护栏：老调用方零改动）', () => {
    modal({ title: '标题' });
    expect(document.querySelector('.modal-header')).not.toBeNull();
    expect(document.querySelector('.modal-title')?.textContent).toBe('标题');
  });

  /**
   * ★ 本文件存在的首要理由。`bare` 让出的只是**外壳**，不是"能不能关" ——
   * 把它写成 `closable: false` 会顺手废掉 design.md §4.5 要求必须支持的 Esc，
   * 而那种回归在界面上完全看不出来（弹窗还能用，只是按 Esc 没反应）。
   */
  it('★ bare 之下 Esc 照旧关闭', () => {
    const w = modal({ bare: true });
    pressEscape();
    expect(w.emitted('update:open')?.[0]).toEqual([false]);
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('★ bare 之下点遮罩照旧关闭', () => {
    const w = modal({ bare: true });
    clickInDocument('.modal-overlay');
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('bare 给 .modal-content 挂 modal-bare（body 内边距靠它撤）', () => {
    modal({ bare: true, size: 'full' });
    const content = document.querySelector('.modal-content') as HTMLElement;
    expect(content.className).toContain('modal-bare');
    expect(content.className).toContain('modal-full');
  });
});

describe('AppModal — closable: false', () => {
  it('三条关闭途径一起没（Esc / 点遮罩 / ×）', () => {
    const w = modal({ closable: false });
    pressEscape();
    clickInDocument('.modal-overlay');
    expect(w.emitted('close')).toBeUndefined();
    expect(document.querySelector('.modal-close')).toBeNull();
  });
});

describe('AppModal — 尺寸档', () => {
  it('缺省是 md；每一档落到同名 class 上', () => {
    modal();
    expect(document.querySelector('.modal-content')?.className).toContain('modal-md');
    for (const size of ['sm', 'md', 'lg', 'xl', 'xxl', 'full']) {
      modal({ size });
      expect(document.querySelector('.modal-content')?.className).toContain(`modal-${size}`);
    }
  });
});

describe('AppModal — 交互与副作用', () => {
  it('点内容不关（只有点在遮罩本身才算）', () => {
    const w = modal();
    clickInDocument('.probe');
    expect(w.emitted('close')).toBeUndefined();
  });

  it('open 切换时锁/解锁页面滚动', async () => {
    const w = modal({ open: false });
    await w.setProps({ open: true });
    expect(document.body.style.overflow).toBe('hidden');
    await w.setProps({ open: false });
    expect(document.body.style.overflow).toBe('');
  });

  /**
   * ★ 组件里那段长注释讲的路径: 带着 `open === true` 被销毁时 watch 不触发，
   * `body` 会永远停在 `overflow: hidden` —— 整页从此滚不动，直到刷新。
   *
   * 📌 先 `open: false` 再切真，是照**生产的挂载方式**来的: 那个 watch 不是
   * `immediate`，所以「挂载时就已经是 open」并不会上锁。全部调用方都是常驻挂载 +
   * 切 prop（本次新增的角色查看器也是），所以这条路径不存在；这里刻意按真实用法
   * 触发上锁，而不是把测试写成组件做不到的样子。
   */
  it('★ 带着 open=true 被销毁时把滚动锁还回去', async () => {
    const w = modal({ open: false });
    await w.setProps({ open: true });
    expect(document.body.style.overflow).toBe('hidden');
    w.unmount();
    wrapper = null;
    expect(document.body.style.overflow).toBe('');
  });

  it('open=false 时不渲染任何东西', () => {
    modal({ open: false });
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });
});
