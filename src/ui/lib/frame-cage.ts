/**
 * 牢笼帧（cage frame）文档生成器 —— 插件系统设计 §4.1、§11。
 *
 * 每个插件界面 / 加固后的美化帧都是两层：宿主挂的外层牢笼帧（opaque sandbox，
 * 里面只有本文件生成的宿主脚本），以及牢笼帧创建的内层帧（真正的插件 / 美化文档）。
 *
 * 为什么要这一层：沙盒不禁止帧导航自己，文档自己的 CSP 在 Chromium 里管不到自身
 * 导航，子帧导航由**父文档**的 `frame-src` 约束 —— 牢笼帧就是这个父文档。牢笼还
 * 盯着内层帧的 `load`：第二次 `load` 意味着内层被导航走了，立即拆掉并上报。
 *
 * 内层帧不写 `sandbox` 属性：沙盒标志从外层牢笼帧继承（§4.1），外层由调用方按
 * `allow-scripts allow-forms allow-pointer-lock`（插件）或现有美化帧的标志挂载。
 * 两层用同一份 CSP（调用方传入），避免 srcdoc 继承策略时取交集挡掉插件所需。
 *
 * 两种连接方式：
 * - `relay` —— 美化帧用。牢笼把宿主（parent）与内层之间的 window 消息原样双向转发，
 *   现有美化帧协议与 `event.source` 校验都不用改（宿主看到的来源是牢笼帧窗口，
 *   内层看到的 parent 也是牢笼帧窗口）。
 * - `port-handoff` —— 插件帧用。宿主把 MessagePort 交给牢笼；内层发来第一条
 *   boot 消息后，牢笼把端口转交内层，然后不再转发任何东西。
 */

export const CAGE_MESSAGE_SOURCE = 'fated-poem-cage';

/** 内层帧的装载方式：`srcdoc` 优先；自检发现 srcdoc 被 `frame-src` 拦时改用 `blob:`。 */
export type CageInnerMode = 'srcdoc' | 'blob';

export type CageLinkMode = 'relay' | 'port-handoff';

/** 牢笼 → 宿主。 */
export interface CageHostMessage {
  source: typeof CAGE_MESSAGE_SOURCE;
  channel: string;
  type: 'cage-ready' | 'inner-ready' | 'cage-violation';
}

/**
 * 宿主 → 牢笼（仅 `port-handoff`），随消息转移一个 MessagePort：
 * `cage.contentWindow.postMessage(message, '*', [port])`。
 */
export interface CagePortMessage {
  source: typeof CAGE_MESSAGE_SOURCE;
  channel: string;
  type: 'port';
}

/** 内层 → 牢笼（仅 `port-handoff`）：内层引导脚本就绪后发一次，牢笼据此转交端口。 */
export interface CageInnerBootMessage {
  source: typeof CAGE_MESSAGE_SOURCE;
  channel: string;
  type: 'boot';
}

export interface CageDocumentOptions {
  /** 牢笼帧与内层帧共用的 CSP；`blob` 模式下须含 `frame-src blob:`。 */
  csp: string;
  /** 内层帧的完整 HTML 文档（含它自己的 CSP meta 与引导脚本）。 */
  inner: string;
  innerMode: CageInnerMode;
  link: CageLinkMode;
  channel: string;
  /** 给牢笼脚本挂的 nonce；CSP 不放行 `'unsafe-inline'` 时必须提供。 */
  scriptNonce?: string;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]+$/;

/** 嵌进 `<script>` 的 JS 字面量：转义 `<` 防 `</script>` 与 `<!--` 越狱，转义行分隔符。 */
function inlineScriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 生成牢笼帧的 srcdoc 文档。文档里只有宿主脚本：内层 HTML 以 JSON 字面量的形式
 * 进脚本，再由脚本写进内层帧的 `srcdoc` 属性或 blob URL —— 不经过牢笼文档的 HTML
 * 解析器，所以内层内容无法在牢笼里注入标签或属性。
 */
