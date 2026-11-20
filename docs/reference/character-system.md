# 原生角色与编年史

角色定义保存作者的初始档案、素材关联和过去；`CharacterState` 保存本存档的当前状态；`characterChronicle` 保存该角色的经历。主叙事在同次回复里给出结构化更新，不新增 Agent 或经历记录专用模型请求。角色机械数据仍由已有实体生成、变量与战斗流程负责。

## 使用与内容入口

运行 `npm run dev`，在新旅程的角色选择页选择原生角色。游玩时打开角色查看器，在档案旁切换“编年史”。全部／重要、搜索与排序只改变当前列表；经历详情显示持续影响、来源类型和来源正文。七个页签、原有画像与相册共用既有主题和移动布局。

作者在内容目录的 `data/content/characters.json` 编辑角色定义，或通过内容包的 `characters` 数组分节提供定义。私有内容仓自 2026-11-20 起改为每个角色一个源目录 `content/characters/<id>/`，由构建工具同时生成该文件与 `character` 世界书条目，见下节。引擎占位文件 `public/data/content/characters.json` 为 `[]`；实际世界资料继续放在外部内容目录。内容包未提供该节时回落内容目录，显式 `[]` 表示清空。当前版本通过 JSON／内容包编辑初始资料，没有新增作者编辑器。

```json
[
  {
    "id": "river-guide",
    "name": "向导",
    "profile": {
      "aliases": ["渡口向导"],
      "identity": ["引路人"],
      "background": "来自河谷，熟悉沿河道路。",
      "goals": "寻找失散的旧友"
    },
    "assets": [{ "type": "立绘", "url": "https://example.com/guide.png" }],
    "past": [
      {
        "title": "离乡",
        "summary": "独自离开河谷，开始为旅人引路。",
        "time": { "kind": "past", "label": "少年时期" },
        "importance": 8,
        "impact": "形成独立谨慎的处事习惯。"
      }
    ]
  }
]
```

示例 URL 仅说明格式。素材可用现有 `assetId` 或 HTTP(S) URL 关联，可附 `variant`；二进制留在现有素材库，远程素材继续经已有同步流程下载。查看器优先使用显式关联，缺少关联时沿用名字查找。

## 定义与人设条目并列（2026-11-20）

角色定义是**给引擎用的结构化目录**（界面、素材、编年史、年龄、日历），**给模型读的人设是一条普通世界书条目**。两者并列，不互相替代：

- 定义用 `loreEntry` 指向条目 uid（如 `"loreEntry": "fated:character/hassan"`）。条目照常走 EJS 求值（可按 `char.affection(名字)` 写好感度分档）、`extra.lore.audiences` 路由、在场门与关键词激活、`dependsOn` 依赖闭包。
- 捏人页选中定义，即把链接条目并入存档白名单（`enabledWorldBookEntries`）；被链接的条目不再单列一项。条目的 `enabled: false` 只表示「默认不全局注入」，被选中时照常启用。
- 有已加载的链接条目时，`lore` **不发送**（主叙事的 `buildCharacterContext` 与 entity_gen 的已定人物资料都不带它）；只有没写链接、或链接条目没加载上时，`lore` 才作为兜底文本进入提示词，且不执行其中脚本。
- 世界书里的人物条目（含第三方书）仍可被识别为目录：带 `char-info-ejs-builder` 块、能读出唯一人名、去掉该块后无其他 EJS 的启用条目，转换成带 `loreEntry`（指回自己）的定义。转换只建目录，条目本身留在书里。原生定义与识别出的条目同名或 `loreEntry` 相同时，原生定义优先。

新存档将所选定义深拷贝进 `SaveSlot.metadata.characterDefinitions`；角色实例保留 `definition`。结构化字段（档案、素材、过去）只在建档时播种，内容包更新不覆盖已游玩角色；**人设条目跟随内容包**——条目是世界书，与其他世界书一样随包更新进入已有存档。

旧存档读取期补链，不改存档：冻结定义没有 `loreEntry` 时，依次取 `legacyEntry.uid`、当前注册表里同 id 定义的 `loreEntry`。补出的条目并入白名单；条目不存在时回落冻结的 `lore`。入口为 `linkCharacterDefinitions` / `characterLoreEntryUids` / `resolveCharacterLoreLinks`（`src/core/character/character-definitions.ts`），接线在 `game-pipeline.ts` 的 `loadActiveWorldBooks` 与回合上下文、`create-journey.ts` 的开局固定资料快照。自动生成的人物只归当前存档，不写回作者内容库。

