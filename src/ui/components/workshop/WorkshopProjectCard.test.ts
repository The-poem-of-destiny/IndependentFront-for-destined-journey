/**
 * WorkshopProjectCard.vue + WorkshopSocialActions.vue —— 社交动作（Phase 3 / P3c）
 *
 * 卡片是这对按钮唯一有「外层还有个大点击区」的宿主，所以两件事一起在这里守:
 *
 * 1. **点赞不许打开详情** —— 卡片整块是「打开详情」的点击区。赞一下就弹出一个模态
 *    是最讨厌的一种误触，而它有**两条**通道（鼠标的冒泡、键盘的 keydown 冒泡），
 *    两条都得堵。
 * 2. **未登录一发请求都不出去**（§3.3 / D25）—— 只出引导，不出红色报错，更不出网络。
 * 3. **不编数字** —— 响应里没有社交值时整个计数不渲染；写个 0 顶上去等于向用户断言
 *    「没人赞过」，而我们其实只是不知道。
 *
 * social store 整层替成可断言的假（真 store 的乐观/校正/回滚在
 * `workshop-social-store.test.ts` 里守）。**绝不发真实请求**。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reactive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { WorkshopProjectMeta, WorkshopSocialMeta } from '@engine/workshop-types';
import WorkshopProjectCard from './WorkshopProjectCard.vue';
import { useUIStore } from '../../stores/ui-store';

const h = vi.hoisted(() => ({
  toggleLike: vi.fn(),
  toggleSubscribe: vi.fn(),
}));

/**
 * ★ 假 store 的状态必须 `reactive`。裸对象会把响应式链掐断，于是
 * 「toggle 响应落进 override 之后计数自己刷新」这条断言变成恒真 —— 它就再也
 * 抓不到「组件读的是快照而不是 store」这类回归了。
 */
const state = reactive<{
  loggedIn: boolean;
  overrides: Record<string, WorkshopSocialMeta>;
  busy: string[];
}>({ loggedIn: false, overrides: {}, busy: [] });

vi.mock('../../stores/workshop-social-store', () => ({
  useWorkshopSocialStore: () => ({
    toggleLike: h.toggleLike,
    toggleSubscribe: h.toggleSubscribe,
    get isLoggedIn() {
      return state.loggedIn;
    },
    // §3.3 的优先级规则本体在真 store 里，这里照抄它的形状即可
    socialOf: (id: string, from?: WorkshopSocialMeta) => state.overrides[id] ?? from,
    isBusy: (id: string, kind: string) => state.busy.includes(`${kind}:${id}`),
  }),
}));

function meta(over: Partial<WorkshopProjectMeta> = {}): WorkshopProjectMeta {
  return {
    id: 'p1',
    rootProjectId: 'r1',
    name: '维拉的旅途',
    description: '一段外传',
    version: '1.2.0',
    authorName: '某位作者',
    tags: ['系统'],
    coverUrl: undefined,
    downloadUrl: 'https://example.invalid/p1.json',
    fileSize: 2048,
    ...over,
  };
}

function social(over: Partial<WorkshopSocialMeta> = {}): WorkshopSocialMeta {
  return {
    likesCount: 9,
    subscribesCount: 3,
    downloadsCount: 41,
    userLiked: false,
    userSubscribed: false,
    ...over,
  };
}

function card(props: Record<string, unknown> = {}) {
  return mount(WorkshopProjectCard, {
    props: { project: meta(), ...props },
    attachTo: document.body,
  });
}

