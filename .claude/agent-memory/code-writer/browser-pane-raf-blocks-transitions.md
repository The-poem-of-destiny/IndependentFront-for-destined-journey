---
name: browser-pane-raf-blocks-transitions
description: Browser 工具真机走查时页面卡在首屏——Browser pane 未显示则不 compositing，requestAnimationFrame 不触发，Vue <transition mode="out-in"> 永远换不了页
metadata:
  type: feedback
---

用 Browser 工具（`preview_start` + `navigate`）做真机走查时，**如果 Browser pane 没有被显示**，页面不 compositing：`requestAnimationFrame` 回调永不执行、CSS `transitionend` 永不触发。App.vue 的 `<transition name="fade" mode="out-in">` 依赖这两者，于是 **`ui.navigate(...)` 改了 store 但视图永远停在首屏**，`.app-shell` 的子元素会卡在 `fade-enter-active` / `fade-leave-active` 类上。`computer` 的坐标点击同样打不中（screenshot 会直接报 "the Browser pane is not displayed"）。

**Why:** 这不是应用 bug，纯环境限制。不知道这一条会误判成「路由坏了 / store 不响应」，然后去改本来没问题的代码。

**How to apply:** 走查前先在页面里打这一针，再切视图：

```js
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
// 顺带把过渡时长压到 ~0，减少等待
const s = document.createElement('style');
s.textContent = '*,*::before,*::after{transition-duration:0.001s!important;animation-duration:0.001s!important}';
document.head.appendChild(s);
```

顺序要求：**先 reload 页面，再打针，最后切视图**——元素一旦卡进过渡中间态就修不回来了，只能重载。

补充（2026-07-31 P1-5 走查实测）：打完针后视图**能**切，只是慢——`defineAsyncComponent`
首次切换要等 1.5~3s 才出内容，等不够会误判成「按钮没接上」。`javascript_tool` 里不能裸写顶层
`await`，一律包 `(async()=>{ ... })()` 并在每步后 `await new Promise(r=>setTimeout(r,1500))`。
验证落库别在 UI 上找证据，直接 `indexedDB.open('SillyTavernWebDB')` 读 `saves` / `workshopProjects`
等表最快最准。表单输入要走原生 setter：
`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp,v)` +
`dispatchEvent(new Event('input',{bubbles:true}))`，否则 v-model 收不到。

配套的两条：
- 拿 store 实例：`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('ui')`，然后 `ui.navigate('workshop')`。直接写 `pinia.state.value.ui.currentView` 也能改到值，但一样过不了过渡那关。
- 点击一律用 `element.click()`（JS），别用 `computer` 的坐标点击。
- 验证结果读 `document.body.innerText` / `querySelectorAll`，screenshot 在这个模式下不可用。

相关：[[typecheck-skips-vue-sfc]]
