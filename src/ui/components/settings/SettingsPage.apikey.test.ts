/**
 * SettingsPage.vue —— API Key 编辑态的 _realKey 失效守护
 *
 * 这个洞真实咬过一次（用户报 Cline key 401）：
 *
 * 编辑已有 API 时 `openEditApi` 会把旧 key 存进 `_realKey`，而测试连接 /
 * 获取模型 / 保存三条链路取 key 都是 `_realKey || apiForm.apiKey` ——
 * **`_realKey` 优先**。若 key 输入框没有任何"用户改了输入就丢弃 _realKey"
 * 的钩子，用户在编辑弹窗里粘贴的新 key 永远不会被发出去、也保存不下来，
 * 表现为"明明填了对的 key 却一直 401"的死循环。
 *
 * 修复：key 输入框绑 `@input="onApiKeyInput"`，函数清掉 `_realKey` 与
 * `_masked`，让用户的新输入成为唯一权威。
 *
 * 做法与 SettingsPage.engine-imports.test.ts 同理：读 SFC 源码做结构断言，
 * 刻意不 mount —— mount 整个设置页要拖进 API 池 / 世界书 / Agent 配置一整片
 * 启动逻辑，而这个洞纯粹是"绑定缺失"，源码层就能钉死。
 */
import { describe, it, expect } from 'vitest';
import settingsPageSource from '@ui/components/settings/SettingsPage.vue?raw';

/** 抠出绑定了 v-model="apiForm.apiKey" 的那个 <input ...> 标签全文（含多行属性） */
function extractApiKeyInputTag(source: string): string {
  const re = /<input\b[^>]*v-model="apiForm\.apiKey"[^>]*>/s;
  const m = source.match(re);
  return m ? m[0] : '';
}

describe('SettingsPage.vue API Key 编辑态', () => {
  const source = settingsPageSource;

  it('key 输入框确实存在（正则本身别悄悄失效）', () => {
    expect(extractApiKeyInputTag(source)).not.toBe('');
  });

  it('key 输入框绑了 @input="onApiKeyInput"，用户改 key 时丢弃旧 _realKey', () => {
    const tag = extractApiKeyInputTag(source);
    expect(tag).toContain('@input="onApiKeyInput"');
  });

  it('onApiKeyInput 同时清空 _realKey 与 _masked', () => {
    const start = source.indexOf('function onApiKeyInput');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('}', start));
    expect(body).toMatch(/_realKey\s*=\s*''/);
    expect(body).toMatch(/_masked\s*=\s*false/);
  });

  it('取 key 仍是 _realKey 优先（本守护的前提——若这条变了，上面两条的理由需重审）', () => {
    // 三条链路（测试连接 / 获取模型 / 保存）至少存在一处 `_realKey || apiForm.apiKey`。
    // 若有人把优先级反过来（apiKey 优先），这个守护测试的存在意义就变了，应当连带重审。
    expect(source).toMatch(/_realKey\s*\|\|\s*apiForm\.apiKey/);
  });
});
