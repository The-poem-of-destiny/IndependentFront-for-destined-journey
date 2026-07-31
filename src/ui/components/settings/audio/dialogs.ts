/**
 * 音频分区的确认 / 输入弹窗契约。
 *
 * 实现在 AudioDialogs.vue（一次只有一个弹窗在场），由 AudioSection 挂一份、
 * 用 provide 把这两个方法发下去；各子组件 inject 后当 window.confirm /
 * window.prompt 用。刻意不做成全局服务 —— 作用域就是这一个分区。
 */
import type { InjectionKey } from 'vue';

export interface AudioConfirmOptions {
  title: string;
  message: string;
  /** 确认按钮文字，默认「确认」 */
  confirmLabel?: string;
  /** 危险操作 → 确认按钮走 danger 变体 */
  danger?: boolean;
}

export interface AudioPromptOptions {
  title: string;
  label: string;
  value: string;
}

export interface AudioDialogsApi {
  /** 取消 / Esc / 遮罩都兑现为 false，且只兑现一次 */
  askConfirm(opts: AudioConfirmOptions): Promise<boolean>;
  /** 解析为 trim 后的非空字符串；取消返回 null（对齐 window.prompt 的语义） */
  askPrompt(opts: AudioPromptOptions): Promise<string | null>;
}

export const audioDialogsKey: InjectionKey<AudioDialogsApi> = Symbol('audio-dialogs');
