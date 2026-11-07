# Discord 登录鉴权与内容包受控分发设计 v1（账户绑定 + 寿命控制 + 客户端密文存储与运行时解密）

> **状态**：设计定稿（待实施）
> **前置关联**：
>
> - `docs/planning/2026-08-05-content-engine-separation-design.md`（内容-引擎分离 v1.3）
> - `docs/planning/2026-09-26-content-pack-auto-update-design.md`（内容包自动更新 v1，本设计实施后其「免登录公开直拉 + 源码内嵌密钥」通道由本方案正式接管替换）

---

## 0. 核心决策速览（已确认边界）

| 维度                           | 裁定结论                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **服务端拓扑与落位**           | **独立远端中心服 + 本地前端对接**。玩家在本地运行前端，向公网部署的中心服务端发起 Discord OAuth2 登录验证与内容包请求；在本仓新增独立服务端模块目录 `pack-server/`（共用 TypeScript / Hono 工具链，可独立部署）。                                                                                                                                       |
| **Discord 准入条件**           | **指定 Discord 服务器（Guild）成员 + 指定身份组（Role）**。校验用户已加入目标 Guild 且拥有配置的目标 Role ID（未配置 Role ID 时退化为仅校验是否入群；支持可选 UID 黑白名单）。                                                                                                                                                                          |
| **账户绑定与寿命控制**         | **强绑定获取账号（`boundUserId`）+ 有效期寿命（`expiresAt`）**。某 Discord 账号获取的内容包只能由**当前登录了同一 Discord 账号且在有效期内**的客户端解密运行；未登录、切换其他账号或寿命到期时自动锁定并回落至演示占位内容。                                                                                                                            |
| **客户端密文存储与运行时解密** | **磁盘全密文（Encrypted at Rest）+ 运行时内存解密（Decrypted in Memory Only）**。客户端 IndexedDB 仅存储 AES-256-GCM 加密信封（`EncryptedPackEnvelope`），不落盘任何明文世界书/预设/提示词；运行时使用下载时分发的密钥材料结合当前登录账号 ID 动态派生解密密钥，在内存中解密并挂载全量内容。                                                            |
| **客户端自动续期 / 重新验证**  | **后台静默自动续期 + 实时资格重验（零流量信封重封装）**。采用双层信封加密（`DEK` 加密内容包本体，`KEK(boundUserId, expiresAt)` 封装 32B `DEK`）；客户端在启动、临期定时、页面唤醒及联网恢复时自动调用 `/api/v1/pack/renew` 向 Discord 重验资格并刷新 60B `wrappedDekB64` 与 `expiresAt`，无需重下数 MB 内容包；若验证发现已退群或失去身份组则立即锁定。 |
| **旧通道与离线导入**           | **替换免登录在线拉取，保留本地文件导入**。在线「检查更新 / 获取内容包」统一收口为需 Discord 登录验证；保留设置页手动选择本地 `.json` 文件导入作为开发与离线兜底。                                                                                                                                                                                       |

---

## 1. 背景与威胁模型升级

### 1.1 现状问题与两个必须闭合的明文缺口

1. **分发侧缺口**：在 `2026-09-26-content-pack-auto-update-design.md`（自动更新 v1）中，内容包通过公开仓库 `poem-dist` 分发，AES-256-GCM 密钥 `PACK_BLOB_KEY_B64` 硬编码在公开仓库 `server/content-pack-release.ts` 中，仅防自动索引，不具备访问控制能力。
2. **客户端落盘侧缺口（关键发现）**：现有 `src/ui/stores/content-store.ts` 的 `applyInstall()` 在安装内容包时，会将明文整包 `payload: pack` 写入 IndexedDB 的 `contentPacks` 表，并将 `pack.worldBooks`（16 本世界书）和 `pack.presets`（Story 预设）以**明文**写入 `db.worldBooks` 与 `db.presets` 表。
   - 若不改造此落盘路径，即便下载过程加密、即便用户退出登录或内容包过期，`db.worldBooks` 与 `db.presets` 中的明文依然留在浏览器磁盘上并继续被游戏读取，且会被 `exportAllData`（整库备份）明文导出。

### 1.2 新威胁模型与安全目标

1. **机密彻底离树**：Discord `CLIENT_SECRET`、会话签名密钥 `SESSION_SECRET`、内容包主密钥 `PACK_MASTER_KEY` 及内容包源文件全部仅存在于远端中心服私有环境中。
2. **密码学级账户绑定与寿命约束**：
   - 内容包密文在服务端下发时，通过 `HKDF-SHA256` 与 `AES-256-GCM AAD（附加认证数据）` 将 **目标用户 Discord ID (`boundUserId`)** 与 **到期时间戳 (`expiresAt`)** 焊死在密文与密钥派生链中。
   - 任何跨账号使用、未登录使用、或在本地数据库篡改 `boundUserId` / `expiresAt` 的行为，均会导致 Web Crypto `AES-GCM` 认证标签校验失败，无法解出明文。
3. **客户端静态零明文（Zero Plaintext at Rest）**：
   - IndexedDB `contentPacks` 表仅存储加密信封 `EncryptedPackEnvelope`。
   - 内容包所属的 `worldBooks`、`presets` 与其余 12 个分节一样，全部改为**运行时内存叠加层（Runtime Memory Overlay）**，仅在当前账号验证通过且解密成功后驻留内存，绝不写入 `db.worldBooks` / `db.presets` 磁盘表，亦绝不进入存档/整库备份导出。

---

