---
name: vtu-body-clear-kills-stale-wrappers
description: 组件测试里 `document.body.innerHTML = ''` 会炸掉前面用例遗留的 wrapper —— 只在文件开了 enableAutoUnmount 时才安全
metadata:
  type: feedback
---

在**没有** `enableAutoUnmount(afterEach)` 的组件测试文件里，绝不要写
`document.body.innerHTML = ''` 做清场；改成 `wrapper.unmount()`（Teleport 的内容跟着走）
+ 按需 `document.body.style.overflow = ''`。

**Why:** VTU 2 的 `mount()` 把宿主 div 挂在 `document.body` 上，而这些文件通常共享一个
模块级 `reactive` 假 store（见 [[reactive-store-mock-vacuous]]）。清空 body 等于抽掉**前面
每一个还没卸载的 wrapper** 的宿主节点；下一个 `beforeEach` 一改假 store 的数据，那些
wrapper 就会重渲染并以 `TypeError: Cannot read properties of null (reading 'insertBefore')`
炸出来。症状很有欺骗性：**测试全绿**（41 passed），只在结尾多出一段 "Errors 6 errors /
Unhandled Rejection"，而且报错指向的是**后面**那几个用例的名字，不是真正肇事的那一个。

`GamePage.test.ts` 里同样的写法没事，因为那个文件开了 `enableAutoUnmount(afterEach)`。

**第二种症状（2026-08-08，更阴）：不是报错，是数据串场。** 同一条件下，`beforeEach` 里
「清空再重填共享 mockSettings」会**叫醒**所有遗留 wrapper 重渲染，副作用落进下一个用例的
断言 —— `ImageSection.test.ts` 表现为「本用例只写了两条预设，列表里冒出上一个用例的第三条」，
外加两条无关的 `.session-bar` / 删除断言变红。**这条脆弱性可以潜伏很久**：只要没有任何子
组件订阅那份共享设置，就没人会被叫醒。给 `ImagePresetList` 加了一个读 `settings` 的
computed 之后它才变成三条红 —— 于是看上去像是新代码的锅，其实是测试文件缺
`enableAutoUnmount`。**诊断姿势**：把新组件对共享 reactive mock 的依赖临时换成常量，
红转绿就实锤是这个坑，别去改新代码。

**How to apply:** 写涉及 Teleport（`AppModal` / Toast / 抽屉）的组件测试、需要去
`document.body` 里查断言时。先看文件头有没有 `enableAutoUnmount`；没有就只 unmount 自己。
