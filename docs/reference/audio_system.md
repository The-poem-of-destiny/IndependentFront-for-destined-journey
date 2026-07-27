# 音频系统 v1.0

> 引擎参考文档。面向第一次接触本项目音频子系统的开发者：这套系统是什么、能做什么、怎么调用、数据存在哪、以及哪些事它**刻意不做**。
>
> 本文以**源码为准**。若与 `docs/planning/` 下的设计稿冲突，以本文与源码为准（设计稿写于实现之前）。

---

## 一、定位与目标

《命定之诗》独立前端是一个纯浏览器端的文字 RPG 引擎。音频系统解决的问题只有一个：**让玩家在游玩时有背景音乐和音效，且音频文件来自玩家自己**。

项目不分发任何音频素材（授权未清），所以系统的重心不是"播放内置曲库"，而是"接住玩家自己的音乐文件，并把它组织成可用的曲库与播放列表"。

它在整个引擎里的位置是**旁路**：没有任何主流程依赖它，关掉音频系统游戏照常运行。这是刻意的——音频是氛围增强，不是游戏逻辑。因此它也不参与存档、不参与 Agent 编排、不写任何游戏状态。

v1.0 交付的能力边界：

| 能做 | 不做 |
|------|------|
| 播放本地磁盘文件夹里的音乐 | 播放远程 URL 音源 |
| 播放上传进 IndexedDB 的音频 | 音频格式转码 |
| 播放列表（顺序 / 单曲 / 全部循环 / 随机） | 真正的交叉淡入（A、B 两条流同时出声） |
| 一次性音效（声池、并发上限） | 音效解码缓存 |
| 按标签播放（为 AI 预留的钩子） | 由 AI 实际触发播放（**尚未接线**） |
| 按名称寻址曲目与播放列表 | 全角/半角折叠、拼音匹配 |

---

## 二、架构分层

```
界面层     AudioSection.vue (设置页音频分区)   MiniPlayer.vue (游戏页迷你播放器)
             │  只调 store，不认识 AudioManager
UI 桥接层  audio-store.ts (Pinia)  ← 应用的唯一入口
             ├── audio-singleton.ts   惰性单例 + 浏览器工厂 + 首次手势解锁监听
             └── audio-folder.ts      File System Access API 的唯一接触点
             │  store 调引擎方法、调 Dexie 函数，把两边缝在一起
存储层     database.ts   audioTracks / audioBlobs / audioPlaylists / audioHandles
             │  引擎从不 import 它
引擎层     audio-manager.ts   门面：曲库注册表 + 主音量 + 解锁 + AI 钩子
           audio-channels.ts  MusicChannel（音序器） + SfxChannel（声池）
           audio-names.ts     名称归一化 / 查找 / 唯一化（纯函数）
```

**依赖方向是单向的**，这条约束比看起来重要：

- 引擎层（`src/sillytavern/audio-*.ts`）**不认识 Vue，也不碰 Dexie**。它连 `AudioContext` 和 `Audio` 都不直接构造——全部走注入。原因见第九节：`src/sillytavern/` 必须能在 vitest `environment: 'node'` 下被 import，模块顶层碰一下 `new AudioContext()` 就会把整个引擎测试套件炸掉。
- 引擎层也**不能 import `src/ui/`**。所以当"扩展名 → MIME 表"需要被引擎（名称归一化要剥扩展名）和 UI（文件夹扫描要筛 MIME）共用时，做法是把表**上提**到 `audio-names.ts`，由 UI 反向 import。
- `AudioManager` 的实例**不住在引擎层**。引擎只导出类，单例在 `src/ui/lib/audio-singleton.ts` 里惰性创建。

---

## 三、双通道模型

音乐和音效在技术上是两件完全不同的事，所以 `audio-channels.ts` 里的两个类**刻意不共享基类**——它们只共享"有一个 gain 节点"这个概念，其余毫无共同点。

两个通道的 gain 节点都接到 `AudioManager` 的 master gain 上，master 再接 `destination`。于是音量有两级：主音量（master）× 通道音量。静音只是把 gain 设为 0，**不破坏 volume 数值**，取消静音能恢复原值。

