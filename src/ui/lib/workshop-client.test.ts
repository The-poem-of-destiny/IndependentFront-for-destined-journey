/**
 * workshop-client.test.ts — 唯一网络接触点的行为固定（Phase 1 / P1-2）
 *
 * ⚠️ 本文件**绝不发真实网络请求**。`globalThis.fetch` 在 beforeEach 里被替换成
 * 一个会抛的哨兵：任何一条忘了注入 mock 的路径都会当场炸出「真实网络」而不是
 * 静悄悄地去连上游。测试跑得快慢是小事，CI 里跑出真实流量是事故。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { planInstall } from '@engine/workshop-install-plan';
import {
  WORKSHOP_DEFAULT_PAGE_SIZE,
  WORKSHOP_DETAIL_TTL_MS,
  WORKSHOP_LIST_TTL_MS,
  WORKSHOP_PAYLOAD_TTL_MS,
  WORKSHOP_PAYLOAD_TIMEOUT_MS,
  WORKSHOP_REQUEST_TIMEOUT_MS,
  buildListUrl,
  buildProjectUrl,
  decodeJwtPayload,
  downloadPayload,
  fetchInstallInput,
  fetchProject,
  invalidateWorkshopProject,
  listProjects,
  pollLogin,
  resetWorkshopClient,
  setWorkshopAuthTokenProvider,
  setWorkshopClock,
  setWorkshopConfig,
  setWorkshopFetch,
  getWorkshopApiBase,
  isWorkshopConfigured,
  startLogin,
  toggleLike,
  toggleSubscribe,
  type WorkshopFetchInit,
  type WorkshopFetchLike,
  type WorkshopResponseLike,
} from './workshop-client';

// ═══════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════

/**
 * 测试用的社区源基址（D41）。
 *
 * 🔴 社区源已是**运行时配置**，默认 unset —— 所以每个用例都得先把它配上，
 * 否则 URL 装配会抛「未配置社区源」。用一个显然假的域，跑出真流量也连不到任何东西。
 */
const WORKSHOP_API_BASE = 'https://workshop.test';

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
const DOWNLOAD_URL = `${WORKSHOP_API_BASE}/api/files/projects/${PROJECT_ID}/payload.json`;

/** 上游 `GET /api/projects/{id}` 的形状（附录 C，20 字段里取要紧的） */
function detailResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { project: projectOverrides, ...rest } = overrides;
  return {
    success: true,
    project: {
      id: PROJECT_ID,
      rootProjectId: PROJECT_ID,
      name: '测试扩展包',
      description: '一段简介',
      version: '2.1.0',
      authorId: 'author-1',
      authorName: 'nick',
      authorGlobalName: '全局昵称',
      authorAvatar: 'https://example.invalid/a.png',
      downloadUrl: DOWNLOAD_URL,
      fileSize: 4096,
      coverImage: 'https://example.invalid/cover.png',
      tags: ['世界观', '正则'],
      downloadsCount: 12,
      likesCount: 3,
      subscribesCount: 1,
      userLiked: false,
      userSubscribed: false,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      ...(projectOverrides as Record<string, unknown> | undefined),
    },
    // 详情预览里 uid 是**字符串**、有 `enabled`
    worldbookEntriesPreview: [
      { uid: '0', comment: '预览条目', content: '预览正文', enabled: true, key: ['预览'] },
    ],
    // ★ 正则的唯一来源（P1-1 实测：带完整 replaceString）
    regexEntriesPreview: [
      {
        id: 'regex-uuid-1',
        scriptName: '状态栏美化',
        findRegex: '/<status>([\\s\\S]*?)<\\/status>/g',
        replaceString: '<div class="status">$1</div>',
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: false,
        trimStrings: [],
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
        placement: [2],
      },
    ],
    // project 已在上面按字段合并过，这里只覆盖顶层其余字段（否则会把 project 整块换掉）
    ...rest,
  };
}

/** `downloadUrl` 载荷：裸数组，uid 是**数字**、只有 `disable` */
function payloadResponse(): unknown[] {
  return [
    {
      uid: 0,
      comment: '正式条目甲',
      content: '甲的正文',
      disable: false,
      key: ['甲'],
      order: 50,
      position: 4,
    },
    { uid: 1, comment: '正式条目乙', content: '乙的正文', disable: true, key: ['乙'] },
  ];
}

function jsonResponse(body: unknown): WorkshopResponseLike {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

/** 按 URL 前缀路由的 fetch mock；未登记的 URL 一律 404，绝不落到真实网络 */
function routedFetch(routes: Array<[matcher: string, respond: () => WorkshopResponseLike]>): {
  impl: WorkshopFetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const impl: WorkshopFetchLike = async (url) => {
    calls.push(url);
    for (const [matcher, respond] of routes) {
      if (url.startsWith(matcher)) return respond();
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'not found' };
  };
  return { impl, calls };
}

function happyFetch(): { impl: WorkshopFetchLike; calls: string[] } {
  return routedFetch([
    [DOWNLOAD_URL, () => jsonResponse(payloadResponse())],
    [`${WORKSHOP_API_BASE}/api/projects/${PROJECT_ID}`, () => jsonResponse(detailResponse())],
  ]);
}

let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  resetWorkshopClient();
  // D41：社区源是运行时配置且默认 unset，每个用例都得先配上
  setWorkshopConfig({ apiBase: WORKSHOP_API_BASE, loginHint: '' });
  setWorkshopClock(() => now);
  // 哨兵：任何漏注入的路径都会炸，而不是去连真上游
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('测试里不允许发真实网络请求');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetWorkshopClient();
});

// ═══════════════════════════════════════════════════════════
// URL 拼装
// ═══════════════════════════════════════════════════════════

