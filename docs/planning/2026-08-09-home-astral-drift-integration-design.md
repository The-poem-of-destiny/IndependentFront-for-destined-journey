# 首页 Astral Drift 集成设计 v1.0 —— three.js 背景层 + 主题化取景

> 状态：**取景与降级已定稿；light 主题的处理仍在评审中，未实施**。
> 日期：2026-08-09
>
> 🔴 **D6（light 主题反相成纸上刻印）尚未获准**。原型已证明它技术上成立、也确实好看，
> 但主人 2026-08-09 明确表示对这个处理有保留。**不要照 D6 动工** —— 它是目前唯一的候选
> 方案，不是已定的方案。其余决策（D1-D5、D7-D14）不依赖 D6 的结论：真要换掉，改的是
> grade pass 里 chart 那一个分支，取景、懒加载、降级矩阵、安全区一条都不用动。
> 备选方向见 §5.5。
> 原型：`src/ui/components/home/AstralDriftHome.standalone.html`（可直接双击打开，HUD 里全部旋钮可调）
> 场景来源：同目录 `AstralDriftV2.standalone.html`（未改动，仍是场景的真源）
> ADR 关联：ADR-21（StateManager 唯一写入口，本文不碰状态）· Q-18（设置项要改两处）· 内容-引擎分离（§2 D10）

---

## 0. 范围与验收

### 0.1 一句话

把 Astral Drift v2 变成**首页的背景层**：星系让开左侧、UI 仍是 DOM、十套主题各自成立、
拿不到 WebGL 或用户开了减动效时**干净地退回现在这版 CSS 首页**。

### 0.2 不在范围内

- 不动 `AstralDriftV2.standalone.html`（它是场景真源，本次只读不写）
- 不改捏人页 / 游戏页 / 任何引擎侧代码
- 不做「开场镜头推进」的转场（原型 E 方案，留待 v2）
- 不做 portrait 下的 flank arc 方案（见 §5 已知缺口）

### 0.3 验收标准（做完 = 这十二条全成立）

1. 首屏**不因为这个功能变慢**：`three` 不进主 chunk，首次绘制仍是现在的 CSS 首页
2. 场景加载完成后淡入，中途不闪、不跳、不改变任何 DOM 的位置
3. 十套主题逐个切过去，**每一套都能读清标题、正文与全部五个按钮**
4. 五套 light 主题走 chart（墨-纸反相），五套 dark 主题走 astral（口音染色）——判据取
   `THEME_LIST[].type`，不是背景色亮度
5. 主题切换即时生效，不重建场景、不重载页面
6. `prefers-reduced-motion` 或应用内减动效开关任一为真 → **不加载 three**，退回 CSS 首页
7. 无 WebGL2 / `createContext` 失败 / context lost → 同上，且不抛未捕获异常
8. 标签页隐藏时暂停渲染循环，切回来恢复（不靠 rAF 自己停——它在某些环境不停）
9. 从首页离开（进游戏页 / 捏人页）时销毁场景，WebGL context 归还
10. 竖屏（aspect < 1.15）下 UI 上移、星盘下压，五个按钮全部不压在盘面亮处
11. 首页仍然**零 IP 文本**：标题 / 副标题 / 风味文字全部来自 `branding`，场景本身不含任何世界观文案
12. 四闸门全绿：`typecheck` / `test` / `lint` / `knip:ratchet`

---

## 1. 现状与约束（实测，不是估计）

### 1.1 取景冲突

在 1440×900 实测 v2 的原始构图：

|          | 可安全放文字的暗区 | 最亮点                 | 最忙的带                      |
| -------- | ------------------ | ---------------------- | ----------------------------- |
| 1440×900 | 顶部 **0–18%**     | 白热核心 **50% / 50%** | 弧线 + 符文，**62–78%**，通栏 |
| 414×896  | 顶部 **0–20%**     | 核心 **52%**           | 25% 以下全是亮的              |

v2 文件头注释写的是「顶部三分之一刻意留暗给文案」——**在 16:10 实际只有五分之一**。
而 `HomePage.vue` 的 `.title-section` 在 `margin-top: 32vh`、按钮列从约 48vh 排到 85vh，
**两者正好压在核心与弧线上**。这就是本设计存在的全部理由。

### 1.2 主题矩阵

`THEME_LIST`（`src/ui/stores/theme-store.ts`）带 `type: 'warm' | 'dark' | 'light'` 字段，
十套里 **五套是浅色底**（parchment / indigo / ivory / misty-lilac / forest）。
一个近黑的星系放在 远行者舆图 或 青花瓷 下面是硬冲突，这是必须解决的问题而非可接受的取舍。

