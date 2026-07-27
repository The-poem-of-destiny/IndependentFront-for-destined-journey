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
| 进入新地点自动换 BGM（可在设置里关） | 音效由游戏事件触发（**仍未接线**） |
| 按场景选曲：地点/人物/情绪/情境四维加权 | 战斗/制作等**非地点**事件自动换歌（要靠 AI 标记，prompt 侧未接） |
| 解析 `<play_audio>` 并切换 BGM（Code 侧已接线） | 让 AI 产出该标记（**prompt 侧刻意留空**） |
| 按名称寻址曲目与播放列表 | 全角/半角折叠、拼音匹配 |
| 播放列表拖拽排序 | 跨列表拖拽、拖拽到列表外、键盘排序 |
| 曲库多选（shift 区间 / 全选筛选结果）+ 批量加入列表 / 批量删除 | 批量改标签、批量改类型 |

---

## 二、架构分层

```
界面层     AudioSection.vue  编排壳（生命周期 / 跨段派生 / 唯一 aria-live 播报区）
             └── settings/audio/  AudioMixer（混音台） / AudioPlaylists（播放列表）
                                  AudioLibrary（曲库） / AudioFolderStrip（文件夹条）
                                  AudioDialogs（确认与输入弹窗，provide 下发）
                                  format.ts（展示格式化） / dialogs.ts（inject key）
           MiniPlayer.vue (游戏页迷你播放器)
             │  只调 store，不认识 AudioManager
UI 桥接层  audio-store.ts (Pinia)  ← 应用的唯一入口
             ├── audio-singleton.ts   惰性单例 + 浏览器工厂 + 首次手势解锁监听
             └── audio-folder.ts      File System Access API 的唯一接触点
             │  store 调引擎方法、调 Dexie 函数，把两边缝在一起
存储层     database.ts   audioTracks / audioBlobs / audioPlaylists / audioHandles
             │  引擎从不 import 它
引擎层     audio-manager.ts   门面：曲库注册表 + 主音量 + 解锁 + AI 钩子
           audio-channels.ts  MusicChannel（音序器） + SfxChannel（声池） + clamp01
           audio-names.ts     名称归一化 / 查找 / 唯一化（纯函数）
           types-audio.ts     注入 seam 接口 + 两声道与 Manager 的 state/options 形状
```

`AudioSection.vue` 只剩编排职责：分区级生命周期（`init` / 装库 / 进度轮询起停）、跨段共享的可见曲目派生（隐藏名单过滤后同时喂给播放列表与曲库）、以及**唯一**的 `aria-live` 播报区——各子组件的一次性播报统一 `emit('announce')` 上来，全应用只有这一处会读给屏幕阅读器。

`types-audio.ts` 是「唯一类型来源」的音频分册：注入 seam 接口（`AudioContextLike` / `AudioElementLike` / …）与两个声道、Manager 的 state/options 形状住在这里，`types.ts` 用 `export * from './types-audio'` 再导出，import 路径依然只有 `@engine/types` 一条。**音频的数据模型类型仍留在 `types.ts`**（`AudioTrack` / `AudioPlaylist` / `AudioPlaybackState` 等），搬进来会制造第二个真相来源。`audio-channels.ts` 与 `audio-manager.ts` 按原样 re-export 这些类型，历史 import 路径不变。

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
- 每次换曲都 `revokeObjectURL` 上一段 URL——这是唯一的泄漏防线。上一段 URL 的回收**刻意推迟到提交那一刻**：中途作废时旧 URL 还是元素正在用的那个。

#### 加载世代号：在飞的旧加载绝不能"补出声"

一次换曲要跨三个 `await`（淡出等待 → 读字节 → `element.play()`）。这期间用户完全可能又点了停止、又切了一首。没有防线的话，先发出的那次加载会在稍后落地，把新状态覆盖掉，或者在用户已经按下停止之后自顾自地响起来。

做法是一个自增的**加载世代号**：`loadCurrent` 入口处 `invalidateLoad()` 自增并捕获本次世代，随后**每个 `await` 之后**都问一次 `isStale(gen)`——对不上就立刻返回，**不写任何状态**，并回收本次自己造出来的 object URL。`startElement()` 同样受看护：`element.play()` 期间被打断时不仅不写 `status`，还会把已经开播的元素按回去。

作废入口是所有会更换当前曲目或中止播放的路径：`playTrack` / `playPlaylist` / `next` / `prev` / `handleEnded`（都经由 `loadCurrent`）、`stop()` / `pause()` / `pruneTracks()` 掉当前曲 / `dispose()`（`disposed` 也算 stale）。

**`pause()` 与 `stop()` 的语义不同**，差别正在这里：

