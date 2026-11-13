# 世界书「关键日期」格式设计

> **状态：格式已在引擎侧实施（2026-11-13，§7 第 1 步；分支 `calendar-v1-key-dates`）。** 内容仓未动（第 2–4 步未做），日历尚未读取它（第 5 步未做）。§6 的内容问题仍待裁定。
> 关联：[日历系统 v1 设计](2026-11-13-calendar-system-v1-design.md)——本格式取代其中「来源 B：`calendar` 内容分节」的方案，节庆统一从世界书条目读取。

## 1. 要解决的问题

世界书里的节庆目前有两种写法：其中 14 个各占一条条目并带结构化的 `annualWindow`；其余全部是势力文化条目里的一行自由文本，引擎读不到。需要一个统一的、写在世界书条目上的结构化格式，让任何「有日期意义的设定」都能被程序读出来。

历法前提不变：**12 个月 × 30 天，一年 360 天**，7 天一周。

## 2. 需求来源

格式的能力清单来自对私有内容仓全部世界书的一次逐条普查（2026-11-13）：共 47 个节庆 / 典礼，其中 14 个已经以独立条目 + `annualWindow` 的形式结构化，其余 33 个是势力文化条目里的一行自由文本。

🔴 普查原文含真实世界观内容，**不在公开仓**；本文只保留从中归纳出的能力清单，示例一律使用虚构名称。

### 2.1 格式必须覆盖的能力

| #   | 能力                                               | 普查中的情形（去专名）                             |
| --- | -------------------------------------------------- | -------------------------------------------------- |
| F1  | 单日与连续多日，可跨月跨年                         | 几乎全部                                           |
| F2  | 只精确到月 / 到季节 / 完全不定                     | 只写了「某月」「每年春季」或没写日期的节庆         |
| F3  | 日期只是大约                                       | 正文写明日期无法预测、由观测决定的节庆；季节性现象 |
| F4  | 多年一度                                           | 三年一度的选拔、四年一度的博览会                   |
| F5  | 按月重复                                           | 每月举行的庆典                                     |
| F6  | 地区：通行全大陆 / 一个势力 / 势力内多个更细的地点 | 全大陆通行的固定节庆；只在沿海或某公国举行的节庆   |
| F7  | 一句话简介（区别于给模型读的正文）                 | 自由文本里括号内的说明；正文不能直接给玩家看       |
| F8  | 别名                                               | 同一节庆在不同条目里的两种叫法                     |
| F9  | 类别与标签                                         | 纪念日、宗教、赛事、集市、选拔考试；法定节日、休工 |
| F10 | 重要程度                                           | 最高法定节日；全大陆通行的节庆                     |
| F11 | 时刻说明                                           | 「一夜」「从日落到翌日日出」                       |
| F12 | 节庆内的日程                                       | 第一天的开幕仪式、第三天的竞赛、最后一天的烟火     |
| F13 | 一条条目承载多个日期                               | 一条势力文化条目里列了五个节庆                     |
| F14 | 不公开的日期                                       | 隐秘派系的祭典                                     |
| F15 | 仅发生一次的日期                                   | 现有节庆里没有；剧情节点会用到，顺手留出           |

明确**不建模**的：月相（「满月之夜」当固定日期处理）、相对日期（「某节前一周」直接写算好的日期）、一年多次且无日期（写进简介）、历史事件的起始年份（不引入纪元前年份）。

## 3. 格式

关键日期写在世界书条目的 `extra.lore.keyDates` 数组里。源文件位置是内容仓的 `content/worldbooks/<书>/entries/<slug>/entry.json`。

```ts
interface LoreKeyDate {
  /** 条目内唯一的 slug。全局稳定键 = `<条目 uid>#<id>` */
  id: string;
  name: string;
  aliases?: string[]; // F8

  when: KeyDateWhen; // F1 F2
  repeat?: KeyDateRepeat; // F4 F5 F15；缺省 = 每年
  /** 日期只是大约（F3）。显示时标注，不影响落位 */
  approximate?: boolean;

  /** 地区名（F6）。缺省或空 = 通行全大陆；匹配规则同 `activation.locations` */
  regions?: string[];

  /** 给玩家看的一句话（F7）。纯文本，不执行 EJS，建议 ≤ 60 字 */
  summary?: string;
  /** 时刻或时长的补充说明（F11），如「从日落到翌日日出」 */
  timeNote?: string;
  /** 类别（F9），内容自定的短词，如「节庆」「纪念日」「赛事」 */
  category?: string;
  tags?: string[]; // F9，如「法定节日」「休工」
  /** 重要节日（F10），用于日历上的突出显示 */
  major?: boolean;
  /** 节庆内日程（F12）。`day` 是节庆的第几天，从 1 起 */
  highlights?: Array<{ day: number; title: string }>;
  /** 缺省 true。false = 不自动出现在玩家日历上（F14） */
  public?: boolean;
}

