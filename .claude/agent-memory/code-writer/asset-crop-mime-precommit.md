---
name: asset-crop-mime-precommit
description: 「预测的 ext/mime 别当记账依据」—— 素材裁剪落库曾用开裁前的 resolveOutputMime 预定值，画布不支持 webp 编码时写下假类型；2026-07-30 已修（producedAssetType 读产出 blob.type）
metadata:
  type: project
---

**已修（2026-07-30，素材审查轮）**。`asset-store.ts` 新增 `producedAssetType(blob)`，
`importPortraitPair` 写行时的 `mime`/`ext` 取自**画布产出的 Blob 自称的类型**；
`resolveOutputMime` 的预定值降级为**只给闸门预检用**（名字不合法时不该等字节都烘好
才发现），并在注释里明写「这只是预测，不是记账依据」。兜底是 PNG —— 规范给画布定的
默认就是 PNG，比"沿用预测"更可能为真。

**原缺陷**: 预定值一路传到 `writeIntoSlot`，从不读产出 `blob.type`。画布不支持
`image/webp` 编码的引擎（Firefox）会按规范静默吐 PNG 字节，于是库里出现
`mime: image/webp` / `ext: webp` **盖在 PNG 字节上**。渲染看不出来（浏览器嗅字节），
但导出文件名、再导入的路由、以及「ext 是权威」这条契约全在说谎，**要到用户把包带去
另一台机器才炸**。

**How to apply**: 这条的可迁移形式是 —— **一个"打算做什么"的值绝不能兼任"实际做了
什么"的记账依据**，哪怕两者几乎总是相等。同类嫌疑: 任何 `toBlob(type)` /
编码器 / 转码路径的返回值。`image-crop.ts` 早就为 gif/avif 讲过同一条理由
（「别记一个字节并不具备的类型」），只是当时没落到 webp 上。
参见 [[blob-uint8array-typecheck-trap]]。
