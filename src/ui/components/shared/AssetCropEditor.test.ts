/**
 * AssetCropEditor.vue + lib/crop-rects.ts —— 一源两图的裁剪台
 * @vitest-environment jsdom
 *
 * 这里钉的是**契约**，不是像素:
 *   · 默认框（立绘=整图 / 头像=顶部居中正方形）—— 默认值决定了绝大多数用户一次都不调；
 *   · 头像框在任何改尺寸路径下恒为 1:1，且两个框都夹在图内；
 *   · 三态开关照实传给 `importPortraitPair`: 框 / `'whole'` / `'skip'`，
 *     其中 `'skip'` 是"这个类型一行都不写"—— 少了它，重裁一次立绘就会顺手多铸
 *     一张没人要的头像变体；
 *   · 落库调用拿的名字**永远是 prop**（不是文件名、更不是用户输进来的字符串）——
 *     §7.3 否决第二个命名入口，这条测试就是那句话的执法者；
 *   · **部分成功不许报成功**（store 每条批量路径的共同纪律）；
 *   · 视频行不给裁（image-crop.ts 明写传视频进来是调用方的错，所以拦在按钮上）。
 *
 * 手法:
 *   · jsdom 里没有 `URL.createObjectURL`，也没有真正的图片解码 —— 所以源图尺寸走
 *     组件的 `sourceSize` 注入缝，几何全程在**源图像素**空间里跑，一个真实的画布都不碰。
 *   · Teleport 就地渲染（`stubs: { teleport: true }`），AppModal 的内容才 find 得到。
 *   · `@engine/database` 整层替掉: jsdom 下没有可用的 IndexedDB，而本文件测的东西
 *     跟持久层没有关系。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { AssetMetaRecord } from '@engine/types'
import type { CropRect } from '../../lib/image-crop'
import AssetCropEditor from './AssetCropEditor.vue'
import AssetCharacterDrawer from '../settings/assets/AssetCharacterDrawer.vue'
import { assetDialogsKey } from '../settings/assets/dialogs'
import {
  clampRect,
  defaultAvatarRect,
  moveRect,
  previewBackground,
  resizeRect,
  wholeImageRect,
} from '../../lib/crop-rects'
import {
  useAssetStore,
  type PortraitCropPlan,
  type PortraitPairResult,
} from '../../stores/asset-store'

// ── 抽屉那条用例要的两行；编辑器那些用例用不到，getAssets 返回它无害 ──
const ROWS: AssetMetaRecord[] = [
  {
    id: 'a-png',
    name: '苏婉',
    type: '立绘',
    ext: 'png',
    mime: 'image/png',
    bytes: 128,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'a-mp4',
    name: '苏婉',
    type: '头像',
    ext: 'mp4',
    mime: 'video/mp4',
    bytes: 256,
    createdAt: 2,
    updatedAt: 2,
  },
]

vi.mock('@engine/database', () => ({
  getAssets: vi.fn(async () => ROWS),
  saveAsset: vi.fn(async () => 'id'),
  deleteAsset: vi.fn(async () => {}),
  getAssetBlob: vi.fn(async () => undefined),
  getAudioTracks: vi.fn(async () => []),
  saveAudioTrack: vi.fn(async () => {}),
  deleteAudioTrack: vi.fn(async () => {}),
  getAudioPlaylists: vi.fn(async () => []),
  saveAudioPlaylist: vi.fn(async () => {}),
  deleteAudioPlaylist: vi.fn(async () => {}),
  getAudioBlob: vi.fn(async () => undefined),
  getAudioHandle: vi.fn(async () => undefined),
  saveAudioHandle: vi.fn(async () => 'library-root'),
  deleteAudioHandle: vi.fn(async () => {}),
  getDatabase: vi.fn(() => ({})),
}))

// ═══════════════════════════════════════════════════════════
// 纯几何
// ═══════════════════════════════════════════════════════════

describe('crop-rects 几何', () => {
  it('立绘默认框就是整张图', () => {
    expect(wholeImageRect(400, 900)).toEqual({ x: 0, y: 0, w: 400, h: 900 })
  })

  it('头像默认框是顶部居中的正方形，边长取「图宽」与「图高三分之一」里较小者', () => {
    // 高图: 三分之一更小
    expect(defaultAvatarRect(400, 900)).toEqual({ x: 50, y: 0, w: 300, h: 300 })
    // 宽图: 图宽更小 → 顶部整宽的方块
    expect(defaultAvatarRect(200, 900)).toEqual({ x: 0, y: 0, w: 200, h: 200 })
  })

  it('平移撞到边界就停住，尺寸不变', () => {
    const r = moveRect({ x: 50, y: 0, w: 300, h: 300 }, 999, 999, 400, 900)
    expect(r).toEqual({ x: 100, y: 600, w: 300, h: 300 })
  })

  it('锁定 1:1 时四个角怎么拖都还是正方形，且不越界', () => {
    const base: CropRect = { x: 50, y: 100, w: 200, h: 200 }
    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
      for (const [dx, dy] of [
        [999, 5],
        [-999, -999],
        [7, 999],
        [-30, 12],
      ] as const) {
        const r = resizeRect(base, corner, dx, dy, 400, 900, true)
        expect(r.w, `${corner} ${dx},${dy}`).toBe(r.h)
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(400)
        expect(r.y + r.h).toBeLessThanOrEqual(900)
      }
    }
  })

  it('自由比例改尺寸时对角固定不动', () => {
    const r = resizeRect({ x: 10, y: 20, w: 100, h: 100 }, 'se', 40, -30, 400, 900, false)
    expect(r.x).toBe(10)
    expect(r.y).toBe(20)
    expect(r).toEqual({ x: 10, y: 20, w: 140, h: 70 })
  })

  it('非有限数不猜: NaN 进来不会造出一个不存在的框', () => {
    const r = clampRect({ x: Number.NaN, y: 0, w: Number.NaN, h: 50 }, 400, 900)
    expect(Number.isFinite(r.x)).toBe(true)
    expect(Number.isFinite(r.w)).toBe(true)
    expect(r.w).toBeGreaterThan(0)
  })

  it('预览背景: 整图时 100% / 无偏移，取一角时按公式换算', () => {
    expect(previewBackground({ x: 0, y: 0, w: 400, h: 900 }, 400, 900)).toEqual({
      size: '100% 100%',
      position: '0% 0%',
    })
    // 400 宽里取 200 宽、起点 x=100 → 恰好是可移动区间的一半
    const bg = previewBackground({ x: 100, y: 0, w: 200, h: 200 }, 400, 900)
    expect(bg.size).toBe('200% 450%')
    expect(bg.position).toBe('50% 0%')
  })
})

// ═══════════════════════════════════════════════════════════
// 编辑器
// ═══════════════════════════════════════════════════════════

interface EditorVm {
  portraitRect: CropRect
  avatarRect: CropRect
  problem: string
  canConfirm: boolean
}

function sourceBlob(): Blob {
  return new Blob(['fake-png-bytes'], { type: 'image/png' })
}

async function mountEditor(): Promise<{
  wrapper: VueWrapper
  vm: EditorVm
  source: Blob
  calls: () => unknown[][]
  resolveWith: (res: PortraitPairResult) => void
}> {
  const store = useAssetStore()
  const spy = vi.spyOn(store, 'importPortraitPair')
  spy.mockResolvedValue({ outcome: 'ok', portraitId: 'p1', avatarId: 'a1' })
  const source = sourceBlob()
  const wrapper = mount(AssetCropEditor, {
    props: { open: true, source, name: '苏婉', sourceSize: { w: 400, h: 900 } },
    global: { stubs: { teleport: true } },
  })
  await flushPromises()
  return {
    wrapper,
    vm: wrapper.vm as unknown as EditorVm,
    source,
    calls: () => spy.mock.calls as unknown[][],
    resolveWith: (res) => {
      spy.mockResolvedValue(res)
    },
  }
}

describe('AssetCropEditor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('打开时立绘框=整图、头像框=顶部居中正方形', async () => {
    const { vm } = await mountEditor()
    expect(vm.portraitRect).toEqual({ x: 0, y: 0, w: 400, h: 900 })
    expect(vm.avatarRect).toEqual({ x: 50, y: 0, w: 300, h: 300 })
  })

  it('刻意没有名称输入框 —— 名字只能由 prop 给（§7.3）', async () => {
    const { wrapper } = await mountEditor()
    expect(wrapper.findAll('input').length).toBe(0)
    expect(wrapper.findAll('textarea').length).toBe(0)
  })

  it('角把手按方向键改尺寸，头像框始终 1:1', async () => {
    const { wrapper, vm } = await mountEditor()
    const handle = wrapper.find('[data-handle="avatar-se"]')
    expect(handle.exists()).toBe(true)

    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(vm.avatarRect).toEqual({ x: 50, y: 0, w: 301, h: 301 })

    // Shift 加速；一路顶到边界后仍然是正方形（350 = 图宽 400 - 左边 50）
    for (let i = 0; i < 20; i += 1) {
      await handle.trigger('keydown', { key: 'ArrowDown', shiftKey: true })
    }
    expect(vm.avatarRect.w).toBe(vm.avatarRect.h)
    expect(vm.avatarRect.w).toBe(350)
    expect(vm.avatarRect.x + vm.avatarRect.w).toBeLessThanOrEqual(400)
  })

  it('框本体按方向键平移，撞到图边界就停住', async () => {
    const { wrapper, vm } = await mountEditor()
    const rect = wrapper.find('[data-rect="avatar"]')
    for (let i = 0; i < 40; i += 1) {
      await rect.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
    }
    expect(vm.avatarRect.x + vm.avatarRect.w).toBe(400)
    expect(vm.avatarRect.w).toBe(300)
  })

  it('确认时把两个框交给 importPortraitPair，名字取的是 prop', async () => {
    const { wrapper, calls, source } = await mountEditor()
    await wrapper.find('.confirm-btn').trigger('click')
    await flushPromises()

    expect(calls().length).toBe(1)
    const [gotSource, gotName, crops] = calls()[0] as [Blob, string, PortraitCropPlan]
    expect(gotSource).toBe(source)
    expect(gotName).toBe('苏婉')
    expect(crops.portrait).toEqual({ x: 0, y: 0, w: 400, h: 900 })
    expect(crops.avatar).toEqual({ x: 50, y: 0, w: 300, h: 300 })
    expect(wrapper.emitted('close')?.length).toBe(1)
  })

  it("某一类型切到「整图」→ 那一半传 'whole'（不是 undefined，也不是跳过）", async () => {
    const { wrapper, calls } = await mountEditor()
    await wrapper.find('[data-mode="portrait-whole"]').trigger('click')
    await wrapper.find('.confirm-btn').trigger('click')
    await flushPromises()

    const crops = (calls()[0] as unknown[])[2] as PortraitCropPlan
    expect(crops.portrait).toBe('whole')
    expect(crops.avatar).toEqual({ x: 50, y: 0, w: 300, h: 300 })
  })

  it("🔴 某一类型切到「不生成」→ 那一半传 'skip'，另一半照常给框", async () => {
    const { wrapper, calls } = await mountEditor()
    await wrapper.find('[data-mode="avatar-skip"]').trigger('click')
    await wrapper.find('.confirm-btn').trigger('click')
    await flushPromises()

    const crops = (calls()[0] as unknown[])[2] as PortraitCropPlan
    expect(crops.avatar).toBe('skip')
    expect(crops.portrait).toEqual({ x: 0, y: 0, w: 400, h: 900 })
  })

  it('三态开关: 每个类型恰好三个按钮，且选中态互斥', async () => {
    const { wrapper } = await mountEditor()
    for (const which of ['portrait', 'avatar'] as const) {
      const btns = wrapper.findAll(`[data-mode^="${which}-"]`)
      expect(btns.map((b) => b.text())).toEqual(['裁剪', '整图', '不生成'])
      expect(btns.filter((b) => b.attributes('aria-pressed') === 'true')).toHaveLength(1)
    }
    await wrapper.find('[data-mode="portrait-skip"]').trigger('click')
    const after = wrapper.findAll('[data-mode^="portrait-"]')
    expect(after.filter((b) => b.attributes('aria-pressed') === 'true')).toHaveLength(1)
    expect(wrapper.find('[data-mode="portrait-skip"]').attributes('aria-pressed')).toBe('true')
  })

  it('两个都选「不生成」→ 确认按钮禁用，不把必然失败的 no-crops 发出去', async () => {
    const { wrapper, vm, calls } = await mountEditor()
    await wrapper.find('[data-mode="portrait-skip"]').trigger('click')
    await wrapper.find('[data-mode="avatar-skip"]').trigger('click')

    expect(vm.canConfirm).toBe(false)
    expect(wrapper.find('.confirm-btn').attributes('disabled')).toBeDefined()
    await wrapper.find('.confirm-btn').trigger('click')
    await flushPromises()
    expect(calls().length).toBe(0)
  })

  it("两个都选「整图」不再是错误 —— 按钮可用，两半都传 'whole'", async () => {
    const { wrapper, vm, calls } = await mountEditor()
    await wrapper.find('[data-mode="portrait-whole"]').trigger('click')
    await wrapper.find('[data-mode="avatar-whole"]').trigger('click')

    expect(vm.canConfirm).toBe(true)
    await wrapper.find('.confirm-btn').trigger('click')
    await flushPromises()
    expect(calls()[0][2]).toEqual({ portrait: 'whole', avatar: 'whole' })
  })

  it('部分成功如实报: 不当成功、不关窗、说清哪一张留下了', async () => {
    const { wrapper, vm, resolveWith } = await mountEditor()
    resolveWith({ outcome: 'failed', portraitId: 'p1' })
    await wrapper.find('.confirm-btn').trigger('click')
    await flushPromises()

    expect(vm.problem).toContain('部分成功')
    expect(vm.problem).toContain('立绘')
    expect(vm.problem).toContain('不会撤回')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.text()).toContain('部分成功')
  })

  it('全失败时只报理由，不出现「部分成功」的措辞', async () => {
    const { wrapper, vm, resolveWith } = await mountEditor()
    resolveWith({ outcome: 'busy' })
    await wrapper.find('.confirm-btn').trigger('click')
    await flushPromises()

    expect(vm.problem).not.toContain('部分成功')
    expect(vm.problem).toContain('另一次导入正在进行')
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════
// 抽屉入口
// ═══════════════════════════════════════════════════════════

describe('AssetCharacterDrawer 的裁剪入口', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('图片行给裁剪按钮，mp4 行的按钮禁用并说明原因', async () => {
    const store = useAssetStore()
    await store.refreshAssets()

    const wrapper = mount(AssetCharacterDrawer, {
      props: { name: '苏婉' },
      global: {
        stubs: { teleport: true },
        provide: {
          [assetDialogsKey as unknown as symbol]: {
            askConfirm: async () => false,
            askPrompt: async () => null,
          },
        },
      },
    })
    await flushPromises()

    const png = wrapper.find('[data-crop-action="a-png"]')
    const mp4 = wrapper.find('[data-crop-action="a-mp4"]')
    expect(png.exists()).toBe(true)
    expect(png.attributes('disabled')).toBeUndefined()
    expect(mp4.exists()).toBe(true)
    expect(mp4.attributes('disabled')).toBeDefined()
    expect(mp4.attributes('aria-label')).toContain('视频')
    expect(mp4.attributes('title')).toContain('一帧')
  })
})
