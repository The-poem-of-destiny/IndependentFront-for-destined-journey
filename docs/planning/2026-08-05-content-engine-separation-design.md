# 内容-引擎分离设计 v1.2 —— 开源净化与内容包体系

> 2026-08-05 起草，2026-08-06 定稿。为正式开源发布做准备：把《命定之诗》全部世界内容（世界书 /
> 真实提示词 / 预设 / 目录数据 / 参考语料）从引擎仓库中完全剥离。公开仓只带**演示级通用占位
> 内容**；真实内容由用户以**内容包（content pack）**形式导入，内容包由私有仓构建与分发。
>
> 研究基线：master @ `e53f8c0`（v1.0/v1.1 基于 `70bd93c`；其后 `972d5a2` 合入的
> **提示词更新中心**（`AgentUpdateCenter.vue` + `applyProjectDefaultToAgent`）正落在 D44 的
> 改造面上，已按新基线裁定；字体/许可 WIP 也已在 `e53f8c0` 提交——波 0 相应缩水）。
> 六份研究报告结论已并入本文，关键断言均带 file:line。
> **v1.1**：四路对抗评审报 4 blocker + 15 major，全部裁定改入。
> **v1.2**：二轮验证（对首轮修复的回归核查 + 独立通读）再报 4 blocker + 13 major，全部裁定
> 改入；两轮修订记录见 §11。
> 配套实施计划：`2026-08-05-content-engine-separation-implementation-plan.md`。

---

## 0. 范围与验收

### 0.1 目标状态（三仓拓扑）

```
公开引擎仓（全新建仓，改名，单次快照初始提交）
  src/ server/ tests/ scripts/ docs/(引擎部分) public/data/(占位内容)
  引擎开发主战场从此在这里。MIT + LICENSE 文件 + 上游署名。

私有内容仓（全新建仓，只装内容）
  data/worldbooks/ data/defaults/ …（🔴 目录形状与引擎的 /data/* URL 约定一致，D15）
  + 内容包构建器 + 内容 CI（编码门 / 全语料 EJS 门 / schema 校验 / 跨仓契约测试）
  产物：fated-poem-pack-<semver>.json（GitHub Release，走命定社区渠道分发）

本仓（IndependentFront-for-destined-journey）
  转私有，冻结归档。425 MB 完整历史 + reference/ 大语料的最终归宿。不再做任何开发。
```

### 0.2 验收标准（本轮做完 = 这十五条全成立）

1. 公开仓 `git ls-files` 全树无任何《命定之诗》**世界内容**：无世界书正文、无真实提示词、无预设、
   无目录数据（装备/物品/背景/命定核心）、无地图节点/标记 lore、无血脉描述、无 reference/ 语料、
   无真实对局衍生 fixture。📌 「命定之诗」作为**产品名引用**允许出现在声明过的白名单位置
   （内容态横幅文案、授权协议指针、README 提及、守门测试自身、packId）——守门规则见 D32。
2. 公开仓 `npm run build && npx vite preview` 零安装态可跑通演示环路
   （首页 → 捏人 → 进入游戏 → story 以通用叙事引导产出正文）。构建产物**自带占位内容**——
   今天「生产构建零内容且全静默」的潜伏缺陷（§1.1）一并闭合。🔴 preview 下 `/api/*` 今天
   404（BFF 全部注册在 `configureServer` dev 钩子里，无 `configurePreviewServer`）——D14 补
   一个 `configurePreviewServer` 分支挂同一个 `getRequestListener(buildHonoApp().fetch)`，
   否则本条无任何 D 决策交付。独立静态服务器（`server/` serve `dist-ui/`）仍不在本轮（§0.3）。
3. 应用有**显式内容态**：未装内容包时首页与设置页有可见提示；装包/更新/卸载有分节结果报告；
   内容加载失败进状态而不是静默（现状：6 处活跃 `/data/*` fetch + 1 处 `/audio/manifest.json`，
   其中 `game-pipeline.ts:730-742` 与 `beautifier.ts:96-97` 已有 warn，其余静默——census 见 §5.5）。
4. 用户在设置页导入 `fated-poem-pack-*.json` 后，应用行为与今日（内容内置时）等价：
   15 本世界书全量、13 个 agent 真实提示词、story 预设短路生效、捏人目录/地图/血脉/名字池全量。
   **首次安装不产生虚假冲突**（四态基线规则，D20）。
5. 「恢复默认」语义 = **已装内容包 > 内置占位**；导入真实包后任何 restore 都不会把真实提示词
   打回占位（§5.6）。
6. 内容包可**升级**（同 packId 比版本，diff 预览，hash 冲突两阶段确认）、可**卸载**（回落占位，
   agents 层零残留——按 §5.4 的 provider-owned 设计，卸载即删 pack 行，无需逆向清洗）。
7. 公开仓 CI 全绿。EJS 门构成 = `ejs-scrambled-corpus` + `ejs-backend-parity`（二者已存在、
   已跑去内容化语料）；**全语料门 `worldbook-ejs-corpus.test.ts` 整文件迁私有仓**（D29）。
8. 公开仓新增 `tests/no-world-content.test.ts` 门：世界专名词表 + 路径白名单 + 条目数阈值 +
   `reference/` 不存在（D32），并在**新仓首个 commit 上**跑过一次（不是只在本仓跑）。
9. 私有内容仓 CI 全绿：编码门（真实内容版）+ 全语料 EJS 门 + pack schema 校验 + 跨仓契约
   测试（clone 公开引擎，`POEM_PACK_FILE` 注入真实包跑引擎自带契约用例，D38）。
10. SiliconFlow API key 已轮换（历史里 `sk-ycsg…` tracked 三周；本仓**公开且有 4 fork** ——
    视为已泄露，立即执行，与其余工作无关）。
11. LICENSE 文件落地（MIT），tavernlike 上游署名补齐，README/PRODUCT/AGENTS 按引擎叙事重写，
    CONTRIBUTORS.md 记四位贡献者，THIRD-PARTY-NOTICES 扩展覆盖内容分发说明。
12. `package.json` 加 `"private": true` + `files` 白名单（`.npmignore` 今天不排除 `data/`，
    误 publish 即泄露——即刻关死，不等发布决策）。
13. 授权链五件事有明确处置记录（kitsch 预设 / BGM / 三方 regex / 贡献者签字 / 主创权利确认，
    D35）；未解决项不阻塞工程但**阻塞对应内容进包**。
14. 真机三走查通过：(a) 公开仓零安装态演示环路；(b) 导入真实包后的完整游玩链路；
    (c) **占位期建档 → 装包后旧存档仍可用**（uid 迁移，D43）。
15. 现存安装（四位贡献者/测试者）升级路径有明确行为：不静默降级，可见提示引导装包（§5.8）。

### 0.3 非目标（v1 明确不做）

- **不重写本仓 git 历史**（filter-repo 否决，D1）；不追讨已存在的 4 个 fork。
- **不做独立生产静态服务器**：`server/app.ts` 只挂 `/api/*`，无 serveStatic、无 start 脚本
  （验证过）。验收 #2 以 `vite preview` + dev BFF 为准；serveStatic 是发布后的独立小任务。
- **不改中文变量协议**：`stat_data.*`、`命运点数` 等键名是与 ST/MVU 内容格式的兼容契约
  （`namespace-normalizer.ts`），世界书 EJS 按名读取。文档标注为「协议词汇」。
- **不开放 WorldBookPartition 为 pack 声明式**：闭合联合（`types.ts:33-49`，📌 实为 **16**
  名——15 个内容分区 + `creative_workshop`；15 指的是 `BUILTIN_IDS`）v1 不动；真实包与占位包
  共用同一套分区名与书 id；**pack 校验器拒绝 `creative_workshop` 分区的书**（工坊分区是信任
  边界，不许 pack 染指）。
- **不做 npm publish**；不做自动同步镜像（每次提交重证「没漏」，永久成本，否决）。
- **不清洗 `docs/CHANGELOG.md` 历史条目**：只进私有归档，公开仓 CHANGELOG 从快照日重开。
- **GAME_EPOCH_YEAR（488）与 T1-T7 数值表保持引擎常量**（D6/D9）：纪元起点是全部游戏时间
  算术的原点（`time-system.ts:69` → `:167` `:194` 序列化枢轴），改它会重释一切既存存档时间戳。

---

## 1. 三个决定设计形状的结构性事实

### 1.1 `/data/*` 只存在于 dev server —— 生产构建今天就是「零内容态」

`vite.config.ts` 没有 `publicDir` 覆盖；`/data/*` 由手写 dev 中间件（约 43-63 行）从仓库
`data/` 目录读盘服务。`vite build` 产物 `dist-ui/` 里**没有 `data/`**（实measured），
`server/app.ts` 只挂 `/api/*`。于是生产构建的所有内容 fetch 全部 404，各调用点或静默或仅
console.warn（census 见 §5.5）。

**推论**：内容分离不是在替换一条生产内容链路，而是在填一个本来就存在的洞。占位内容 + 运行时
导入是**纯增量**，回归风险远低于预想。

### 1.2 内容装载已经是运行时 fetch —— 接缝早就存在

世界书（15 本 1.85 MB）、`agent-config.json`（413 KB，含 story 的 101 条目 / 85,563 字预设）、
`beautifier-rules.json`（396 KB）、`/audio/manifest.json` 都是运行时 fetch，不进 JS bundle。
占位换真实 = 换文件 + 换 Dexie 行，引擎代码近乎零改。