- `pause()` 撞上在飞加载时，作废之后**把在飞的那首记为当前曲目**并置 `needsReload`——落到「已选中这首、但还没装进元素」的暂停态；随后 `play()` 发现 `needsReload` 会重新走一遍完整加载。
- `stop()` 只作废、回到 0、状态 `idle`，**不接管在飞的那首**（它还没提交，也就没有被选中过），并且**丢弃当前曲目**（`currentTrackId = null` + `needsReload`）。队列保留，`play()` 按队列重新加载。
  最后这半句是补上的防线：不丢的话元素里还留着上一首的 `src`，而队列早已指向另一首，「选了 A → 停止 → 再播」会放回旧的那首，且 `trackId` 与 `queue[index]` 自相矛盾。

#### 取不到字节时跳过，而不是停住整个队列

当前曲目的行没了、或字节读不出来时，`skipUnavailable()` 会**跳到下一首继续**。30 首的列表里坏一首就把后面 29 首全废掉、而且是毫无征兆地静音，比"跳过一首"糟糕得多。

连锁跳过的次数封顶为队列长度——整条队列都坏掉时必须收敛到 `idle`，不能绕着队列无限转。只在 `autoplay`（用户确实想听）时跳；预载 / 暂停态换曲就地停下，免得悄悄把选中曲目挪走。

#### 时长广播

`durationSec` 是**离散状态的一部分**，所以通道监听元素的 `loadedmetadata` / `durationchange`，值真的变了才 `emit()`（同值不重复扇出）。少了这条通路，暂停态换曲拿不到新时长——不自动播放就没有别的时机去刷它，进度条要等恢复播放才正常。`AudioElementLike` 的事件类型因此拓宽为 `AudioElementEvent = 'ended' | 'loadedmetadata' | 'durationchange'`。

注意**只有 `durationSec` 走广播**：`positionSec` 依旧是按需 getter，广播它等于把高频扇出请回来（见 §6.8）。

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

**未授权不等于文件不见了**。`loadBlob` 在读盘前先看 `folderPermission`：不是 `granted` 就只提示一次「需要授权」并返回 `undefined`，**绝不写 `missing`**。浏览器重启后权限退回 `prompt` 是常态（启动期刻意不 `requestPermission`，那需要用户手势），此时每点一首就标一首的话，会把整个曲库逐首污染成"文件已移除"，而磁盘上的文件好好的。同理，`resolveFile` 抛出的异常属于权限被撤销这类**临时**故障，也不作数——只有它明确返回"找不到"才标记。

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
| `play` / `pause` / `toggle` / `stop` | `() => Promise<void>` / `() => void` / `() => Promise<void>` / `() => void` | `stop` 回到 0 且清空 pending，队列保留；`pause` 保留选中曲目（加载中被暂停会落到「已选中未装载」态，`play()` 重新加载）——差别见 §三 |
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

> **批量与落库失败的统一口径**：`uploadFiles` / `rescanFolder` / `forgetFolder` / `deleteTracks` / `addTracksToPlaylist` 这几条路径都遵循同一套规矩——**单条失败不中断其余**，结束后**一条汇总提示**（一屏 toast 等于没有 toast），部分成功就如实呈现部分成功（不做回滚、不谎称全成），并且**界面呈现的状态永远等于持久层的真实状态**。批量动作返回 `AudioBatchResult { ok, skipped, failed }`：`skipped` 是「有意跳过」（内置曲目 / 已在列表中 / 查无此曲），不是错误。
>
> 唯一的例外是上传撞上**存储配额耗尽**：它不是个案，后面的文件基本也没戏，所以就地停下并给出「改用音乐文件夹」的出路。

