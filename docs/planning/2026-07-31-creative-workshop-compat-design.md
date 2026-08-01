# 创意工坊兼容层设计 v2

> 状态：**已实施（Phase 0 / 0b / 1 全部落地，2026-07-31）** · 分支 `creative-workshop-integration-v1`
> 设计本身评审通过于 2026-07-31 拷问定稿；实施纪要见 `docs/CHANGELOG.md`「工坊 P0 / P0b / P1」。
>
> 上游：【命定之诗】创意工坊 —— 角色卡内嵌酒馆助手脚本 + Cloudflare Worker 后端
> 源码：`github.com/AkabaneSaki/myrepo`
>
> **v2 说明**：v1 的 D1–D17 经逐条拷问后大幅收敛，决策重新编号。v1 中被推翻的结论（默认拒绝反转、项目 id 独立存储、合并视图、workshopBooks 表、正则不导入、排除备份）不再保留正文，仅在 §9 列出以免重复讨论。
>
> **实施期偏离本文之处（以实现为准）**：
>
> 1. **新增 Phase 0b —— 美化规则迁出 localStorage**（Dexie v15 `beautifierRules` 表 + `AppSettings.beautifierPresetRules` 字段整个删除）。定稿时未预见：§1 D5 把「美化规则仍只在 localStorage」列为**范围外**，实施中发现内置规则 22 条 = 386,645 字符（≈378 KB）与工坊正则（再 ≈494 KB）困在同一个配额里，与 Phase 0 是同一个缺陷，遂就地补做。
> 2. Phase 0 迁移在审查中修掉两个会丢数据的缺陷（重复 id 静默合并 / 导入旧备份清空 worldBooks 表），详见 CHANGELOG。
>
> **仍然成立的取舍**：§0 那句「Phase 1 装进来的世界书条目在 Phase 2 落地前不会被求值」**依旧是现状** —— **Phase 2 未做**，工坊条目正文里的 EJS 原样进 Agent 上下文。

---

## 0. 阶段划分

| 阶段         | 内容                                       | 依赖                                   | 状态                     |
| ------------ | ------------------------------------------ | -------------------------------------- | ------------------------ |
| **Phase 0**  | 世界书从 localStorage 迁移到 Dexie         | 无 —— 独立价值，且是 Phase 1 的前置    | ✅ 已实施（Dexie v14）   |
| **Phase 0b** | 美化规则从 localStorage 迁移到 Dexie       | 无 —— **实施期新增**，定稿时未预见     | ✅ 已实施（Dexie v15）   |
| **Phase 1**  | 创意工坊：浏览 · 下载 · 安装 · 更新 · 卸载 | Phase 0                                | ✅ 已实施 + 真机走查已过 |
| **Phase 2**  | EJS 沙盒 + 只读 stats 投影（另行设计）     | 无强依赖，但工坊内容需要它才能真正生效 | ⬜ **未做**              |

**已确认的取舍**：Phase 1 装进来的世界书条目在 Phase 2 落地前**不会被求值**——条目正文里的 EJS 会原样进入 Agent 上下文。这**不是**新增的缺陷：内置世界书今天就在这么干（`event.json` 297 个 EJS 块、`system_core.json` 252 个）。工坊条目与内置条目一视同仁，不做特殊门禁（D6）。

---

## 1. Phase 0 —— 世界书迁移

### D1 — 现状与动因

当前 `WorldBook`（Phase 8 类型）**全部存在 localStorage**：`settings-store.ts` 用一个 ref 装下全部设置，deep watch 序列化进单个 key。Dexie 里的 `lorebooks` 表是 v3 遗留的 `Lorebook` 类型，生产代码零读写。

三个后果：

