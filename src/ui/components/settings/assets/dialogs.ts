/**
 * 素材分区的确认 / 输入弹窗契约。
 *
 * 实现在 AssetDialogs.vue（一次只有一个弹窗在场），由 AssetSection 挂一份、
 * 用 provide 把这两个方法发下去；各子组件 inject 后当 window.confirm /
 * window.prompt 用。刻意不做成全局服务 —— 作用域就是这一个分区。
 *
 * 为什么与 audio/dialogs.ts 各存一份而不共享: 那份的 InjectionKey 是音频分区
 * 私有的作用域标记（`Symbol('audio-dialogs')`），两个分区共用同一个 key 就意味着
 * 两棵组件树抢同一个弹窗宿主。契约形状故意长得一样（同一副视觉、同一套语义），
 * 但 key 必须各自独立 —— 这正是「作用域就是这一个分区」那句话的落点。
 */
import type { InjectionKey } from 'vue';

export interface AssetConfirmOptions {
  title: string;
  message: string;
  /** 确认按钮文字，默认「确认」 */
  confirmLabel?: string;
  /** 危险操作 → 确认按钮走 danger 变体 */
  danger?: boolean;
}

export interface AssetPromptOptions {
  title: string;
  label: string;
  value: string;
}

export interface AssetDialogsApi {
  /** 取消 / Esc / 遮罩都兑现为 false，且只兑现一次 */
  askConfirm(opts: AssetConfirmOptions): Promise<boolean>;
  /** 解析为 trim 后的非空字符串；取消返回 null（对齐 window.prompt 的语义） */
  askPrompt(opts: AssetPromptOptions): Promise<string | null>;
}

export const assetDialogsKey: InjectionKey<AssetDialogsApi> = Symbol('asset-dialogs');
