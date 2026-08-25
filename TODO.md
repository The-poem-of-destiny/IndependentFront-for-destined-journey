# TODO

发布前待办清单。**这里只记「还没做」的事**；做完的搬去 `docs/CHANGELOG.md`，
已知缺陷（有现象、有根因分析的）归 `docs/known-issue.md`，不要在三处重复。

条目排序不代表优先级，主人裁定为准。

## 待办

- [ ] **LLM 组装层 Delta 会话 v1 —— 生产运营验收（下个对话说「继续 delta 生产验收」接上）**
      🔴 引擎代码已合入 master（PR #118 delta session + #119 vars_update 字段规范），内容仓 pack 已发
      **2.5.0 / 2.5.1 / 2.5.2**。只剩这一项真机验收没做。

  - **必读**：`docs/planning/2026-08-22-llm-assembly-delta-architecture-scratch.md` §2.3「运营验收」
    - `docs/planning/2026-08-22-llm-assembly-delta-implementation-plan.md` §9「生产 usage 验收」。
  - **前置**：引擎加载最新 pack **2.5.2**（story 默认注入 extra_setting；三条生产规则 436/437/440 默认关；
    vars_update 提示词字段规范 G3-G6 已落地）；设置页主 endpoint 填 `contextWindowTokens=512k`。
  - **步骤**：① 两个预热普通回合 → ② 五个连续、无侧链的普通主线回合 → ③ 记录七个主 DAG Agent
    （memory_recall chat 版 / plot_pre_check / story / request_dispatcher / memory_summary /
    vars_update / plot_post_check）每轮的 hit/miss/completion、实际调用集合、session revision、
    rebase reason。
  - **验收判据**：每回合主 DAG miss 合计 ≤ 30,000 tokens；侧链若意外触发则单列并重做该样本。
  - **产出**：新开带日期的 review 报告放 `docs/reviews/`（聚合 usage + 匿名场景 + 版本 SHA，
    不提交 API Key / 完整 prompt / 私有世界书），**别改写** `docs/reviews/2026-08-21-*` 历史报告。
  - **验收后重点盯**：① vars_update / request_dispatcher 的累积 delta 认知负担（AI 合并"基线+delta"
    出当前状态的准确性）；② story 注入 extra_setting 后 token 涨幅；③ 流式 story 不带 prompt_tokens，
    预算自动重基线对 story 暂不生效（设计 §8.3，已知）；④ 侧链若使总轮超 30k，记录独立 usage 另立设计。
  - **可选后续（已搁置，验收后可再议）**：模板占位符驱动 scope 裁剪（story 关 NARRATIVE delta 之类）；
    dlc.json uid 486「神秘使 › 生产与制作」默认关闭（主人裁定暂不动）。

- [ ] **Mac 兼容性** —— 目前只在 Windows 11 上开发和验证过。

  - [x] **开发启动器**（2026-08-14）：`npm run dev` 经 `scripts/dev.mjs` 按平台分发，
        Mac/Linux 走新增的 `dev.sh`（见 `docs/reference/dev-bat-notes.md` 第六节）。
        🔴 **尚未在真机 macOS 上跑过**，只做了语法检查与分支走查。
  - [ ] 真机 macOS 走查：`dev.sh` 的端口清理分支 + Vite 实际启动。
  - [ ] 其余面：路径分隔符、大小写敏感文件系统、字体回退，以及正式打包时的
        Mac 产物（与下一条「正式发布打包」合并考虑）。

- [ ] **正式发布打包** —— 把当前的开发态收敛成可分发的正式版本：产物形态（桌面壳 / 纯静态站
      / 两者）、版本号与更新渠道、内容仓 pack 的随包策略、首次启动的资产落地流程。

- [ ] **地图系统集成收尾** —— v1 / v1.2 引擎、内容仓 map-pack v1.2.0 校验门，以及地图编辑器的
      发展度 / 初始建筑 / 主建筑创作面均已落地。当前缺口是同步私有内容仓：给
      `request_dispatcher` 补 `{{MAP_CONTEXT}}` 与六个 `tile_ops`，并让世界书 uid 510 展示 v1.2
      的状态 / 发展度 / 建筑 / 编年史。同步后需在当前主线完成真实 AI 轮次、浏览器内 EJS
      地图投影、v1.2 UI 与时间结算的端到端真机走查。现行契约见
      `docs/planning/2026-08-11-map-system-v1-integration.md` 与
      `docs/planning/2026-08-18-map-tile-dynamics-v1.2-design.md`。

- [ ] **文生图集成复验** —— 在当前主线重新走通完整游玩链路：story 产出 `<scene_image>` 标记 →
      `image_prompt` 侧链 → NovelAI / ComfyUI provider → 图片落库 → 正文就地渲染与 CG 图鉴，
      同时覆盖手动 / 自动模式、失败恢复、重画、存档恢复和设置迁移。历史版本曾分别完成
      NovelAI 与 ComfyUI 真机验证，但 `artifacts/` 中没有保留对应的当前主线验收证据；设计契约见
      `docs/planning/2026-08-04-image-generation-design.md` 与
      `docs/planning/2026-08-08-comfyui-image-provider-design.md`。