**绕过这条接缝的硬耦合**（build/test 时解析，必须逐个拆）：

| #   | 耦合                                                             | 位置                              | 后果                                 |
| --- | ---------------------------------------------------------------- | --------------------------------- | ------------------------------------ |
| 1   | `map-marker-presets.json` 静态 ESM import                        | `MapPanel.vue:25`                 | 删文件**直接 break build**           |
| 2   | `start-catalog-data.ts` 334 KB 目录数据编译进 bundle             | `start-catalog.ts:5` re-export    | 捏人页全部内容随 JS 分发             |
| 3   | `location-db.ts` / `bloodlines.ts` / `random-tables.ts` 数据常量 | 各文件                            | 地图/血脉/名字池随 JS 分发           |
| 4   | `beautifier-rules.json?raw`                                      | `beautifier-segments.test.ts:5`   | 测试硬依赖真实规则文件               |
| 5   | `public/audio/manifest.json?raw`                                 | `view-audio.test.ts:52`           | 同类（v1.1 评审补）                  |
| 6   | `import.meta.glob('../../data/worldbooks/*.json')`               | `worldbook-ejs-corpus.test.ts:34` | glob 落空**不报错**，`>400` 断言转红 |

### 1.3 每一个需要的机制都有已验证的先例

| 需要                                               | 先例                                                                         | 出处                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 「absent=别动 / []=清空 / rows=替换」三态分节导入  | FullBackup `doImportAllData`                                                 | `database.ts:762-909`（⚠️ 但 `lorebooks/presets/settings` 三张 v1-v3 老表**无三态护栏、无条件 clear**（`:771-776`）——D22 顺手补 presets 的护栏） |
| 纯 planner + 哑执行器 + 两阶段提交 + hash 冲突确认 | 工坊安装管线                                                                 | `workshop-install-plan.ts` / `workshop-store.ts`                                                                                                 |
| 三类处置记录（dropped/degraded/sideEffect）        | `WorkshopNote`                                                               | `workshop-types.ts`                                                                                                                              |
| 批量世界书写入唯一入口                             | `worldbook-store.upsertBooks`                                                | 工坊安装已在用                                                                                                                                   |
| 去内容化测试语料                                   | scrambled corpus + 生成器（自检门：混淆前后编译等价）                        | `tests/fixtures/ejs-scrambled-corpus.json` + `scripts/scramble-worldbook-ejs.mjs`                                                                |
| 「静默失败变断言」守门测试                         | `no-external-assets.test.ts`（WIP）                                          | 字体自托管工作，模式照抄                                                                                                                         |
| 二进制资产载体（音频走这条）                       | asset-zip 流式解包 + 限额 + 根 manifest（含逐轨 `tags`，`asset-zip.ts:417`） | `asset-zip.ts` / `asset-import-plan.ts`                                                                                                          |

**内容包 ≈ 一个本地安装的官方工坊项目 + agent 配置载荷**。不发明第二套机制。

---

## 2. 决策表

### 2.1 总路线（D1-D5）

| #   | 决策             | 裁定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 理由                                                                                                                                                                                                                       |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 公开仓怎么来     | **全新建仓，单次快照初始提交**；否决 git-filter-repo。🔴 **快照切法必须是 `git archive HEAD`（或 `git ls-files` 驱动的拷贝），绝不允许文件系统整目录拷贝** —— `.claude/worktrees/` 现挂着**两份完整工作副本（含全部世界书）**，且只被本机 `.git/info/exclude` 排除，不在版本化的 `.gitignore` 里；整目录拷贝会把全部内容提交进新公开仓。前置：把 `.claude/worktrees/` 提进 `.gitignore`（📌 `artifacts/`、`tmp/` 已在 ignore 里，v1.1 清单范围有误）；快照后在**新仓首个 commit 上**跑 D32 词表全树扫描 | 内容自项目第 4 天起入史（`reference/` @ `86ad48a`），358 commits 无干净前缀；内容渗进 docs/fixture/AGENTS.md 历史修订，rewrite **无法证明清干净**；.git 425 MB；历史里埋着「授权未定」BGM 与 live API key。快照 = 审一棵树 |
| D2  | 本仓归宿         | **转私有冻结归档**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 已公开 + 4 fork + 9 star——历史暴露已成事实，转私有止损不撤回。归档保完整历史与 PR 链                                                                                                                                       |
| D3  | 私有内容仓怎么来 | **全新私有仓**。世界书真源仍是 `The-poem-of-destiny/Worldbook-for-destined-journey`（已存在，私有），内容仓从它同步；✋ 主人也可裁定直接扩建该仓                                                                                                                                                                                                                                                                                                                                                        | 内容仓也要干净历史（泄露一次 ≠ 全泄露）                                                                                                                                                                                    |
| D4  | 公开仓名字       | ✋ 主人定；本文用占位 codename **`poem-engine`**。硬约束：不含 destined-journey / 命定之诗                                                                                                                                                                                                                                                                                                                                                                                                              | 仓名本身编码 IP                                                                                                                                                                                                            |
| D5  | SiliconFlow key  | **立即轮换**，先于一切                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `sk-ycsg…` 2026-07-09→07-30 tracked，≥10 commit 可读，公开 + 4 fork = 已泄露。`.env.local` 验证过从未 tracked                                                                                                              |

### 2.2 内容边界裁定（D6-D13）

| #   | 对象                                                                                          | 裁定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 理由                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D6  | T1-T7 数值表（`tier-constants.ts`）、`field-enums.ts`、战斗/制作公式、`GAME_EPOCH_YEAR`       | **引擎，留开源**（可调默认值）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 数字与公式是游戏平衡不是 lore；层级名/七级品质是中文 RPG 通用词汇；拿掉它们引擎「没有游戏」。`canBreakthrough` 报错文案里的「登神要素」一词中性化。**名单式扫描抓不到数值 lore**——写进 D32 门注释 |
| D7  | `stat_data.*` / `命运点数` 中文变量协议                                                       | **引擎，留开源**（协议词汇）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | EJS 按名读取；兼容契约                                                                                                                                                                            |
| D8  | `WorldBookPartition` 15 名闭合联合                                                            | **保留不动**（§0.3）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                 |
| D9  | era 与时间                                                                                    | era 默认值内容化：**save 创建时从 provider 取 era 盖章进 SaveProfile，此后只读存档、永不活读 pack**（否则卸包会追溯改名每个存档的历法）。`GAME_EPOCH_YEAR = 488` 保持引擎常量（时间算术原点，§0.3）。改点：`createDefaultTime(era)` 默认值、🔴 **`fromEpochMinutes()`（`time-system.ts:179-193`）—— era 在返回值里硬编码 `'复兴纪元'`，每次 epoch→GameTime 往返都会把盖章值冲掉**（v1.2 补，这是序列化枢轴的另一半：`era` 改由调用方从 SaveProfile 供给，或从派生 GameTime 中去掉 era 字段只在展示层拼接）、`create-store.ts:1010`（硬编码字面量）、`create-store.ts:1489`、`database.ts:1343`（同步调 `createDefaultTime()` 无参——era 作参数从 UI 层传入）。📌 残留字面量清理入 D33：`time-system.ts` 各注释/格式示例（`:66/:79/:98/:162`）、`stat-projection.ts:188`。📌 `time-system.test.ts:39-48` 断言默认 era + `year === 488`，改默认值时同改；其余显式传参用例不 churn。开场 prompt 的命定核心区块（`create-store.ts:1470-1530`）改为可选通用「起源印记」区块；PlotSection 五年模板（`:190-200`）通用化 | —                                                                                                                                                                                                 |
| D10 | `start-catalog-data.ts` 里的三方 franchise 背景（Overlord `:8195`、Fate `:8275`、HP `:8339`） | **不进任何 pack 构建**：构建器黑名单硬拦 + ✋ 主人单独处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 别人的 IP；私有分发同样是侵权风险                                                                                                                                                                 |
| D11 | `beautifier-rules.json`（22 条）+ `regex-remote-snapshot.json`（20 条）                       | **移私有仓**，pack 携带；公开仓自带 4-6 条**自写**演示规则                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 三方创作者作品（一条内嵌 Revue Starlight）；授权协议 §2 ⚠️ 明确排除工坊内容。授权问题单列 D35                                                                                                     |
| D12 | 音频                                                                                          | **内置曲库概念在公开仓退役**：占位 `public/audio/manifest.json = []`（保住 fetch 与空态）。真实音频**不进 JSON pack**——许可清了之后作为独立资产 zip 走既有 `importZip` 通道进用户曲库（Dexie；zip manifest 自带 `tags`，场景配乐照常工作——`audio-scene` 的定位链先从 location 字符串推导、location-db 只是补充，已验证）。真实 `manifest.json` 移私有仓存档。`audio-store.ts:57` 计入静默 census（§5.5）；`view-audio.test.ts:52` 的 `?raw` import 换合成 fixture（§7.1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 57 条全是 `"license": "PLACEHOLDER-PENDING-REVIEW"`；JSON base64 装字节已被否决三次                                                                                                               |
| D13 | kitsch/kemini 预设血统（授权协议 §5：「专用于《命定之诗》这张卡」）                           | 发布前需 kitsch **重新授权**或替换预设；未解决前构建器给 preset 节打 provenance 警示标记                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 独立前端 + 导入包是另一个载体；私有化不治愈授权缺口                                                                                                                                               |

### 2.3 引擎接缝（D14-D28 + D41-D45）

