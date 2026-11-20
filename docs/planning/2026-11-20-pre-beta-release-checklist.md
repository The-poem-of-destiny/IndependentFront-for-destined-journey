# 测试版（Beta）发布前检查清单

> 状态：**在办**（2026-11-20 建立）。来源：2026-11-20 对三仓（引擎 / 私有内容仓 / 地图编辑器）的 beta 就绪审查。
> 本文件只做「发 beta 之前要过的闸门」索引；每条的细节与长期待办仍以根目录 [`TODO.md`](../../TODO.md)、
> [`docs/known-issue.md`](../known-issue.md) 为准，这里不重复正文。做完一条就打勾并写日期；整份清单清空后归档到 `docs/archive/planning/`。

## 审查时的基线（2026-11-20 实测）

- 引擎 `master@4d62845`：`npm run gates` 全绿（typecheck ×3、build、format、lint、knip 棘轮、测试 508 个文件、约 1.08 万条用例）。
  本机 Node 25 需 `NODE_OPTIONS=--no-experimental-webstorage` 才与 CI 等价。
- 私有内容仓在分支 `content/character-affection-tiers`：`build-pack.mjs` 构建成功（13 个分节），用该包跑引擎契约测试 7/7 通过，`scan-secrets` 0 命中。
- 结论：**代码本身接近可发，挡住 beta 的是分发链路、一处密钥外泄和首次上手体验。**

## 🔴 阻塞项（不解决就不能发 beta）

- [ ] **旧内容包密钥已公开，发布工具仍会把私有内容公开出去**
  - 证据：私有内容仓 `tools/build-release.mjs:34` 写死 `FALLBACK_KEY_B64`，`--upload` 默认目标是**公开**仓 `The-poem-of-destiny/poem-dist`（同文件 :42）；
    同一把密钥在公开引擎仓历史 `d0c113a:server/content-pack-release.ts:35` 中，`origin/master` 可达。
  - 后果：`poem-dist` 上 v2.8 ~ v2.12.1 的 `pack.bin` 任何人都能解密；照文档跑一次 `--upload` 就会把当前私有内容以同样方式公开。
  - 背景：旧通道当初的威胁模型就是「密钥内嵌 = 混淆、非访问控制」（见 `docs/planning/2026-09-26-content-pack-auto-update-design.md`），
    这本身不是新漏洞；问题在于 2026-11-07 起内容改走 Discord 授权，意图变成「受控分发」，而旧通道仍可用、仍在文档里，
    会把这层访问控制整个绕过去。
  - 待主人裁定：① 停用或改掉 `--upload` 默认目标；② `poem-dist` 旧 Release 是否下架 / 转私有（密钥已在公开历史里，轮换救不回已发的包）。
- [ ] **测试者拿不到程序**：引擎仓没有任何 GitHub Release；Windows 便携 zip 只能在 Windows x64 上打（`scripts/build-portable.mjs` 平台检查）；macOS 没有任何打包产物。
  - [ ] 在 Windows 机上打便携 zip，并完成 `TODO.md`「正式发布打包」里的干净虚拟机冒烟。
  - [x] 决定 macOS 测试者的获取方式（便携包 / 仅源码运行 / 暂不支持），写进 README。（2026-11-20：主人裁定标为 WIP，已写进 README 平台表）
  - [ ] `dev.sh` 自动探测的仍是旧内容仓文件夹名 `../fated_poem_independent_assets/data`（`dev.sh:33`），对齐现在的 `Independend-Frontend-Assets`。
- [ ] **测试者拿不到正式内容**：内容中心服 `The-poem-of-destiny/fate-content-pack-server` 是私有仓、只有一个提交、未部署。
      二选一：部署中心服并做真实 Discord OAuth 端到端联调；或明确 beta 期间改用「从 JSON 文件导入」明文包（等于无访问控制，需主人接受）。
- [ ] **首次上手路径缺失**：应用内没有把「内容包 → 添加 API → 建角色」串起来；README「首次游玩配置」已过时，且与准入页对 Embedding 的说法矛盾。见 `TODO.md` 首条。
  - 📌 2026-11-20：README 一半已完成 —— 「首次游玩」一节已对照现版本应用重写，并写明 Embedding 为可选；应用内首次上手引导仍未做。
- [ ] **默认开启但未真机验证的功能**：`stagedNarrative`（正文演出）与 `visualEffects`（界面特效层）在 `src/ui/stores/settings-store.ts` 默认 `true`。
      演出若卡住，玩家看不到行动选项。二选一：真机（含低配笔记本）走查通过，或 beta 默认关闭。

## 🟠 发 beta 前应修

### 引擎（本清单建立时同批修复，分支 `fix/pre-beta-engine-hardening`）