| 问题             | 实测                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 配额压力         | 内置世界书紧凑序列化 889,962 字符（≈0.85 MB；localStorage 按 UTF-16 计约 1.7 MB），配额通常 5 MB。且 [settings-store.ts:233](../../src/ui/stores/settings-store.ts:233) 配额溢出**静默 catch**          |
| 写放大           | deep watch 在**任何**设置变更时重新 `JSON.stringify` 整个 ~2 MB 设置对象                                                                                                                                |
| **备份不覆盖** ★ | 设置页 存档数据 分区标注「IndexedDB + localStorage」，但 `exportAllData()` 只做 `db.*.toArray()`，**从不读 localStorage**。导出→清库→导入 会丢失全部世界书编辑、自建/导入书、Agent 配置、美化规则、主题 |

### D2 — 行为保持迁移，不改语义

**整本持久化**，不做「只存用户改动 + 内置从磁盘现加载」的增量方案。

理由：行为保持的迁移不应同时改语义，否则无法验证。增量方案需要的覆盖合并层，正是当前那句「已有 → 保留 localStorage 版本」特例的同类复杂度。IndexedDB 配额是数百 MB 量级，0.85 MB 无意义。想做增量存储，等数据搬到正常地方之后另开。

### D3 — 表拓扑

```ts
this.version(14).stores({
  ...（重述 v13 全部 19 表）,
  worldBooks:       'id, partition, updatedAt',   // 全部世界书：内置 / 导入 / 工坊
  workshopProjects: 'id, installedAt, updatedAt', // 仅项目生命周期元数据
});
```

- **只有一张世界书表**。工坊书就是 `partition: 'creative_workshop'` 的普通行，没有第二张表、没有第二种形状。
- `workshopProjects` 独立存在，是因为它承载 `WorldBook` 没有字段位的东西（`downloadUrl` / `version` / `installedVersion` / `fetchedAt` / `uidRange` / `droppedNotes` / `tags`）——项目生命周期数据不该塞进每本内置书也要用的类型里。
- **`lorebooks` 与 `settings` 两张死表原样保留**。删表要写 `lorebooks: null`，会永久抹掉长期用户可能仍存有的 v1–v3 行；它们放着不花钱，导出也只是空数组。删除是独立的、需要明确决定的动作，不是迁移的附带损伤。
- `partition` 索引：工坊过滤是一等访问模式，保留。（若按 D3 的「不建死索引」原则从严，去掉也不影响正确性。）

### D4 — 切换流程：原子写 → 校验 → 再销毁

`settings.worldBooks` 是每一条用户编辑的**唯一副本**，且今天不在任何备份里。搞砸即不可恢复。

1. **以显式标志位判定**：`settings.worldBooksMigratedAt`。**不**以「表里有没有行」判定——半失败的运行会留下行，看起来像已完成。
2. **单个 Dexie 事务**（`db.transaction` 内 `bulkPut`），写入全有或全无。
3. **销毁前校验**：回读表，逐本比对书数量与条目数量，与源数组完全一致才继续。
4. **然后**删除 localStorage 副本、置标志位，顺序不可颠倒。
5. **任何一步失败：localStorage 原封不动、标志位不置。** 应用继续读 localStorage，用户无感，下次启动重试。最坏情况是迁移永不成功——严格优于半成功。
6. **启动顺序**：内置书合并（`loadBuiltInWorldBooks()` → 缺则补）必须在迁移**之后**、针对 Dexie 执行。若先跑，会把内置书重新写回 localStorage，源数组在迁移脚下漂移。

不保留 localStorage 回滚副本——留着就没释放配额，而释放配额正是本次迁移的目的。代价由第 3 步的校验强度承担。

### D5 — 备份

`FullBackup` **新增 `worldBooks` 与 `workshopProjects` 两个字段**，`exportAllData()` / `importAllData()` 同步。

- 世界书是用户数据（编辑、自建、导入），必须进备份——这修掉 D1 表里那个缺陷的一半。
- `workshopProjects` 是元数据，几 KB。少了它，恢复出来的备份会有工坊内容却不知其来源与版本。
- `FullBackup.version` 递增；`importAllData` 需容忍旧备份缺这两个字段。
- **仍然排除**：音频 blob、素材 blob —— 体积量级不同，各有独立导出口，不变。