## 2. 总体架构与通信拓扑

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 玩家本地环境（公开引擎仓：Browser 前端 + 可选本地 BFF `server/`）            │
│                                                                              │
│  ┌────────────────────────────────────┐    ┌──────────────────────────────┐  │
│  │ 前端 UI 与运行时解密/自动续期层     │    │ 本地 BFF (`server/routes/`)  │  │
│  │ - discord-auth-client.ts (会话/租约)│    │ - `/api/content-pack/*`      │  │
│  │ - pack-crypto.ts (WebCrypto 解密)  │───►│   同源透传转发至远端中心服   │  │
│  │ - content-store.ts (密文落库+续期)  │    │ - 不持有任何密钥与机密配置   │  │
│  │ - worldbook-store / usePresets     │    └──────────────┬───────────────┘  │
│  │   (运行时内存 Overlay 合成视图)    │                   │                  │
│  └─────────────────┬──────────────────┘                   │                  │
└────────────────────┼──────────────────────────────────────┼──────────────────┘
                     │ 1. OAuth2 弹窗登录 / postMessage     │ 2. 携带 Bearer Token
                     ▼                                      ▼    请求验证/密文包/自动续期
┌──────────────────────────────────────────────────────────────────────────────┐
│ 公网独立远端中心服（`pack-server/`，私有部署、持有全部机密环境变量）         │
│                                                                              │
│  ┌────────────────────────────────────┐    ┌──────────────────────────────┐  │
│  │ Discord 认证与资格核验模块          │    │ 专属信封加密与自动续期模块    │  │
│  │ - OAuth2 Code 换取 Access Token    │    │ - 派生 DEK 与 KEK(User, TTL) │  │
│  │ - 查验 Guild 成员与 Role 列表       │    │ - 封装 AES-256-GCM 双层信封  │  │
│  │ - 签发无状态加密会话令牌 (Sealed)   │    │ - /renew 60B wrappedDEK 续期 │  │
│  └─────────────────┬──────────────────┘    └──────────────┬───────────────┘  │
└────────────────────┼──────────────────────────────────────┼──────────────────┘
                     │ HTTPS                                │ 本地磁盘 / 私有 Release
                     ▼                                      ▼
           ┌───────────────────┐                  ┌───────────────────────┐
           │ Discord API v10   │                  │ 私有内容包源          │
           │ - /oauth2/token   │                  │ - 预压缩 gzip 常驻内存│
           │ - /users/@me/...  │                  │ - 按请求毫秒级专属加密│
           └───────────────────┘                  └───────────────────────┘
```

---

## 3. 内容包寿命、账户绑定与运行时加解密机制（核心密码学设计）

### 3.1 为什么采用「双层信封加密（DEK + 账户/寿命绑定的 Wrapped DEK）」

要同时满足以下五项要求：

1. **下载时分发密钥，客户端运行时用该密钥解密**；
2. **此账号获取的内容包只能由登录了此账号的客户端运行**；
3. **内容包具有寿命（TTL），到期后不可继续运行且本地不可篡改延期**；
4. **客户端支持后台自动续期 / 自动重新验证，且续期时无需重新下载数 MB 的内容包本体**；
5. **服务端保持零数据库无状态**；

我们采用标准密码学 **信封加密（Envelope Encryption：确定性用户数据密钥 `DEK` + 绑定账户与寿命的密钥加密密钥 `KEK`）**：

```text
[服务端主密钥 PACK_MASTER_KEY (32B, 仅存中心服环境变量)]
   │
   ├── 1. 派生账户专属内容数据密钥 DEK (32B, 服务端与客户端均不落盘明文)：
   │      DEK = HKDF-SHA256(
   │        ikm  = PACK_MASTER_KEY,
   │        salt = "${packId}:${packVersion}",
   │        info = "poem-user-dek-v1|${boundUserId}"
   │      )
   │      └── 用 DEK 加密 500KB 预压缩内容包本体：
   │          ciphertextB64 = AES-256-GCM(
   │            key = DEK, iv = bodyNonce12B, plaintext = gzippedPackBytes,
   │            aad = "dps-pack-body-v1|${packId}|${packVersion}|${boundUserId}"
   │          )
   │
   └── 2. 派生分发密钥种子 distributedKey (32B, 随 KeyLease 下发给客户端)：
          distributedKey = HKDF-SHA256(
            ikm  = PACK_MASTER_KEY,
            salt = "${packId}:${packVersion}",
            info = "poem-dist-key-v1|${boundUserId}"
          )
             │
             ├─ 二级派生：结合「当前登录 Discord User ID」与「到期时间 expiresAt」派生 KEK (32B)：
             │  KEK = HKDF-SHA256(
             │    ikm  = distributedKey,
             │    salt = "${packId}:${packVersion}",
             │    info = "poem-pack-kek-v1|${currentSession.user.id}|${expiresAt}"
             │  )
             ▼
          封装/解封 32B DEK（仅 60 字节：12B wrapNonce + 32B encDEK + 16B tag）：
          wrappedDekB64 = AES-256-GCM(
            key = KEK, iv = wrapNonce12B, plaintext = DEK,
            aad = "dps-pack-wrap-v1|${packId}|${packVersion}|${boundUserId}|${expiresAt}"
          )
