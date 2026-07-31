/**
 * workshop-manifest.test.ts — 上游 JSON → 内部形状
 *
 * 夹具全部照**真实上游样本**造（角色卡 `creative_workshop_cache`，3 个项目）：
 * - `project` 33 字段的真实字段名与取值形态
 * - 世界书条目的**两种**形状（详情预览 uid 是字符串 + 有 enabled / 载荷文件 uid
 *   是数字 + 只有 disable）
 * - 正则条目 13 字段
 *
 * 核心断言是**容忍**：上游加字段忽略、删字段给缺省、改类型不崩 —— 一次上游调整
 * 不应该让工坊页白屏。
 */

import { describe, it, expect } from 'vitest';
import { parseProjectMeta, parsePayload } from './workshop-manifest';

/** 真实样本：命定核心-言灵（重置），字段名与形态照抄，长文本截断 */
const REAL_PROJECT = {
  id: '08aa5a5e-b21e-4436-b44b-96d2c246b83e',
  rootProjectId: '08aa5a5e-b21e-4436-b44b-96d2c246b83e',
  publishedProjectId: null,
  draftProjectId: null,
  name: '命定核心-言灵（重置）',
  description: '言灵2.0更新内容\n\n世界书内容：\n1.将拆词、覆写、移词、误读四种技能合并',
  version: '2.1.0',
  authorId: '1460747861682688006',
  authorName: 'yejianzai_chuan',
  authorGlobalName: '夜见哉川',
  authorAvatar: 'https://cdn.discordapp.com/avatars/1460747861682688006/2a52ed39.webp?size=100',
  status: 'approved',
  downloadUrl:
    'https://poemofdestinycreativeworkshop.1528779666.workers.dev/api/files/projects/08aa5a5e/project-08aa5a5e.json',
  fileSize: 24530,
  downloadsCount: 16,
  tags: ['系统', '外挂', '改词'],
  coverImage:
    'https://poemofdestinycreativeworkshop.1528779666.workers.dev/api/files/projects/08aa5a5e/cover.png',
  worldbookEntriesPreview: [],
  regexEntriesPreview: [],
  likesCount: 3,
  subscribesCount: 1,
  userLiked: false,
  userSubscribed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  reviewedAt: '2026-01-02T00:00:00.000Z',
  reviewerId: '123',
  rejectReason: null,
  reviewTarget: 'project',
  visibility: 'public',
  isPublished: true,
  hasPendingDraft: false,
  latestApprovedAt: '2026-01-02T00:00:00.000Z',
};

/** 真实样本：载荷文件里的条目形状（uid 是**数字**，无 enabled，只有 disable） */
const PAYLOAD_ENTRY = {
  key: [],
  keysecondary: [],
  comment: '命定系统-言灵(夜见哉川)',
  content: '<%_ const _wcInput = String(getChatMessage(-1, "user") || ""); _%>',
  constant: true,
  vectorized: false,
  selective: true,
  selectiveLogic: 0,
  addMemo: true,
  order: 1100,
  position: 4,
  disable: false,
  excludeRecursion: false,
  preventRecursion: true,
  probability: 100,
  useProbability: true,
  depth: 1,
  group: '',
  groupOverride: false,
  groupWeight: 100,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: false,
  automationId: '',
  role: 0,
  sticky: 0,
  cooldown: 0,
  delay: 0,
  uid: 0,
  displayIndex: 0,
  ignoreBudget: false,
  outletName: '',
  triggers: [],
};

/** 真实样本：详情预览里的条目形状（uid 是**字符串**，有 enabled，有 extra） */
const PREVIEW_ENTRY = {
  uid: '0',
  comment: '命定系统-言灵(夜见哉川)',
  content: '正文',
  key: [],
  keysecondary: [],
  constant: true,
  selective: true,
  selectiveLogic: 0,
  enabled: true,
  disable: false,
  scanDepth: null,
  position: 4,
  role: null,
  depth: 1,
  order: 1100,
  probability: 100,
  useProbability: true,
  sticky: 0,
  cooldown: 0,
  delay: 0,
  excludeRecursion: false,
  preventRecursion: true,
  delayUntilRecursion: false,
  extra: {},
};

