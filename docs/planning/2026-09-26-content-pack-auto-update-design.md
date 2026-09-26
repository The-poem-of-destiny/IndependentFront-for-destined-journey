# 内容包自动更新 v1 设计（Release-only 加密分发）

> **状态：✅ 已实施（2026-09-26），端到端链路已验证。** 发布仓
> `The-poem-of-destiny/poem-dist` 已创建（release-only 公开仓）。当前最新 release =
> `v2.8.0`（14 个 agent，含 `combat_enemy`），引擎 `server/content-pack-release.ts`
> 对真实 GitHub 拉取 → 解密 → 解压 → 解析成功（15 本世界书 / 14 个 agent）。
> 📌 同日更正：首个 release 是 `v2.7.5`，但它是 2026-09-11 构建的旧包（仅 13 个 agent，
> 缺 `combat_enemy`），已用 `v2.8.0` 取代（旧 release 保留备查，不影响 `latest` 取值）。
> **未做**：设置页「检查更新」按钮的 UI 真机走查。

## 1. 背景与目标

内容包（世界书 / 提示词 / 预设 / 目录）由私有内容仓 `fated_poem_independent_assets`
构建，今天靠**手动**把 `dist/fated-poem-pack-<ver>.json` 交给玩家导入。
本设计给一个「检查更新 → 一键拉取 → 自动装/升级」的闭环。

难点是**内容仓不能公开**，而玩家又需要一个公开可拉取的地址。方案：新建一个
**release-only 公开仓**（仓内无源码，只有 Release 资产），把内容包压成
**加密二进制 blob** 放进去，避开明文索引与随手举报。

## 2. 威胁模型（🔴 先想清楚，决定加密做多强）

**只求「不明文 / 不被自动扫描 / 不扎眼」**，不追求访问控制。
因此：密钥（AES-256）内嵌在公开源码里 —— 这是**纯混淆**，开 devtools / 读仓
源码的有心人仍可取出密钥解密。真正保密必须服务端持钥，那与
「public release-only」的前提直接冲突。

> 结论：**不要**用这套机制保护 API key 或任何真机密。它挡的是 GitHub 自动
> 内容索引和路过的举报者，不是定向获取。

## 3. 方案形状（三块）

```
私有内容仓 tools/build-release.mjs
   pack.json ──gzip──► AES-256-GCM ──► pack.bin + manifest.json
        │                                      │
        │                            gh release create（独立公开仓）
        ▼                                      ▼
引擎仓 BFF  /api/content-pack/{latest,blob}
   GitHub API 取最新 release → 下 blob → 校验 sha256 → 解密 → 解压 → 明文
        │
        ▼
前端 lib/content-pack-updater.ts → 既有 installPack / upgradePack（两阶段确认）
```

### 3.1 为什么加解密在服务端而不是浏览器

1. **密钥不进前端 bundle** —— 少一处泄漏面（虽然诚实地讲，服务端源码同样公开）。
2. **绕开 GitHub Releases 的 CORS**：`github.com/.../releases/download/...` 会 302 到
   `release-assets.githubusercontent.com`，**实测 2026-09-26：302 与最终 200 都不带
   `Access-Control-Allow-Origin`**，浏览器 `fetch` 必被拦（只有 `api.github.com`
   的元数据接口带 ACAO）。服务端 fetch 无此限制。
3. Node 的 `node:crypto` 比 Web Crypto 简单。

### 3.2 密文与清单格式

`pack.bin` 布局：

```
nonce(12 bytes) || AES-256-GCM(gzip(utf8(JSON))) || authTag(16 bytes)
```

`manifest.json`（明文，**刻意极小且不含任何世界观文字** —— 它会被 GitHub 明文索引）：

```jsonc
{
  "formatVersion": 1,
  "packId": "fated-poem-official",
  "packVersion": "4.3.2",
  "minEngineVersion": "1.0.0",
  "name": "…", // 可选
  "size": 1234567, // gzip 后、加密前的字节数
  "plainSha256": "…", // sha256(gzip(JSON)) —— 解密后校验
  "blobSha256": "…", // sha256(密文) —— 下载后、解密前校验
}
```

