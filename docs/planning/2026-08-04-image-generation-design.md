# 图像生成系统设计 v1.0 —— NovelAI 情景插画

> 状态：**设计定稿**，未实施。
> 日期：2026-08-04
> 范围：**NovelAI 单家 provider + 情景插画单一用途**。四家 provider 对比、分级路由、角色画像路径见 **附录 A**（已核准，v2 直接取用）。
> ADR 关联：ADR-21（StateManager 唯一写入口）· ADR-28（模仿结果、不照抄中间结构）· Q-05（加标记只动 `MARKER_SPECS`）· Q-18（设置项要改两处）

---

## 0. 范围与验收

### 0.1 核心流程

```
三档开关（关 / 手动 / 自动）
  → story agent 在正文里输出 <scene_image>（标题 + 一句话说明 + 角色名 + danbooru 场景串）
  → 【自动】过限额后就地发请求   【手动】标记处出现按钮，玩家点了才发
  → 装配提示词（角色预设逐个进各自槽位）→ 经 BFF 调 NAI → 解 zip
  → 图**就地插在标记所在的位置**
  → 落进该存档专属的存储（用户花了钱，必须留住）
  → 全部插画在 **CG 图鉴**里按剧情顺序回看
```

一句话：**标记是锚点，图长在锚点上；图鉴是同一批记录的第二个视图。**

### 0.2 验收标准（v1 做完 = 这九条全成立）

1. story agent 输出的 `<scene_image>` **在任何开关档位下都不会以尖括号形式漏给玩家**（含美化关闭、流式输出中）
2. 自动档：新回合的标记就地生成，图出现在标记原来的位置
3. 手动档：标记处是按钮，点击后生成，位置同上
4. 自动档**不会对历史消息追溯开火**（把开关从手动拨到自动，一分钱不花）
5. 刷新页面后：生成中的仍显示生成中，失败的仍显示失败原因，成功的仍显示图
6. 回退一回合再重发：旧图不丢（图鉴里仍在），且**同一回合不会自动生成第二张**
7. 三层限额任一触发时，标记**降级成手动按钮**而不是消失；手动点击永远可用
8. CG 图鉴按剧情顺序列出全部插画，带 AI 写的标题与说明，可跳回原消息
9. `npm run typecheck` 与 `npm test` 全绿，新模块各自带 `*.test.ts`

### 0.3 非目标（v1 明确不做）

img2img / 局部重绘 / 放大 · 候选多选 · 角色画像入槽位（`writeIntoSlot`）· 素材库 `插画` 类型 · 分级路由 · 另外三家 provider · NAI 角色坐标（5×5 网格）· 缩略图烘焙 · 自动淘汰策略

---

## 1. 三个把 v1 变便宜的既有事实

均已查证，是本设计成立的前提。

| #   | 事实                                                                                                                    | 出处                                                | 省掉了什么                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| 1   | **正文渲染路径刻意保留标记**，只有 `<play_audio>` 被单独剥                                                              | `marker-protocol.ts:349` 注释原文                   | 标记可以直接当锚点，**不需要改写 AI 写过的正文** |
| 2   | **正文已经是分段渲染的**（`compileBeautifierSegments` → 文本段/命中段），`CARD_PATTERN` 已在做"认内置标签 → 变成一个段" | `beautifier.ts:276-313` · `BeautifiedNarrative.vue` | 「把图插在标记处」不是新机制，是加第三种段       |
| 3   | **加标记只动 `MARKER_SPECS`** —— 扫描器、`MARKER_TAGS`、`scanMarkers` 全由那张表推导                                    | `marker-protocol.ts:20`（Q-05）                     | agent 侧接线 = 一张表加一行                      |

另外三处现成件：`fflate`（解 NAI 的 zip）· `forward()` 二进制管道直通（BFF）· `asset-url.ts` 的 object URL LRU + 引用计数。

---

## 2. 决策表

| #       | 决策                                 | 裁定                                                                         | 理由                                                                                                                                                             |
| ------- | ------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | 提示词写在标记属性还是正文           | **正文（`bodyText`）**                                                       | danbooru 串必有逗号、括号、`{{}}`，可能有引号。塞进属性值，一个 `"` 就截断标签解析 → 生成失败                                                                    |
| **D2**  | 图怎么定位到正文位置                 | **标记留在 `msg.content` 不动，图按 `(saveId, messageId, occurrence)` 反查** | 永不改写 AI 写过的字节。且快照回滚带回同样的 messageId 与正文 → 图**自动重新挂上**，零回收代码                                                                   |
| **D3**  | 分段在美化之前还是之后               | **之前，且不受美化开关约束**                                                 | 插画是应用自有渲染，不是"美化"。美化关掉 / 流式输出中，`BeautifiedNarrative` 退回单个裸文本段 —— 那时标记会漏成尖括号                                            |
| **D4**  | 角色外观谁写                         | **标记只报角色名，Code 拼预设**                                              | story agent 不知道苏婉的 booru 标签，让它每回合自己编 = 每张图里的人都不一样                                                                                     |
| **D5**  | 生成中/失败的记录                    | **pending 记录先落库，再发请求**                                             | 否则刷新之后"这里本来有张图"凭空消失                                                                                                                             |
| **D6**  | 保留策略                             | **v1 不做任何自动淘汰**                                                      | 用户为每一张付过钱。只给手动清理 + 用量读数                                                                                                                      |
| **D7**  | 孤儿（消息没回来的图）               | **保留，不删**                                                               | 同 D6。只有删除存档才连带删                                                                                                                                      |
| **D8**  | FullBackup                           | **元数据进，字节不进**                                                       | 字节进 JSON 备份会爆炸；元数据含 prompt + seed + model，**NAI 同参数可复现** —— 备份存的是配方。加上标题说明，恢复出来的图鉴是**一份读得通的目录**               |
| **D9**  | 候选张数                             | **恒 `n_samples: 1`**                                                        | 用户按张付费；且**恰好卡在 Opus 免费档内**（常规尺寸 + 单张）                                                                                                    |
| **D10** | 分级路由                             | **v1 不建**（NAI 是 explicit-ok，无需选路）                                  | 但分层保留，见 D11                                                                                                                                               |
| **D11** | 只有一家 provider 还分不分层         | **分**：方言/装配层与适配器层照留                                            | 省掉能少写约 60 行；但 v2 接 OpenAI/Gemini 时，"提示词装配"与"HTTP 形状"糊在一起就要整个重写。且**分层正是 NAI 三重冗余能被一处保证的原因**（§6.1）              |
| **D12** | 素材库 `插画` 类型                   | **v1 不加**                                                                  | 加类型 token 要付 D16 命名不变式的迁移代价，而 v1 插画进存档专属表、不进素材库。**这条推翻了本文档 2026-08-04 早先的裁定**——当时的前提（插画要入素材库）已不成立 |
| **D13** | 角色画像（`writeIntoSlot`）          | **v1 不做**                                                                  | 主人裁定先做情景。`writeIntoSlot` 现成，v2 接它是纯增补                                                                                                          |
| **D14** | 开关形状                             | **三档单选** `'off' \| 'manual' \| 'auto'`                                   | 两个 boolean 能表达"关掉但自动"这种无意义组合，且每个消费点要重推优先级。先例：`audioSceneAutoPlay`                                                              |
| **D15** | 🔴 自动档**绝不追溯触发**            | 只对**本回合新到的消息**自动发请求                                           | 否则把开关拨到自动的那一刻，整本聊天记录里所有未生成的标记一起开火 —— 几百回合的存档能瞬间烧掉几十美元                                                           |
| **D16** | 手动档要不要先建记录                 | **不建，点击才建**                                                           | 否则每个从没被点过的标记都在表里留一行 `idle`。标记本身已带渲染按钮所需的全部信息                                                                                |
| **D17** | 重画的处置                           | **追加一条新记录**（同 `(messageId, occurrence)`，`take` 递增），不覆盖      | 用户对两张都付过钱。正文显示最新 + `2/3` 切换，图鉴显示全部                                                                                                      |
| **D18** | 标题与说明谁写                       | **story agent 在标记属性里写**                                               | 它正在写这段剧情，知道图画的是什么，且写的是中文叙事口吻。Code 无从从 danbooru 标签反推出「篝火旁的低语」                                                        |
| **D19** | 标题放属性、提示词放正文             | **刻意不一致**                                                               | 提示词被引号搞坏 = 生成失败（结构性）；标题被搞坏 = 图鉴里一行难看（装饰性）。容错等级不同，处置就该不同                                                         |
| **D20** | 频率控制放 prompt 还是 Code          | **两处都要，Code 是失效保护**                                                | prompt 里的克制指令是"一般情况下的期望"，模型漂移/越狱/上下文污染都能让它失效，而失效代价是真金白银。凡是"错了会花钱"的约束，都不能只由被约束者自己遵守          |
| **D21** | 🔴 限流时标记怎么处置                | **绝不丢弃。超预算 = 降级成手动按钮**                                        | 这是让 Code 限流变安全的那一条。丢标记 = 玩家眼里"有时候有图有时候没有"；降级 = 玩家看到按钮、知道有这张图、想要就自己点                                         |
| **D22** | 分层限额                             | 每条消息上限 · 滚动时间窗 · 同回合去重                                       | 三条各挡一种失效模式，不是同一条的三个刻度                                                                                                                       |
| **D23** | 🔴 同回合已自动生成过 → 不再自动生成 | 按 `(saveId, turn, source:'auto')` 去重                                      | **回退重发是既有功能且玩家用得很勤**。不设这条，对同一段剧情重掷 5 次就产生 5 张图，4 张挂在被丢弃的消息上                                                       |
| **D24** | 超限时自动与手动的差别               | **自动硬停（降级成按钮），手动只弹一次确认**                                 | 机器该被拦死，人该只被减速。玩家点按钮是在场的、刻意的支出                                                                                                       |
| **D25** | 失败重试                             | **永不自动重试**，只有手动重试按钮                                           | 自动重试 + 上游 5xx = 最经典的账单事故。且失败原因多半是提示词或额度，重试一百次也不会变对                                                                       |
| **D26** | 用户改过的提示词 vs 重画             | **编辑版优先**（`editedScenePrompt`），原文不覆盖                            | 改完提示词点重画、结果却按 AI 原话生成，是这类界面最挫败的一种失败。原文留着，"改回去"才永远可行                                                                 |
| **D27** | 标记正文进装配前**必须过标点归一化** | `normalizeTagString`（§3.2b）                                                | story agent 写中文叙事却要吐 danbooru 串，全角 `，` 与 `《》` 必然渗进来 —— 前者让整串变成一个巨型标签，后者毁掉 `<lora:>` 语法，**两者都不报错，只是静默画错**  |