/** 真实样本：正则条目 13 字段（substituteRegex 是**枚举**，实测 0 与 2） */
const REAL_REGEX = {
  id: 'd67b1f7e-e3d0-4e5f-94bd-fe32328ef311',
  scriptName: '命定核心-言灵改稿笺美化',
  findRegex: '<yanling_edits\\b[^>]*\\bkind="([^"]+)"[^>]*>([\\s\\S]*?)</yanling_edits>',
  replaceString: '```html\r\n<!doctype html>\n<html lang="zh-CN">$1$2</html>\n```',
  trimStrings: [],
  disabled: false,
  markdownOnly: true,
  promptOnly: false,
  runOnEdit: true,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: 10,
  placement: [1, 2],
};

describe('parseProjectMeta —— D13 只取要的，丢弃身份/审核/社交面', () => {
  it('真实 33 字段项目 → 10 个内部字段', () => {
    const meta = parseProjectMeta(REAL_PROJECT);
    expect(meta).toEqual({
      id: '08aa5a5e-b21e-4436-b44b-96d2c246b83e',
      rootProjectId: '08aa5a5e-b21e-4436-b44b-96d2c246b83e',
      name: '命定核心-言灵（重置）',
      description: REAL_PROJECT.description,
      version: '2.1.0',
      authorName: '夜见哉川', // authorGlobalName 优先
      tags: ['系统', '外挂', '改词'],
      coverUrl: REAL_PROJECT.coverImage, // 上游字段名是 coverImage
      downloadUrl: REAL_PROJECT.downloadUrl,
      fileSize: 24530,
    });
  });

  it('刻意丢弃的 17 个字段一个都不落进来', () => {
    const meta = parseProjectMeta(REAL_PROJECT)!;
    for (const dropped of [
      'publishedProjectId',
      'draftProjectId',
      'authorId',
      'authorAvatar',
      'status',
      'reviewedAt',
      'reviewerId',
      'rejectReason',
      'reviewTarget',
      'visibility',
      'isPublished',
      'hasPendingDraft',
      'latestApprovedAt',
      'likesCount',
      'subscribesCount',
      'downloadsCount',
      'userLiked',
      'userSubscribed',
      'coverImage',
      'worldbookEntriesPreview',
      'regexEntriesPreview',
    ]) {
      expect(meta).not.toHaveProperty(dropped);
    }
  });

  it('authorGlobalName 缺失时回退 authorName', () => {
    const meta = parseProjectMeta({ ...REAL_PROJECT, authorGlobalName: '' })!;
    expect(meta.authorName).toBe('yejianzai_chuan');
  });

  it('作者两个字段都没有 → 缺省「未知作者」，不产出空串', () => {
    const meta = parseProjectMeta({ id: 'x' })!;
    expect(meta.authorName).toBe('未知作者');
    expect(meta.name).toBe('未命名项目');
    expect(meta.version).toBe('1.0.0');
    expect(meta.description).toBe('');
    expect(meta.tags).toEqual([]);
    expect(meta.downloadUrl).toBe('');
    expect(meta.fileSize).toBe(0);
    expect(meta.rootProjectId).toBe('x'); // 自己就是根
  });

  it('封面缺失时不产出 coverUrl 键（可选字段不落 undefined）', () => {
    const meta = parseProjectMeta({ id: 'x' })!;
    expect('coverUrl' in meta).toBe(false);
  });

  it('id 缺失 / 空白 → null（本模块唯一的拒绝）', () => {
    expect(parseProjectMeta({ name: '无 id' })).toBeNull();
    expect(parseProjectMeta({ id: '   ' })).toBeNull();
    expect(parseProjectMeta({ id: 123 })).toBeNull();
  });

  it('非对象输入不抛，返回 null', () => {
    for (const bad of [null, undefined, 42, 'str', [], true]) {
      expect(() => parseProjectMeta(bad)).not.toThrow();
      expect(parseProjectMeta(bad)).toBeNull();
    }
  });

  it('容忍上游加字段：未知字段被忽略而非报错', () => {
    const meta = parseProjectMeta({ ...REAL_PROJECT, brandNewUpstreamField: { a: 1 } })!;
    expect(meta).not.toHaveProperty('brandNewUpstreamField');
    expect(meta.id).toBe(REAL_PROJECT.id);
  });

  it('容忍上游改类型：tags 里混进非串只留串，fileSize 是串也认', () => {
    const meta = parseProjectMeta({
      ...REAL_PROJECT,
      tags: ['系统', 42, null, '改词'],
      fileSize: '24530',
    })!;
    expect(meta.tags).toEqual(['系统', '改词']);
    expect(meta.fileSize).toBe(24530);
  });

  it('fileSize 为负 / 小数 → 归一成非负整数', () => {
    expect(parseProjectMeta({ id: 'x', fileSize: -5 })!.fileSize).toBe(0);
    expect(parseProjectMeta({ id: 'x', fileSize: 10.9 })!.fileSize).toBe(10);
  });

  it('容忍传入整个详情响应（自动下钻 .project）', () => {
    const meta = parseProjectMeta({
      project: REAL_PROJECT,
      worldbookEntriesPreview: [],
      regexEntriesPreview: [],
    })!;
    expect(meta.id).toBe(REAL_PROJECT.id);
  });
});