```

### 3.2 安全性、防篡改与零流量自动续期原理

1. **跨账号拷贝失效**：
   - 账号 A 下载的内容包中，`boundUserId = "AAA"`。
   - 若拷贝给登录了账号 B（`currentSession.user.id = "BBB"`）的客户端：客户端用 `"BBB"` 参与二级 HKDF 派生出的 `KEK` 与 `"AAA"` 完全不同，连第一层 `wrappedDekB64`（60 字节）都无法通过 `AES-GCM` 认证解封，更无法获得 `DEK` 解密内容包本体。
2. **本地篡改寿命（`expiresAt`）或篡改绑定账号（`boundUserId`）失效**：
   - `boundUserId` 与 `expiresAt` 同时焊入 `KEK` 的 `HKDF info` 以及 `wrappedDekB64` 的 `AES-GCM AAD`。
   - 用户若在浏览器 DevTools 中将 IndexedDB 里的 `expiresAt` 改大或修改 `boundUserId`，`KEK` 与 `AAD` 立即失配，`crypto.subtle.decrypt` 直接抛出 `OperationError`。
3. **后台自动续期仅需 < 1 KB 流量（免重下内容包本体）**：
   - 因为 500 KB 的内容包本体 `ciphertextB64` 是由与 `(packId, packVersion, boundUserId)` 绑定的 `DEK` 加密的，而寿命 `expiresAt` 绑定在外层的 60 字节 `wrappedDekB64` 上：
   - 当客户端后台自动续期时（`POST /api/v1/pack/renew`），服务端向 Discord 实时核验该用户仍在群且保有身份组后，生成新的 `expiresAt`，用新 `KEK` 重新封装出一个新的 **60 字节 `wrappedDekB64`** 下发给客户端。
   - 客户端仅需更新 IndexedDB 中的 `{ expiresAt, wrapNonceB64, wrappedDekB64 }` 与本地 `keyLease`，**完全不需要重新下载数 MB 的内容包本体**！
4. **防本地系统时钟回拨（Clock Rollback Mitigation）**：
   - 服务端每次响应 `/verify`、`/latest`、`/blob`、`/renew` 时均返回权威时间戳 `serverTime`（epoch ms）。
   - 客户端持久化记录 `clockOffset = serverTime - Date.now()` 与单调递增的最高已观测时间水线 `maxObservedTime`。
   - 判定寿命采用 `effectiveNow = Math.max(Date.now() + clockOffset, maxObservedTime)`，离线回拨系统时间无法绕过过期锁。

### 3.3 加密信封与密钥租约数据结构

```ts
/**
 * 持久化在客户端 IndexedDB `contentPacks` 表中的加密内容包信封。
 * 磁盘上不包含任何明文世界书、提示词、预设或目录数据。
 */
export interface EncryptedPackEnvelope {
  formatVersion: 1;
  packId: string;
  packVersion: string;
  minEngineVersion?: string;
  name?: string;
  /** 绑定获取该包的 Discord User ID */
  boundUserId: string;
  /** 服务端签发时间戳（epoch ms） */
  issuedAt: number;
  /** 内容包寿命截止时间戳（epoch ms，自动续期时随 wrappedDekB64 一并刷新） */
  expiresAt: number;
  /** 解封 DEK 用的 12 字节随机 IV（Base64） */
  wrapNonceB64: string;
  /** 经 KEK(boundUserId, expiresAt) + AAD_wrap 加密后的 32B DEK + 16B Tag（Base64，共 48B） */
  wrappedDekB64: string;
  /** 解密内容包本体用的 12 字节随机 IV（Base64） */
  bodyNonceB64: string;
  /** 经 DEK + AAD_body 加密后的 gzip(utf8(JSON)) 密文 + 16B Tag（Base64） */
  ciphertextB64: string;
  /** 解密后、解压前的 gzip 字节 SHA-256 十六进制摘要 */
  plainSha256: string;
}

/**
 * 下载或续期时由服务端分发的密钥租约（随当前登录会话存储，退出登录即销毁）。
 */