### MusicChannel —— 音序器

「音序器」（sequencer）在这里指：它持有一个曲目队列、一个当前索引、循环模式和随机开关，负责决定"下一首放什么"。

- **流式播放，永不解码成 buffer**。用一个 `HTMLAudioElement` 的 `src` 加载，通过 `createMediaElementSource` 接进音频图。理由很实在：5 分钟立体声解码成 float32 约 105MB，几首歌就能把内存打爆。
- 队列推进矩阵（`handleEnded`）：`repeat: 'one'` 回到 0 重播；队列未到尾则索引 +1；到队尾时 `repeat: 'all'` 回绕到 0（若 shuffle 开启则重新洗牌），否则停止。
- 用户手动 `next()` 与自动推进不同：手动到队尾**总是**回绕到 0，与 repeat 无关。
- `setShuffle()` **只置位不立即重排**。重排发生在 `playPlaylist()` 和 `all` + shuffle 的回绕点。这样切换开关不会把正在播放的曲子从脚下抽走。
- **单元素淡入淡出**，不是真交叉淡入：换曲时先把 gain 淡到 0，等淡出结束，再换 `src` 并从 0 淡回。同一时刻只有一条流在出声。真交叉淡入需要两个元素两条链路，v1 不做。
- `fadeMs === 0` 时**完全不排定时器**（同步路径），这是测试保持确定性的前提；UI 用 `AUDIO_DEFAULT_FADE_MS = 300`。
- 每次换曲都 `revokeObjectURL` 上一段 URL——这是唯一的泄漏防线。

### SfxChannel —— 声池

「声池」（voice pool）指：同时可以有多个音效在响，每一发都是独立的一次性声源，播完即弃。

- 无队列、无索引、无循环。每一发的流程：`loadBlob` → `blob.arrayBuffer()` → `decodeAudioData` → `AudioBufferSourceNode` → `start()`。
- **8 声部上限**（`SFX_DEFAULT_MAX_VOICES`）。超出时掐掉**运行最久**的那一发——最新的声音才和刚发生的事最相关。判定用实际 `start()` 时刻而非调用顺序，因为解码可能乱序完成。
- **4 路并发解码上限**（`SFX_DEFAULT_MAX_DECODES`）。超出时**直接拒绝并返回 false，不排队**——爆发期排队只会让积压越堆越深，声音迟到几秒比不响更糟。
- **三道体积/时长门禁**：元数据声称超 30 秒或超 5MB → 连字节都不读；真实 blob 超 5MB → 拒绝；解码后真实时长超 30 秒 → 拒绝。门禁与 `kind` 字段无关，因为 `kind` 可能是错的（用户可以把一首歌标成 sfx）。
- **每次播放都重新解码，不做缓存**。这是刻意决定，不是疏漏——日后加 LRU 是零接口变更的纯内部优化。另外 `decodeAudioData` 会 **detach** 它消费的 `ArrayBuffer`，所以每一发都必须重新 `blob.arrayBuffer()`，共享 buffer 会在第二次解码时抛错。

---

## 四、三种音源后端

`AudioTrack.source` 决定字节从哪来。三种后端并存，互不感知：

| source | 字节来源 | 浏览器要求 | 典型用途 |
|--------|----------|-----------|----------|
| `file` | 用户本机音乐文件夹（File System Access API） | 仅 Chromium | 主路径：几百 MB 音乐不占浏览器配额 |
| `blob` | IndexedDB `audioBlobs` 表 | 全部 | 兜底：非 Chromium 浏览器上传入库 |
| `builtin` | `public/audio/` 下的静态文件，由 `manifest.json` 声明 | 全部 | 内置素材（v1 **空载**） |

**File System Access API** 是浏览器提供的一套让网页读写用户本机文件/目录的接口。用户通过 `showDirectoryPicker()` 亲手选一个目录，网页拿到一个「目录句柄」（`FileSystemDirectoryHandle`）。句柄可以被结构化克隆，因此能存进 IndexedDB 跨会话保留——但**权限不跨浏览器重启**。