| #       | 决策                                                                                             | 裁定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D14+D15 | 占位内容位置与 dev overlay（一条规则，v1.1 合并消解矛盾）                                        | 占位内容 `data/` → **`public/data/`**（URL 一律不变 `/data/*`；Vite dev 原生服务 `public/`、build 自动拷贝进 `dist-ui/`）。**无条件读中间件删除**；改为**条件 overlay**：设置 `POEM_CONTENT_DIR` 时才注册 `/data/*` 中间件从该目录服务（📌 `configureServer` 注册的中间件先于 Vite 的 publicDir 静态处理——overlay 必然赢，这个次序是承重的，写进代码注释）；`PUT /api/worldbooks/:id` 与 `PUT /api/defaults/:name` 同样只在 `POEM_CONTENT_DIR` 设置时注册，写回该目录。🔴 **私有内容仓的创作树目录形状必须与 URL 约定一致**：`<POEM_CONTENT_DIR>/worldbooks/*.json` + `<POEM_CONTENT_DIR>/defaults/agent-config.json`（即私有仓顶层就叫 `data/`，overlay 指到 `data/`）——§3.1 布局以此为准，两处不许漂移。UI 侧「保存为默认」按钮在 overlay 未启用时**隐藏**——判定只用**编译期注入的 define 标志**（🔴 HTTP 探测被否决：`/api/defaults` 中间件对非 PUT/POST `next()` 落到 SPA fallback 返回 200 `index.html`，探测会**失败开**）。🔴 v1.2 补：同一插件加 **`configurePreviewServer`** 分支挂 `getRequestListener(buildHonoApp().fetch)`——否则 `vite preview` 下 `/api/*` 404，验收 #2 无人交付。`server.watch.ignored` 相应调整                                                                                                                                                                                                                                                                      |
| D16     | 内容装载收口                                                                                     | 新建 **ContentProvider**（`src/sillytavern/content-source.ts` 纯函数层 + `src/ui/stores/content-store.ts` 执行层）。**三处装载面 fetch** 改走 `loadProjectDefaults()`：`settings-store.ts:428`、`game-pipeline.ts:704`、`create-store.ts:970`。🔴 **`AgentConfigPanel.vue:135` 不迁**——它是「读-改-写回落盘」的读半边（`:133-144` 读全量 → `saveAgentProjectDefaults` PUT 整份），若走 pack 叠加层，一次「保存为默认」就把真实提示词写进公开仓占位文件，方向整个反了；它保持读原始盘上文件（provider 提供显式绕过 pack 的 `loadRawProjectDefaults()`），且随 D14+D15 的按钮隐藏一起失效。provider 对同步消费方提供**模块级注册表**（`setContentRegistry()`，boot/装包时由 content-store 灌注）：`random-tables` 名字池、`bloodlines`、`$location`（`location-db.ts:910-921` 冻结命名空间里烤死的 `DEFAULT_LOCATIONS`）、`agent-tools` 同步工具执行路径都读注册表。**时序契约**：`loadProjectDefaults()` await content-store 的模块级 ready promise（不是「挂进 App.vue init 链」——`settings-store` 构造器在 `main.ts:71`、`app.mount` 之前就 `setTimeout(0)` 触发装载，App.vue 链根本拦不住；ready promise 在模块加载时创建，谁先到都等它）。装载失败进 `contentStatus`                                                                                                                                                                                                                              |
| D17     | 内容包格式                                                                                       | 单 JSON `fated-poem-pack-<semver>.json`（~3.2 MB）。`formatVersion` 必读；分节全部可选，三态。schema 见 §4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D18     | 安装持久化                                                                                       | Dexie **v20** 新表 `contentPacks`（`packId` 主键；`packVersion / installedAt / payload(整包) / sectionHashes / notes`）。整包入库 → 恢复默认/卸载/升级 diff 不需要重新拿文件。**hash 分工（v1.2 明确）**：`sectionHashes`（每节一枚）只用于 D40 升级 diff 展示与快速比对；**冲突判定与对账用的逐书基线一律从 `payload` 现算**（per-item），两者不许混用。🔴 **contentPacks 不进 FullBackup**：payload 进备份 = 每份日常备份都是可自由转发的完整内容包 + 体积翻倍。备份/恢复一致性由**恢复后对账**解决：`importAllData` 完成后跑 `reconcilePackState()`——**范围限定 `{worldBooks, presets}`**（其余分节的真源就是 `contentPacks.payload` 本身，恢复动不到它们，无从失配），**逐 pack 拥有项比对**（pack 书 id → payload 现算 hash vs 恢复行 hash；用户自建书/工坊书不在比对域，用户对 pack 书的合法编辑也只标记该书而非整节）：有 pack 拥有项缺失或被替换 → `contentStatus = 'needs_attention'` + 用户二选（本地 payload 重放 / 卸载回占位），**不自动做任何一边**。`activePresetId` 悬空（旧备份清了 presets 表）→ 明确分支：从 `contentPacks.payload` 重导 story 预设。DataSection 文案写明排除。`DB_VERSION` 20 同步 bump（DB_VERSION ↔ 最后一个 `this.version(n)` 漂移教训）                                                                                                                                                                                                                      |
| D19     | 安装管线                                                                                         | 纯 planner `content-pack-plan.ts`（同步纯函数：`planPackInstall(pack, current, packBaseline, placeholderBaseline)` → `PackInstallPlan`，逐节 added/updated/removed/conflicted + **存档 uid 迁移步骤**（D43））+ 哑执行器（content-store）。执行器写入路径（v1.1 修订）：worldbooks → `upsertBooks`；presets → `savePreset` 按 pack id upsert；beautifier → **provider 内存层**（不是 `upsertRules`，见 D20）；agents → **只写 contentPacks + provider 缓存失效**（不写 `settings.agents`，见 §5.4）；catalog/locations/bloodlines/namePools/markers/branding → contentPacks 为真源 + 注册表灌注。两阶段提交 + `WorkshopNote` 报告；安装前 `exportAllData()` 快照，失败回滚                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D20     | 逐节冲突策略（v1.1 四态基线；v1.2 修基线来源与 preset 语义）                                     | worldbooks 按 `id` + 双基线 hash（逐书，从 payload/清单现算，见 D18）：① 有上次装包基线：现 hash = 基线 → 覆盖；≠ → 冲突确认。② **无装包基线（首次安装——主路径）**：现 hash = **占位基线 hash** → 未动过的占位书 → 静默覆盖；≠ → 冲突确认（覆盖既存测试者的真实编辑书前必须确认）。🔴 **占位基线来源 = 构建期生成、随引擎打包的占位 hash 清单**（`placeholder-hashes.json`，兼作 D42 重播种输入）——**不许运行时 fetch `/data/*` 现算**：一则 planner 是纯函数（D19，基线由调用方作参数传入；D38 契约测试无 HTTP 环境，用 `node:fs` 读盘供给），二则 `POEM_CONTENT_DIR` overlay 生效时 `/data/*` 服务的是**真实内容树**，现算会把作者刚编辑的真书误判成「未动过的占位」而静默覆盖。agents：无冲突概念（provider-owned，§5.4）。presets（v1.2 消歧）：**占位预设与 pack 预设用不同的固定 id**；pack 安装 = 按 pack `presetId` **整行 upsert**（不 mint 新 UUID，不适用 name-only sync——M5.1 只属于占位播种路径）；`activePresetId` 未设或指向占位预设 id 时切到 pack 预设，指向用户第三方预设时不动。beautifier：pack 规则走 provider 内存层（`presetRules` 语义，`isBuiltin: true`，参与 `builtinDisabled` 门控），**不写用户表**——卸载天然免费。📌 换规则集时既有 flip 清单（`beautifierBuiltinDisabled` 按 id 记翻转）中 id 不复存在的项**惰性无害**（读侧查无此 id 即忽略），不迁移只记 note。占位书与真实书共用同一套 15 个 id + `builtIn: true`（缺了被 `loadBuiltInWorldBooks` 真值门静默丢弃） |
| D21     | 「恢复默认」语义                                                                                 | 一切 restore 改走 ContentProvider：**已装 pack payload > 内置占位**。矩阵见 §5.6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D22     | presets 撤出 localStorage（v1.1 从「顺手收益」提级为**前置任务**）                               | `settings.presets` 镜像删除，Dexie `presets` 表唯一真源，`settings` 只留 `activePresetId`。这不是清理是**D19 的前置**：预设今天双写（写 Dexie、读 localStorage 镜像——`PresetManager.vue` 10 处读、`AgentConfigPanel.vue:58` computed、`settings-store.ts:459-472` 播种路径读写同一镜像），装包写 Dexie 而 UI 读镜像 = 装了看不见。同 PR 三件事：镜像删除（读侧全部改 Dexie+内存 ref）、`settings-store.ts:459-472`（M5.1 同步路径，D16 正在重写同一函数）、**`db.presets` 补三态护栏**。📌 护栏的作用域（v1.2 修正）：只保护**手编/裁剪过的备份**（字段缺失才跳过；本应用导出的备份**总是带 `presets` 字段**——`exportAllData` 恒发——所以「旧备份抹掉 pack 预设」的真正救济不是护栏而是 **D18 的 `reconcilePackState()` + activePresetId 悬空重导分支**）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D23     | 地图                                                                                             | `MapPanel.vue:25` 静态 import 改走 provider（空数组兜底）。`useMapViewer.ts:24,29` 的 `i.ibb.co` 热链删除，图源 URL 由 pack `branding.mapSources` 供给，公开仓默认空态。🔴 同文件 `:51` `prefixUrl: 'https://openseadragon.github.io/…/images/'` 是第三条外链（评审补获，no-external-assets 门现扫不到 `.ts`）——OSD 控件雪碧图自托管进 `public/`（或 `showNavigationControl: false`），并把 no-external-assets 门扩展到 `src/**` 的 `https?://` 白名单扫描                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D24     | 捏人目录（v1.1 修正切分线）                                                                      | 🔴 `start-catalog-data.ts` **不是纯数据文件**：`DIFFICULTY_PRESETS`（`:61`）、`GENDER_OPTIONS`（`:8549`）、`BACKGROUND_RESTRICTIONS`（`:8481`，空）是机制，先做**文件内切分**——新 `start-catalog-mechanics.ts` 收这三件 + 既有 `start-catalog.ts` 常量（`ATTRIBUTE_NAMES/RARITY_LABELS/QUALITY_COLORS/QUALITY_BASE_DC`）留引擎；七个池/表数组（装备/物品/技能池、背景、命定核心、种族/身份点数、起始地树）→ pack `catalog` 节。爆炸半径（v1.1 补全）：`create-store` 同步消费 `:204/:215/:347/:736/:746/:1846-1848` 全部转 ref + 加载态；**`CreateStepDifficulty.vue:16` 直接 import `DIFFICULTY_PRESETS`（不经 store）**——随机制文件留引擎，天然解耦；**`field-enums.test.ts:166-180` 动态 import 数据文件扫 rarity code（Q-11 防分叉门）**——改指占位目录 fixture，防 `codes.size > 0` 变空转。规模：**L，测试尾巴 XL**（`create-store.test.ts` ~25 处直接池引用）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D25     | location-db / bloodlines / random-tables（v1.1 拆三档如实计量）                                  | ① location：9 个查询函数已 `(nodes,…)` 参数式，默认值改注册表——**S**；但 `$location` 冻结命名空间烤死 `DEFAULT_LOCATIONS`（`:910-921`）与 `audio-scene.ts:151/343` 默认参一起改注册表读取。② bloodlines：**无注入缝**（`:148/153/160` 直读模块常量），加注册表缝 + `create-store.ts:207` 改点——**S**；占位集保同 id + 同 statModifiers；📌 `bloodlines.test.ts:51` **逐字断言 IP 描述**（『人形龙血传承者…』）——此测试既要改断言（shape 断言）也在 D33 中性化名单里（v1.0「测试零改动/全仓最便宜」的说法撤回）。③ random-tables：**无注入缝**（`:781/:795/:801/:810-815` 直读文件私有常量），且消费方是 **agent-tools 同步工具执行路径**（`agent-tools.ts:34` import，`:214-241` 工具注册）——注册表必须在任何 agent 执行前灌注完成（D16 时序契约覆盖）——**M**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D26     | 品牌面                                                                                           | `branding` 默认模块（中性应用名/副标题/credits/about）+ pack `branding` 节覆盖，运行时 `document.title`。改点清单：`index.html:6`、`HomePage.vue` 5 处、`AboutSection.vue` 3 处、`PlotSection.vue` 模板、`package.json` name/description、`dev.bat`/`update.bat` 横幅（ASCII 规矩）、`favicon.png` 换中性图、`variables.css:2` 注释、`agent-tools.ts:219` 工具描述、**`public/poem-ejs.d.ts`**（v1.1 补：文件头 + `:184` 的 `复兴纪元` 样例中性化，文件更名 `engine-ejs.d.ts` 并同步 `worldbook-ejs-regex-authoring-guide.md` 引用——它随 publicDir 进 dist，是面向创作者的公开工件）、`types.ts:2` 头注释。**引擎版本注入**（v1.1 新增，D40 的操作数）：`vite.config.ts` `define: { __ENGINE_VERSION__: JSON.stringify(pkg.version) }`，公开仓从快照起打 tag、动 `package.json.version`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D27     | 演示面                                                                                           | `test-save.ts` + `test-fixtures.ts`（生产模块，HomePage/GamePage 动态 import）重写中性**留公开仓**。`agent-templates.ts` stub 去 IP：`:393 :403 :411`（v1.1 补 `:411` vars_update 例子里的理查德×2）。`placeholder-registry.ts` 3 处词句去 IP（`:507` 已自带「区块为空以通用奇幻为准」降级指令）。🔴 story 无预设回退今天是一句话 + 3 行格式例——公开仓**新写**一份能用的通用叙事引导（占位预设 8-12 条目 + 回退 systemPrompt，输出契约 `<maintext>/<option>/<sum>/<vars>` 完整），占位内容里唯一真写作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D28     | 死代码清理                                                                                       | `item_gen_system_prompt.txt`（零引用）删；`worldbook-loader.ts::loadWorldBooks` + 重复 `WORLD_BOOK_FILES` 删，15 书清单唯一真源 `BUILTIN_IDS`；`preset-loader.ts` `PRESET_BASE` 死路径 + `data/presets/` 删；`.github/CODEOWNERS` 空匹配规则修正                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D41     | 工坊（v1.1 新增，替代「非目标」含糊态）                                                          | `WORKSHOP_API_BASE`（`workshop-client.ts:76` 硬编码 worker URL）改为配置：公开仓默认**未设置** → 工坊入口渲染「未配置社区源」空态；pack `branding.workshopApiBase` + 配套登录前提文案供真实值。理由：公开引擎带一个硬编码的命定工坊客户端 = 给任意用户一键安装授权协议 §2 ⚠️ 明确排除的三方二创内容，且 `failure-text.ts:37` 的 Discord 前提「中性化」后就变成假话——配置化两个都解                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D42     | 占位内容升级（v1.1 新增）                                                                        | `mergeBuiltIns` 是 id-presence-only、永不更新——占位书发一次错版对早期用户就是永久的。占位集带 `placeholderVersion` 戳（settings）；戳前进时对**hash 仍等于占位基线**（即用户没动过）的书重播种。复用 D20 的占位基线 hash 机制                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D43     | 存档 uid 迁移（v1.1 新增；v1.2 修迁移语义）                                                      | `enabledWorldBookEntries` 是**按 `partition:uid` 的允许清单**（`worldbook-loader.ts:185-190`「只保留 uid 命中条目，其余移除」；建档时 `create-store.ts:484-508` 钉 `system_core:<uid>` `character:<uid>`），占位书与真实书同分区不同 uid 空间 → 占位期建的存档在装包后核心分区被**静默滤成零条**。三段式：① 占位书 uid 用**保留段（900001+）**，与真实语料 uid 空间物理隔离（防「碰巧命中错误条目」；实测真实语料 max uid ≈ 509，工坊在自己分区从 0 分配，不撞）。② 迁移优先**按名配对**（🔴 v1.2：这是仓里已验证的先例——`workshop-install-plan.ts:12-23,73,137-138` 解决的就是「换掉分区条目而不打碎 allowlist」，按 name 配对、幸存者保 uid；此处 uid 必变，故配对产出 old→new 重写映射）。③ 配不上的键分两类处置：**单选钉选分区（`system_core`/`character`，建档单选写入）不许裸删**——裸删 = 该分区「整本原样通过」（`worldbook-loader.ts:187`），把玩家单选的一个命定核心炸成全书全部核心注入（内容通胀回归）；改为标记存档 `needs_selection`，UI 强制重选后写新键。多选分区的失配键才允许清除 + `WorkshopNote sideEffect`。同一 uid 机制也门控美化 auto-enable（`beautifier-store.ts:105-115`）——迁移后失效的 auto-enable 记 note。回归测试：占位建档 → 装包 → 断言 ①真实条目存活过滤 ②`system_core` 恰好单条（不是整本）（验收 #14c）                                                                                                                                                         |
| D44     | agents 层重设计（v1.1 新增；v1.2 大修——首版修复自身引入两处静默失内容路径，均已裁定，正文 §5.4） | pack 的 `agentDefaults` **永不写入 `settings.agents`**（v1.1 诊断不变：`fillMissingAgentSettings` 在启动过一次的安装上保证 no-op，且写入即无 provenance）。v1.2 修正四件：① **resolve 覆盖全部 12 键**（`model/worldBookEnabled/worldBookIds/systemPrompt/template/温度五参/maxTokens/historyLayers/historySlice`），改造点是**单一读取咽喉 `getAgentSettings`（`agent-settings.ts:104`）加默认层参数**，不是逐调用点打补丁——`worldBookEnabled/worldBookIds/model/数值参` 今天**只有** boot 播种在写（`game-pipeline.ts:507-508` 直读 settings，`agent-settings.ts:106-115` 硬兜底 `false/[]/''`），删播种不给默认层 = 全体 agent 静默失去世界书。② **名册迭代改源**：`listConfiguredAgents`/`updateAgentWorldBookIds`（`agent-settings.ts:252-276`）与工坊授权 `grantWorkshopBookToAgents`（`workshop-types.ts:438-443`）现按 `Object.keys(bag.agents)` 迭代——空覆写层会让工坊安装**授权给零个 agent**；改为迭代**解析名册**（默认层键 ∪ 覆写层键）。③ **precedence 是行为变更不是重构**：今天 `game-pipeline.ts:548` 是 `defaults                                                                                                                                                                                                                                                                                                                                                                  |     | settings`（**默认层优先**，覆写被无视；`:541` 又是第三种）——新 resolve 统一为**覆写 ?? 默认**，作为显式裁定记录。随之 v1.0「测试者九键保留视作覆写、无害」不成立（那会让 pack 后续版本永远够不到他们）：**一次性迁移变成必做**——引擎带**历史默认值指纹表（逐 agent 逐字段 SHA-256，私有构建生成，指纹不泄内容）**，首启时命中指纹的覆写键删除。④ **覆写制造面全列改造**：`saveAgentSettings`（`AgentConfigPanel.vue:102-105`，现整份落盘——改为与解析默认 diff，相等键删除）、`applyProjectDefaultToAgent`（`agent-settings.ts:184`，语义改「清覆写层」）、`resetAgentSettings`、**`AgentUpdateCenter.vue`**（`972d5a2`新增，本就为旧缺陷而生——重定位为「覆写层 vs 默认层」差异面板 + 「清除覆写」动作）。新增管线测试：空覆写层 + pack → story`worldBookIds` 非空 |
| D45     | 快照卫生（v1.1 新增，D1 的执行面）                                                               | 波 0 前置（📌 v1.2 核实：合并冲突与字体/许可 WIP 已在 `e53f8c0` 提交完成，此两项闭环；保留「本仓 CI 全绿」为每波出口条件）。`.claude/agent-memory/`（30 个 tracked 文件，含真实语料统计）、`.codex/`、`.impeccable/`（一处 `命定之诗与黄昏之歌` 字面量）、`.playbook/` **默认不进公开快照**，逐目录 review 后才放行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 2.4 测试与门（D29-D34）