describe('parsePayload —— 外层三种形状 + 条目两种形状', () => {
  it('裸数组（载荷文件实测形状）', () => {
    const payload = parsePayload([PAYLOAD_ENTRY]);
    expect(payload.worldbookEntries).toHaveLength(1);
    expect(payload.regexEntries).toEqual([]);
  });

  it('{ entries: [] }（ST 导出形状）', () => {
    expect(parsePayload({ entries: [PAYLOAD_ENTRY] }).worldbookEntries).toHaveLength(1);
  });

  it('{ entries: { "0": {} } }（对象映射形状）', () => {
    const payload = parsePayload({ entries: { '0': PAYLOAD_ENTRY, '1': PAYLOAD_ENTRY } });
    expect(payload.worldbookEntries).toHaveLength(2);
  });

  it('合成形状：条目 + 正则一起传', () => {
    const payload = parsePayload({
      worldbookEntries: [PAYLOAD_ENTRY],
      regexEntries: [REAL_REGEX],
    });
    expect(payload.worldbookEntries).toHaveLength(1);
    expect(payload.regexEntries).toHaveLength(1);
  });

  it('详情响应的 preview 键名也认', () => {
    const payload = parsePayload({
      worldbookEntriesPreview: [PREVIEW_ENTRY],
      regexEntriesPreview: [REAL_REGEX],
    });
    expect(payload.worldbookEntries).toHaveLength(1);
    expect(payload.regexEntries).toHaveLength(1);
  });

  it('垃圾输入 → 空载荷，不抛', () => {
    for (const bad of [null, undefined, 42, 'str', true, {}]) {
      expect(() => parsePayload(bad)).not.toThrow();
      expect(parsePayload(bad)).toEqual({ worldbookEntries: [], regexEntries: [] });
    }
  });

  it('数组里混进非对象 → 过滤掉，不产出垃圾条目', () => {
    expect(parsePayload([PAYLOAD_ENTRY, null, 'x', 42]).worldbookEntries).toHaveLength(1);
  });
});