export interface PackKeyLease {
  packId: string;
  packVersion: string;
  /** 绑定的 Discord User ID（必须与当前登录用户及 Envelope 一致） */
  boundUserId: string;
  /** 服务端分发的一级派生密钥材料（32 字节 Base64） */
  distributedKeyB64: string;
  /** 签发时间戳（epoch ms） */
  issuedAt: number;
  /** 密钥租约到期时间戳（epoch ms，与 Envelope.expiresAt 对齐） */
  expiresAt: number;
}
```

### 3.4 性能评估：服务端按请求实时加密的开销

- 服务端在启动或内容包更新时，预先读取明文 `pack.json`（约 2.5~~3 MB）并执行一次 `gzipSync`，将压缩后的字节流 `gzippedPackBytes`（约 400~~600 KB）常驻内存。
- 初次下载 `GET /api/v1/pack/blob` 时，Node.js 对 500 KB `gzippedPackBytes` 执行一次 `AES-256-GCM` 耗时 **< 1 毫秒**；
- 自动续期 `POST /api/v1/pack/renew` 时，仅对 32 字节的 `DEK` 执行一次 `AES-256-GCM` 封装，耗时 **< 0.05 毫秒**，响应体不足 600 字节。

---

## 4. 客户端密文存储与运行时内存叠加层（Runtime Memory Overlay）实现

### 4.1 IndexedDB `contentPacks` 表结构演进（`src/core/persistence/database.ts`）

无需破坏既有表主键（仍以 `packId` 为主键），扩展 `ContentPackRecord` 支持密文存储态：

```ts
export interface ContentPackRecord {
  packId: string;
  packVersion: string;
  installedAt: number;
  /**
   * 在线获取的受保护内容包：仅存加密信封，不存明文 payload。
   */
  encryptedEnvelope?: EncryptedPackEnvelope;
  /**
   * 绑定账户 ID（提升至顶层字段便于未解密时 UI 直接展示绑定归属）
   */
  boundUserId?: string;
  /**
   * 内容包寿命到期时间戳（epoch ms，提升至顶层便于未解密时直接判过期）
   */
  expiresAt?: number;
  /**
   * 仅本地离线手动导入（开发调试用 `.json`）才存明文 payload；
   * 在线经 Discord 验证获取的内容包此字段恒为 undefined。
   */
  payload?: ContentPack;
  sectionHashes?: Readonly<Record<string, string>>;
  notes?: unknown[];
}
```

### 4.2 全分节「仅内存明文」挂载机制（闭合 `db.worldBooks` 与 `db.presets` 明文落盘漏洞）

现有引擎中，内容包的 14 个分节里已有 12 个分节（`agents`、`beautifierRules`、`catalog`、`locations`、`bloodlines`、`namePools`、`markers`、`branding`、`imageDialects`、`mapPack`、`randomEvents`、`remoteAssets`）是纯内存 Provider 模式。
本次将剩余的 **`worldBooks`** 与 **`presets`** 统一收口为**运行时内存叠加层（Memory Overlay）**：

1. **`worldbook-store.ts` 内存叠加层改造**：
   - 新增内部状态 `packOverlayBooks = shallowRef<WorldBook[]>([])`（仅驻内存，绝不调用 `db.worldBooks.bulkPut`）。
   - `db.worldBooks` 磁盘表仅存放：内置演示占位书（Placeholder）、玩家自建书、创意工坊安装的书。
   - 当加密内容包在运行时解密激活时，调用 `wbStore.setPackOverlayBooks(decryptedPack.worldBooks)`：
     - `worldbook-store.books`（对外暴露的响应式视图）将内存中的 `packOverlayBooks` 叠加在同 ID 占位书之上（保留用户自建书与工坊书）。
   - 当未登录、切换账号、退出登录或内容包过期锁定时，调用 `wbStore.setPackOverlayBooks([])`：
     - 内存中的真实世界书立即卸载，`worldbook-store.books` 自动回退为磁盘上的演示占位书。
   - **唯一一处绕过 store 直读 `db.worldBooks.get(id)` 的引擎点修复**：
     - `src/core/combat/sandbox/protocol.ts:60` 改为优先从运行时内容包世界书读取器查询，未命中再查 `db.worldBooks.get(id)`。

2. **`usePresets.ts` 内存叠加层改造**：
   - 新增内部状态 `packOverlayPresets = shallowRef<ChatPreset[]>([])`（仅驻内存，绝不写入 `db.presets`）。
   - 解密激活时注入 `pack.presets`，锁定或卸载时清空，自动切回占位预设。

3. **整库备份与会话备份（`database.ts` / `session-backup.ts`）零泄漏**：
   - 因为 `db.worldBooks` 与 `db.presets` 磁盘表不再写入加密内容包的明文数据，玩家执行「导出全部数据」时导出的备份天然不含加密内容包中的任何世界书或预设明文。
   - `reconcilePackState()` 与 `session-backup.ts` 读取当前已激活内容包时，统一通过运行时内存解密后的 `getActivePackPayload()` 读取。

---

## 5. 客户端自动续期与自动重新验证机制（Auto-Renewal & Auto-Reverification）

### 5.1 设计原则：对合规玩家完全无感，对撤权玩家即时收敛

- **无感续期**：只要玩家保持 Discord 登录态，且仍在目标服务器内并保有身份组，客户端会在后台**自动完成 Discord 资格重验与内容包寿命续期**，正常游玩全程零弹窗、零中断、无需手动点按钮。
- **宽限降级（Graceful Retry within TTL）**：在内容包寿命**尚未真正到期**前的预续期窗口内，若遇短暂断网或 Discord 接口 5xx 抖动，客户端**不提前中断玩家当前已解密的内存运行态**，而是后台指数退避重试；直到真正越过 `expiresAt` 且仍无法完成验证时才执行锁定。
- **权限撤销即时锁定**：若后台自动重新验证收到服务端明确的 `403`（`NOT_IN_GUILD` / `MISSING_REQUIRED_ROLE` / `USER_BLOCKED`），客户端**不必等到 `expiresAt` 自然到期**，立即撤销内存中的内容包明文并锁定回退至占位态。

### 5.2 四个自动触发时机（`pack-lease-scheduler.ts`）

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                   客户端自动续期 / 重新验证调度器                          │
├──────────────────┬──────────────────┬──────────────────┬───────────────────┤
│ 1. 启动水合钩子  │ 2. 后台定时巡检  │ 3. 页面唤醒/联网 │ 4. 登录与回合前守卫│
│ hydratePackState │ 每 15min + 临期  │ visibilitychange │ 登录完成自解锁 /  │
│ 过期阻塞式自续期 │ 唤醒定时器       │ & online 事件    │ 回合前临期非阻塞续│
└────────┬─────────┴────────┬─────────┴────────┬─────────┴─────────┬─────────┘
         └──────────────────┴─────────┬────────┴───────────────────┘
                                      ▼
                     POST /api/content-pack/renew (单飞去重)
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         ▼ 200 OK                     ▼ 403 权限被撤 / 401 失效    ▼ 网络异常 / 5xx
┌──────────────────────┐    ┌──────────────────────────┐  ┌───────────────────────┐
│ · 更新 wrappedDekB64 │    │ · 立即 lockActivePack()  │  │ · 未超 expiresAt：    │
│ · 更新 expiresAt     │    │ · 清空内存世界书/预设    │  │   保持内存运行 + 退避 │
│ · 更新 keyLease/Token│    │ · 若原处于锁定则报明确原因│  │ · 已超 expiresAt：    │
│ · 若原已锁定则自解锁 │    └──────────────────────────┘  │   进入 LOCKED_EXPIRED │
└──────────────────────┘                                  └───────────────────────┘
```

1. **时机一：应用启动水合时（`hydratePackState()` 自动恢复与预续期）**
   - **已过期或丢租约时自动阻塞续期（Boot Auto-Recovery）**：
     - 启动时若检测到 IndexedDB 中有 `EncryptedPackEnvelope`，且本地已登录同一 Discord 账号（`session.user.id === envelope.boundUserId`），但 `effectiveNow >= envelope.expiresAt` 或本地缺失 `keyLease`：
     - 客户端自动调用一次 `POST /api/content-pack/renew`：
       - 若续期成功 → 将返回的新 `wrappedDekB64`、`expiresAt` 写回 IndexedDB `contentPacks` 表，保存新 `keyLease` 与新 `sessionToken`，立即在内存解密激活内容包（玩家打开应用直接进入完整内容态，无需去设置页操作）。
       - 若续期失败 → 进入对应的 `LOCKED` 状态并回落占位内容。
   - **未过期但进入临期窗口时后台静默预续期（Boot Pre-emptive Renewal）**：
     - 启动时若 `effectiveNow < envelope.expiresAt`，先直接用本地 `keyLease` 在内存解密挂载（**零网络等待，保证毫秒级启动**）；
     - 若剩余寿命 `envelope.expiresAt - effectiveNow <= RENEW_AHEAD_WINDOW_MS`（默认当剩余寿命低于总寿命的 `25%` 或少于 `48 小时`），则在启动完成后异步发起后台 `renew`。