type MonthDay = { month: number; day: number }; // month 1-12，day 1-30

type KeyDateWhen =
  | { precision: 'day'; start: MonthDay; end?: MonthDay } // 单日或连续多日
  | { precision: 'month'; month: number } // 在某月，具体哪天不定
  | { precision: 'season'; season: 'spring' | 'summer' | 'autumn' | 'winter' }
  | { precision: 'none' }; // 有这个节日，日期不定

type KeyDateRepeat =
  | { unit: 'year'; interval?: number; anchorYear?: number } // interval 缺省 1
  | { unit: 'month' } // 每月
  | { unit: 'once'; year: number }; // 仅某一年
```

### 3.1 规则

- **R1　历法是 30 天 × 12 月。** `day` 取 1–30。转换时：31 日、「月末」「除夕」「岁末最后一天」一律写 30。
- **R2　`end` 早于 `start` 表示跨年**（如 12/29–1/2），与 `annualWindow` 口径一致。
- **R3　多年一度必须给 `anchorYear`**：`(年份 − anchorYear) % interval === 0` 的那些年举办。没有它无法判定哪一年有。
- **R4　`repeat.unit` 为 `month` 时**，`when` 只能是 `precision: 'none'`，或 `precision: 'day'` 且 `start.month` / `end.month` 被忽略（只看日）。
- **R5　整月都是节庆**（「考试月」这类）写成 `precision: 'day'` 的 1 日至 30 日；`precision: 'month'` 只表示「这个月里的某一天，哪天不知道」。两者含义不同。
- **R6　`regions` 沿用 `activation.locations` 的匹配**：位置路径任一段包含所列名字即命中。多个名字是「或」。
- **R7　`id` 在条目内唯一、定下后不改。** 玩家的显示选择按 `<条目 uid>#<id>` 记忆，改 `id` 等于换了一个节日。
- **R8　读取侧容错，永不抛。** 坏的一项整项跳过并告警，不连累同条目的其他日期；`LoreKeyDate` 内部的未知字段保留不报错。
- **R9　`summary`、`timeNote`、`highlights[].title` 是纯文本。** 不执行 EJS、不展开宏。条目正文仍然只给模型读，日历不展示。

### 3.2 与模型读取的关系

- **R12　`keyDates` 不进入任何提示词。** 模型读到的仍然只是条目正文（`content`），读取时机仍由原有的激活规则决定；加上 `keyDates` 不需要另建一条给模型看的条目，也不改变模型看到的任何内容。发给资料选择 Agent 的目录只含条目名、`summary` 与正文长度。
- 反过来也成立：**只写在 `keyDates` 里、正文没提的日期，模型不会知道。** 想让模型知道某个节庆，仍然要写进正文。
- 区域资料的指纹（`regionSnapshotKey`）会对条目的 `extra.lore` 取哈希；`keyDates` 已从这枚指纹里排除，所以给条目补关键日期不会让区域资料缓存失效。

### 3.3 与 `annualWindow` 的关系

两者职责不同，都保留：

|            | `keyDates`                       | `readWhen.any[].annualWindow`         |
| ---------- | -------------------------------- | ------------------------------------- |
| 回答的问题 | 这个日子是什么、在哪天           | 什么时候把这条条目的正文喂给模型      |
| 消费方     | 日历（本地显示）                 | Story v2 读取门                       |
| 特有信息   | 名称、简介、地区、重复规则、日程 | `beforeDays` / `afterDays` 预热与余韵 |

- **R10　同一条条目两者并存时，日期必须一致。** `annualWindow.start/end` 等于对应 `keyDates` 项的 `when.start/end`。由内容仓的 `tools/content-source.mjs check` 校验，不一致即报错。
- **R11　没有 `annualWindow` 的条目也可以有 `keyDates`。** 势力文化条目里的一行节庆只需要加 `keyDates`，不改变它的任何读取行为。
- `annualWindow` 表达不了多年一度、按月重复和月 / 季精度；这些只存在于 `keyDates`。要让它们也能驱动读取门是引擎之后的事，不在本格式范围。

## 4. 示例

以下名称均为虚构。

**一条独立节庆条目**（`readWhen` 部分保持原样）：

```json
"extra": {
  "lore": {
    "keyDates": [
      {
        "id": "harvest-festival",
        "name": "丰收祭",
        "when": { "precision": "day", "start": { "month": 9, "day": 8 }, "end": { "month": 9, "day": 14 } },
        "regions": ["河谷公国"],
        "category": "节庆",
        "summary": "河谷的丰收庆典，新酒开桶，各地酿酒师同台竞赛。",
        "timeNote": "七天七夜",
        "highlights": [
          { "day": 1, "title": "开幕礼" },
          { "day": 3, "title": "酿酒竞赛" }
        ]
      }
    ]
  }
}
```