| 方法 | 签名 | 返回值语义 |
|------|------|-----------|
| `uploadFiles` | `(files: File[], kind?: AudioTrackKind) => Promise<AudioTrack[]>` | 每个文件建一条 `source: 'blob'` 曲目；重名**自动编号**；返回**实际建成**的曲目，失败的不在其中 |
| `findTrack` | `(id: string) => AudioTrack \| undefined` | |
| `findTrackByName` | `(name: string) => AudioTrack \| undefined` | 归一化比较；多命中取 `createdAt` 最早者 |
| `renameTrack` | `(id: string, name: string) => Promise<boolean>` | **`false` = 曲目不存在 / 是内置曲目 / 重名被拒** |
| `setTrackTags` | `(id: string, tags: string[]) => Promise<void>` | 内置曲目空转 |
| `setTrackKind` | `(id: string, kind: AudioTrackKind) => Promise<void>` | 内置曲目空转 |
| `deleteTrack` | `(id: string) => Promise<void>` | 内置曲目不可删；顺带剪掉播放列表悬挂引用 |
| `deleteTracks` | `(ids: string[]) => Promise<AudioBatchResult>` | 曲库多选批量删。内置曲目 / 查无此曲计 `skipped`；逐条尽力做完 |
| `findPlaylist` | `(id: string) => AudioPlaylist \| undefined` | |
| `findPlaylistByName` | `(name: string) => AudioPlaylist \| undefined` | |
| `createPlaylist` | `(name: string) => Promise<AudioPlaylist \| null>` | **`null` = 重名被拒**（不抛） |
| `renamePlaylist` | `(id: string, name: string) => Promise<boolean>` | **`false` = 不存在 / 重名被拒** |
| `deletePlaylist` | `(id: string) => Promise<void>` | 不级联删曲目 |
| `addTrackToPlaylist` / `removeTrackFromPlaylist` | `(playlistId: string, trackId: string) => Promise<void>` | 重复添加空转 |
| `addTracksToPlaylist` | `(playlistId: string, trackIds: string[]) => Promise<AudioBatchResult>` | 曲库多选批量加入。已在列表中的计 `skipped`；**只落一次库**（整序覆盖），写失败即整批 `failed`，不谎称部分成功；列表已不存在时全额 `failed` |
| `reorderPlaylist` | `(playlistId: string, trackIds: string[]) => Promise<void>` | 整序覆盖（拖拽排序的唯一写路径） |

### 6.5 音乐文件夹

| 方法 | 签名 | 返回值语义 |
|------|------|-----------|
| `pickFolder` | `() => Promise<boolean>` | 需要用户手势。**`false` = 不支持 / 用户取消**；成功即扫描 |
| `grantFolderPermission` | `() => Promise<boolean>` | 需要用户手势。**`false` = 无句柄 / 被拒**；成功即扫描 |
| `rescanFolder` | `() => Promise<void>` | 增量对账，永不删行；扫描中重入直接空转。单条落库失败不中断，结束后汇总提示 |
| `forgetFolder` | `() => Promise<boolean>` | 只删句柄，曲目全部标 `missing`。**`false` = 没能完全做到**：句柄删不掉则整个中止、内存态一个字不改（关联其实还在，谎称取消是最坏结果）；句柄删了但个别曲目标不上 `missing` 则部分成功。失败已 toast 说明爆炸半径，调用方无需再报 |
| `loadBlob` | `(trackId: string) => Promise<Blob \| undefined>` | 装给 Manager 的字节解析器；`undefined` = 取不到（`file` 源会顺带标 `missing`）。这条在播放路径上，所以「`missing` 标记本身没能落库」的告警**按 trackId 去重**——同一首只提示一次，等哪次真标上了再把记号清掉，否则反复播放就是一屏 toast |

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
| `playByScene` | `(query: SceneTagQuery) => Promise<SceneTagResult \| null>` | **`null` = 没有任何维度达标**，此时**保持当前播放**。命中时返回命中详情与逐维度得分（见第八节） |
| `playByLocation` | `(location: string, opts?: { variant?: 'A' \| 'B' }) => Promise<SceneTagResult \| null>` | `playByScene({ location, variant })` 的便捷入口，**同一套打分**，不是另一种语义 |

`playByTag` 只匹配 `kind === 'music'` 的曲目；多命中时用注入的随机源挑一首。它是**单标签精确匹配**，适合"我就要这一首/这一组"。

`playByScene` 是场景化上层：地点/人物/情绪/情境四维加权累计，地名不必与标签字面相等，地点无曲时沿层级回退。详见**第八节**。

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

## 八、场景选曲：标签分类 + 多维度累计打分

`audio-tags.ts`（标签分类）与 `audio-scene.ts`（选曲打分）是与 `audio-names.ts` 同级的纯函数模块（无 I/O、无 Dexie、无 Vue、无 AudioContext），一起解决 `playByTag` 解决不了的问题。

**为什么需要它**：正典位置是一条**七段连字符路径**（`agent-config.json` 的 `<tp_format>`）：

```
${大陆方位}-${区域}-${势力}-${子级势力}-${聚落/地标}-${区位}-${详细位置}
大陆中东部-帝国平原-奥古斯提姆帝国-北境行省-艾瑟嘉德-贵族区-锻炉大厅
```

曲库标签却只有几十个固定词。整条路径永远不会等于任何一个标签，`playByTag` 这种整串精确匹配一个都点不着。而路径本身就写明了层级——最细那段没配曲，就该往左退一段用更粗的地点顶上。

### 三档相似度

`nameSimilarity(a, b) → [0, 1]`，档与档之间**刻意不重叠**：