2. **时机二：运行期后台定时巡检（Background Periodic & Deadline Timer）**
   - 内容包解锁运行期间，调度器维护两个定时器：
     - **周期性复验与预续期心跳（默认每 15 分钟）**：检查当前是否已进入预续期窗口（剩余寿命 `<= 25% TTL`）或距离上次服务端验证 `verifiedAt` 已超过复验周期；满足则静默触发 `renew`。
     - **到期精准唤醒定时器**：根据 `msUntilExpiry = envelope.expiresAt - effectiveNow` 设定定时器（提前 5 分钟触发最后一次续期尝试；若到点仍未续期成功，准时触发 `lockActivePack('EXPIRED')`）。

3. **时机三：标签页唤醒与网络恢复钩子（`visibilitychange` & `online`）**
   - 监听 `document.addEventListener('visibilitychange')`（切回前台且距上次检查 `>= 5 分钟`）与 `window.addEventListener('online')`（断网恢复）：
   - 若当前内容包处于**临期预续期窗口**，或此前因离线导致处于 **`LOCKED_EXPIRED`** 状态，立即自动触发一次 `renew`；一旦网络恢复且验证通过，自动在内存中重新解密并无缝恢复 `pack` 状态。

4. **时机四：Discord 登录成功联动与回合执行前守卫**
   - 当玩家在未登录或切换账号后重新登录 Discord，若本地 IndexedDB 已存有绑定该账号的 `EncryptedPackEnvelope`，登录回调落地后自动执行 `renewAndUnlock()`，无需玩家再点「解锁」或「重新下载」。
   - 在 `game-pipeline` 每回合开始前执行 `ensurePackLeaseActive()`：若已越过 `expiresAt` 且后台续期未通过，立即拦截并回退占位态。

### 5.3 单飞锁与指数退避策略（Single-Flight & Backoff）

- **单飞去重（`inFlightRenewPromise`）**：同一时刻无论多个触发源（如 `online` 与 `visibilitychange` 同时触发）调用 `renewPackLease()`，均复用同一个进行中的 Promise，绝不并发打服务端。
- **网络故障退避**：当因网络断开或上游 `502/429` 失败时，按 `1 min → 5 min → 15 min` 指数退避重试；一旦收到 `401` 或 `403`（明确无权限），立即停止自动重试并锁定内容包，直至用户主动点击「重新登录」或「重新验证资格」。

---

## 6. Discord 登录与准入验证流程设计

### 6.1 OAuth2 Scope 选择与零 Bot 强校验机制

- **请求 Scope**：`identify guilds.members.read`
- **核验端点**：使用用户授权所得的 OAuth2 `access_token` 直接调用 Discord API v10：
  - `GET https://discord.com/api/v10/users/@me/guilds/{DISCORD_GUILD_ID}/member`
  - **返回值判定**：
    1. 若 HTTP 状态码为 `404`（Discord 错误码 `10004 Unknown Member`）→ 判定为 **`NOT_IN_GUILD`**（未加入指定服务器）。
    2. 若 HTTP 状态码为 `200`，返回 Guild Member 对象（内含 `user` 及 `roles: string[]`）：
       - 比对 `member.roles` 与服务端配置的 `DISCORD_REQUIRED_ROLE_IDS`；
       - 若未命中所需身份组 → 判定为 **`MISSING_REQUIRED_ROLE`**；
       - 若命中（或服务端未配置 `DISCORD_REQUIRED_ROLE_IDS`）→ 判定为 **`ELIGIBLE`（验证通过）**。
- **可选 Bot Token 增强**：若中心服额外配置了 `DISCORD_BOT_TOKEN`，在续期/下载复验时也可通过 `GET /guilds/{guild.id}/members/{user.id}` 实时查询。

### 6.2 为什么 OAuth2 `redirect_uri` 固定指向远端中心服

玩家在本地运行前端时，Origin 可能是 `http://localhost:5173`、`http://127.0.0.1:4173` 或自托管地址，无法在 Discord Developer Portal 中穷举注册。
因此：

- Discord OAuth2 的 `redirect_uri` **唯一固定**为远端中心服地址：`https://<pack-server-domain>/api/v1/auth/discord/callback`。
- 本地前端通过**弹窗（Popup）+ `window.opener.postMessage` + `attemptId` 轮询双通道兜底**接收中心服签发的会话令牌，彻底解耦玩家本地运行端口与 Discord 后台回调白名单。

### 6.3 无状态自包含会话令牌（Sealed Session Token）

为保证远端中心服**零数据库依赖**（无需 Redis / MySQL，单进程或容器即可无状态部署），中心服采用 `HMAC-SHA256 + AES-256-GCM` 组合封装会话令牌：

- **Token 格式**：`dps1.<base64url(payloadJson)>.<base64url(hmacSha256)>`
- **Payload 结构**：

```ts
export interface PackServerSessionPayload {
  /** 令牌格式版本 */
  v: 1;
  /** Discord User ID */
  sub: string;
  /** Discord 用户名 (username) */
  username: string;
  /** Discord 显示昵称 (global_name / guild nick) */
  displayName: string;
  /** Discord 头像完整 URL 或 null */
  avatarUrl: string | null;
  /** 验证针对的 Discord Guild ID */
  guildId: string;
  /** 当前验证状态 */
  accessStatus: 'eligible' | 'not_in_guild' | 'missing_role' | 'blocked';
  /** 签发时间戳（秒） */
  iat: number;
  /** 过期时间戳（秒，默认 7 天） */
  exp: number;
  /** 上次向 Discord 实时核验 Guild/Role 的时间戳（秒） */
  verifiedAt: number;
  /**
   * 经中心服 SESSION_SECRET (AES-256-GCM) 加密的 Discord OAuth access_token。
   * 客户端无法解密；中心服用于「自动续期 / 重新验证资格」时实时向 Discord 复核权限，免除玩家重复弹窗授权。
   */
  sealedDiscordToken: string;
}
```

