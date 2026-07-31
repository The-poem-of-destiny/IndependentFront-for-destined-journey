/**
 * AssetMedia — 共享素材位
 *
 * 这个组件从 ScenePanel / CharacterListPanel 两份逐字相同的本地实现里抽出来，
 * 所以本文件要钉住的**恰恰是抽取过程中最容易丢的那条性质**:
 *
 * 🔴 **每项一个作用域** —— 列表里删掉一项，只有**那一项**的 object URL 被释放，
 * 其余项一条都不许动。抽成共享组件后若不慎共用了一份解析状态（例如把 composable
 * 提到模块级），泄漏与死图在界面上都看不出来，只有这条断言看得出来。
 *
 * 其余覆盖: 命中出 img / mp4 出 video / 未命中交还插槽 / 类型链透传。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import AssetMedia from './AssetMedia.vue';
import { ASSET_TYPE_AVATAR_CHAIN, ASSET_TYPE_FALLBACK_CHAIN } from '@engine/asset-resolve';
import type { AssetMetaRecord, AssetType } from '@engine/types';

// ---- Mocks ----

let mockAssets: {
  assets: AssetMetaRecord[];
  assetUrl: ReturnType<typeof vi.fn>;
  releaseAssetUrl: ReturnType<typeof vi.fn>;
};

vi.mock('../../stores/asset-store', () => ({
  useAssetStore: () => mockAssets,
}));

function makeRow(
  name: string,
  type: AssetType,
  id = `${name}_${type}`,
  over: Partial<AssetMetaRecord> = {},
): AssetMetaRecord {
  return {
    id,
    name,
    type,
    ext: 'png',
    mime: 'image/png',
    bytes: 12,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssets = {
    assets: [],
    assetUrl: vi.fn(async (id: string) => `blob:${id}`),
    releaseAssetUrl: vi.fn(),
  };
});

describe('AssetMedia — 渲染', () => {
  it('未命中 → 交还插槽兜底，绝不渲染空白框', async () => {
    const wrapper = mount(AssetMedia, {
      props: { name: '苏婉', type: '头像' as AssetType },
      slots: { default: '苏' },
    });
    await flushPromises();

    expect(wrapper.text()).toBe('苏');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('video').exists()).toBe(false);
  });

  it('命中静图 → <img>，alt 是名字，插槽让位', async () => {
    mockAssets.assets = [makeRow('苏婉', '头像', 'av')];
    const wrapper = mount(AssetMedia, {
      props: { name: '苏婉', type: '头像' as AssetType },
      slots: { default: '苏' },
    });
    await flushPromises();

    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('blob:av');
    expect(img.attributes('alt')).toBe('苏婉');
    expect(wrapper.text()).toBe('');
  });

  it('命中 mp4 → <video muted playsinline loop autoplay>（自动播放不欠手势）', async () => {
    mockAssets.assets = [makeRow('苏婉', '立绘bg', 'bgv', { ext: 'mp4', mime: 'video/mp4' })];
    const wrapper = mount(AssetMedia, {
      props: { name: '苏婉', type: '立绘bg' as AssetType },
      slots: { default: '苏' },
    });
    await flushPromises();

    const video = wrapper.find('video');
    expect(video.exists()).toBe(true);
    expect(video.attributes('src')).toBe('blob:bgv');
    expect(video.attributes('aria-label')).toBe('苏婉');
    const el = video.element as HTMLVideoElement;
    expect(el.muted).toBe(true);
    expect(el.loop).toBe(true);
    expect(el.autoplay).toBe(true);
  });

  it('名字为空 → 直接走插槽，一次 assetUrl 都不发', async () => {
    mockAssets.assets = [makeRow('苏婉', '头像', 'av')];
    const wrapper = mount(AssetMedia, {
      props: { name: '', type: '头像' as AssetType },
      slots: { default: '?' },
    });
    await flushPromises();

    expect(wrapper.text()).toBe('?');
    expect(mockAssets.assetUrl).not.toHaveBeenCalled();
  });
});

describe('AssetMedia — 类型链透传', () => {
  it('脸位链与立牌链在同一份库上给出相反答案', async () => {
    mockAssets.assets = [makeRow('苏婉', '头像', 'av'), makeRow('苏婉', '立绘', 'st')];

    const face = mount(AssetMedia, { props: { name: '苏婉', type: ASSET_TYPE_AVATAR_CHAIN } });
    const standee = mount(AssetMedia, { props: { name: '苏婉', type: ASSET_TYPE_FALLBACK_CHAIN } });
    await flushPromises();

    expect(face.find('img').attributes('src')).toBe('blob:av');
    expect(standee.find('img').attributes('src')).toBe('blob:st');
  });

  it('★ 只有立绘时脸位也出图（降级到第二档，不留首字母的洞）', async () => {
    mockAssets.assets = [makeRow('苏婉', '立绘', 'st')];
    const wrapper = mount(AssetMedia, {
      props: { name: '苏婉', type: ASSET_TYPE_AVATAR_CHAIN },
      slots: { default: '苏' },
    });
    await flushPromises();

    expect(wrapper.find('img').attributes('src')).toBe('blob:st');
  });
});

describe('AssetMedia — 每项一个作用域（抽成共享组件后必须仍然成立）', () => {
  /** 一个 v-for 列表宿主，模仿 ScenePanel / CharacterListPanel 的用法 */
  const List = defineComponent({
    props: { names: { type: Array as () => string[], required: true } },
    setup(props) {
      return () =>
        h(
          'div',
          props.names.map((n) =>
            h('span', { key: n, class: 'slot' }, [
              h(AssetMedia, { name: n, type: ASSET_TYPE_AVATAR_CHAIN }, () => n[0]),
            ]),
          ),
        );
    },
  });

  it('每项各解析各的 —— 只有一个有素材时另一个仍是兜底', async () => {
    mockAssets.assets = [makeRow('林霜', '头像', 'lin')];
    const wrapper = mount(List, { props: { names: ['苏婉', '林霜'] } });
    await flushPromises();

    const slots = wrapper.findAll('.slot');
    expect(slots).toHaveLength(2);
    expect(slots[0].find('img').exists()).toBe(false);
    expect(slots[0].text()).toBe('苏');
    expect(slots[1].find('img').attributes('src')).toBe('blob:lin');
  });

  it('🔴 移除其中一项 → 只释放**那一项**的 URL，其余一条都不动', async () => {
    mockAssets.assets = [makeRow('苏婉', '头像', 'av'), makeRow('林霜', '头像', 'lin')];
    const wrapper = mount(List, { props: { names: ['苏婉', '林霜'] } });
    await flushPromises();
    expect(wrapper.findAll('img')).toHaveLength(2);
    expect(mockAssets.releaseAssetUrl).not.toHaveBeenCalled();

    await wrapper.setProps({ names: ['苏婉'] });
    await flushPromises();

    expect(mockAssets.releaseAssetUrl.mock.calls.map((c) => c[0])).toEqual(['lin']);
    // 留下来的那一项一个字都没动
    expect(wrapper.findAll('img')).toHaveLength(1);
    expect(wrapper.find('img').attributes('src')).toBe('blob:av');
  });

  it('整个列表卸载 → 每一项各还各的（不泄漏、也不重复撤）', async () => {
    mockAssets.assets = [makeRow('苏婉', '头像', 'av'), makeRow('林霜', '头像', 'lin')];
    const wrapper = mount(List, { props: { names: ['苏婉', '林霜'] } });
    await flushPromises();

    wrapper.unmount();

    expect(mockAssets.releaseAssetUrl.mock.calls.map((c) => c[0]).sort()).toEqual(['av', 'lin']);
  });
});