export function buildCageDocument({
  csp,
  inner,
  innerMode,
  link,
  channel,
  scriptNonce,
}: CageDocumentOptions): string {
  if (scriptNonce !== undefined && !NONCE_PATTERN.test(scriptNonce)) {
    throw new Error('frame-cage: scriptNonce 含非法字符');
  }
  const nonceAttribute = scriptNonce === undefined ? '' : ` nonce="${scriptNonce}"`;
  const config = inlineScriptLiteral({
    source: CAGE_MESSAGE_SOURCE,
    channel,
    innerMode,
    link,
    inner,
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
</head>
<body>
<script${nonceAttribute}>
(() => {
  'use strict';
  const config = ${config};
  const source = config.source;
  const channel = config.channel;
  const host = parent;
  let frame = null;
  let blobUrl = null;
  let loads = 0;
  let dead = false;
  let pendingPort = null;
  let innerBooted = false;
  let handedOff = false;

  const post = (type) => {
    try { host.postMessage({ source, channel, type }, '*'); } catch (_) {}
  };
  const isCageMessage = (data) =>
    !!data && typeof data === 'object' && data.source === source && data.channel === channel;
  const revokeBlob = () => {
    if (blobUrl === null) return;
    try { URL.revokeObjectURL(blobUrl); } catch (_) {}
    blobUrl = null;
  };

  // 内层被导航走（第二次 load）或其他违规：拆掉内层、停止一切转发、上报宿主。
  const violate = () => {
    if (dead) return;
    dead = true;
    removeEventListener('message', onMessage);
    revokeBlob();
    if (pendingPort) {
      try { pendingPort.close(); } catch (_) {}
      pendingPort = null;
    }
    if (frame) {
      try { frame.remove(); } catch (_) {}
      frame = null;
    }
    post('cage-violation');
  };

  const handOff = () => {
    if (handedOff || !innerBooted || !pendingPort || !frame || !frame.contentWindow) return;
    handedOff = true;
    const port = pendingPort;
    pendingPort = null;
    frame.contentWindow.postMessage({ source, channel, type: 'port' }, '*', [port]);
    // 端口交出后牢笼不再转发任何消息，只继续盯着内层的导航。
    removeEventListener('message', onMessage);
  };

  const onMessage = (event) => {
    if (dead) return;
    const data = event.data;
    const ports = event.ports ? Array.from(event.ports) : [];
    const innerWindow = frame ? frame.contentWindow : null;
    if (config.link === 'relay') {
      if (event.source === host) {
        // 发给牢笼自己的协议消息不转给内层。
        if (isCageMessage(data) || !innerWindow) return;
        innerWindow.postMessage(data, '*', ports);
        return;
      }
      if (innerWindow && event.source === innerWindow) {
        // 内层不得冒充牢笼向宿主报信（如伪造 cage-ready / cage-violation）。
        if (isCageMessage(data)) return;
        host.postMessage(data, '*', ports);
      }
      return;
    }
    // port-handoff
    if (event.source === host) {
      if (!isCageMessage(data) || data.type !== 'port' || pendingPort || handedOff) return;
      if (ports.length !== 1) return;
      pendingPort = ports[0];
      handOff();
      return;
    }
    if (innerWindow && event.source === innerWindow) {
      if (!isCageMessage(data) || data.type !== 'boot' || innerBooted) return;
      innerBooted = true;
      handOff();
    }
  };
  addEventListener('message', onMessage);

  const root = document.documentElement;
  const body = document.body;
  for (const element of [root, body]) {
    element.style.margin = '0';
    element.style.padding = '0';
    element.style.width = '100%';
    element.style.height = '100%';
    element.style.overflow = 'hidden';
    element.style.background = 'transparent';
  }

  frame = document.createElement('iframe');
  // 不写 sandbox：沙盒标志从牢笼帧继承（§4.1）。不写 allow：跨源帧的设备权限默认关闭。
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.style.display = 'block';
  frame.style.border = '0';
  frame.style.width = '100%';
  frame.style.height = '100%';
  frame.style.background = 'transparent';
  frame.addEventListener('load', () => {
    if (dead) return;
    loads += 1;
    if (loads === 1) {
      revokeBlob();
      post('inner-ready');
      return;
    }
    violate();
  });
  // 先定好来源再插入文档，避免插入时多出一次 about:blank 的 load。
  if (config.innerMode === 'blob') {
    blobUrl = URL.createObjectURL(new Blob([config.inner], { type: 'text/html' }));
    frame.setAttribute('src', blobUrl);
  } else {
    frame.setAttribute('srcdoc', config.inner);
  }
  body.appendChild(frame);
  post('cage-ready');
})();
</script>
</body>
</html>`;
}
