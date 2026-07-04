const fs = require('fs');
const path = 'E:/code/fated_poem_independent/data/defaults/agent-config.json';
const data = JSON.parse(fs.readFileSync(path, 'utf-8'));

// ============= request_dispatcher systemPrompt =============
let sp = data.agents.request_dispatcher.systemPrompt;

// 1. 在制作判断之后插入任务判断节
const craftSect = `## 制作判断\r\n\r\n- 正文明确涉及锻造/炼金/烹饪/裁缝/附魔/制药/工程且产出了新物品 → \x60<crat_gen_request>\x60\r\n- 正文只是提到"买了一把剑"（购买不是制作）→ 走 item_gen_request 或 item_update_request`;
const questSect = `## 任务判断\r\n\r\n<已有任务> 区块列出了当前存档中所有任务（名称/状态/优先级/进度/目标/奖励）。\r\n\r\n- 正文中出现**新的委托/目标/任务**，名称不在 <已有任务> 中 → **新任务** → \x60<quest_update_request operation="upsert" name="任务名">\x60\r\n- 正文中**已有任务发生了进展/状态变化**，名称在 <已有任务> 中 → **任务更新** → \x60<quest_update_request operation="upsert" name="已有任务名">\x60\r\n- 正文中任务被**放弃/废弃/不再需要** → **任务移除** → \x60<quest_update_request operation="remove" name="任务名">\x60\r\n- NPC 提到了某个任务名但状态没有实质变化 → 不操作（仅提及，无需更新）\r\n- 任务判断同样遵循 "同名即同一任务" 规则：名字完全匹配 → 已有任务；名字不完全匹配 → 新任务`;

sp = sp.replace(craftSect, craftSect + '\r\n\r\n' + questSect);

// 2. 思考深度 - 新增第5条
sp = sp.replace(
  '5. **制作场景识别**: 正文中是否有制作行为？是购买还是亲手制作？\r\n6. **全局变量变化**',
  '5. **任务逐个检查**: 正文中涉及了哪些任务/委托/目标？逐个对照 <已有任务> ——哪些是新出现的任务、哪些已有任务有了进展、哪些已废弃？\r\n6. **制作场景识别**: 正文中是否有制作行为？是购买还是亲手制作？\r\n7. **全局变量变化**'
);

// 3. 数据来源新增
sp = sp.replace(
  '- 上方的 **<已有物品>**',
  '- 上方的 **<已有任务>** — 判断新任务 vs 已有任务的**唯一依据**\r\n- 上方的 **<已有物品>**'
);

// 4. 绝对禁止新增
sp = sp.replace(
  '7. ❌ **request 标签正文为空**',
  '7. ❌ **遗漏任务更新** — 正文中有任务新建/推进/完成时，必须发 <quest_update_request>\r\n8. ❌ **request 标签正文为空**'
);

// 5. 边界情况
sp = sp.replace(
  '| 正文无事发生（纯对话无变化） | 仍然输出 <json>（含 delta_time），不发任何 request |',
  '| 正文无事发生（纯对话无变化） | 仍然输出 <json>（含 delta_time），不发任何 request |\r\n| 正文中任务推进但旧任务名和新的不完全一致 | 检查是否为同义名称（如"追查失踪商队"和"失踪商队调查"）。若判断是同一任务 → upsert 更新；若无法确定 → 新建任务 |'
);

// 6. 工作流程
sp = sp.replace(
  '5. 逐个角色判断：已有角色变化 → char_update_request；新角色 → char_gen_request\r\n6. 逐个物品判断',
  '5. 逐个任务判断：新任务 → quest_update_request upsert；任务推进 → quest_update_request upsert；任务废弃 → quest_update_request remove\r\n6. 逐个角色判断：已有角色变化 → char_update_request；新角色 → char_gen_request\r\n7. 逐个物品判断'
);
sp = sp.replace(
  '7. 逐个物品判断：已有物品变更 → item_update_request；新物品 → item_gen_request\r\n8. 检查制作场景',
  '7. 逐个物品判断：已有物品变更 → item_update_request；新物品 → item_gen_request\r\n8. 检查制作场景'
);
sp = sp.replace(
  '8. 输出 <json>（必须） + 按需的 request 标签',
  '9. 输出 <json>（必须） + 按需的 request 标签'
);

// 7. 输出前自检
sp = sp.replace(
  '8. ☐ 没有包裹 markdown 代码块？',
  '8. ☐ 任务有变化时已发送 <quest_update_request>？\r\n9. ☐ 每个 quest 的 name 与 <已有任务> 或正文完全一致？\r\n10. ☐ 没有包裹 markdown 代码块？'
);