| #   | 决策                          | 裁定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D29 | 语料门（v1.1 改裁定）         | **`worldbook-ejs-corpus.test.ts` 整文件迁私有仓**（含两条 golden + uid 全局唯一性断言），公开仓**不留复制品**——原「烟雾块改打 scrambled corpus」方案与已存在的 `ejs-scrambled-corpus.test.ts` 近乎逐条重复（后者已覆盖全语料不抛 / 双向回退白名单 / 无残留 `<%` / 动静分层 / 异步 prerender / QuickJS 后端 / 静区字节一致），且两 fixture 形状不兼容（string id vs numeric uid），「换输入」实为适配器+重键白名单，纯支出。公开仓 EJS 门 = `ejs-scrambled-corpus` + `ejs-backend-parity`（验收 #7 措辞已按此改）。前置：对 scrambled corpus（678 KB tracked）做一次**泄露审计**（stats/features 元数据与未混淆字面量从未逐行查过）；生成器 `scramble-worldbook-ejs.mjs` **迁私有仓 tools/**（公开 fixture 的再生输入是真实世界书——留在公开仓就是没有维护者的黑盒 blob；私有 CI 语料变更时重生成并向公开仓开 PR）；📌 同 PR 删 `package.json` 的 `"ejs:fixture"` 脚本（否则公开仓留一个指向已删文件的脚本，lint/format glob 还盖着 `scripts/**`） |
| D30 | 编码门                        | 分叉：公开仓保源码扫描 + 占位 `data/` 扫描（`DATA_ROOT` 路径随 D14 改 `public/data`，哨兵放宽「≥1 文件且全干净」）；私有仓完整门扫真实内容，`agent-config.json` 哨兵保留。📌 实测 **47 U+FFFD 已修**（U+FFFD:0 / ctrl:0 / JSON ok）——AGENTS.md 记录过时，顺手更正                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D31 | `beautifier-segments.test.ts` | `?raw` import 换 4 条手写合成 fixture（style/script/svg/media），`toHaveLength(22)` 删。`view-audio.test.ts` 同法（D12）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D32 | 守门（v1.1 重构为两轴）       | `tests/no-world-content.test.ts` 两轴：**① 叙事内容轴**——世界专名词表（研究 lexicon 的 37 词，**刨掉「命定之诗」产品名本身**）扫 `git ls-files` 全树（含 docs/），带**路径白名单**（守门文件自身、README/关于页的产品名引用行、授权协议指针）；**② 体量轴**——`public/data/worldbooks/*.json` 单本 ≤10 条 / 全集 ≤150 条、占位目录条数阈值、`reference/` 目录不存在、13 agent id 齐 + 各 systemPrompt 非空 + `agents.story.preset.settings.prompts[]` 非空（📌 v1.0 引 `agent-templates.test.ts` 作占位 config 的门是**张冠李戴**——那测试断的是代码侧 `REGISTERED_AGENT_IDS`（15 个，`agent-templates.ts:728`），跟 JSON 文件的 13 个 agent 无关、约束不了任何东西；这里的新断言才是真门）。词表是 floor 不是 ceiling（数值 lore 抓不到，D6）；专名本身已随公开卡片公开，词表入公开仓不构成新泄露                                                                                                                                                 |
| D33 | 测试与 fixture 中性化         | `tests/agent-framework/**` 整体迁私有（同 PR 删 `knip.json` 两行 entry）；`tests/realtime_export/*.preset.json` 删 tracked；~60 测试文件 IP 名 fixture 中性化（`state-manager.test.ts` 112 处最多；**v1.1 补：`bloodlines.test.ts:51`**）；**`combat-v3/fixtures/case-*.fixture.json`（7 件，真实战斗转写衍生：理查德×多、`_provenance` 叙述、`sourceCase` 指向将私有化的压测文档）**——中性化角色名/招式叙述 + 删 `sourceCase` 字段（或改指私有仓注记）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D34 | knip 棘轮                     | 分离后必有新死导出。走 **reviewed `knip:update`** 逐行看 diff；每一波的 knip 更新做**该波最后一个 commit**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 2.5 发布与许可（D35-D40）