---

## 3. 标记协议

```xml
<scene_image title="篝火旁的低语" desc="苏婉第一次说起她的家乡" characters="苏婉" rating="general">
tavern interior, warm candlelight, wooden table, sitting, holding a mug, looking at viewer
</scene_image>
```

| 部分         | 必填   | 说明                                                                                          |
| ------------ | ------ | --------------------------------------------------------------------------------------------- |
| `title`      | 否     | 中文短标题，图鉴条目名。缺省 → Code 填「第 N 回合的插画」                                     |
| `desc`       | 否     | 一句话说明，图鉴副标题。缺省 → 空串                                                           |
| `characters` | 否     | 逗号分隔角色名。**原样 `===` 匹配，不归一化**（铁律 1 / 素材系统 D2）。缺省 = 纯风景          |
| `rating`     | 否     | `general` / `sensitive` / `questionable` / `explicit`。缺省 → 设置里的默认档                  |
| 正文         | **是** | **场景/动作/光线/构图**的 danbooru 标签，含数量标签（`2girls, 1boy`）。**不写角色外观**（D4） |

### 3.1 `MARKER_SPECS` 增量

```ts
scene_image: {
  fields: (attrs) => ({
    title: sanitizeCaption(attrs['title'], CAPTION_TITLE_MAX),
    desc: sanitizeCaption(attrs['desc'], CAPTION_DESC_MAX),
    characters: splitCharacterList(attrs['characters']),
    rating: normalizeRating(attrs['rating']),
  }),
  emptyBody: '',   // Phase 10 那批的口径：必填 string，缺省空串
},
```

### 3.2 `sanitizeCaption` 规格（纯函数）

```
输入 string | undefined → 输出 string
① undefined/null → ''
② trim
③ 去掉裸的 " 与 '（属性解析残留），保留中文引号「」『』和全角引号
④ 折叠内部连续空白为单个空格
⑤ 截断到 max 字（按码位，不是字节），截断时不加省略号
```

`CAPTION_TITLE_MAX = 30`、`CAPTION_DESC_MAX = 60`。

🔴 **绝不因为标题畸形就拒绝整个标记** —— 那会把一次装饰性失误升级成一张画不出来的图。

### 3.2b `normalizeTagString` 规格（纯函数）—— 🔴 别漏

标记正文要在进装配前过一遍**标点归一化**。这不是洁癖，是本子系统最隐蔽的一类失败：

> story agent 写的是**中文叙事**，却被要求在同一段输出里吐 danbooru 标签串。中文输入状态下，模型极易把 **全角逗号 `，`** 和 **全角书名号 `《》`** 带进标签串。而：
>
> - `，` 不是合法分隔符 → 整串被当成**一个巨型标签**，画出来的东西面目全非
> - `《》` 会毁掉 `<lora:name:0.8>` / `<wlr:…>` 这类尖括号语法
>
> 两种情况**都不会报错**，只会静默产出一张莫名其妙的图 —— 最难查的那一类。

```
输入 string → 输出 string
① 换行与 <br> → ", "        （AI 常按行分组标签）
② 《 》 → < >               （恢复尖括号语法）
③ ，→ ,   、→ ,   ；→ ,     （全角/顿号/全角分号 → ASCII 逗号）
④ 折叠 `\s*,\s*` → ", "
⑤ 折叠连续空白 → 单空格；折叠连续逗号 → 单逗号；去首尾逗号与空白
```

🔴 **归一化只动标点，不动内容** —— 权重语法（`{{}}` / `[[]]` / `-0.8::feet::` / `<lora:…>`）在第 ② 步之后**原样透传**，一个字符都不许改。

同一个函数也用于**角色预设的正/负向**（用户手打时同样会带全角标点）。

**测试要盖到的**：`1girl，silver hair` → `1girl, silver hair` · `《lora:x:0.8》` → `<lora:x:0.8>` · `a,,b` → `a, b` · `{{masterpiece}}` 不变 · `-0.8::feet::` 不变。

### 3.3 为什么标题在属性、提示词在正文（D19）

- **提示词进正文**：danbooru 串里必有逗号、括号、`{{}}`，可能有引号 → 塞进属性值一个 `"` 就截断解析 → **生成失败**（结构性）
- **标题/说明进属性**：中文叙事短句，出现英文直引号概率低；`parseTagAttributes` 双单引号都认。真搞坏也只是**图鉴里一行难看**（装饰性）

### 3.4 漏写闭合标签的兜底

AI 漏写闭合标签是常事。`scanPlayAudioMarkers` 已有先例（认自闭合 / 成对 / 只有开标签三种）。`scene_image` **有必须的正文**，所以：

- ✅ 成对写法：通用骨架
- ✅ 只有开标签、没写闭合：**吃到下一个块级标记或正文末尾**，当作正文
- ❌ 自闭合 `<scene_image ... />`：没有正文 = 没有提示词 → **当作无效标记剥掉**（渲染成空），不建记录

---

## 4. 类型定义（`src/sillytavern/types-image.ts`）

先例：`types-audio.ts`（大型联合拆分文件；数据模型类型仍可留 `types.ts`，本子系统全部集中在此）。

