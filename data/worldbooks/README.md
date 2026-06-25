# 世界书填写指南

本文件告诉 AI 如何从参考材料（`reference/` 目录下的原版世界书）中提取内容，填入 `data/worldbooks/` 下的 15 个世界书文件。

---

## 一、世界书文件结构

每个 `.json` 文件：

```json
{
  "id": "唯一标识，与文件名一致",
  "name": "中文显示名",
  "partition": "分区类型标识",
  "description": "这个书给哪些 Agent 用，写什么内容",
  "entries": [
    {
      "uid": 123456,
      "name": "条目名称",
      "content": "注入给 AI 的正文，纯文本或 Markdown",
      "enabled": true,
      "constant": false,
      "key": ["关键词1", "关键词2"],
      "keysecondary": [],
      "selectiveLogic": 0,
      "order": 100,
      "position": 0
    }
  ],
  "builtIn": true
}
```

**字段说明：**

| 字段 | 用途 | 备注 |
|------|------|------|
| `uid` | 条目唯一数字 ID | 自增或来自原版世界书 UID |
| `name` | 条目名称 | 人类可读，显示在 UI |
| `content` | **注入给 AI 的正文** | AI 真正能看到的内容。纯文本或 Markdown，不要放 JSON 代码块 |
| `enabled` | 开关 | `true` = 可注入，`false` = 禁用 |
| `constant` | 永久注入 | `true` = 跳过关键词扫描，始终注入 |
| `key` | 主关键词 | 命中任一即激活（除非 selectiveLogic 另有规则） |
| `keysecondary` | 辅助关键词 | 配合 selectiveLogic 决定激活逻辑 |
| `selectiveLogic` | 匹配逻辑 | 0=AND_ANY, 1=NOT_ALL, 2=NOT_ANY, 3=AND_ALL |
| `order` | 注入排序 | 数值越大越靠后（越接近 prompt 尾部）。默认 100 |
| `position` | ST 兼容位置 | 保留字段，暂未使用 |

---

## 二、15 个世界书的分工

### 1. `world_setting.json` — 世界设定
**注入给**: story, plot_pre_check, plot_post_check
**内容范围**:
- 世界观宇宙架构（虚海 / 神国 / 阿斯塔利亚位面）
- 纪元与历史（复兴纪元、位面入侵等大事件）
- 神明体系 / 魔法体系基础
- 生命层级与社会阶级
- 登神长阶体系
- 世界规则（客观现实原则、反动态等级等）
- 叙事基调与风格指南

### 2. `race.json` — 种族
**注入给**: char_update, char_gen
**内容范围**:
- 23 种族详情及变体（人类/精灵/翼民/兽族/矮人/血族/巨龙/古龙/亚龙等）
- 血脉觉醒/继承规则
- 种族繁衍与混血规则
- 智慧生物分类学（智人种/亚人种/幻身种/异界种）

### 3. `faction.json` — 势力
**注入给**: story, plot_pre/post
**内容范围**:
- 10 势力详情（奥古斯提姆帝国/诺斯加德联盟/萨赫拉联邦/索伦蒂斯王国/瓦伦蒂亚/翡翠之心/翼民圣都/永夜盟约/伯伦斯法环/兽族联盟）
- 势力政治结构与社会制度
- 势力文化与传统
- 势力间的外交关系

### 4. `character.json` — 角色
**注入给**: char_update, char_gen, item_gen
**内容范围**:
- 命定核心系统（泡泡/重薇/奥托/薇洛/阿米娅/艾莉亚/唐吉坷德/长颈鹿/类脑娘/阿比盖尔/高文/lily/黑薇/妲丽安/null/小夜莺/茶茶/奶龙/梅林/读者/UNN演播室/先祖/莉莉丝 等核心）
- 世界 NPC 角色卡（维奥莱塔/安娜斯塔西娅/灾厄之翼 等）
- DLC 角色卡（索尔希艾拉/缪尔/莉莉娅丝/澪/天原绘璃奈 等 35+ 角色）

### 5. `event.json` — 事件
**注入给**: plot_pre_check, plot_post_check
**内容范围**:
- DLC 事件链本体（双子星的咏叹调/猩红之影/血姬/被遗忘者/群山回响/瓷化密室/斯芬克斯/神选者/冰之歌）
- 事件入口逻辑与触发条件
- 事件信号变量适配

### 6. `adventure_area.json` — 冒险区域
**注入给**: story, plot_pre/post
**内容范围**:
- 10 势力地理详情（首都/城市/城镇/地块）
- 冒险区域（无尽树海/悲鸣沼泽/永冻冰原/泣歌云海/碎星群岛/龙脊山脉）
- 旅行规则（徒步/骑乘/马车/传送 日行距离）
- 位置拓扑连通性
- 边陲之国 DLC 地图

### 7. `monster_ecology.json` — 怪物生态
**注入给**: story, combat
**内容范围**:
- 末世星与异界威胁
- 灾厄之翼·安博卡 等 BOSS 设定
- 貂式魔物 / 各类魔物生态
- 怪物层级与分布