## 年龄与生日（2026-11-13 已实施，待真机验证）

角色只保存**年龄锚点** `CharacterState.ageAnchor = { startAge, month, day }`：开局时刻（纪元年 1 月 1 日，即 `GAME_EPOCH_YEAR`，现为 488 年）的周岁，加上生日（历法同游戏时间：12 月 × 30 日）。当前年龄不落库，读取时由 `ageAt(ageAnchor, gameTime)` 现算，因此时间推进、跳时、快照回退、读档之后年龄自动正确，没有需要逐回合维护的计数。

不保存出生年：游戏只有一个纪元，数百岁的角色出生年会落到纪元之前甚至为负，在没有纪元／历法体系时没有意义。「开局时几岁」对任何寿命都成立。

作者在定义顶层（与 `profile` 平级）提供年龄线索，两项都可省略：

```json
{ "id": "river-guide", "name": "向导", "age": 34, "birthday": { "month": 3, "day": 15 } }
```

- `age`：角色在**开局时**的周岁（非负整数，或 `"34岁"` 这类文本），与该角色第几年才登场无关——开局三年后首次登场时显示 37 岁。
- `birthday`：`{ "month", "day" }` 或文本（`"3月15日"`、`"03-15"`）。不接受年份。现实历法的 31 日并到 30 日。
- 实例自带的线索——主角建号年龄 `customFields.age`、`entity_gen` 输出的 `age` / `birthday`——表示角色**实例化那一刻**的年龄，落库时按当时的游戏时间折算回开局年龄。开局后才出生的角色 `startAge` 为负，出生前年龄记 0。
- 作者定义优先于实例自带线索，年龄与生日各自独立取用。线索只在角色落库时读一次。
- **兜底**：没有线索，或线索无效（如 `"外貌约16岁"`、13 月），按**实例化那一刻 18 岁、生日 1 月 1 日**处理，不拒绝整份定义或整次生成。
- 旧世界书人物只认整行明确的 `年龄: 20` / `年龄：约400岁`（视为开局年龄）；带「外貌」「实际」等限定语的写法不猜，走兜底。需要准确年龄时改用原生定义显式填写。
- `ageAnchor` 是 Code 维护的账务字段：不在 `update_character` 白名单，也不在 `profile_changes` 白名单，模型不能事后改年龄。
- 引入本功能之前落库的角色没有锚点，在下一个回合收尾时回填一次（规则同上；主角的建号年龄按回填时刻折算）。
- 主叙事的在场角色块显示 `年龄: 34岁（生日3月15日）`；角色列表面板显示同一文本。让模型在生成新人物时输出 `age` / `birthday` 的提示词尚未编写，解析侧已就绪。

实现：`src/core/character/character-age.ts`；落库闸门在 `StateManager.applyAddCharacter` 与 `createJourney`。

## 叙事协议与提交

正文及其他输出之后给出恰好一个完整区块；无变化也输出空 `characters` 数组。

```xml
<character_updates>
{"characters":[{"name":"向导","profile_changes":{"goals":"与旅人共同前往渡口"},"chronicle":[{"title":"同行之约","summary":"答应与旅人同行。","time":{"kind":"this_turn"},"importance":8,"impact":"建立同行关系。","location":"渡口","people":["旅人"]}]}]}
</character_updates>
```

- `profile_changes` 白名单：`aliases/identity/occupation` 为字符串数组；`race/appearance/background/personality/gender/outfit/goals` 为非空字符串。代码不接受任意对象合并、机械字段或模型生成的 ID。
- `importance` 是 0–10 整数；当前经历用 `this_turn`，由代码读取原回合的游戏时间。初登场人物的过去用 `past` 和自由文本 `label`，不把模糊时期转换为精确日期。
- 主叙事新人物经已有 `entity_gen` 创建实体、补齐机械数据；作者定义与主叙事已确定的身份优先。即使调度器漏发创建标记，管线也会为结构化更新中的新人物使用该既有入口。
- 完整及尚未闭合的更新块均从玩家正文隐藏。缺块、坏 JSON、非法档案、非法经历和无法关联的人物会给出警告；有效人物独立提交，失败不清空旧资料。
- 正式回合接纳后，`StateManager` 在本存档写队列和按角色事务中更新档案与经历。代码核验来源回合、消息集合及正文指纹，并生成稳定条目 ID；已提交的同源经历不重复写入。
- 只有 `introducedBy` 对应本回合的新人物可写初始过去。既有角色不能让模型事后补造或重写历史。普通聊天可记录为低分；提到另一个人不自动为其创建亲历。

