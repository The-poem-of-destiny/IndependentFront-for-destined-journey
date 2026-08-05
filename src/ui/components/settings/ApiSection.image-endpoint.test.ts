/**
 * 出图端点在 API 池表单里的形状 —— 结构断言（照本目录既有做法读 SFC 源码，不 mount：
 * mount ApiSection 要拖进密钥解密 / Dexie / 模型列表一整片启动逻辑，而这里守的
 * 全是「这一格在不在」这种结构决定）。
 *
 * 背景（2026-08-05 真机连坑两轮）：出图上游地址只有一个，却被做成了自由文本框。
 * 两次填错的报错**都指着无辜的地方** —— 填成 `api.novelai.net` 时上游报
 * 「model must be a valid enum value」（看起来像模型名写错），漏掉 `https://` 时
 * BFF 报「invalid X-Target-Base-URL」（看起来像 header 坏了）。于是裁定：
 * **出图端点只填名称与 API Key**，地址由代码持有。
 *
 * 真正的行为闸在 `scene-image-seams.test.ts`（「地址一概不传」那条），
 * 本文件守的是不要有人把输入框加回来。
 */
import { describe, it, expect } from 'vitest';
import source from '@ui/components/settings/ApiSection.vue?raw';
import seamsSource from '@ui/lib/scene-image-seams.ts?raw';

describe('出图端点：只填名称与 API Key', () => {
  it('「主链接」与「模型」两格对出图端点隐藏', () => {
    expect(source).toContain('const isImageEntry');
    // 两格各一个 v-if；隐藏之后要有一句话交代地址去哪了，否则看起来像功能缺了
    expect(source.match(/v-if="!isImageEntry"/g) ?? []).toHaveLength(2);
    expect(source).toContain('fixed-endpoint-hint');
    expect(source).toContain('NAI_IMAGE_API_BASE');
  });

  it('保存时把地址写成常量，而不是留空', () => {
    // 留空会让卡片上那行地址看起来像「没配好」；写常量它说的才是实话
    expect(source).toContain('isImageEntry.value ? NAI_IMAGE_API_BASE : apiForm.baseUrl');
  });

  it('「测试连接」的图像分支排在 baseUrl 闸之前', () => {
    // 排在闸后面的话，没有地址的出图端点点了会静悄悄什么都不发生 ——
    // 比一句「测不了」更让人以为是按钮坏了
    const imageBranch = source.indexOf("apiForm.apiType === 'image'");
    const baseUrlGuard = source.indexOf('!apiForm.baseUrl || !apiForm.apiKey');
    expect(imageBranch).toBeGreaterThan(-1);
    expect(baseUrlGuard).toBeGreaterThan(-1);
    expect(imageBranch).toBeLessThan(baseUrlGuard);
  });

  it('出图链路不再从端点记录里读地址', () => {
    // 与 scene-image-seams.test.ts 的行为断言互补：那边证明「没传」，
    // 这边证明「源码里没有这条读法」——有人加回来时两处会同时红
    expect(seamsSource).not.toContain('endpoint.baseUrl');
  });
});
