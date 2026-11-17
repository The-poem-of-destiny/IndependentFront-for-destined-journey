# Windows 便携版（portable zip）发布说明

状态：2026-11-16 已实施（测试版）。打包脚本已在开发机打出 zip，冒烟脚本可对其做自动检查；**尚未发布任何 Release**，也未在没装 Node 的干净 Windows 上真机双击验证（见「没有自动化的部分」）。

## 是什么

给不想装 Node.js / 不会用 git 的玩家准备的 Windows x64 免安装包：解压后双击 `Start.bat`，自带的 `node.exe` 跑一个本地独立服务器（前端静态资源 + BFF 同源路由），并自动用默认浏览器打开游戏页。

- 服务器入口：`server/standalone.ts`（进程层：读 `config.json`、监听、开浏览器、端口冲突指引）+ `server/standalone-app.ts`（纯函数装配的 Hono app，复用 `server/app.ts` 的 `buildHonoApp`，便于单测 `app.request()`）。
- 启动器：`scripts/portable/Start.bat`；随包说明：`scripts/portable/README.txt`（打包时改名为 `使用说明.txt`）。
- 打包：`scripts/build-portable.mjs`（`npm run release:portable`）；冒烟：`scripts/smoke-portable.mjs`。
- 单测：`tests/server-standalone.test.ts`、`tests/build-portable.test.ts`、`tests/portable-launcher.test.ts`。

## zip 布局

产物为 `release/narrative-engine-v<版本>-win-x64.zip`（`release/` 已被 `.gitignore` 排除），解压后：

```text
narrative-engine-v<版本>-win-x64/
  Start.bat                 启动器（原样复制，CRLF、纯 ASCII）
  使用说明.txt               README.txt 填好占位符，CRLF + UTF-8 BOM
  THIRD-PARTY-NOTICES.md    打包时生成的组件清单（Node 版本 + 服务端 / 前端依赖及许可证），不是仓库根那份
  runtime/node.exe          打包机当前运行的 node（process.execPath）
  runtime/NODE-LICENSE.txt
  app/server.mjs            server/standalone.ts 经 Vite SSR 打成的单文件
  app/config.json           { packServerUrl }
  app/build-info.json       { version, node, commit, dirty, builtAt }
  app/licenses/             打进 server.mjs 的服务端依赖许可证（hono、@hono/node-server）
  app/web/**                前端构建产物
```

2026-11-16 实测（版本 1.0.0、Node v22.20.0）：423 个文件，zip 54.3 MiB，解压后约 110 MiB。

## 固定源：`http://127.0.0.1:15173`，永远不许改

🔴 **IndexedDB 存档按源（协议 + 主机名 + 端口）隔离。** 换端口、换主机名、换 `http`/`https` 中任意一项，玩家打开的就是一个全新的空库 —— 在玩家看来就是「升级后存档全没了」。所以：

- 源固定为 `http://127.0.0.1:15173`（`server/standalone-app.ts` 的 `STANDALONE_ORIGIN`；`build-portable.mjs` 因 `.mjs` 不能直接 import TS 而抄了一份 `PORTABLE_URL`，两处必须一致）。
- `http://localhost:15173` 一律 **308 重定向** 到规范源，而不是同样放行 —— `localhost` 与 `127.0.0.1` 是两个源，放行就会出现两份存档。
- 只绑定 `127.0.0.1`，不对局域网开放。
- 升级 = 先关掉旧版本的命令行窗口，再解压新版本到任意文件夹并运行新的 `Start.bat`；源不变，存档自动保留。这也是升级不需要迁移工具的前提。
- 端口被占时，探测 `/api/status`（只读，**绝不结束任何进程**）：
  - `service` 字段是本 BFF 且响应头 `X-Poem-Engine-Version` 与自己的版本逐字相同 → 同一版本已在运行，只重新打开浏览器并以 0 退出（输出「已在运行」）。
  - 是本 BFF 但版本不同或没有该头 → 另一个版本（多半是升级前的旧版）还开着：中文提示「先关闭那个版本的窗口再重新运行」，退出码 1，**不开浏览器**（开了玩家看到的是旧版，会以为升级没生效）。
  - 其他情况 → 端口被别的程序占用，给 `netstat` 指引后以 1 退出。
  - 版本号来自 `app/build-info.json` 的 `version`（缺失或损坏时为 `unknown`）。版本头只由 `server/standalone-app.ts` 加在 `/api/status` 上，共享 BFF 的 `/api/status` 契约（dev / preview）不变。只比 version 不比 commit：同版本号的两份不同构建会被当成同一版本。
- `--no-open` 参数跳过自动开浏览器（冒烟测试用）。

将来如果真要换源，必须先做存档迁移方案（导出 → 新源导入的引导），不能只改常量。

## 如何构建

前提：Windows x64，仓库已 `npm ci`。zip 里的 `node.exe` 就是**打包机当前这个 node**，所以：

