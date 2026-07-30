---
name: blob-uint8array-typecheck-trap
description: new Blob([someUint8Array]) 在本仓库 tsc 下报 BlobPart 不兼容；测试跑得过、typecheck 挂
metadata:
  type: feedback
---

`new Blob([bytes])` 里 `bytes` 是**变量**（声明类型 `Uint8Array`）时，本仓库的 tsc 会报
`Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'BlobPart'`。字面量
`new Blob([new Uint8Array([1,2,3])])` 不报（推断成 `Uint8Array<ArrayBuffer>`）。

**Why:** TS 5.7+ 给 TypedArray 加了 buffer 泛型参数，`ArrayBufferLike` 含 `SharedArrayBuffer`，
而 `BlobPart` 只收 `ArrayBufferView<ArrayBuffer>`。**vitest 跑得过，只有 tsc 会红** ——
所以写完测试不跑 typecheck 就发现不了。

**How to apply:** 写成 `new Blob([bytes.slice().buffer as ArrayBuffer], { type })`。
`asset-store.ts` 的 `makeBlob()` 就是这个写法（它的 `.slice()` 另有"复制独立缓冲区"的理由，
两个理由刚好同一行解决）。测试里重复出现就抽个本地 `blobOf(bytes, type)` helper。

相关: [[typecheck-skips-vue-sfc]]（另一条"测试绿了不等于类型对了"）
