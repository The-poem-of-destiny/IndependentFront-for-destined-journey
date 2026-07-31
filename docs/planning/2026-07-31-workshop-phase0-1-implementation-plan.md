# Phase 0 + Phase 1 实施计划

> 设计依据：[2026-07-31-creative-workshop-compat-design.md](./2026-07-31-creative-workshop-compat-design.md) v2（D1–D17）
> 分支：`creative-workshop-integration-v1` · 2026-07-31

**执行铁律**：Phase 0 必须整体跑绿并验证迁移后才开始 Phase 1。P0 动的是**唯一副本且当前无备份**的用户数据（设计 §1/D1），不容许与新功能混在一起排错。

---

## Phase 0 —— 世界书迁移 localStorage → Dexie

### P0-1 类型与 Schema

**文件**：`src/sillytavern/types.ts` · `src/sillytavern/database.ts`

- `types.ts`：`WorldBookPartition` 追加 `'creative_workshop'`（D6，P1 要用，此处一并加免得改两次 schema）；新增 `WorkshopProject`（D13）；`WorldBookEntry.extra?: { workshop?: {...} }`（D14）
- `database.ts`：
  - `version(14).stores({ ...重述 v13 全部 19 表, worldBooks: 'id, partition, updatedAt', workshopProjects: 'id, installedAt, updatedAt' })`
  - **不写** `lorebooks: null` / `settings: null`（D3 —— 死表原样保留）
  - `FullBackup` 加 `worldBooks` / `workshopProjects` 两字段 + `version` 递增（D5）
  - `exportAllData()` 读这两张表；`importAllData()` **必须容忍旧备份缺这两个字段**

**验收**：`npm run typecheck` 0 错误；`database.test.ts` 既有升版回归测试全绿；新增一条「v13 备份导入 v14 不炸」测试。

### P0-2 `worldbook-store`

**文件**：`src/ui/stores/worldbook-store.ts`（新建）+ `.test.ts`

Dexie 世界书的**唯一入口**。对外暴露与现状同形的响应式数组，内部读写 Dexie。

- 启动 hydrate：`db.worldBooks.toArray()` → `ref`
- CRUD：`upsertBook` / `deleteBook` / `upsertEntry` / `deleteEntry`，全部 `await` 落库后再更新 ref
- **绝不**把书写回 `settings.worldBooks`（否则 deep watch 会把它们塞回 localStorage）

**验收**：`fake-indexeddb` 下 CRUD 往返；断言 `settings` 对象在任何操作后都不含 `worldBooks` 内容。

### P0-3 迁移例程 ★最高风险

**文件**：`src/ui/stores/worldbook-store.ts`（或同目录 `worldbook-migration.ts`）+ 专项测试

严格按 D4 六步：

1. 判定：`settings.worldBooksMigratedAt` 未置位才跑（**不**以「表里有行」判定）
2. 单个 `db.transaction` 内 `bulkPut`
3. 回读校验：书数量 + 逐本条目数量与源数组完全一致
4. 校验通过 **才** 删 localStorage 副本、置标志位（顺序不可颠倒）
5. 任何一步失败：localStorage 原封不动、标志位不置、应用继续读旧路径
6. **启动顺序**：迁移 → 之后才跑 `loadBuiltInWorldBooks()` 内置合并（针对 Dexie）

**验收**（这几条是本阶段的核心资产）：
- 正常迁移：数据完整、localStorage 键消失、标志位置位
- 事务中途抛错：Dexie 无残留、localStorage 完好、标志位未置、**重跑成功**
- 校验失败（人为构造数量不符）：不删 localStorage、不置标志位
- 已迁移状态重复启动：幂等，不重复写
- 空 `worldBooks`（全新用户）：不炸
- 启动顺序：内置合并不会把书写回 localStorage

### P0-4 消费端切换

**文件**：`src/ui/lib/game-pipeline.ts:576` · `src/ui/components/settings/SettingsPage.vue` · `src/ui/stores/create-store.ts:364` · `setWorldBooks()` 调用点 · `src/ui/stores/settings-store.ts:186`