**一条文化条目承载多个日期**（节选）：

```json
"keyDates": [
  {
    "id": "founding-day",
    "name": "建国节",
    "when": { "precision": "day", "start": { "month": 5, "day": 27 } },
    "regions": ["中央帝国"],
    "category": "纪念日",
    "major": true,
    "summary": "建国纪念日，首都阅兵，各地设宴。"
  },
  {
    "id": "exam-month",
    "name": "考试月",
    "when": { "precision": "day", "start": { "month": 6, "day": 1 }, "end": { "month": 6, "day": 30 } },
    "regions": ["中央帝国"],
    "category": "选拔",
    "summary": "官员选拔考试，每年一次。"
  }
]
```

**其余几种形态：**

```json
{ "id": "grand-expo", "name": "博览会",
  "when": { "precision": "day", "start": { "month": 12, "day": 19 }, "end": { "month": 12, "day": 21 } },
  "repeat": { "unit": "year", "interval": 4, "anchorYear": 488 },
  "regions": ["雾港"], "category": "集市" }

{ "id": "first-frost-night", "name": "初霜夜",
  "when": { "precision": "day", "start": { "month": 10, "day": 18 } },
  "approximate": true, "regions": ["林地公国"], "timeNote": "一夜",
  "summary": "第一场重霜降下的那一夜，确切日期由观测后通报。" }

{ "id": "masquerade", "name": "假面祭",
  "when": { "precision": "month", "month": 5 },
  "regions": ["海岛王国"], "timeNote": "七天七夜" }

{ "id": "graduation", "name": "毕业典礼",
  "when": { "precision": "season", "season": "spring" }, "regions": ["学院城"] }

{ "id": "monthly-rite", "name": "月度庆典",
  "when": { "precision": "none" }, "repeat": { "unit": "month" }, "regions": ["矿镇"] }

{ "id": "year-end-day", "name": "岁末日",
  "when": { "precision": "day", "start": { "month": 12, "day": 30 } },
  "major": true, "summary": "一年的最后一天。" }
```

## 5. 日历如何消费

| `when.precision`  | 在日历上的位置                                 |
| ----------------- | ---------------------------------------------- |
| `day`             | 落在对应的日期格；多日的连成一段               |
| `month`           | 列在该月的「本月（日期未定）」区域，不占日期格 |
| `season` / `none` | 只出现在「日期未定」列表与筛选抽屉里           |

- 多年一度的项只在举办年份出现；`approximate` 的项加「约」标记。
- `public: false` 的项不自动载入。
- 地区用于三层筛选与「只看所在地区」（见日历设计 D21–D22）。

## 6. 内容转换前要裁定的内容问题

普查发现了八处原文本身不清楚或与 30 天历法冲突的地方（如写在 31 日的节庆、多年一度但没写起算年、自称在另一节庆期间但日期不重叠）。清单涉及真实内容，不在公开仓；转换前需逐条裁定。

## 7. 实施顺序（本文之后）

🔴 **`extra.lore` 的字段是白名单制，两个仓各有一份**（2026-11-13 实查）：引擎 `src/core/content/lore-protocol.ts` 在内容包安装校验时对不认识的字段报 `unknown lore field`，内容仓 `tools/lore-protocol-conditions.mjs` 报 `Unknown lore field`。所以内容不能先于工具转换，带 `keyDates` 的内容包也装不进旧版引擎。

| 步  | 仓   | 内容                                                                                                                      |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | 引擎 | `LoreEntryMeta.keyDates` 类型 + 容错解析 + 单测；`lore-protocol.ts` 白名单加 `keyDates` 并校验 R1–R4。此步只读不用        |
| 2   | 内容 | `lore-protocol-conditions.mjs` 白名单加 `keyDates`，`content-source.mjs check` 增加 R1–R4、R7、R10 校验                   |
| 3   | 内容 | 14 条已结构化的条目补 `keyDates`；其余 33 个节庆写进各自所在条目（§6 裁定之后）                                           |
| 4   | 内容 | 构建内容包时 `--engine-version` 取含第 1 步的引擎版本；在引擎仓跑 `POEM_PACK_FILE=<pack> npx vitest --run tests/contract` |
| 5   | 引擎 | 日历系统按 §5 读取                                                                                                        |

第 1、2 步必须先于第 3 步；第 3 步的内容包只能发给已包含第 1 步的引擎版本。

**第 1 步的实现位置**：类型 `LoreKeyDate` 等在 `src/core/types/types.ts`；`src/core/content/lore-key-dates.ts` 提供严格校验 `loreKeyDateErrors`（接进 `lore-protocol.ts`）、容错解析 `parseLoreKeyDates`、汇总 `collectLoreKeyDates` 与日期判定 `keyDateOccursInYear` / `keyDateCoversDay`。测试：`tests/core/content/lore-key-dates.test.ts`。