**范围外（另行跟踪）**：Agent 配置、美化规则、主题仍然只在 localStorage、仍然不进备份。这是同一个缺陷的另一半，但扩进本次工作会失控。

> 📌 **实施期修正**：其中**美化规则已在 Phase 0b 补做完毕**（Dexie v15 `beautifierRules` 表 + 进 FullBackup）。Agent 配置与主题**仍在 localStorage、仍不进备份**，缺陷剩这一半。

---

## 2. Phase 1 —— 分区

### D6 — 新分区 `创意工坊`，一律归类 ★需求铁律

`WorldBookPartition`（[types.ts:22](../../src/sillytavern/types.ts:22)，现 15 个成员）追加：

```ts
  | 'creative_workshop'; // 创意工坊 — 社区二创内容
```

**所有工坊条目一律 `partition: 'creative_workshop'`**，无论上游标成系统 / 角色 / 事件 / DLC。上游 `tags`（`["系统","外挂","改词"]` 等）**只作展示与筛选**，不参与分区判定。

**理由**：分区在本引擎是**信任域边界**，不是内容学分类。工坊内容来自「无审查机制」的社区投稿，必须能被整体识别、整体开关、整体排除。混进 `system_core` / `character` 会让「这条是不是我自己的内容」永久不可判定。

**除此之外，工坊条目与其它条目完全一视同仁**——同一张表、同一套启用机制、同样可在 `WorldBookEditor` 编辑、同样进备份。没有门禁、没有禁用态控件、没有分区特判。

### D7 — 一项目一本书

```
WorkshopProject（1） ──→ worldBooks 行（1）
                          id        = `workshop:${projectId}`
                          partition = 'creative_workshop'
                          builtIn   = false
```

内置书是 `id === partition` 的一一对应；工坊是**多本书共用一个分区**的第一例。这直接引出 D8。

### D8 — uid 必须在分区内重新分配 ★否则数据损坏

[worldbook-loader.ts:190](../../src/sillytavern/worldbook-loader.ts:190) 的 `filterBooksByEnabledEntries()` 以 **partition 为键**建 uid 允许表：

```ts
const allowedUids = enabledByPartition.get(book.partition);
```

存档 `enabledWorldBookEntries` 是 `"partition:uid"` 格式。多本书共用 `creative_workshop` 时，`creative_workshop:5` 会同时命中**所有**工坊书里 uid=5 的条目。而上游每个项目 uid 都从 0 起编（实测 `"uid":"0"`），**跨项目撞号是必然**。

**方案**：安装时由分区级分配器重新发号，全局单调递增。

```
安装 → allocateUids(entries) → uid ∈ [nextUid, nextUid + n)
       nextUid 持久化在 workshopProjects 的分配游标
```

- **与铁律1 一致**：逻辑键=名字，`uid` 只是引擎内寻址句柄。上游 uid 降级为 `extra.workshop.sourceUid` 溯源，不参与任何判定。
- **卸载不回收号段**：回收会让旧存档的 `enabledWorldBookEntries` 指向新项目的条目——静默的内容错位，比浪费号段严重得多。

### D9 — 内置书装载器不动

`builtin-worldbooks.ts` 的 `BUILTIN_IDS` 与 `worldbook-loader.ts` 的 `WORLD_BOOK_FILES` 不新增条目——工坊书不是 `data/worldbooks/*.json` 静态文件。

---

## 3. 启用模型

### D10 — 两条轴

| 轴         | 粒度               | 存储                                                                                    |
| ---------- | ------------------ | --------------------------------------------------------------------------------------- |
| **已安装** | 项目               | 全局 —— `worldBooks` + `workshopProjects` 行（照音频库/素材库先例，下载一次全存档可用） |
| **已启用** | 项目（展开成条目） | 每存档 —— `SaveSlot.metadata.enabledWorldBookEntries`，写 `creative_workshop:<uid>`     |

**启用完全走既有机制**，与 `system_core:413` 无异。不新增 SaveSlot 字段、不改 `filterBooksByEnabledEntries`、不做分区特判。缺省语义沿用现状（分区未出现在 `enabledWorldBookEntries` → 整本放行），与所有导入书一致。

