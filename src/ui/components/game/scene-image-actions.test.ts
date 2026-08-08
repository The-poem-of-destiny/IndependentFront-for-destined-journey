import { describe, expect, it } from 'vitest';
import {
  REDRAW_DIALECT_MISMATCH_HINT,
  copyablePromptOf,
  isRedrawDialectMismatch,
  nextTakeId,
  type DialectBearingRecord,
  type PromptBearingRecord,
} from './scene-image-actions';

function bearer(over: Partial<PromptBearingRecord> = {}): PromptBearingRecord {
  return { positive: '', scenePrompt: '', ...over };
}

describe('copyablePromptOf — 复制的是这一张实际发出去的那份', () => {
  it('🔴 优先 positive：它是发请求那一方回填的真值，另外两个都只是场景那一段', () => {
    const text = copyablePromptOf(
      bearer({
        positive: '1girl, tavern interior, warm candlelight, best quality',
        scenePrompt: 'tavern interior',
        editedScenePrompt: 'rainy street',
      }),
    );
    expect(text).toBe('1girl, tavern interior, warm candlelight, best quality');
  });

  it('positive 还是空串（刚落库 / 老记录）时退到用户改过的那份', () => {
    expect(
      copyablePromptOf(
        bearer({ positive: '   ', scenePrompt: 'tavern', editedScenePrompt: 'rainy street' }),
      ),
    ).toBe('rainy street');
  });

  it('用户没改过就退到 agent 给的那份', () => {
    expect(copyablePromptOf(bearer({ scenePrompt: 'tavern interior' }))).toBe('tavern interior');
  });

  it('三个都空时给空串 —— 调用方据此不去写剪贴板', () => {
    expect(copyablePromptOf(bearer({ editedScenePrompt: '  ' }))).toBe('');
  });
});

describe('nextTakeId — 角标点击是浏览，环形前进', () => {
  it('往后走一张', () => {
    expect(nextTakeId(['a', 'b', 'c'], 'a')).toBe('b');
    expect(nextTakeId(['a', 'b', 'c'], 'b')).toBe('c');
  });

  it('走到头绕回第一张', () => {
    expect(nextTakeId(['a', 'b', 'c'], 'c')).toBe('a');
  });

  it('当前这张已经不在列表里（被删掉）时从第一张开始', () => {
    expect(nextTakeId(['a', 'b'], 'gone')).toBe('a');
    expect(nextTakeId(['a', 'b'], null)).toBe('a');
  });

  it('只有一张时点了还是它 —— 不会变成 undefined', () => {
    expect(nextTakeId(['a'], 'a')).toBe('a');
  });

  it('一张都没有时给 null', () => {
    expect(nextTakeId([], 'a')).toBeNull();
  });
});

describe('isRedrawDialectMismatch — 重画前那句方言提示（C14）', () => {
  function dialectRec(over: Partial<DialectBearingRecord> = {}): DialectBearingRecord {
    return { ...over };
  }

  it('🔴 没有手改提示词时**永不提示** —— 那条路引擎自己会重跑侧链，提示只会被学会忽略', () => {
    expect(
      isRedrawDialectMismatch(dialectRec({ dialectId: 'danbooru-anime' }), 'natural-prose'),
    ).toBe(false);
    expect(
      isRedrawDialectMismatch(
        dialectRec({ editedScenePrompt: '   ', dialectId: 'danbooru-anime' }),
        'natural-prose',
      ),
    ).toBe(false);
  });

  it('有手改 + 方言不同 → 提示', () => {
    expect(
      isRedrawDialectMismatch(
        dialectRec({ editedScenePrompt: 'tavern interior', dialectId: 'danbooru-anime' }),
        'natural-prose',
      ),
    ).toBe(true);
  });

  it('有手改 + 方言相同 → 不提示', () => {
    expect(
      isRedrawDialectMismatch(
        dialectRec({ editedScenePrompt: 'tavern interior', dialectId: 'natural-prose' }),
        'natural-prose',
      ),
    ).toBe(false);
  });

  it('🔴 记录缺 dialectId（v1 老记录）读作内置 danbooru —— 不是「不匹配」', () => {
    // 把 undefined 当成不匹配的话，每一张 v1 老图都会挂上这句提示，
    // 而一句对所有人都出现的提示等于没有提示
    expect(isRedrawDialectMismatch(dialectRec({ editedScenePrompt: 'x' }), 'danbooru-anime')).toBe(
      false,
    );
    expect(isRedrawDialectMismatch(dialectRec({ editedScenePrompt: 'x' }), 'natural-prose')).toBe(
      true,
    );
  });

  it('当前方言缺席 / 空串同样读作内置 danbooru', () => {
    expect(
      isRedrawDialectMismatch(
        dialectRec({ editedScenePrompt: 'x', dialectId: 'danbooru-anime' }),
        undefined,
      ),
    ).toBe(false);
    expect(
      isRedrawDialectMismatch(
        dialectRec({ editedScenePrompt: 'x', dialectId: 'natural-prose' }),
        '',
      ),
    ).toBe(true);
  });

  it('提示文案是常量，界面与测试读同一份', () => {
    expect(REDRAW_DIALECT_MISMATCH_HINT).toContain('另一方言');
  });
});
