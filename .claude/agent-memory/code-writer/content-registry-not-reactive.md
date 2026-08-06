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
- 测试里给 store 喂内容：先 `setContentRegistry({...})` **再** `useCreateStore()`。
  相关：[[reactive-store-mock-vacuous]]