### 权限生命周期

这是最容易被误解的一点：句柄存下来了，不等于还能读。

1. 用户第一次点「选择文件夹」→ 弹选择器 → 授权 → 句柄存进 `audioHandles` 表，权限为 `granted`。
2. 用户关掉浏览器再打开 → 句柄还在，但 `queryPermission()` 返回 `prompt`。
3. 此时**必须再有一次用户手势**才能 `requestPermission()`。启动期的 `initFolder()` **绝不调用 `requestPermission`**——无手势调用会静默失败，看起来就像 bug。所以 UI 提供一个显式的「授权访问」按钮，每次开浏览器点一次。

`AudioFolderPermission` 有五个取值：`unsupported`（浏览器不支持）/ `none`（支持但没选过）/ `prompt`（有句柄待授权）/ `granted` / `denied`。

### 扫描对账：文件消失只标记，不删行

`rescanFolder()` 按 `relativePath` 把「磁盘上的文件」与「曲目表里 `source === 'file'` 的行」做对账：

- 磁盘有、表里没有 → 新建曲目行；
- 两边都有 → 清除 `missing` 标记，刷新 `size` / `mimeType`；
- 表里有、磁盘没有 → 标 `missing: true`。

**扫描期间永不删行**。理由：标签、`kind` 分类、播放列表里的位次都是用户的整理成果。硬盘没插、文件临时挪走、U 盘没插——任何一次误判都会毁掉这些成果，而它们无法自动恢复。标记 `missing` 是可逆的，删行不是。

同理，「取消关联文件夹」只删句柄并把所有 `file` 曲目标成 `missing`，**不删任何曲目行**。重新选回同一个文件夹时按文件名原样恢复。

---

## 五、数据模型与存储

Dexie（IndexedDB 封装）v12，四张表：

| 表 | 主键 / 索引 | 存什么 | 为什么单独一张 |
|----|-------------|--------|---------------|
| `audioTracks` | `id, name, kind, *tags, updatedAt` | 曲目元数据（名称/类型/来源/标签/相对路径/missing） | 列表查询只需要它 |
| `audioBlobs` | `id` | 音频字节（`{ id, blob }`，id 与曲目同值） | 见下 |
| `audioPlaylists` | `id, name, updatedAt` | 有序的 `trackIds[]` | 播放列表只是曲目的有序引用 |
| `audioHandles` | `id` | File System Access 目录句柄（当前只有 `'library-root'` 一行） | 句柄不是 JSON，进不了 localStorage |

### 为什么元数据与字节要分表

**IndexedDB 没有列投影**——读一条记录就是读整条。如果字节和元数据同表，那么「列出曲库」这个每次打开设置页都要做的操作，会把全部音频字节从磁盘读进内存。几百 MB 的曲库会直接卡死界面。分表之后，列表查询只碰 `audioTracks`，字节只在真正要播放时按 id 单独取。

代价是两张表的写入必须原子，所以 `saveAudioTrack(track, blob)` 偏离了本文件"单行 CRUD"的惯例，改用显式事务——半成功会留下有元数据却无字节（播放即哑）或孤儿 blob 的记录。

`deleteAudioTrack` 同理三表同事务：删元数据 + 删字节 + 从所有播放列表的 `trackIds` 里剔除该 id（清理悬挂引用）。

### 为什么音频库全局共享，不随存档隔离

游戏里几乎所有数据都按 `saveId` 隔离。音频不：曲库是**玩家的资产**，不是某局游戏的状态。换一个存档不该让音乐消失，也不该让同一批文件在每个存档里各存一份。

### 为什么刻意不参与存档导出/导入

`FullBackup`（`exportAllData` / `importAllData`）**不包含任何音频表**。三条理由：

1. 音频字节动辄几百 MB，塞进 JSON 备份会让导出文件大到无法使用；
2. 目录句柄**跨机器毫无意义**——它指向的是本机某个具体路径的授权，导到另一台电脑上是一个必然失效的对象；
3. 音频不是游戏进度，丢了不影响任何存档的可恢复性。