```ts
// ═══ 开关与分级 ═══

/** 三档开关（D14） */
export type ImageGenMode = 'off' | 'manual' | 'auto';

/** 内容分级。v1 只映射成 NAI 提示词里的 `rating:*` tag（§6.2） */
export type ImageRating = 'general' | 'sensitive' | 'questionable' | 'explicit';

// ═══ 标记 ═══

/** `<scene_image>` 的扫描产物。加入 `DetectedMarker` 联合 */
export interface SceneImageMarker {
  type: 'scene_image';
  rawContent: string;
  position: number;
  /** danbooru 场景串（必填，空串 = 无效标记） */
  bodyText: string;
  /** 已过 sanitizeCaption；可能是空串 */
  title: string;
  desc: string;
  /** 原样，未归一化（D2 / 铁律 1） */
  characters: string[];
  /** 缺省时为 undefined，由设置里的默认档兜底 */
  rating?: ImageRating;
}

// ═══ 渲染分段 ═══

export type NarrativeSegment =
  { kind: 'text'; text: string } | { kind: 'image'; occurrence: number; marker: SceneImageMarker };

// ═══ 角色预设 ═══

/** Dexie v17 `imagePresets`，全局按角色名键控，进 FullBackup（纯文本、很小） */
export interface CharacterImagePreset {
  /** 🔴 主键。原始字符串，`===` 匹配，不 trim / 不折叠大小写 / 不 NFKC */
  name: string;
  dialects: {
    /** v1 唯一在用 */
    danbooru?: { positive: string; negative: string };
    /** v2 的 OpenAI/Gemini 用。形状先留好（D11） */
    prose?: { positive: string; negative: string };
  };
  /** 角色一致性的穷人版；缺省 = 每次随机 */
  pinnedSeed?: number;
  createdAt: number;
  updatedAt: number;
}

// ═══ 提示词装配的中间产物 ═══

/**
 * `image-prompt` 的输出、`novelai` 的输入。
 *
 * 🔴 **刻意不是一个字符串**：NAI V4 要把同样的内容展开到三处（§6.1），
 * 而角色是分槽位的。中间结构是三重冗余能被一处保证的前提。
 */
export interface ComposedPrompt {
  /** 场景 + 构图 + rating tag + 画质后缀（后缀在**末尾**） */
  base: string;
  /** 全局负向（我们自己维护的文本 ∪ 设置里的追加） */
  baseNegative: string;
  /** 逐角色，**顺序 = 标记里 characters 的顺序**（V4 的 use_order 依赖它）。最多 6 个 */
  characters: ComposedCharacter[];
  /** 装配过程中的可播报问题，不阻断生成 */
  warnings: ComposeWarning[];
  /** 若任一角色预设带 pinnedSeed 则取第一个；否则 undefined = 随机 */
  seed?: number;
}

export interface ComposedCharacter {
  name: string;
  /** 该角色预设的 positive */
  positive: string;
  /** 该角色预设的 negative → 进 `characterPrompts[].uc`（官方的抗串味手段，§6.2） */
  negative: string;
}

export type ComposeWarning =
  { kind: 'missing-preset'; name: string } | { kind: 'characters-truncated'; dropped: string[] };

// ═══ 限额 ═══

export type QuotaReason = 'per-message' | 'rolling-window' | 'same-turn';

export type QuotaVerdict = { ok: true } | { ok: false; reason: QuotaReason; message: string };

// ═══ 落库记录 ═══

export type SceneImageStatus = 'pending' | 'done' | 'failed';

export interface SceneImageRecord {
  id: string;
  saveId: string;
  messageId: string;
  /** 该消息里第几个 <scene_image>，与渲染段编号对齐（D2） */
  occurrence: number;
  /** 同一处的第几次重画，从 0 起（D17）。正文显示最大者，图鉴显示全部 */
  take: number;
  /** 剧情顺序 —— 图鉴默认排序键 + D23 同回合去重键。取自所属消息的 turn */
  turn: number;

  status: SceneImageStatus;
  /**
   * 自动开火还是玩家点的。
   * 不是审计字段，是**限流账本**：D23 只看 'auto'，滚动窗口两者都计。
   */
  source: 'auto' | 'manual';

  // ── 图鉴展示面（AI 写，用户可改，D18）──
  title: string;
  description: string;
  /** 用户收藏，将来做清理时的豁免位 */
  favorite?: boolean;

  // ── 复现所需（D8：备份存的是配方）──
  /** 标记正文原文（**未归一化**，保留 AI 写的原始字节，供排查） */
  scenePrompt: string;
  /**
   * 用户在图鉴里改过的场景提示词。
   *
   * **存在时，「重画」优先用它**（D26）—— 用户改完提示词点重画，结果却按 AI 的原话生成，
   * 是这类界面最挫败的一种失败。`scenePrompt` 保持原样不被覆盖，于是"改回去"永远可行。
   */
  editedScenePrompt?: string;
  characters: string[];
  rating: ImageRating;
  /** 真正发出去的完整正向/负向（含预设与后缀） */
  positive: string;
  negative: string;
  model: string;
  seed?: number;
  /** 原样请求参数 */
  params: Record<string, unknown>;

  // ── 字节元数据（status='done' 时才有）──
  mime?: string;
  bytes?: number;
  hash?: string;

  /** status='failed' 时的可读原因（已本地化，§12） */
  error?: string;
  /** 失败分类，供统计与"要不要显示重试" */
  errorKind?: ImageGenFailureKind;

  createdAt: number;
}

/** 字节表，与 assetBlobs 同形状 */
export interface SceneImageBlobRecord {
  id: string; // === SceneImageRecord.id
  blob: Blob;
}

// ═══ 失败分类 ═══

export type ImageGenFailureKind =
  | 'auth' // 401：令牌无效/过期
  | 'payment' // 402：Anlas 不足
  | 'rate-limit' // 429
  | 'bad-request' // 400：请求体不合法（带上游 detail）
  | 'upstream' // 5xx
  | 'network' // 连不上 / 超时
  | 'aborted' // 用户取消 / 切存档
  | 'bad-response'; // content-type 不是 zip，或 zip 里没有图

export interface ImageGenFailure {
  ok: false;
  kind: ImageGenFailureKind;
  /** 已本地化的一句话，直接进 UI */
  message: string;
  /** 上游原始信息，只进 console 与记录，不进 UI */
  detail?: string;
  /** 这一类要不要显示"重试"按钮 */
  retryable: boolean;
}
```

---

## 5. 纯函数层契约

**纯度约束（全层）**：无 I/O、无 Dexie、无 Vue、无浏览器全局、无 `Date.now()`（时间从参数进）、无随机。必须在 `vitest environment:'node'` 下可导入。

### 5.1 `image-segments.ts`

```ts
export function splitSceneImageSegments(text: string): NarrativeSegment[];
```

**不变式：**

- 🔴 **不自己写第二个解析器** —— 调 `marker-protocol` 的 `scanByTag(text, 'scene_image')` 拿 `position` + `rawContent`，用它们切。一个标签两个解析器就是漂移的来路
- `occurrence` 在**整条消息**上从 0 递增
- 相邻文本段合并（照 `beautifier.appendText` 的做法）；空文本段不产出
- 正文为空的标记（自闭合 / 只有属性）**产出但不带 occurrence**？❌ 不 —— 直接**不产出任何段**，等价于剥掉（§3.4）
- 输入无标记时返回 `[{kind:'text', text}]`（**不是空数组**，调用方不必特判）
- 输入空串返回 `[]`

### 5.2 `image-prompt.ts` —— 承重模块

```ts
export interface ComposeOptions {
  /** 按模型的画质后缀常量，**追加在末尾**（§6.2） */
  qualitySuffix: string;
  /** 固定的横构图词 */
  compositionTags: string;
  /** 我们自己维护的基础负向 */
  baseNegative: string;
  /** 设置里的全局追加负向 */
  extraNegative: string;
  /** 标记没写 rating 时的默认档 */
  defaultRating: ImageRating;
  /** 缺省 6（NAI 官方上限） */
  maxCharacters?: number;
}

export function composePrompt(
  marker: SceneImageMarker,
  presets: ReadonlyMap<string, CharacterImagePreset>,
  opts: ComposeOptions,
): ComposedPrompt;
```