// 8. 输出格式 - 新增 quest_update_request
sp = sp.replace(
  '/>\r\n</craft_gen_request>\r\n\r\n---\r\n\r\n# 完整示例',
  '/>\r\n</craft_gen_request>\r\n<quest_update_request operation="upsert/remove" name="任务名（必需，用作数据库 key）">\r\n  upsert: status/priority/progress/detail/objective/reward 的任务描述。\r\n  remove: 移除原因。\r\n</quest_update_request>\r\n\r\n---\r\n\r\n# 完整示例'
);

// 9. 示例4
const example4 = '\r\n\r\n## 示例 4：任务推进\r\n\r\n**正文**: "村长交给你一个任务——追查失踪商队的下落。据说商队三天前从白曜城出发，沿北向商道经过暗影森林时失去了音讯。村长许诺事成之后给你50金币的报酬。"\r\n\r\n**已有任务**: (空)\r\n\r\n**思考**: "追查失踪商队"不在已有任务中 → 新任务 → quest_update_request upsert。\r\n\r\n**输出**:\r\n<json>\r\n{"delta_time": 15}\r\n</json>\r\n<quest_update_request operation="upsert" name="追查失踪商队">\r\n  status: 进行中, priority: 高, objective: 找到失踪的商队，了解发生了什么\r\n  progress: 刚从村长处接到任务，尚未开始调查。商队三天前从白曜城出发，最后出现在暗影森林北向商道。\r\n  detail: 白曜城村长委托你调查失踪商队。商队三天前沿北向商道出发，途径暗影森林后失去音讯。\r\n  reward: 50金币\r\n</quest_update_request>';

// Insert before the final closing double-quote of systemPrompt
sp = sp.replace(
  '\r\n</char_update_request>"',
  '\r\n</char_update_request>"' + example4
);

data.agents.request_dispatcher.systemPrompt = sp;
console.log('request_dispatcher systemPrompt: ' + sp.length + ' chars');

// ============= request_dispatcher template =============
let template = data.agents.request_dispatcher.template;
template = template.replace(
  '<正文内容>\n{{AGENT.STORY}}\n</正文内容>',
  '<已有任务>\n{{QUEST_STATE}}\n</已有任务>\n<!-- 当前存档中所有任务的列表（名称/状态/优先级/进度/目标/奖励）。\n     这是你判断"新任务 vs 已有任务"的唯一依据——\n     任务名不在此表中 → 新任务 → <quest_update_request operation="upsert">；\n     任务名在此表中 → 已有任务更新 → <quest_update_request operation="upsert">。-->\n\n<正文内容>\n{{AGENT.STORY}}\n</正文内容>'
);
data.agents.request_dispatcher.template = template;
console.log('request_dispatcher template: added QUEST_STATE block');

// ============= vars_update systemPrompt =============
let vsp = data.agents.vars_update.systemPrompt;

// 1. 角色定位
vsp = vsp.replace(
  '你是一个角色与物品状态更新系统。',
  '你是一个角色、物品与任务状态更新系统。'
);

// 2. 核心原则 #1
vsp = vsp.replace(
  '<调度器输出> 区块中的 <char_update_request> 和 <item_update_request> 是你唯一需要处理的输入。',
  '<调度器输出> 区块中的 <char_update_request>、<item_update_request> 和 <quest_update_request> 是你唯一需要处理的输入。'
);

// 3. 操作语义 - quest侧
vsp = vsp.replace(
  '| modify | 修改物品属性（耐久等） | {"owner": "player_1", "target": "皮甲", "changes": {"durability": -5}} |\r\n\r\n---',
  '| modify | 修改物品属性（耐久等） | {"owner": "player_1", "target": "皮甲", "changes": {"durability": -5}} |\r\n\r\n## quest 侧\r\n\r\n| 操作 | 用途 | 格式 |\r\n|------|------|------|\r\n| upsert | 新建/更新任务，name 作 key | {"name": "追查失踪商队", "status": "进行中", "priority": "高", "progress": "...", "detail": "...", "objective": "...", "reward": "..."} |\r\n| remove | 按 name 删除任务 | {"name": "过时的委托"} |\r\n\r\nupsert 是幂等的：name 相同的任务会覆盖更新。6 个字段都可选，只写有变化的部分即可。\r\n\r\n---'
);

// 4. 思考深度新增
vsp = vsp.replace(
  '5. **数值验证。** HP 不能超过 maxHp，不能为负数；物品数量必须为正整数。',
  '5. **任务变迁检查。** 调度器输出的 <quest_update_request> 语义是否清晰？是新建还是更新还是移除？quest 字段是否完整？\r\n6. **数值验证。** HP 不能超过 maxHp，不能为负数；物品数量必须为正整数。'
);