但要注意：设置页的「清除全部数据」会**一并销毁**音频表。这不是矛盾——"不进备份"说的是导出，"清库"说的是清空本机 IndexedDB。

---

## 六、API 参考

**应用层的唯一入口是 `useAudioStore()`**（`src/ui/stores/audio-store.ts`）。组件不应该直接拿 `AudioManager`，也不应该直接调 `database.ts` 的音频函数——store 负责把引擎状态、Dexie 读写、设置持久化三者缝在一起。

### 6.1 生命周期

| 方法 | 签名 | 说明 |
|------|------|------|
| `init` | `() => Promise<void>` | 幂等。订阅 Manager、装入 `loadBlob`、挂手势解锁监听、恢复设置、拉 manifest、读库、恢复文件夹状态 |
| `dispose` | `() => void` | 停轮询、卸下 blob 解析器、退订 |
| `loadLibrary` | `() => Promise<void>` | 从 Dexie 读曲目+列表，与内置曲目合并后灌给 Manager |
| `loadManifest` | `() => Promise<void>` | 拉 `/audio/manifest.json`；缺文件或解析失败一律静默 |
| `refreshTracks` / `refreshPlaylists` | `() => Promise<void>` | 写操作后的局部刷新 |
| `restoreSettings` | `() => void` | 从 settings-store 恢复音量/循环/随机 |

### 6.2 播放控制

| 方法 | 签名 | 返回值语义 |
|------|------|-----------|
| `playTrack` | `(trackId: string) => Promise<void>` | 单曲播放，队列长度 1 |
| `playPlaylist` | `(playlistId: string, startIndex?: number) => Promise<void>` | 顺带把该列表记为"上次播放" |
| `playTrackByName` | `(name: string) => Promise<boolean>` | **`false` = 没找到**，且**不动当前播放** |
| `playPlaylistByName` | `(name: string, startIndex?: number) => Promise<boolean>` | 同上 |
| `play` / `pause` / `toggle` / `stop` | `() => Promise<void>` / `() => void` / `() => Promise<void>` / `() => void` | `stop` 回到 0 且清空 pending，队列保留 |
| `next` / `prev` | `() => Promise<void>` | `next` 到队尾总是回绕到 0；`prev` 在队首重放当前曲 |
| `seek` | `(sec: number) => void` | 顺带同步 `positionSec` |
| `setRepeat` | `(mode: 'off' \| 'all' \| 'one') => void` | 同时写进设置 |
| `setShuffle` | `(on: boolean) => void` | 同时写进设置 |
| `unlock` | `() => Promise<void>` | 手动触发解锁；通常由手势监听自动调用 |

### 6.3 混音

| 方法 | 签名 | 说明 |
|------|------|------|
| `setMasterVolume` | `(v: number) => void` | 钳制到 0..1，写进设置 |
| `setMasterMuted` | `(m: boolean) => void` | 静音不破坏 volume 数值 |
| `setChannelVolume` | `(ch: 'music' \| 'sfx', v: number) => void` | |
| `setChannelMuted` | `(ch: 'music' \| 'sfx', m: boolean) => void` | |

### 6.4 曲库与播放列表 CRUD

