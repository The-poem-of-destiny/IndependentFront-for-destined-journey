/**
 * WorkshopDetailModal.vue — 装前检视（Phase 1 / P1-4 增补）
 *
 * 这一屏的存在理由是 D12: 我们**不做**命定核心冲突拦截，改为把判断依据完整摊开。
 * 所以本文件守的不是「渲染没报错」，而是**摊开的内容是不是真的**:
 *
 * 1. 条目与正则**逐条可展开**，不再只报一个总数。
 * 2. ★ 每条正则的处置预告与**安装时实际发生的事**同源 —— 两处都走
 *    `mapWorkshopRegexes`。若哪天有人在这里另写一套判定，用户就会遇到
 *    「装前说好好的、装完说没导入」，这正是本项目已经犯过一次的错。
 * 3. 长列表**不一次渲染完**（上游有几百条目的项目）。
 *
 * `fetchProject` 整层 mock，绝不发真实请求。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type {
  WorkshopProjectMeta,
  WorkshopSocialMeta,
  WorkshopSourceRegex,
} from '@engine/workshop-types';
import type { WorkshopSourceEntry } from '@engine/workshop-types';
import WorkshopDetailModal from './WorkshopDetailModal.vue';
import { fetchProject } from '../../lib/workshop-client';

vi.mock('../../lib/workshop-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/workshop-client');
  return { ...actual, fetchProject: vi.fn() };
});

const fetchMock = vi.mocked(fetchProject);

function meta(over: Partial<WorkshopProjectMeta> = {}): WorkshopProjectMeta {
  return {
    id: 'p1',
    rootProjectId: 'r1',
    name: '维拉的旅途',
    description: '一段外传',
    version: '1.2.0',
    authorName: '某位作者',
    tags: ['扩展'],
    coverUrl: undefined,
    downloadUrl: 'https://example.invalid/p1.json',
    fileSize: 2048,
    ...over,
  };
}

function entry(over: Partial<WorkshopSourceEntry> = {}): WorkshopSourceEntry {
  return {
    sourceUid: 1,
    name: '晨雾中的港口',
    content: '海雾漫过石阶，桅杆在灰白里若隐若现。',
    enabled: true,
    key: ['港口'],
    keysecondary: [],
    selectiveLogic: 0,
    order: 100,
    position: 4,
    ...over,
  };
}

function regex(over: Partial<WorkshopSourceRegex> = {}): WorkshopSourceRegex {
  return {
    id: 'rx1',
    scriptName: '对话染色',
    findRegex: '/「(.+?)」/g',
    replaceString: '<span class="quote">「$1」</span>',
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    trimStrings: [],
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    ...over,
  };
}

function detail(
  entries: WorkshopSourceEntry[] = [entry()],
  regexes: WorkshopSourceRegex[] = [regex()],
  social: Partial<WorkshopSocialMeta> = {},
) {
  return {
    ok: true as const,
    fromCache: false,
    data: {
      project: meta(),
      regexEntries: regexes,
      previewEntries: entries,
      // 社交面（D22）：多数用例断言装前检视，计数一律 0/false
      listing: {
        authorId: '',
        authorAvatarUrl: '',
        status: 'approved',
        reviewTarget: 'project',
        rejectReason: '',
        hasPendingDraft: false,
        visibility: true,
        updatedAt: '',
      },
      social: {
        likesCount: 0,
        subscribesCount: 0,
        downloadsCount: 0,
        userLiked: false,
        userSubscribed: false,
        ...social,
      },
    },
  };
}

async function open(over: Record<string, unknown> = {}) {
  const wrapper = mount(WorkshopDetailModal, {
    props: { open: false, projectId: 'p1', ...over },
    attachTo: document.body,
  });
  await wrapper.setProps({ open: true });
  await flushPromises();
  return wrapper;
}

/** 折叠行的头（展开按钮） */
function heads(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll('.wk-row-head')] as HTMLButtonElement[];
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  fetchMock.mockResolvedValue(detail());
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('WorkshopDetailModal 装前检视', () => {
  it('条目与正则逐条列出，展开后能看到关键词与正文', async () => {
    const wrapper = await open();
    // 一条世界书 + 一条正则
    expect(heads()).toHaveLength(2);
    expect(document.body.textContent).toContain('晨雾中的港口');
    expect(document.body.textContent).toContain('对话染色');

    // 收起时给一段正文摘要，不必展开就能扫
    expect(document.body.querySelector('.wk-row-peek')?.textContent).toContain('海雾漫过石阶');

    heads()[0].click();
    await flushPromises();
    const body = document.body.querySelector('.wk-row-body.body-open');
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain('港口'); // 主要关键词
    expect(body!.textContent).toContain('海雾漫过石阶'); // 完整正文
    wrapper.unmount();
  });

  it('没有次要关键词时不显示 selectiveLogic —— 那时它对结果毫无影响，显示只会误导', async () => {
    const wrapper = await open();
    heads()[0].click();
    await flushPromises();
    expect(document.body.textContent).not.toContain('任一次要命中');
    wrapper.unmount();
  });

  it('有次要关键词时把匹配逻辑一并说清', async () => {
    fetchMock.mockResolvedValue(detail([entry({ keysecondary: ['雾'], selectiveLogic: 3 })]));
    const wrapper = await open();
    heads()[0].click();
    await flushPromises();
    expect(document.body.textContent).toContain('全部次要命中');
    wrapper.unmount();
  });

  it('★ promptOnly 的正则装前就标「不会生效」，并计入顶部提要', async () => {
    // promptOnly 在 mapWorkshopRegexes 里是整条跳过 —— 装完一条规则都不会有。
    // 与其装完在已装列表里说「1 项未导入」，不如装之前就在这一条上说清楚。
    fetchMock.mockResolvedValue(detail([entry()], [regex({ promptOnly: true })]));
    const wrapper = await open();
    expect(document.body.querySelector('.wk-predrop')?.textContent).toContain('1');
    expect(document.body.querySelector('.flag-drop')?.textContent).toContain('不会生效');
    wrapper.unmount();
  });

  it('正常正则不带「不会生效」，也不出顶部提要', async () => {
    const wrapper = await open();
    expect(document.body.querySelector('.wk-predrop')).toBeNull();
    expect(document.body.querySelector('.flag-drop')).toBeNull();
    wrapper.unmount();
  });

  it('iframe 内样式与外部资源不再误报降级', async () => {
    fetchMock.mockResolvedValue(
      detail(
        [entry()],
        [
          regex({
            replaceString:
              '<style>body{color:red}</style><img src="https://cdn.example/image.png">$1',
          }),
        ],
      ),
    );
    const wrapper = await open();
    expect(document.body.querySelector('.flag-side')).toBeNull();
    expect(document.body.querySelector('.flag-drop')).toBeNull();
    heads()[1].click();
    await flushPromises();
    expect(document.body.querySelector('.note-degraded')).toBeNull();
    wrapper.unmount();
  });

  it('长列表先渲一屏，其余按需展开', async () => {
    const many = Array.from({ length: 60 }, (_, i) => entry({ name: `条目${i}`, sourceUid: i }));
    fetchMock.mockResolvedValue(detail(many, []));
    const wrapper = await open();
    // 25 是一屏的量；一次性渲 60 个折叠行会让模态开启卡一拍
    expect(heads()).toHaveLength(25);
    expect(document.body.textContent).toContain('展开其余 35 条');

    const more = [...document.body.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('展开其余'),
    ) as HTMLButtonElement;
    more.click();
    await flushPromises();
    expect(heads()).toHaveLength(60);
    wrapper.unmount();
  });

  // ═══ 社交面（P3c）：同一份详情响应顺带带回来，零额外请求 ═══

  it('★ 三个计数摊在底栏，点赞/订阅是放大版按钮', async () => {
    fetchMock.mockResolvedValue(
      detail([entry()], [regex()], {
        likesCount: 12,
        subscribesCount: 4,
        downloadsCount: 88,
        userSubscribed: true,
      }),
    );
    const wrapper = await open();

    const footer = document.body.querySelector('.modal-footer')!;
    const btns = [...footer.querySelectorAll('.wk-social-btn')] as HTMLButtonElement[];
    expect(btns).toHaveLength(2);
    expect(btns[0].textContent).toContain('点赞');
    expect(btns[0].textContent).toContain('12');
    expect(btns[1].textContent).toContain('订阅');
    expect(btns[1].textContent).toContain('4');
    // 「我」订阅着 → 按下态（aria-pressed 而不是只靠颜色）
    expect(btns[1].getAttribute('aria-pressed')).toBe('true');
    expect(btns[0].getAttribute('aria-pressed')).toBe('false');
    // 下载数只在详情露面，且只是展示（§1.3：绝大多数下载被边缘缓存挡在计数之前）
    expect(footer.querySelector('.wk-social-downloads')!.textContent).toContain('88');
    wrapper.unmount();
  });

  it('★ 未登录点赞：只给引导，不发请求（fetchProject 调用数不变）', async () => {
    const wrapper = await open();
    const before = fetchMock.mock.calls.length;

    const like = document.body.querySelector('.wk-social-btn') as HTMLButtonElement;
    like.click();
    await flushPromises();

    expect(fetchMock.mock.calls).toHaveLength(before);
    // 引导走 toast（本组件不自带播报区），断言它没有变成一次网络往返即可
    expect(document.body.querySelector('.wk-social-btn')!.getAttribute('aria-pressed')).toBe(
      'false',
    );
    wrapper.unmount();
  });

  it('拉不到详情、也没装过时不出社交按钮 —— 项目本身都还没落地', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'Failed to fetch', url: 'u' },
    });
    const wrapper = await open();
    expect(document.body.querySelector('.wk-social-btn')).toBeNull();
    wrapper.unmount();
  });

  it('换项目时展开状态与分页上限一起复位', async () => {
    const wrapper = await open();
    heads()[0].click();
    await flushPromises();
    expect(document.body.querySelector('.body-open')).not.toBeNull();

    fetchMock.mockResolvedValue(detail([entry({ name: '另一个条目' })], []));
    await wrapper.setProps({ projectId: 'p2' });
    await flushPromises();
    // 上一个项目的展开状态不该串到下一个（行的身份是序号，串了就是展开了不相干的条目）
    expect(document.body.querySelector('.body-open')).toBeNull();
    wrapper.unmount();
  });
});