| 档 | 条件 | 取值 |
|----|------|------|
| 相等 | 归一化后相同（复用 `normalizeAudioName`） | `1` |
| 包含 | 一方是另一方的子串 | `0.6 + 0.4 × 长度比`，落在 `(0.6, 1)` |
| 字形 | 二元组 Dice 系数 | `× 0.55`，上限 `0.55` |

低于 `SCENE_MATCH_THRESHOLD`（`0.5`）一律不算命中。

**为什么包含档必须整体压过字形档**：中文地名共享字太多。「碎星群岛」与「碎冕冰脊」共享「碎」，纯 Dice 会给出不低的分数；如果两档区间重叠，一次字形巧合就能压过一次真正的包含匹配。分档之后，「碎星群岛外海」永远赢过「碎冕冰脊」。

### 回退链：层级的首要来源是路径本身

`splitLocationPath(location)` 按 `-－—–/／>＞` 拆段并反转，得到「由细到粗」的序列。**刻意不拿 `·` 分段**——地名自己就带间隔号（`诺瓦·瓦伦蒂亚城`、`拜特·纳尔`、`达尔·苏克`），拿它分段会把一个地名劈成两半。

`buildLocationChain(location, nodes?)` 产出 `{ name, depth }[]`：

1. **路径段**：最细一段 `depth 0`，往左每退一段深一级；
2. **`location-db` 补充**：由细到粗逐段模糊定位，取**第一个**能定位到的段，把它的 `parentId` 祖先接在**它**之后。规范名的深度 = **命中它的那一段的深度**——输入本身就是那个地方时（「铁炉堡的地下锻炉」→「铁炉堡」）那就是 `depth 0`，谁命中都不算回退；但定位发生在较粗的段上时（`永夜领-诺克瓦罗斯城-地穴` 里最细的「地穴」查不到，是「诺克瓦罗斯城」才接上地图的）就不能提到 0，否则城市级曲子会跟区位级曲子平起平坐，最具体的那首反而要靠 `createdAt` 兜底才分胜负；
3. 全链按 depth 稳定排序——选曲按 depth 分组短路，链必须有序。

**为什么路径优先于 `location-db`**：`location-db` 只有三十来个节点，「大陆中东部」这类方位段、「龙脊山脉」这类地貌名它根本没有；而路径里每一段都是现成的层级。`location-db` 退居补充，真正的价值是**路径只写到城市时把势力和大陆补上**，以及「白曜城中央广场」这种没写路径的单段输入——这时它是唯一的层级来源。一条规则同时照顾两种形状。

补充定位必须**逐段上试**而不是只看最细段：路径最细的一段常常是地图上没有的区位（「贵族区」），卡在第一段就白补了。

`parentId` 断链就地停止，成环靠去重与深度上限（8）收敛，都不抛异常。

### 标签分类：`类型:值`

标签写成 `地点:龙脊山脉`、`人物:傲雪`、`情绪:紧张`、`情境:战斗`。四个维度与打分维度一一对应。

**为什么用前缀而不是新字段**：`AudioTrack` 的形状、Dexie 三张表、设置页的标签 UI、`playByTag` 全都不用动。加一个 `taxonomy` 字段要改 schema + 迁移 + UI，代价大得多，收益一样。

- 读取时认别名：`角色:` / `位置:` / `氛围:` / `场景:` 以及 `location:` `character:` `mood:` `situation:`，半角与全角冒号都行；写入只产规范前缀（`formatAudioTag`）。
- **只在第一个冒号处切分**，`情境:战斗:决战` 的值是 `战斗:决战`。
- **无类型标签参与所有维度**。用户手打的 `雨夜` 不知道属于哪一维，就每一维都试——宁可多算，也不要把用户自己打的标签变成死标签。

### 选曲：多维度累计打分

`resolveSceneByTags(tracks, query, opts?) → SceneTagResult | null`

```ts
type SceneTagQuery = {
  location?: string          // 位置路径
  characters?: string[]      // 在场角色
  moods?: string[]           // 情绪
  situations?: string[]      // 情境
  variant?: 'A' | 'B'
  kind?: AudioTrackKind      // 缺省 'music'
}
```

**总分 = 各维度加权分之和**：

| 维度 | 权重 | 说明 |
|------|------|------|
| `location` | `1.00` | 再乘 `LOCATION_DEPTH_DECAY ** fallbackDepth`（`0.8 ** depth`） |
| `situation` | `0.75` | |
| `character` | `0.55` | |
| `mood` | `0.35` | 独木难支，用来在同分里挑边 |
| `variant` | `0.20` | **加分项**，自己不足以让一首曲子入选 |

地点分随回退深度衰减，于是跨维度的强弱是**可推算**的：