| #   | 决策                              | 裁定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D35 | 授权链五件事                      | ① kitsch 预设再授权（D13）② BGM 授权（D12）③ 三方 regex 再分发权（D11）④ wessxss / Hilo114 贡献者 MIT 签字 ⑤ ✋ **主创权利确认**：授权协议是 outbound 不是 inbound——「本仓 owner 是否就是主创/开发组」必须显式确认，否则「私有包分发内容」前提不成立。各件未解决只阻塞对应内容进包                                                                                                                                                                                                                                                                                                        |
| D36 | docs 分流                         | A 类移私有：`narrative_context_example.md`、两份 prompt 草稿、授权协议（公开仓留指针，📌 白名单入 D32）、combat-v3 压测目录 + RFC、ARCHITECTURE.md 364 行起。**C 类从「keep as-is」改「keep, cleaned」**（v1.1）：`design.md:1`（标题就是『命定之诗 — 前端设计规范』）、`data-field-conventions-design.md:1,:442`（妲丽安）、asset 设计 `:361`、`worldbook-ejs-regex-authoring-guide.md:14`（链往移走的授权协议→改指针）、reviews 一处——**docs/ 下 43 个词表命中文件全部过一遍**，`docs/superpowers/**` 整树显式列入清洗清单（v1.0 漏了整个目录）。B 类清单照 §7.2。docs/ 纳入 D32 扫描面 |
| D37 | 点目录工具链                      | `audit-code.js` + `code-writer.md` 移私有；公开仓给引擎版 code-writer 变体。**扩为全点目录 triage**（D45）：`.claude/agent-memory/**`、`.codex/`、`.impeccable/`、`.playbook/` 默认不进快照                                                                                                                                                                                                                                                                                                                                                                                               |
| D38 | 跨仓契约测试（v1.1 反转依赖方向） | **公开引擎自带** `tests/contract/pack-install.contract.test.ts`：`POEM_PACK_FILE` 未设→skip；设了→加载该 pack 文件，fake-indexeddb 下走 `planPackInstall` + 执行器，断言「新鲜播种引擎上 0 冲突 + 分节计数 + 0 dropped」，再模拟一次用户编辑后断言「N 冲突」（证明冲突路径也活着）。私有 CI：`git clone --depth 1 <engine>` → `npm ci` → 构建真实包 → `POEM_PACK_FILE=… npx vitest --run tests/contract`。（v1.0 的「私有仓自建 vitest 跑引擎纯函数」不可行——得复刻 vue 插件/别名/tsconfig 拆分/依赖全家桶）                                                                              |
| D39 | npm 关死                          | `"private": true` + `files` 白名单。即刻做                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D40 | 分发与升级                        | pack 经私有仓 Release 构建发布，走命定社区渠道分发。`minEngineVersion` 与 `__ENGINE_VERSION__`（D26 注入）比对，不满足**拒绝 + 报消息**。升级：同 packId 比 semver，diff 从安装计划派生；条目 uid 永不回收（含占位→真实的保留段纪律，D43）                                                                                                                                                                                                                                                                                                                                                |

---

## 3. 目标拓扑与迁移物清单

### 3.1 私有内容仓布局（🔴 `data/` 形状 = D14+D15 overlay 契约）

```
private-content-repo/
├── data/                        ← POEM_CONTENT_DIR 指到这里，形状即 URL 约定
│   ├── worldbooks/*.json        ×15（从 Worldbook-for-destined-journey 同步）
│   ├── defaults/agent-config.json
│   ├── defaults/beautifier-rules.json
│   ├── defaults/map-marker-presets.json
│   ├── audio/manifest.json      （存档；分发待 D12 授权）
│   └── content/                 ← 六个注册表分节（v1.2p：并入 data/ 树，URL /data/content/*，
│       ├── catalog.json            overlay 与占位同形——引擎两种态用同一套路径）
│       ├── locations.json
│       ├── bloodlines.json
│       ├── name-pools.json
│       └── branding.json
├── reference/                   ← 瘦身语料（卡片 JSON、world_book_index、agent 流程测试、战斗样本、HTML 参考页）
├── docs/                        ← A 类文档 + ARCHITECTURE 第二部分 + 压测案例集
├── tests/                       ← worldbook-ejs-corpus.test.ts（整文件）+ encoding 完整门 + agent-framework 全套
├── tools/                       ← build-pack.mjs / scramble-worldbook-ejs.mjs / extract-map-markers.cjs / import-regex-rules.mjs
└── .github/workflows/content-ci.yml   （四道门，D38）
```