### 1.3 依赖现状

- `three` **当前不是依赖**。应用里唯一的 WebGL 消费者是 OpenSeadragon（地图），
  两个 context 并存没有问题（浏览器上限约 16 个）。
- 加 `three` + `examples/jsm` 里用到的四个 pass，压缩后约 **150–170KB gzip**。
  这是本设计里唯一一笔真金白银的成本，D2 就是为它设计的。

### 1.4 原型已经证明可行的三件事

1. **偏心取景成立**：盘面右移后左三分之一是干净深空，标题与按钮列完全可读
2. **十套主题一个 fragment 分支就够**：见 D5
3. **性能不是问题**：实测 **30 fps / 0.3 ms / 1 draw call / scale 1.75**（原型 HUD 读数）

---

## 2. 决策表

| #       | 决策             | 选择                                                                                                                                       | 理由                                                                                                                                                                          |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | 组件形态         | 新增 `AstralDriftBackdrop.vue`，**只做背景层**                                                                                             | UI 仍是 HomePage.vue 的 DOM。让 three 去画 DOM 是把可访问性、i18n、主题 token 全部重造一遍                                                                                    |
| **D2**  | 加载时机         | 首屏渲染现有 CSS 首页 → `requestIdleCallback` → 动态 `import()` 场景模块 → 就位后淡入                                                      | 首屏时间零回归。动态 import 天然分 chunk，不必配 `manualChunks`                                                                                                               |
| **D3**  | 依赖             | `three` 进 `dependencies`；post 处理用 `three/examples/jsm/...`（随包）                                                                    | 不引入第二个 post-processing 库                                                                                                                                               |
| **D4**  | 场景代码形态     | standalone 的 JS 原样搬进 `src/ui/components/home/drift/`，拆成 `scene.ts` / `layers/*.ts`，对外只导出 `createDriftScene(canvas, options)` | 保留 v2 全部注释——那些注释记的是「这么写不报错但是错的」，是本仓最贵的资产                                                                                                    |
| **D5**  | 主题实现         | **grade pass 一个分支**，不是十套 PALETTE                                                                                                  | 场景里几乎每个材质在 build 期就 `PALETTE.x.clone()`，真换色要遍历所有材质。两种模式：astral（三色 ramp 拉向主题口音，混在原图上，星系自己的色相行程保留）/ chart（墨-纸反相） |
| **D6**  | light 主题怎么画 | **把整帧反相成「纸上刻印」**：场景是黑底加色光，其亮度**本身就是一张墨density 图**，`paper - density * ink` 直接得到一张星图               | 一根几何体都不用改。这是黑星系能待在 青花瓷 下面的唯一原因                                                                                                                    |
| **D7**  | light/dark 判据  | `THEME_LIST[].type === 'light'`                                                                                                            | **不许**用背景色亮度反推。判据必须和设置页显示给用户的那个字段是同一个                                                                                                        |
| **D8**  | UI 安全区        | HomePage 用 CSS 变量声明列的位置（`--drift-column-center` / `--drift-column-width`），场景读它换算世界坐标                                 | 原型里 `centre = 0.191` 是量出来的硬编码。一旦有人改 `.ui` 的 padding，弧线就不再抱着列。变量化之后两边不会漂                                                                 |
| **D9**  | 降级             | 减动效 / 无 WebGL2 / context lost → **不加载或卸载，退回 CSS 首页**                                                                        | 首页必须在任何机器上能进游戏。背景是锦上添花，不是必需品                                                                                                                      |
| **D10** | 开关             | 设置页「外观主题」分区加一格「首页动态背景」（开 / 关，默认**开**）                                                                        | 与主题同区，因为它就是取景的一部分。Q-18：设置项要改 `settings-types` + 设置页两处                                                                                            |
| **D11** | 分辨率治理       | 保留 v2 的 governor（实测中位帧耗调 render scale）                                                                                         | 已验证有效，弱 GPU 自己降到能扛的分辨率                                                                                                                                       |
| **D12** | 生命周期         | 场景实例随 HomePage 组件生死；`visibilitychange` 暂停                                                                                      | 离开首页立刻还 context，别攒着                                                                                                                                                |
| **D13** | 竖屏             | 列上移到顶部安全带、盘面下压 16%、flank 弧线隐藏                                                                                           | 竖屏没有「左三分之一」。这是**搁置**不是解决，见 §5                                                                                                                           |
| **D14** | 内容合规         | 场景内**零 IP 文本**；符文是程序生成的抽象字形，不是可读文字                                                                               | 内容-引擎分离：公开仓不得内嵌世界观内容                                                                                                                                       |

---

## 3. 文件面