| 方法 | 签名 | 返回值语义 |
|------|------|-----------|
| `uploadFiles` | `(files: File[], kind?: AudioTrackKind) => Promise<AudioTrack[]>` | 每个文件建一条 `source: 'blob'` 曲目；重名**自动编号**，汇总提示一次 |
| `findTrack` | `(id: string) => AudioTrack \| undefined` | |
| `findTrackByName` | `(name: string) => AudioTrack \| undefined` | 归一化比较；多命中取 `createdAt` 最早者 |
| `renameTrack` | `(id: string, name: string) => Promise<boolean>` | **`false` = 曲目不存在 / 是内置曲目 / 重名被拒** |
| `setTrackTags` | `(id: string, tags: string[]) => Promise<void>` | 内置曲目空转 |
| `setTrackKind` | `(id: string, kind: AudioTrackKind) => Promise<void>` | 内置曲目空转 |
| `deleteTrack` | `(id: string) => Promise<void>` | 内置曲目不可删；顺带剪掉播放列表悬挂引用 |
| `findPlaylist` | `(id: string) => AudioPlaylist \| undefined` | |
| `findPlaylistByName` | `(name: string) => AudioPlaylist \| undefined` | |
| `createPlaylist` | `(name: string) => Promise<AudioPlaylist \| null>` | **`null` = 重名被拒**（不抛） |
| `renamePlaylist` | `(id: string, name: string) => Promise<boolean>` | **`false` = 不存在 / 重名被拒** |
| `deletePlaylist` | `(id: string) => Promise<void>` | 不级联删曲目 |
| `addTrackToPlaylist` / `removeTrackFromPlaylist` | `(playlistId: string, trackId: string) => Promise<void>` | 重复添加空转 |
| `reorderPlaylist` | `(playlistId: string, trackIds: string[]) => Promise<void>` | 整序覆盖（拖拽后调用） |

### 6.5 音乐文件夹

| 方法 | 签名 | 返回值语义 |
|------|------|-----------|
| `pickFolder` | `() => Promise<boolean>` | 需要用户手势。**`false` = 不支持 / 用户取消**；成功即扫描 |
| `grantFolderPermission` | `() => Promise<boolean>` | 需要用户手势。**`false` = 无句柄 / 被拒**；成功即扫描 |
| `rescanFolder` | `() => Promise<void>` | 增量对账，永不删行 |
| `forgetFolder` | `() => Promise<void>` | 只删句柄，曲目全部标 `missing` |
| `loadBlob` | `(trackId: string) => Promise<Blob \| undefined>` | 装给 Manager 的字节解析器；`undefined` = 取不到（`file` 源会顺带标 `missing`） |

响应式状态：`folderPermission`（`AudioFolderPermission`）、`folderName`（string）、`scanning`（boolean）。

### 6.6 音效

| 方法 | 签名 | 返回值语义 |
|------|------|-----------|
| `playSfx` | `(trackId: string) => Promise<boolean>` | **`false` = 未解锁 / 曲目不存在 / 门禁拒绝 / 解码拥塞 / 解码失败** |
| `stopAllSfx` | `() => void` | 掐掉全部在响声部 |

### 6.7 AI 钩子

| 方法 | 签名 | 返回值语义 |
|------|------|-----------|
| `playByTag` | `(tag: string, fallback?: 'keep' \| 'stop') => Promise<boolean>` | **`false` = 无曲目带此标签**。未命中时 `keep`（默认）保持当前曲继续播，`stop` 停止 |

只匹配 `kind === 'music'` 的曲目；多命中时用注入的随机源挑一首。

### 6.8 观察状态

| 属性 | 类型 | 说明 |
|------|------|------|
| `state` | `AudioPlaybackState` | **离散**状态镜像：music（status/trackId/playlistId/index/durationSec/volume/muted/repeat/shuffle）、sfx（volume/muted/liveVoices）、masterVolume、masterMuted、unlocked |
| `positionSec` | `number` | 播放位置。**不在 `state` 里**——它每秒变几十次，广播它等于把 60fps 扇出请回来。改为约 4Hz（250ms）轮询，且**只在有人看的时候跑** |
| `startPositionPolling` / `stopPositionPolling` | `() => void` / `(force?: boolean) => void` | 引用计数：两个进度条同时挂载不互相掐，没人看时不跑定时器 |
| `tracks` / `playlists` / `builtinTracks` / `loading` | | 曲库镜像 |

### 6.9 调用示例

