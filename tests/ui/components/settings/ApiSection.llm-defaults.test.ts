import { describe, expect, it } from 'vitest';
import apiSource from '@ui/components/settings/ApiSection.vue?raw';

/**
 * ApiSection.vue —— 「参数跟随模型」（源级默认采样参数 + 自定义请求头）与密钥遮蔽的源码契约。
 *
 * 与 SettingsPage.apikey.test.ts 同一形态（`?raw` 结构断言，不 mount）：这里钉的是
 * 「字段绑对了地方」这类静默失效 —— 绑错输入框不会报错，只是用户改了没用。
 */
describe('ApiSection 源级默认采样参数', () => {
  it('五个默认采样参数的输入框都绑到了 apiForm 字段', () => {
    for (const field of [
      'defaultTemperature',
      'defaultTopP',
      'defaultFrequencyPenalty',
      'defaultPresencePenalty',
      'defaultMaxTokens',
    ]) {
      expect(apiSource, field).toContain(`apiForm.${field}`);
    }
  });

  it('默认采样参数只在 LLM 源上渲染', () => {
    expect(apiSource).toContain('<div v-if="isLlmEntry" class="default-params">');
  });

  it('S-10：新建源的采样参数一律留空（不悄悄盖掉内容包为各 Agent 调好的默认）', () => {
    expect(apiSource).toContain("defaultTemperature: ''");
    expect(apiSource).toContain("defaultTopP: ''");
    expect(apiSource).toContain("defaultFrequencyPenalty: ''");
    expect(apiSource).toContain("defaultPresencePenalty: ''");
    expect(apiSource).toContain("defaultMaxTokens: ''");
    expect(apiSource).not.toContain("apiForm.defaultTemperature = '1'");
    expect(apiSource).not.toContain("apiForm.defaultPresencePenalty = '0'");
    // 编辑已有连接、且库里没存过采样参数时同样显示为空，保存后不会凭空写进池默认
    expect(apiSource).toContain("String(defaultParams.temperature) : ''");
    expect(apiSource).not.toContain("String(defaultParams.temperature) : '1'");
    // 说明文字不再声称「默认为 temperature 1」
    expect(apiSource).not.toContain('默认为 temperature 1');
  });

  it('保存时经 buildDefaultParameters() 写入 defaultParameters（并透传 headerOverrides）', () => {
    expect(apiSource).toContain('defaultParameters: buildDefaultParameters()');
    expect(apiSource).toContain('headerOverrides: parseHeaderOverridesOrThrow()');
  });

  it('自定义请求头是高级设置里的一个 JSON 文本框', () => {
    expect(apiSource).toContain('v-model="apiForm.headerOverrides"');
    expect(apiSource).toContain('normalizeHeaderOverrides');
  });
});

describe('ApiSection 密钥遮蔽与弹窗宽度', () => {
  it('编辑已有连接时字段里装的是掩码，真 key 只在 _realKey', () => {
    expect(apiSource).toContain('apiForm.apiKey = key ? maskKey(key) : ');
    expect(apiSource).toContain('apiForm._realKey = key;');
  });

  it('明文显示是显式开关（showKey），默认关闭', () => {
    expect(apiSource).toContain('const showKey = ref(false);');
    expect(apiSource).toContain(":type=\"showKey ? 'text' : 'password'\"");
  });

  it('添加 / 编辑弹窗加宽到 lg', () => {
    expect(apiSource).toContain('size="lg"');
  });
});