### 8. `industry.json` — 产业
**注入给**: story, craft_gen
**内容范围**:
- 产业概览（基础服务/装备制造/奢侈品）
- 锻造与装备产业
- 炼金产业（公会垄断/定价/认证）
- 材料采集与贸易
- 奴隶贸易 / 性服务产业 / 情报交易
- 房产与装修 / 服装与奢侈品
- 技能书和技能课程
- 暗杀和绑架 / 魔宠贸易
- 银行信贷业 / 专业设施租赁

### 9. `organization.json` — 组织
**注入给**: story, plot_pre/post
**内容范围**:
- 冒险者公会 / 金狮商会 / 魔法协会
- 苍棘之塔（血族秘密警察）
- 阴影势力（黑市网络）
- 异界信徒（降临派/窃夺派/共存派）
- 锻造协会 / 炼金公会
- 翠玉航线 / 捕奴队

### 10. `system_core.json` — 系统核心
**注入给**: story, vars_update
**内容范围**:
- 命定之诗系统机制（FP/命运点数/命定契约/外神禁咒）
- 各命定核心的详细能力与机制
- 变量系统核心规则
- 骰池系统（D20 随机池）

### 11. `variable.json` — 变量
**注入给**: vars_update
**内容范围**:
- 世界初始设定 (`[InitVar]`)
- VarsPatch 操作说明（replace / delta / insert / delta_time）
- 变量命名空间规范（`stat_data.*` 命名空间）
- 变量更新规则与合法值域
- output_format 与 UpdateVariable 标签规则
- EJS 变量模板

### 12. `quick_feature.json` — 快捷功能
**注入给**: story
**内容范围**:
- 命运抽卡（100FP/抽，骰池随机）
- 命运盲盒（1500FP/盒）
- FP 扩展消耗选项
- 其他快捷交互功能

### 13. `extra_setting.json` — 额外设定
**注入给**: vars_update, craft_gen, story
**内容范围**:
- 核心数值表（HP/MP/SP 乘数、战斗系数、属性上限、EXP 上限）
- 品质效果限定（7 品质数值）
- 战斗协议（5 战斗类型/回合制/集群/先攻/伤害）
- 生产制作协议（锻造/炼金/烹饪/裁缝，DC 基准与品质继承）
- 状态规则（增益/减益/特殊，层数+倒计时）
- 技能装备道具生成规则
- 随机池规则
- 复活机制 / 好感度体系 / 角色辅助指导
- 任务与委托规则 / 经验值获取规则
- 经济价格指南 / 长途移动与地理参考

### 14. `cot.json` — COT
**注入给**: story（可选）
**内容范围**:
- Chain-of-Thought 推理模板
- 正文 COT 专用预设
- 实体输出/信息输出规则

### 15. `dlc.json` — DLC
**注入给**: 按需注入
**内容范围**:
- DLC 角色扮演（假小子/男娘）
- 无尽深渊地城扩展
- 旧版精灵王国 / 旧版诺斯加德联盟 / 木灵
- 神秘使职业扩展 / 边境精灵
- 边陲之国详细地图
- 鸣潮 DLC（弗洛洛角色卡）
- 雌小鬼与熟女与龙 DLC
- 祂的命定之囚开局

---

## 三、条目导入规则

- **原版条目不再改动** — 直接整条搬入对应分区，不断句、不拆分、不改写
- **筛选归类** — 判断这条原版世界书属于哪个分区，放进对应的 `.json` 文件
- **content 原样保留** — 原版条目里是什么就放什么
- **name 标注来源** — 在条目名称中体现来源

---

## 四、当前状态

15 个世界书文件已创建，部分已从原版世界书（605 条目）填充。

| 文件 | 状态 |
|------|------|
| `world_setting.json` | 已填充（合并原 world_overview + narrative_guide） |
| `race.json` | 已填充（原 race_detail） |
| `faction.json` | ⬜ 待填充 |
| `character.json` | 已填充（原 character_detail） |
| `event.json` | 已填充（原 event_detail） |
| `adventure_area.json` | 已填充（原 region_detail） |
| `monster_ecology.json` | ⬜ 待填充 |
| `industry.json` | ⬜ 待填充 |
| `organization.json` | ⬜ 待填充 |
| `system_core.json` | 已填充（原 fated_core） |
| `variable.json` | ⬜ 待填充（原 var_update 为空） |
| `quick_feature.json` | ⬜ 待填充 |
| `extra_setting.json` | 已填充（原 numerical_design） |
| `cot.json` | ⬜ 待填充 |
| `dlc.json` | 已填充（原 _ejs_deferred） |

参考文件路径：
- `reference/v4.2.1_chara_card.json` — 角色卡内嵌世界书
- `reference/命定之诗与黄昏之歌v4.2 绿灯命中微调版 (1).json` — 完整 492 条世界规则
- `reference/world_book_index.md` — 世界书条目索引
- GitHub: `The-poem-of-destiny/Worldbook-for-destined-journey` — 最新世界书源材料
