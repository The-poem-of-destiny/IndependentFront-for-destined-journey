# 交接：升级/升层属性点系统（2026-08-10）

> 本次会话交付「升级发自由点 + 升层全属性 +1 + UI 分配」三件事。全部闸门已过、**真机走查未做**。
> 下一个会话（或真机 debug loop）从本文件接手。

## 需求原文

1. 升级以后，user 获得一个自由属性点
2. 提升层级 user 全属性 +1
3. 自由属性点可由 user 在 UI 上分配

## 交付内容（8 个代码文件）

### 引擎

| 文件                                           | 改动                                                                                                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sillytavern/state-manager.ts`             | `applyUpdateCharacter` 内：落地前抓 `prevLevel/prevTier`，落地后（hp/mp/sp 钳制之后）对 `type==='player'` 自动发放。升 N 级 → `freeAttrPoints +N`；升 N 层 → 五维各 +N、按新层级 `attributeCap` 封顶。新增 `ATTRIBUTE_KEYS` 常量。 |
| `src/sillytavern/attribute-allocation.ts`      | 🆕 `allocateAttributePoint(saveId, charName, attr)`：按名查角色（含「主角」「玩家」别名，与 `resolveCharacter` 同口径），校验点数 > 0 与层级上限，走 `commitChatState` 提交。                                                      |
| `src/sillytavern/state-manager.test.ts`        | +8 条自动发放用例。                                                                                                                                                                                                                |
| `src/sillytavern/attribute-allocation.test.ts` | 🆕 7 条（fake-indexeddb 真实 DB）。                                                                                                                                                                                                |

### UI

| 文件                                                       | 改动                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/stores/game-store.ts`                              | 🆕 action `allocateAttrPoint(attr)`：守卫活跃存档 + player，调引擎函数，成功后 `refreshFromDb()`，throw 收敛成 `ok:false`。                                         |
| `src/ui/components/game/StatusOverview.vue`                | 属性区头部「自由点 N」徽章（在 `<Transition>` 外，折叠时可见）；每个五维格在有点数时出全宽「+」按钮；达上限禁用 + tooltip 挂在格上（disabled 按钮吞自己的 title）。 |
| `src/ui/stores/game-store.test.ts`                         | +5 条（mock `@engine/attribute-allocation`）。                                                                                                                      |
| `src/ui/components/game/StatusOverview.attrpoints.test.ts` | 🆕 7 条（照 `StatusOverview.assets.test.ts` 的挂载模式）。                                                                                                          |

## 关键设计裁定（下次改动前必读）

1. **双重发放 guard**：AI 同一 patch 显式写了 `freeAttrPoints` → 升级不再叠加；显式写了 `attributes` → 升层不再叠加。理由：AI 提示词没教它「Code 会自动发」，它自己发的时候 Code 不能再发一遍。
2. **分配 patch 形状**：`{ op: 'update_character', target: 'characters.<角色名>', value: { attributes: { [attr]: 1 }, freeAttrPoints: -1 }, metadata: { delta: true } }` —— 刻意不含 `level`/`tier`，所以分配**结构上不可能**触发自动发放。
3. **钳制只封顶不回削**：`Math.max(cur, Math.min(cur + gain, cap))`。delta 五维加法本身不钳上限（AI 可越上限加属性），已超上限的属性在升层时不得被静默压低（verifier 逮到的缺口，已修）。
4. **层级配置查不到时**（越界层级/脏数据）：自动发放只加不钳；分配不拦（上限未知时拒绝等于把点数扣死）。两处口径一致，注释已写。
5. **降级降层不回收**：快照回退负责回滚，AI 改错数字不 clawback。
6. **单飞请求**：StatusOverview 同一时间只允许一个分配请求在飞，防最后一点双花。

## 验证状态

- `npm run test -- --run`：288 文件，**7369 passed / 9 skipped**
- `npm run typecheck` / `npm run typecheck:vue` / `npm run lint`（--max-warnings 0）：全绿
- Prettier：仅 `--write` 触过的文件，`git diff --numstat` 确认无整档重排
- **真机走查未做**：需要带自由点的存档实际游玩验证（升级 → 徽章出现 → 点「+」→ 属性 +1、点数 -1、达上限禁用、失败 toast）

## 已知遗留（本次范围围栏外，值得另开任务）

1. `update_character` 的 delta 五维加法**不钳层级上限** —— AI 可以把属性加越界。实现者与 verifier 都点名了；修它要过一遍既有语料确认没有依赖越界的用例。
2. AI 提示词未同步：story/预设条目没有告知「Code 自动发点」，AI 可能自己也发（guard 会防叠加，但 AI 发的数值可能与规则不一致）。改提示词要动预设条目（story 有预设短路，别写 `agents.story.systemPrompt`，见根 AGENTS.md）。
3. `CharacterListPanel.vue` 的只读「自由点」行与新徽章信息重复但无分配入口 —— 要不要在那里也开分配口，等真机反馈。
4. 升层时 `tierName` 不自动同步（AI 需自己写 `tierName`），maxHp/maxMp/maxSp 也不按 `calcResources` 自动重算 —— 维持既有行为，未动。
5. 「+」按钮 20px 高，低于 design.md §4.1 的 36px 触控目标 —— 36px 会破坏「五维保持单行」约束，以全格宽补偿，CSS 注释有理由。

## 分支 / 提交

- 分支：`feat/level-attr-points`（从 `codex/jade-conservatory-polish` HEAD 切出；工作树里另有该分支未提交的主题打磨改动，**不属于本特性，未一起提交**）
- 提交范围：上述 8 个代码文件 + `docs/CHANGELOG.md` 条目 + 本文件