describe('parsePayload —— 条目两种形状归一（★ 实测差异）', () => {
  it('载荷形状：uid 数字 + 无 enabled 只有 disable', () => {
    const [entry] = parsePayload([PAYLOAD_ENTRY]).worldbookEntries;
    expect(entry.sourceUid).toBe(0); // 原样保留数字
    expect(entry.name).toBe('命定系统-言灵(夜见哉川)');
    expect(entry.enabled).toBe(true); // 由 disable:false 推出
    expect(entry.order).toBe(1100);
    expect(entry.position).toBe(4);
    expect(entry.selectiveLogic).toBe(0);
  });

  it('预览形状：uid 字符串 + 有 enabled', () => {
    const [entry] = parsePayload({ worldbookEntriesPreview: [PREVIEW_ENTRY] }).worldbookEntries;
    expect(entry.sourceUid).toBe('0'); // 原样保留字符串
    expect(entry.enabled).toBe(true);
  });

  it('disable:true → enabled:false', () => {
    const [entry] = parsePayload([{ ...PAYLOAD_ENTRY, disable: true }]).worldbookEntries;
    expect(entry.enabled).toBe(false);
  });

  it('enabled 优先于 disable（两者矛盾时以显式 enabled 为准）', () => {
    const [entry] = parsePayload([{ ...PAYLOAD_ENTRY, disable: true, enabled: true }])
      .worldbookEntries;
    expect(entry.enabled).toBe(true);
  });

  it('两者都没有 → 默认启用', () => {
    const [entry] = parsePayload([{ comment: 'x', content: 'y' }]).worldbookEntries;
    expect(entry.enabled).toBe(true);
  });

  it('comment 为空 → 用序号兜底，name 永不为空（按名匹配的锚点）', () => {
    const entries = parsePayload([{ content: 'a' }, { comment: '   ', content: 'b' }])
      .worldbookEntries;
    expect(entries[0].name).toBe('未命名条目 1');
    expect(entries[1].name).toBe('未命名条目 2');
  });

  it('uid 非法 → sourceUid 退化成序号，不产出 undefined', () => {
    const entries = parsePayload([{ comment: 'a', uid: null }, { comment: 'b' }]).worldbookEntries;
    expect(entries[0].sourceUid).toBe(0);
    expect(entries[1].sourceUid).toBe(1);
  });

  it('selectiveLogic 越界 → 夹回 0', () => {
    expect(parsePayload([{ comment: 'a', selectiveLogic: 9 }]).worldbookEntries[0].selectiveLogic)
      .toBe(0);
    expect(parsePayload([{ comment: 'a', selectiveLogic: 3 }]).worldbookEntries[0].selectiveLogic)
      .toBe(3);
  });

  it('key / keysecondary 混进非串只留串', () => {
    const [entry] = parsePayload([{ comment: 'a', key: ['x', 1, null], keysecondary: 'nope' }])
      .worldbookEntries;
    expect(entry.key).toEqual(['x']);
    expect(entry.keysecondary).toEqual([]);
  });
});

describe('parsePayload —— 正则 13 字段', () => {
  it('真实正则条目逐字段', () => {
    const [rx] = parsePayload({ regexEntries: [REAL_REGEX] }).regexEntries;
    expect(rx).toEqual({
      id: 'd67b1f7e-e3d0-4e5f-94bd-fe32328ef311',
      scriptName: '命定核心-言灵改稿笺美化',
      findRegex: REAL_REGEX.findRegex,
      replaceString: REAL_REGEX.replaceString,
      disabled: false,
      markdownOnly: true,
      promptOnly: false,
      runOnEdit: true,
      trimStrings: [],
      substituteRegex: 0,
      minDepth: null,
      maxDepth: 10,
      placement: [1, 2],
    });
  });

  it('★ substituteRegex 是枚举不是布尔：值 2 原样保留', () => {
    const [rx] = parsePayload({ regexEntries: [{ ...REAL_REGEX, substituteRegex: 2 }] })
      .regexEntries;
    expect(rx.substituteRegex).toBe(2);
  });

  it('上游若真给了布尔 → 归一成 0/1，不让类型谎报', () => {
    expect(
      parsePayload({ regexEntries: [{ substituteRegex: true }] }).regexEntries[0].substituteRegex,
    ).toBe(1);
    expect(
      parsePayload({ regexEntries: [{ substituteRegex: false }] }).regexEntries[0].substituteRegex,
    ).toBe(0);
  });

  it('id 缺失 → 用序号兜底（规则 id 需在项目内唯一）', () => {
    const entries = parsePayload({ regexEntries: [{}, {}] }).regexEntries;
    expect(entries.map((r) => r.id)).toEqual(['#0', '#1']);
  });

  it('全空条目 → 全缺省，不抛', () => {
    const [rx] = parsePayload({ regexEntries: [{}] }).regexEntries;
    expect(rx.findRegex).toBe('');
    expect(rx.replaceString).toBe('');
    expect(rx.disabled).toBe(false);
    expect(rx.trimStrings).toEqual([]);
    expect(rx.placement).toEqual([]);
    expect(rx.minDepth).toBeNull();
    expect(rx.maxDepth).toBeNull();
  });

  it('snake_case 别名也认（上游若改名不至于全丢）', () => {
    const [rx] = parsePayload({
      regexEntries: [{ script_name: 'n', find_regex: 'p', replace_string: 'r' }],
    }).regexEntries;
    expect(rx.scriptName).toBe('n');
    expect(rx.findRegex).toBe('p');
    expect(rx.replaceString).toBe('r');
  });
});