**真正的闸门是 Agent 可见性**（D11），不是存档启用。

### D11 — Agent 默认不可见（= 既有规范，非特例）

新装工坊书不自动加入任何 Agent 的 `worldBookIds`，须在设置页显式勾选。

这**不是**为工坊新增的限制：[SettingsPage.vue:1009](../../src/ui/components/settings/SettingsPage.vue:1009) 的 `importWorldBook()` 只往书列表里 push，从不碰 Agent 配置——每一本导入书都是这样。没有 Agent 指向的书，不管存档怎么设置都注入不到任何地方。

### D12 — UI 粒度是项目，不做冲突拦截

- 勾一个项目 → 写入其全部条目的 `creative_workshop:<uid>`。用户不需要在维拉的 12 条里挑 11 条；那 12 条是一个作品。
- **不做命定核心冲突检测**：工坊项目可能自带命定核心，与内置单选的那个撞。但 `tags` 是上游自由文本（"系统"/"命定核心"/"外挂"/"路边"），无可靠机器信号，猜必误伤。**UI 显著展示 tags 与简介，由用户判断。**
- 捏人页现有的命定核心是**单选一个 uid**（`selectedSystemCoreEntryUid`），项目是 N 条条目，塞不进那个槽 —— 工坊走自己的多选列表。
- **实施期 UX 调整（2026-07-31）**：工坊多选列表与命定核心单选**同屏并列**，都在捏人页「命定核心」步骤里，拆成视觉上分开的两轴（`一 · 命定核心` 单选·必选 / `二 · 工坊项目` 多选·可选）；工坊区从 `CreateStepCharacters.vue` 挪到 `CreateStepDestinyCore.vue`，原步骤名「内容启用」改回「角色启用」。**仍不做冲突拦截** —— 同屏之后反而更好落实本条决策：用户能同时看到内置命定核心与工坊项目的 tags 与简介，自行判断是否撞车。纯 UI 位置调整，`create-store` 三条轴逻辑与 `buildEnabledWorldBookEntries()` 输出逐字未变（有测试钉住）。
- 建档后须可改（工坊项目是玩到一半装的），因此除捏人页外还需一个每存档的启用面板。

---

## 4. 数据契约

### D13 — `WorkshopProject`

上游 `project` 有 34 字段，其中 17 个属身份/审核/社交。Phase 1 只落自己要的；上游原始响应不整包存库（否则即第二真相来源，违反铁律4）。

```ts
export interface WorkshopProject {
  id: string; // 上游 uuid，跨版本稳定
  rootProjectId: string; // 版本族系根
  name: string;
  description: string;
  version: string; // 上游自由填，本引擎只做串比对不解析
  authorName: string; // authorGlobalName 优先，回退 authorName
  tags: string[]; // 仅展示与筛选，不参与 partition（D6）
  coverUrl?: string;
  downloadUrl: string;
  fileSize: number;

  // ===== 本地状态 =====
  installState: 'installed' | 'update_available' | 'broken';
  installedVersion: string;
  installedAt: number;
  fetchedAt: number; // 上次拉取上游元数据时间（TTL 判定）
  uidRange: { start: number; end: number };
  droppedNotes?: string[]; // 安装时的处置记录，供 UI 提示
}
```

**刻意丢弃**：`publishedProjectId` `draftProjectId` `authorId` `authorAvatar` `status` `reviewedAt` `reviewerId` `rejectReason` `reviewTarget` `visibility` `isPublished` `hasPendingDraft` `latestApprovedAt` `likesCount` `subscribesCount` `downloadsCount` `userLiked` `userSubscribed` —— 全属 Phase 3+ 的认证/审核/社交面。

### D14 — 条目溯源

```ts
entry.extra = {
  workshop: {
    projectId: string;
    projectName: string;
    sourceUid: string | number;  // 上游原始 uid，仅溯源
    sourceComment: string;       // 上游 comment（= 本引擎的 name）
    sourceHash: string;          // 安装时正文哈希 —— 供 D15 精确判定是否被改过
  },
};
```