```
src/ui/components/home/
├── HomePage.vue                     # 改：挂载 backdrop + 声明安全区 CSS 变量 + 降级态
├── AstralDriftBackdrop.vue          # 新：懒加载壳 + 生命周期 + 降级判定（不含场景代码）
└── drift/                           # 新：场景本体（从 standalone 搬运）
    ├── index.ts                     #   createDriftScene(canvas, options) —— 唯一出口
    ├── scene.ts                     #   renderer / composer / governor / 帧循环
    ├── layout.ts                    #   安全区 → 世界坐标换算（viewSize / worldX / placeLayout）
    ├── theme.ts                     #   ThemeSurface：主题 → grade uniforms
    ├── passes/mip-bloom.ts
    ├── passes/grade.ts              #   astral / chart 双模式 fragment
    └── layers/{galaxy,runes,arcs,veils,stars,dust,meteors}.ts

src/ui/stores/settings-types.ts      # 改：homeBackdrop 开关
src/ui/components/settings/SettingsPage.vue  # 改：外观主题分区加一格

tests/ui/home-backdrop.test.ts       # 新：降级矩阵 + 主题判据 + 安全区换算
tests/ui/home-backdrop-wiring.test.ts# 新：链路测试（见 §4 T6 那条教训）
```

---

## 4. 实施波次

> 模式与图像 v2 一致：主会话 grounding / 编排 / 审查，实现交子代理。
> 同一波内任务文件面互不相交。

```
波 0  scout   —— 确认 vite 动态 import 分块产物、settings 加项的两处准确位置
波 1  T1      —— three 入包 + drift/ 目录搬运（纯搬运，行为零变化，先能跑起来）
波 2  T2 ∥ T3 —— layout.ts 安全区换算 ∥ theme.ts 主题桥（两者互不相交）
波 3  T4      —— AstralDriftBackdrop.vue：懒加载 / 降级 / 生命周期
波 4  T5      —— HomePage 接线 + 设置开关（依赖 T4 的组件契约）
波 5  T6      —— 测试 + 四闸门 + 真机走查
```

### T1 搬运（波 1）

standalone 的 `<script type="module">` 拆进 `drift/`。**这一步不许顺手优化**——
只做「把函数搬进文件、补类型、导出」。任何行为改动都必须是后续任务的显式内容，
否则出了问题分不清是搬运带的还是改动带的。

搬运后立刻验证：`createDriftScene` 在一个空白页里能画出和 standalone 一样的帧。

### T2 安全区（波 2）

把原型里的 `centre = 0.191` / `spread` 换成读 CSS 变量。HomePage 声明：

```css
.home-page {
  --drift-column-center: 0.191; /* 列中心，占帧宽比例 */
  --drift-column-width: 0.242; /* 列宽，占帧宽比例 */
}
```

场景 `placeLayout()` 读 `getComputedStyle` 拿到这两个值再换算世界坐标。

**这里有一个原型已经踩过的坑，必须原样带过去**：换算用的相机距离要取
`CAMERA_BASE.z`，**不能取 `camera.position.z`**。`placeLayout()` 由 `resize()`
在启动时调用，那时 `animate()` 还没跑过、相机还在原点，取实时值会让所有距离小 5 倍，
弧线直接飞到画面中央。而且相机每帧 dolly ±0.85，取实时值会让弧线相对 DOM 列呼吸。

### T3 主题桥（波 2）

`ThemeSurface.apply(themeId)` → 写 grade pass 的
`uInk` / `uThemeMix` / `uInkGain` / `uAccent` / `uField` / `uPaper` / `uInkColor`。

口音色从**主题 CSS 的 `--theme-primary` 实际取值**来，不要在 TS 里再抄一份十六进制——
抄一份就是第二套默认值，两处漂移之后没人说得清屏幕上那个颜色是从哪来的
（与 `branding` 那条「不留硬编码文案兜底」同一个理由）。

chart 模式的两条实施注意，都是原型上撞出来的：

1. **先 tone map 再算 density**。composer 目标是 half-float，星系核心远超 1.0，
   那里的 chroma 极大，直接减会把全帧最亮的像素翻成它的补色——核心变成一坨饱和蓝，
   即「照片负片」，恰恰是这个模式最不该像的东西。用 `color / (1 + color)` 先压到 SDR。
2. **chroma 项要随 ink 趋满而淡出**，否则最浓的墨迹一直往补色漂。留在中间调的彩色晕
   才是想要的「套版印刷」感。

### T4 背景层组件（波 3）

