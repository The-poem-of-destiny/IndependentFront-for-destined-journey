/**
 * fx-item-flight.ts — 物品飞入
 *
 * 守的是：弧线关键帧的几何（起止落点、朝上拱起、两头透明）；
 * 闸门关 / 标签页隐藏 / 目标缺席 / 无 element.animate 时整个跳过、不建节点；
 * 同一时间至多一次飞行，在飞时的请求被合并；落地后图标挤压一次。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  arcKeyframes,
  createItemFlight,
  isItemGainMessage,
  FLIGHT_DURATION_MS,
} from '../../../src/ui/lib/fx-item-flight';

function parse(frame: Keyframe): { x: number; y: number; deg: number } {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) rotate\((-?[\d.]+)deg\)/.exec(
    String(frame.transform),
  );
  if (!m) throw new Error(`坏关键帧: ${String(frame.transform)}`);
  return { x: Number(m[1]), y: Number(m[2]), deg: Number(m[3]) };
}

describe('arcKeyframes', () => {
  const from = { x: 600, y: 500 };
  const to = { x: 40, y: 120 };

  it('帧数与 offset：首帧 0、末帧 1、单调递增', () => {
    const frames = arcKeyframes(from, to, 12);
    expect(frames).toHaveLength(12);
    expect(frames[0].offset).toBe(0);
    expect(frames[11].offset).toBe(1);
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].offset!).toBeGreaterThan(frames[i - 1].offset!);
    }
  });

  it('首帧落在起点、末帧落在终点', () => {
    const frames = arcKeyframes(from, to, 8);
    expect(parse(frames[0])).toMatchObject({ x: 600, y: 500 });
    expect(parse(frames[7])).toMatchObject({ x: 40, y: 120 });
  });

  it('弧线朝上拱起：中点高于起止连线的中点', () => {
    const frames = arcKeyframes(from, to, 9);
    const mid = parse(frames[4]);
    expect(mid.y).toBeLessThan((from.y + to.y) / 2);
  });

  it('水平飞行也朝上拱，且拱高有上限', () => {
    const frames = arcKeyframes({ x: 0, y: 500 }, { x: 4000, y: 500 }, 3);
    const mid = parse(frames[1]);
    expect(mid.y).toBeLessThan(500);
    // 二次贝塞尔中点 = 控制点偏移的一半；上限 160 → 至多 80
    expect(500 - mid.y).toBeLessThanOrEqual(80.01);
  });

  it('透明度两头为 0、中段为正', () => {
    const frames = arcKeyframes(from, to, 7);
    expect(frames[0].opacity).toBe(0);
    expect(frames[6].opacity).toBe(0);
    expect(Number(frames[3].opacity)).toBeGreaterThan(0.9);
  });

  it('步数不足 2 时按 2 算；起止重合不产生 NaN', () => {
    const frames = arcKeyframes({ x: 5, y: 5 }, { x: 5, y: 5 }, 1);
    expect(frames).toHaveLength(2);
    for (const f of frames) expect(String(f.transform)).not.toContain('NaN');
  });
});

describe('isItemGainMessage', () => {
  it('item_gen 与 craft 系统消息算「获得物品」', () => {
    expect(isItemGainMessage({ role: 'system', systemEvent: { type: 'item_gen' } as never })).toBe(
      true,
    );
    expect(isItemGainMessage({ role: 'system', systemEvent: { type: 'craft' } as never })).toBe(
      true,
    );
  });

  it('其他事件与非系统消息不算', () => {
    expect(isItemGainMessage({ role: 'system', systemEvent: { type: 'combat' } as never })).toBe(
      false,
    );
    expect(isItemGainMessage({ role: 'assistant', systemEvent: undefined })).toBe(false);
  });
});

// ── 执行器 ──

interface FakeAnim {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
  finish: () => void;
  finished: Promise<void>;
}

const anims: FakeAnim[] = [];

function installAnimate(): void {
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const finished = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const anim: FakeAnim = {
      keyframes,
      options,
      finished,
      finish: () => resolve(),
      cancel: vi.fn(() => reject(new Error('aborted'))),
    };
    anims.push(anim);
    return anim;
  };
}

function removeAnimate(): void {
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
}

function rect(left: number, top: number, w: number, h: number): DOMRect {
  return {
    left,
    top,
    width: w,
    height: h,
    right: left + w,
    bottom: top + h,
    x: left,
    y: top,
  } as DOMRect;
}

function setupDom(opts: { target?: boolean; targetVisible?: boolean; row?: boolean } = {}) {
  const { target = true, targetVisible = true, row = true } = opts;
  document.body.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'fx-item-flight';
  document.body.appendChild(overlay);
  if (row) {
    const r = document.createElement('div');
    r.className = 'bubble-row bubble-row-system';
    r.getBoundingClientRect = () => rect(300, 600, 400, 40);
    document.body.appendChild(r);
  }
  let btn: HTMLElement | null = null;
  if (target) {
    btn = document.createElement('button');
    btn.className = 'tool-btn';
    btn.setAttribute('data-tool', 'items');
    btn.innerHTML = '<i class="fa-solid fa-box"></i>';
    btn.getBoundingClientRect = () => (targetVisible ? rect(10, 100, 40, 40) : rect(0, 0, 0, 0));
    document.body.appendChild(btn);
  }
  return { overlay, btn };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  anims.length = 0;
  removeAnimate();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('createItemFlight', () => {
  it('闸门关 → 跳过，不建节点', () => {
    installAnimate();
    const { overlay } = setupDom();
    const f = createItemFlight({ getOverlay: () => overlay, isFxEnabled: () => false });
    expect(f.request()).toBe('fx-off');
    expect(overlay.childElementCount).toBe(0);
    expect(anims).toHaveLength(0);
  });

  it('标签页隐藏 → 跳过', () => {
    installAnimate();
    const { overlay } = setupDom();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const f = createItemFlight({ getOverlay: () => overlay, isFxEnabled: () => true });
    expect(f.request()).toBe('hidden');
    expect(overlay.childElementCount).toBe(0);
  });

  it('目标缺席或不可见 → 跳过', () => {
    installAnimate();
    let dom = setupDom({ target: false });
    let f = createItemFlight({ getOverlay: () => dom.overlay, isFxEnabled: () => true });
    expect(f.request()).toBe('no-target');
    expect(dom.overlay.childElementCount).toBe(0);

    dom = setupDom({ targetVisible: false });
    f = createItemFlight({ getOverlay: () => dom.overlay, isFxEnabled: () => true });
    expect(f.request()).toBe('no-target');
  });

  it('没有 element.animate → 跳过', () => {
    removeAnimate();
    const { overlay } = setupDom();
    const f = createItemFlight({ getOverlay: () => overlay, isFxEnabled: () => true });
    expect(f.request()).toBe('no-animate');
    expect(overlay.childElementCount).toBe(0);
  });

  it('起飞：一道光条约 700ms 飞向背包按钮，落地后图标挤压 0.9 → 1.04 → 1', async () => {
    installAnimate();
    const { overlay, btn } = setupDom();
    const f = createItemFlight({ getOverlay: () => overlay, isFxEnabled: () => true });
    expect(f.request()).toBe('started');
    expect(overlay.querySelectorAll('.fx-flight-streak')).toHaveLength(1);
    expect(anims).toHaveLength(1);
    expect(anims[0].options.duration).toBe(FLIGHT_DURATION_MS);
    // 终点 = 背包按钮中心 (30, 120)；起点 = 最后一条系统行中心 (500, 620)
    const last = anims[0].keyframes[anims[0].keyframes.length - 1];
    expect(String(last.transform)).toContain('translate(30.0px, 120.0px)');
    expect(String(anims[0].keyframes[0].transform)).toContain('translate(500.0px, 620.0px)');

    anims[0].finish();
    await flush();
    expect(overlay.childElementCount).toBe(0);
    expect(anims).toHaveLength(2);
    const scales = anims[1].keyframes.map((k) => k.transform);
    expect(scales).toEqual(['scale(1)', 'scale(0.9)', 'scale(1.04)', 'scale(1)']);
    expect(f.isBusy()).toBe(true);

    anims[1].finish();
    await flush();
    expect(f.isBusy()).toBe(false);
    void btn;
  });

  it('在飞时的请求被合并：同一时间至多一次飞行', () => {
    installAnimate();
    const { overlay } = setupDom();
    const f = createItemFlight({ getOverlay: () => overlay, isFxEnabled: () => true });
    expect(f.request()).toBe('started');
    expect(f.request()).toBe('busy');
    expect(f.request()).toBe('busy');
    expect(anims).toHaveLength(1);
    expect(overlay.querySelectorAll('.fx-flight-streak')).toHaveLength(1);
  });

  it('没有系统行时从对话区底部中点起飞', () => {
    installAnimate();
    const { overlay } = setupDom({ row: false });
    const chat = document.createElement('div');
    chat.className = 'chat-flow';
    chat.getBoundingClientRect = () => rect(200, 0, 600, 800);
    document.body.appendChild(chat);
    const f = createItemFlight({ getOverlay: () => overlay, isFxEnabled: () => true });
    f.request();
    expect(String(anims[0].keyframes[0].transform)).toContain('translate(500.0px, 776.0px)');
  });

  it('最后一条系统行已滚出视口或对话区可见区：改从对话区底部中点起飞', () => {
    installAnimate();
    const { overlay } = setupDom({ row: false });
    const chat = document.createElement('div');
    chat.className = 'chat-flow';
    chat.getBoundingClientRect = () => rect(200, 100, 600, 600);
    document.body.appendChild(chat);
    const row = document.createElement('div');
    row.className = 'bubble-row bubble-row-system';
    document.body.appendChild(row);
    const f = createItemFlight({ getOverlay: () => overlay, isFxEnabled: () => true });

    // 滚到视口上方
    row.getBoundingClientRect = () => rect(300, -400, 400, 40);
    f.request();
    expect(String(anims[0].keyframes[0].transform)).toContain('translate(500.0px, 676.0px)');
    f.dispose();
    anims.length = 0;

    // 仍在视口内，但已被对话区的滚动裁掉（压在顶栏后面）
    row.getBoundingClientRect = () => rect(300, 40, 400, 40);
    f.request();
    expect(String(anims[0].keyframes[0].transform)).toContain('translate(500.0px, 676.0px)');
    f.dispose();
    anims.length = 0;

    // 在对话区可见区内：照旧取系统行中心
    row.getBoundingClientRect = () => rect(300, 400, 400, 40);
    f.request();
    expect(String(anims[0].keyframes[0].transform)).toContain('translate(500.0px, 420.0px)');
  });

  it('dispose 中止在飞动画并清掉光条', async () => {
    installAnimate();
    const { overlay } = setupDom();
    const f = createItemFlight({ getOverlay: () => overlay, isFxEnabled: () => true });
    f.request();
    f.dispose();
    await flush();
    expect(anims[0].cancel).toHaveBeenCalled();
    expect(overlay.childElementCount).toBe(0);
    expect(f.isBusy()).toBe(false);
    // 没有落地挤压
    expect(anims).toHaveLength(1);
  });
});
