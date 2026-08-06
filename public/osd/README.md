# OpenSeadragon 控件图标（自托管）

这 40 个 PNG 是 OpenSeadragon 导航控件（缩放 / 复位 / 翻页 / 旋转 / 全屏）的按钮贴图，
从本仓已安装的 `openseadragon` npm 包 **原样复制**：

```
node_modules/openseadragon/build/openseadragon/images/*.png  →  public/osd/
```

## 为什么不用官方 CDN

`useMapViewer.ts` 曾经写着 `prefixUrl: 'https://openseadragon.github.io/openseadragon/images/'`。
那是一条**没人会发现失败**的外链：图挂了只是按钮变成空白方块，控件仍然可点，控制台不报错。
离线、CDN 故障、企业代理、大陆网络都会命中，而我们无从得知。

同样的理由已经让字体与图标（Noto / Font Awesome）改成自托管，这里是同一条纪律的第三处。
守门断言在 `tests/no-external-assets.test.ts`（扫 `src/**` 的 `https?://` 字面量白名单）。

## 升级 openseadragon 之后

包升级可能新增或改名贴图。重新执行上面那条复制即可（整目录覆盖，不要挑文件）。

## 许可

OpenSeadragon 使用 **BSD 3-Clause** 许可，许可证全文随 npm 包分发
（`node_modules/openseadragon/LICENSE.txt`）。这些贴图是该包的一部分，
与我们已经打包分发的 `openseadragon.js` 同一份许可，复制到 `public/` 不改变许可状态。