| 对比 | 结果 |
|------|------|
| 地点 depth 0 (1.00) vs 情境 (0.75) | 站在有专属曲的地点上，地点曲赢 |
| 地点 depth 2 (0.64) vs 情境 (0.75) | 只能回退两级时，战斗/潜行曲接管 |
| 地点 depth 3 (0.51) vs 人物 (0.55) | 地点已经很泛，在场角色的主题曲接管 |

**这组权重是起始值，不是真理**——什么时候该让战斗曲盖过地点曲、人物主题该多强势，是配乐口味问题。改 `SCENE_TAG_WEIGHTS` 即可，也可以按次传 `opts.weights` 覆盖。

返回值：

| 字段 | 说明 |
|------|------|
| `track` / `score` | 选中的音轨与总分 |
| `breakdown` | 逐维度得分，便于排查"为什么选了这首" |
| `resolvedLocation` / `fallbackDepth` | 地点维命中的地点名与回退深度；地点维没命中时为 `null` |
| `matchedTags` | 各维度命中的标签值 |

五条关键语义：

- **门槛看单维度原始相似度，不看总分**。至少一个维度的原始相似度达到 `SCENE_MATCH_THRESHOLD` 才算命中；拿加权总分当门槛会让权重低的维度天然出局。
- **每一维只跟自己那一维的标签比**。查询里的人物名不会去撞地点标签（无类型标签除外，见上）。
- **多个查询词取最佳单项，不累加**。否则标签打得多的曲子平白占便宜。
- **曲名参与地点维**的比对——曲名常常就是地点名，没打标签的曲子不至于点不着。
- **排除 `missing`**：文件已移除的曲目直接出局，选中它等于选了一次必然失败的播放。

全同分时按 `createdAt` → `id` 兜底，保证答案与数组顺序无关（与 `findByName` 的稳定性口径一致）。

> **为什么没有「逐级短路」了**：早先有过一版只看地点、本级有曲就定下来的 `resolveSceneAudio`。短路与累计分是互斥的两套语义——短路下地点分不可比，就算不出「地点很泛但在场角色很准」这种情况。同时留着会让"为什么选了这首"有两个答案，所以它已撤除，`playByLocation` 现在只是 `playByScene` 的便捷入口。

### store 侧：`playByScene` / `playByLocation`

```ts
// 直接把 <tp> 里 `@` 之后的位置串喂进去即可，不需要预处理
const hit = await audio.playByScene({
  location: '大陆中东部-帝国平原-奥古斯提姆帝国-北境行省-艾瑟嘉德-贵族区-锻炉大厅',
  characters: ['傲雪'],
  situations: ['战斗'],
  moods: ['紧张'],
  variant: 'B',
})
console.log(hit?.breakdown) // 排查为什么选了这首

// 只有地点时的便捷入口，走的是同一套打分
await audio.playByLocation('铁炉堡', { variant: 'A' })
```

两条只有 store 层才有的行为：

- **同一首已在播时不重播**。在同一地点内走动、翻面板都会重复调到这里，每次都从头播会让 BGM 变成一段永远放不完的开头。判据是 `status !== 'idle'`，因此**用户手动暂停后也不会被地点重新唤醒**。
- **未命中保持当前播放**（对齐 `playByTag` 的 `keep` 语义）。换场景时突然静音，比继续放着上一场的曲子更突兀。

---

## 九、AI 集成现状（诚实版）

**结论先行：地点变化触发的场景配乐已全线接通并可用；AI 标记那条链路 Code 侧就绪、prompt 侧刻意留空（AI 不会输出 `<play_audio>`）。音效全链仍未接线。**

| 能力 | 实现 | 测试 | 生产调用方 |
|------|------|------|-----------|
| `playByScene` / `playByLocation` | ✅ | ✅ | ✅ `GamePipeline` 的地点变化触发 + `primeSceneAudio`；AI 标记那条仍无输入（见下） |
| `playByTag` | ✅ | ✅ | ❌ **零**（保留为单标签精确入口） |
| `playSfx` | ✅ | ✅ | ⚠️ 唯一调用方是设置页曲库的试听按钮（`settings/audio/AudioLibrary.vue`），游戏内无任何音效触发点 |
| `playTrackByName` / `playPlaylistByName` | ✅ | ✅ | ⚠️ 仅 UI |
| `public/audio/manifest.json` | ✅ 57 首内置曲目 | — | 授权 `UNVERIFIED`，见 `public/audio/README.md` |

### 谁来触发换歌：两条来源，AI 标记优先

```
① 地点变化（主路径）  player.location 与上次选曲时不同 → 自动按地点选曲
② AI 标记（可选）     story 输出 <play_audio> → 按它给的情境/情绪选曲
```

两条都收口在 `GamePipeline.flushPendingAudio()`，都在 `refreshFromDb()` 之后执行：

