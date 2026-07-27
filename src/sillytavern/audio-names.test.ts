/**
 * audio-names.test.ts — 按名寻址纯函数单元测试
 *
 * 覆盖: 扩展名剥离 / 空白折叠 / 大小写 / CJK / 多命中稳定性 /
 * 占用判定（含 exceptId） / 去重取名（含尾缀换号与大小写保留）。
 * 纯函数模块，无任何 seam 注入。
 */

import { describe, it, expect } from 'vitest';
import {
  AUDIO_FILE_EXTENSIONS,
  AUDIO_MIME_BY_EXTENSION,
  normalizeAudioName,
  findByName,
  isNameTaken,
  uniqueAudioName,
} from './audio-names';

/** findByName 的最小行形状 */
function row(id: string, name: string, createdAt: number) {
  return { id, name, createdAt };
}

describe('AUDIO_FILE_EXTENSIONS', () => {
  it('与 MIME 表同源，且含全部 9 个受支持扩展名', () => {
    expect(AUDIO_FILE_EXTENSIONS).toEqual(Object.keys(AUDIO_MIME_BY_EXTENSION));
    expect([...AUDIO_FILE_EXTENSIONS].sort()).toEqual(
      ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'webm'],
    );
  });
});

describe('normalizeAudioName —— 扩展名剥离', () => {
  it.each(AUDIO_FILE_EXTENSIONS)('剥掉尾部 .%s', (ext) => {
    expect(normalizeAudioName(`battle.${ext}`)).toBe('battle');
  });

  it('大写扩展名同样剥掉', () => {
    expect(normalizeAudioName('Battle.MP3')).toBe('battle');
    expect(normalizeAudioName('Battle.FlAc')).toBe('battle');
  });

  it('名字中间的点保留', () => {
    expect(normalizeAudioName('v1.2 主题')).toBe('v1.2 主题');
    expect(normalizeAudioName('a.b.mp3')).toBe('a.b');
  });

  it('未知扩展名不剥', () => {
    expect(normalizeAudioName('battle.txt')).toBe('battle.txt');
    expect(normalizeAudioName('battle.')).toBe('battle.');
  });

  it('整串只是一个扩展名时不剥（不得归一化成空串）', () => {
    expect(normalizeAudioName('.mp3')).toBe('.mp3');
    expect(normalizeAudioName('  .WAV  ')).toBe('.wav');
  });
});

describe('normalizeAudioName —— 空白与大小写', () => {
  it('两端 trim + 内部空白折叠成单个空格', () => {
    expect(normalizeAudioName('  夜之 \t\n 城   主题  ')).toBe('夜之 城 主题');
  });

  it('剥完扩展名后残留的空白也被清掉', () => {
    expect(normalizeAudioName('战斗 .mp3')).toBe('战斗');
  });

  it('casefold —— Latin 大小写对等价', () => {
    expect(normalizeAudioName('Battle Theme')).toBe(normalizeAudioName('bATTLE theme'));
  });

  it('空串 / 纯空白归一化为空', () => {
    expect(normalizeAudioName('')).toBe('');
    expect(normalizeAudioName('   \t ')).toBe('');
  });
});

describe('normalizeAudioName —— CJK', () => {
  it('战斗 / 战斗.mp3 / " 战斗 " 三者等价', () => {
    const a = normalizeAudioName('战斗');
    expect(normalizeAudioName('战斗.mp3')).toBe(a);
    expect(normalizeAudioName(' 战斗 ')).toBe(a);
    expect(normalizeAudioName('战斗.MP3')).toBe(a);
    expect(a).toBe('战斗');
  });

  it('不同 CJK 名字不混淆', () => {
    expect(normalizeAudioName('战斗')).not.toBe(normalizeAudioName('战斗2'));
  });
});