```ts
// 1) 组件挂载：初始化 + 进度轮询（务必配对卸载）
const audio = useAudioStore()
onMounted(() => { void audio.init(); audio.startPositionPolling() })
onUnmounted(() => { audio.stopPositionPolling() })

// 2) 上传文件进 IndexedDB 兜底路径
const created = await audio.uploadFiles(Array.from(input.files ?? []), 'music')
console.log(`导入 ${created.length} 首`)

// 3) 手工改名：重名要给用户反馈，不能默默改掉
if (!(await audio.renameTrack(track.id, newName))) {
  toast('已有同名曲目', 'error')
}

// 4) 按名称播放（未来 AI/脚本的调用形状）
if (!(await audio.playTrackByName('雨夜的旅店'))) {
  // 没找到——当前播放保持不变
}

// 5) 关联本机音乐文件夹（必须在用户点击的回调里调用）
async function onPickFolder() {
  if (await audio.pickFolder()) toast(`已关联「${audio.folderName}」`, 'success')
}
```

---

## 七、按名称寻址与名称唯一性

`audio-names.ts` 是纯函数模块（无 I/O、无 Dexie、无 Vue、无 AudioContext），提供全项目唯一的一套名称口径。

**为什么要按名称而不是按 id**：id 是 `audio_<uuid>` 这类机器串，用户心智里的锚点是名字，AI 也不可能知道 id。项目有一条铁律——**AI 永不产 id**（见 `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`）。音频要接 AI 就必须能按名字/标签寻址，所以先把这套口径固化下来。

### 归一化规则

`normalizeAudioName(raw)` 依次做四件事：

1. `trim()`；
2. **剥尾部扩展名**——只认真正的尾缀且必须在认可列表内（`mp3/ogg/oga/wav/m4a/aac/flac/opus/webm`）。`战斗.mp3` → `战斗`；`v1.2 主题` 的点在中间，原样保留；整串就是扩展名（`.mp3`）不剥，剥完就空了；
3. 折叠内部连续空白为单个空格；
4. `toLocaleLowerCase()`。

返回值**仅用于比较**，不要拿它当展示名或落库值。

### 唯一性策略：导入自动编号，手动录入拒绝

| 路径 | 策略 | 理由 |
|------|------|------|
| 上传 / 文件夹扫描 | `uniqueAudioName()` **自动编号**，永不失败 | 导入是批量的，一个重名就中断整批不可接受 |
| 手工改名 / 新建播放列表 | `isNameTaken()` **拒绝**，返回 false/null | 用户是在有意起名，替他悄悄改是骗人 |

`uniqueAudioName()` 在已带 ` (n)` 尾缀时**换号而不是叠加**：已有 `战斗 (2)` 时，`战斗` 和 `战斗 (2)` 都得到 `战斗 (3)`，绝不产出 `战斗 (2) (2)`。返回值保留调用方原本的大小写与空格——只有**比较**走归一化。

`isNameTaken(items, candidate, exceptId?)` 的 `exceptId` 用于改名校验：忽略正在改名的那一行，于是"改成自己现在的名字"永远不算冲突。

### 三条容易踩的边界

- **曲目与播放列表是两个独立命名空间**。一首叫「战斗」的曲子和一个叫「战斗」的播放列表可以并存。
- **约束只作用于新写入**。历史上已经存在的重名行**刻意不动**——不做数据迁移，不强制改名。
- 因此 `findByName()` 在多命中时必须给出**稳定**答案：取 `createdAt` 最小者，同 `createdAt` 再按 id 升序。这样结果与数组顺序无关、跨次加载不变。空查询/全空白查询一律返回 `undefined`。

---

## 八、AI 集成现状（诚实版）

**结论先行：v1.0 的 AI 集成是"接口就绪，尚未接线"。**

| 能力 | 实现 | 测试 | 生产调用方 |
|------|------|------|-----------|
| `playByTag` | ✅ | ✅ | ❌ **零** |
| `playSfx` | ✅ | ✅ | ⚠️ 唯一调用方是设置页的试听按钮（`AudioSection.vue`），游戏内无任何音效触发点 |
| `playTrackByName` / `playPlaylistByName` | ✅ | ✅ | ⚠️ 仅 UI |
| `public/audio/manifest.json` | 文件存在，内容是 `[]` | — | 内置曲库**空载**（授权未清） |

