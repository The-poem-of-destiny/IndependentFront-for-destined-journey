/**
 * 卸载内容包的确认流程（S-36）—— 「内容包」分区与内容态横幅共用。
 *
 * 🔴 卸载**永远先确认**：它把整个应用退回演示级占位内容，此前只有「改过包内世界书」
 *    才会弹一个原生框，平常一点就执行。文案按设计 §5.2 / §5.4 的真实卸载路径写：
 *    - 世界书 / Agent 提示词 / 预设 / 目录回落占位（provider-owned，删 pack 行即回落）；
 *    - 存档本身不删，但存档里勾选的内容包世界书条目会被标记为需要重新选择；
 *    - `settings.agents` 只存用户覆写，卸载不碰它 —— 自己改过的 Agent 设置保留；
 *    - 包自带的预设行被删，正在用时切回占位预设；
 *    - 在线授权包：清掉本地解密内容，恢复要重新登录并下载。
 * 编辑过包内世界书时，content-store 会返回 `needs_confirmation`，这里再问一次「修改会丢」。
 */
import { confirmDialog } from '../../lib/confirm-dialog';
import type { PackUninstallOutcome } from '../../stores/content-store';

type PackUninstallResult =
  | { status: 'cancelled' }
  | { status: 'uninstalled'; outcome: PackUninstallOutcome }
  | { status: 'busy' }
  | { status: 'saves_in_use' }
  | { status: 'failed' };

interface UninstallTarget {
  /** 当前是否为在线授权内容包（content-store 的 protectedPack） */
  protectedPack: boolean;
  uninstallPack: (opts?: { confirmEdits?: boolean }) => Promise<PackUninstallOutcome>;
}

/** 第一道确认的文案（措辞由 ContentPackSection 测试钉住） */
function buildUninstallConfirm(protectedPack: boolean) {
  const details = [
    '已有存档不会被删除，剧情、角色与记忆都保留；但存档里勾选的内容包世界书条目会被标记为需要重新选择，重新导入内容包之前它们只能用占位内容继续。',
    'Agent 的默认设置回落到占位默认；你自己改过的 Agent 设置会保留。内容包自带的预设会被删除，正在使用时自动切回占位预设。',
    protectedPack
      ? '这是在线授权内容包：本机已解密的内容会被清除，之后需要重新登录 Discord 并下载才能恢复。'
      : '如果你编辑过内容包自带的世界书，下一步会再确认一次：卸载会丢弃这些修改。',
  ];
  return {
    title: '卸载内容包？',
    message:
      '卸载后，应用会回到演示级占位内容：世界书、Agent 提示词、预设与目录数据都换回占位版本，直到你重新导入内容包。',
    details,
    confirmLabel: '卸载内容包',
    danger: true,
  };
}

/** 执行「确认 → 卸载 →（编辑过的书）二次确认 → 卸载」；抛错交给调用方处理 */
export async function confirmAndUninstallPack(
  target: UninstallTarget,
): Promise<PackUninstallResult> {
  if (!(await confirmDialog(buildUninstallConfirm(target.protectedPack)))) {
    return { status: 'cancelled' };
  }
  const outcome = await target.uninstallPack();
  if (!outcome.ok && outcome.status === 'needs_confirmation') {
    const edited = outcome.plan?.confirmations ?? [];
    const ok = await confirmDialog({
      title: '丢弃你对内容包世界书的修改？',
      message: `有 ${edited.length} 本内容包世界书被你编辑过。卸载会把它们换回占位版本，这些修改会丢失，无法恢复。`,
      details: edited.map((c) => `《${c.bookName || c.bookId}》`),
      confirmLabel: '丢弃修改并卸载',
      danger: true,
    });
    if (!ok) return { status: 'cancelled' };
    const done = await target.uninstallPack({ confirmEdits: true });
    if (done.ok) return { status: 'uninstalled', outcome: done };
    return refusal(done);
  }
  if (outcome.ok) return { status: 'uninstalled', outcome };
  return refusal(outcome);
}

/** 未卸成的结果分流：另一次操作在跑 / 存档被别的标签页占着（2026-11-27，L2）/ 其余算失败 */
function refusal(outcome: PackUninstallOutcome): PackUninstallResult {
  if (outcome.status === 'busy') return { status: 'busy' };
  if (outcome.status === 'saves_in_use') return { status: 'saves_in_use' };
  return { status: 'failed' };
}
