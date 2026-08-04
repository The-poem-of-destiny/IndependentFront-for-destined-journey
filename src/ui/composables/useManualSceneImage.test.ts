/**
 * useManualSceneImage 测试（D24：手动被限额拦下是「弹一次确认后照发」，不是拦死）
 *
 * 这里钉住的是**手动那一侧的出路**。它对应 `image-quota` 里那条不变式 ——
 * 「手动按钮永远可用，`ok:false` 的语义是要确认而不是不许」—— 在 UI 侧的落点。
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  SceneImageGenerateInput,
  SceneImageGenerateResult,
} from '../stores/scene-image-store';
import { useManualSceneImage, type ManualSceneImageRequest } from './useManualSceneImage';

function baseRequest(over: Partial<ManualSceneImageRequest> = {}): ManualSceneImageRequest {
  return {
    saveId: 'save_1',
    messageId: 'msg_1',
    turn: 3,
    anchorKind: 'message-end',
    intent: '苏婉坐在壁炉旁，窗外下着雨',
    title: '第 3 回合的插画',
    characters: [],
    rating: 'general',
    ...over,
  };
}

const DENIED: SceneImageGenerateResult = {
  ok: false,
  reason: 'per-message',
  message: '这条消息已经有 2/2 张插画，继续生成会额外消耗额度 —— 确认后仍可生成',
};

describe('useManualSceneImage', () => {
  it('恒发 source:"manual"，且第一次绝不带 quotaConfirmed', async () => {
    const generate = vi.fn(
      async (_input: SceneImageGenerateInput): Promise<SceneImageGenerateResult> => ({
        ok: true,
        id: 'simg_1',
      }),
    );
    const manual = useManualSceneImage({ generate });

    await manual.request(baseRequest());

    expect(generate).toHaveBeenCalledTimes(1);
    const sent = generate.mock.calls[0]?.[0] as SceneImageGenerateInput;
    expect(sent.source).toBe('manual');
    expect(sent.quotaConfirmed).toBeUndefined();
    expect(manual.pending.value).toBeNull();
  });

  it('🔴 被限额拦下时不是终点：立起确认框，原样带着 checkQuota 那句中文', async () => {
    const generate = vi.fn(
      async (_input: SceneImageGenerateInput): Promise<SceneImageGenerateResult> => DENIED,
    );
    const notify = vi.fn();
    const manual = useManualSceneImage({ generate, notify });

    const result = await manual.request(baseRequest());

    expect(result.ok).toBe(false);
    expect(manual.pending.value?.message).toBe(DENIED.message);
    // 拦下不是错误 —— 不该冒一条 toast 然后就结束了（那正是 D24 要修的行为）
    expect(notify).not.toHaveBeenCalled();
  });

  it('确认之后逐字重发，只多一个 quotaConfirmed', async () => {
    const generate = vi
      .fn<(input: SceneImageGenerateInput) => Promise<SceneImageGenerateResult>>()
      .mockResolvedValueOnce(DENIED)
      .mockResolvedValueOnce({ ok: true, id: 'simg_2' });
    const manual = useManualSceneImage({ generate });

    await manual.request(baseRequest({ title: '第 7 回合的插画', turn: 7 }));
    await manual.confirm();

    expect(generate).toHaveBeenCalledTimes(2);
    const second = generate.mock.calls[1]?.[0] as SceneImageGenerateInput;
    expect(second).toMatchObject({
      title: '第 7 回合的插画',
      turn: 7,
      anchorKind: 'message-end',
      source: 'manual',
      quotaConfirmed: true,
    });
    expect(manual.pending.value).toBeNull();
  });

  it('🔴 auto 拿不到这个绕过口 —— 请求形状里根本没有 source/quotaConfirmed', async () => {
    const generate = vi.fn(
      async (_input: SceneImageGenerateInput): Promise<SceneImageGenerateResult> => DENIED,
    );
    const manual = useManualSceneImage({ generate });

    // @ts-expect-error 手动入口发不出自动档：`source` 不在 ManualSceneImageRequest 里
    await manual.request({ ...baseRequest(), source: 'auto' });
    // @ts-expect-error 绕过口不由调用方给：只有走完确认框才配得上它
    await manual.request({ ...baseRequest(), quotaConfirmed: true });
    await manual.confirm();

    // 三次调用（两次 request + 一次 confirm），每一次都是 manual
    for (const call of generate.mock.calls) {
      expect((call[0] as SceneImageGenerateInput).source).toBe('manual');
    }
  });

  it('确认之后仍被拒（限额之外的原因）就如实报出来，不再立第二个确认框', async () => {
    const generate = vi
      .fn<(input: SceneImageGenerateInput) => Promise<SceneImageGenerateResult>>()
      .mockResolvedValue(DENIED);
    const notify = vi.fn();
    const manual = useManualSceneImage({ generate, notify });

    await manual.request(baseRequest());
    await manual.confirm();

    expect(notify).toHaveBeenCalledWith(DENIED.message);
    expect(manual.pending.value).toBeNull();
  });

  it('dismiss 收掉确认框，且一个字节都不花', async () => {
    const generate = vi.fn(
      async (_input: SceneImageGenerateInput): Promise<SceneImageGenerateResult> => DENIED,
    );
    const manual = useManualSceneImage({ generate });

    await manual.request(baseRequest());
    manual.dismiss();

    expect(manual.pending.value).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('busy 在请求期间为真、结束后归位（按钮转圈但绝不置灰，§9.3）', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = vi.fn(
      async (_input: SceneImageGenerateInput): Promise<SceneImageGenerateResult> => {
        await gate;
        return { ok: true, id: 'simg_3' };
      },
    );
    const manual = useManualSceneImage({ generate });

    const flight = manual.request(baseRequest());
    expect(manual.busy.value).toBe(true);
    release?.();
    await flight;
    expect(manual.busy.value).toBe(false);
  });
});