- [x] LLM 重试策略按错误分类：4xx（408 / 429 除外）不重试；429 遵守 `Retry-After`；已开始出字后中断的流最多重试 1 次；退避等待可被取消。（2026-11-20）
- [x] 流式输出空闲超时：首个分片后不再无限等待，每个分片重置计时器。（2026-11-20）
- [x] 整库导入清掉按存档的运行时表（战斗沙盒、Delta 提示会话等），避免恢复旧备份后续上「未来」的战斗。（2026-11-20）
- [x] 同一存档跨标签页互斥（Web Locks），避免两个标签页同时写同一存档。（2026-11-20）
- [x] 首页开发用「快速测试」整库清空前二次确认；直出失败 toast 改为脱敏摘要。（2026-11-20）

### 发布链路与内容

- [ ] **引擎版本号开始递增**：`package.json` 自始至终是 `1.0.0`。便携版「同版本已在运行」判断、内容包 `minEngineVersion` 闸门都依赖它，首个 beta 前必须递增。
- [ ] **内容仓分支合并**：`content/character-affection-tiers` 领先 `main` 9 个提交（Prime 1.18 预设、原生角色、随机事件、直出协议、好感七档、NSFW 标记），无 PR。发包前合并，否则从 `main` 发包会全部缺席。
- [ ] **地图创作源回到地图仓**：内容仓里的编译产物比地图仓 HEAD 重新编译的结果更新（国家 10 vs 9、地块 311 vs 308、中层 79 vs 76），对应 `mapdata/` 从未提交到地图仓。
      照文档从地图仓重编会静默回退这些修改。先把源补回地图仓，再验证重编 hash 一致。
- [ ] **`provinces.png` 不随包分发**：包里已有 `mapPack`，但势力图栅格只认同源 `/data/content/provinces.png`，装正式包的玩家势力图会报缺图。见 `TODO.md`「地图包不随内容包分发」。
- [ ] **下一个内容包版本号必须大于 2.12.1**：内容仓 README 与中心服 README 的示例仍写 `2.8.0`，`build-pack` 默认 `1.0.0`。
- [ ] **清掉内容仓默认配置里的两个本机 API 池 id**（`TODO.md` 已列）。
- [ ] **第三方许可证**：`THIRD-PARTY-NOTICES.md` 与 `public/licenses/` 只覆盖 three.js 和字体；前端实际打包的 dexie（Apache-2.0）、openseadragon（BSD-3）、vue、pinia、fflate、quickjs-emscripten 等缺全文。仓库根目录也没有 `LICENSE` 文件（`package.json` 声明 MIT）。
  - 📌 2026-11-20：第三方全文部分已完成 —— `public/licenses/` 新增 7 份许可证全文（从 `node_modules` 原样复制），`THIRD-PARTY-NOTICES.md` 表格同步扩充。
    根目录 `LICENSE` / 本项目自身许可证的问题主人暂缓裁定，未做。
- [ ] 更新 `TODO.md`「内容包 ↔ 引擎能力缺口」一节：当前分支构建已含 13 个分节，`mapPack` / `characters` / `randomEvents` 已在包内，真正缺的只剩 `imageDialects` / `remoteAssets`。

## 🟡 beta 期间可并行处理

- [ ] 2026-11-14 UI/UX 普查剩余项（约 100 条 P2、49 条 P3），优先：存档管理删除确认不写存档名、`删除标记` / `全部重置` 无确认、首页「退出」在浏览器标签页里无效、四种确认弹窗风格并存。
- [ ] 2026-11-14 普查 41 条 P1 修复全部「待真机」，需要一次集中真机回归。
- [ ] 主题对比度：indigo / ocean / bronze / sakura 的弱化文字对卡片背景低于 WCAG AA 4.5:1（实测 3.7 ~ 4.3）。
- [ ] 露骨内容开关没有年龄 / 意图确认（默认关，正确）。
- [ ] 首页按钮文案用空格拉开字距（「新 建 存 档」），读屏逐字朗读；改用 CSS `letter-spacing`。
- [ ] 整库导入只在标签页存活期间可回滚；导入中途关页会留下半新半旧的库。
- [ ] EJS 默认后端仍是无沙箱的 `LegacyBackend`，隔离只靠 `main.ts` 先装生产后端；改为默认 fail-closed。
- [ ] 本地 BFF 的 SEC-02 补充：`text/plain` 的 POST 属于简单请求、不触发预检，开着 `POEM_CONTENT_DIR` 的 dev server 可被任意网页写回内容目录（仅开发态，便携版不受影响）。
- [x] README 写 Node 20.19+，`.nvmrc` 是 22.23.2，统一口径。（2026-11-20：README 改为按 `.nvmrc` 推荐 Node 22，最低版本以 `package.json` 的 `engines` 为准）
- [ ] `TODO.md` 里各项「真机验收」（战斗沙盒、Delta 会话、文生图、原生角色、直出正式内容）在正式包可分发后集中跑一轮。

## 建议顺序

1. 当天：裁定密钥外泄与 `poem-dist` 处置，停用 `--upload` 默认目标。
2. 发布链路：递增引擎版本号 → 合并内容仓分支 → 地图源回仓 → 中心服部署（或明文包方案）→ Windows 便携包冒烟。
3. 邀请测试者之前：首次上手引导 + README 重写，并对默认开启的演出 / 特效做真机走查。