🔴 **`reference/` 三类件的处置** —— ① 两份 `.jsonl` 真实对局导出（105 MB，真实玩家会话，
从未做 PII/密钥审查）；② `游戏实例*.json/bin`（12 MB，同类）；③ `角色生成.txt`
（内嵌露骨 NSFW 关键词池）。

> ✅ **2026-08-06 主人裁定：三类**一并迁进 `_private-staging/reference/`**，随其余瘦身件
> 搬去私有内容仓**（否决了设计原先建议的 `git rm`）。故 §3.1 那句「三类不迁移、留本仓归档
> （或删）」作废 —— 波 4 T17 第 1 步对 `reference/` 是**整树离场、无例外**。
>
> 🔴 随之而来的两条，波 4/波 6 执行时必须一起做，别只搬不管：
>
> 1. **那 105 MB 从未做过 PII / 密钥审查**（这正是原先建议删的理由）。搬进私有仓不等于
>    问题消失，只等于问题换了个仓库住 —— 私有仓 CI 的密钥扫描面必须覆盖到它，
>    否则它会以「反正是私有的」的名义永远不被看。
> 2. **私有仓 CI 每次都要拉这 117 MB**。若 clone 时长变得难以忍受，用 Git LFS 或把这三类件
>    单独放一个不参与 CI 的目录 —— 但**不要**用「太大了」当理由悄悄回退成删除，
>    那是在替主人重做一次已经做过的决定。

### 3.2 分发链

```
Worldbook-for-destined-journey (私有,世界书真源)
        │ 同步
        ▼
私有内容仓 ── tools/build-pack.mjs ──► fated-poem-pack-<semver>.json ── Release ──► 玩家
        │                                      ▲
        │ POEM_CONTENT_DIR overlay (data/)     │ 契约测试: clone 引擎 + POEM_PACK_FILE
        ▼                                      │
公开引擎仓 (poem-engine) ◄─────────────────────┘
```

---

## 4. 内容包格式 v1

```jsonc
{
  "formatVersion": 1, // 🔴 必读必校验。不满足 → 拒绝 + 报消息
  "packId": "fated-poem-official",
  "packVersion": "1.0.0", // semver，驱动升级判定
  "minEngineVersion": "1.1.0", // 与 __ENGINE_VERSION__ (D26) 比对；不满足 → 拒绝 + 报消息
  "name": "命定之诗 正式内容包",
  "description": "…",
  "exportedAt": 0,

  // ── 分节全部可选：absent = 本包对该域无话可说（别动）；[] = 刻意清空 ──
  "worldBooks": [/* WorldBook[]，15 本，builtIn:true，真实分区名，真实 uid 空间 */],
  "agentDefaults": { "version": 1, "agents": {/* AgentProjectDefaults，含 story.preset */} },
  "presets": [/* ChatPreset[]，若在 agentDefaults 之外单发 */],
  "beautifierRules": { "version": 1, "rules": [/* isBuiltin:true 语义 */] },
  // 🔴 无 builtinDisabled 字段（v1.2 删）：那是用户设置（s.beautifierBuiltinDisabled，
  // localStorage），不是默认值文件的一部分——pack 带它就得写用户设置，违反 D20
  // 「不写用户表/设置」，卸载也不再免费。defaults 文件实测也只有 {version, rules}
  "mapMarkers": [/* MapMarker[]，91 条 */],
  "catalog": {/* 七池：装备/物品/技能、背景、命定核心、种族/身份点数、起始地树 */},
  "locations": [/* LocationNode[]，34 节点 */],
  "bloodlines": {/* KNOWN_BLOODLINES 形状 */},
  "namePools": {/* NAME_POOLS / HAIR_COLORS / EYE_COLORS / PERSONALITY_POOL */},
  "branding": {
    "appTitle": "…",
    "subtitles": [],
    "credits": "…",
    "about": "…",
    "era": "复兴纪元", // save 创建时盖章用；无 epochYear（D9）
    "plotTemplate": "…",
    "mapSources": [/* 地图图源 URL */],
    "workshopApiBase": "https://…workers.dev", // D41
    "workshopLoginHint": "…",
  },
  "imagePresets": [/* 可选 */],

  "sectionHashes": { "worldBooks": "sha256:…", "…": "…" },
  // 构建器逐节盖章。📌 用途仅限 D40 升级 diff 展示与快速比对；
  // 冲突判定/对账的逐书基线从 payload 现算（D18 hash 分工）
}
```

规则：分节三态；部分包合法；malformed 不 throw、validate 先于任何写入；安装前快照可回滚；
uid 永不回收（占位保留段 900001+，D43）；升级 diff 从安装计划派生；音频字节不进 JSON（D12）；
**pack payload 不进 FullBackup**（D18）。

尺寸预估：世界书 1.86 MB + agent-config 413 KB + 美化 396 KB + 标记 102 KB + 目录 ~350 KB +
地点/血脉/名字池 ~60 KB ≈ **3.2 MB**。localStorage 零接触（D22 后 settings 只碰
`activePresetId` 与内容态标志）。

---

## 5. 引擎侧改造契约

### 5.1 ContentProvider

- `content-source.ts`（引擎，纯）：pack 校验（`validatePackOrThrow`）、分节解析优先级、
  `planPackInstall(pack, current, packBaseline, placeholderBaseline)`、hash 工具。零 I/O 全可单测。
- `content-store.ts`（UI，Pinia）：模块级 **ready promise**（时序契约见 D16）；`contentStatus`
  （`placeholder | pack:<id>@<ver> | needs_attention | error`）；pack 行缓存；各 section 内存 ref；
  `setContentRegistry()` 灌注同步注册表（random-tables / bloodlines / $location / agent-tools）；
  安装/升级/卸载执行器。
- 装载面三处 fetch 收口 + AgentConfigPanel 保持 raw 读（D16）。

### 5.2 安装/升级/卸载流

```
安装:
选文件 → JSON.parse → validatePackOrThrow（格式/引擎版本/creative_workshop 分区拒绝态）
  → 调用方备料: 上次装包基线(从既有 contentPacks.payload 现算) + 占位基线(内置 placeholder-hashes.json)
  → planPackInstall(pack, 现状, 上次装包基线?, 占位基线)          // 纯函数；四态规则 D20
  → 计划含: 各分节 added/updated/removed/conflicted + 存档 uid 迁移步骤 (D43 按名配对/needs_selection)
  → 无冲突 → 执行；有冲突 → needs_confirmation（逐节列出）
  → 执行器: exportAllData() 快照 → 分节写入（D19 路径）→ 存档迁移 → contentPacks.put
  → 注册表重灌 + provider 缓存失效 → 报告（WorkshopNote 三类）；任一步 throw → 快照回滚

卸载（v1.2 补齐安全面——与安装同级，不是顺手一删）:
  → 预检: 逐 pack 拥有书比对 payload 基线 → 「N 本已被你编辑过，卸载将丢弃」确认（有编辑必确认）
  → exportAllData() 快照
  → 世界书: 🔴 显式「删 pack 拥有 id → upsertBooks(占位书)」（mergeBuiltIns 是 id-presence-only,
    对仍占着 15 个 id 的 pack 内容是保证 no-op——它只服务首播种与 D42，卸载不许用它）
  → presets: 删 pack 预设行; activePresetId 指向它时切回占位预设 id
  → agents/beautifier/catalog/…: 零动作（provider-owned, 删 pack 行即回落）
  → 存档迁移（D43 语义反向: 真实 uid 消失 → 按名配对回占位/needs_selection）
  → contentPacks.delete → 注册表重灌 → 报告；任一步 throw → 快照回滚
```

### 5.3 世界书细则

- 占位 15 本：同 id 同分区、`builtIn: true`、**uid 保留段 900001+**（D43）。
- 安装写入走 `upsertBooks`；`mergeBuiltIns`（id-presence-only）只负责占位播种 + D42 重播种。
- agent 可见性：pack 与占位同 15 id ⇒ 既有 `agents.*.worldBookIds` 命名继续成立；未来新 id
  须含 grant 步骤（工坊 `grantWorkshopBookToAgents` 先例）。

### 5.4 agents 层（D44，v1.2 大修版）

**分层真源**：`projectAgentDefaults`（运行时解析 = pack `agentDefaults` > 占位文件）作为
**默认层**；`settings.agents` 只承载**用户显式覆写**。装包 = 写 contentPacks + 失效 provider
缓存，**不写 `settings.agents`**；卸载 = 删 pack 行，默认层自动回落，**零 IP 残留**。

**v1.2 的四条修正**（v1.1 首版在这里自己造了两个静默失内容路径）：

1. **resolve 覆盖全部 12 键，改造点是读取咽喉不是调用点。**
   `resolve(agentId, key) = 覆写层 ?? 默认层` 必须覆盖
   `model / worldBookEnabled / worldBookIds / systemPrompt / template / temperature / topP /
freqPen / presPen / maxTokens / historyLayers / historySlice`。今天 `worldBookEnabled /
worldBookIds / model / 数值参` 的**唯一写入者就是被删除的 boot 播种**（`game-pipeline.ts:507-508`
   直读 settings；`agent-settings.ts:106-115` 硬兜底 `''/false/[]`）——只给 systemPrompt 做
   fallback 的话，删播种 = 全体 agent 静默失去世界书。落点：`getAgentSettings`
   （`agent-settings.ts:104`，单一读取咽喉）加默认层参数，callers 不动。
