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

**How to apply:** 写涉及 Teleport（`AppModal` / Toast / 抽屉）的组件测试、需要去
`document.body` 里查断言时。先看文件头有没有 `enableAutoUnmount`；没有就只 unmount 自己。
