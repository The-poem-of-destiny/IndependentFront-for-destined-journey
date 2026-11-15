import { isDirectSettingsProfile } from '../../../lib/direct-settings';
/**
 * 「保存为项目默认」的纯装配部分（Q-25 第 9 步）。
 *
 * `saveAsDefault` 原本是一整块：装配条目 → fetch 现有文件 → 合并 → PUT → 弹 toast。
 * 装配那一半是纯的（进去几个普通值，出来一个 `AgentDefaultEntry`），却因为和三次
 * I/O 挤在一个函数里，只能靠起整个设置页 + 打桩 fetch 才能验。
 *
 * 这里只搬**装配**，I/O 与 toast 留在组件里 —— 那部分本来就该在有 store 的地方。
 */
import type { AgentDefaultEntry, PresetItem } from '../../../stores/settings-store';
import type { AgentSettingsEntry } from '../../../stores/agent-settings';

export interface AgentDefaultInput {
  agentId: string;
  /** 当前 Agent 的完整设置（`getAgentSettings` 的结果，数值项已合默认） */
  settings: AgentSettingsEntry;
  /** System Prompt 编辑框里的草稿 */
  promptDraft: string;
  /** Context Template 编辑框里的草稿 */
  templateDraft: string;
  /**
   * **生效**的预设整份（preset-resolution 解析结果：选择键为空/失效时即默认那条）。
   * 只有连默认都解析不到时才是 null —— 调用方应在那种情况下拒绝保存。
   */
  effectivePreset: PresetItem | null;
}

/**
 * 装配一条要写进 `data/defaults/agent-config.json` 的项目默认值。
 *
 * 🔴 **story 与其它 Agent 存的是两样东西**，这条分叉是本函数存在的全部理由：
 *   · `story` 的可调面是**预设**（ST 那套 prompts 列表），所以存 `presetId` + 整份
 *     `preset`，而 `systemPrompt` / `template` 留空 —— 正文的系统提示词由预设提供，
 *     再存一份就是两个真源。
 *   · 其它 Agent 没有预设，存 `systemPrompt` + `template`，`presetId` / `preset` 留空。
 *
 * `preset` 走一次 JSON 往返做**深拷贝**：来源是 Vue 响应式代理，直接塞进
 * `JSON.stringify` 的请求体虽然能过，但拷贝还切断了与 store 的引用 ——
 * 之后用户在设置页改预设不会顺手改掉已经"保存为默认"的那一份。
 */
export function buildAgentDefaultEntry(input: AgentDefaultInput): AgentDefaultEntry {
  const { agentId, settings, promptDraft, templateDraft, effectivePreset } = input;

  const base: AgentDefaultEntry = {
    ...settings,
    // 🔴 S-00：`model` 存的是**本机** API 池 id，写进项目默认后换台机器必然悬空，
    //    新玩家会被「story 绑定的 API 已不存在」挡在创角之外。默认值里永远留空串
    //    （打包脚本要求该键是字符串，所以留键不删）。
    model: '',
    systemPrompt: '',
    template: '',
    presetId: '',
    preset: null,
  };

  if (agentId === 'story' || isDirectSettingsProfile(agentId)) {
    // 存的是生效预设本身：选择键为空（跟随默认）时也写出真实 id，绝不写空 id
    if (effectivePreset) {
      base.presetId = effectivePreset.id;
      base.preset = JSON.parse(JSON.stringify(effectivePreset)) as PresetItem;
    }
    return base;
  }

  base.systemPrompt = promptDraft || '';
  base.template = templateDraft || '';
  return base;
}