- 🔴 正式发布请用不低于 `.nvmrc`（目前 22.23.2）的 node 打包。低于时脚本只打警告、不拦截；2026-11-16 那次实测包用的是 v22.20.0，只能当内部测试包。
- node 安装目录里没有 `LICENSE` 时，脚本会从 GitHub（`raw.githubusercontent.com/nodejs/node/<版本>/LICENSE`）下载对应版本的许可证，需要联网。

```bash
# 内容中心服地址（只写 origin），写进 app/config.json，由本地 BFF 读取
npm run release:portable -- --pack-server-url https://packs.example.com
# 或用环境变量
POEM_PACK_SERVER_URL=https://packs.example.com npm run release:portable
# 确实不需要内容包功能时（游戏内无法登录取包）
npm run release:portable -- --no-pack-server
```

- 不给中心服地址、也不加 `--no-pack-server` 时脚本直接失败，避免误发一个拿不到内容的包。
- 🔴 便携版的中心服地址只走 `app/config.json`。用 Vite 自己的 `loadEnv`（前端构建所用的 production mode）判断：仓库根 `.env*` 在该 mode 下定义了 `VITE_PACK_SERVER_URL`（`KEY=value` 与 `KEY: value` 两种写法都算）时脚本拒绝打包（否则会被烧进前端产物，出现「前端直连 + BFF 代理」两套来源）。development mode 下或 shell 环境里有该值时不拦截，但构建后会扫一遍前端产物的 JS / HTML，出现该值就失败。
- `public/` 里被 git 忽略的文件不进包（`git ls-files -z` 按 NUL 切分，中文文件名不受 `core.quotepath` 转义影响）。2026-11-16 主检出实测：`public/audio/bgm/` 下 57 首本机 bgm mp3 因此不随包分发（授权未定）。
- 产物里不允许有 sourcemap，且必须含 `.wasm`（QuickJS 沙盒），否则脚本失败。
- 开发启动器（`dev.bat` / `dev.sh` / `dev.local.bat` / `update.bat` / `scripts/dev.mjs`）绝不进包：压缩前按文件名逐条比对（`findDevLaunchers`），命中即失败。玩家侧唯一入口是 `Start.bat`。

## 冒烟测试

```bash
node scripts/smoke-portable.mjs release/narrative-engine-v<版本>-win-x64.zip
```

模拟玩家「解压 → 双击」：

1. 15173 已被占用就直接失败（不碰占用者）。
2. 分别用系统 `tar.exe` 与 PowerShell `Expand-Archive` 解压到一个**带空格和中文**的临时目录，两份文件数必须一致，`使用说明.txt` 的中文文件名必须正确。
3. 在极简环境（`PATH` 只剩 System32、没有任何 node）里跑 `cmd /c Start.bat --no-open`，检查 30 秒内就绪、首页 / wasm 的 MIME 与魔数 / 缺失资源 404 / `/api/status` / 未知 API 404 JSON / 便携版写默认值返回 501 / `Origin: null` 被 403，以及再次启动时识别为「已在运行」、首个实例 stderr 为空。
4. 只结束自己启动的进程树，清理临时目录。任何一项 FAIL 退出码为 1。

检查共 14 项（2026-11-16 按脚本计数）。它是 Windows 专用、要真打一次 zip，不在 CI 里跑，发布前手动跑。

## 没有自动化的部分（发布前要人工做）

- **在没装 Node 的干净 Windows（虚拟机）上真机双击 `Start.bat`**：冒烟测试只是把 `PATH` 收窄，不等于真实的新机器。
- **SmartScreen**：zip 内文件带网络来源标记，首次运行可能弹蓝色提示；`使用说明.txt` 写了「更多信息 → 仍要运行」，实际弹窗样子没看过。
- **资源管理器「全部解压缩」**：冒烟用的 `Expand-Archive` 与它同源但不是同一个入口；另外还要看看在压缩软件预览窗口里直接双击时，`Start.bat` 的缺文件提示是否出现。
- **真实 Discord 登录 + 取包**：依赖中心服部署，见下面「已知限制」。

## 已知限制

- **没有背景音乐**：bgm 授权未定，不进包；游戏内音频面在便携版里是空的。是否随包分发要等授权裁定。
- **中心服必须把 `http://127.0.0.1:15173` 加进允许的前端 origin**，否则便携版玩家无法登录取包（开发期允许的是 `http://localhost:5173`，见 `docs/reference/discord-content-pack-client.md`）。
- **exe 未签名**：`node.exe` 是官方签名的，但整个包没有我们自己的代码签名，SmartScreen 会按「未知发布者」处理。代码签名是可选项，暂未做。
- **只支持 Windows x64**：打包与运行都是。Mac 产物见 `TODO.md`。
- **便携版不能「保存为默认」**：没有内容目录，`PUT /api/defaults/*` 返回 501。
- 自动更新不在范围内：升级靠玩家手动下载新 zip。