- **有标记时标记赢**。story 知道这一刻的戏剧意图（要打起来了 / 气氛转冷），比"地点变了"这个纯事实更准。
- **没标记就看地点变没变**。**没变就不动音乐** —— 同一个地点里来回走动、翻面板不该反复重选曲子。
- 进入游戏页时 `primeSceneAudio()` 起一次（读档回来的第一眼也该有音乐），并把 `lastAudioLocation` 定下来，于是紧接着的第一轮不会为同一个地点再选一遍。
- 用户在设置里关掉「场景配乐」后**两条来源都不生效**，音乐完全交回手动控制。关闭期间照样记录地点，重新打开时不会为"早就待着的地点"补播一次。

**曲库由游戏页负责装载**：`GamePage` 挂载时调 `audio.init()`。在此之前只有设置页音频分区与迷你播放器会 init，没打开过它们的会话曲库是空的 —— 选曲永远命中不了任何东西，而且是静悄悄地命中不了。

### AI 标记链路：Code 侧四段是怎么接的

```
story Agent  输出 <play_audio situation="战斗" mood="紧张"/>
   │           ⚠️ 约定尚未写进任何 prompt —— 这一段是空的
   ▼
marker-protocol.ts  scanPlayAudioMarkers() → PlayAudioMarker
   │           自闭合 / 成对 / 只有开标签没闭合，三种写法都认；scanMarkers 一并收录
   ▼
agent-orchestrator.ts  processStageMarkers() Stage 1 → events.onPlayAudio
   │           编排器不 await；一轮多个标记只取最后一个
   ▼
game-pipeline.ts  Stage 1 只**暂存**标记；run() 末尾 refreshFromDb() 之后才
               flushPendingAudio() → handlePlayAudio() → playByScene()
               地点取 player.location、角色取 present === true 的 NPC
```

四个设计取舍，每个都有具体理由：

- **AI 不写地点，也不写在场角色**。这两样已经是游戏状态里的事实（`player.location` / `character.present`），让 AI 再写一遍只会多一处漂移源——它写的地点和状态里的地点对不上时，你没有第三方可以裁决。AI 只负责它独有的判断：此刻是什么情绪、什么情境。
- **不阻塞管线，但必须等状态落库**。编排器不 `await` 配乐，抛错也只 `console.warn` 吞掉——配乐是旁路氛围，换不换歌都不该影响这一轮叙事的产出。但触发点**不能留在 Stage 1**：story 在那时就写下了标记，而 `player.location` / `character.present` 要等 Stage 2 的 `request_dispatcher` / `vars_update` 落库、再经 `refreshFromDb()` 才更新。**转场恰恰是唯一真正该换歌的时刻**，在 Stage 1 播就等于正文已经进了熔火裂谷、BGM 还在放上一座城的曲子。所以 Stage 1 只暂存，`run()` 末尾回读之后才 flush（abort / 报错路径同样 flush——正文都产出了，该换的歌照换）。
- **一轮多个标记时只取最后一个**。AI 在一轮里改主意是常事，以它最后的判断为准；连着切两首歌只会让玩家听见两个开头。
- **标记必须从正文里剥掉**。`stripPlayAudioMarkers()` 在 story 消息入库前剥它——漏出去就是玩家眼前的一行尖括号。这里**刻意不用 `stripMarkers`**：正文渲染路径目前保留着 craft/combat 等标记（美化规则与下游链路还在读），一把全剥会改掉既有行为。

`<play_audio action="stop"/>` 走 `audio.stop()`；`variant="A"/"B"` 透传给打分器。正文形式 `<play_audio>探索, 平静</play_audio>` 的自由词**同时喂给情绪与情境两维**——与"无类型标签参与所有维度"同一个道理。

### 还没接的

**AI 标记的 prompt 侧（刻意）**：story 的 systemPrompt / 预设里**没有** `<play_audio>` 的输出约定，所以 AI 不会产出这个标记。**这不影响场景配乐本身** —— 地点变化那条主路径不经过 AI。加上它只是让 AI 能在"地点没变但气氛变了"（战斗爆发、气氛转冷）时额外插一手。这是有意为之——先把 API 接口稳定下来，prompt 怎么写、什么时候该换歌是独立的一次调整。

要启用时只需在 story 预设里加一个条目，说明标记格式与"只在场景转折时输出"的克制原则。**Code 侧一行都不用改。**

在此之前，`playByScene` 仍可由 UI 或调试面板手动调用来验证选曲效果。

**音效全链空白**：需要在战斗结算、制作成功、状态效果触发等处埋 `playSfx` 调用点。基建（声池 / 并发上限 / 体积门禁）早就完备，缺的只是触发方。

