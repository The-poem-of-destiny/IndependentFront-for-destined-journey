---
name: vite-define-two-traps
description: vitest 不共用 vite.config.ts，且 define 只替换裸标识符——两条都会让编译期注入静默失效
metadata:
  type: feedback
---

`define` 注入的编译期常量（如 `__ENGINE_VERSION__`）在本仓有**两个都不报错的失效点**：

1. **vitest 不共用 `vite.config.ts`** —— 根目录同时有 `vitest.config.ts`，它优先，
   `vite.config.ts` 的 `define` 在测试里一个字节都不生效。两处必须各写一份（值同源自
   `package.json`）。
2. **`define` 只替换裸标识符** —— 写成 `(globalThis as {...}).__X__` 那种成员访问，
   esbuild 一个字都不动。注入了也永远读到 `undefined`。

**Why:** T13 通电 `minEngineVersion` 版本门时两条全踩到。第 2 条是 T1 预留桩的原写法，
表现是「门看着接好了，实际恒 `skipped`」——没有任何东西会红。

**How to apply:** 加任何 `define` 常量时，(a) 两个 config 都加；(b) 读取用
`typeof __X__ === 'string' ? __X__ : undefined`，只把 `globalThis.__X__` 当**测试覆写**
通道（优先级高于 define）；(c) 写一条「define 真的落进测试运行时」的回归钉
（断言值存在且形状对），否则真正的业务断言红了也定位不到根因。