- [ ] **配乐重制/精选** —— 现有曲目**不够 ambient**，存在感太强，会把注意力从正文上拽走。
      需要按场景重新甄选或重制成低存在感的环境音床，并复核音量包络与循环点。
      音频系统本身见 `docs/reference/audio_system.md`（改音频必读）。

- [ ] **远程素材（URL）铺设与验证** —— 素材可经 URL 远程加载，由一张**素材目录（catalogue）**
      做索引与落地。现有素材体系见 `docs/planning/2026-07-29-asset-management-system-design.md`。

  - [x] **主体已落地**（2026-08-17）：世界书条目（上游 `char-info-ejs-builder` 约定，静态抽取
        profile，绝不执行 EJS）+ 内容包第 14 分节 `remoteAssets` 双载体 → 启动同步
        （哈希增量 / 镜像删除 / 手动导入优先 / 代理回退）。真机核心链路已验，
        详见 `docs/CHANGELOG.md`「远程素材 v1」条。
  - [ ] **工坊来源接入** —— 工坊后端尚未提供素材声明面，待其升级后接第三个来源
        （前两个来源共用同一套抽取与校验，接入只是多一个 collect 口）。
  - [ ] **设置分区 UI 真机走查** —— `AssetRemoteSyncStrip`（开关 / 立即同步 / 上次结果行）
        只过了组件与仓库测试，未在真机点过。

- [ ] **远程加载的内容包（探索）** —— 评估把内容包（世界书 / 提示词与预设 / 其余 pack 内容）
      也做成可远程加载：分发与版本协商、与内容仓构建产物的关系、离线与失效时的回退、
      以及内容授权边界。目前只是**探索选项**，未裁定。上一条的远程素材是图/音资源面，
      这一条是内容面，两者可能共用同一套 catalogue 与版本机制，需一并考虑
      （🔴 但远程素材 v1 那张 catalogue 是**声明扫描式**的——声明本身 100% 来自本地世界书与
      本地内容包，不含分发与版本协商；内容面若要复用，缺的正是这一层，见
      `docs/CHANGELOG.md`「远程素材 v1」条）。

- [ ] **主题打磨** —— 🔴 **目标是「好看」，不是「统一」。** 现有 10 套主题
      （`src/ui/themes/`：bronze / crimson / forest / indigo / ivory / misty-lilac /
      obsidian / ocean / parchment / sakura）需要逐套按审美重做配色与质感，
      让每套都有自己立得住的调性与氛围，而不是把它们抹平成同一个样子。
      `docs/design.md` 的排版/间距规范是底线约束（别踩坏可读性与无障碍对比度），
      不是这一条的目的；规范之内该怎么大胆怎么大胆。

  - [ ] **星海首页（Astral Drift）实施后验收** —— 主链已于 2026-08-20 在
        `a441924aa622014d2d327836264e0d61fe23148a` 实施，交付记录见
        `docs/CHANGELOG.md`，现阶段只剩闭环：逐套走查十主题可读性，覆盖减动效 / 无 WebGL2 /
        context lost / 离页释放，补背景专项自动化测试，并验证宽屏、竖屏与高 DPI 构图。
        🔴 当前代码已采用 D6 的 light 主题墨纸反相方案，但这只是实施事实；主人 2026-08-09
        的保留意见仍未被正式推翻，最终视觉方向仍需裁定。

- [ ] **多分辨率 / 多宽高比适配** —— 目前布局按固定桌面视口调优；需要覆盖超宽、竖屏、
      高 DPI 与非 16:9 比例，确认地图、状态栏、立绘与大画像在各比例下不裁切、不溢出。

- [ ] **移动端支持** —— 触屏交互（无 hover）、安全区、虚拟键盘遮挡、手势与地图缩放，
      以及移动浏览器上的 QuickJS(wasm) / IndexedDB 表现验证。

- [ ] **扫荡机制（探索，未裁定）** —— 主人 2026-08-24 提出，暂不实施，留档备查。
      投骰 `(属性 + 等级×层级) + d20` vs `目标难度 + d20`：成功直接结算（正常经验+战利品），失败进战斗。
      主人要的曲线：同层成功率低、低一层 ~~80%。当时推的公式：`层差 D×10`（每低一层 +10）+ 同层惩罚（敌方 +3），
      对应成功率 同层 34% / 低1层 77~~80%（平局算败/算胜）/ 低2层 99%+ / 低3层 100%。
      未定：平局算哪边、属性取哪维、失败是否要代价（纯零代价会变"无脑扫荡"）。