**真机验证**：整条链路的测试都跑在注入替身上（jsdom 没有可用音频后端），浏览器里到底出不出声**尚未验证过**。

### 为什么给 AI 的是标签而不是 id

对齐「AI 永不产 id」铁律。AI 只需要说"现在是战斗、气氛紧张"，由 Code 层按标签维度打分选曲。用户的曲库内容与 AI 的 prompt 完全解耦——换一批音乐不需要改任何 prompt。

未命中时**保持当前播放**也是同一个考虑：如果曲库里没有任何曲子配得上此刻的场景，不该让音乐**突然静音**——那比"音乐不贴合"糟糕得多。

---

## 十、限制与已知问题

### 手势解锁

浏览器的自动播放策略要求：`AudioContext` 出生即 `suspended`，必须在**用户手势的调用栈里** `resume()` 才能出声。

系统的处理：`installUnlockListener()` 挂 `pointerdown` / `keydown` 监听，手势到来时调 `manager.unlock()`，**解锁成功才自摘**（`resume()` 被拒时留着监听等下一次手势——先摘再解锁的话，一次拒绝就让音频永久锁死）。锁定期内的播放请求**不抛错**，而是记进 `pending`（`playTrack` 会把 id 存进 `pendingTrackId`，UI 用它显示「点击页面任意处即可开始播放音乐」），解锁后自动兑现。

**监听必须在 `main.ts` 应用启动时就装**，不能等到音频用起来（`audio.init()`）才装。"点某个按钮进游戏"这一下手势发生在 `GamePage` 挂载**之前**，等挂载后才装监听就白白错过了它——进场配乐只能落进 `pending`，玩家得**再随便点一下**才出声，表现为"进去没声音，点一下音乐按钮就有了"。装监听本身不构造 `AudioContext`（`getAudioManager()` 只在手势回调里调），所以从不碰音频的会话也不会平白多出一个 ctx。

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
| 播放列表排序仅支持拖拽，键盘用户不可用 | 原生 HTML5 拖放需要指针，而原先每行的 ▲▼ 兜底**已按需求移除**，且刻意不提供任何键盘替代路径（Alt+方向键、隐藏按钮等一律不加）。键盘/辅助技术用户无法调整播放列表次序；排序结果的 `aria-live` 播报仍在，但那只是结果播报，不构成操作入口 |
| 排序按**可见行**下标索引 | `moveTrack` 拿到的是渲染行的位次，而写回的是 `trackIds` 的整序覆盖。列表里若有解析不出曲目的悬挂 id（渲染时被滤掉），下标会错位。属**既有行为**：`deleteAudioTrack` 会在同一事务里剪掉悬挂引用，正常路径下不会留下这种 id |
| **从未在真实浏览器里跑过** | 见下 |

#### 踩坑记录：勾选框不能靠 `@click.prevent` 回滚

曲库多选的勾选框曾写成 `:checked` + `@click.prevent`（指望浏览器把翻转「取消」掉，
状态全由选中集合驱动）。**真机上这条路是坏的**：浏览器先翻转 `checked` → 调监听器 →
监听器返回时 JS 栈已空，微任务检查点触发，**Vue 在这一刻打完 DOM 补丁** → 浏览器这才
执行「取消激活恢复」，把刚打上的勾抹回点击前的值。表现为选中集合、计数、行染底全对，
唯独那一行的勾永远打不上。jsdom 的补丁排在恢复之后，所以旧测试全绿也没拦住。

现行做法是**受控闭环**：放手让浏览器翻转，处理函数末尾用 `syncBox()` 把 DOM 写回集合的
真值（全选框还要一并写 `indeterminate`，浏览器点击时会把它清掉）。这样无论 Vue 补不补
这个 prop（值没变时它会跳过），DOM 与状态都已经一致。

### ⚠️ 最重要的一条

**整套系统的所有测试都跑在注入的测试替身上**（`audio-fakes.ts` 的伪 `AudioContext` / 伪 `AudioElement`、`audio-folder.ts` 的 `__setFolderTestHooks`）。这意味着：Web Audio 图的连接是否真的出声、`MediaElementSource` 与 blob URL 的兼容性、真实 `showDirectoryPicker` 的行为、各浏览器的自动播放策略差异——**全部未经真机验证**。

真机联调时优先怀疑：解锁时机、`crossOrigin` 与 `MediaElementSource` 的相互作用、大文件夹扫描耗时、`revokeObjectURL` 的时序。

---

## 十一、测试