2. **名册迭代改源。** `listConfiguredAgents` / `updateAgentWorldBookIds`
   （`agent-settings.ts:252-276`）与工坊授权 `grantWorkshopBookToAgents`
   （`workshop-types.ts:438-443`）都按 `Object.keys(bag.agents)` 迭代——覆写层为空时，工坊装书
   会**授权给零个 agent 且无报错**。改为迭代**解析名册**（默认层键 ∪ 覆写层键）。
3. **precedence 统一是显式行为变更。** 今天 `game-pipeline.ts:548` 实为
   `defaults || settings`（默认层优先、覆写被无视），`:541` 又是覆写独取——一共三种。新 resolve
   统一**覆写 ?? 默认**并记录为裁定。随之，「测试者旧九键视作覆写、无害」不成立（pack 后续版本
   将永远够不到他们）：**一次性迁移必做**——引擎带**历史默认值指纹表**（逐 agent 逐字段
   SHA-256，私有构建生成；指纹不泄内容），首启命中指纹的覆写键删除。
4. **覆写制造面全列改造。** `saveAgentSettings`（`AgentConfigPanel.vue:102-105`，现把展示中的
   默认整份写进覆写层——改为与解析默认 diff、相等键删除）；`applyProjectDefaultToAgent`
   （`agent-settings.ts:184`）语义改「清该 agent 覆写层」；`resetAgentSettings` 同向；
   **`AgentUpdateCenter.vue`**（`972d5a2` 新增，为旧缺陷而生）重定位为「覆写层 vs 默认层」
   差异面板 + 「清除覆写」动作——否则四位测试者会永远看到全部 agent 标着「与最新默认不同」。

- AgentConfigPanel/AgentParamsCard 显示解析值、明示「默认 / 已覆写」来源徽标，保存只写 diff。
- story 预设：pack 按 pack `presetId`（≠ 占位预设 id）整行 upsert 进 Dexie（D20/D22）；
  `activePresetId` 未设或指向占位预设 id 时切到 pack 预设，指向用户第三方预设时不动。
- 新增管线测试：空覆写层 + pack → story `worldBookIds` 非空、工坊授权可达全名册。

### 5.5 内容态与静默 census（v1.1 修订口径）

活跃 `/data/*` fetch 共 **6 处**（`beautifier.ts:95`、`builtin-worldbooks.ts:34`、
`AgentConfigPanel.vue:136`、`game-pipeline.ts:704`、`create-store.ts:970`、
`settings-store.ts:428`）+ `/audio/manifest.json`（`audio-store.ts:57`）；其中 game-pipeline
与 beautifier 已 warn，其余静默；另有 2 处死路径随 D28 删除。改造后：全部经 provider 上报
`contentStatus`，行为兜底不变（失败不阻塞启动），首页横幅 + 设置页徽标消费状态。横幅文案含
产品名引用（「导入《命定之诗》内容包…」），入 D32 白名单。

### 5.6 「恢复默认」矩阵

| 入口                                        | 现行为                                | 新行为                                                                                          |
| ------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| per-agent 恢复默认                          | 取 `projectAgentDefaults`（占位文件） | 语义变化：清该 agent 的**覆写层** → 解析值自动回默认层（pack > 占位）；story 分支恢复 pack 预设 |
| per-book 恢复默认（`resetSingleWorldBook`） | re-fetch `/data/worldbooks/<id>.json` | provider：pack payload 该书 > 占位文件                                                          |
| 全局 `resetToDefaults`                      | fetch 全部占位书 clear+bulkPut        | provider 同上，整套 + 存档迁移语义（D43）                                                       |
| beautifier 内置禁用回退                     | 每 boot re-fetch 占位文件             | provider：pack rules > 占位文件 >（代码兜底 `getBuiltinRules()` 不动）                          |

### 5.7 FullBackup 交互（v1.1 新增，v1.2 收窄）

- `contentPacks` **不入** FullBackup（D18）。
- `db.presets` 补三态护栏（D22；作用域 = 手编/裁剪备份，见 D22 注）。
- `importAllData` 收尾挂 `reconcilePackState()`：**范围 `{worldBooks, presets}`、逐 pack 拥有项
  比对（payload 现算 hash），用户自建/工坊行不在域内**——pack 拥有项缺失或被替换才
  `needs_attention` + 用户二选（本地 payload 重放 / 卸载回占位），不自动；`activePresetId`
  悬空 → 从 payload 重导 story 预设（明确分支）。其余分节真源即 payload，恢复动不到，无需对账。
- DataSection 文案更新（备份不含内容包本体；恢复后可能需重放）。

### 5.8 现存安装旅程（v1.1 新增，验收 #15）

- **发布时序**：真实 pack 与公开引擎首发**同时或先于**可用——否则测试者升级即降级。
- 引擎首启检测：`contentStatus === placeholder` 且 Dexie 世界书条目规模远超占位阈值
  （= 老真实数据仍在）→ 横幅措辞切换为「检测到本地真实内容，导入内容包以恢复完整默认与
  后续更新」，不静默换占位语境。
- **明示会降级的四个面**（对测试者的迁移公告）：美化内置 22 条规则（内存重算面，占位后只剩
  演示规则——装包即回）、地图标记（bundle 面）、捏人目录（bundle 面）、内置曲库（manifest 面）。
  世界书/预设/agent 覆写（Dexie/localStorage 持久面）不受影响。

---

## 6. 占位内容集规格

三级标准：**UI 不空破** / **演示环路可走** / **不承诺游戏性**（与需求原文 display purposes
only 对齐）。

| 件            | 规格                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 世界书 ×15    | 同 id/分区/schema、`builtIn: true`、**uid ∈ 900001+ 保留段**（D43）；每本 2-5 条通用奇幻条目；全集 ≥1 EJS 动态条 + ≥1 静态条；总条目 ≤150（D32 阈值）                                                               |
| agent-config  | **与今日文件相同的 13 个 agent id**（D32 新门直接断言，别再引代码侧 15 id 测试）；各 systemPrompt 300-800 字通用版（输出契约/工具调用约定保真——那是引擎协议）；story 带 8-12 条目通用叙事预设（D27），presetId 固定 |
| 捏人目录      | 七池小而全：武器/防具/饰品各 3-5、物品 5、背景 3（纯通用奇幻）、「起源印记」3 个、点数表沿用占位血脉 id；机制件（难度/性别）已随 D24 留引擎                                                                         |
| 地点          | 6-8 节点两层小地图，通用描述                                                                                                                                                                                        |
| 血脉          | 同 id + 同 statModifiers，一句话中性描述（`bloodlines.test.ts:51` 断言同步改 shape 断言）                                                                                                                           |
| 名字池        | 每池 8-12 个通用奇幻名                                                                                                                                                                                              |
| 地图标记      | `[]`（面板空态）或 3-5 个通用标记；图源列表空（D23）                                                                                                                                                                |
| 美化规则      | 4-6 条自写演示规则（对话卡/高亮/style/media；兼作 D31 fixture 来源）                                                                                                                                                |
| 音频 manifest | `[]`（D12：内置曲库退役，空态 + 用户导入通道保留）                                                                                                                                                                  |
| 演示存档      | test-save / test-fixtures 中性重写（D27）                                                                                                                                                                           |
| branding      | 中性应用名（codename）、era `'元年'`、通用 credits、workshopApiBase 未设置                                                                                                                                          |

占位集也过编码门与 prettier（📌 现 format glob 不含 `data/` 也不会含 `public/data/`——D14 PR
同步把 `"public/data/**/*.json"` 加进 `format`/`format:check` glob，CI 的 Linux 检出是权威）。
**占位逐书/逐节 hash 清单（`placeholder-hashes.json`）在占位内容构建时生成、随引擎打包**——
它是 D20 四态基线、D42 重播种、卸载 re-seed 三处的共同输入，不许运行时从 `/data/*` 现算
（overlay 生效时那里是真实内容）。占位预设 id 与 pack 预设 id **不同且各自固定**（D20）。

---

## 7. 测试与文档分流细表

### 7.1 测试处置