describe('findByName', () => {
  const items = [
    row('t1', '战斗', 300),
    row('t2', '夜之城.mp3', 100),
    row('t3', '  Battle Theme  ', 200),
  ];

  it('按归一化名字命中', () => {
    expect(findByName(items, '战斗.mp3')?.id).toBe('t1');
    expect(findByName(items, ' 夜之城 ')?.id).toBe('t2');
    expect(findByName(items, 'battle   theme')?.id).toBe('t3');
  });

  it('未命中返回 undefined', () => {
    expect(findByName(items, '不存在')).toBeUndefined();
  });

  it('空查询 / 纯空白查询返回 undefined', () => {
    expect(findByName(items, '')).toBeUndefined();
    expect(findByName(items, '   ')).toBeUndefined();
    expect(findByName([row('x', '', 1)], '  ')).toBeUndefined();
  });

  it('多命中取 createdAt 最小的一条', () => {
    const dupes = [
      row('a', '战斗', 300),
      row('b', '战斗.mp3', 100),
      row('c', ' 战斗 ', 200),
    ];
    expect(findByName(dupes, '战斗')?.id).toBe('b');
  });

  it('数组顺序颠倒后结果不变', () => {
    const dupes = [
      row('a', '战斗', 300),
      row('b', '战斗.mp3', 100),
      row('c', ' 战斗 ', 200),
    ];
    expect(findByName([...dupes].reverse(), '战斗')?.id).toBe('b');
  });

  it('createdAt 相同时按 id 升序破平（且与顺序无关）', () => {
    const dupes = [
      row('z-track', '战斗', 100),
      row('a-track', '战斗.mp3', 100),
      row('m-track', '战斗', 100),
    ];
    expect(findByName(dupes, '战斗')?.id).toBe('a-track');
    expect(findByName([...dupes].reverse(), '战斗')?.id).toBe('a-track');
  });

  it('无 id 字段的行也能工作（仅按 createdAt）', () => {
    const noId = [
      { name: '战斗', createdAt: 200 },
      { name: '战斗.mp3', createdAt: 100 },
    ];
    expect(findByName(noId, '战斗')?.createdAt).toBe(100);
  });

  it('空数组返回 undefined', () => {
    expect(findByName([], '战斗')).toBeUndefined();
  });
});

describe('isNameTaken', () => {
  const items = [
    { id: 't1', name: '战斗' },
    { id: 't2', name: 'Night City.mp3' },
  ];

  it('归一化比较判定占用', () => {
    expect(isNameTaken(items, '战斗.mp3')).toBe(true);
    expect(isNameTaken(items, '  night   city  ')).toBe(true);
    expect(isNameTaken(items, '夜之城')).toBe(false);
  });

  it('exceptId 排除自身 —— 改名成自己现有的名字不算冲突', () => {
    expect(isNameTaken(items, '战斗', 't1')).toBe(false);
    expect(isNameTaken(items, '战斗.MP3', 't1')).toBe(false);
    // 排除的是别人时仍然冲突
    expect(isNameTaken(items, '战斗', 't2')).toBe(true);
  });

  it('空候选名不算占用', () => {
    expect(isNameTaken(items, '')).toBe(false);
    expect(isNameTaken(items, '   ')).toBe(false);
  });
});

describe('uniqueAudioName', () => {
  it('空闲时原样返回', () => {
    expect(uniqueAudioName([{ id: 'a', name: '夜之城' }], '战斗')).toBe('战斗');
  });

  it('冲突时取最小可用编号 (2)', () => {
    const items = [{ id: 'a', name: '战斗' }];
    expect(uniqueAudioName(items, '战斗')).toBe('战斗 (2)');
  });

  it('已存在 (2) 时新的 "战斗" 得到 (3)', () => {
    const items = [
      { id: 'a', name: '战斗' },
      { id: 'b', name: '战斗 (2)' },
    ];
    expect(uniqueAudioName(items, '战斗')).toBe('战斗 (3)');
  });

  it('已带尾缀的输入换号而不是叠加', () => {
    const items = [
      { id: 'a', name: '战斗' },
      { id: 'b', name: '战斗 (2)' },
    ];
    expect(uniqueAudioName(items, '战斗 (2)')).toBe('战斗 (3)');
    expect(uniqueAudioName(items, '战斗 (2)')).not.toContain('(2) (2)');
  });

  it('编号有空洞时取最小的那个空洞', () => {
    const items = [
      { id: 'a', name: '战斗' },
      { id: 'b', name: '战斗 (3)' },
    ];
    expect(uniqueAudioName(items, '战斗')).toBe('战斗 (2)');
  });

  it('冲突判定走归一化（扩展名 / 空白 / 大小写都算撞名）', () => {
    const items = [{ id: 'a', name: '战斗.mp3' }];
    expect(uniqueAudioName(items, '战斗')).toBe('战斗 (2)');

    const latin = [{ id: 'a', name: 'battle theme' }];
    expect(uniqueAudioName(latin, 'Battle   Theme')).toBe('Battle   Theme (2)');
  });

  it('保留调用方的大小写', () => {
    const items = [{ id: 'a', name: 'battle' }];
    expect(uniqueAudioName(items, 'Battle')).toBe('Battle (2)');
  });

  it('base 只是编号形状时不误剥', () => {
    const items = [{ id: 'a', name: '(2)' }];
    expect(uniqueAudioName(items, '(2)')).toBe('(2) (2)');
  });

  it('空名字视为空闲，原样返回', () => {
    expect(uniqueAudioName([{ id: 'a', name: '战斗' }], '')).toBe('');
  });
});