**拼接顺序（`base`）：**

```
[1] 场景     ← marker.bodyText（含数量标签 2girls/1boy）
[2] 构图     ← opts.compositionTags
[3] rating   ← `rating:${marker.rating ?? opts.defaultRating}`
[4] 画质后缀 ← opts.qualitySuffix   🔴 末尾，不是开头
```

**不变式：**

- 🔴 **角色预设绝不拼进 `base`** —— 分别进 `characters[]`。拼成一串是一锅标签汤，模型分不清哪个特征属于谁；官方文档确认串味存在，且解法是**逐角色 UC**
- 🔴 **角色的 negative 进该角色的槽**，不并入 `baseNegative`
- 查不到预设的角色：**跳过该角色**，产出 `{kind:'missing-preset'}` 告警，**不报错**（AI 刚造的 NPC 没人写过预设，只画场景比拒绝生成好得多）
- 超过 `maxCharacters`：**截断 + 产出 `{kind:'characters-truncated', dropped}`**，不静默丢
- `seed` 取**第一个带 `pinnedSeed` 的角色**的值；都没有则 undefined
- 各段用 `, ` 连接，空段跳过，不产生 `, ,`
- danbooru 权重语法（`{{}}` / `[[]]` / `-0.8::x::`）**原样透传**，一个字符都不改

**角色预设的编写规范**（要显示在预设编辑器里）：

> 正向**不要写数量标签**（`1girl` / `solo`），那是场景的事。负向写"不希望这个角色沾上的特征"（例如另一个角色的发色），它会被放进这个角色专属的 UC 槽。

### 5.3 `image-quota.ts`

```ts
export interface QuotaInput {
  /** 本存档已有的全部记录（含 pending/failed） */
  records: readonly Pick<SceneImageRecord, 'messageId' | 'turn' | 'source' | 'createdAt'>[];
  /** 本次要生成的目标 */
  target: { messageId: string; turn: number; source: 'auto' | 'manual' };
  /** 当前时刻，**从参数进**（纯函数不碰 Date.now） */
  now: number;
  limits: { maxPerMessage: number; maxPerHour: number };
}

export function checkQuota(input: QuotaInput): QuotaVerdict;
```

**三层，互相独立，任一不满足即拒：**

| 层                | 判据                                                                     | 默认 | 挡的是                                                          |
| ----------------- | ------------------------------------------------------------------------ | ---- | --------------------------------------------------------------- |
| **L1 每条消息**   | 同 `messageId` 的记录数 ≥ `maxPerMessage`                                | 2    | 单条正文蹦出 15 个标记                                          |
| **L2 滚动时间窗** | `now - createdAt < 3600_000` 的记录数 ≥ `maxPerHour`                     | 20   | **真正的失效保护**：回退重发风暴、UI 双触发、任何没预料到的循环 |
| **L3 同回合去重** | `target.source === 'auto'` 且已存在同 `turn` 且 `source==='auto'` 的记录 | 恒开 | 回退重发（D23）                                                 |

**不变式：**

- L3 **只对 `source==='auto'` 生效** —— 玩家想为同一段剧情多画几张是他的钱、他的选择
- L1/L2 **两种 source 都计**（一个 UI bug 造成的连点也该被拦）
- 返回的 `message` 是**可读中文**，不是布尔或错误码 —— 它会直接出现在按钮的 tooltip 上
- 🔴 **自动与手动共用这一个函数**。差别只在拿到 `ok:false` 之后做什么：自动降级成按钮，手动弹一次确认（D24）。两处各写一份判定就是漂移的来路

### 5.4 `image-providers/novelai.ts`

```ts
export interface NaiOptions {
  model: string; // 'nai-diffusion-4-5-full'
  width: number; // 1216
  height: number; // 832
  steps: number; // 23
  scale: number; // 4.5
  sampler: string; // 'k_euler_ancestral'
  noiseSchedule: string; // 'karras'
  ucPreset: number; // 0
  seed?: number; // 缺省 → 调用方生成（本函数不产随机）
}

export function buildNaiRequest(prompt: ComposedPrompt, opts: NaiOptions): NaiRequestBody;

export function parseNaiZip(
  bytes: Uint8Array,
  contentType: string,
): { ok: true; images: Uint8Array[] } | ImageGenFailure;
```

**`buildNaiRequest` 的核心不变式 —— 三重冗余一致（§6.1）：**

```
prompt.base            → body.input
                       → body.parameters.v4_prompt.caption.base_caption          （逐字相同）
prompt.baseNegative    → body.parameters.negative_prompt
                       → body.parameters.v4_negative_prompt.caption.base_caption （逐字相同）
prompt.characters[i]   → body.parameters.characterPrompts[i]
                           { prompt: .positive, uc: .negative, center:{x:0,y:0}, enabled:true }
                       → body.parameters.v4_prompt.caption.char_captions[i]
                           { char_caption: .positive, centers:[{x:0,y:0}] }
                       → body.parameters.v4_negative_prompt.caption.char_captions[i]
                           { char_caption: .negative, centers:[{x:0,y:0}] }
```

🔴 **只填一处不会报错，只会静默产出不对的图**（角色条件丢失、负向不生效）。所以必须由**单一中间结构一次性展开**，绝不允许调用方分别传。测试断言的正是"三处一致 + 顺序一致"。

`parseNaiZip`：`contentType` 不含 `zip` → `bad-response`；zip 解出 0 张图 → `bad-response`；否则按 zip 内条目顺序返回全部 PNG 字节。

---

## 6. NovelAI 接口规格（2026-08-04 核准）

| 项      | 值                                                              |
| ------- | --------------------------------------------------------------- |
| 端点    | `POST https://image.novelai.net/ai/generate-image`              |
| 鉴权    | `Authorization: Bearer <persistent token>`                      |
| CORS    | ❌ 无 → **必须走 BFF**                                          |
| 响应    | `Content-Type: application/x-zip-compressed` → ZIP 装 PNG       |
| v1 模型 | **`nai-diffusion-4-5-full`**（理由见 §6.2）                     |
| 尺寸    | **1216 × 832**（NAI 官方横构图预设，≈3:2）—— 卡在 Opus 免费档内 |
| 分级    | explicit-ok                                                     |

### 6.1 V4.5 请求体 —— 由**真实录制的请求**确认

来源：`LlmKira/novelai-python` 的 `record/ai/generate_image/text2image_v4/schema.json`，一份对 `nai-diffusion-4-5-curated` 的实际请求体。**先前设计稿写的 `parameters: { prompt, uc }` 是错的**，V4 的形状是：

```jsonc
{
  "model": "nai-diffusion-4-5-full",
  "action": "generate",
  // 🔴 正向提示词在**顶层 input**，`parameters.prompt` 这个字段不存在
  "input": "1girl, tavern interior, …, rating:general, location, very aesthetic, masterpiece, no text",
  "parameters": {
    "negative_prompt": "blurry, lowres, …", // 与下面 base_caption 一字不差

    "v4_prompt": {
      "caption": {
        "base_caption": "…同 input…",
        "char_captions": [
          { "char_caption": "girl, silver hair, golden eyes, …", "centers": [{ "x": 0, "y": 0 }] },
        ],
      },
      "use_coords": false,
      "use_order": true,
    },
    "v4_negative_prompt": {
      "caption": {
        "base_caption": "…同 negative_prompt…",
        "char_captions": [
          { "char_caption": "lowres, aliasing, ", "centers": [{ "x": 0, "y": 0 }] },
        ],
      },
      "legacy_uc": false,
    },

    // 🔴 第三处重复，字段名换了一套（camelCase + prompt/uc/center/enabled）
    "characterPrompts": [
      {
        "prompt": "girl, silver hair, …",
        "uc": "lowres, aliasing, ",
        "center": { "x": 0, "y": 0 },
        "enabled": true,
      },
    ],

    "params_version": 3,
    "ucPreset": 0,
    "qualityToggle": true,
    "width": 1216,
    "height": 832,
    "n_samples": 1,
    "seed": 168874300,
    "sampler": "k_euler_ancestral",
    "noise_schedule": "karras",
    "scale": 4.5,
    "steps": 23,
    "cfg_rescale": 0,
    "dynamic_thresholding": false,
    "skip_cfg_above_sigma": null,
    "use_coords": false,
    "autoSmea": false,
    "prefer_brownian": true,
    "legacy": false,
    "legacy_uc": false,
    "legacy_v3_extend": false,
    "deliberate_euler_ancestral_bug": false,
    "add_original_image": true,
    "controlnet_strength": 1,
    "normalize_reference_strength_multiple": true,
  },
}
```