两道 sha256 校验：先验密文（防投毒 / 发布仓误覆盖），再验明文（防清单与内容不符）。

## 4. 路由与常量契约

服务端 `server/content-pack-release.ts`：

- `DEFAULT_PACK_REPO = 'The-poem-of-destiny/poem-dist'` —— **占位**，建好独立仓后用
  环境变量 `POEM_PACK_REPO=owner/repo` 覆盖，或直接改默认值。
- `PACK_BLOB_KEY_B64` —— 内嵌密钥，**必须与私有仓 `tools/build-release.mjs` 的
  `FALLBACK_KEY_B64` 逐字一致**（可分设 `POEM_PACK_KEY_B64` 覆盖，但两处要同步）。
- 🔴 **只从 env/常量解析仓坐标与密钥，绝不接受请求参数里的 URL/仓库** ——
  本模块是 BFF 服务端出站 fetch 的唯一入口，放任 URL 进来即 SSRF。
- 资产下载额外校验主机白名单（`github.com` / `*.githubusercontent.com` 等）。

BFF 两条只读路由（`server/routes/content-pack.ts`）：

| 路由                           | 行为                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/content-pack/latest` | 无发布版本 → `{ok:true,available:false}`；有 → `{ok:true,available:true,tag,packVersion,…}`；错误 → 502 `{ok:false,error}` |
| `GET /api/content-pack/blob`   | 无版本 → 404；成功 → 解密后的明文 pack JSON + `X-Pack-Version` 头；错误 → 502                                              |

前端 `src/ui/lib/content-pack-updater.ts` 是纯 fetch 包装（判别联合永不抛穿）：
`checkPackUpdate(currentVersion)` 比版本、`downloadLatestPack()` 取明文，交给
DataSection 既有的 `runInstall` —— 同 packId 自动走升级 diff 两阶段确认，
**不新开安装路径**。版本比较复用引擎 `semverGte`（全仓唯一一份）。

## 5. 发布流程（私有仓）

```powershell
node tools/build-pack.mjs --version 4.3.2 --engine-version 1.0.0
node tools/build-release.mjs --tag v4.3.2 --upload   # 或去掉 --upload 看手动指引
```

`--upload` 走 `gh release create <tag> --repo <独立仓> pack.bin manifest.json`。
Release 资产名固定为 `manifest.json` / `pack.bin`，tag 约定 `v<packVersion>`。

## 6. 已知取舍与待办

- ✅ **端到端已验**（2026-09-26）：发布仓 `The-poem-of-destiny/poem-dist` 已建，当前最新
  release `v2.8.0`（`pack.bin` + `manifest.json`，14 个 agent），引擎服务端模块对真实
  GitHub 拉取/解密成功。**剩下**：设置页「检查更新」按钮的 UI 真机走查。
  - 📌 首个 release `v2.7.5` 是 2026-09-11 构建的旧包（13 agent），同日已用 `v2.8.0` 取代；
    旧 release 保留。🔴 发版前务必确认 `build-pack` 自检的 agent 数（现为 14）与私仓
    `data/defaults/agent-config.json` 一致，别直接抓 `dist/` 里的旧包发。
- **只有 JSON 内容包**：图片 / 音频 / 地图底图**不在** pack 里，本机制不覆盖它们。
  若将来要让 pack 里的 §14 `remoteAssets` 指向 GitHub Release 资产，**图片同样会被 CORS 挡**，
  得一起走 BFF 或换有 CORS 的图床。
- **密钥即混淆**：见 §2。轮换密钥 = 两仓同步改，旧 blob 立即失效（预期）。
- **无发布者签名**：目前靠 sha256 完整性校验；公开仓被投毒时客户端会拒装（校验失败），
  但**不能**证明发布者身份。要更强可后续加 Ed25519（公钥内嵌、私钥只在发布机）。
- **Release 资产镜像**：GitHub 侧可被删除/替换；客户端每次下载都校验密文 sha256，失败即报错不装。
