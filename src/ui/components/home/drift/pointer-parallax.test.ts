/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { bindPointerParallax } from './pointer-parallax';

describe('首页星盘鼠标视差', () => {
  it('从可命中的父容器读取指针位置，并在离开时回中', () => {
    const home = document.createElement('div');
    const stage = document.createElement('div');
    home.append(stage);
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      right: 500,
      bottom: 250,
      width: 400,
      height: 200,
      toJSON: () => ({}),
    });

    const binding = bindPointerParallax(stage);
    home.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 50 }));

    expect(binding.state.targetX).toBe(1);
    expect(binding.state.targetY).toBe(-1);

    home.dispatchEvent(new Event('pointerleave'));
    expect(binding.state.targetX).toBe(0);
    expect(binding.state.targetY).toBe(0);
  });

  it('销毁后解除父容器上的指针监听', () => {
    const home = document.createElement('div');
    const stage = document.createElement('div');
    home.append(stage);
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    });

    const binding = bindPointerParallax(stage);
    binding.dispose();
    home.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 100 }));

    expect(binding.state.targetX).toBe(0);
    expect(binding.state.targetY).toBe(0);
  });
});