---

## 7. 远端中心服设计（`pack-server/`）

### 7.1 目录结构

在本仓新增 `pack-server/`（纳入 `tsconfig.tools.json` 与 Vitest 测试网，与本地 `server/` 解耦）：

```text
pack-server/
├── index.ts                  # 独立启动入口（@hono/node-server 监听端口，读取环境变量）
├── app.ts                    # buildPackServerApp(config) —— 纯 Hono 实例工厂（便于单测注入）
├── config.ts                 # 环境变量解析与校验（启动期快速失败）
├── crypto-session.ts         # state 签发/核验、Sealed Session Token 签发/验签/加解密
├── crypto-pack.ts            # 信封加密：DEK/KEK 派生 (HKDF-SHA256)、DEK 封装与内容包加密 (AES-256-GCM)
├── discord-client.ts         # Discord OAuth2 token 交换与 /users/@me/guilds/{id}/member 查询
├── pack-provider.ts          # 内容包读取与预压缩缓存（支持 local 目录模式与 github 私有源模式）
└── routes/
    ├── auth.ts               # /api/v1/auth/discord/{login,callback,result,verify,logout}
    └── pack.ts               # /api/v1/pack/{latest,blob,renew}（受 Bearer Token + eligible 守卫保护）
```

### 7.2 远端中心服环境变量契约（`pack-server/config.ts`）

| 环境变量名                  | 必填          | 默认值 / 示例                 | 说明                                                                           |
| --------------------------- | ------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `PACK_SERVER_PORT`          | 否            | `8787`                        | 中心服监听端口                                                                 |
| `PACK_SERVER_PUBLIC_URL`    | **是**        | `https://pack.example.com`    | 中心服公网基准 URL（用于拼装固定 `redirect_uri`）                              |
| `DISCORD_CLIENT_ID`         | **是**        | `123456789012345678`          | Discord OAuth2 应用 Client ID                                                  |
| `DISCORD_CLIENT_SECRET`     | **是**        | `***`                         | Discord OAuth2 应用 Client Secret                                              |
| `DISCORD_GUILD_ID`          | **是**        | `987654321098765432`          | 要求玩家加入的 Discord 服务器（Guild）ID                                       |
| `DISCORD_REQUIRED_ROLE_IDS` | 否            | `111111,222222`               | 逗号分隔的身份组 Role ID 列表；留空则仅校验是否在服务器内                      |
| `DISCORD_ROLE_MATCH_MODE`   | 否            | `any` (`any` \| `all`)        | `any`=拥有任一指定身份组即放行；`all`=需同时拥有全部指定身份组                 |
| `DISCORD_GUILD_INVITE_URL`  | 否            | `https://discord.gg/xxx`      | 未入群时的引导加入链接（随 403 响应返回前端展示）                              |
| `DISCORD_ALLOWED_USER_IDS`  | 否            | `...`                         | 逗号分隔的特殊白名单 Discord User ID（直接放行）                               |
| `DISCORD_BLOCKED_USER_IDS`  | 否            | `...`                         | 逗号分隔的封禁黑名单 Discord User ID（一票否决）                               |
| `SESSION_SECRET`            | **是**        | 至少 32 字符高熵随机串        | 用于派生会话 HMAC 签名密钥与令牌加密密钥                                       |
| `PACK_MASTER_KEY_B64`       | **是**        | 32 字节 Base64                | 用于按 `(packId, packVersion, userId)` 派生 `DEK` 与 `distributedKey` 的主密钥 |
| `PACK_LEASE_TTL_SECONDS`    | 否            | `604800`（7 天）              | 单次获取或自动续期内容包的绑定寿命有效期（秒，如 24h / 7d）                    |
| `SESSION_TTL_SECONDS`       | 否            | `604800`（7 天）              | 登录会话令牌有效期（随每次自动续期同步顺延）                                   |
| `REVERIFY_INTERVAL_SECONDS` | 否            | `900`（15 分钟）              | 下发内容包或续期时触发向 Discord 实时复验成员/身份组的时间间隔                 |
| `CORS_ALLOWED_ORIGINS`      | 否            | `*`                           | 允许跨域访问的前端 Origin 列表（逗号分隔或 `*`）                               |
| `PACK_SOURCE_MODE`          | 否            | `local` (`local` \| `github`) | 内容包源模式：`local` 从本地私有目录读；`github` 从 Release 拉取解密           |
| `PACK_STORAGE_DIR`          | `local` 必填  | `/var/lib/poem-packs`         | 本地模式下存放 `manifest.json` 与 `pack.json`（或 `pack.bin`）的目录           |
| `PACK_GITHUB_REPO`          | `github` 必填 | `owner/repo`                  | GitHub Release 仓库坐标                                                        |
| `PACK_GITHUB_TOKEN`         | 否            | `ghp_***`                     | 访问私有 GitHub Release 仓库的 PAT（可选）                                     |
| `PACK_DECRYPT_KEY_B64`      | 加密源必填    | 32 字节 Base64                | 从上游加密 Release 解包用的仓库级密钥                                          |

### 7.3 远端中心服 API 契约

#### 7.3.1 `GET /api/v1/auth/discord/login`

- **Query 参数**：`origin`（必填）、`attemptId`（可选，UUID）。
- **行为**：构造签名 `state`（含 `origin`、`attemptId`、`nonce`、`exp = now + 600`），302 重定向至 Discord OAuth2 授权页（`scope=identify%20guilds.members.read`）。