/** [点赞, 订阅] 两个按钮 */
function actions(wrapper: ReturnType<typeof card>) {
  return wrapper.findAll('.wk-social-btn');
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  state.loggedIn = false;
  state.overrides = {};
  state.busy = [];
  h.toggleLike.mockResolvedValue({ status: 'ok', social: social({ userLiked: true }) });
  h.toggleSubscribe.mockResolvedValue({ status: 'ok', social: social({ userSubscribed: true }) });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('WorkshopProjectCard 社交动作', () => {
  it('★ 未登录点赞：一次 toggle 都不发，只给一句引导', async () => {
    const ui = useUIStore();
    const wrapper = card({ social: social() });

    await actions(wrapper)[0].trigger('click');
    await flushPromises();

    expect(h.toggleLike).not.toHaveBeenCalled();
    expect(ui.toasts).toHaveLength(1);
    expect(ui.toasts[0].message).toContain('Discord 登录');
    // 引导不是报错 —— 红色 toast 会让「还没登录」看起来像出了故障
    expect(ui.toasts[0].type).toBe('info');
    wrapper.unmount();
  });

  it('已登录点赞：把项目 id 与本次响应的社交值一起交给 store', async () => {
    state.loggedIn = true;
    const from = social();
    const wrapper = card({ social: from });

    await actions(wrapper)[0].trigger('click');
    await flushPromises();

    expect(h.toggleLike).toHaveBeenCalledTimes(1);
    expect(h.toggleLike.mock.calls[0][0]).toBe('p1');
    expect(h.toggleLike.mock.calls[0][1]).toStrictEqual(from);
    wrapper.unmount();
  });

  it('订阅走另一个端点，不会误调点赞', async () => {
    state.loggedIn = true;
    const wrapper = card({ social: social() });

    await actions(wrapper)[1].trigger('click');
    await flushPromises();

    expect(h.toggleSubscribe).toHaveBeenCalledTimes(1);
    expect(h.toggleLike).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('★ toggle 的结果落进 override 后，计数与激活态自己刷新', async () => {
    state.loggedIn = true;
    const wrapper = card({ social: social({ likesCount: 9 }) });
    expect(actions(wrapper)[0].text()).toContain('9');
    expect(actions(wrapper)[0].attributes('aria-pressed')).toBe('false');

    // 真 store 在响应到达时写 override（§3.3 最权威的一层），这里模拟那一步
    h.toggleLike.mockImplementation(async () => {
      state.overrides = { p1: social({ likesCount: 10, userLiked: true }) };
      return { status: 'ok', social: state.overrides.p1 };
    });
    await actions(wrapper)[0].trigger('click');
    await flushPromises();

    expect(actions(wrapper)[0].text()).toContain('10');
    expect(actions(wrapper)[0].attributes('aria-pressed')).toBe('true');
    expect(actions(wrapper)[0].classes()).toContain('is-active');
    wrapper.unmount();
  });

  it('★ 401：同样是引导登录，不是红色报错', async () => {
    state.loggedIn = true;
    h.toggleLike.mockResolvedValue({ status: 'unauthorized' });
    const ui = useUIStore();
    const wrapper = card({ social: social() });

    await actions(wrapper)[0].trigger('click');
    await flushPromises();

    expect(ui.toasts[0].type).toBe('info');
    expect(ui.toasts[0].message).toContain('Discord 登录');
    wrapper.unmount();
  });

  it('失败要说出来，且说清是哪个动作失败了', async () => {
    state.loggedIn = true;
    h.toggleSubscribe.mockResolvedValue({ status: 'failed', message: '连不上创意工坊' });
    const ui = useUIStore();
    const wrapper = card({ social: social() });

    await actions(wrapper)[1].trigger('click');
    await flushPromises();

    expect(ui.toasts[0].type).toBe('error');
    expect(ui.toasts[0].message).toContain('订阅失败');
    wrapper.unmount();
  });

  it('节流/在飞被跳过时不吭声 —— 结果已经在屏幕上了', async () => {
    state.loggedIn = true;
    h.toggleLike.mockResolvedValue({ status: 'skipped', reason: 'throttled' });
    const ui = useUIStore();
    const wrapper = card({ social: social() });

    await actions(wrapper)[0].trigger('click');
    await flushPromises();

    expect(ui.toasts).toHaveLength(0);
    wrapper.unmount();
  });

  it('在飞时该按钮禁用，另一个照常可点（两个端点互不相干）', async () => {
    state.loggedIn = true;
    state.busy = ['like:p1'];
    const wrapper = card({ social: social() });

    expect(actions(wrapper)[0].attributes('disabled')).toBeDefined();
    expect(actions(wrapper)[0].attributes('aria-busy')).toBe('true');
    expect(actions(wrapper)[1].attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  // ═══ ★ 点击隔离：两条通道都要堵 ═══

  it('★ 点赞不打开详情，点卡片本体才打开', async () => {
    state.loggedIn = true;
    const wrapper = card({ social: social() });

    await actions(wrapper)[0].trigger('click');
    await flushPromises();
    expect(wrapper.emitted('open')).toBeUndefined();

    await wrapper.find('.wk-card').trigger('click');
    expect(wrapper.emitted('open')).toEqual([['p1']]);
    wrapper.unmount();
  });

  it('★ 焦点在点赞按钮上敲回车，同样不该打开详情', async () => {
    // 键盘走的是另一条通道: click 被 .stop 拦住了，keydown 仍然一路冒泡到卡片根节点
    state.loggedIn = true;
    const wrapper = card({ social: social() });

    await actions(wrapper)[0].trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('open')).toBeUndefined();

    // 焦点在卡片本身时回车照常打开（根节点从 <button> 换成 div 后不能丢掉这份行为）
    await wrapper.find('.wk-card').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('open')).toEqual([['p1']]);
    wrapper.unmount();
  });

  it('根节点仍是可聚焦、带名字的按钮语义（换成 div 之后不能丢）', () => {
    const wrapper = card({ social: social() });
    const root = wrapper.find('.wk-card');
    expect(root.attributes('role')).toBe('button');
    expect(root.attributes('tabindex')).toBe('0');
    expect(root.attributes('aria-label')).toContain('维拉的旅途');
    // ★ <button> 套 <button> 是非法 HTML，浏览器会把内层按钮提到外面 —— 版式当场散架
    expect(root.element.tagName).toBe('DIV');
    wrapper.unmount();
  });

  // ═══ §3.3：不编数字 ═══

  it('★ 没有社交数据时按钮还在，但一个数字都不显示', () => {
    const wrapper = card(); // 不传 social
    expect(actions(wrapper)).toHaveLength(2);
    expect(wrapper.find('.wk-social-count').exists()).toBe(false);
    wrapper.unmount();
  });

  it('override 压过本次响应携带的值（§3.3 优先级）', () => {
    state.overrides = { p1: social({ likesCount: 99, userLiked: true }) };
    const wrapper = card({ social: social({ likesCount: 9 }) });
    // 列表 TTL 有 120 秒，缓存里的旧计数不许盖掉刚刚点出来的结果
    expect(actions(wrapper)[0].find('.wk-social-count').text()).toBe('99');
    expect(actions(wrapper)[0].attributes('aria-pressed')).toBe('true');
    wrapper.unmount();
  });
});
