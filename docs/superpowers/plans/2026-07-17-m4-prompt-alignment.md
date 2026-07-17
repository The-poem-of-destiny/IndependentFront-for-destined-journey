# M4 AI Prompt 契约对齐 实施计划（数据字段规范批次 4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI prompt 侧契约与 M2/M3 代码契约对齐（规范第 14 章）：`player_1` 示例灭绝、`id`→`name` 键、quests/affections 输出格式教学、枚举取值表注入；随后拆除全部过渡兼容（M2 UUID 兜底 + M3 `name ?? id` 过渡读）。

**Architecture:** agent-config.json 是单行超长 JSON（换行为字面 `\r\n`），一切编辑走 node 脚本 parse→改→stringify 回写，每个编辑 task 自带结构断言脚本。prompt 现状全文已提取在 `tmp/_vars_update_sp.txt` / `_dispatcher_sp.txt` / `_item_gen_sp.txt` / `_char_gen_sp.txt`（若丢失，用 task 内脚本重新提取）。改动原则：**只改字段名/示例/新增区块，不重写既有指令的语气与结构**（prompt 大改需真机验证，游玩测试冻结中——本批只做契约对齐这类"不改行为方向"的修改）。

**Tech Stack:** node 脚本编辑 JSON · Vitest（结构断言不进测试套件，作为脚本跑）

## Global Constraints

- 每个 task 完成后 `npm run typecheck` 0 错误 + `npm run test -- --run` 不新增失败（已知 1 失败: create-store 命定之灵）。
- 本计划在 M3 完成后执行。
- agent-config.json 编辑铁律: ① 永远 `JSON.parse` 后改对象再 `JSON.stringify(obj, null, 2)`？——**否**：先 `node -e "console.log(raw.slice(0,200))"` 确认现有序列化风格（紧凑单行），回写保持**原风格**（`JSON.stringify(obj)` 不带缩进），避免 git diff 爆炸。② 改前 `cp data/defaults/agent-config.json tmp/agent-config.pre-m4.bak`。③ 每个 task 的断言脚本必须先跑一次"改前失败"（TDD 精神）。
- 涉及 systemPrompt 文案的新增区块用中文，格式贴合该 prompt 既有小节风格（先读 tmp/ 提取文本确认分节符号）。
- 规范: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md` 第 14 章；模板变更须同步 `reference/agent流程测试/agent预期分析.md`（CLAUDE.md 规定）。

---

### Task 1: vars_update systemPrompt — id→name 键 + 示例改造 + quests/affections 教学

**Files:**
- Modify: `data/defaults/agent-config.json`（agents.vars_update.systemPrompt）
- Create: `tmp/m4-t1-edit.cjs`（编辑脚本）+ `tmp/m4-t1-assert.cjs`（断言脚本）

**Interfaces:**
- Produces（AI 端输出契约，M3 翻译层已按此消费）:
  - characters.replace/delta/add/remove 条目键: `"name": "<角色名>"`（`"id"` 键从格式说明与全部示例中移除）
  - items.*: target 一律物品名
  - 新增 quests 键教学: `{"quests":{"upsert":[{"name":"任务名","status":"进行中",...}],"remove":[{"name":"任务名"}]}}`（杀 #25——现在格式没教全靠自检清单暗示）
  - 新增 affections 键教学: `{"affections":{"set":[{"name":"角色名","value":50}],"delta":[{"name":"角色名","amount":5}]}}`（M5 翻译接线的前提）
  - 新增「枚举取值表」小节: slot 8 值 / type 5 值 / rarity 7 值 / quest.status 4 值（与 field-enums.ts 逐字一致）

- [ ] **Step 1: 写断言脚本（先跑必须失败）**

```js
// tmp/m4-t1-assert.cjs — vars_update prompt 契约断言
const cfg = JSON.parse(require('fs').readFileSync('data/defaults/agent-config.json', 'utf8'));
const sp = cfg.agents.vars_update.systemPrompt;
const must = ['"name": "理查德"', '"quests"', '"affections"', '枚举取值', '搁置'];
const mustNot = ['player_1', '"id": "'];
let fail = 0;
for (const m of must) if (!sp.includes(m)) { console.error('缺失:', m); fail++; }
for (const m of mustNot) if (sp.includes(m)) { console.error('残留:', m); fail++; }
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: 写编辑脚本并执行** — 参照 `tmp/update-agent-config.cjs` 的读写模式；对 systemPrompt 做字符串手术（示例块整段替换而非正则碎补）：① 全部 `"id": "player_1"` 型示例行替换为 `"name": "理查德"` 型 ② 输出格式节的 characters 条目键说明改 name ③ 在 items 格式节之后插入 quests 教学块 + affections 教学块（含各一个完整示例）④ 追加枚举取值表小节 ⑤ 第 8 条禁令"items 没有 add"保持并补一句"新增物品仍由 item_gen 负责，勿用 characters.add 后门"（杀 #6 越权造物的 prompt 侧）。
- [ ] **Step 3: 断言脚本通过 + 序列化风格 diff 检查**（`git diff --stat data/` 应只有 1 文件小幅变化）。
- [ ] **Step 4: 全量测试 + typecheck**（prompt 改动不应影响任何测试——有 snapshot 测试断言 prompt 内容的话按新文案更新）。
- [ ] **Step 5: Commit** `feat(M4): vars_update prompt — name 键 + quests/affections 教学 + 枚举表 (#25)`

覆盖: #25 + player_1 毒化源（vars_update 侧）。

---

### Task 2: request_dispatcher systemPrompt — 示例改名 + owner 教学 + 意识体判定规则