| 文件 | 用例数 | 覆盖范围 |
|------|-------|----------|
| `src/sillytavern/audio-channels.test.ts` | 69 | 队列推进矩阵、shuffle、淡入淡出、object URL 回收、**加载世代号作废矩阵**、时长广播、`pruneTracks`、声池抢占/并发上限/三道门禁 |
| `src/sillytavern/audio-manager.test.ts` | 54 | 曲库注册表、master gain、解锁与 pending 兑现、`playByTag` 命中/多命中/fallback、状态广播 |
| `src/sillytavern/audio-names.test.ts` | 40 | 归一化四步、扩展名边界、`findByName` 稳定性、`isNameTaken`、`uniqueAudioName` 换号 |
| `src/ui/lib/audio-folder.test.ts` | 27 | 能力探测、句柄持久化、权限归一化、扫描过滤/排序/单文件容错、`resolveFile` NotFound |
| `src/ui/lib/audio-singleton.test.ts` | 26 | 惰性单例、无 Web Audio 时的静默桩、`setBlobResolver`、首次手势解锁监听与自摘 |
| `src/ui/stores/audio-store.test.ts` | 40 | 库加载、上传编号与配额中止、CRUD 拒绝路径、**批量删除/批量加入的分项计数**、文件夹对账与部分失败汇总、按名播放 |
| `src/ui/components/settings/AudioSection.test.ts` | 35 | 设置页三段式交互（拆分后仍从壳层挂载整棵子树）、拖拽排序、曲库多选与批量动作 |
| `src/ui/components/game/MiniPlayer.test.ts` | 12 | 迷你播放器交互与轮询配对 |

### 为什么引擎层必须有注入缝

vitest 的 `environment: 'node'` 里**没有** `AudioContext`、`Audio`、`URL.createObjectURL`；jsdom 里也没有可用的 Web Audio 实现。所以 `AudioManagerOptions` 的 `createContext` / `createElement` / `createObjectURL` / `revokeObjectURL` / `random` / `fadeMs` / `loadBlob` **不是风格偏好，而是测试套件存在的前提**。

同理，`AudioManager` 在浏览器全局缺失时只在**被调用**时才抛错（`defaultCreateContext` 惰性引用），而 `audio-singleton.ts` 更进一步——缺失时返回**静默 no-op 桩**而不是抛错，让应用和每个组件测试都能在无 Web Audio 的环境里活下来，只是没有声音。

`fadeMs: 0` 让淡入淡出走完全同步的路径（不排定时器、不 await），这是通道测试能确定性断言的关键。

---

## 附：关键文件清单

| 文件 | 职责 |
|------|------|
| `src/sillytavern/audio-channels.ts` | `MusicChannel`（音序器） / `SfxChannel`（声池） / `clamp01`（音量归一化，子系统内唯一一份） |
| `src/sillytavern/types-audio.ts` | 注入 seam 接口 + 两声道与 Manager 的 state/options 形状（由 `types.ts` 再导出） |
| `src/sillytavern/audio-manager.ts` | `AudioManager` 门面：曲库注册表 / master gain / 解锁 / `playByTag` |
| `src/sillytavern/audio-names.ts` | 名称归一化 / `findByName` / `isNameTaken` / `uniqueAudioName` / 扩展名→MIME 表 |
| `src/sillytavern/audio-fakes.ts` | 共享测试替身（伪 AudioContext / AudioElement） |
| `src/sillytavern/types.ts` | `AudioSourceKind` / `AudioTrackKind` / `AudioTrack` / `AudioBlobRecord` / `AudioHandleRecord` / `AudioPlaylist` / `AudioRepeatMode` / `AudioPlaybackState` |
| `src/sillytavern/database.ts` | Dexie v12 四表 + 音频 CRUD（事务保证元数据/字节原子） |
| `src/ui/lib/audio-singleton.ts` | 惰性单例 / 浏览器工厂 / 静默桩 / `setBlobResolver` / 首次手势解锁监听 |
| `src/ui/lib/audio-folder.ts` | File System Access 唯一接触点：选择 / 持久化 / 权限 / 扫描 / 取文件 |
| `src/ui/stores/audio-store.ts` | Pinia 薄壳，**应用的唯一入口** |
| `src/ui/components/settings/AudioSection.vue` | 设置页音频分区的**编排壳**：生命周期 / 跨段派生 / 唯一 aria-live 播报区 |
| `src/ui/components/settings/audio/` | `AudioMixer`（混音台） / `AudioPlaylists`（播放列表 + 拖拽排序） / `AudioLibrary`（曲库 + 文件夹条 + 多选批量） / `AudioFolderStrip` / `AudioDialogs` + `format.ts` / `dialogs.ts` |
| `src/ui/components/game/MiniPlayer.vue` | 游戏页浮动迷你播放器 |
| `public/audio/manifest.json` | 内置曲库清单（v1 为 `[]`） |