```
mounted
  → 若 isReducedMotion() 或 settings.homeBackdrop === false → 什么都不做，保持 CSS 首页
  → 若无 WebGL2 → 同上
  → requestIdleCallback(() => import('./drift'))
  → createDriftScene(canvas, { theme, safeArea })
  → canvas opacity 0 → 1（400ms，reduced-motion 下直接 1）
unmounted / 离开首页
  → scene.dispose()：取消 rAF、释放 targets、几何体、材质、forceContextLoss()
visibilitychange
  → hidden 暂停帧循环，visible 恢复
webglcontextlost
  → 卸载并退回 CSS 首页，不抛
```

### T5 接线（波 4）

HomePage 挂 backdrop、声明安全区变量、按 backdrop 是否激活切换自身背景
（激活时不再画 `.bg-glow` / `.stars`，否则两层星星叠着）。设置页加开关。

### T6 测试（波 5）

- 降级矩阵：减动效 / 无 WebGL2 / 开关关闭 → **断言 `import()` 没有发生**
- 主题判据：十套主题逐个断言落在正确模式（用 `THEME_LIST` 驱动，新增主题自动纳入）
- 安全区换算：给定帧宽与 CSS 变量，断言世界坐标；含 `CAMERA_BASE.z` 那条回归
- **链路测试，不是组件测试**：图像 v1 的 `blurByDefault` 声明了却没人传值，
  整条功能是死的，而组件单测全绿——那种测试能证明逻辑对、**证明不了有人供值**。
  这里同形状的风险是「主题变了但 uniform 没人写」，所以要有一条从
  切换主题 → 断言 grade uniform 变化 的真链路测试。

---

## 5. 已知缺口（写下来，免得被当成做完了）

1. **竖屏是搁置不是解决**：列上移、盘面下压能用，但 flank 弧线直接隐藏了。
   竖屏值得一个自己的构图，v2 再做。
2. **bloom 仍按暗色盘调**：chart 模式下把 `bloom` 推高会糊成一片。
   要么给 chart 一个独立的 bloom strength，要么在 `applyTheme` 里按模式缩放。
3. **`warm` 类型没有主题使用**：`THEME_LIST` 的 type 联合里有 `'warm'`，当前十套没人用它。
   判据写成 `=== 'light'`，warm 会落进 astral。真出现 warm 主题时要重新裁定。
4. **首页仍是滚动容器**：`.home-page` 是 `overflow-y: auto`。canvas 用 `position: fixed`
   贴住视口即可，但内容超高时背景不跟着滚——需要真机确认观感。

### 5.5 🔴 light 主题的处理是**未决**项

D6 那个「整帧反相成纸上刻印」是原型里实际跑通的方案，也是目前唯一的候选，
但**没有获准**（主人 2026-08-09 表示有保留）。在裁定之前不要按它动工。

这件事之所以难，是因为它不是调参能解决的：这个场景的全部表现力来自**加色光打在黑底上**
（每一层都是 additive、depthTest 关掉的）。浅色底把这个前提整个抽走了——
不是「亮度调一调」，是这套画法在浅底上没有可用的形式。

已知的可选方向，按改动量排列：

1. **反相成纸上刻印**（D6，原型现状）。同一批几何体零改动，密度即墨色。
   优点是十套主题共用一条链路；风险是它把星系变成了**一张图**，
   气氛、景深、流动感基本消失——这大概正是保留意见的来源。
2. **light 主题不上背景**：五套浅色主题保持现在的 CSS 首页。
   最诚实、最便宜，代价是一半主题拿不到这块新屏。
3. **给 light 主题另做一套取景**：不是反相，而是换内容——
   例如浅底上的细线星图 / 罗盘刻度，几何体重画，additive 换成 multiply 或普通混合。
   表现力上限最高，工作量也最大（等于第二个场景）。
4. **背景与主题解耦**：动态背景恒为暗色，只在它上面盖一层主题色的半透明纸，
   UI 仍取主题 token。回避整个矩阵，代价是浅色主题的首页不再"浅"。

裁定之后要改的只有 `passes/grade.ts` 的 chart 分支与 `theme.ts` 的判据（方向 2、4 还会
碰 `AstralDriftBackdrop.vue` 的挂载条件）。取景、懒加载、降级、安全区都不受影响。

---

## 6. 成本

| 项       | 量                                                            |
| -------- | ------------------------------------------------------------- |
| 新增依赖 | `three`，约 150–170KB gzip，**不进首屏 chunk**                |
| 新增文件 | 约 12 个（场景拆分占 9 个）                                   |
| 改动文件 | 3 个（HomePage.vue / settings-types.ts / SettingsPage.vue）   |
| 运行时   | 实测 0.3 ms/帧、1 draw call、30 fps 上限；governor 兜底弱 GPU |