**Files:**
- Modify: `data/defaults/agent-config.json`（agents.request_dispatcher.systemPrompt）
- Create: `tmp/m4-t2-edit.cjs` + `tmp/m4-t2-assert.cjs`

**Interfaces:**
- Produces: 示例 id（player_1/npc_guard_01）全改角色名；`<item_gen_request>` 的 owner 属性教学=「持有者的角色名」；新增判定规则一条:「有名字、有对话、会持续出场的意识体/附灵/器灵（如寄宿在物品中的人格）**按新角色处理**，输出 char_gen_request」（补上轮 debug 发现的妲丽安缺口）。

- [ ] **Step 1: 断言脚本**（must: `owner="理查德"` 型示例、`意识体`；mustNot: `player_1`、`npc_guard_01`）先跑失败。
- [ ] **Step 2: 编辑脚本执行**（叙事示例文案遵守 `reference/narrative_context_example.md` 的沉浸感规范——不出现数值机制词）。
- [ ] **Step 3-5**: 断言通过 → 全量+typecheck → Commit `feat(M4): dispatcher prompt — 示例改名 + 意识体角色判定规则`

覆盖: player_1 毒化源（dispatcher 侧）+ 妲丽安判定缺口。

---

### Task 3: item_gen / char_gen systemPrompt — 枚举对齐

**Files:**
- Modify: `data/defaults/agent-config.json`（agents.item_gen / agents.char_gen 的 systemPrompt）
- Create: `tmp/m4-t3-edit.cjs` + `tmp/m4-t3-assert.cjs`

- [ ] **Step 1: 断言脚本** — item_gen: slot 枚举与 field-enums 的 8 值逐字一致（mustNot: `护甲|主手|惯用手|鞋子` 作为**槽位教学值**出现——它们只能是"会被归一化的别名"；must: `武器|副手|头部|身体|手部|脚部|腰带|饰品` 完整出现）；type 枚举 5 中文值；XML 输出保持无 id 属性（mustNot: `<item id=`）。char_gen: 输出的装备/物品/技能 XML 同样无 id 教学。
- [ ] **Step 2: 编辑执行**；**Step 3-5**: 断言通过 → 全量+typecheck → Commit `feat(M4): item_gen/char_gen prompt 枚举对齐 field-enums (#37 prompt 侧)`

覆盖: #37 #38（prompt 侧收口）。

---

### Task 4: agent-templates.ts fixedExamples 改名 + story prompt 的 char_detect 指令删除

**Files:**
- Modify: `src/sillytavern/agent-templates.ts`（:182 附近 fixedExamples 的 player_1）
- Modify: `data/defaults/agent-config.json`（agents.story 预设内的 char_detect 输出指令——M3 已删代码路径，这里删教学，story 不再输出该 marker）
- Test: `src/sillytavern/agent-templates.test.ts`

- [ ] **Step 1**: grep `player_1` 全仓（排除 tmp/ 与本计划），逐处改角色名或删除；story 预设的 char_detect 指令段用 node 脚本定位删除（断言: story systemPrompt 不再含 `char_detect`）。
- [ ] **Step 2: 全量 + typecheck**（agent-templates.test 若断言旧示例文本则同步更新）。
- [ ] **Step 3: Commit** `feat(M4): fixedExamples 改名 + story char_detect 教学删除`

---

### Task 5: 拆除全部过渡兼容（代码侧收口）

**Files:**
- Modify: `src/sillytavern/state-manager.ts`（resolveCharacter 的 UUID 兜底分支）
- Modify: `src/sillytavern/agent-orchestrator.ts`（`a.name ?? a.id` 过渡读，四处循环）
- Test: `src/sillytavern/state-manager.test.ts` / `agent-orchestrator.test.ts`

- [ ] **Step 1: 失败测试** — ① target 用 UUID 时进 errors `角色不存在: <uuid>`（UUID 不再是合法地址）② AI json 只有 `id` 键无 `name` 键时该条目跳过并 console.warn（不再兜底）。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**（删两处过渡分支；orchestrator 改 `const key = a.name; if (!key) { console.warn(...); continue; }`）。
- [ ] **Step 4: 既有依赖 UUID 寻址的测试改名字寻址** + typecheck + 全量。
- [ ] **Step 5: Commit** `refactor(M4): 拆除 UUID 兜底与 name??id 过渡读 — 名字寻址唯一化 (铁律1 收口)`

---

### Task 6: 文档同步 + 收尾

**Files:**
- Modify: `reference/agent流程测试/agent预期分析.md`（vars_update/dispatcher/item_gen 三节的输出格式与示例同步新契约）
- Modify: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`（附录 A 注记）
- Modify: `docs/reference/agent_system_prompt_guide.md`（若其中示例含 player_1 同步）

- [ ] **Step 1**: 三份文档同步；grep 全仓 `player_1` 应仅剩历史文档/审计归档中的记录性出现。
- [ ] **Step 2**: `npm run typecheck && npm run test -- --run` 终验；`bash scripts/notify.sh "M4 Prompt 对齐 完成!" "player_1 灭绝 | quests/affections 教学就位"`。
- [ ] **Step 3: Commit** `docs(M4): agent预期分析 同步新契约 + 附录 A 注记`

---

## 覆盖清单

| 项 | Task |
|----|------|
| #25 quests 格式未教 | 1 |
| affections 格式教学（#15 前提）| 1 |
| player_1 毒化源灭绝 | 1 / 2 / 4 |
| #37 #38 prompt 侧枚举 | 3 |
| 妲丽安式意识体判定缺口 | 2 |
| story char_detect 教学残留 | 4 |
| 过渡兼容拆除（铁律1 收口）| 5 |
| 文档同步（CLAUDE.md 规定）| 6 |
