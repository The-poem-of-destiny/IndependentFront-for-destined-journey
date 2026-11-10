# Discord 授权内容包客户端

## 交付范围

当前前端对接独立部署的 `discord-content-pack-server` v1 协议，替代旧版公开 Release 免登录下载与 BFF 解密通道。客户端不包含 Discord client secret、Bot token、session secret 或 pack master secret。中心服的部署、资格策略和内容发布不属于本仓配置。

实现路径：

- `src/ui/lib/discord-auth-client.ts`：弹窗登录、严格消息来源验证与轮询交接、opaque token 串行更新、跨标签页身份同步、时钟高水位。
- `src/ui/lib/pack-crypto.ts`：WebCrypto HKDF-SHA256、AES-GCM、gzip、完整性与包格式校验。
- `src/ui/lib/pack-lease-scheduler.ts`：15 分钟资格心跳、临期续租、到期锁定、可见性/网络恢复检查、单飞与 1/5/15 分钟退避；遵循更长的 `Retry-After`。
- `src/ui/stores/content-store.ts`：受保护安装、密文缓存、自动恢复、仅更新信封头的续租、锁定与卸载。运行中续租不重置本次会话编辑。
- `src/core/content/pack-runtime.ts`：不依赖 Vue 的内存供值层；世界书、预设、战斗协议和备份依赖检测共用它。
- `server/routes/content-pack.ts`：同源 BFF 仅透传 Bearer、必要 JSON 和中心服状态码；不解密、不回退到旧公开源。

## 配置与操作

### 本地前端 + BFF

启动进程前设置 `POEM_PACK_SERVER_URL`，值必须是 origin，不带路径、查询或账号密码。正式地址必须使用 HTTPS；本机 `localhost`、`127.0.0.1`、`[::1]` 可用 HTTP。

```bash
# macOS / Linux
POEM_PACK_SERVER_URL=https://packs.example.com npm run dev
```

```powershell
# PowerShell
$env:POEM_PACK_SERVER_URL = 'https://packs.example.com'
npm run dev
```

本配置读取进程环境变量；不要假设根目录 `.env` 会自动进入 Node BFF 的 `process.env`。

### 静态前端

构建前设置 `VITE_PACK_SERVER_URL=https://packs.example.com`。此地址可公开，会进入前端产物；中心服必须允许该前端 origin（开发时是 `http://localhost:5173`）。OAuth redirect URI 指向中心服自己的 callback，不能填写本地 BFF。

两种模式的登录弹窗均直连中心服。普通前端请求在本地模式走 BFF，在静态模式直连中心服。

### 玩家操作

设置 → 存档数据 → 内容包：

1. 点击「登录 Discord」，完成授权与社区资格检查；允许浏览器弹窗。
2. 点击「检查更新」，再获取最新内容包；冲突时需要明确确认覆盖。
3. 面板显示登录账号、包绑定账号、有效期、续租或锁定原因。可「重新验证并续期」、切换账号或退出登录。

未配置中心服时给出配置错误，不会偷偷使用旧公开下载通道。显式从 JSON 文件导入仍是明文本地离线模式，与在线授权包分开。

## 授权生命周期

- 受保护包必须同时匹配登录账号、信封 `boundUserId`、租约账号、packId/version 及有效期，才允许解密挂载。
- 有效租约与会话可离线恢复。启动时缺失/过期租约且已登录同一合格账号，会自动尝试续租；失败则保持锁定并按策略重试。
- 自动续租窗口为寿命剩余 25% 或 48 小时（取较大者），另有每 15 分钟强制复验与到期前 5 分钟检查。窗口恢复/重新联网会检查，精确到期计时器独立于在途请求。
- 暂时网络错误、429、5xx 不提前撤销尚有效的租约；401 或确定的 `NOT_IN_GUILD` / `MISSING_REQUIRED_ROLE` / `USER_BLOCKED` 立即锁定。来源配置错误不冒充退群。
- 退出、账号切换、撤权、有效期截止会清空内存正文、注册表、默认提示词及派生缓存。正文开场认领/消息落库前、手动侧链/战斗/大纲生成前均有授权门；运行中的旧请求不能在退出或卸载后重新激活内容。
- token 请求在同标签页串行；支持 Web Locks 的浏览器同时跨标签串行，降低 OAuth refresh token 轮换竞争。跨标签收到退出/资格变化立即失效，单纯 token 轮换不重置内容。

## 持久化与旧数据迁移

| 数据 | 在线授权包 | 显式本地文件包 |
| --- | --- | --- |
| `contentPacks` | 加密信封、版本、账号、有效期、拥有项 id；无明文 payload | `source: local-file` 与明文 payload |
| pack 世界书/预设 | 内存 overlay，编辑仅本次会话生效 | 原有 IndexedDB 持久化 |
| session token / keyLease | localStorage，退出清除 | 不需要 |
| 全库/单档备份 | 不携带授权正文、密钥、token；单档只记录内容依赖 | 保留原本地备份语义 |
| 提示词 Delta / Debug Turn / 战斗 transcript | 不写入磁盘，安装时清理旧派生缓存 | 原行为 |

用户已明确选择：**所有未标记来源的历史明文包都清理并锁定，要求重新登录获取**。迁移删除该包的明文整包、拥有的内置书/预设及派生提示缓存，留下 `legacy-locked` 元数据供提示与卸载；保留显式 `builtIn: false` 玩家书和 `creative_workshop` 书。旧包的内置正文编辑也会丢弃。新本地导入包有明确来源标记，不参加这项清理。

旧全库备份回灌的包拥有项会再次清洗，即使当前租约不可用也不例外。原包/密钥不进入游戏备份，恢复备份不等于取得内容授权。

在线包切换为显式本地文件包时，先撤销旧受保护记录的拥有项清理责任，再写入本地行；失败恢复原密文记录和内存编辑，避免后续备份清洗误删新本地包。锁定后的受保护 id 仍禁止晚到编辑写回磁盘。排队缓存读取跨运行时版本变化时丢弃结果。

由于战斗 transcript 含系统提示词，在线授权包期间不持久化该缓存，**刷新页面不能靠旧 transcript 继续在办战斗**；已正式提交的游戏存档数据不受影响。正文 Delta 会话刷新后重新建立。该取舍是为闭合派生提示词明文落盘路径，不改变本地文件模式。

## 安全与验收边界

这不是 DRM：浏览器必须在内存持有可用内容与分发租约，XSS、本机恶意程序、自定义客户端和已复制的历史明文不在其保密保证内。离线时无法即时感知退群，只能在租约到期或重新联网复验时撤权。时钟高水位与单调计时防止普通时钟回拨延长租约，但无法抵御主动篡改客户端。退出不使其他客户端已经复制的无状态 token 立刻失效。

自动化覆盖独立 Node 加密夹具与 WebCrypto 互通、篡改/账号/到期拒绝、密文持久化与备份、旧包清洗、内存编辑、续租正文不变、迟到响应、明确撤权/暂时故障、弹窗来源、跨标签会话和调度退避。

真实 Discord OAuth、生产中心服/真实包与桌面浏览器实机交互尚未验收。未部署、提交或推送。全量闸门执行结果以本次交付说明为准，不能把协议夹具测试称为生产联调通过。
