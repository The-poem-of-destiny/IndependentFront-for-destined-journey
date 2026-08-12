# 地图系统 v1 实施编排（lean-delegation，2026-08-11）

> 设计真源：`docs/planning/2026-08-11-map-system-v1-integration.md`（ADR-31，14 条裁定）。
> 编排模式照 `2026-08-04-image-generation-implementation-plan.md` 先例：主会话只做
> 拆解/审阅/验收，实现全部由 Opus（medium effort）子代理完成；每任务带范围栅栏 +
> 验证命令 + ≤15 行回报契约。
>
> 三个仓：**app**（本工作树，走分支 + PR squash merge）、**map**（`E:\Projects\independentfront-map-system-design\sample-map`，本地提交）、**content**（`E:\Projects\fated_poem_independent_assets`，本地提交）。

## 波次总览

| 波   | 内容                              | 任务数 | 依赖      | 出口判据                                   |
| ---- | --------------------------------- | ------ | --------- | ------------------------------------------ |
| W0   | 编译管线（map 仓）+ 占位包（app） | 2      | —         | 真实 mapdata 编译全绿出包；占位包过 coerce |
| W1   | 引擎五模块 + 测试（app）          | 5      | W0 schema | `npm run typecheck` + 新增测试全绿         |
| W2   | 接线：状态钩子/EJS/占位符/注册表  | 4      | W1        | 链路测试绿（set_location → lastTileId 等） |
| W3   | UI 势力地图页签（app）            | 2      | W1(+W2)   | 组件测试绿 + 手动构建通过                  |
| W4   | 真实包落内容仓 + 标定 + 真机走查  | 3      | W0-W3     | 校准断言绿；浏览器走查通过；全量测试套件绿 |
| 收尾 | PR + squash merge + CI 确认       | —      | W0-W4     | master CI 绿                               |

## W0 — 编译管线与数据

- **T0.1 `compile-map-pack.mjs`**（map 仓）：读 `mapdata/` 六件套 + `provinces.png`
  （Node 侧最小 PNG 解码器，`node:zlib`，仓例零 npm 依赖）→ 复用 `mapdata.js` 的
  `parse*` / `indexPixels` / `pixelAdjacency` → 产 `map-pack.json`（§4 schema：tiles /
  adjacency / straits / travelRules 默认表 / climates（可选 seed 文件，缺省单一温带档）/
  placeBindings（MARKERS 位置→地块 + 中层锚地块）/ contentHash / kmPerPx 暂用常量）。
  连带修 `titles.txt:802` 的 `b_0 → province=0` 数据缺陷；校验任一 error 拒绝出包，
  「绑定保留 id」升级为 error。`--out <路径>` 直写内容仓。
- **T0.2 占位包**（app 仓）：`public/data/content/map-pack.json` 中立合成小包
  （约 12 块：两国 + 无主 + 海带 + 湖 + 不可通行山脊 + 海峡；照 locations.json 占位先例，
  零真实地名）。引擎测试用的 fixture pack 由 W1 各测试文件内联，不引用这份。

## W1 — 引擎五模块（全纯函数叶，接 §5/§6/§7 设计）

- **T1.1 `types-map.ts` + `map-pack.ts`**：类型分册 + `coerceMapPack` 容错解析
  （永不抛，坏条目跳过、坏包回退占位，先例 `image-dialect.ts`）。
- **T1.2 `map-index.ts`**：索引 + `resolveTileByLocation`（落位契约五条 + 锚地块）。
- **T1.3 `map-path.ts`**：混合通行图 Dijkstra + `via`/`avoid` + `MapRoute`；
  退役 `TravelResult`（types.ts:3638，零使用）。
- **T1.4 `map-weather.ts`**：`weatherAt` 加权采样（种子随机照 `ejs-rng`，无枚举，词汇随包）。
- **T1.5 `map-context.ts`**：MAP_CONTEXT 四类行渲染 + `runtime_geo_compact_data` 投影
  （uid 446 契约：places/edges/segments）+ `$map` 数据形状。
- 横切：**结构闸门测试**（`map-*.ts` 禁中文字面量，先例 start-catalog-mechanics 黑名单）
  - 性质测试（不穿 impassable/lake、水段岸接、via 序、幂等、coerce 不抛）。
- 并行策略：T1.1 先行（一个代理），落地后 T1.2-T1.5 四代理并行（共享 T1.1 的类型与
  内联 fixture 约定）。

## W2 — 接线（全是既有缝）

- **T2.1 状态钩子**：`applySetLocation`（仅玩家落位 → `worldFlags.map`，packVersion 自愈）
  - `applyTimeAdvance` 跨天天气重断言 + 提交后胶水（`sys.旅行目的地` → journey 旗）。
- **T2.2 EJS/天气供值**：`buildStatData` / `buildCapabilityInput` 补传 weather（两处既有漂移）
  - `$map` 只读 namespace + `runtime_geo_compact_data` 经 local 供给。
- **T2.3 占位符与模板**：`{{MAP_CONTEXT}}`（placeholder-registry + placeholder-catalog 两处）
  - dispatcher 模板加块 + 教写 `sys.旅行目的地`（`data/defaults/agent-config.json`，
    🔴 改完必跑编码三判据）。
- **T2.4 内容注册表**：`content-store.ts` 第 8 面 `mapPack`（面/占位/包段映射三处）。
- 横切：链路测试 `commitChatState(set_location)` → `lastTileId`（blurByDefault 教训：
  单模块测试证明不了有人供值）。