#### 7.3.2 `GET /api/v1/auth/discord/callback`

- **行为**：
  1. 验签 `state` 并检查有效期；
  2. 用 `code` 换取 `access_token`；
  3. 调 Discord `/users/@me` 与 `/users/@me/guilds/{DISCORD_GUILD_ID}/member` 核验入群状态与 `roles`；
  4. 计算 `accessStatus`，签发 `SealedSessionToken`；
  5. 返回桥接 HTML，通过 `window.opener?.postMessage` 传回主窗口并写入短期 `attemptStore` 供轮询兜底。

#### 7.3.3 `GET /api/v1/auth/discord/result?attemptId=<id>`

- **行为**：阅后即焚返回 `{ ok: true, status: 'completed', serverTime, token, user, access, expiresAt }`。

#### 7.3.4 `POST /api/v1/auth/discord/verify`

- **请求头**：`Authorization: Bearer <token>`
- **行为**：校验令牌；若 `forceRefresh` 或超期则实时向 Discord 重新查询入群与身份组状态，返回最新 `access`、`serverTime` 与顺延后的新 `token`。

#### 7.3.5 `GET /api/v1/pack/latest`（需鉴权且 `eligible === true`）

- **请求头**：`Authorization: Bearer <token>`
- **响应**：返回 `{ ok: true, serverTime, available: true, tag, packId, packVersion, minEngineVersion, size, plainSha256, leaseTtlSeconds }`。

#### 7.3.6 `GET /api/v1/pack/blob`（需鉴权且 `eligible === true`）

- **请求头**：`Authorization: Bearer <token>`
- **行为**：
  1. 验证 Bearer Token；若距上次 `verifiedAt` 超过 `REVERIFY_INTERVAL_SECONDS`，实时向 Discord API 复验 Guild 与 Role。
  2. 以当前用户 `boundUserId = session.sub` 与寿命 `expiresAt = now + PACK_LEASE_TTL_SECONDS * 1000` 派生 `DEK`、`distributedKey` 与 `KEK`。
  3. 用 `DEK` 加密 `gzippedPackBytes` 产出 `ciphertextB64`，用 `KEK` 加密 `DEK` 产出 `wrappedDekB64`。
  4. 返回专属加密信封与密钥租约：
     ```json
     {
       "ok": true,
       "serverTime": 1762500000000,
       "envelope": {
         "formatVersion": 1,
         "packId": "fated-poem-official",
         "packVersion": "2.8.0",
         "boundUserId": "123456789012345678",
         "issuedAt": 1762500000000,
         "expiresAt": 1763104800000,
         "wrapNonceB64": "...",
         "wrappedDekB64": "...",
         "bodyNonceB64": "...",
         "ciphertextB64": "...",
         "plainSha256": "..."
       },
       "keyLease": {
         "packId": "fated-poem-official",
         "packVersion": "2.8.0",
         "boundUserId": "123456789012345678",
         "distributedKeyB64": "...",
         "issuedAt": 1762500000000,
         "expiresAt": 1763104800000
       }
     }
     ```

#### 7.3.7 `POST /api/v1/pack/renew`（轻量自动续期 + 实时资格重验 + 密钥租约恢复）

- **请求头**：`Authorization: Bearer <token>`
- **请求体**：`{ "packId": "fated-poem-official", "packVersion": "2.8.0" }`
- **行为**：
  1. **强制或按窗口向 Discord 实时核验 Guild 成员与 Role 资格**：
     - 若用户已退群或被撤销身份组，立即返回 `403 { ok: false, code: 'NOT_IN_GUILD' | 'MISSING_REQUIRED_ROLE', error: '...' }`（客户端收到后立即锁定本地包）。
  2. **签发新寿命与重新封装 60 字节 `wrappedDekB64`**：
     - 计算新到期时间 `expiresAt = now + PACK_LEASE_TTL_SECONDS * 1000`；
     - 按 `(packId, packVersion, boundUserId)` 派生同一把 `DEK` 与 `distributedKey`；
     - 用新 `expiresAt` 派生的新 `KEK` 将 `DEK` 重新封装为新的 `wrapNonceB64` + `wrappedDekB64`；
     - 同时顺延签发新的 `sessionToken`（避免会话令牌先于内容包过期）。
  3. **顺带检查是否有新版内容包**：比对客户端传入的 `packVersion` 与服务端当前最新 `manifest.packVersion`。
  4. **响应体（< 600 字节）**：
     ```json
     {
       "ok": true,
       "serverTime": 1762600000000,
       "token": "dps1...(顺延后的新会话令牌)",
       "access": {
         "eligible": true,
         "code": "ELIGIBLE",
         "guildId": "987654321",
         "message": "Discord 社区资格验证通过"
       },
       "renewal": {
         "packId": "fated-poem-official",
         "packVersion": "2.8.0",
         "boundUserId": "123456789012345678",
         "issuedAt": 1762600000000,
         "expiresAt": 1763204800000,
         "wrapNonceB64": "...",
         "wrappedDekB64": "..."
       },
       "keyLease": {
         "packId": "fated-poem-official",
         "packVersion": "2.8.0",
         "boundUserId": "123456789012345678",
         "distributedKeyB64": "...",
         "issuedAt": 1762600000000,
         "expiresAt": 1763204800000
       },
       "latestPackVersion": "2.8.0",
       "updateAvailable": false
     }
     ```

---

## 8. 前端与本地 BFF 模块划分

### 8.1 本地 BFF 转发层（`server/routes/content-pack.ts`）

- 从 `server/content-pack-release.ts` 移除公开内嵌密钥 `PACK_BLOB_KEY_B64`。
- 本地 BFF 提供同源转发路由：
  - `GET /api/content-pack/latest` → 转发至中心服 `GET /api/v1/pack/latest`
  - `GET /api/content-pack/blob` → 转发至中心服 `GET /api/v1/pack/blob`
  - `POST /api/content-pack/renew` → 转发至中心服 `POST /api/v1/pack/renew`
  - `POST /api/content-pack/verify` → 转发至中心服 `POST /api/v1/auth/discord/verify`
