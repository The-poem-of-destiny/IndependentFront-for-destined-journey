import { describe, expect, it } from 'vitest';
import { copyablePromptOf, nextTakeId, type PromptBearingRecord } from './scene-image-actions';

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
