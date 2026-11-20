# 第三方依赖 —— 许可与署名

本仓库**自带并分发**下列字体与图标字体的二进制文件（`node_modules/@fontsource-variable/*`
与 `node_modules/@fortawesome/fontawesome-free`，构建时由 Vite 输出到 `dist/assets/`）。
四者的许可证全文随应用一起分发，位于 `public/licenses/`，在运行的应用里可通过
`/licenses/<文件名>` 直接访问；首页「关于」弹窗（`AboutSection.vue`，由 `HomePage.vue` 原位打开）
列出了字体与图标这一份清单。下文「分发中的运行时库」里的 JS 库许可证全文也在同一目录，
但不在「关于」弹窗里列出（见该节说明）。

> 📌 2026-11-20 更正：本段原写「设置页「关于」分区」。「关于」早已改为首页弹窗，
> 组件仍住在 `src/ui/components/settings/AboutSection.vue`，但设置页不再挂它；
> 弹窗只列字体与 Font Awesome，不列 JS 运行时库。

在 2026-08-05 之前，这些资源是从 Google Fonts 与 cdnjs **运行时加载**的。改为自托管的
理由见 `docs/design.md` §7.4「字体从哪来 —— 自托管，零外部请求」。

## 分发中的运行时库

版本按 package-lock.json 2026-11-20 实测。

| 库                 | 版本    | 版权方                                                          | 许可证       | 许可证全文                                                                                                        |
| ------------------ | ------- | --------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| three.js           | 0.185.1 | three.js authors                                                | MIT          | [`public/licenses/three.txt`](public/licenses/three.txt)                                                          |
| Vue                | 3.5.38  | Yuxi (Evan) You                                                 | MIT          | [`public/licenses/vue.txt`](public/licenses/vue.txt)                                                              |
| Pinia              | 2.3.1   | Eduardo San Martin Morote                                       | MIT          | [`public/licenses/pinia.txt`](public/licenses/pinia.txt)                                                          |
| Dexie.js           | 4.4.3   | David Fahlander                                                 | Apache-2.0   | [`public/licenses/dexie.txt`](public/licenses/dexie.txt) + [`dexie-NOTICE.txt`](public/licenses/dexie-NOTICE.txt) |
| fflate             | 0.8.3   | Arjun Barrett                                                   | MIT          | [`public/licenses/fflate.txt`](public/licenses/fflate.txt)                                                        |
| OpenSeadragon      | 6.0.2   | CodePlex Foundation、OpenSeadragon contributors                 | BSD-3-Clause | [`public/licenses/openseadragon.txt`](public/licenses/openseadragon.txt)                                          |
| quickjs-emscripten | 0.32.0  | Jake Teton-Landis；QuickJS 引擎 Fabrice Bellard、Charlie Gordon | MIT          | [`public/licenses/quickjs-emscripten.txt`](public/licenses/quickjs-emscripten.txt)                                |

几条覆盖关系：

- `vue.txt` 同时覆盖打进产物的 `@vue/reactivity`、`@vue/runtime-core`、`@vue/runtime-dom`、`@vue/shared`
  （同版本、LICENSE 逐字相同）。
- `quickjs-emscripten.txt` 取自 `@jitl/quickjs-wasmfile-release-sync/LICENSE`，同时载有 quickjs-emscripten
  与 QuickJS 引擎两段声明；它覆盖 `quickjs-emscripten-core`、`@jitl/quickjs-ffi-types`（二者 LICENSE 与
  `quickjs-emscripten` 自身那份逐字相同，即本文件的第一段）以及四个 `@jitl/quickjs-wasmfile-*` 变体（四份 LICENSE 逐字相同）。
- `openseadragon.txt` 同时覆盖 `public/osd/` 下从该包原样复制的控件贴图（见 `public/osd/README.md`）。
- Dexie 是 Apache-2.0：随分发附许可证全文与上游 NOTICE 原文（`dexie-NOTICE.txt`），两样都已原样复制。

three.js 用于首页 Astral Drift 动态背景，并通过动态导入成为独立分块，不进入首屏主分块。
MIT、BSD-3-Clause、Apache-2.0 都不要求界面内可见署名（只要求随分发附上版权声明与许可证全文），
所以这些库不进「关于」弹窗；许可证全文随 `public/` 原样进入构建产物，运行时可经 `/licenses/<文件名>` 访问。

### 升级依赖之后

1. 重新 `cp` 上表各库的 LICENSE（及 Dexie 的 NOTICE）到 `public/licenses/`，**逐字复制，不要手改年份**；
   用 `diff --strip-trailing-cr <新文件> <源文件>` 确认为空。
2. 按 `package-lock.json` 更新上表的版本列与「实测」日期。
3. `npm run build` 之后从 sourcemap 重新导出实际打进产物的包清单，与上表对照，有新增的包就照同样方式补许可证：

```bash
node -e "const fs=require('fs'),d='dist-ui/assets',s=new Set();for(const f of fs.readdirSync(d))if(f.endsWith('.map'))for(const x of JSON.parse(fs.readFileSync(d+'/'+f,'utf8')).sources||[]){const i=x.lastIndexOf('node_modules/');if(i>=0){const p=x.slice(i+13).split('/');s.add(p[0][0]=='@'?p[0]+'/'+p[1]:p[0])}}console.log([...s].sort().join('\n'))"
```

2026-11-20 实测输出 16 个包：`@jitl/quickjs-ffi-types`、4 个 `@jitl/quickjs-wasmfile-*`、4 个 `@vue/*`、
`dexie`、`fflate`、`openseadragon`、`pinia`、`quickjs-emscripten`、`quickjs-emscripten-core`、`three`
—— 全部由上表覆盖。字体与 Font Awesome 走 CSS/字体资源，不出现在这份 JS 清单里，见下文。

## Windows 便携版额外分发的组件

便携版 zip（`npm run release:portable`，见 `docs/reference/portable-release.md`）除上面的前端资源外，
还分发一份 Node.js 运行时与打进本地服务器（`app/server.mjs`）的服务端依赖。许可证全文由打包脚本
放进 zip，不在本仓库里。

| 组件              | 版权方                           | 许可证                                    | 许可证全文（zip 内路径）                      |
| ----------------- | -------------------------------- | ----------------------------------------- | --------------------------------------------- |
| Node.js           | OpenJS Foundation 与 Node 贡献者 | MIT（另含所捆绑第三方组件各自的许可条款） | `runtime/NODE-LICENSE.txt`                    |
| hono              | Yusuke Wada 与 Hono 贡献者       | MIT                                       | `app/licenses/hono-LICENSE.txt`               |
| @hono/node-server | Yusuke Wada 与 Hono 贡献者       | MIT                                       | `app/licenses/@hono__node-server-LICENSE.txt` |

Node.js 的版本即打包机当时的 node 版本，记录在 zip 内 `app/build-info.json`；zip 内另有一份打包时生成的
`THIRD-PARTY-NOTICES.md`，按版本列出全部服务端与前端依赖。

前端（字体、图标、JS 运行时库）的许可证全文随前端构建产物进入 zip，位于 `app/web/licenses/`
（`public/licenses/` 经 Vite 原样复制进产物，打包脚本把整份产物放进 `app/web/`）。

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
| 图标（本应用用到的 webfont 字形） | **CC BY 4.0** | **必须署名** —— 已在首页「关于」弹窗标注      |
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
