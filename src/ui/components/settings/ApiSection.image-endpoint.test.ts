import { describe, expect, it } from 'vitest';
import apiSource from '@ui/components/settings/ApiSection.vue?raw';
import imageSource from '@ui/components/settings/image/ImageConnectionCard.vue?raw';
import seamsSource from '@ui/lib/scene-image-seams.ts?raw';

describe('图像连接与通用 API 源分离', () => {
  it('通用 API 页只提供 LLM、Embedding 与 Reranker', () => {
    expect(apiSource).toContain('<option value="llm">');
    expect(apiSource).toContain('<option value="embedding">');
    expect(apiSource).toContain('<option value="reranker">');
    expect(apiSource).not.toContain('<option value="image">');
  });

  it('图像页拥有命名 NovelAI 连接与固定官方地址', () => {
    expect(imageSource).toContain('saveImageConnection');
    expect(imageSource).toContain('NAI_IMAGE_API_BASE');
    expect(imageSource).toContain('imageNovelai.endpointId');
  });

  it('出图链路读取独立连接，仍不把用户地址传给 NovelAI', () => {
    expect(seamsSource).toContain('deps.imageConnections?.()');
    expect(seamsSource).not.toContain('endpoint.baseUrl');
  });

  it('LLM 上下文窗口与源请求体参数都在高级区', () => {
    expect(apiSource).toContain('apiForm.contextWindowTokens');
    expect(apiSource).toContain('apiForm.bodyOverrides');
    expect(apiSource).toContain('apiForm.bodyOmitPaths');
    expect(apiSource).toContain('normalizeContextWindowTokens(apiForm.contextWindowTokens)');
  });
});
