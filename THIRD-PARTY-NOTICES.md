# 第三方字体与图标 —— 许可与署名

本仓库**自带并分发**下列字体与图标字体的二进制文件（`node_modules/@fontsource-variable/*`
与 `node_modules/@fortawesome/fontawesome-free`，构建时由 Vite 输出到 `dist/assets/`）。
四者的许可证全文随应用一起分发，位于 `public/licenses/`，在运行的应用里可通过
`/licenses/<文件名>` 直接访问；设置页「关于」分区也列出了同一份清单。

在 2026-08-05 之前，这些资源是从 Google Fonts 与 cdnjs **运行时加载**的。改为自托管的
理由见 `docs/design.md` §7.4「字体从哪来 —— 自托管，零外部请求」。

## 分发中的字体

| 字体                     | 版权方                     | 许可证                    | 许可证全文                                                                       |
| ------------------------ | -------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| Noto Sans SC (Variable)  | Google Inc.                | SIL Open Font License 1.1 | [`public/licenses/OFL-Noto-Sans-SC.txt`](public/licenses/OFL-Noto-Sans-SC.txt)   |
| Noto Serif SC (Variable) | Google Inc.                | SIL Open Font License 1.1 | [`public/licenses/OFL-Noto-Serif-SC.txt`](public/licenses/OFL-Noto-Serif-SC.txt) |
| Cinzel (Variable)        | The Cinzel Project Authors | SIL Open Font License 1.1 | [`public/licenses/OFL-Cinzel.txt`](public/licenses/OFL-Cinzel.txt)               |
| Font Awesome Free 6.7.2  | Fonticons, Inc.            | 见下（三段式）            | [`public/licenses/Font-Awesome-Free.txt`](public/licenses/Font-Awesome-Free.txt) |

### SIL OFL 1.1 —— 三条我们必须守的

1. **随分发附上版权声明与许可证全文。** 已办：`public/licenses/*.txt` 会原样进入 `dist/`
   （Vite 把 `public/` 逐字复制），所以任何拿到构建产物的人都同时拿到了许可证。
2. **不得单独售卖字体本身。** 字体只作为本应用的一部分分发。
3. **保留字体名（Reserved Font Name）**：上述三款**均未声明** RFN —— 各自 LICENSE 里
   第 33 行那句 `"Reserved Font Name" refers to …` 是 OFL 的**定义段落**，不是声明。
   （核对方式：OFL 的 RFN 要写在版权行之后、形如 `with Reserved Font Name X`；三份文件里都没有。）
   因此改名/改造也是允许的 —— 但我们两样都没做，原样分发。

### Font Awesome Free 6.7.2 —— 三种许可，署名是硬要求

| 部分                              | 许可证        | 我们的义务                                    |
| --------------------------------- | ------------- | --------------------------------------------- |
| 图标（本应用用到的 webfont 字形） | **CC BY 4.0** | **必须署名** —— 已在设置页「关于」分区标注    |
| 字体文件                          | SIL OFL 1.1   | 附许可证全文（同上）                          |
| CSS / JS 代码                     | MIT           | 保留版权声明（在 `Font-Awesome-Free.txt` 里） |

🔴 CC BY 4.0 的署名义务是**唯一一条要求界面上可见**的 —— 光把许可证文件放进 `dist/`
不够。署名写在 `AboutSection.vue`，删它之前先想清楚这一条。

只打包用到的两套：`fontawesome.css` + `solid.css` + `regular.css`（截至 2026-08-18 复核：
`src/` 下 `fa-solid` 237 处、`fa-regular` 4 处，数字仅作量级参考，会随 UI 变动）。
**不引 `brands.css`** —— 全仓零处使用，省掉 `fa-brands-400.woff2`。

## 刻意**没有**自托管的字体

CSS 里还出现下列字体名，它们**只是系统字体兜底**：本应用从不下载它们，用户机器上有就用、
没有就落到下一级。它们全部是专有字体，**打包进仓库会构成侵权**，所以只能这样引用：

| 字体                                        | 权利方                                | 用在哪                     |
| ------------------------------------------- | ------------------------------------- | -------------------------- |
| Monaco / Menlo                              | Apple                                 | 代码与正则展示区的等宽兜底 |
| Consolas / Courier New                      | Microsoft / Monotype                  | 同上                       |
| Palatino Linotype / Book Antiqua / Palatino | Monotype / Linotype                   | 首页英文副标               |
| KaiTi / STKaiti / 楷体                      | Microsoft・北大方正 / Apple・常州华文 | 首页风味引文               |

**按名字引用一款字体不是分发它**，所以现状合规；把这些 `.ttf` 放进仓库则不合规。
这条边界别越过去。

两款等宽字体（Cascadia Code、JetBrains Mono）其实是 OFL、可以自托管，但**目前也只是兜底**：
自托管它们等于新增一笔现在并不发生的下载，只为了让代码/正则面板在缺字体的机器上更统一。
要不要做是产品取舍，不是许可问题。