| 处置         | 对象                                                                                                                                                                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 留公开仓不动 | `ejs-scrambled-corpus.test.ts`、`ejs-backend-parity.test.ts`、`agent-templates.test.ts`、`no-external-assets`（扩 src/** 外链扫描，D23）、`theme-fonts-invariant`、`knip-ratchet`、`server-app`、纯逻辑测试全部                                                                                                                         |
| 留公开仓改造 | encoding 门公开半（D30，DATA_ROOT 改路径）、`beautifier-segments`（D31）、`view-audio`（D12/D31 同法）、`field-enums.test.ts:166`（改指占位目录，D24）、`bloodlines.test.ts:51`（shape 断言，D25）、location/audio-scene/create-store/time-system 测试改打占位 fixture、~60 文件 IP fixture 名中性化 + combat-v3 fixtures 中性化（D33） |
| 迁私有仓     | `worldbook-ejs-corpus.test.ts` 整文件（D29）、encoding 门完整版、agent-framework 全套 + fixtures、`realtime_export/*.preset.json`                                                                                                                                                                                                       |
| 新增公开仓   | `no-world-content.test.ts`（D32 两轴）、内容包管线测试（planner 单测 + 执行器 fake-indexeddb 集成 + **占位建档→装包→存档存活**回归（D43）+ 装包后 boot 时序断言（D16））、`tests/contract/pack-install.contract.test.ts`（D38，POEM_PACK_FILE 门控）、零安装态启动 smoke                                                                |
| 新增私有仓   | 契约测试 CI 编排（clone 引擎 + 注入包）、pack 构建器自检                                                                                                                                                                                                                                                                                |

### 7.2 docs 分流

- **移私有（A）**：`narrative_context_example.md`、`plot_outline_prompt_draft.md`、
  `plot_post_check_prompt_draft.md`、授权协议（公开留指针，白名单）、
  `2026-07-31-combat-v3-stress-test/`（6 件）+ 同名 RFC、ARCHITECTURE.md 364 行起、
  phase7d 四件（上游卡分析）、`status_page_architecture.md`、`task_plan|findings|progress.md`。
- **公开仓清洗（B/C 合并为「keep, cleaned」清单）**：ARCHITECTURE 前 363 行（改题）、
  PRD / project-introduction（引擎叙事重写）、known-issue（妲丽安引文抽象化）、
  zone_visibility_model（示例换通用 fixture）、audio_system（示例地名换占位）、EJS/工坊设计
  四件（真实条目正文删改、统计保留）、`design.md`（标题）、`data-field-conventions-design.md`
  （标题 + `:442`）、asset 设计 `:361`、`worldbook-ejs-regex-authoring-guide.md`（授权协议
  链接改指针 + poem-ejs 更名同步）、reviews 一处、**`docs/superpowers/**` 整树逐件过**——
  以 D32 词表扫 docs/ 的结果为完备清单（43 个命中文件），不再靠人工列举。
- **留公开（C, cleaned 后）**：combat v2/v3 架构、image/asset 设计、dev-bat-notes、
  story_preset_format、agent 指南类、reviews 其余。

---

## 8. 风险与开放问题

| #   | 风险                                              | 处置                                                                                                                              |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 已公开 + 4 fork：历史内容与 key 已暴露            | key 立即轮换（D5）；内容暴露接受为既成事实；✋ fork 处置主人裁定                                                                  |
| R2  | 占位 story 提示词是全新写作，质量决定开源第一印象 | D27 单列任务；验收 #2 真机走演示环路                                                                                              |
| R3  | 四处「移动解决不了的授权问题」                    | D10-D13 + D35：黑名单 + provenance 标记 + 未解决不进包                                                                            |
| R4  | 占位与真实 schema 漂移                            | D38 契约测试（双向断言：0 冲突 + 模拟编辑后 N 冲突）；改 pack 类型的 PR 必须跑私有 CI                                             |
| R5  | scrambled corpus 未审计（678 KB tracked）         | D29 前置泄露审计；有问题则私有仓重生成（生成器自带编译等价自检）                                                                  |
| R6  | create-store 同步→异步是最大单体改造              | D24 修正切分线后独立任务，L + 测试尾 XL，实施计划最大时间盒                                                                       |
| R7  | 词表抓不到数值 lore 与未列名词                    | D6 写进门注释；快照 cut 前一次人工全树 review + 新仓首 commit 复扫（D1/D45）                                                      |
| R8  | knip 棘轮必响                                     | D34：reviewed update，每波末位 commit                                                                                             |
| R9  | 授权挂起期分发空窗                                | 工程与授权解耦：最小可分发包 = 世界书 + agent-config（自有内容）                                                                  |
| R10 | 升级/卸载/存档迁移路径无先例                      | 验收 #14 三走查 + D43 回归测试 + §7.1 管线测试                                                                                    |
| R11 | 波间中断留下红 CI                                 | 实施计划定义原子 PR 集（`data/` 移动波 = D14+D23+D31+D29迁移+encoding路径+extract-map-markers 一个 PR）；每波结束本仓 CI 必须全绿 |

✋ **待主人裁定汇总**：D3（内容仓建新 vs 扩建）、D4（公开仓名）、§3.1（105 MB 对局导出删 vs
归档）、D10/D13/D35（授权四件）、R1（fork 处置）。全部有默认推荐，不阻塞开工。

---

## 9. 架构顺手改善清单

1. 生产构建内容缺失的潜伏缺陷闭合（D14）。
2. agent 默认值分层化：默认层/覆写层分离，`resolve()` 单一读点（D44）——顺带消灭四处重复
   fetch 与 boot 播种的语义纠缠。
3. presets 撤出 localStorage + `db.presets` 三态护栏（D22）。
4. 7 处静默失败 → 显式内容态（§5.5）。
5. 死代码四组清除（D28）；15 书清单真源合一。
6. 演示数据与真实内容解耦（D27）。
7. location/bloodlines/catalog/名字池数据驱动化 + 同步注册表模式（D16/D24/D25）——引擎向
   「通用文字 RPG 引擎」实质迈进。
8. 工坊后端配置化（D41）。
9. 外链三清（i.ibb.co ×2 + OSD prefixUrl）+ no-external-assets 门扩展到 src/**（D23）。
10. 引擎版本注入 `__ENGINE_VERSION__` + tag 纪律（D26/D40）。

---

## 10. 实施排序约束（实施计划的边界条件）

1. **波 0（本仓，先于一切）**：D5 key 轮换；D39 npm 关死；`.gitignore` 补 `.claude/worktrees/`
   （D1）。📌 v1.2 核实：字体 WIP 与工作树冲突已在 `e53f8c0` 解决提交——v1.1 波 0 里那两项
   已完成，勿重复排。
2. **原子 PR 集**：`data/` 移动必须一个 PR 内完成 D14+D23（MapPanel）+D31（beautifier fixture）
   +D29（语料门迁出）+encoding 门路径+`extract-map-markers.cjs` 处置+vite.config——六处硬耦合
   （§1.2 表）任何一处滞后即红 CI。
3. **D22（presets 出 localStorage）先于 D19（装包写 presets）**；D16（provider + ready
   promise）先于 D44（agents 分层）与 D25③（random-tables 注册表——同步工具执行路径依赖
   灌注时序）。
4. **D34 knip 更新是每波最后一个 commit**。
5. **占位内容 authoring（§6）先于快照 cut**；真实 pack 构建先于或同时于公开仓首发（§5.8）。
6. 所有引擎改造在**本仓**完成并以 `POEM_CONTENT_DIR`（指向内容树）+ 真实 pack 双态验证后，
   才执行内容删除与快照 cut——先改造、后搬家、再切仓。
7. （v1.2 补）**D26 的 `__ENGINE_VERSION__` 注入先于 D40 的 `minEngineVersion` 门与 pack
   构建器取值**；**`placeholder-hashes.json` 生成属于占位内容 authoring 交付物**，先于 D20
   planner、D42 重播种、卸载 re-seed 三个消费方接线。

---

## 11. 修订记录（两轮对抗评审裁定）

**v1.1**（4 路评审，4 blocker + 15 major 全采纳）：uid 允许清单塌陷 → D43；agents fillMissing
no-op + 卸载残留 → D44/§5.4；首装无基线 → D20 四态；快照 worktrees 泄露 + 工作树冲突 →
D1/D45；守门自相矛盾 → D32 两轴 + 白名单；美化规则双写矛盾 → D20 provider 层裁定；epochYear
撤出 pack + era 盖章 → D9；FullBackup×pack 对账 + payload 不入备份 → D18/§5.7；语料门整迁
不复制 → D29；start-catalog 机制件切分 → D24；D25 三档如实计量；契约测试反转 → D38；工坊
配置化 → D41；minEngineVersion 操作数 → D26；现存安装旅程 → §5.8；audio manifest → D12/§6；
D14/D15 矛盾合并；census 6+1 修正；OSD 外链 → D23；poem-ejs.d.ts → D26；点目录 triage →
D37/D45；占位升级通道 → D42；D22 提级前置。

**v1.2**（2 路验证：对 v1.1 修复的回归核查 47 项中 38 项确认已解 + 独立通读；新报 4 blocker +
13 major 全采纳）：D44 首版删播种打断 `worldBookIds`/名册/工坊授权 + precedence 实为反向 +
覆写制造面漏列 + 迁移从可选变必做（含指纹表机制）→ D44/§5.4 四条修正；`fromEpochMinutes`
硬编码 era（序列化枢轴另一半）→ D9；`vite preview` 无 `/api` → D14 `configurePreviewServer` +
验收 #2 改写；D43 裸删对单选钉选分区 = 内容通胀 → 按名配对（工坊先例）+ `needs_selection`；
卸载 re-seed 用 `mergeBuiltIns` 是保证 no-op → §5.2 显式删后播 + 快照 + 确认；planner 纯函数
vs fetch 矛盾 + overlay 毒化占位基线 → 基线来源钉死 `placeholder-hashes.json`；reconcile 范围
收窄 `{worldBooks,presets}` 逐项比对 + preset 重导分支 → D18/§5.7；preset id 占位≠pack 消歧 →
D20；pack schema 删 `builtinDisabled` → §4；分区数 15→16 更正 → §0.3；`ejs:fixture` 脚本清理
→ D29；format glob 补 `public/data` → §6；D1 gitignore 清单收窄；基线更新 `70bd93c`→`e53f8c0`
（波 0 两项已完成；`AgentUpdateCenter` 纳入 D44）；probe 失败开 → define 标志；引文行号勘正。
