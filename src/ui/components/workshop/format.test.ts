/**
 * format.test.ts — 工坊展示层纯函数
 *
 * 处置文案的口径必须只有一份: 折叠行、分组标题、安装 toast 三处共用
 * `WORKSHOP_NOTE_LABEL` / `summarizeNoteGroups`。三处说法一旦分家，用户会以为
 * 自己遇到了几个不同的问题 —— 而「N 项未导入」这三个字只属于 `dropped`。
 */

import { afterEach, describe, it, expect } from 'vitest';
import { groupWorkshopNotes, workshopNote } from '@engine/workshop-types';
import { setWorkshopConfig } from '../../lib/workshop-client';

// 工坊配置是模块级状态（D41）：用例改过就得还原，否则串到隔壁文件
afterEach(() => setWorkshopConfig({ apiBase: '', loginHint: '' }));
import {
  baseTagClass,
  baseTagOf,
  describeReviewState,
  DISCORD_FALLBACK_AVATAR,
  WORKSHOP_NOTE_LABEL,
  describeEntryPosition,
  describeSelectiveLogic,
  discordAvatarUrl,
  discordDisplayName,
  formatBytes,
  formatDate,
  formatNoteSegment,
  formatVersion,
  summarizeNoteGroups,
  truncate,
} from './format';
import { WORKSHOP_LOGIN_GUIDE, describeFailure, describeLoginFailure } from './failure-text';

describe('formatBytes / formatDate / formatVersion', () => {
  it('字节分档，0 与非法值给空串', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
  });

  it('时间戳 → YYYY-MM-DD，0 与非法值给空串', () => {
    expect(formatDate(Date.UTC(2026, 6, 31))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatDate(0)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });

  it('版本一律带 v 前缀，上游自己带了不重复加', () => {
    expect(formatVersion('1.2.0')).toBe('v1.2.0');
    expect(formatVersion('v1.2.0')).toBe('v1.2.0');
    expect(formatVersion('  ')).toBe('');
    expect(formatVersion(undefined)).toBe('');
  });
});

describe('处置文案 —— 只有 dropped 配叫「未导入」', () => {
  it('标签口径固定', () => {
    expect(WORKSHOP_NOTE_LABEL.dropped).toBe('未导入');
    expect(WORKSHOP_NOTE_LABEL.degraded).not.toContain('未导入');
    expect(WORKSHOP_NOTE_LABEL.sideEffect).not.toContain('未导入');
  });

  it('单段文案；count ≤ 0 给空串（永不出现「0 项」）', () => {
    expect(formatNoteSegment('dropped', 3)).toBe('3 项未导入');
    expect(formatNoteSegment('sideEffect', 1)).toBe('1 项有全局副作用');
    expect(formatNoteSegment('degraded', 0)).toBe('');
    expect(formatNoteSegment('degraded', Number.NaN)).toBe('');
  });

  it('★ 整句只拼非空组，且 dropped 的数字不吞掉另外两类', () => {
    const groups = groupWorkshopNotes([
      workshopNote('dropped', 'a'),
      workshopNote('degraded', 'b'),
      workshopNote('degraded', 'c'),
      workshopNote('sideEffect', 'd'),
    ]);
    expect(summarizeNoteGroups(groups)).toBe('1 项未导入 · 2 项已装但效果受限 · 1 项有全局副作用');
  });

  it('只有 degraded 时不出现「未导入」字样', () => {
    const groups = groupWorkshopNotes([workshopNote('degraded', 'b')]);
    expect(summarizeNoteGroups(groups)).toBe('1 项已装但效果受限');
  });

  it('★ 老的纯 string[] 项目 → 「N 项未导入」，与旧 UI 口径一致', () => {
    expect(summarizeNoteGroups(groupWorkshopNotes(['a', 'b']))).toBe('2 项未导入');
  });

  it('无 note → 空串（调用方据此整块不渲染）', () => {
    expect(summarizeNoteGroups(groupWorkshopNotes([]))).toBe('');
    expect(summarizeNoteGroups(groupWorkshopNotes(undefined))).toBe('');
  });
});

