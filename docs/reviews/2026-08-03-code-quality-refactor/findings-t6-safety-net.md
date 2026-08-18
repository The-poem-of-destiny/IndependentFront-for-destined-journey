# T6 质量网的缺口：类型、测试与工具链没盖住最容易出错的地方

> 本文是《[代码质量与重构审查报告（2026-08-03）](README.md)》的一部分。返回 [索引与优先级总表](README.md) · [重构路线图](roadmap.md) · [健康面与覆盖缺口](health-and-gaps.md)

## 成因

约定（每模块配测试、`types.ts` 唯一来源）在最难测、最热的地方恰好破例：有状态的 composable、`Record<string, any>` 的设置面、`tests/` 与 `server/` 拿不到 tsc/eslint/prettier。缺口一旦存在就自我复制——下一个模块也可以是例外，而这些正是回归时无声、只能靠真机复现的区域。

## 本主题的发现

| ID            | 严重度 | 问题                                                                                                                                 |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [Q-15](#q-15) | 中     | tests/、server/、scripts/ 共 15 个源文件在 tsc/ESLint/Prettier 三张网之外，同时 59 个 tracked 临时脚本与 ~120MB 参考大文件躺在仓库里 |
| [Q-18](#q-18) | 中     | 全应用最热的状态零编译期保护：settings 是 Record<string, any>，per-Agent 设置摊成 13 张并行 Record 且默认值重述六次                  |
| [Q-20](#q-20) | 中     | 测试底盘的三处缺口：三个有状态 composable 零测试、7 份逐字相同的 localStorage 桩、两份源码级断言测试前提已过期                       |

<a id="q-15"></a>

### Q-15 tests/、server/、scripts/ 共 15 个源文件在 tsc/ESLint/Prettier 三张网之外，同时 59 个 tracked 临时脚本与 ~120MB 参考大文件躺在仓库里

- **严重度**：中
- **主题**：质量网的缺口：类型、测试与工具链没盖住最容易出错的地方
- **位置**：`tsconfig.json:24`、`package.json:11`、`package.json:16`、`package.json:19`、`.github/workflows/ci.yml:18`、`.github/workflows/ci.yml:19`、`.github/workflows/ci.yml:20`、`.github/workflows/ci.yml:21`、`.github/workflows/ci.yml:22`、`.gitignore:37`、`.gitignore:40`
- **工作量**：S　**风险**：低
- **来源**：XCUT-05, XCUT-08

**证据**

**三张网都只盖 src/。** `tsconfig.json:24` 是 `"include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"]`，`typecheck` 与 `typecheck:vue` 共用这一份，于是 `server/`（194 行，5 个路由）、`tests/`（7 个 .ts，含 `server-app.test.ts` 与 `tests/ui/components` 下 4 个组件测试）、`vite.config.ts`、`vitest.config.ts` 全部不在 program 里。`package.json:19` 的 `"lint": "eslint \"src/**/*.{ts,vue}\""` 与 :16 的 format glob 同理，`scripts/*.mjs|cjs`（约 1070 行）也在外。CI（`ci.yml:18-22`）忠实跑完这五步，所以这些文件在 CI 里是「跑得到、检不到」——`tests/` 的测试文件由 vitest 转译执行，但从未被类型检查过。

**仓库里的历史残留。** `git ls-files tmp | wc -l` = 59（3.9 MB），含 `tmp/_strip_emoji.mjs`、`tmp/m4-apply.cjs`、9 个 `agent-config.pre-*.bak` 等一次性会话产物。`.gitignore` 自己在注释里写了「历史 tracked 文件保留，新增文件不追踪」「历史 tracked 的用 `git rm --cached` 清理」——清理动作从没做。根目录还 tracked 着 `_msg_story.json`（6.5 KB 调试样本）与 `bash.exe.stackdump`（Cygwin crash dump），src/tests/docs 里零引用。体积头部是 `reference/…imported.jsonl` 82 MB、另一份 jsonl 20 MB、`reference/v4.2.1.png` 7 MB、`reference/游戏实例.bin` 3.7 MB，仅这四个就 113 MB，而 `reference/` 已被 eslint/prettier/tsconfig 全部排除，纯静态资料。另有孤儿 `src/components/SillyTavern/index.html`（唯一引用是 `docs/archive/planning/progress.md:16` 的一句历史记录），它是 src/ 下唯一不属于 `src/ui` 或 `src/sillytavern` 的东西，AGENTS.md 架构图里不存在；同一张架构图还写着 `src/vanilla/sillytavern-store.ts`，而 `src/vanilla/` 目录已经不存在。

> 复核修正：原始发现的两处计数偏高——`tests/` 下是 7 个 .ts 不是 13 个，`scripts/` 是约 1070 行不是 1470（`notify.sh` 是 shell）。另外「新 clone 要拉 120MB+，CI checkout 每次都付」这一条虽真，但 `git rm --cached` **不能**解决它：blob 仍在历史里，每次 clone 照付。只有 filter-repo 历史重写或 LFS + 重写才能回收带宽。本条的实得收益是导航噪音，不是带宽。

**影响**

`server/routes/proxy.ts` 是真在跑请求的代码，测试文件是质量的最后一道底线，两者都拿不到类型保护——测试里写错的 mock 形状不会红，只会在断言处变成看不懂的 `undefined`。任何人改 `server/` 或 `tests/` 都会被 `format:check` 放过、然后被 review 抓，属于纯浪费的人力检查。`tmp/` 里的 `.bak` 污染全仓 grep——找 agent `systemPrompt` 时会命中 9 份历史快照；`src/components/SillyTavern/` 让人以为 src 下还有第三套 UI；AGENTS.md 里指路的 `src/vanilla/` 根本打不开。这些直接抬高后续每一步的导航成本，所以本条应排在其它重构之前，做完才有编译期保护。

**重构建议**

两个独立 PR。

**PR 1（补网）：**

1. 新增 `tsconfig.tools.json`：`extends: "./tsconfig.json"`，`include: ["server/**/*.ts", "tests/**/*.ts", "*.config.ts"]`，`noEmit: true`。
2. `package.json` 加 `"typecheck:tools": "tsc -p tsconfig.tools.json --noEmit"`，并加进 `ci.yml` 的检查序列。
3. lint/format 的 glob 从 `"src/**/*"` 扩到 `"{src,server,tests,scripts}/**/*"` + `"*.config.{ts,js}"`，**先单独跑一次 `npm run format` 提一个纯格式化基线 commit**，再开启 `format:check`。
4. **不要删** `tsconfig.json:24` 里的 `"src/**/*.vue"`。裸 tsc 确实忽略它，但 `vue-tsc --noEmit` 读同一份 tsconfig，正是这一行让它枚举到全部 SFC；删掉会静默把 vue-tsc 的 program 缩到从 .ts 入口可达的部分。改为在该行上方加注释指明「.vue 的实际检查由 `typecheck:vue` 承担」。

**PR 2（清仓）：**

1. `git rm -r tmp _msg_story.json bash.exe.stackdump data/defaults/agent-config.json.bak src/components`——注意 `src/components` 是**有意删除**该 demo 页（代码零引用），不是 untrack 后留在工作区。`.gitignore` 已挡新增，只差这一刀。
2. `reference/` 下的 jsonl/png/bin 改走 Git LFS 或挪到独立 `-assets` 仓库，README 给下载指引；若必须留库内，至少把 82MB 那份换成 `scripts/scramble-worldbook-ejs.mjs` 已验证过的「结构留下、内容抹掉」产物。想真正回收 clone 带宽需要 filter-repo 历史重写，这一步单独决策。
3. AGENTS.md 架构图删掉 `src/vanilla/sillytavern-store.ts` 一行（该 Store 已被 Pinia 取代）。

<a id="q-18"></a>

### Q-18 全应用最热的状态零编译期保护：settings 是 Record<string, any>，per-Agent 设置摊成 13 张并行 Record 且默认值重述六次

- **严重度**：中
- **主题**：质量网的缺口：类型、测试与工具链没盖住最容易出错的地方
- **位置**：`src/ui/stores/settings-store.ts:102`、`src/ui/stores/settings-store.ts:110`、`src/ui/stores/settings-store.ts:239`、`src/ui/stores/settings-store.ts:398`、`src/ui/App.vue:70`、`src/ui/stores/beautifier-store.ts:118`、`src/ui/stores/workshop-store.ts:387`、`src/ui/lib/game-pipeline.ts:168`、`src/ui/lib/game-pipeline.ts:512`、`src/ui/composables/useHoverPopup.ts:119`、`src/ui/stores/create-store.ts:1118`、`src/ui/components/settings/SettingsPage.vue:841`、`src/ui/components/settings/SettingsPage.vue:966`、`src/ui/components/settings/SettingsPage.vue:991`
- **工作量**：M　**风险**：中
- **来源**：STORE-03, UI-05, UI-04

**证据**

两层缺口叠在同一个 store 上。

其一，整个设置面没有类型。`function getDefaults(): Record<string, any>`（settings-store.ts:102）、`const settings = ref<Record<string, any>>(merged)`（:239），模块头注释还把这件事当特性写：「`s.settings.任意新字段 = 值` 加新设置零改动」。默认值体（:103-190）其实逐行携带了真实形状（`activeAgent: null as string | null`、`snapshotRetentionMode: 'tiered' as 'tiered' | 'dense'`、`agentModels: {} as Record<string, string>` 等约 40 行），但没有一点信息活过返回类型。于是每个消费点自己重新声明：App.vue:70 `settings.settings.reducedMotion as boolean`；beautifier-store.ts:118 `(… .beautifierBuiltinDisabled as string[]) ?? []`；workshop-store.ts:387 与 :488 `settingsStore.settings.agentWorldbookIds as Record<string, string[]>`；game-pipeline.ts:168 `(this.settings.settings.snapshotRetentionMode ?? 'tiered') as 'tiered' | 'dense'`、:521 `(s.agentPrompts as Record<string, string>)[agentId] ?? ''`；create-store.ts:1120-1123；useHoverPopup.ts:119；settings-store 自己在 :377-409 连写十几次 `(settings.value.agentModels as Record<string, string>)`。另有九个组件走捷径 `const s = settings.settings`（ChatFlow.vue:39、GamePage.vue:31、ScenePanel.vue:17、SettingsPage.vue:26、DebugPanel.vue:50、useBeautify.ts:22 等）然后把 `v-model` 直接绑到 `s.<任意键>`。

其二，per-Agent 设置摊成 13 张并行 map。settings-store.ts:110-127 声明 13 个用同一个 agentId 作键的兄弟 map：`agentModels`、`agentWorldbookEnabled`、`agentWorldbookIds`、`agentPrompts`、`agentTemplates`、`agentDirty`、`agentTemperature`、`agentTopP`、`agentFreqPen`、`agentPresPen`、`agentMaxTokens`、`agentHistoryLayers`、`agentHistorySlice`。形状正确的记录类型 `AgentDefaultEntry` 就在同一文件（:47-62），却只用于磁盘上的项目默认值文件，从不用于活状态。于是每个操作都是一段 13 行的手抄：`saveAsDefault()`（SettingsPage.vue:846-862）把 13 个值读进一个对象字面量，`restoreAgentDefaults()` 写回两遍——一遍来自项目默认（:936-977）、一遍来自硬编码兜底（:983-999），两个分支只差取值来源。同一批字面默认值在四个文件的六处重述：SettingsPage.vue:853/857/966/970/991/995 的 `?? 0.7` / `?? 16384`，模板 :1437 与 :1509，settings-store.ts:398/410，game-pipeline.ts:512-513 `(s.agentTemperature as Record<string, number>)[agentId] ?? 0.7`，create-store.ts:1120-1122 的 `plot_outline`。

**影响**

拼错键名（`agentTopP` vs `agentTopp`）、写错值形状全部要到真机才暴露，而这些键正好控制模型选择、温度与 systemPrompt——症状是「设置页改了没反应」，debug loop 里最贵的一类。SettingsPage 模板 3823 行里任何一个 `v-model` 笔误都不是错误，而是一个被 deep watcher 永久持久化到 localStorage 的幽灵键。加第 14 个 per-Agent 旋钮要改七处，并记住 `agentHistoryLayers` / `agentHistorySlice` 用「键存在与否」编码「走引擎默认」这条只写在注释里的语义；漏改一张 map 会产出一个在 UI 上看着正常的半恢复 Agent。默认值是拷贝而非引用，改 `maxTokens` 要找六处字面量，漏掉 game-pipeline.ts:512 那处就是设置页显示新默认、运行时用旧值——这类偏差要到账单上才可见。当前六份拷贝的取值仍然一致（0.7 / 1.0 / 0 / 0 / 16384），所以这是潜在维护成本而非已发生的缺陷。另外它让 `as any` 沿 Agent 装配链一路传染，是 Agent 装配分层重构的前置。

**重构建议**

先合并 13 张 map，再给整袋子建类型（顺序反了会让 13 个 map 变成接口里的 13 个成员）：

1. 把已存在的 `AgentDefaultEntry` 提升为活状态形状：在 `getDefaults()` 里改成 `agents: Record<string, AgentSettingsEntry>`；新增 `export const AGENT_SETTINGS_DEFAULTS = { temperature: 0.7, topP: 1, freqPen: 0, presPen: 0, maxTokens: 16384, … }` 作为这些数字**唯一**出现的地方。硬约束：`agentHistoryLayers` / `agentHistorySlice` 必须保持 `?: number | undefined`，且 `getAgentSettings()` **不得**给它们合并默认值——合并会静默覆盖引擎按 Agent 分类给的默认。
2. store 上加三个函数：`getAgentSettings(id): AgentSettingsEntry`（合默认，调用方从此不写 `?? 0.7`）、`patchAgentSettings(id, patch: Partial<AgentSettingsEntry>)`、`resetAgentSettings(id, from?: AgentDefaultEntry)`——后者吸收 `restoreAgentDefaults` 的两个分支，两分支合成一条代码路径加一个来源对象。
3. `saveAsDefault` 改写成 `{ ...getAgentSettings(id) }`（:846-862 的对象字面量消失），game-pipeline.ts:512 与 create-store.ts:1120 改指 `getAgentSettings()`。
4. 在 settings-store 写一次性迁移：首次加载时把已有的 13 张 localStorage map 折进 `agents`；配 `settings-store.agents.test.ts` 断言往返与默认合并（AGENTS.md「必须写测试」）。
5. 随后新建 `src/ui/stores/settings-types.ts`，声明 `export interface UiSettings { … }`，把 `getDefaults()` 里 `as` 注解已经写明的类型逐键落成接口；签名改为 `getDefaults(): UiSettings` 与 `ref<UiSettings>(…)`，上面列出的约 30 处 `as Record<string, …>` 断言自行删除，编译器会指出写错的那些。这个类型放在 `src/ui/stores/` 下，**不要**加进引擎的 `src/sillytavern/types.ts`——那条「唯一类型来源」规则的作用域是引擎类型。
6. 开放扩展要显式隔离：保留一个声明出来的 `extra: Record<string, unknown>` 字段，而不是让整个对象 any。注意 settings 启动时会与未知的老键 merge、三个 migration 模块又以 `settings[FLAG]` 读迁移标志位，所以接口必须留开口（索引签名或 `extra`），否则这些读法会失去类型。这一步反转的是 store 头注释里明确写下的设计意图，应作为决策先取得同意，而不是当清理顺手做掉。

<a id="q-20"></a>

### Q-20 测试底盘的三处缺口：三个有状态 composable 零测试、7 份逐字相同的 localStorage 桩、两份源码级断言测试前提已过期

- **严重度**：中
- **主题**：质量网的缺口：类型、测试与工具链没盖住最容易出错的地方
- **位置**：`src/ui/composables/useMapMarkers.ts:1`、`src/ui/composables/useMapViewer.ts:1`、`src/ui/composables/useHoverPopup.ts:73`、`src/ui/lib/toSystemEvent.ts:1`、`src/ui/components/game/MapPanel.vue:309`、`src/ui/stores/worldbook-store.test.ts:31`、`src/ui/stores/beautifier-store.test.ts:31`、`src/ui/stores/workshop-store.test.ts:658`、`src/ui/stores/workshop-social-store.test.ts`、`src/ui/stores/settings-store.test.ts:68`、`src/ui/stores/settings-store.ts:74`、`src/ui/components/settings/SettingsPage.engine-imports.test.ts:8`、`src/ui/components/settings/SettingsPage.apikey.test.ts:57`、`.github/workflows/ci.yml:19`
- **工作量**：M　**风险**：低
- **来源**：STORE-10, UI-08, XCUT-09, XCUT-06, XCUT-10

**证据**

三处彼此独立、但都落在「测试底盘」上的缺口。

**（一）三个有状态 composable 零测试。** `src/ui/composables/` 下 5 个模块，`useAssetImage.ts`（304 行）有 614 行测试、`useBeautify.ts`（77 行）有 113 行测试，而 `useMapMarkers.ts`（355 行）、`useMapViewer.ts`（228 行）、`useHoverPopup.ts`（147 行）合计 730 行**没有任何 sibling 测试**，全仓 grep `useMapMarkers`/`useHoverPopup` 在 `*.test.ts` 下命中数为 0。这三个都不是琐碎逻辑：`useHoverPopup.ts:73` 的 `place(el, value)` 做锚点矩形测量 + 视口 clamp，覆盖三种放置模式（`'below' | 'right' | 'right-bottom'`，:81-114），带 `zoom` 系数与 `estHeight` 预估，是纯矩形算术、最适合单测，而且 AGENTS.md 称它是「悬停浮层唯一实现」，被 StatusOverview(:296) 与 ScenePanel 消费；`useMapMarkers.ts` 是 355 行标记 CRUD + OpenSeadragon overlay 命令式同步，`syncOverlays`(:280-324) 用手工 `overlayMap` 维护生命周期，还驱动 `MapPanel.vue:174` 那条持久化 debounce。同域的 `src/ui/lib/toSystemEvent.ts`（127 行纯函数，被 test-fixtures 与 game-store 消费）也零测试。对照之下 stores/lib 的覆盖是扎实的（asset-store 2161 行、workshop-client 1418 行、game-pipeline 978 行测试）。注：`crop-rects.ts` 虽无同名测试，但确由 `AssetCropEditor.test.ts:38` 覆盖，不计入本条。

**（二）7 份逐字相同的 localStorage 桩，且硬编码生产常量。** 7 个 store 测试各带同一段 12 行桩，`worldbook-store.test.ts:31-42` 与 `beautifier-store.test.ts:31-42` 连变量名 `lsBacking` 都一样：

```ts
const lsBacking = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsBacking.get(k) ?? null,
  setItem: (k: string, v: string) => void lsBacking.set(k, v),
  // ...
  get length() {
    return lsBacking.size;
  },
  key: (i: number) => [...lsBacking.keys()][i] ?? null,
});
```

5 个文件里写着 `const STORAGE_KEY = 'fated-poem-settings';`，`settings-store.test.ts` 更是直接内联字面量四次（:68/:91/:110/:135），生产端真源在 `settings-store.ts:74`。仓库里没有 `tests/ui/helpers`、没有 `src/ui/stores/__testing__`，唯一共享层 `src/test-setup.ts` 只有一行 `import 'fake-indexeddb/auto'`。DB 侧同理：`clearAllData()` 在 `char-query.integration.test.ts:16`、`database.test.ts:271/839/1201`、`audio-singleton.test.ts:154` 各自手动调，没有统一的 `beforeEach` 复位钩子。

**（三）两份源码级断言测试。** `SettingsPage.engine-imports.test.ts:10-11` 的存在理由写着「`npm run typecheck` 是裸 `tsc`，不解析 `.vue`（**项目没装 vue-tsc**）」——但 `package.json:12` 有 `"typecheck:vue": "vue-tsc --noEmit"`，`ci.yml:19` 也在跑它。同文件 `:104` 的 `expect(body.slice(0, 200)).toContain('db.delete()')` 与 `:96` 的 `expect(codeLines).not.toMatch(/\bdeleteDatabase\s*\(/)` 断的是 `database.ts` 的源码字面：`clearAllData` 内部换成 `Dexie.delete(name)`、或加一行前置日志把 `db.delete()` 挤出前 200 字符，测试就红，而行为没变。`SettingsPage.apikey.test.ts:57` 的 `expect(source).toMatch(/_realKey\s*\|\|\s*apiForm\.apiKey/)` 同类，把一个具体表达式的写法当契约。对照 `combat-v3/no-nondeterminism.test.ts` 的源码扫描（禁 `Math.random`）是合理用法——那条断言的对象本身就是「源码里不许出现某个符号」。

> 复核修正：（一）关于桩的失效模式，「生产端改了 key、测试仍全绿」只对 `settings-store.test.ts` 那四处内联字面量成立；worldbook/beautifier 两份是透过自己装的桩读的，生产端改 key 会让它们红而不是绿。（二）`SettingsPage.engine-imports.test.ts` 里三条断言只有第一条（解构名存在性）被 vue-tsc 取代，第三条（`clearAllData` 必须整库 `db.delete()` 而非逐表 clear）守的是「存档数据」分区文案里那句用户可见承诺「清除会连带删掉音频与素材库」，套件里没有第二处在守——整份删掉会丢掉这条守护。

**影响**

`place()` 与 `syncOverlays` 正是「只会以『地图标记偶尔不见了』『弹层在某个屏宽下半截出屏』报上来」的那类代码：clamp 的一个 off-by-one 没有 reviewer 会看出来、typecheck 也不会报，overlay 生命周期泄漏会在快速切图源（`MapPanel.vue:311`）时累积 DOM 节点，而它们都是唯一实现、没有回归网。桩的重复是纯卫生问题（没有覆盖缺口），但一旦要让桩跟上浏览器行为（加配额异常、加 `storage` 事件）就得改 7 处，漏一处就出现「A 测试通过 B 测试不通过」的假差异。两份源码断言测试的红灯与正确性无关、只与格式化和重命名相关，会训练维护者「测试红了先看是不是那两个源码测试」，长期削弱整套测试的可信度。

**重构建议**

按依赖顺序推进：先做共享夹具，再补 composable 测试（`useHoverPopup` 需要 Pinia，正好吃到夹具），源码断言那条独立可做。

1. **`src/ui/stores/__testing__/store-harness.ts`**：导出 `installMemoryLocalStorage(): { backing: Map<string, string>; restore(): void }`、`freshPinia()`（`setActivePinia(createPinia())` + 表清空）、`resetAppDatabase()`（统一 `clearAllData()` + 重开库）。`settings-store.ts:74` 改成 `export const SETTINGS_STORAGE_KEY`，测试 import 它而不是抄。7 个 store 测试与 5 个 DB 测试的 `beforeEach` 收敛成两三行调用。
2. **`useHoverPopup.test.ts`**（最便宜、价值最高，无需 mount）：`useHoverPopup({ width, estHeight, placement })`，给 `onEnter` 喂一个 `currentTarget` 有固定 `getBoundingClientRect` 的合成 `MouseEvent`，桩掉 `window.innerWidth/innerHeight`，断言三种 placement 的 `x`/`y` 与四角 clamp、`hoverDelayMs = 0` 路径、以及 fake timers 下的「快速进出取消」。**别漏两处**：`place()` 读可选的 `anchorSelector`(:75-77)、查不到时回落到 trigger rect；`right-bottom` 分支是靠 `style` computed(:110-117) 的 `translateY(-100%)` 把弹层**下边缘**对齐锚点——只断 x/y 会漏掉 clamp 反转。它读 `settings.settings.hoverDelayMs`(:119)，所以即便不 mount 组件也需要活的 Pinia（用第 1 步的 `freshPinia()`）。
3. **`toSystemEvent.test.ts`**：纯函数，七种 SystemEvent 各一条断言，单独一个 PR 就完事，不要和 OSD 的活捆在一起。
4. **`useMapMarkers.test.ts`**：给 `viewerRef` 喂一个记账用的最小假 viewer（`addOverlay`/`removeOverlay`/`updateOverlay`/`viewport.imageToViewportCoordinates` 三四个 spy，放 `src/ui/composables/__testing__/osd-fakes.ts`，对齐 `audio-singleton` 用 `audio-fakes.ts` 的先例）。断言点定在行为：setMarkers→syncOverlays 后 overlayMap 与 DOM 数量一致、删标记后 `removeOverlay` 被调且 map 清干净、重复 sync 不重复建节点、切换地图源后旧 overlay 全部被移除（泄漏守卫）、debounce 把一串标记 mutation 合成一次持久化。
5. **`useMapViewer.test.ts`** 保持最小：把 `OpenSeadragon(...)` 的构造抽成可注入的 `createViewer` 参数，断 unmount 调 `destroy()`、`destroy()` 后再触发事件不抛。注意这是**为可测性改生产签名**，评审时按生产变更看待，不是纯测试 PR。
6. **源码断言**：删 `SettingsPage.engine-imports.test.ts` 的第一条断言（解构名存在性，已由 vue-tsc 取代）与第二条（`deleteDatabase` 不得复现，同样冗余），**保留第三条并就地修脆**——把 `expect(body.slice(0, 200))` 改成对「截到函数末尾的 body」`expect(body).toContain('db.delete()')`，前置日志之类的改动就不会误伤。在 `ci.yml` 的 `typecheck:vue` 那一步加一行注释说明它替代了哪条守护。`SettingsPage.apikey.test.ts:57` 的源码正则换成行为断言：直调那条保存路径，输入「表单里是掩码占位符」，断言落库的是 `_realKey` 而非掩码——断结果不断写法。若确实要保留源码级守卫，可统一挪到 `src/guards/*.guard.test.ts` 并在文件头注明「本目录断源码字面，重构时优先改这里」，但这是 AGENTS.md 里尚不存在的新目录约定，需同时写进 AGENTS.md。
