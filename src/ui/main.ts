import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { useThemeStore } from './stores/theme-store';
import { useUIStore } from './stores/ui-store';
import { installUnlockListener } from './lib/audio-singleton';
import { installProductionEjsBackend } from '@engine/ejs-backend';
import { setEngineSettingsProvider } from '@engine/engine-settings';
import { useSettingsStore } from './stores/settings-store';
// 字体与图标 —— **自托管**，零外部请求（2026-08-05，替掉 index.html 里的两个 CDN）。
//
// 🔴 必须排在所有样式表**之前**：`@font-face` 得先登记，否则首屏那一瞬按兜底字体排版，
//    字体到位后再回流一次（CJK 字面宽度差很大，那一跳很显眼）。
//
// 用的是 **variable** 包（`@fontsource-variable/*`）而不是逐字重的静态包：
// 静态包 4 个字重 × 2 个中文族约 34MB，变量包一共 10.6MB 就覆盖 100–900 全区间。
// 两个包都保留了 Google 的 unicode-range 切片（每族 101 个子集），所以浏览器仍然
// 只下载正文真正用到的那几片，不是一次拉整族。
//
// 🔴 字体族名是 `'Noto Sans SC Variable'`（带 Variable 后缀），与静态包不同 ——
//    `themes/variables.css` 与 `stores/theme-store.ts` 的字体栈必须写这个名字，
//    写成 `'Noto Sans SC'` 不会报错，只会安静地退回系统字体。
import '@fontsource-variable/noto-sans-sc';
import '@fontsource-variable/noto-serif-sc';
import '@fontsource-variable/cinzel';
// Font Awesome 只引用到的两套：fa-solid（221 处）+ fa-regular（2 处）。
// **刻意不引 brands.css** —— 全仓零处使用，省掉 fa-brands-400.woff2。
import '@fortawesome/fontawesome-free/css/fontawesome.css';
import '@fortawesome/fontawesome-free/css/solid.css';
import '@fortawesome/fontawesome-free/css/regular.css';

import './styles/base.css';
import './styles/transitions.css';
import './styles/utilities.css';

// 主题系统
import './themes/variables.css';
import './themes/parchment.css';
import './themes/obsidian.css';
import './themes/crimson.css';
import './themes/indigo.css';
import './themes/bronze.css';
import './themes/sakura.css';
import './themes/ivory.css';
import './themes/misty-lilac.css';
import './themes/forest.css';
import './themes/ocean.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);

// 初始化主题（在 app 挂载前）
const themeStore = useThemeStore();
themeStore.init();
themeStore.initFontSize();
// 🔴 必须跟着 init() 一起跑：这两格是「设置严格压过主题」的执行点，少了它，
//    字体退回 [data-theme] 说了算，而设置页的下拉框仍显示用户选的值（design.md §7.4）
themeStore.initFonts();

// 引擎读设置的注入缝（Q-06）。
//
// 设置的真源是 settings-store（持久化到 localStorage，按 AGENTS.md 那里只存无密钥
// 元数据）。引擎侧 createSnapshot 此前读的是 Dexie `settings` 表 —— 一份靠
// game-pipeline 每轮抄两个字段维持的影子配置，桥断了用户完全无感。
//
// **必须在挂载前注册**：开场 Prompt 那一轮管线可能在挂载后立刻跑起来，
// 晚注册会让第一张快照按缺省上限裁剪。
setEngineSettingsProvider(() => {
  const s = useSettingsStore().settings;
  return {
    // 设置页上叫「快照上限」，字段名是历史遗留的 memorySnapshotLimit
    maxSnapshotsPerSave: s.memorySnapshotLimit,
    snapshotRetentionMode: s.snapshotRetentionMode,
  };
});

// 首次手势解锁监听 —— 必须在**应用启动时**就装，不能等到音频用起来才装。
//
// 浏览器要求 AudioContext 在用户手势的调用栈里 resume()。而"点某个按钮进游戏"
// 这一下手势发生在 GamePage 挂载之前：等挂载后才装监听，那一下就白白错过了，
// 进场配乐只能落进 pending 队列，得等用户**再随便点一下**才出声。
//
// 装监听本身不构造 AudioContext（getAudioManager() 只在手势回调里调），
// 所以从不碰音频的会话也不会平白多出一个 AudioContext。
installUnlockListener();

// 世界书 EJS 隔离后端（能力面 §0.1 / 切片 T8 / §11.2 ①）。
//
// **不 await**：wasm 装载有开销，挡在挂载前会白白拖慢启动；而世界书求值只发生在
// 提示装配期（第一次发消息时），那时早已装完。装载期间后端是 fail-closed，
// 不存在「还没装完先用 new Function 渲染一轮」的窗口。
//
// 🔴 返回值**必须接住**。之前这里写的是 `void installProductionEjsBackend();`，
// 而函数注释写着「调用方据返回值决定要不要提示用户」—— 没有调用方在看，
// 于是「隔离装载失败」变成一条没人读的 console.warn。装不上是安全相关的状态，
// 必须让用户看见，否则他会按「有隔离」来用（比如去开工坊）。
void installProductionEjsBackend().then((isolated) => {
  if (isolated) return;
  useUIStore().toast(
    'EJS 隔离环境未能装载，世界书动态内容已停用（条目按原文注入）。请刷新或更新浏览器。',
    'error',
    // 安全相关，不自动消失
    0,
  );
});

app.mount('#app');