### 接线还差什么

要让 AI 真正切换 BGM，需要补齐这条链路（**四段全部尚未实现**）：

1. **story Agent 产出标记** —— 在 `agent-config.json` 的 story systemPrompt 里加输出约定，例如 `<bgm tag="战斗"/>`；
2. **`marker-protocol.ts` 扫描** —— 当前 `MARKER_TAGS` 只有 8 个（`craft_request` / `combat_trigger` / `char_detect` / 5 个 `*_request`），**没有 `bgm`**。需要新增标记类型与 `scanBgmMarkers()`；
3. **`GamePipeline` 回调** —— 编排器的 marker 处理阶段把扫到的标签透出来；
4. **调 `playByTag(tag)`** —— UI 层收到回调后调用 store。

音效同理：需要在战斗结算、制作成功、状态效果触发等处埋 `playSfx` 调用点。

### 为什么给 AI 的是标签而不是 id

对齐「AI 永不产 id」铁律。`AudioTrack.tags` 是场景标签（如 `战斗` / `酒馆` / `雨夜`），由用户在设置页给自己的曲子打上。AI 只需要说"现在该放战斗音乐"，由 Code 层在打了该标签的曲目里挑一首。用户的曲库内容与 AI 的 prompt 完全解耦——换一批音乐不需要改任何 prompt。

`fallback` 默认 `'keep'` 也是同一个考虑：如果用户没给任何曲子打 `雨夜` 标签，AI 提到雨夜时不该让音乐**突然静音**——那比"音乐不贴合"糟糕得多。

---

## 九、限制与已知问题

### 手势解锁

浏览器的自动播放策略要求：`AudioContext` 出生即 `suspended`，必须在**用户手势的调用栈里** `resume()` 才能出声。

系统的处理：`installUnlockListener()` 挂一次性的 `pointerdown` / `keydown` 监听，首次手势时调 `manager.unlock()` 并自摘。锁定期内的播放请求**不抛错**，而是记进 `pending`（`playTrack` 会把 id 存进 `pendingTrackId`，UI 用它显示「点击页面任意处即可开始播放音乐」），解锁后自动兑现。

注意锁定期的 `playSfx` **直接返回 false**，不排 pending——音效是即时反馈，迟到几秒的爆炸声毫无意义。

### 其他限制

| 限制 | 说明 |
|------|------|
| 仅 Chromium 支持文件夹 | Firefox / Safari 没有 File System Access，`folderPermission` 恒为 `unsupported`，降级到上传入 IndexedDB 的路径 |
| 无远程 URL 音源 | `AudioSourceKind` 里 `'url'` 在 v1 被砍掉；重新加入是纯增量改动 |
| 无音效解码缓存 | 每一发都重新解码；加 LRU 是零接口变更的内部优化 |
| 单元素淡入淡出 | 换曲有一段短暂静默，不是真交叉淡入 |
| 名称归一化不做全角/半角折叠 | `Ａ` 与 `A` 视为不同名 |
| 名称归一化不做拼音/罗马化 | `战斗` 与 `zhandou` 视为不同名 |
| 名称归一化不做 NFC/NFKC | Unicode 等价字符视为不同名 |
| 目录扫描不递归 | 只扫目录**顶层**，子文件夹里的文件不会被发现 |
| **从未在真实浏览器里跑过** | 见下 |

### ⚠️ 最重要的一条

**整套系统的所有测试都跑在注入的测试替身上**（`audio-fakes.ts` 的伪 `AudioContext` / 伪 `AudioElement`、`audio-folder.ts` 的 `__setFolderTestHooks`）。这意味着：Web Audio 图的连接是否真的出声、`MediaElementSource` 与 blob URL 的兼容性、真实 `showDirectoryPicker` 的行为、各浏览器的自动播放策略差异——**全部未经真机验证**。

真机联调时优先怀疑：解锁时机、`crossOrigin` 与 `MediaElementSource` 的相互作用、大文件夹扫描耗时、`revokeObjectURL` 的时序。