脚本已验证录制样本中 `input === v4_prompt.caption.base_caption` 且 `negative_prompt === v4_negative_prompt.caption.base_caption`。

### 6.2 官方文档交叉验证（docs.novelai.net）

#### 🔴 录制样本里的 `rating:general` 是**画质标签后缀**带进来的，不是分级字段

官方 [Add Quality Tags](https://docs.novelai.net/en/image/qualitytags/) 各模型后缀（V3 之后一律在**末尾**）：

| 模型             | 后缀                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| **V4.5 Full**    | `, location, very aesthetic, masterpiece, no text`                     |
| **V4.5 Curated** | `, location, masterpiece, no text, -0.8::feet::, `**`rating:general`** |
| V4 Full          | `, no text, best quality, very aesthetic, absurdres`                   |
| V4 Curated       | `, `**`rating:general`**`, amazing quality, very aesthetic, absurdres` |
| Anime V3         | `, best quality, amazing quality, very aesthetic, absurdres`           |

录制样本用的是 V4.5 Curated，其 `base_caption` 末尾逐字就是那一串。

**为什么这对本项目是要害：**

> `nai-diffusion-4-5-curated` + 画质标签 = 提示词里被硬塞一个 `rating:general`。而本项目明确要支持露骨内容 —— 照抄 Curated 的后缀 = 每张图都在跟自己的提示词打架。

**两条裁定：**

1. **v1 默认模型 `nai-diffusion-4-5-full`**。Curated 既是过滤子集模型，其规范后缀又强制 `rating:general`
2. **画质后缀是我们自己维护的可配置常量**（`ComposeOptions.qualitySuffix`），按上表给默认值，**绝不盲抄 Curated 那一行**。测试断言默认值不含 `rating:general`

分级仍是**提示词里的 tag**（`rating:general|sensitive|questionable|explicit` 追加进 base），只是归我们显式控制。

#### 多角色官方规则（[Multi-Character Prompting](https://docs.novelai.net/en/image/multiplecharacters/)）

| 规则                                | 对 `image-prompt.ts` 的约束                                         |
| ----------------------------------- | ------------------------------------------------------------------- |
| **最多 6 个角色**                   | 超出**截断并告警**                                                  |
| 数量标签属于 base                   | 角色槽写 `girl, purple hair…`，**不写 `1girl`**                     |
| 顺序 ≈ 阅读顺序                     | 数组顺序 = 标记 `characters` 的顺序，别排序别去重                   |
| 位置是 5×5 网格，**只是轻微暗示**   | v1 不用坐标：恒 `{x:0,y:0}` + `use_coords:false` + `use_order:true` |
| **特征会串味，官方解法是逐角色 UC** | 角色预设 negative 进 `characterPrompts[].uc`                        |

#### ⚠️ `ucPreset` 按模型各自编号

官方 [Undesired Content](https://docs.novelai.net/en/image/undesiredcontent/)：UC 预设是**每模型一套具名清单**（V4.5 Full 有 Heavy/Light/Furry Focus/Human Focus，Curated 只有三项）。`ucPreset: 0` 是那个模型清单里的第 0 项，换模型语义就变。

→ **不当跨模型稳定常量。** v1 自己维护完整负向文本，`ucPreset` 取录制值原样发；换到 Full 之后是否仍合理见 §6.3。用户负向是**叠加**在预设之上而非替换（官方明述），我们的全局负向照此语义。

### 6.3 仍需一次真机 curl 确认（不阻塞纯函数层开工）

1. 纯风景（0 角色）时 `characterPrompts` / `char_captions` 传 `[]` 是否被接受
   → **风险已很低**：`v4_*` 信封是 V4 模型分支的**固定结构**，多角色关闭时同样发送、只是数组为空。仍要打一发确认，但不必为此设计降级路径
2. 我们拼的 body 能否端到端换回 zip
3. 换到 `nai-diffusion-4-5-full` 后 `ucPreset: 0` 是否仍合理
   → **同样已降级**：这个值在各 V3/V4 分支的实践取值互不相同却都能正常出图，说明它**不是承重参数**。先原样发，出问题再调

```bash
curl -X POST https://image.novelai.net/ai/generate-image -H "Authorization: Bearer $NAI_TOKEN" -H "Content-Type: application/json" -H "Accept: application/x-zip-compressed" --data @nai-probe.json -o nai-probe.zip -w "status=%{http_code} type=%{content_type}\n"
```

⚠️ **Anlas**：Opus 订阅在「常规尺寸 + 单张」内不消耗点数。模板的 `1216×832 / 23 步 / n_samples:1` 在免费档内。

---

## 7. 存储层

### 7.1 Dexie v17

```ts
this.version(17).stores(
  withSchema(SCHEMA_V16, {
    sceneImages: 'id, saveId, messageId, [saveId+messageId], turn',
    sceneImageBlobs: 'id',
    imagePresets: 'name', // 主键即角色名（D2：严格 ===）
  }),
);
```

- **正文渲染**按 `[saveId+messageId]` 取（一条消息就几张，`occurrence`/`take` 在内存里挑）
- **图鉴**按 `saveId` 整取后按 `turn` 排序
- **D23 去重**按 `saveId` 取后按 `turn` + `source` 过滤
- `sceneImageBlobs` 与 `assetBlobs` 同形状（`id` 对应元数据 id）

### 7.2 删除存档时连带删

加进 `database.ts:1083` 那个删除事务：

```ts
await db.sceneImages.where('saveId').equals(id).delete();
// blobs 按上面查出的 id 批删
```

`imagePresets` **不删** —— 它是全局的（D2），与素材库同口径。

### 7.3 FullBackup（D8）

| 表                | 进备份 | 理由                                                                                           |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `sceneImages`     | ✅     | 元数据是**配方**：prompt + seed + model + 标题说明。恢复出来是一份读得通的图鉴目录，可一键重画 |
| `imagePresets`    | ✅     | 纯文本、很小，与世界书/工坊项目同性质                                                          |
| `sceneImageBlobs` | ❌     | 字节进 JSON 备份会爆炸。与 `audioBlobs` / `assetBlobs` 一致                                    |

**独立 zip 导出**：「导出本存档插画」，复用 `asset-zip.ts` 的流式机制。文件名 `<turn>_<title>.png`，附 `manifest.json` 带标题/说明/提示词/seed。

### 7.4 回滚（D7）

`game-store.rollbackOneTurn()` → `restoreSnapshot()` **会连消息一起回滚**（已确认 `game-store.ts:794-802`）。

因为图按 `(messageId, occurrence)` 反查（D2），快照带回同样的 messageId 与正文 → **标记回来了，图自动重新挂上**。真正回不来的消息留下孤儿记录 —— **保留不删**（D7），图鉴里仍可见可导出。

**这条是 D2 白送的，不需要写一行回收逻辑。**

### 7.5 用量

设置页存档数据分区加一行：「本存档插画：N 张 / X MB（自动 A / 手动 M）」+ 手动清理按钮。

---

## 8. 执行链路

```
story agent 输出正文（含 <scene_image>）
  ↓ 既有 scanMarkers（MARKER_SPECS 加一行）
  ↓ GamePipeline 的 onSceneImage 回调 ← 照 onPlayAudio 的现成先例
  │
  ├─【auto】且**这是本回合新到的消息**（D15）
  │      → 逐个标记过 checkQuota({source:'auto'})
  │          ok   → generate(source:'auto')
  │          拒   → 什么都不做 → 落到"无记录"格 → **渲染成手动按钮**（D21）
  ├─【manual】→ 什么都不做。渲染按钮；点击时过同一个 checkQuota({source:'manual'})
  │          ok   → generate(source:'manual')
  │          拒   → 弹一次确认，确认后照发（D24）
  └─【off】→ 什么都不做（标记照扫，否则漏成文本；但不建记录、不发请求）

generate(saveId, messageId, occurrence, marker, source)    ← 唯一入口，两档共用
  ↓ take = 该 (messageId, occurrence) 已有记录数
  ↓ 建 SceneImageRecord{status:'pending', source, take} → **立即落库**（D5）
  ↓ composePrompt(marker, presets, opts)
  ↓ buildNaiRequest(composed, naiOpts)
  ↓ image-client 经 BFF 发请求（带 AbortController）
  ↓ 成功：parseNaiZip → 存 blob → status:'done' + mime/bytes/hash
     失败：status:'failed' + error/errorKind（§12）
  ↓ store 变更 → 正文与图鉴两处同时更新（同一批记录的两个视图）
```

### 8.1 D15 的实现面

`onSceneImage` 回调**只在编排器刚产出这条消息时触发一次** —— 历史消息重新渲染走的是 store 查询，根本不经过这个回调。所以 D15 是**默认成立的**。

🔴 需要提防的是反过来：**日后千万别为了"补全历史插画"加一条扫描全部消息的路径**，那会把这条安全性一次性拆掉。**代码里必须留这句注释。**

### 8.2 并发

一条消息可能有 2-3 个标记 → **串行发**（NAI 有速率限制，且并发同时扣费）。手动点击进同一个队列，不另开一条。切存档/离开页面 → `AbortController` 取消未完成的，对应记录标 `aborted`。

---

## 9. 限流失效保护（D20–D25）

### 9.1 为什么不能只写在 prompt 里

prompt 里的克制指令表达的是"一般情况下希望它怎么做"。模型漂移、越狱正文、世界书注入、上下文被挤爆，任何一条都能让它失效 —— 而**失效的代价是真金白银**。凡是"错了会花钱"的约束，都不该只由被约束的那一方自己遵守。

### 9.2 让 Code 限流变安全的那一条（D21）

**超预算的标记降级成手动按钮，绝不丢弃。**

这条把"限流"和"丢东西"拆开了。§10.2 的真值表里「无记录 + 开关非 off」本来就渲染按钮，所以限流**不需要任何新的渲染状态** —— 它只是让某些标记走到那一格。玩家看到的是一个按钮和一句「已达本小时上限」，而不是一张凭空消失的图。

### 9.3 两条硬规矩，不可配置

- **永不自动重试**（D25）
- **手动按钮永远可用**。任何限额都不能把它变灰，最多弹一次确认

### 9.4 花销要看得见

设置页与图鉴各显示一行 **「本小时 7/20 · 本存档共 43 张（自动 31 / 手动 12）」**。一个数字在涨这件事，比任何限额都更早让人察觉不对 —— 这本身就是一层失效保护。

---

## 10. 渲染层

### 10.1 分段在美化之前（D3）

```
msg.content
  ↓ splitSceneImageSegments(text)              ← always-on，不看美化开关
  [ {text}, {image, occurrence, marker}, {text}, … ]
  ↓ 每个 text 段各自过 compileBeautifierSegments(...)   ← 既有逻辑，仍受开关/流式约束
  ↓ BeautifiedNarrative 渲染
```

两个后果，都是想要的：

- **美化关掉、或流式输出途中，标记依然不会漏成尖括号**
- 美化规则**不会跨过一张插画**去匹配（正确：一条规则不该把插图吞进替换里）

### 10.2 图片段的状态真值表

渲染只看两件事：这个 `(messageId, occurrence)` **有没有记录** × **当前哪一档开关**。

| 有记录？  | 开关              | 渲染                                                                                        |
| --------- | ----------------- | ------------------------------------------------------------------------------------------- |
| 无        | `off`             | **什么都不渲染**，标记隐形                                                                  |
| 无        | `manual` / `auto` | **「生成插画」按钮** + 标题 + 说明。点击 → 建记录并发请求                                   |
| `pending` | 任意              | 占位框（1216:832 骨架屏）+ 转圈。**刷新后仍在**（D5）                                       |
| `done`    | 任意              | 图片，点击放大；悬停出「重画 / 复制提示词 / 收藏 / 删除」；多 take 时角落 `2/3` 可切（D17） |
| `failed`  | 任意              | 一行可读原因 + 「重试」（`retryable` 为 false 时不显示）。**绝不静默留白**                  |

> 💡「无记录 + `auto`」这一格是 D15 与 D21 的共同产物：自动只对新消息开火、超限降级到这里。所以把开关从手动拨到自动**不会追溯烧钱**，玩家仍能一张张补画。

**布局约束**：图片宽度跟随正文列宽，`max-height` 夹住。**按钮态与占位态必须占同样高度**，否则每张图生成完成时整个对话流会跳一下。

### 10.3 CG 图鉴

同一批 `SceneImageRecord` 的第二个视图 —— **零新数据模型**。

- **入口**：游戏页侧栏（`SideToolbar.vue`），与 `SnapshotPanel` / `MemoryPanel` 同级
- **列表**：按 `turn` 升序（剧情顺序）。每格缩略图 + `title` + `desc`。同 `(messageId, occurrence)` 的多 take 折成一格，角标显示张数
- **详情**：大图 + 标题/说明（**双击就地改** —— AI 写的是初值不是定论）+ 元数据（回合/模型/seed/出场角色）+ **可编辑的场景提示词**（改完点重画 → 走 `editedScenePrompt`，D26）+ 动作（跳回那条消息 / 重画 / 导出这一张 / 收藏 / 删除）
- **未生成的标记不进图鉴** —— 图鉴是"已经画出来的东西"，塞一堆灰格子会让它从战利品陈列变成待办清单。补画入口在正文里
- **性能**：几十张时 object URL + CSS 尺寸即可。上百张后再考虑烘缩略图（`image-crop.ts` 的 canvas 缝现成），属于"卡了再做"
- 🔴 **懒加载要双保险**：`IntersectionObserver` **加上**一个定时兜底（约 500ms 后按 `getBoundingClientRect()` 对视口 ±1500px 复查一遍）。单靠观察器在低带宽/弱设备上会不触发，图鉴一屏几十张时表现为**一片空白框**，而且是那种"我这边好好的"的 bug

🔴 **object URL 必须走 `src/ui/lib/asset-url.ts` 的引用计数 LRU，不要写第二个** —— 图鉴一次挂几十个 URL、切走要全部回收，正是它解决的问题。

---

## 11. 设置项

新增第 13 分区 `🖼 图像生成`。⚠️ **要改两处**（Q-18 硬规矩）：`settings-types.ts` 的 `UiSettings` 声明 **+** `getDefaults()` 给默认值。

```ts
// UiSettings 增量
imageGenMode: ImageGenMode; // 'manual'  ← 默认手动，见下
imageEndpointId: string | null; // null      指向 API 池（apiType:'image'）
imageModel: string; // 'nai-diffusion-4-5-full'
imageQualitySuffix: string; // ', location, very aesthetic, masterpiece, no text'
imageBaseNegative: string; // 我们维护的基础负向
imageExtraNegative: string; // ''        用户追加
imageDefaultRating: ImageRating; // 'general'
imageWidth: number; // 1216
imageHeight: number; // 832
imageSteps: number; // 23
imageScale: number; // 4.5
imageSampler: string; // 'k_euler_ancestral'
imageNoiseSchedule: string; // 'karras'
imageUcPreset: number; // 0
imageMaxPerMessage: number; // 2
imageMaxPerHour: number; // 20
```

**默认档位是 `'manual'`**：手动档下 AI 多写几个标记只是多几个按钮、不花钱，所以"story agent 该多久画一次"这个提示词工程问题可以先不解决 —— 让玩家看着标记频率合不合适，再决定要不要拨到自动。

⚠️ **`apiType` 的坑**：`api-key-migration.ts:16` 把类型钉成 `'chat' | 'embedding'`，`:65` 有一行 `entry.apiType === 'embedding' ? 'embedding' : 'chat'` —— 加 `'image'` 时**两处一起改**，否则症状是「图像 API 存了、重开变成 chat」。

---

## 12. BFF 与错误分类

### 12.1 BFF 改动

1. `vite.config.ts` 的 hono 挂载前缀加 `/api/image`
2. `server/routes/image.ts` **复用 `forward()`** —— 它已是 `new Response(upstream.body, …)` 管道直通且剥掉了 `content-encoding`，**zip 原样过**。🔴 **不要**另写一条会 `await res.json()` 的路径
3. `Accept: application/x-zip-compressed` 由前端设置，`forward()` 已透传
4. SSRF 黑名单、`Authorization` 透传都**不动**

### 12.2 错误分类与文案

| HTTP / 情形     | `kind`         | UI 文案                                     | 可重试 |
| --------------- | -------------- | ------------------------------------------- | ------ |
| 401             | `auth`         | NovelAI 令牌无效或已过期，去设置里重填      | ❌     |
| 402             | `payment`      | Anlas 不足，或这次的尺寸/步数超出了免费额度 | ❌     |
| 429             | `rate-limit`   | NovelAI 限流了，过一会儿再试                | ✅     |
| 400             | `bad-request`  | 请求被拒绝：{上游 detail 摘要}              | ❌     |
| 5xx             | `upstream`     | NovelAI 服务端出错了                        | ✅     |
| 网络/超时       | `network`      | 连不上 NovelAI，检查网络或代理              | ✅     |
| 用户取消        | `aborted`      | 已取消                                      | ✅     |
| 非 zip / 空 zip | `bad-response` | NovelAI 返回了看不懂的内容                  | ✅     |

`detail` 只进 console 与记录，**不进 UI**（上游报文可能很长且是英文）。

---

## 13. 文件落位

```
src/sillytavern/
├── types-image.ts              ← §4 全部类型
├── image-segments.ts           ← ★splitSceneImageSegments（§5.1）
├── image-prompt.ts             ← ★承重：composePrompt（§5.2）
├── image-quota.ts              ← ★checkQuota（§5.3，三层限额**唯一**判定处）
├── image-defaults.ts           ← 画质后缀表 / 构图词 / 基础负向 等常量
├── marker-protocol.ts          ← 改：MARKER_SPECS 加一行 + sanitizeCaption
└── image-providers/
    └── novelai.ts              ← buildNaiRequest / parseNaiZip（§5.4）

src/ui/
├── lib/image-client.ts         ← 唯一网络接触点（先例：workshop-client.ts，判别联合永不抛穿 + 超时 + 取消）
├── stores/scene-image-store.ts ← Dexie v17 唯一读写口 + generate() 队列
├── stores/image-preset-store.ts← 角色预设 CRUD
└── components/game/
    ├── BeautifiedNarrative.vue ← 改：外层先过 splitSceneImageSegments
    ├── SceneImageSegment.vue   ← 新：§10.2 状态真值表
    ├── CgGalleryPanel.vue      ← 新：图鉴列表
    ├── CgGalleryDetail.vue     ← 新：图鉴详情
    └── SideToolbar.vue         ← 改：加图鉴入口

src/ui/components/settings/image/
├── ImageSection.vue            ← 分区壳（**单根** section.centered），照 Q-25 拆法
├── ImageProviderCard.vue       ← 三档开关 + 端点 + 模型 + 参数 + 后缀/负向 + 限额 + 用量
└── ImagePresetList.vue         ← 角色预设 CRUD（含 §5.2 那条编写规范提示）

server/routes/image.ts          ← 复用 forward()
```

各分区 `<style scoped src="../settings-chrome.css">` 引入共用外壳样式。

---

## 14. 测试清单

| 模块                                                | 断言                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image-segments.test.ts`                            | 分割位置 · occurrence 编号 · 0/1/多标记 · 标记在正文首尾 · 漏写闭合的兜底 · 自闭合被剥掉 · 无标记返回单个 text 段（非空数组） · **不引入第二个解析器**（走 `scanByTag`）                                                                                                                  |
| `image-prompt.test.ts`                              | 四段顺序（**画质后缀在末尾**） · 查不到预设的角色被跳过并告警而非报错 · 角色 negative 进各自槽**而非**全局 · **第 7 个角色被截断且告警** · rating tag 正确 · **默认后缀不含 `rating:general`** · 权重语法原样透传 · 不产生 `, ,`                                                          |
| `image-quota.test.ts`                               | 三层各自边界（L1 第 2/3 个 · L2 窗口内外 · L3 同回合已有 auto） · **三条互相独立**（任一不满足即拒） · **L3 只对 auto 生效** · 手动**永不被判成不可用**，只可能"要确认" · 拒绝理由是可读中文                                                                                              |
| `novelai.test.ts`                                   | `buildNaiRequest` 逐字节确定 · ★**三重冗余一致**（`input`≡`base_caption`、`negative_prompt`≡负向 `base_caption`、`characterPrompts[i]`≡`char_captions[i]` 且**顺序一致**） · 0 角色时两数组皆 `[]` · `parseNaiZip` 喂**真 NAI zip fixture** → 字节 · 非 zip content-type → `bad-response` |
| `marker-protocol.test.ts`                           | 既有 + `scene_image` 属性解析与正文提取 · **标题含引号/超长/缺省时只收敛不拒绝**                                                                                                                                                                                                          |
| `normalizeTagString`（并入 `image-prompt.test.ts`） | ★全角逗号/顿号/全角分号 → ASCII · `《》`→`<>`（`<lora:x:0.8>` 得以复原） · 换行与 `<br>` → `, ` · 连续逗号折叠 · **权重语法 `{{}}` / `[[]]` / `-0.8::feet::` 一个字符不改** · 首尾逗号被去掉                                                                                              |
| `scene-image-store.test.ts`                         | fake-indexeddb：pending 先落库 · 按 `[saveId+messageId]` 查 · 删存档连带删（且 `imagePresets` **不**删） · **重画追加 take 不覆盖**                                                                                                                                                       |
| 渲染态判定（纯函数抽出来测）                        | §10.2 真值表逐格 —— 尤其**「无记录 + auto」出按钮而不是自动开火**                                                                                                                                                                                                                         |

> D15 值得单独一条断言：它是本设计唯一"错了会直接花钱"的规则，而其正确性来自"回调只在新消息时触发"这个**外部事实**。所以要测的不是回调本身，而是**渲染态判定不会把 auto 解释成"没记录就去生成"** —— 那是将来最可能被人"顺手补全"掉的一环。

---

## 15. 实施顺序

| 阶段   | 内容                                                                   | 依赖    | 可并行              |
| ------ | ---------------------------------------------------------------------- | ------- | ------------------- |
| **A**  | `types-image.ts` + `image-defaults.ts`                                 | 无      | —                   |
| **B1** | `image-segments.ts` + 测试                                             | A       | ✅ 与 B2/B3/B4 并行 |
| **B2** | `image-prompt.ts` + 测试                                               | A       | ✅                  |
| **B3** | `image-quota.ts` + 测试                                                | A       | ✅                  |
| **B4** | `image-providers/novelai.ts` + 测试                                    | A       | ✅                  |
| **C**  | `marker-protocol.ts`：`MARKER_SPECS` 加一行 + `sanitizeCaption` + 测试 | A       | —                   |
| **D**  | Dexie v17 + `scene-image-store` + `image-preset-store` + 测试          | A       | —                   |
| **E**  | `server/routes/image.ts` + `vite.config.ts` + `image-client.ts`        | A       | 与 D 并行           |
| **F**  | `BeautifiedNarrative.vue` 改造 + `SceneImageSegment.vue`               | B1, D   | —                   |
| **G**  | `GamePipeline.onSceneImage` 接线（三档分流 + 限额）                    | C, D, E | —                   |
| **H**  | 设置分区 `settings/image/`                                             | D       | 与 F/G 并行         |
| **I**  | CG 图鉴 `CgGalleryPanel/Detail` + `SideToolbar` 入口                   | D       | 与 G/H 并行         |
| **J**  | `agent-config.json` story systemPrompt（教方言 + 标题写法 + 克制指令） | G       | —                   |
| **K**  | 真机走查 + §6.3 的三点 curl 确认                                       | 全部    | —                   |

**B 组四个纯函数模块完全不依赖任何未决事项，可以立刻开工。**

---

## 附录 A：v2 路线图（已核准的调研，直接取用）

### A.1 另外三家 provider

| Provider          | 端点 / 鉴权                                                                            | 方言     | 分级          | 关键点                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- | -------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1111 / Forge** | `POST {base}/sdapi/v1/txt2img`；本地无鉴权                                             | danbooru | explicit-ok   | 启动加 `--api`；CORS 用 `--cors-allow-origins=http://127.0.0.1:5173`（**正是 dev.bat 钉死的端口**）。响应 `{images:[b64], parameters, info}`。进度 `GET /sdapi/v1/progress`（不需 `id_task`）。中断 `/sdapi/v1/interrupt`                                                                                                                                               |
| **OpenAI**        | `POST /v1/images/generations`；Bearer                                                  | prose    | sfw-moderated | 模型 `gpt-image-2` / `gpt-image-1.5` / `gpt-image-1` / `gpt-image-1-mini`。🔴 **`gpt-image-2` 不支持透明背景**，要透明得挑 1.5 或更早 + `output_format` png/webp。GPT 系**恒回 `data[].b64_json`**，`response_format` 只对 DALL·E 有效。拒绝时 `error.code='moderation_blocked'` 带 `moderation_stage`(input/output) + `categories`                                     |
| **Google Gemini** | `POST https://generativelanguage.googleapis.com/v1beta/interactions`；`x-goog-api-key` | prose    | sfw-moderated | 🔴 **不是 `:generateContent`**，是 Interactions API：`{model, input:[{type:'text'…},{type:'image'…}], response_format:{type:'image', aspect_ratio, image_size}}`，图在 `interaction.output_image.data`。模型 `gemini-3-pro-image`(NB Pro) / `gemini-3.1-flash-image`(NB 2)。宽高比含 `16:9`/`4:5`；分辨率 1K/2K/4K。**参考图做角色一致性**：NB Pro 支持 6 物件 + 5 角色 |

接 Gemini 时 BFF 要加 **`x-goog-api-key`** 到 `forward()` 白名单**和** `app.ts` 的 `cors({allowHeaders})` —— **两处都要**，漏一处是跨端口访问时才炸的那类 bug。

### A.2 分级路由

两条命名路由：`explicit`（本地 SD / NAI）与 `safe`（OpenAI / Gemini），请求带 rating 选路。三条铁则：

1. **`explicit` 永不落到 `sfw-moderated` 的 provider 上**，即使用户把 OpenAI 填进露骨槽 —— 适配器能力声明覆盖用户配置。不是家长模式，是防止用户在不知情下拿自己账号去撞服务端审核
2. **绝不静默降级**：能力不匹配就当场说清。偷偷剥提示词 → "她怎么穿着衣服"的迷惑结果；照发 → 烧额度 + 账号风险
3. **SFW 路线反向注负面词**：一份 booru 预设在本地模型上会自己漂向露骨

### A.3 角色画像路径

`writeIntoSlot(blob, name, type, ext, mime)` 现成，自带三道闸门 / `(name,type)` 域哈希去重 / 永不覆盖的变体编号 / 末尾 `setPrimary`。`variant` 自由字符串天然是表情差分的键（`微笑`/`战斗`/`受伤`）。

槽位驱动构图：`头像` → 脸部特写 1:1 · `立绘` → 全身 + **必须透明背景**（`allowsVideo('立绘')===false` 就是因为它要抠像叠背景，带白底会渲染成人物背后一块矩形）· `立绘bg` → 整幅铺满。

裁剪台（`AssetCropEditor.vue` + `importPortraitPair`）已通：生成一张全身图 → 裁剪台 → 同时烘出立绘 + 头像两份真字节。

### A.4 地点视觉预设 —— 场景一致性

v1 用角色预设解决了**角色**一致性，但**场景**一致性完全没管：同一家旅店在第 3 回合和第 40 回合会画成两个地方。

解法是**同一个机制换个实体**：按**地点名**键控的视觉预设，与 `CharacterImagePreset` 形状一致。而本项目有两样通用工具做不到的东西：

- `location-db.ts` 已有 32 个地点节点的层级结构
- 引擎**随时知道主角当前在哪** —— 不需要 AI 在标记里报地点，Code 自己就能查

于是 `composePrompt` 多一个来源：`base` 里注入当前地点的视觉预设（材质/光线/建筑风格/色调）。地点未命中时按 `audio-scene.ts` 那条**逐级回退链**找父级地点（"某间旅店" → "旅店" → "城镇内部"），与场景配乐的选曲逻辑同源。

⚠️ 别用 AI 每回合重写场景描述来做一致性 —— 那是"把上一张的标签贴进提示词里祈祷"，回合一多必然漂移。预设是**钉死的**，这正是它比"让模型自己记住"强的地方。

### A.5 素材库 `插画` 类型（做"存进素材库"时才需要，D12）

```ts
export type AssetType = '头像' | '立绘' | '立绘bg' | '场景' | '插画';
export type AssetCategory = 'character' | 'scene';
```

🔴 **有迁移代价**：`ASSET_TYPES` 参与**文件名整段解析**，D16 命名不变式拒绝「名字或变体含类型 token」的文件 —— 加 token 会让某些**过去合法的文件名变非法**。中文 token 碰撞概率远低于 latin 短词（`CG` 撞 `苏婉_立绘_CG.png` 是真会发生的），所以选 `插画`。上线前仍要跑全库预检：扫 `assetMeta` 所有行的 `name`/`variant`，命中新 token 的列出来让用户批量改名。

🔴 **场景类型不进角色回退链**：`ASSET_TYPE_FALLBACK_CHAIN` / `ASSET_TYPE_AVATAR_CHAIN` 一个字不改。一张缺席的场景图退化成某个角色的立绘是**错图**，而两条现有链的前提（构图不对也好过留洞）在场景槽位上不成立。

---

## 附录 B：核准来源（2026-08-04）

**NovelAI**

- 真实录制的 V4.5 请求体：`LlmKira/novelai-python` → `record/ai/generate_image/text2image_v4/schema.json`
- 端点与 zip 响应的一线 TS 实现：<https://github.com/koishijs/novelai-bot/blob/main/src/index.ts>
- [Multi-Character Prompting](https://docs.novelai.net/en/image/multiplecharacters/) —— 6 角色上限 / base 与角色槽分工 / 顺序 / 位置只是暗示 / 串味与逐角色 UC
- [Add Quality Tags](https://docs.novelai.net/en/image/qualitytags/) —— 各模型画质后缀原文（§6.2 那张表的出处）
- [Undesired Content](https://docs.novelai.net/en/image/undesiredcontent/) —— UC 预设按模型分组、用户负向是叠加不是替换
- [Models](https://docs.novelai.net/en/image/models/) · [Image 文档索引](https://docs.novelai.net/en/image/)
- `image.novelai.net/openapi.json` 只含 Observability API，**不含生图端点** —— 公开面无 schema 可查，故取证走录制请求

**v2 路线图**

- [Gemini 图像生成](https://ai.google.dev/gemini-api/docs/image-generation)
- [OpenAI 图像生成指南](https://developers.openai.com/api/docs/guides/image-generation) · [参数参考](https://developers.openai.com/api/reference/python/resources/images/methods/generate)
- [AUTOMATIC1111 API Wiki](https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/API) · [`--cors-allow-origins` PR](https://github.com/AUTOMATIC1111/stable-diffusion-webui/pull/4294) · [progress 端点讨论](https://github.com/AUTOMATIC1111/stable-diffusion-webui/discussions/7888)