## W3 — UI 势力地图页签

- **T3.1 渲染核**：MapPanel 新页签，自包含移植 sample 栈（平移缩放 / provinces.png 运行时
  解码 idBuf / 整幅半透明着色 / RDP 边界线 / hover 命中），contentHash 键控缓存，
  关 Modal 释放。
- **T3.2 交互**：信息卡（名/国/中层/地形/天气/通行性）+ 玩家地块高亮 + 路线预览
  （findPath + via/avoid 点选）+ 「出发」注入旅行指令 + journey 展示 +
  顺手修 `schedulePersist` 空壳 bug（标记编辑不落库）。
- 组件测试 + `?raw` 源文断言（禁静态 data/ 导入等既有先例）。

## W4 — 真实数据与真机

- **T4.1 真实包**：`compile-map-pack.mjs --out` 进内容仓 + 气候 seed 初稿（诺斯加德按
  世界书细档，其余按势力一句话档）+ kmPerPx 最小二乘标定（8 组城际天数）+ 内容仓
  校准断言测试（±30%）。
- **T4.2 story 侧世界书条目**：内容仓 `extra_setting` 新增 constant EJS 条目渲染
  MAP_CONTEXT（读 `$map`）；uid 446 供数联调。🔴 编码三判据。
- **T4.3 真机走查**（主会话亲自做，Browser pane）：dev server + `POEM_CONTENT_DIR` →
  地图页签渲染/hover/点击/路线/出发 → developer mode 看 dispatcher 提示词里的
  MAP_CONTEXT → 叙事移动一回合看落位。发现缺陷按 debug loop 修（子代理）。

## 收尾

全量 `npm run typecheck` + `npm run test -- --run` + `npm run lint` → push → PR →
squash merge（主人已授权：「提交」= 免 review 直接合并）→ **确认 master CI 绿** →
map 仓与 content 仓本地提交收尾 → 按主人指令关机。

## 实际执行情况（2026-08-12 收口）

> 照 image-generation 先例，此节记录实际怎么跑的与计划的偏差。

**实际波次**：W0(2) → W1(5，T1.1 先行后四路并行) → [T2.1 单飞 ∥ T4.1] → [T2.2/T2.3/T2.4 三路并行]
→ [W3 单代理合并 T3.1+T3.2 ∥ T4.2] → 颜色烘入补丁 → T4.3 主会话真机走查。
共 14 个实现代理加 4 次原代理续跑（SendMessage 热续），与计划的 16 任务口径基本一致。

**与计划的偏差（每条一行，理由已在正文相应处）**：

1. **自愈戳 version → contentHash**（T0.1 发现语义歧义：手动碰版的 semver 不随图变；
   `MapSaveFlags.packVersion` 改名 `packStamp`）。
2. **地形系数/费率从引擎常量迁入 pack `travelRules`**（§12-14 追加需求「换图零改码」翻案 §12-11）。
3. **锚地块优先可通行块**（照字面「最大块」会把 7 个域的锚放到不可通行块上）。
4. **代理类型中途换轨**：前半用项目 `code-writer` 定义，主人裁定它是给 DeepSeek 类工具的
   且不钉 medium effort（撞了一次会话额度上限）；后半改默认 `claude` 类型 + opus + 紧验证 brief。
5. **T4.1 的「前任死于勘察期」前提是错的**——前任已完成并本地提交，新代理逐项核验后原样保留
   （重编译字节一致 / 代价模型与 app 逐函数一致 / 世界书引文原文核对）。
6. **标定诚实降级**：12 组城际单标量只能 5 组 ±30%（逐对最优 k 跨 12.7 倍）；
   最差对（渡鸦港→银帆城 +329%）是 mapdata 没画直连海路的数据缺口，非代码问题。
7. **uid 446 原是 `enabled: false`**（设计假设它活着）——引擎供数后点亮（内容仓 ad7804b）。
8. **世界书可见性按书不按条目**：uid 510 会溢出到 vars_update/craft_gen 等的提示词，
   §12-9「vars_update 不注入」在世界书通道上做不到条目级；v1 接受（token 经济裁定非安全裁定），
   不为此造条目级过滤器。
9. **pack 补烘每地块 RGB**（W3 发现 UI 重算工具链色哈希是静默错块的隐患；颜色现随包权威下发）。
10. **真机走查修了两处**：dev overlay 中间件按 UTF-8 读二进制毁掉 provinces.png
    （vite.config.ts 改按 Buffer + 扩展名 MIME）；新档 `lastTileId` 未设时地图锁死
    （MapPoliticalTab 补只读显示落位，零写入）。
11. **story 侧世界书条目措辞刻意省略季节**（引擎的具名月表不存在，内容侧不复制引擎季节桶表
    避免漂移面；dispatcher 侧渲染器带季节）。

**留给后续的口子**（都已在正文/CHANGELOG 记录）：真实 AI 轮次未真机（无 key）；
mapdata 数据侧待补（渡鸦港-银帆城海路、时钟塔城/诺瓦·瓦伦蒂亚城两个绑定缺口、
lake #137 地形、8 个零地块中层、森林/湿地被建成墙的 44 块）；`DEFAULT_KM_PER_PX`
仍是 0.7（裸重编译会出未标定包，verify-map-pack 棘轮会拦）；面板 QuickJS wasm
装载失败是内嵌浏览器限制，真浏览器无此问题（fail-closed 行为符合设计）。