---

## 5. 更新与冲突

### D15 — 按名匹配，覆盖式更新，改动过就警告

- **匹配**：新旧条目按 `name` 配对（铁律1）。存活条目 **uid 保持不变** → 存档的 `enabledWorldBookEntries` 无需重写。
- **删除**：上游移除的条目，其 uid 退休（不回收，D8）。存档里的残留引用惰性失效。
- **新增**：从分配器领新号。
- **冲突**：逐条比对当前正文与 `sourceHash`。
  - 未改动 → 静默覆盖（这正是更新的语义）
  - **已改动 → 覆盖，但更新前弹警告**，明确告知「你编辑过的 N 条将被覆盖」，确认后继续。不提供逐条保留选择。

`sourceHash` 的唯一用途是让警告**精确**（只在真有编辑时出现），而非无条件恐吓。若认为不值这个字段，可退化为无条件警告。

---

## 6. 正则

### D16 — 原样安装，默认启用，不做任何剥离

工坊载荷除世界书条目外带 ST 正则（实测 2 / 3 / 1 条）。落点是现有**输出美化规则库**。

**实测形态**：6/6 条的 `replaceString` 都是包在 ` ```html ` 围栏里的完整 HTML 文档，各含 1 个 `<script>` + 1 个 `<style>`，长度 10 921 – **340 412** 字节。

**决策：原样安装、默认启用、不剥离 `<script>`、不剥离 `<style>`。**

字段映射：

| ST 正则         | → `BeautifierRule`                                  | 备注                                                                                                                                        |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `findRegex`     | `pattern` + `flags`                                 | ⚠️ **两种形态**：实测 2 条是裸 pattern、4 条是 `/pattern/flags`，解析器必须都吃                                                             |
| `replaceString` | `replacement`                                       | ✅ 捕获组方言**已核实兼容**：一律 `$1..$9`，`{{match}}` 出现 0 次；引擎侧 `result.replace(re, rule.replacement)` 同为 JS 语义，**无需转写** |
| `disabled`      | `enabled`                                           | 取反                                                                                                                                        |
| `scriptName`    | `name`                                              |                                                                                                                                             |
| `markdownOnly`  | `scope: 'maintext'`                                 |                                                                                                                                             |
| —               | `isBuiltin: false` · `group: '创意工坊 · <项目名>'` |                                                                                                                                             |
| —               | `autoEnable.worldBookIds: ['workshop:<id>']`        | 装了才启用，卸载即失效                                                                                                                      |

**无对应物、明确丢弃**：`promptOnly`（美化库是显示层，无提示词侧改写通道）· `placement` · `minDepth`/`maxDepth` · `substituteRegex`（⚠️ 实测是**枚举**不是布尔，值 0 与 2）· `runOnEdit` · `trimStrings`。逐条记入 `droppedNotes`，UI 明示「N 项未导入」——**丢弃必须 loud**，静默截断会让用户以为装全了。（⚠️ 「N 项未导入」这个单一口径已被**实施期修订**推翻，见本节末「D16 实施期修订」）

**已知后果（已确认接受）**：

- `<script>` 在 `v-html` 中**不会执行**（浏览器不执行 innerHTML 插入的脚本），保留它只占字节。
- `<style>` **会全局生效**——启用的工坊规则会把自带样式表泄进应用的主题 token 体系（`docs/design.md` + 10 主题）。
- HTML 里的内联事件处理属性（`onclick` 等）**会触发**。
- `src/ui/` 全域无 iframe / srcdoc / ```html 围栏渲染器，故这些载荷渲染出来是残缺的（`<html>/<head>/<body>` 被解析器丢弃）。

以上均在 `droppedNotes` 中记录，项目卡片如实展示。

另有 1/6 条（读者对话渲染0726）的 `replaceString` 含 2 处 `{{getvar::}}` 宏，引擎美化管线无宏替换环节 —— 记入 `droppedNotes`。

