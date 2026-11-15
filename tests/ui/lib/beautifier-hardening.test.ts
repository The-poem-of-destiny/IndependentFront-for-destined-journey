import { afterEach, describe, expect, it } from 'vitest';
import { computed, isReadonly } from 'vue';
import {
  beautifierHardened,
  setBeautifierHardened,
} from '../../../src/ui/lib/beautifier-hardening';

describe('美化帧加固开关', () => {
  afterEach(() => setBeautifierHardened(false));

  it('默认不加固', () => {
    expect(beautifierHardened.value).toBe(false);
  });

  it('只能经 setBeautifierHardened 改写，读取方拿到的是只读视图', () => {
    expect(isReadonly(beautifierHardened)).toBe(true);
    setBeautifierHardened(true);
    expect(beautifierHardened.value).toBe(true);
    setBeautifierHardened(false);
    expect(beautifierHardened.value).toBe(false);
  });

  it('是响应式的：依赖它的计算值随开关更新', () => {
    const mode = computed(() => (beautifierHardened.value ? 'cage' : 'plain'));
    expect(mode.value).toBe('plain');
    setBeautifierHardened(true);
    expect(mode.value).toBe('cage');
  });
});