describe('装前检视的字段翻译', () => {
  it('position 覆盖 ST 的三个已知值，未知值原样报出而不是硬派一个说法', () => {
    expect(describeEntryPosition(0)).toBe('角色定义前');
    expect(describeEntryPosition(1)).toBe('角色定义后');
    expect(describeEntryPosition(4)).toBe('按深度插入');
    // 上游可以有我们没见过的值：宁可显示"位置 7"，也不要错报成"按深度插入"
    expect(describeEntryPosition(7)).toBe('位置 7');
  });

  it('selectiveLogic 四分支与 worldbook-loader.matchKeyword 同义', () => {
    expect(describeSelectiveLogic(0)).toBe('任一次要命中');
    expect(describeSelectiveLogic(1)).toBe('非全部次要命中');
    expect(describeSelectiveLogic(2)).toBe('无次要命中');
    expect(describeSelectiveLogic(3)).toBe('全部次要命中');
    expect(describeSelectiveLogic(9)).toBe('逻辑 9');
  });

  it('truncate 压平空白并在超长时才加省略号', () => {
    expect(truncate('短句')).toBe('短句');
    // 折叠行是单行的，换行/连续空格必须压掉，否则摘要会带一串空洞
    expect(truncate('第一行\n\n第二行   末尾')).toBe('第一行 第二行 末尾');
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════
// 登录位与登录文案（Phase 3 / P3c）
// ═══════════════════════════════════════════════════════════

describe('discordAvatarUrl / discordDisplayName', () => {
  it('把哈希拼成 URL —— JWT 里给的从来不是 URL', () => {
    expect(discordAvatarUrl({ userId: 'u1', avatar: 'abc' })).toBe(
      'https://cdn.discordapp.com/avatars/u1/abc.webp?size=100',
    );
  });

  it('★ 缺 id 或没设过头像一律回默认图，绝不回空串', () => {
    // 空 src 会让浏览器去请求当前页面地址，然后画一个碎图标
    expect(discordAvatarUrl(null)).toBe(DISCORD_FALLBACK_AVATAR);
    expect(discordAvatarUrl({ userId: 'u1', avatar: '' })).toBe(DISCORD_FALLBACK_AVATAR);
    expect(discordAvatarUrl({ userId: '', avatar: 'abc' })).toBe(DISCORD_FALLBACK_AVATAR);
  });

  it('显示名优先 globalName，缺了才退 username', () => {
    // 反过来的话，改过显示名的用户会看到一个自己早就不用的旧 ID
    expect(discordDisplayName({ username: 'vera', globalName: '维拉' })).toBe('维拉');
    expect(discordDisplayName({ username: 'vera', globalName: '  ' })).toBe('vera');
    expect(discordDisplayName(null)).toBe('工坊用户');
  });
});

describe('登录相关文案（D25）', () => {
  it('★ 401 不说成「上游出错了」—— 未登录是常态，该给的是去处', () => {
    const text = describeFailure({ kind: 'unauthorized', status: 401, message: '', url: 'u' });
    expect(text).toContain('登录');
    expect(text).not.toContain('出了问题');
  });

  it('登录失败：上游原话照登，后面补上配置里给的前提句（D41）', () => {
    setWorkshopConfig({ loginHint: '登录需要你已加入某个 Discord 服务器' });
    const text = describeLoginFailure('你不在允许的服务器中');
    expect(text).toContain('你不在允许的服务器中');
    expect(text).toContain('登录需要你已加入某个 Discord 服务器');
  });

  it('🔴 没配前提句就一个字都不补 —— 宁可不说，也别说一句假话（D41）', () => {
    // 这句此前写死了某个具体的服务器名。社区源已是配置项，换一个源它就成了假话，
    // 而假话恰好出现在用户最需要知道「我到底还差什么」的时刻。
    setWorkshopConfig({ loginHint: '' });
    expect(describeLoginFailure('你不在允许的服务器中')).toBe('你不在允许的服务器中');
  });

  it('上游一句话都没给时也不能只弹一个空串', () => {
    setWorkshopConfig({ loginHint: '' });
    expect(describeLoginFailure('')).toContain('登录失败');
  });

  it('引导语只有一份 —— 卡片、详情、页面共用', () => {
    expect(WORKSHOP_LOGIN_GUIDE).toContain('Discord 登录');
  });
});

describe('baseTagOf / baseTagClass（Phase 4）', () => {
  it('按 WORKSHOP_BASE_TAGS 的顺序取第一个命中的', () => {
    // 同时挂了「扩展」和「系统」时，徽章只能显示一个 —— 顺序即优先级
    expect(baseTagOf(['扩展', '系统'])).toBe('系统');
    expect(baseTagOf(['角色'])).toBe('角色');
  });

  it('★ 一个基础标签都没有时返回空串，不替作者盖章成「系统」', () => {
    // 上游 getBaseTag 在这里退回 BASE_TAGS[0]，会把只挂「路边」的项目说成系统级 ——
    // 而「系统」恰恰是最需要用户警惕的那类（D12）
    expect(baseTagOf(['路边', '外挂'])).toBe('');
    expect(baseTagOf([])).toBe('');
    expect(baseTagOf(undefined)).toBe('');
  });

  it('四个基础标签各有配色类，非基础标签无类', () => {
    expect(baseTagClass('系统')).toBe('system');
    expect(baseTagClass('扩展')).toBe('extension');
    expect(baseTagClass('角色')).toBe('character');
    expect(baseTagClass('事件')).toBe('event');
    expect(baseTagClass('路边')).toBe('');
  });
});

describe('describeReviewState（Phase 4）', () => {
  const base = {
    status: 'approved',
    reviewTarget: 'project',
    hasPendingDraft: false,
    visibility: true,
  };

  it('一切正常时不出徽章', () => {
    expect(describeReviewState(base)).toBeNull();
    expect(describeReviewState(undefined)).toBeNull();
  });

  it('★ 草稿状态压过本体状态', () => {
    // 本体 approved + 草稿 rejected：作者要看到的是「新版本被拒」而不是「一切正常」
    const badge = describeReviewState({
      ...base,
      status: 'rejected',
      reviewTarget: 'draft',
    });
    expect(badge).toEqual({ text: '新版本被拒', kind: 'err' });
  });

  it('草稿审核中', () => {
    expect(describeReviewState({ ...base, status: 'pending', reviewTarget: 'draft' })).toEqual({
      text: '新版本审核中',
      kind: 'warn',
    });
  });

  it('★ 本体待审/被拒也要说出来 —— 上游这两种情况一个字都不说', () => {
    // 刚投稿的作者切到「我的项目」看不到「审核中」，只会以为投稿没成功
    expect(describeReviewState({ ...base, status: 'pending' })).toEqual({
      text: '审核中',
      kind: 'warn',
    });
    expect(describeReviewState({ ...base, status: 'rejected' })).toEqual({
      text: '已被拒绝',
      kind: 'err',
    });
  });

  it('有待审草稿 / 已隐藏都只是信息，不是待处理', () => {
    expect(describeReviewState({ ...base, hasPendingDraft: true })?.kind).toBe('muted');
    expect(describeReviewState({ ...base, visibility: false })).toEqual({
      text: '已隐藏',
      kind: 'muted',
    });
  });
});
