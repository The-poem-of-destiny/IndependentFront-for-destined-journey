/**
 * useManualSceneImage.ts — 玩家主动要图的那一条路（设计 §9.3 / D24）
 *
 * 装什么: 「发起 → 被限额拦下 → 弹一次确认 → 带确认重发」这一小段状态。
 * 不装什么: 生成本身（`scene-image-store.generate`）、限额判定（`image-quota.checkQuota`）、
 *           确认框长什么样（调用方各自渲染 —— 正文那一格是就地展开，右键入口是弹窗）。
 *
 * ---
 *
 * **为什么值得单独一个文件**
 *
 * 手动开火现在有**两个入口**（正文里的「生成插画」按钮、消息右键的「为这一段配图」），
 * 而 D24 那条规矩 ——「手动永不被判成不可用，最多是要确认」—— 两个入口都得守。
 * 两处各写一遍 `if (!result.ok) toast(...)` 的下场是可以预见的: 一处补上了确认、
 * 另一处仍然把用户拦死在一个 toast 上，而那正是 `image-quota` 专门写了测试去保证
 * **不会**发生的事。
 *
 * ---
 *
 * 🔴 **本 composable 只发得出 `source: 'manual'`**。请求形状里根本没有 `source` 与
 * `quotaConfirmed` 两个字段（见 {@link ManualSceneImageRequest}），所以「顺手给自动档
 * 也开一个绕过口」在这一层是**类型错误**而不是一次代码审查。store 那一侧还有第二道
 * 判据（`quotaConfirmed` 只对 manual 生效），两道都在。
 */
import { shallowRef, type ShallowRef } from 'vue';
import type {
  SceneImageGenerateInput,
  SceneImageGenerateResult,
} from '../stores/scene-image-store';

/**
 * 手动开火的入参 —— 与 `SceneImageGenerateInput` 同形，**减去两个不该由调用方决定的字段**:
 *
 * - `source` —— 本 composable 恒填 `'manual'`
 * - `quotaConfirmed` —— 只有走完确认框才配得上它，调用方给不了
 */
export type ManualSceneImageRequest = Omit<SceneImageGenerateInput, 'source' | 'quotaConfirmed'>;

/** 等着玩家点确认的那一次请求 */
export interface ManualSceneImagePending {
  /** 原样留着，确认之后**逐字重发**（只多一个 `quotaConfirmed`） */
  input: ManualSceneImageRequest;
  /**
   * `checkQuota` 给的那句中文，**原样显示**（§5.3 不变式）。
   *
   * 它已经是按「还能继续、只是要确认」的口吻写的；在这里改写成「已达上限」
   * 会让一个照样点得动的按钮看起来像坏了。
   */
  message: string;
}

export interface ManualSceneImageDeps {
  generate: (input: SceneImageGenerateInput) => Promise<SceneImageGenerateResult>;
  /** 拦下之外的失败（目前只有「没载入存档」）走这里报出去；缺省吞掉 */
  notify?: (message: string) => void;
}

export interface ManualSceneImage {
  /** 有一次请求在飞（用于把按钮置 loading，**不**置灰 —— 手动按钮永远可用，§9.3） */
  busy: ShallowRef<boolean>;
  /** 非 null = 确认框该出现了 */
  pending: ShallowRef<ManualSceneImagePending | null>;
  /** 发起一次手动生成；被限额拦下时**不报错**，而是把 `pending` 立起来 */
  request: (input: ManualSceneImageRequest) => Promise<SceneImageGenerateResult>;
  /** 玩家点了「仍然生成」—— 带 `quotaConfirmed` 逐字重发 */
  confirm: () => Promise<void>;
  /** 玩家点了「算了」 */
  dismiss: () => void;
}

export function useManualSceneImage(deps: ManualSceneImageDeps): ManualSceneImage {
  const busy = shallowRef(false);
  const pending = shallowRef<ManualSceneImagePending | null>(null);

  async function request(input: ManualSceneImageRequest): Promise<SceneImageGenerateResult> {
    busy.value = true;
    try {
      const result = await deps.generate({ ...input, source: 'manual' });
      // 🔴 拿到 ok:false 不是终点（D24）。这里立起确认框，钱由玩家自己决定花不花。
      if (!result.ok) pending.value = { input, message: result.message };
      return result;
    } finally {
      busy.value = false;
    }
  }

  async function confirm(): Promise<void> {
    const waiting = pending.value;
    if (waiting === null) return;
    pending.value = null;
    busy.value = true;
    try {
      const result = await deps.generate({
        ...waiting.input,
        source: 'manual',
        quotaConfirmed: true,
      });
      // 确认之后还被拒 = 限额之外的原因（store 里 bypass 只跳限额那一步），
      // 再立一次确认框只会变成一个点不完的圈 —— 如实报出来。
      if (!result.ok) deps.notify?.(result.message);
    } finally {
      busy.value = false;
    }
  }

  function dismiss(): void {
    pending.value = null;
  }

  return { busy, pending, request, confirm, dismiss };
}
