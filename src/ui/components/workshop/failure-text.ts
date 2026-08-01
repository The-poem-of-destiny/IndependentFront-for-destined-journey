/**
 * failure-text.ts — 把 `WorkshopFailure` 翻成给人看的一句话（Phase 1 / P1-4）
 *
 * 为什么单独一处: 同一个失败会出现在浏览模态、详情模态、页面 toast 三个地方，
 * 三处说法不一致时用户会以为遇到了三种不同的毛病。文案口径必须只有一份。
 *
 * ⚠️ `kind: 'cancelled'` 在这里**不该被展示** —— 那是用户自己按的取消，不是错误。
 * 调用点应当在到达本函数之前就 return；本函数给它留了一句兜底文案，仅防漏。
 *
 * 纯度约束: 无 Vue、无 store、无 I/O。
 */
import type { WorkshopFailure } from '../../lib/workshop-client';

export function describeFailure(f: WorkshopFailure): string {
  switch (f.kind) {
    case 'timeout':
      return '创意工坊一直没有响应。可能是服务在冷启动，稍后再试一次。';
    case 'network':
      return '连不上创意工坊。请检查网络，或稍后再试。';
    case 'http':
      return f.status === 404
        ? '这个项目在工坊里找不到了，可能已被作者下架。'
        : `创意工坊返回了 ${f.status ?? '异常'}。这通常是上游服务出了问题，稍后再试。`;
    case 'malformed':
      return `工坊返回的内容看不懂，可能是上游接口改了。（${f.message}）`;
    case 'no_source':
      return `这个项目没有可安装的内容。（${f.message}）`;
    case 'cancelled':
      return '已取消。';
    default:
      return f.message;
  }
}