describe('社区源配置（D41）', () => {
  it('默认 unset —— 引擎自己不带任何社区源地址', () => {
    // 🔴 这条是**开源边界**的钉子，不是功能测试：公开引擎带一个硬编码的社区源，
    //    等于给任意用户一键安装第三方二创内容的入口。它红了说明有人把地址写回代码里了。
    setWorkshopConfig({ apiBase: '', loginHint: '' });
    expect(getWorkshopApiBase()).toBe('');
    expect(isWorkshopConfigured()).toBe(false);
  });

  it('未配置时 URL 装配抛（护栏，不是让请求带着空基址飞出去）', () => {
    setWorkshopConfig({ apiBase: '' });
    expect(() => buildProjectUrl(PROJECT_ID)).toThrow(/未配置社区源/);
  });

  it('尾斜杠被剃掉 —— 拼接一律 `${base}/api/...`，不产生双斜杠', () => {
    setWorkshopConfig({ apiBase: 'https://workshop.test/// '.trim() });
    expect(getWorkshopApiBase()).toBe('https://workshop.test');
    expect(buildProjectUrl('x')).toBe('https://workshop.test/api/projects/x');
  });

  it('配置值决定 URL —— 换一个社区源，请求就去那一个', () => {
    setWorkshopConfig({ apiBase: 'https://mirror.example' });
    expect(buildProjectUrl('x')).toBe('https://mirror.example/api/projects/x');
  });
});

describe('buildListUrl', () => {
  it('缺省带上 page/pageSize/sort，不带 tag/search', () => {
    const url = new URL(buildListUrl());
    expect(url.origin + url.pathname).toBe(`${WORKSHOP_API_BASE}/api/projects`);
    expect(url.searchParams.get('page')).toBe('0');
    expect(url.searchParams.get('pageSize')).toBe(String(WORKSHOP_DEFAULT_PAGE_SIZE));
    expect(url.searchParams.get('sort')).toBe('published');
    expect(url.searchParams.has('tag')).toBe(false);
    expect(url.searchParams.has('search')).toBe(false);
  });

  it('分页/标签/搜索/排序全部拼进去，且搜索词被正确编码', () => {
    const url = new URL(
      buildListUrl({
        page: 3,
        pageSize: 50,
        tag: '世界观',
        search: '命定 & 诗',
        sort: 'downloads',
      }),
    );
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('pageSize')).toBe('50');
    expect(url.searchParams.get('tag')).toBe('世界观');
    expect(url.searchParams.get('search')).toBe('命定 & 诗');
    expect(url.searchParams.get('sort')).toBe('downloads');
    // 编码后不能出现裸 & 把参数劈开
    expect(url.searchParams.get('sort')).not.toContain('诗');
  });

  it('空白 tag/search 视为不传（上游把空串当"筛选空标签"）', () => {
    const url = new URL(buildListUrl({ tag: '   ', search: '\t' }));
    expect(url.searchParams.has('tag')).toBe(false);
    expect(url.searchParams.has('search')).toBe(false);
  });

  it('负数页 / 非法 pageSize 归一到安全值', () => {
    const url = new URL(buildListUrl({ page: -5, pageSize: 0 }));
    expect(url.searchParams.get('page')).toBe('0');
    expect(url.searchParams.get('pageSize')).toBe('1');
    const nan = new URL(buildListUrl({ page: Number.NaN, pageSize: Number.NaN }));
    expect(nan.searchParams.get('page')).toBe('0');
    expect(nan.searchParams.get('pageSize')).toBe(String(WORKSHOP_DEFAULT_PAGE_SIZE));
  });

  it('详情 URL 对 id 做编码', () => {
    expect(buildProjectUrl('a b/c')).toBe(`${WORKSHOP_API_BASE}/api/projects/a%20b%2Fc`);
  });
});

// ═══════════════════════════════════════════════════════════
// listProjects
// ═══════════════════════════════════════════════════════════

