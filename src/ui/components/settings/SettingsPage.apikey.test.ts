/**
 * ApiSection.vue —— API Key 编辑态的 _realKey 失效守护
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
 * 🔴 Q-25 之后守的是 `ApiSection.vue`（API 池分区连同它的添加/编辑弹窗
 *    整个从 SettingsPage.vue 搬了出来）。文件名保持不变是为了不打断
 *    `git log --follow`；等 Q-20 把它改写成行为断言时一并更名。
 *
 * 📌 遗留做法说明：这里读 SFC 源码做结构断言、刻意不 mount。当初的理由是
 *    "mount 整个设置页要拖进 API 池 / 世界书 / Agent 配置一整片启动逻辑" ——
 *    **那个理由现在不成立了**：ApiSection 是个自足的小组件，mount 它很便宜。
 *    Q-20 的建议（直调保存路径、断言落库的是 `_realKey` 而非掩码）现在是
 *    一次廉价改造。本次不做，是因为改断言形态与搬文件混在同一个 PR 里，
 *    红了会分不清是搬错了还是断言换了。
 */
import { describe, it, expect } from 'vitest';
import apiSectionSource from '@ui/components/settings/ApiSection.vue?raw';

/**
 * 抠出绑定了 v-model="apiForm.apiKey" 的那个 <input ...> 标签全文（含多行属性）。
 *
 * 🔴 `[^>]*` 在这个标签上是**有条件成立**的：`:type` 的表达式里含
 *    `apiForm.apiKey.length > 10`，那个 `>` 会被当成标签结束。今天能匹配到
 *    `@input`，靠的是 `@input` 排在 `:type` **之前**（属性顺序！）。
 *    `eslint --fix` 的 `vue/attributes-order` 会把 `:type` 提到前面 —— 一旦提了，
 *    这个正则就再也看不见 `@input`，测试红而代码没错。Q-25 期间踩过一次。
 *    真要根治得换成 HTML 解析或直接 mount（Q-20 的建议），不是在这里加转义。
 */
function extractApiKeyInputTag(source: string): string {
  const re = /<input\b[^>]*v-model="apiForm\.apiKey"[^>]*>/s;
  const m = source.match(re);
  return m ? m[0] : '';
}

describe('ApiSection.vue API Key 编辑态', () => {
  const source = apiSectionSource;

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
