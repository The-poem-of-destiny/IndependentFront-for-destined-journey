import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { useThemeStore } from './stores/theme-store';
import { useUIStore } from './stores/ui-store';
import { installUnlockListener } from './lib/audio-singleton';
import { installProductionEjsBackend } from '@engine/ejs-backend';
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
