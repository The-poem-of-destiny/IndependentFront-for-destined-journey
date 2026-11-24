/**
 * StagedNarrative —— 按节渲染时插画不重复、不错位
 *
 * `<scene_image>` 的 occurrence 按整条消息计数：第二节里的第一张图是整条的第 1 号（从 0 起），
 * 不能在本节里重新从 0 数；message-end 图带只挂在全文末节；侧链拿到的是整条正文。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import StagedNarrative from '../../../../src/ui/components/game/StagedNarrative.vue';
import {
  createStagePlayback,
  deriveStagePlayback,
  stepStagePlayback,
} from '../../../../src/ui/lib/stage-playback';
import { useFxEnabled } from '../../../../src/ui/lib/fx-gate';
import { ASSET_STUB } from './action-panel/fixtures';

vi.mock('../../../../src/ui/composables/useBeautify', () => ({
  useBeautify: () => ({ getBeautifierRules: () => [], isBeautifierEnabled: () => false }),
}));
const sceneImages = vi.hoisted(() => ({
  records: [] as Array<{ anchorKind: string; occurrence: number }>,
}));
vi.mock('../../../../src/ui/stores/scene-image-store', () => ({
  useSceneImageStore: () => ({ byMessage: () => sceneImages.records }),
}));
vi.mock('../../../../src/ui/composables/useAssetImage', async () => {
  const { ref } = await import('vue');
  return { useAssetImage: () => ({ url: ref(null), isVideo: ref(false), row: ref(null) }) };
});

const SceneImageStub = defineComponent({
  name: 'SceneImageSegment',
  props: {
    messageId: { type: String, default: '' },
    occurrence: { type: Number, default: 0 },
    anchorKind: { type: String, default: 'marker' },
    narrative: { type: String, default: '' },
  },
  setup: (props) => () =>
    h('i', {
      class: 'img-stub',
      'data-kind': props.anchorKind,
      'data-occ': String(props.occurrence),
      'data-narrative': props.narrative,
    }),
});

const A = '第一节。\n<scene_image title="甲">图一</scene_image>\n还是第一节。';
const B = '第二节。\n<scene_image title="乙">图二</scene_image>\n收尾。';
const CONTENT = `${A}\n\n${B}`;
const BREAK = CONTENT.indexOf('第二节');

function viewAt(advanced: boolean) {
  let state = createStagePlayback({ content: CONTENT, breaks: [BREAK], enters: [], closed: true });
  if (advanced) state = stepStagePlayback(state, { type: 'advance' });
  return deriveStagePlayback(state);
}

function mountStaged(advanced: boolean, messageId?: string) {
  return mount(StagedNarrative, {
    props: { view: viewAt(advanced), content: CONTENT, messageId, imageMode: 'manual' },
    global: { stubs: { SceneImageSegment: SceneImageStub } },
  });
}

describe('StagedNarrative 插画计数', () => {
  it('第二节的图按整条计数为 1；侧链拿整条正文', () => {
    const wrapper = mountStaged(true, 'm1');
    const markers = wrapper.findAll('.img-stub[data-kind="marker"]');
    expect(markers.map((m) => m.attributes('data-occ'))).toEqual(['0', '1']);
    const narrative = markers[1].attributes('data-narrative') ?? '';
    expect(narrative).toContain('第一节');
    expect(narrative).toContain('收尾');
  });

  it('message-end 图带只挂在全文末节，且末节没放出来时不出现', () => {
    sceneImages.records = [{ anchorKind: 'message-end', occurrence: 0 }];
    try {
      expect(mountStaged(false, 'm1').findAll('.img-stub[data-kind="message-end"]')).toHaveLength(
        0,
      );
      expect(mountStaged(true, 'm1').findAll('.img-stub[data-kind="message-end"]')).toHaveLength(1);
    } finally {
      sceneImages.records = [];
    }
  });

  it('草稿（无 messageId）不画插画格，标记照剥', () => {
    const wrapper = mountStaged(true);
    expect(wrapper.findAll('.img-stub')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('<scene_image');
  });
});

describe('StagedNarrative 行动面板入场', () => {
  const PANEL = '<action_info>\n|行动者|艾琳|\n|目标|灰狼|\n|伤害|36|\n</action_info>';
  const P_A = `第一节。\n${PANEL}`;
  const P_B = `第二节。\n${PANEL}`;
  const P_CONTENT = `${P_A}\n\n${P_B}`;
  const P_BREAK = P_CONTENT.indexOf('第二节');

  function setFx(on: boolean) {
    if (on) document.documentElement.setAttribute('data-fx', 'on');
    else document.documentElement.removeAttribute('data-fx');
    useFxEnabled(); // 让共享镜像对齐 DOM
  }

  function mountPanels(settledEnd: number) {
    let state = createStagePlayback({
      content: P_CONTENT,
      breaks: [P_BREAK],
      enters: [],
      closed: true,
    });
    state = stepStagePlayback(state, { type: 'advance' });
    return mount(StagedNarrative, {
      props: { view: deriveStagePlayback(state), content: P_CONTENT, settledEnd },
      global: { stubs: { ...ASSET_STUB, SceneImageSegment: SceneImageStub } },
    });
  }

  const entering = (wrapper: ReturnType<typeof mountPanels>) =>
    wrapper.findAll('.action-panel-card').map((card) => card.classes().includes('is-entering'));

  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => setFx(false));

  it('闸门开：settledEnd 之前的节静默，之后新放出的节播入场', () => {
    setFx(true);
    const wrapper = mountPanels(P_BREAK);
    expect(wrapper.findAll('.action-panel-card').map((c) => c.attributes('data-kind'))).toEqual([
      'exchange',
      'exchange',
    ]);
    expect(entering(wrapper)).toEqual([false, true]);
  });

  it('闸门关：哪一节都不播', () => {
    setFx(false);
    expect(entering(mountPanels(0))).toEqual([false, false]);
  });
});