## 上下文规则

普通叙事、Delta 与 Story v2 共用输出协议和经历筛选。当前在场、玩家或最近输入／正文明确提及的角色为候选；初次相遇前，明确提及的作者角色也可提供重要初始经历。

经历先经过重要度 **≥7** 的硬门槛，再按重要度、相关地点／人物和时间排序，限制在 **6,000 字符**的独立经历预算中。发送时间、标题、摘要和持续影响，不发送来源全文。低分事件不会因关键词命中或剩余预算被补入。最近正文窗口继续保留原有叙事；Delta 缓存正文及 provider 原生文本块同时移除结构化更新，推理与工具块保持不变，避免低分记录绕过经历筛选进入后续提示词。

尚未实体化的已选作者角色提供简短资料目录；被提及后提供完整档案。已经实体化的人物沿用当前档案；补充 lore 只在没有已加载的链接条目时发送（按上下文里解析过的同 id 定义判断，不看角色身上冻结的副本）。

## 旧内容与存档

兼容转换只处理角色分区中可明确识别为单个人物的静态资料：读取既有 `char-info-ejs-builder` 标记里的素材声明，去掉该素材展示块，保留自然语言 lore 和原书／条目身份，并链接回该条目。其他 EJS、未知人物、禁用条目不转换，作为普通条目按原路径选择。旧捏人预设的条目选择映射到链接该条目的定义。

> 📌 2026-11-20 更正：此前的实现把转换成功的条目从**所有 Agent** 的世界书里移除，改由定义的 `lore` 只发给主叙事（见 `docs/archive/planning/2026-10-31-character-chronicle-implementation.md`「原生定义替代对应的旧人物 lore」）。结果是条目的 EJS、路由、激活与依赖对配上对的角色全部失效，加了 EJS 的条目又会因判据失配而在捏人页重复出现。现改为上节的并列模型。

这是一条只读兼容路径，不是对作者文件的批量迁移。批量迁移应先核对报告，再通过独立的显式写入操作执行；本次实现不改写私有内容库。旧存档从新回合开始记录，不扫描聊天或调用模型编造此前经历。

Dexie **v31** 增加 `characterChronicle` 表，索引为 `id`、`saveId`、`[saveId+characterId]`。快照载荷携带编年史，恢复时与角色档案一起替换；撤销角色初次出场也撤销其生成过去。作者初始经历在角色接纳后写入，后续普通回退保留相应快照中的作者经历。

整库和单存档备份都携带经历。单存档导入重映射角色、来源消息、创建回合及条目 ID，重新计算引用 ID，保留内容指纹；快照同样处理。删档级联删除经历。旧备份缺少该表／字段按空记录处理，未知日期显示“日期未载”，不伪造数据。

全部已保存经历对玩家可见；没有剧透开关、可见度／发现状态、后台离场模拟或历史任意改写接口。

## 实现位置与验证

[实施计划与本地验收记录](../archive/planning/2026-10-31-character-chronicle-implementation.md) 已归档。

- 数据类型：`src/core/types/types-character.ts`；解析、转换、筛选：`src/core/character/character-{definitions,updates,chronicle}.ts`。
- 写入：`src/core/state/state-manager.ts`；表、快照与备份：`src/core/persistence/`。
- 同轮接线：`src/ui/lib/game-pipeline.ts`、`src/core/agents/entity-gen-agent.ts`；提示词三种路径：`src/core/prompts/`。
- 界面：`src/ui/components/game/CharacterViewerModal.vue` 与 `CharacterChronicleTab.vue`；选择和内容载入：`src/ui/stores/create-store.ts`、`content-store.ts`。
- 针对性回归：`npx vitest run tests/core/character tests/core/integration/character-chronicle.test.ts tests/ui/components/game/CharacterChronicleTab.test.ts tests/ui/lib/game-pipeline.boundaries.test.ts`。模型返回使用固定夹具；真实外部模型的协议遵循与重要度评分仍需实际游玩验证。
