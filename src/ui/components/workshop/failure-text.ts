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

/**
 * 未登录 / 401 的统一引导语（D25）。
 *
 * ★ 三处共用一句：卡片上的小按钮、详情里的大按钮、页面 toast。分开写之后，卡片说
 * 「请先登录」而详情弹一条红色报错，用户会以为自己遇到了两个不同的毛病。
 *
 * 措辞刻意是**引导**而非报错 —— 未登录是完全正常的状态，不是出了错。
 */
export const WORKSHOP_LOGIN_GUIDE = '点赞与订阅需要先用 Discord 登录创意工坊。';

/**
 * 登录失败的整句（D25）。
 *
 * 上游 poll 的失败 `message` 绝大多数是**服务器成员门槛**没过（不在
 * `ALLOWED_GUILD_IDS` 内，§1.1），而它给的原话未必说得清「我该怎么办」。
 * 所以原话照登（上游将来换文案我们不必跟），后面补一句我们自己的前提说明。
 *
 * 为什么不区分「这条是不是门槛失败」再决定加不加: store 那边超时/弹窗被拦/上游 5xx
 * 都收在同一个 `message` 里，靠串匹配去猜是哪一种，猜错的那天就成了误导。而这句
 * 补充说的是**登录的前提条件**，对任何一种登录失败都成立。
 */
export function describeLoginFailure(message: string): string {
  const raw = (message ?? '').trim();
  const hint = '（登录需要你已加入「命定之诗」Discord 服务器）';
  return raw ? `${raw}${hint}` : `登录失败${hint}`;
}

export function describeFailure(f: WorkshopFailure): string {
  switch (f.kind) {
    case 'unauthorized':
      // 不是红色报错：token 过期是常态，用户要的是「去哪儿重新登录」而不是错误码
      return '登录状态已失效，请重新用 Discord 登录后再试。';
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