---

## 十、测试

| 文件 | 用例数 | 覆盖范围 |
|------|-------|----------|
| `src/sillytavern/audio-channels.test.ts` | 61 | 队列推进矩阵、shuffle、淡入淡出、object URL 回收、`pruneTracks`、声池抢占/并发上限/三道门禁 |
| `src/sillytavern/audio-manager.test.ts` | 51 | 曲库注册表、master gain、解锁与 pending 兑现、`playByTag` 命中/多命中/fallback、状态广播 |
| `src/sillytavern/audio-names.test.ts` | 32 | 归一化四步、扩展名边界、`findByName` 稳定性、`isNameTaken`、`uniqueAudioName` 换号 |
| `src/ui/lib/audio-folder.test.ts` | 27 | 能力探测、句柄持久化、权限归一化、扫描过滤/排序/单文件容错、`resolveFile` NotFound |
| `src/ui/stores/audio-store.test.ts` | 23 | 库加载、上传编号、CRUD 拒绝路径、文件夹对账、按名播放 |
| `src/ui/components/settings/AudioSection.test.ts` | 14 | 设置页三段式交互 |
| `src/ui/components/game/MiniPlayer.test.ts` | 12 | 迷你播放器交互与轮询配对 |

### 为什么引擎层必须有注入缝

vitest 的 `environment: 'node'` 里**没有** `AudioContext`、`Audio`、`URL.createObjectURL`；jsdom 里也没有可用的 Web Audio 实现。所以 `AudioManagerOptions` 的 `createContext` / `createElement` / `createObjectURL` / `revokeObjectURL` / `random` / `fadeMs` / `loadBlob` **不是风格偏好，而是测试套件存在的前提**。

同理，`AudioManager` 在浏览器全局缺失时只在**被调用**时才抛错（`defaultCreateContext` 惰性引用），而 `audio-singleton.ts` 更进一步——缺失时返回**静默 no-op 桩**而不是抛错，让应用和每个组件测试都能在无 Web Audio 的环境里活下来，只是没有声音。

`fadeMs: 0` 让淡入淡出走完全同步的路径（不排定时器、不 await），这是通道测试能确定性断言的关键。

---

## 附：关键文件清单

| 文件 | 职责 |
|------|------|
| `src/sillytavern/audio-channels.ts` | `MusicChannel`（音序器） / `SfxChannel`（声池） + 全部注入 seam 接口 |
| `src/sillytavern/audio-manager.ts` | `AudioManager` 门面：曲库注册表 / master gain / 解锁 / `playByTag` |
| `src/sillytavern/audio-names.ts` | 名称归一化 / `findByName` / `isNameTaken` / `uniqueAudioName` / 扩展名→MIME 表 |
| `src/sillytavern/audio-fakes.ts` | 共享测试替身（伪 AudioContext / AudioElement） |
| `src/sillytavern/types.ts` | `AudioSourceKind` / `AudioTrackKind` / `AudioTrack` / `AudioBlobRecord` / `AudioHandleRecord` / `AudioPlaylist` / `AudioRepeatMode` / `AudioPlaybackState` |
| `src/sillytavern/database.ts` | Dexie v12 四表 + 音频 CRUD（事务保证元数据/字节原子） |
| `src/ui/lib/audio-singleton.ts` | 惰性单例 / 浏览器工厂 / 静默桩 / `setBlobResolver` / 首次手势解锁监听 |
| `src/ui/lib/audio-folder.ts` | File System Access 唯一接触点：选择 / 持久化 / 权限 / 扫描 / 取文件 |
| `src/ui/stores/audio-store.ts` | Pinia 薄壳，**应用的唯一入口** |
| `src/ui/components/settings/AudioSection.vue` | 设置页音频分区（混音台 / 播放列表 / 音轨库三段式 + 音乐文件夹条） |
| `src/ui/components/game/MiniPlayer.vue` | 游戏页浮动迷你播放器 |
| `public/audio/manifest.json` | 内置曲库清单（v1 为 `[]`） |
