---
name: reactive-store-mock-vacuous
description: 组件测试里把 store mock 写成裸对象，会静默切断「落库后 UI 自己更新」这条响应式链，断言变成恒真/恒假
metadata:
  type: feedback
---

`vi.mock('../../stores/xxx-store', () => ({ useXxxStore: () => mockStore }))` 这种写法里，
**`mockStore` 必须用 `reactive({...})` 包一层**，只要被测组件（或它用的 composable）
是靠 store 数组的响应式来重渲染的。

**Why:** `useAssetImage` 的共享索引是 `computed(() => buildAssetIndex(source.assets))`。
裸对象的属性读取不进依赖收集，于是「挂载后往库里推一行 → 画像自己换过来」这类断言
在测试里**恒假**（一路绿是因为大多数用例在 mount 之前就把 assets 摆好了，从没验过更新）。
反过来，如果断言写成 `expect(...).toBe(false)` 之类，它会**恒真**地骗你。
audio-store / game-store 的同类 mock 有同一个坑。

**How to apply:** 写「导入/落库之后界面自己刷新」的用例时，
① mock 用 `reactive`；② mount 之后再 mutate（`mockStore.assets.push(...)`），
mount 之前摆数据的用例验不到这条链；③ 验一次非空转：临时把 `reactive` 去掉，
用例必须变红 —— 不变红说明断言根本没碰到响应式链。

相关: [[typecheck-skips-vue-sfc]]（.vue 的类型只有 vue-tsc 查得到，
本仓库没装，SFC 的正确性主要靠这类组件测试兜）。
