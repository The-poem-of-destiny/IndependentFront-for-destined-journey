---
name: content-registry-not-reactive
description: content-store 的注册表是模块级普通变量；Vue computed 里直接读它会永久缓存首次求值结果，内容加载完 UI 仍是空的
metadata:
  type: feedback
---

内容-引擎分离（波 2）把七池/血脉/地点/品牌搬进 `content-store` 的注册表后，**任何 Vue
computed 里都不许直接 `getContentRegistry().<face>`** —— 必须先落进 `ref`，由加载门
（`initContent()` 之类）赋值。

**Why:** `registry` 是 content-store 里的模块级 `let`，`setContentRegistry()` 整份替换它，
但它**不是 reactive 对象**。computed 首次求值时注册表往往还没灌（异步 fetch），于是那份
空目录被永久缓存 —— 症状是「内容加载完了，捏人页下拉还是只有『自定义』一项」，
而且**不报任何错**。装包重灌注册表同理，UI 一动不动。

**How to apply:**
- store 构造时**同步**读一次（boot 链常态下已灌好，少一帧空列表），再由加载门 `await
  ensureContentRegistryLoaded()` 后重取一次；两处都写进同一个 `ref`。
- 加载门四态 `idle | loading | ready | empty`：构造时没内容是 `idle`（还没试过），
  只有走完加载才敢下 `empty` 的结论。一进页面就画空态 = 把「还在加载」误报成「没内容」。
- 品牌面（era/appTitle…）解析走 `src/ui/branding-defaults.ts` 的 `getBranding()`，
  **别在消费方另写一个 `raw.era` 读法**；血脉走 `bloodlines.getBloodlineSet()` 的注册表缝
  再落 ref（无参 `getBloodlineList()` 在 computed 里会踩同一个坑）。
- 🔴 **等的必须是 `ensureContentRegistryLoaded()`，不是 `contentReadyPromise`**。后者在
  content-store **模块加载时就同步兑现**（文件尾 `seedPlaceholderRegistry()` +
  `markContentReady()`），它只说明「占位骨架就位」，对 `/data/content/*.json` 那几次 fetch
  一个字都没说。`await contentReadyPromise` 之后重取注册表 = 又读到一次空目录，
  和不写这段代码等价。2026-08-08 在 `ImagePresetList.vue` 上逮到一次（C15 那句
  「缺少形态提示」因此在组件整个生命周期里是死的）。
- **同族的模块级非响应式缝还有两条**：`random-event-runtime.getRandomEventPack()` 与
  `engine-settings.getEngineSettings()`。2026-08-16 给 DebugPanel 加随机事件区块时踩到：
  它们同样要落 `ref`。**取快照写在 `<script setup>` 顶层同步调，别放 `onMounted`** ——
  onMounted 里改 ref 是下一拍才渲染，真机上首帧闪一下「未装载事件包」，而组件测试里
  `mount(...).text()` 是同步读的，读到的全是 ref 初值（症状：断言全红，但功能其实是对的，
  很容易误判成模块被加载了两份）。
- 测试里给 store 喂内容：先 `setContentRegistry({...})` **再** `useCreateStore()`。
  组件测试里 mock content-store 时**别把注册表 mock 成一开始就满的** —— 那样「组件等的
  是哪个 promise」这个问题根本没被问到，接错 promise 照样全绿。要留一个「加载门兑现后
  才灌值」的用例。相关：[[reactive-store-mock-vacuous]]