describe('listProjects', () => {
  it('解析分页信息与项目列表，缺 id 的项被丢弃并计数', async () => {
    const { impl, calls } = routedFetch([
      [
        `${WORKSHOP_API_BASE}/api/projects?`,
        () =>
          jsonResponse({
            success: true,
            total: 42,
            page: 1,
            pageSize: 20,
            projects: [
              detailResponse().project,
              { name: '没有 id 的野项目' }, // parseProjectMeta 会拒
            ],
          }),
      ],
    ]);
    setWorkshopFetch(impl);

    const res = await listProjects({ page: 1, search: '扩展' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBe(42);
    expect(res.data.page).toBe(1);
    expect(res.data.pageSize).toBe(20);
    expect(res.data.projects).toHaveLength(1);
    // 解析一律走 manifest 纯函数：authorGlobalName 优先、coverImage → coverUrl
    expect(res.data.projects[0].authorName).toBe('全局昵称');
    expect(res.data.projects[0].coverUrl).toBe('https://example.invalid/cover.png');
    expect(res.data.droppedCount).toBe(1);
    expect(calls[0]).toContain('search=');
  });

  it('TTL 内的同一查询命中缓存 —— 翻回上一页/点掉标签不再发请求', async () => {
    const { impl, calls } = routedFetch([
      [`${WORKSHOP_API_BASE}/api/projects?`, () => jsonResponse({ projects: [], total: 0 })],
    ]);
    setWorkshopFetch(impl);

    const first = await listProjects();
    expect(first.ok && first.fromCache).toBe(false);

    now += WORKSHOP_LIST_TTL_MS - 1;
    const second = await listProjects();
    expect(second.ok && second.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('force 越过缓存 —— 工具条上的「刷新」按了就必须真的去拉', async () => {
    const { impl, calls } = routedFetch([
      [`${WORKSHOP_API_BASE}/api/projects?`, () => jsonResponse({ projects: [], total: 0 })],
    ]);
    setWorkshopFetch(impl);

    await listProjects();
    const forced = await listProjects({}, { force: true });
    expect(forced.ok && forced.fromCache).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('TTL 过期后重新拉取（45 秒之外的「打开模态」是新鲜的一屏）', async () => {
    const { impl, calls } = routedFetch([
      [`${WORKSHOP_API_BASE}/api/projects?`, () => jsonResponse({ projects: [], total: 0 })],
    ]);
    setWorkshopFetch(impl);

    await listProjects();
    now += WORKSHOP_LIST_TTL_MS;
    const again = await listProjects();
    expect(again.ok && again.fromCache).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('★ 查询参数不同即不同的键 —— 第 2 页绝不会吃到第 1 页的缓存', async () => {
    // 按 page 参数返回不同内容：串了缓存的话这里会当场露馅
    const calls: string[] = [];
    const byPage: WorkshopFetchLike = async (url) => {
      calls.push(url);
      const page = new URL(url).searchParams.get('page');
      return jsonResponse({ projects: [], total: page === '1' ? 111 : 0 });
    };
    setWorkshopFetch(byPage);

    const p0 = await listProjects({ page: 0 });
    const p1 = await listProjects({ page: 1 });
    const p0Again = await listProjects({ page: 0 });

    expect(p0.ok && p0.data.total).toBe(0);
    expect(p1.ok && p1.data.total).toBe(111);
    // 换搜索词同理：又是一把新钥匙
    const searched = await listProjects({ search: '维拉' });
    expect(searched.ok && searched.fromCache).toBe(false);
    // 回到第 0 页才是命中（同一把钥匙）
    expect(p0Again.ok && p0Again.fromCache).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('projects 缺失时退化为空列表而非报错', async () => {
    setWorkshopFetch(
      routedFetch([[WORKSHOP_API_BASE, () => jsonResponse({ success: true })]]).impl,
    );
    const res = await listProjects();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.projects).toEqual([]);
    expect(res.data.total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// fetchProject / 缓存
// ═══════════════════════════════════════════════════════════

describe('fetchProject', () => {
  it('解析元数据 + 正则（来自 regexEntriesPreview）+ 世界书预览', async () => {
    const { impl } = happyFetch();
    setWorkshopFetch(impl);

    const res = await fetchProject(PROJECT_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.project.id).toBe(PROJECT_ID);
    expect(res.data.project.version).toBe('2.1.0');
    expect(res.data.regexEntries).toHaveLength(1);
    expect(res.data.regexEntries[0].scriptName).toBe('状态栏美化');
    expect(res.data.previewEntries).toHaveLength(1);
    expect(res.data.previewEntries[0].name).toBe('预览条目');
  });

  it('TTL 内命中缓存（fromCache=true，不再发请求）', async () => {
    const { impl, calls } = happyFetch();
    setWorkshopFetch(impl);

    const first = await fetchProject(PROJECT_ID);
    expect(first.ok && first.fromCache).toBe(false);

    now += WORKSHOP_DETAIL_TTL_MS - 1;
    const second = await fetchProject(PROJECT_ID);
    expect(second.ok && second.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('TTL 过期后重新拉取', async () => {
    const { impl, calls } = happyFetch();
    setWorkshopFetch(impl);

    await fetchProject(PROJECT_ID);
    now += WORKSHOP_DETAIL_TTL_MS;
    const again = await fetchProject(PROJECT_ID);
    expect(again.ok && again.fromCache).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('force 绕过缓存', async () => {
    const { impl, calls } = happyFetch();
    setWorkshopFetch(impl);

    await fetchProject(PROJECT_ID);
    const forced = await fetchProject(PROJECT_ID, { force: true });
    expect(forced.ok && forced.fromCache).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('并发调用只发一次请求（在飞去重）', async () => {
    const { impl, calls } = happyFetch();
    setWorkshopFetch(impl);

    const [a, b] = await Promise.all([fetchProject(PROJECT_ID), fetchProject(PROJECT_ID)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('空 id 直接返回 malformed，不发请求', async () => {
    const { impl, calls } = happyFetch();
    setWorkshopFetch(impl);

    const res = await fetchProject('   ');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('malformed');
    expect(calls).toHaveLength(0);
  });
});

describe('downloadPayload', () => {
  it('把载荷交给 parsePayload —— 数字 uid + disable 被归一', async () => {
    const { impl } = happyFetch();
    setWorkshopFetch(impl);

    const res = await downloadPayload(DOWNLOAD_URL);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.worldbookEntries).toHaveLength(2);
    expect(res.data.worldbookEntries[0].name).toBe('正式条目甲');
    expect(res.data.worldbookEntries[0].enabled).toBe(true);
    // disable:true → enabled:false
    expect(res.data.worldbookEntries[1].enabled).toBe(false);
    expect(res.data.regexEntries).toEqual([]);
  });

  it('载荷 TTL 是 15 小时：详情早已过期它仍命中', async () => {
    const { impl, calls } = happyFetch();
    setWorkshopFetch(impl);

    await downloadPayload(DOWNLOAD_URL);
    now += WORKSHOP_DETAIL_TTL_MS * 10;
    const hit = await downloadPayload(DOWNLOAD_URL);
    expect(hit.ok && hit.fromCache).toBe(true);

    now += WORKSHOP_PAYLOAD_TTL_MS;
    const miss = await downloadPayload(DOWNLOAD_URL);
    expect(miss.ok && miss.fromCache).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('空 URL → no_source，不发请求', async () => {
    const { impl, calls } = happyFetch();
    setWorkshopFetch(impl);

    const res = await downloadPayload('');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('no_source');
    expect(calls).toHaveLength(0);
  });

  it('340 KB 级 replaceString 原样透传，不做任何截断', async () => {
    const huge = 'x'.repeat(340 * 1024);
    const detail = detailResponse();
    (detail.regexEntriesPreview as Array<Record<string, unknown>>)[0].replaceString = huge;
    setWorkshopFetch(routedFetch([[WORKSHOP_API_BASE, () => jsonResponse(detail)]]).impl);

    const res = await fetchProject(PROJECT_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.regexEntries[0].replaceString).toHaveLength(huge.length);
  });
});

// ═══════════════════════════════════════════════════════════
// 失败路径 —— 一律结构化返回，绝不抛穿
// ═══════════════════════════════════════════════════════════

describe('失败路径', () => {
  it('fetch 抛异常 → network，不抛穿', async () => {
    setWorkshopFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const res = await fetchProject(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('network');
    expect(res.error.message).toContain('Failed to fetch');
    expect(res.error.url).toBe(buildProjectUrl(PROJECT_ID));
  });

  it('HTTP 404 → http + status（项目已下架）', async () => {
    setWorkshopFetch(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '',
    }));
    const res = await fetchProject(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('http');
    expect(res.error.status).toBe(404);
  });

  it('返回 HTML（Cloudflare 拦截页）→ malformed，message 带响应开头', async () => {
    setWorkshopFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => '<!DOCTYPE html><html><body>error 1015</body></html>',
    }));
    const res = await downloadPayload(DOWNLOAD_URL);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('malformed');
    expect(res.error.message).toContain('<!DOCTYPE html>');
  });

  it('JSON 合法但缺项目 id → malformed', async () => {
    setWorkshopFetch(
      routedFetch([[WORKSHOP_API_BASE, () => jsonResponse({ success: true, project: {} })]]).impl,
    );
    const res = await fetchProject(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('malformed');
  });

  it('失败不写缓存 —— 下一次真的重试', async () => {
    let fail = true;
    const calls: string[] = [];
    setWorkshopFetch(async (url) => {
      calls.push(url);
      if (fail) throw new Error('boom');
      return jsonResponse(detailResponse());
    });

    const bad = await fetchProject(PROJECT_ID);
    expect(bad.ok).toBe(false);
    fail = false;
    const good = await fetchProject(PROJECT_ID);
    expect(good.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('没有可用 fetch 实现时返回 network 而不是崩', async () => {
    setWorkshopFetch(undefined);
    vi.stubGlobal('fetch', undefined);
    const res = await fetchProject(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('network');
  });

  it('响应对象不可读（上游/中间层给了怪东西）→ malformed', async () => {
    setWorkshopFetch(async () => ({ ok: true, status: 200 }) as unknown as WorkshopResponseLike);
    const res = await downloadPayload(DOWNLOAD_URL);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('malformed');
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 组合入口 —— 两个响应合成 planInstall 的输入
// ═══════════════════════════════════════════════════════════

describe('fetchInstallInput', () => {
  it('世界书条目来自载荷、正则来自详情，合成结果能直接喂 planInstall', async () => {
    const { impl, calls } = happyFetch();
    setWorkshopFetch(impl);

    const res = await fetchInstallInput(PROJECT_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const { input, entriesSource, notes } = res.data;
    expect(entriesSource).toBe('download');
    expect(notes).toEqual([]);
    // ★ 条目取自 downloadUrl（不是详情预览的那条「预览条目」）
    expect(input.worldbookEntries.map((e) => e.name)).toEqual(['正式条目甲', '正式条目乙']);
    // ★ 正则取自详情的 regexEntriesPreview
    expect(input.regexEntries).toHaveLength(1);
    expect(calls).toHaveLength(2);

    // 直接喂 planInstall：这是本模块存在的目的
    const plan = planInstall(input, { nextUid: 7 });
    expect(plan.projectId).toBe(PROJECT_ID);
    expect(plan.partition).toBe('creative_workshop');
    expect(plan.entries.map((e) => e.uid)).toEqual([7, 8]);
    expect(plan.entries[0].extra?.workshop?.projectName).toBe('测试扩展包');
    expect(plan.nextUid).toBe(9);
    expect(plan.rules).toHaveLength(1);
    expect(plan.rules[0].name).toBe('状态栏美化');
  });

  it('缓存命中时 fromCache 为 true 且不重复下载', async () => {
    const { impl, calls } = happyFetch();
    setWorkshopFetch(impl);

    await fetchInstallInput(PROJECT_ID);
    const again = await fetchInstallInput(PROJECT_ID);
    expect(again.ok && again.fromCache).toBe(true);
    expect(calls).toHaveLength(2); // 详情 1 + 载荷 1，第二轮全命中
  });

  it('★ force 只重拉详情，不重下载荷 —— 版本内不可变的字节重下也是同一份', async () => {
    // 新版本 = 新 downloadUrl = 新缓存键，所以强制重下**不可能**换来更新的内容，
    // 只会在每次「更新」时白白重传一份最大 340 KB 的同样载荷。
    const { impl, calls } = happyFetch();
    setWorkshopFetch(impl);
    const detailUrl = buildProjectUrl(PROJECT_ID);
    const countOf = (prefix: string): number => calls.filter((u) => u.startsWith(prefix)).length;

    await fetchInstallInput(PROJECT_ID);
    expect(countOf(detailUrl)).toBe(1);
    expect(countOf(DOWNLOAD_URL)).toBe(1);

    const forced = await fetchInstallInput(PROJECT_ID, { force: true });
    expect(forced.ok).toBe(true);
    // 详情确实重拉了（版本号/计数是随时会动的元数据）…
    expect(countOf(detailUrl)).toBe(2);
    // …载荷一次都没再下
    expect(countOf(DOWNLOAD_URL)).toBe(1);
  });

  it('无 downloadUrl 时显式回退到详情预览，并记 note', async () => {
    const detail = detailResponse({ project: { downloadUrl: '' } });
    setWorkshopFetch(routedFetch([[WORKSHOP_API_BASE, () => jsonResponse(detail)]]).impl);

    const res = await fetchInstallInput(PROJECT_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.entriesSource).toBe('detail_preview');
    expect(res.data.input.worldbookEntries.map((e) => e.name)).toEqual(['预览条目']);
    expect(res.data.notes.join()).toContain('可能不完整');
  });

  it('载荷下载失败 → 整体失败，不静默降级到预览', async () => {
    setWorkshopFetch(
      routedFetch([
        [`${WORKSHOP_API_BASE}/api/projects/${PROJECT_ID}`, () => jsonResponse(detailResponse())],
        // DOWNLOAD_URL 未登记 → 404
      ]).impl,
    );

    const res = await fetchInstallInput(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('http');
    expect(res.error.status).toBe(404);
  });

  it('既无下载地址也无预览条目 → no_source', async () => {
    const detail = detailResponse({ project: { downloadUrl: '' }, worldbookEntriesPreview: [] });
    setWorkshopFetch(routedFetch([[WORKSHOP_API_BASE, () => jsonResponse(detail)]]).impl);

    const res = await fetchInstallInput(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('no_source');
  });

  it('详情失败时不去下载载荷', async () => {
    const calls: string[] = [];
    setWorkshopFetch(async (url) => {
      calls.push(url);
      throw new Error('offline');
    });
    const res = await fetchInstallInput(PROJECT_ID);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 超时与取消（P1-4 补齐）
// ═══════════════════════════════════════════════════════════
//
// `fetch` 默认不超时。没有这一层，上游挂起 = 页面永久转圈，用户既看不到错误也
// 点不动重试 —— 判别联合把「失败」建模得再干净，也救不了一个不兑现的 Promise。

describe('超时', () => {
  /** 挂着不兑现，但尊重 signal —— 这正是真 fetch 的行为 */
  function hangingFetch(): { impl: WorkshopFetchLike; signals: (AbortSignal | undefined)[] } {
    const signals: (AbortSignal | undefined)[] = [];
    const impl: WorkshopFetchLike = (_url, init) => {
      signals.push(init?.signal);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('The operation was aborted')),
        );
      });
    };
    return { impl, signals };
  }

  it('元数据请求超时 → kind: timeout，而不是永远挂着', async () => {
    vi.useFakeTimers();
    try {
      const { impl } = hangingFetch();
      setWorkshopFetch(impl);
      const pending = listProjects();
      await vi.advanceTimersByTimeAsync(WORKSHOP_REQUEST_TIMEOUT_MS + 10);
      const res = await pending;
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('timeout');
      expect(res.error.message).toContain('15');
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时之前不误杀', async () => {
    vi.useFakeTimers();
    try {
      const { impl } = hangingFetch();
      setWorkshopFetch(impl);
      let settled = false;
      const pending = listProjects().then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(WORKSHOP_REQUEST_TIMEOUT_MS - 100);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('载荷用更宽的超时（340 KB 级内容 + worker 代理，15 秒会误杀慢网）', async () => {
    vi.useFakeTimers();
    try {
      const { impl } = hangingFetch();
      setWorkshopFetch(impl);
      let settled = false;
      const pending = downloadPayload(DOWNLOAD_URL).then((r) => {
        settled = true;
        return r;
      });
      // 元数据的闸已经过了，载荷这一发还得活着
      await vi.advanceTimersByTimeAsync(WORKSHOP_REQUEST_TIMEOUT_MS + 1000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(WORKSHOP_PAYLOAD_TIMEOUT_MS);
      const res = await pending;
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时不写缓存 —— 下一次调用真的重试', async () => {
    vi.useFakeTimers();
    try {
      const { impl } = hangingFetch();
      setWorkshopFetch(impl);
      const first = fetchProject(PROJECT_ID);
      await vi.advanceTimersByTimeAsync(WORKSHOP_REQUEST_TIMEOUT_MS + 10);
      expect((await first).ok).toBe(false);

      setWorkshopFetch(happyFetch().impl);
      const second = await fetchProject(PROJECT_ID);
      expect(second.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('取消', () => {
  function hangingFetch(): WorkshopFetchLike {
    return (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
  }

  it('调用方 abort → kind: cancelled（不是 network，UI 据此静默丢弃）', async () => {
    setWorkshopFetch(hangingFetch());
    const ctrl = new AbortController();
    const pending = listProjects({}, { signal: ctrl.signal });
    ctrl.abort();
    const res = await pending;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('cancelled');
  });

  it('已经取消的 signal → 一发请求都不出去', async () => {
    const calls: string[] = [];
    setWorkshopFetch(async (url) => {
      calls.push(url);
      return jsonResponse({ projects: [] });
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await listProjects({}, { signal: ctrl.signal });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('signal 会真的传到 fetch 实现手里', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    setWorkshopFetch(async (_url, init) => {
      seen.push(init?.signal);
      return jsonResponse({ projects: [] });
    });
    await listProjects();
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it('带 signal 的请求退出去重池 —— 一人取消不牵连另一人', async () => {
    // A 自带 signal（standalone），B 不带。A 取消后 B 必须仍能拿到结果。
    // ⚠️ 不能按「init.signal 在不在」分支: 超时闸让**每一发**请求都带 signal。
    // 这里按调用序区分 —— 第一发（A）挂着，第二发（B）正常回。
    let call = 0;
    setWorkshopFetch(async (_url, init) => {
      call += 1;
      if (call === 1) {
        return new Promise<WorkshopResponseLike>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return jsonResponse(detailResponse());
    });

    const ctrl = new AbortController();
    const a = fetchProject(PROJECT_ID, { signal: ctrl.signal });
    const b = fetchProject(PROJECT_ID);
    ctrl.abort();

    const resA = await a;
    const resB = await b;
    expect(resA.ok).toBe(false);
    if (!resA.ok) expect(resA.error.kind).toBe('cancelled');
    expect(resB.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 社交面 + 认证（Phase 3 / P3b）
// ═══════════════════════════════════════════════════════════

/** 造一个真 JWT 形状的串（只有 payload 段是我们关心的；签名段随便填） */
function makeJwt(payload: Record<string, unknown>): string {
  const seg = (obj: unknown): string => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.c2ln`;
}

const USER_ID = '1460747861682688006';
const TOKEN = makeJwt({
  userId: USER_ID,
  username: 'yejianzai',
  globalName: '夜见哉川',
  avatar: '2a52ed39',
  isAdmin: false,
  isSuperAdmin: false,
  exp: 4_102_444_800, // 2100 年，测试期内不会过期
});

/** 记录每一发请求的 url **与 init** —— 认证附着只能从 init 上验 */
function recordingFetch(respond: (url: string) => WorkshopResponseLike): {
  impl: WorkshopFetchLike;
  seen: Array<{ url: string; init?: WorkshopFetchInit }>;
} {
  const seen: Array<{ url: string; init?: WorkshopFetchInit }> = [];
  const impl: WorkshopFetchLike = async (url, init) => {
    seen.push({ url, init });
    return respond(url);
  };
  return { impl, seen };
}

function errorResponse(status: number, body: unknown): WorkshopResponseLike {
  return {
    ok: false,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'Bad Request',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('decodeJwtPayload', () => {
  it('解出 payload，且中文昵称不是乱码（atob 出来是 latin1 字节串，必须过 UTF-8）', () => {
    const payload = decodeJwtPayload(TOKEN);
    expect(payload?.userId).toBe(USER_ID);
    expect(payload?.globalName).toBe('夜见哉川');
  });

  it('畸形串一律 null（手改过的 localStorage / 截断的 token），永不抛', () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.@@@@.c']) {
      expect(decodeJwtPayload(bad)).toBeNull();
    }
  });

  it('payload 段不是对象（是数组/数字）也回 null', () => {
    expect(decodeJwtPayload(makeJwt([1, 2] as unknown as Record<string, unknown>))).toBeNull();
  });
});

describe('认证附着（D21/D24）', () => {
  it('★ 未注册 token provider → 一个 header 都不挂，请求形状与 Phase 1 一字不差', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse(detailResponse()));
    setWorkshopFetch(impl);

    await fetchProject(PROJECT_ID);
    expect(seen[0].init?.headers).toBeUndefined();
    expect(seen[0].init?.cache).toBeUndefined();
  });

  it('★ 已登录 → Authorization: Bearer + cache:no-store（上游缺 Vary: Authorization）', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse(detailResponse()));
    setWorkshopFetch(impl);
    setWorkshopAuthTokenProvider(() => TOKEN);

    await fetchProject(PROJECT_ID);
    expect(seen[0].init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].init?.cache).toBe('no-store');
  });

  it('provider 返回空串/null 一律按未登录处理', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ projects: [] }));
    setWorkshopFetch(impl);

    setWorkshopAuthTokenProvider(() => '  ');
    await listProjects();
    setWorkshopAuthTokenProvider(() => null);
    await listProjects({ page: 1 });
    expect(seen.every((s) => s.init?.headers === undefined)).toBe(true);
  });

  it('provider 自己抛异常也不该炸掉一次列表请求', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ projects: [] }));
    setWorkshopFetch(impl);
    setWorkshopAuthTokenProvider(() => {
      throw new Error('store 还没 init');
    });

    const res = await listProjects();
    expect(res.ok).toBe(true);
    expect(seen[0].init?.headers).toBeUndefined();
  });

  it('★ 载荷请求永不带身份（/api/files/* 是公开的、对所有人同一份字节）', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse(payloadResponse()));
    setWorkshopFetch(impl);
    setWorkshopAuthTokenProvider(() => TOKEN);

    await downloadPayload(DOWNLOAD_URL);
    expect(seen[0].init?.headers).toBeUndefined();
    expect(seen[0].init?.cache).toBeUndefined();
  });

  it('resetWorkshopClient 会复位 provider —— 否则上个用例的登录态会漏进下一个', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse(detailResponse()));
    setWorkshopAuthTokenProvider(() => TOKEN);
    resetWorkshopClient();
    setWorkshopFetch(impl);
    setWorkshopClock(() => now);

    await fetchProject(PROJECT_ID);
    expect(seen[0].init?.headers).toBeUndefined();
  });
});

describe('缓存键的身份前缀（D24）', () => {
  it('★ 未登录与已登录互不命中 —— 否则登出后还会看见自己赞过的红心', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ projects: [], total: 0 }));
    setWorkshopFetch(impl);

    // 匿名拉一屏
    const anon = await listProjects();
    expect(anon.ok && anon.fromCache).toBe(false);

    // 登录后同一个 URL：必须真的重拉（旗标是按 JWT 填的，匿名那份不是「我」的）
    setWorkshopAuthTokenProvider(() => TOKEN);
    const authed = await listProjects();
    expect(authed.ok && authed.fromCache).toBe(false);
    expect(seen).toHaveLength(2);

    // 同一身份内仍然吃缓存（TTL 的意义没被身份前缀抵消掉）
    const again = await listProjects();
    expect(again.ok && again.fromCache).toBe(true);

    // 登出回到匿名桶：那一份还在，命中
    setWorkshopAuthTokenProvider(undefined);
    const backToAnon = await listProjects();
    expect(backToAnon.ok && backToAnon.fromCache).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('详情同样分桶', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse(detailResponse()));
    setWorkshopFetch(impl);

    await fetchProject(PROJECT_ID);
    setWorkshopAuthTokenProvider(() => TOKEN);
    const authed = await fetchProject(PROJECT_ID);
    expect(authed.ok && authed.fromCache).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it('★ 载荷**不**分桶 —— 同一份不可变字节没必要在登录前后各下一遍', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse(payloadResponse()));
    setWorkshopFetch(impl);

    await downloadPayload(DOWNLOAD_URL);
    setWorkshopAuthTokenProvider(() => TOKEN);
    const hit = await downloadPayload(DOWNLOAD_URL);
    expect(hit.ok && hit.fromCache).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('两个不同用户不共用一个桶', async () => {
    const other = makeJwt({ userId: 'someone-else', exp: 4_102_444_800 });
    const { impl, seen } = recordingFetch(() => jsonResponse(detailResponse()));
    setWorkshopFetch(impl);

    setWorkshopAuthTokenProvider(() => TOKEN);
    await fetchProject(PROJECT_ID);
    setWorkshopAuthTokenProvider(() => other);
    const second = await fetchProject(PROJECT_ID);
    expect(second.ok && second.fromCache).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it('token 解不出 userId 时落在 auth 桶而不是 anon 桶（那一发确实带了身份）', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse(detailResponse()));
    setWorkshopFetch(impl);

    setWorkshopAuthTokenProvider(() => 'garbage-token');
    await fetchProject(PROJECT_ID);
    setWorkshopAuthTokenProvider(undefined);
    const anon = await fetchProject(PROJECT_ID);
    expect(anon.ok && anon.fromCache).toBe(false);
    expect(seen).toHaveLength(2);
  });
});

describe('社交计数随读取顺带解析（D22）', () => {
  it('列表返回 socials（按项目 id 索引），零额外请求', async () => {
    const { impl, seen } = recordingFetch(() =>
      jsonResponse({
        total: 1,
        projects: [detailResponse().project, { name: '没有 id 的野项目', likesCount: 99 }],
      }),
    );
    setWorkshopFetch(impl);

    const res = await listProjects();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.socials[PROJECT_ID]).toEqual({
      likesCount: 3,
      subscribesCount: 1,
      downloadsCount: 12,
      userLiked: false,
      userSubscribed: false,
    });
    // 被丢弃的野项目没有 id，也就无从索引
    expect(Object.keys(res.data.socials)).toEqual([PROJECT_ID]);
    expect(seen).toHaveLength(1);
    // ★ 社交字段绝不混进落库那一半
    expect(res.data.projects[0]).not.toHaveProperty('likesCount');
  });

  it('详情返回 social，同样零额外请求', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse(detailResponse()));
    setWorkshopFetch(impl);

    const res = await fetchProject(PROJECT_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.social.likesCount).toBe(3);
    expect(res.data.social.downloadsCount).toBe(12);
    expect(seen).toHaveLength(1);
  });

  it('上游没给社交字段时全 0 / false，而不是缺键', async () => {
    const detail = detailResponse();
    for (const key of ['likesCount', 'subscribesCount', 'downloadsCount', 'userLiked']) {
      delete (detail.project as Record<string, unknown>)[key];
    }
    setWorkshopFetch(routedFetch([[WORKSHOP_API_BASE, () => jsonResponse(detail)]]).impl);

    const res = await fetchProject(PROJECT_ID);
    expect(res.ok && res.data.social.likesCount).toBe(0);
    expect(res.ok && res.data.social.userLiked).toBe(false);
  });
});

describe('toggleLike / toggleSubscribe（D23）', () => {
  const LIKE_URL = `${WORKSHOP_API_BASE}/api/projects/${PROJECT_ID}/like`;
  const SUB_URL = `${WORKSHOP_API_BASE}/api/projects/${PROJECT_ID}/subscribe`;

  it('POST 到 /like，无体，带身份；回执归一成 {active, count}', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ liked: true, count: 4 }));
    setWorkshopFetch(impl);
    setWorkshopAuthTokenProvider(() => TOKEN);

    const res = await toggleLike(PROJECT_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ active: true, count: 4 });
    expect(seen[0].url).toBe(LIKE_URL);
    expect(seen[0].init?.method).toBe('POST');
    expect(seen[0].init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    // O6：URL 上不挂 `_=<timestamp>` 之类的缓存破坏参数
    expect(seen[0].url).not.toContain('_=');
  });

  it('订阅走 /subscribe，读的是 `subscribed` 字段', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ subscribed: false, count: 0 }));
    setWorkshopFetch(impl);

    const res = await toggleSubscribe(PROJECT_ID);
    expect(res.ok && res.data).toEqual({ active: false, count: 0 });
    expect(seen[0].url).toBe(SUB_URL);
  });

  it('★ 绝不进缓存 —— 连点两次就是两发请求（点赞→取消，不许被去重成一次）', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ liked: true, count: 1 }));
    setWorkshopFetch(impl);

    await toggleLike(PROJECT_ID);
    await toggleLike(PROJECT_ID);
    expect(seen).toHaveLength(2);
  });

  it('并发的两发也不去重（翻转语义下合并 = 少发一次操作）', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ liked: true, count: 1 }));
    setWorkshopFetch(impl);

    await Promise.all([toggleLike(PROJECT_ID), toggleLike(PROJECT_ID)]);
    expect(seen).toHaveLength(2);
  });

  it('★ 401 → unauthorized（不是 http）—— UI 引导登录而非报红', async () => {
    setWorkshopFetch(async () => errorResponse(401, { error: 'Unauthorized' }));
    const res = await toggleLike(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('unauthorized');
    expect(res.error.status).toBe(401);
    expect(res.error.message).toContain('Unauthorized');
  });

  it('★ 网络失败绝不重试 —— fetch 调用数恒为 1（重试可能把刚点的赞又取消）', async () => {
    let calls = 0;
    setWorkshopFetch(async () => {
      calls += 1;
      throw new TypeError('Failed to fetch');
    });

    const res = await toggleLike(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('network');
    expect(calls).toBe(1);
  });

  it('超时同样只发一次，且分类为 timeout', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      setWorkshopFetch((_url, init) => {
        calls += 1;
        return new Promise<WorkshopResponseLike>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });
      const pending = toggleLike(PROJECT_ID);
      await vi.advanceTimersByTimeAsync(WORKSHOP_REQUEST_TIMEOUT_MS + 10);
      const res = await pending;
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe('timeout');
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('空 id 直接 malformed，不发请求', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ liked: true, count: 1 }));
    setWorkshopFetch(impl);
    const res = await toggleLike('   ');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('malformed');
    expect(seen).toHaveLength(0);
  });
});

describe('错误体的两种形状（§1.4）', () => {
  it('手写路由的 `{"error": "..."}` 进 message', async () => {
    setWorkshopFetch(async () => errorResponse(404, { error: 'Project not found' }));
    const res = await fetchProject(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('http');
    expect(res.error.message).toContain('Project not found');
  });

  it('chanfana 校验失败的 `{success:false, errors:[…]}` 也能说出人话', async () => {
    setWorkshopFetch(async () =>
      errorResponse(400, {
        success: false,
        errors: [{ code: 7, message: 'Invalid enum value', path: ['query', 'sort'] }],
      }),
    );
    const res = await listProjects({ sort: '乱填' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain('Invalid enum value');
    expect(res.error.message).toContain('query.sort');
  });

  it('HTML 拦截页 / 空体 → 只报状态码，绝不编内容', async () => {
    setWorkshopFetch(async () => errorResponse(502, '<!DOCTYPE html><html>bad gateway</html>'));
    const res = await fetchProject(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain('502');
    expect(res.error.message).not.toContain('DOCTYPE');
  });

  it('读错误体本身失败也不该把失败变成另一种失败', async () => {
    setWorkshopFetch(async () => ({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async (): Promise<string> => {
        throw new Error('body 读不动');
      },
    }));
    const res = await fetchProject(PROJECT_ID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('http');
    expect(res.error.status).toBe(500);
  });
});

describe('登录三段式（D19/D25）', () => {
  const LOGIN_URL = `${WORKSHOP_API_BASE}/api/auth/login`;
  const STATE = 'state-uuid-1';

  it('startLogin 解出 {url, state}，且不带身份（此时还没有 token）', async () => {
    const { impl, seen } = recordingFetch(() =>
      jsonResponse({ url: 'https://discord.com/oauth2/authorize?x=1', state: STATE }),
    );
    setWorkshopFetch(impl);
    setWorkshopAuthTokenProvider(() => TOKEN);

    const res = await startLogin();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.state).toBe(STATE);
    expect(res.data.url).toContain('discord.com');
    expect(seen[0].url).toBe(LOGIN_URL);
    expect(seen[0].init?.headers).toBeUndefined();
  });

  it('★ startLogin 绝不缓存 —— 缓存住一把用过的 state 会让第二次登录永远等不到结果', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ url: 'https://d/', state: STATE }));
    setWorkshopFetch(impl);

    await startLogin();
    await startLogin();
    expect(seen).toHaveLength(2);
  });

  it('响应缺 url/state → malformed', async () => {
    setWorkshopFetch(async () => jsonResponse({ url: 'https://d/' }));
    const res = await startLogin();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('malformed');
  });

  it('poll 未就绪 → pending', async () => {
    setWorkshopFetch(async () => jsonResponse({ ready: false }));
    const res = await pollLogin(STATE);
    expect(res.ok && res.data.phase).toBe('pending');
  });

  it('poll 就绪且成功 → success，带 token 与用户快照', async () => {
    const { impl, seen } = recordingFetch(() =>
      jsonResponse({
        ready: true,
        success: true,
        token: TOKEN,
        user: { userId: USER_ID, username: 'yejianzai', globalName: '夜见哉川', avatar: 'h' },
      }),
    );
    setWorkshopFetch(impl);

    const res = await pollLogin(STATE);
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.phase !== 'success') return;
    expect(res.data.token).toBe(TOKEN);
    expect(res.data.user?.globalName).toBe('夜见哉川');
    expect(seen[0].url).toContain(`key=${STATE}`);
  });

  it('★ poll 就绪但失败 → failure，message 原样带出（多为 Discord 服务器门槛）', async () => {
    setWorkshopFetch(async () =>
      jsonResponse({ ready: true, success: false, message: '你不在允许的服务器中' }),
    );
    const res = await pollLogin(STATE);
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.phase !== 'failure') return;
    expect(res.data.message).toBe('你不在允许的服务器中');
  });

  it('就绪却没给 token 也算 failure —— 不让 UI 收下一个空 token', async () => {
    setWorkshopFetch(async () => jsonResponse({ ready: true, success: true }));
    const res = await pollLogin(STATE);
    expect(res.ok && res.data.phase).toBe('failure');
  });

  it('★ poll 绝不缓存也不去重（单次消费：叠了会互相吃结果）', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ ready: false }));
    setWorkshopFetch(impl);

    await pollLogin(STATE);
    await Promise.all([pollLogin(STATE), pollLogin(STATE)]);
    expect(seen).toHaveLength(3);
  });

  it('传输层失败仍是 ok:false（调用方据此继续轮询，而不是把登录判死）', async () => {
    setWorkshopFetch(async () => {
      throw new Error('offline');
    });
    const res = await pollLogin(STATE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('network');
  });

  it('空 state 直接 malformed，不发请求', async () => {
    const { impl, seen } = recordingFetch(() => jsonResponse({ ready: false }));
    setWorkshopFetch(impl);
    const res = await pollLogin('  ');
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// invalidateWorkshopProject（真机反馈 2026-08-01）
// ═══════════════════════════════════════════════════════════

describe('invalidateWorkshopProject', () => {
  it('★ 丢掉该项目的详情 —— 作者改完点进去看到的必须是新的，不是 5 分钟前的副本', async () => {
    const { impl, calls } = routedFetch([
      [`${WORKSHOP_API_BASE}/api/projects/${PROJECT_ID}`, () => jsonResponse(detailResponse())],
    ]);
    setWorkshopFetch(impl);

    await fetchProject(PROJECT_ID);
    // 第二次本该吃缓存
    const cached = await fetchProject(PROJECT_ID);
    expect(cached.ok && cached.fromCache).toBe(true);
    expect(calls).toHaveLength(1);

    invalidateWorkshopProject(PROJECT_ID);

    const fresh = await fetchProject(PROJECT_ID);
    expect(fresh.ok && fresh.fromCache).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('★ 列表**全部**丢掉 —— 改一个名字会影响哪几页是算不出来的', async () => {
    const { impl, calls } = routedFetch([
      [`${WORKSHOP_API_BASE}/api/projects?`, () => jsonResponse({ projects: [], total: 0 })],
    ]);
    setWorkshopFetch(impl);

    await listProjects({ page: 0 });
    await listProjects({ page: 1 });
    expect(calls).toHaveLength(2);
    // 两页都该命中缓存
    await listProjects({ page: 0 });
    await listProjects({ page: 1 });
    expect(calls).toHaveLength(2);

    invalidateWorkshopProject(PROJECT_ID);

    await listProjects({ page: 0 });
    await listProjects({ page: 1 });
    expect(calls).toHaveLength(4);
  });

  it('★ 载荷刻意不丢 —— 它按 downloadUrl 存键，上游发新版天然是另一把钥匙', async () => {
    const { impl, calls } = routedFetch([[DOWNLOAD_URL, () => jsonResponse(payloadResponse())]]);
    setWorkshopFetch(impl);

    await downloadPayload(DOWNLOAD_URL);
    invalidateWorkshopProject(PROJECT_ID);
    const after = await downloadPayload(DOWNLOAD_URL);

    expect(after.ok && after.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('别的项目的详情不受牵连', async () => {
    const OTHER = '99999999-8888-7777-6666-555555555555';
    const { impl, calls } = routedFetch([
      [`${WORKSHOP_API_BASE}/api/projects/${OTHER}`, () => jsonResponse(detailResponse())],
    ]);
    setWorkshopFetch(impl);

    await fetchProject(OTHER);
    invalidateWorkshopProject(PROJECT_ID);
    const again = await fetchProject(OTHER);

    expect(again.ok && again.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