- 全部改读 `worldbook-store`
- `settings-store` 移除 `worldBooks` 默认值与启动合并逻辑（搬进 worldbook-store）
- `SettingsPage` 的导入/新建/删除/恢复默认/存为内置 改走 store
- **`filterBooksByEnabledEntries` 及下游一律不动**——只是拿到的数组变长

**验收**：`npm run test -- --run` 全绿；手动走查设置页世界书增删改 + 开局游戏页世界书注入正常。

---

## Phase 1 —— 创意工坊

### P1-1 纯函数层（可并行，无 DB/网络依赖）

| 文件 | 职责 | 关键点 |
| --- | --- | --- |
| `workshop-types.ts` | 类型 + 常量 | `WORKSHOP_PARTITION` |
| `workshop-manifest.ts` | 上游 JSON → 内部形状 | 容忍字段增删，未知字段忽略；只取 D13 的 12 个字段 |
| `workshop-regex-map.ts` | ST 正则 → `BeautifierRule` | ⚠️ `findRegex` **两种形态**（裸 pattern / `/p/flags`）都要吃；`substituteRegex` 是**枚举非布尔**；`promptOnly` 等丢弃项写进 `droppedNotes`；**不剥离 `<script>`/`<style>`**，`enabled` 按上游 |
| `workshop-install-plan.ts` | `planInstall()` 纯同步出计划 | uid 分配（D8）/ 条目转换 + `extra.workshop`（D14）/ 正则映射 / `sourceHash` 冲突检测（D15）/ 丢弃项收集 |

**验收**：每个模块配套 `*.test.ts`。`planInstall` 必测：跨项目 uid 不重叠、卸载后号段不回收、按名匹配的增删改、`sourceHash` 命中与不命中、`droppedNotes` 内容正确。

### P1-2 `workshop-client`

**文件**：`src/ui/lib/workshop-client.ts` + 测试（fetch mock）

唯一网络接触点。`listProjects(query)` / `fetchProject(id)` / `downloadPayload(url)`。TTL：详情 5 分钟 · 载荷 15 小时。网络失败 → `installState: 'broken'` 而非抛穿。

### P1-3 `workshop-store`

**文件**：`src/ui/stores/workshop-store.ts` + 测试

执行器：拿 `planInstall` 的计划落库，**不含转换逻辑**。安装 = 写 `workshopProjects` 行 + 写 `worldBooks` 行（`partition: 'creative_workshop'`）+ 追加 `BeautifierRule`。卸载 = 删这三处，**不回收 uid 号段**。更新 = 冲突非空时先弹警告再覆盖（D15）。

### P1-4 UI

**文件**：`src/ui/components/workshop/WorkshopPage.vue` + 子组件

- 浏览模态：卡片列表（封面/名称/作者/tags/版本/计数）+ 搜索 + 标签筛选 + 分页
- 详情模态：简介 + 条目数 + 正则数 + 安装/更新/卸载
- 已安装列表：版本对比、更新提示、`droppedNotes` 展开（「N 项内容未导入」）
- 本地文件导入入口（`project-{id}.json`）
- **严格遵循 `docs/design.md`**：token/组件库（AppCard/AppModal/AppTabs/AppButton）/10 主题 / `prefers-reduced-motion`

**不做**（Phase 3+）：登录、点赞、订阅、投稿。

### P1-5 启用轴接线

- 捏人页新增「启用的工坊项目」多选（项目级，展开写 `creative_workshop:<uid>`）——⚠️ 捏人页 7d 正在改造中，改动尽量收敛
- 建档后可改：每存档的工坊启用面板
- **不做**命定核心冲突拦截，只显著展示 tags（D12）

---

## 收尾

1. `npm run typecheck` + `npm run test -- --run` 全绿
2. 文档同步（AGENTS.md 提交前检查清单）：架构图补 `worldbook-store` / `workshop-*`；进度表加 Phase 0/1；`docs/CHANGELOG.md` 追加
3. `bash scripts/notify.sh` 阶段完成通知
4. 提交 + 推送

## 需要停下来问的情形

- 迁移测试出现任何数据不一致 —— **立刻停**，不要「修一下再说」
- 捏人页 7d 改造与 P1-5 冲突到需要动其结构
- `BeautifierRule` 承载 340 KB `replacement` 时出现实际渲染/性能问题
- 上游 API 返回形状与附录 C 的 schema 不符