// 5. 数据来源
vsp = vsp.replace(
  ' <char_update_request> 和 <item_update_request>',
  ' <char_update_request>、<item_update_request> 和 <quest_update_request>'
);

// 6. 边界情况
vsp = vsp.replace(
  '| 同一角色有多条 update_request | 合并成一条处理，但每类操作各自输出 |',
  '| 同一角色有多条 update_request | 合并成一条处理，但每类操作各自输出 |\r\n| 调度器输出中有 <quest_update_request> 但缺少某些字段 | 只写入已有字段，不编造。status 默认"进行中"，priority 默认"中" |\r\n| 多个任务同时需要更新 | 每条任务一条 upsert，各自独立 |'
);

// 7. 输出前自检
vsp = vsp.replace(
  '8. ☐ 没有包裹 markdown 代码块？',
  '8. ☐ quest 更新已正确映射到 upsert/remove？\r\n9. ☐ quest name 与调度器标签一致？\r\n10. ☐ 没有包裹 markdown 代码块？'
);

// 8. 工作流程
vsp = vsp.replace(
  '4. 判断是否有需要脚本的状态效果。如果是 → 调 get_script_reference → 获取 API 文档\r\n5. 编写 <json>（必须）\r\n6. 如果有环境效果需要脚本 → 编写 <status_effects>（可选）\r\n7. 输出前自检',
  '4. 解析 quest 变更：调度器中的 <quest_update_request> → upsert/remove 操作\r\n5. 判断是否有需要脚本的状态效果。如果是 → 调 get_script_reference → 获取 API 文档\r\n6. 编写 <json>（必须，含 characters + items + quests）\r\n7. 如果有环境效果需要脚本 → 编写 <status_effects>（可选）\r\n8. 输出前自检'
);

// 9. 输出格式 - quests字段
vsp = vsp.replace(
  '    "modify": [{"owner": "角色ID", "target": "物品名", "changes": {"durability": -5}}]\r\n  }\r\n}\r\n</json>',
  '    "modify": [{"owner": "角色ID", "target": "物品名", "changes": {"durability": -5}}]\r\n  },\r\n  "quests": {\r\n    "upsert": [{"name": "任务名", "status": "进行中", "priority": "高", "progress": "...", "detail": "...", "objective": "...", "reward": "..."}],\r\n    "remove": [{"name": "任务名"}]\r\n  }\r\n}\r\n</json>'
);

// 10. 示例 - 补全 quest 示例到现有的示例3之后
vsp = vsp.replace(
  '}\r\n</json>"',
  '}\r\n</json>\r\n\r\n## 示例 4：任务更新\r\n\r\n**调度器输出:**\r\n<quest_update_request operation="upsert" name="追查失踪商队">\r\n  status: 进行中, priority: 高, progress: 在暗影森林发现了商队的残骸，但人都消失了，只剩下被撕碎的货物和血迹。\r\n  objective: 在商队残骸附近搜索幸存者的踪迹\r\n</quest_update_request>\r\n\r\n**输出:**\r\n<json>\r\n{\r\n  "characters": {\r\n    "replace": [],\r\n    "delta": [],\r\n    "add": [],\r\n    "remove": []\r\n  },\r\n  "items": {\r\n    "consume": [],\r\n    "equip": [],\r\n    "unequip": [],\r\n    "transfer": [],\r\n    "modify": []\r\n  },\r\n  "quests": {\r\n    "upsert": [{"name": "追查失踪商队", "status": "进行中", "priority": "高", "progress": "在暗影森林发现了商队的残骸，但人都消失了，只剩下被撕碎的货物和血迹。", "objective": "在商队残骸附近搜索幸存者的踪迹"}],\r\n    "remove": []\r\n  }\r\n}\r\n</json>"'
);

data.agents.vars_update.systemPrompt = vsp;
console.log('vars_update systemPrompt: ' + vsp.length + ' chars');

// ============= vars_update template =============
let vtemp = data.agents.vars_update.template;
vtemp = vtemp.replace(
  '<正文内容>\n{{AGENT.STORY}}\n</正文内容>',
  '<已有任务>\n{{QUEST_STATE}}\n</已有任务>\n<!-- 当前存档中所有任务的状态集合。在解析 quest_update_request 时需要参考此处判断当前状态。-->\n\n<正文内容>\n{{AGENT.STORY}}\n</正文内容>'
);
data.agents.vars_update.template = vtemp;
console.log('vars_update template: added QUEST_STATE block');

// Write back
fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
console.log('\nAll done! agent-config.json updated successfully.');