- 强制校验并透传 `Authorization: Bearer <token>` 请求头。

### 8.2 新增 `src/ui/lib/pack-crypto.ts`（客户端运行时信封解密与寿命/账号校验）

- 基于浏览器原生 `crypto.subtle`（HKDF + AES-GCM）与 `fflate.gunzipSync`：
  - `verifyEnvelopeBinding(envelope, keyLease, session, effectiveNow)`：校验账号一致性与有效期寿命；
  - `unwrapPackDek(envelope, keyLease, currentUserId)`：用 `distributedKeyB64 + currentUserId + envelope.expiresAt` 派生 `KEK`，解封 `wrappedDekB64` 得到内存 `DEK` `CryptoKey`；
  - `decryptContentPackAtRuntime(envelope, keyLease, session, effectiveNow)`：验证绑定 → 解封 `DEK` → `AES-256-GCM` 解密 `ciphertextB64`（含 `AAD_body` 认证）→ `SHA-256` 校验 → `gunzipSync` 解压 → `JSON.parse` 产出内存态 `ContentPack`。

### 8.3 新增 `src/ui/lib/discord-auth-client.ts` 与自动续期调度器

- 管理 `localStorage` 中的：
  - `poem_discord_auth_v1`：当前登录会话 `DiscordAuthSession`；
  - `poem_discord_pack_lease_v1`：下载/续期时分发的密钥租约 `PackKeyLease`（退出登录时同步清除）；
  - `poem_pack_clock_guard_v1`：`{ clockOffset, maxObservedTime }` 单调时钟防回拨水线。
- 提供自动续期调度函数（挂载于 `content-store`）：
  - `renewPackLeaseOnServer()`（单飞去重 + 自动更新 IndexedDB 信封头 `{ expiresAt, wrapNonceB64, wrappedDekB64 }` + 刷新 `sessionToken` 与 `keyLease`）；
  - `startPackAutoRenewalScheduler()` / `stopPackAutoRenewalScheduler()`（管理 15 分钟周期巡检、临期唤醒定时器、`visibilitychange` 与 `online` 事件监听）。

### 8.4 UI 状态展示（`DataSection.vue` 与 `ContentStatusBanner.vue`）

在设置页「内容包」卡片与顶部内容态横幅中，清晰展示账户绑定、寿命与自动续期状态：

1. **已解锁运行态（`ACTIVE_UNLOCKED`）**：
   - 显示：「已绑定账号：`@displayName` ｜ 授权有效期至：`YYYY-MM-DD HH:mm`（后台自动续期已开启）」
   - 操作按钮：`检查更新`、`立即刷新验证`、`卸载内容包`。
2. **后台自动续期中（`RENEWING`）**：
   - 静默状态指示（不遮挡界面）：「正在同步 Discord 授权租约…」。
3. **已安装密文包但处于锁定态（`LOCKED`）**：
   - 细分为三种明确提示：
     - **`LOCKED_NOT_LOGGED_IN`**：本地存有加密内容包，但当前未登录 Discord → 提示「内容包已加密锁定，请登录绑定的 Discord 账号（登录后将自动解锁运行）」。
     - **`LOCKED_ACCOUNT_MISMATCH`**：当前登录的 Discord 账号与内容包绑定的 `boundUserId` 不一致 → 提示「此内容包绑定于另一 Discord 账号，请切换回原账号，或使用当前已验证账号重新获取内容包」。
     - **`LOCKED_EXPIRED`**：离线超时或权限被撤导致自动续期未通过 → 提示具体原因（如「网络连接恢复后将自动续期」或「Discord 身份组验证未通过，请在服务器内恢复身份组后点击重新验证」）。

---

## 9. 实施拆分与验证计划

1. **Step 1 — 密码学原语与远端中心服实现（`pack-server/`）**：
   - 实现 `crypto-pack.ts`（信封加密：`DEK/KEK` 双级 HKDF + `wrappedDekB64` 零流量重封装 + `AES-256-GCM` AAD 加解密）、`crypto-session.ts`、`discord-client.ts`、`pack-provider.ts`、`routes/{auth,pack}.ts`（含 `/api/v1/pack/renew`）；
   - 单测覆盖：正确账号+有效期内解密成功、不同账号解密失败、篡改 `expiresAt` 解密失败、篡改 `boundUserId` 解密失败、`/renew` 零流量续期后用新 `wrappedDekB64` 解开原密文包、退群后 `/renew` 返回 `403` 拦截。
2. **Step 2 — 本地 BFF 改造与公开仓密钥移除（`server/`）**：
   - 移除 `server/content-pack-release.ts` 中的硬编码密钥，将 `server/routes/content-pack.ts` 改为中心服同源代理（支持 `latest` / `blob` / `renew` / `verify`）。
3. **Step 3 — 客户端运行时解密、内存叠加层与自动续期调度器（`src/ui/` & `src/core/`）**：
   - 实现 `src/ui/lib/pack-crypto.ts`、`src/ui/lib/discord-auth-client.ts`，升级 `src/ui/lib/content-pack-updater.ts`；
   - 改造 `content-store.ts`、`worldbook-store.ts`、`usePresets.ts`：加密内容包仅将 `EncryptedPackEnvelope` 存入 `db.contentPacks`，`worldBooks` 与 `presets` 走运行时内存叠加层；接入启动自动恢复续期、后台定时预续期、`visibilitychange`/`online` 自动重验与 `403` 即刻锁定。
4. **Step 4 — UI 接入与八道闸门验证**：
   - 更新 `DataSection.vue` 与 `ContentStatusBanner.vue`；
   - 跑通 `npm run gates` 全量测试与编码检查。