#### D16 实施期修订 —— `droppedNotes` 分三类（2026-07-31）

**问题**：本节原定的单一口径「N 项未导入」在真机上会**撒谎**。装「艾莉亚核心先行版 v3.2.1」时 UI 顶部写「**34 项内容未导入**」，但那 34 条 note 里只有约 14 条是真丢弃；其余 20 条描述的对象是**已装且已启用、只是渲染受限或有副作用**的正则 —— Dexie 里那 5 条正则全部 `enabled`，世界书那边也装得好好的。用户读到「34 项未导入」只会以为安装失败。

**修订**：note 从裸 `string` 升为带 `kind` 的结构，分三类：

| kind         | 含义                                  | 覆盖                                                                                                                         |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `dropped`    | ST 字段本引擎无对应物，**确实没导入** | `placement` · `maxDepth` · `minDepth` · `runOnEdit` · `promptOnly`（整条跳过）· `substituteRegex` · `trimStrings` · 退休条目 |
| `degraded`   | **已装**，但渲染不完整                | ` ```html ` 围栏无渲染器 · 完整 HTML 文档被解析器截断 · `<script>` 惰性 · `{{宏}}` 无替换环节 · 上游重名本地改名             |
| `sideEffect` | **已装**，且有规则自身之外的副作用    | `<style>` 全局生效、可能覆盖应用主题 token                                                                                   |

三类的事实依据全部来自本节「已知后果（已确认接受）」——修订没有改变任何一条已知后果，只是**停止把「已装但受限」误报成「未导入」**。

- 类型：`types.ts` 新增 `WorkshopNoteKind` / `WorkshopNote` / `WorkshopNoteLike`
- 纯函数：`workshop-types.ts` 新增 `workshopNote` / `normalizeWorkshopNote(s)` / `groupWorkshopNotes`。**向后兼容**：已装项目在 Dexie 里存的是旧 `string[]`，裸字符串与脏 `kind` 一律退回 `dropped`，**绝不抛**
- 打 kind：`workshop-regex-map.ts` / `workshop-install-plan.ts`；文案口径统一在 `components/workshop/format.ts`
- UI：`WorkshopInstalledList.vue` 折叠行三段分计数（`sideEffect` 带 ⚠ 且最显眼），`WorkshopPage.vue` toast 同口径

**真机复验**：同一批 note 现在显示为「14 项未导入 · 15 项已装但效果受限 · ⚠ 5 项有全局副作用」，合计仍是 34。**「丢弃必须 loud」不变**，改的是 loud 的对象要分得清 —— 把不同性质的事混成一个数字，本身就是另一种静默截断。

---

## 7. 获取形态

### D17 — 原生模态 + 直连公开 REST

`WorkshopPage` 内做**本项目自己的** Vue 模态，直连上游公开 REST。**不嵌 iframe、不跑上游 JS。**

```
GET /api/projects?page&pageSize&tag&search&sort   # approvedOnly，公开
GET /api/projects/{projectId}
GET /api/files/*                                   # 载荷 / 封面（worker 代理）
```

- **CORS 已核实开放**：`cloudflare/src/index.ts:61` 全路由 `Access-Control-Allow-Origin: *`，且 `/api/files/*` 明确注释「通过 worker 代理下载，解决 CORS 问题」。
- **无需认证**：`ProjectList.handle()` 调 `getCurrentUserFromRequest(c)` 仅用于填 `userLiked`/`userSubscribed`，未登录不抛 401。
- **并行来源**：本地 `project-{id}.json` 文件导入，离线可用，`planInstall` 落地后近乎免费。

**为何不嵌上游 web app 的 iframe**（备选方案，附录 B 有完整桥协议）：UI 归属（外来 iframe 会破坏 10 主题体系）、攻击面（无远程页面即无 sandbox/origin 校验/CSP 负担）、契约自主。若将来急需点赞/订阅/投稿对等功能，iframe 方案能一次性免费拿到（含 OAuth 全托管），届时附录 B 的协议与安全约束原样可用。

缓存 TTL 沿用上游量级：项目详情 5 分钟 · 载荷 15 小时 · diff 5 分钟。

---

## 8. 模块划分

照素材系统「纯函数出计划 / 执行器只落库」的分层：

```
src/sillytavern/
├── workshop-types.ts          纯类型 + 常量
├── workshop-manifest.ts       ★纯函数：上游 JSON → 内部形状；容忍字段增删
├── workshop-install-plan.ts   ★纯同步：planInstall(payload, registry) → InstallPlan
│                                uid 分配 / 条目转换 / 正则映射 / 冲突检测 / 丢弃项收集
│                                不碰 DB、不碰网络 —— 全部可单测
└── workshop-regex-map.ts      ★纯函数：ST 正则 → BeautifierRule（D16）

src/ui/
├── lib/workshop-client.ts     唯一网络接触点
├── stores/worldbook-store.ts  🆕 Phase 0：Dexie 世界书唯一入口（替代 settings.worldBooks）
├── stores/workshop-store.ts   执行器：拿 plan 落 DB，不含转换逻辑
└── components/workshop/       WorkshopPage.vue + 模态子组件
```

**`planInstall` 纯同步出计划**是关键接缝：安装的全部决策（发哪些 uid、条目怎么转、哪些丢弃、与已装项目冲不冲、哪些条目被用户改过）在无副作用纯函数里算完并可完整断言，store 只负责把计划写进 DB。素材系统已验证此分层。

**Phase 0 的消费端改造**：`settings.worldBooks` 的读者全部切到 `worldbook-store` —— `game-pipeline.loadActiveWorldBooks()`、`SettingsPage` 书列表、`create-store.loadWorldBookEntries()`、`setWorldBooks()` 调用点。`filterBooksByEnabledEntries` 及其下游不动，只是拿到的数组变长。

---

## 9. v1 中已被推翻的结论（勿重开）

| v1 结论                                          | 结局            | 原因                                                                  |
| ------------------------------------------------ | --------------- | --------------------------------------------------------------------- |
| `creative_workshop` 分区缺省拒绝（反转放行语义） | ❌ 撤销         | 与「一视同仁」冲突；真正的闸门是 Agent 可见性，且它已默认关闭         |
| 每存档存项目 id 而非 uid（新增 SaveSlot 字段）   | ❌ 撤销         | 缺省放行后更新友好性问题自行消失；不必为工坊单开一条启用路径          |
| `workshopBooks` 独立表                           | ❌ 撤销         | 世界书迁进 Dexie 后，工坊书就是普通行                                 |
| 合并只读视图 `getAllWorldBooks()`                | ❌ 不需要       | 单一数据源，无可合并                                                  |
| 工坊正则不导入（需 iframe 渲染器）               | ❌ 撤销         | 改为原样安装并默认启用（D16），已知后果已确认接受                     |
| 工坊内容排除出 FullBackup                        | ❌ 撤销         | 工坊书即 `worldBooks` 行，排除需按 partition 特判，与「一视同仁」冲突 |
| Phase 1 只建启用存储不建 UI                      | ❌ 撤销         | 「一视同仁」= 不做门禁                                                |
| 交换 Phase 1/2 顺序                              | ❌ 否决         | 明确保持现有顺序                                                      |
| 「不存在列表/搜索端点」                          | ⚠️ **事实错误** | 该断言来自只读压缩 bundle；端点在 worker 侧（附录 C）                 |

---

## 附录 A — 卡内缓存实测

`命定之诗与黄昏之歌v4.2.png` → `data.extensions.tavern_helper.scripts[4].data.creative_workshop_cache`

```
creative_workshop_cache
├── projectDetails  { <uuid>: { cachedAt, data: { project, worldbookEntriesPreview, regexEntriesPreview } } }
└── worldbookSources{ <uuid>: { cachedAt, downloadUrl, data: WorldbookEntry[] } }
```

| 项目                        | 版本  | 作者      | 条目 | 正则 | 体积      | 正文 EJS 占比 |
| --------------------------- | ----- | --------- | ---- | ---- | --------- | ------------- |
| 命定核心-言灵（重置）       | 2.1.0 | 夜见哉川  | 1    | 2    | 24 530 B  | 51.0%         |
| 命定核心-维拉 占卜/穿越时空 | 1.0.0 | redcrown  | 12   | 3    | 228 336 B | 12.1%         |
| 读者-先行稳定版             | 1.2.5 | Allomerus | 1    | 1    | 108 980 B | 72.8%         |

条目为标准 ST 形状（24+ 字段），**正文含 0 个 `<script>` 标签**；正则为标准 ST 形状（13 字段），**每条含 1 个 `<script>` + 1 个 `<style>`**。

## 附录 B — 上游插件架构（备选方案 iframe 桥用）

插件本身是 **iframe 宿主 + postMessage 桥**，业务逻辑（浏览/搜索/社交/OAuth）全在上游 web app 内。

桥协议 `src/CreativeWorkshop/bridge/protocol.ts`，namespace `creative-workshop-bridge`，消息形状 `{ namespace, type, requestId, payload }`：

- 请求 8 类：`handshake` · `get-context` · `list-installed-projects` · `install-project` · `uninstall-project` · `get-project-diff` · `confirm-project-update` · `oauth:start`
- 响应 9 类：`handshake:ok` · `context` · `installed-projects` · `install-result` · `uninstall-result` · `project-diff` · `update-result` · `oauth:result` · `error`

**`bridge:context` 的实际消费面**：插件发 5 个字段（`connected` / `characterName` / `worldbooks` / `regexEnabled` / `chatId`），而 web app 侧 `syncContextFromBridge()` **只读 `connected` 一个布尔**（全仓 grep 确认无第二处读取）。故若启用此方案，只需回 `{ connected: true }`，数据外泄面为零。

安全约束（若启用）：iframe `sandbox="allow-scripts allow-same-origin allow-popups allow-forms"`（`allow-same-origin` 必须给且安全——被嵌页与本应用跨源，该标志只恢复它对自己 origin 的访问）· 每条消息双校验 `event.origin` 与 `event.source`（上游用 `postMessage(msg, '*')` 通配 targetOrigin）· 只开放 7 项能力 · 远程只能提议不能执行，走同一条 `planInstall` 校验并弹确认 · origin 白名单 + CSP `frame-src`。

插件宿主 API 依赖（14 个）：`getScriptId` `getVariables` `updateVariablesWith` `getCharWorldbookNames` `getCurrentCharacterName` `isCharacterTavernRegexesEnabled` `SillyTavern.getCurrentChatId` `getWorldbook` `deleteWorldbookEntries` `getTavernRegexes` `updateTavernRegexesWith` `replaceScriptButtons` `eventOn` `getButtonEvent` + jQuery + lodash。

## 附录 C — 上游后端 REST API

`cloudflare/src/index.ts` 路由表 + `endpoints/projects.ts` zod schema。

| 认证   | 方法 | 路径                                                                                                                                 |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 公开   | GET  | `/api/projects`（分页/搜索/标签/排序）· `/api/projects/{id}` · `/api/files/*`                                                        |
| 需登录 | —    | `/api/auth/login·callback·poll·me·logout` · `/api/my/projects` · `POST·PUT·DELETE /api/projects*` · `like` · `subscribe` · `upload*` |
| 管理员 | —    | `/api/admin/*`                                                                                                                       |

`GET /api/projects` — Query：`page`(0) · `pageSize`(20) · `tag?` · `search?` · `sort`(`published`)。
Response：`{ success, total, page, pageSize, projects[] }`，每项 20 字段（`id` `name` `description` `version` `author*` `downloadUrl` `fileSize` `coverImage` `tags[]` `downloadsCount` `likesCount` `subscribesCount` `userLiked` `userSubscribed` `createdAt` `updatedAt`）。服务端固定 `approvedOnly: true`。
