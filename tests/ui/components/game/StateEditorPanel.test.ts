/**
 * StateEditorPanel — 变量修改器界面（状态树协议 T11，设计 §11）
 *
 * 打开即从库新读；只读键置灰带锁；生成中整面只读；改 HP → 预览变更 → 确认提交；
 * 提交后回读；撤销上一次修改；页脚写明回退会丢本轮之后的手改。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { makeInput } from '../../../core/variables/state-tree-fixture';
import StateEditorPanel from '../../../../src/ui/components/game/StateEditorPanel.vue';

const toast = vi.fn();

function makeGame() {
  const input = makeInput();
  return reactive({
    messages: [] as { role: string; turn?: number }[],
    isGenerating: false,
    isRewriting: false,
    isInCombat: false,
    stateEditUndoStack: [] as { label: string; undo: unknown }[],
    stateEditorFocusPath: null as string | null,
    consumeStateEditorFocus: vi.fn((): string | null => {
      const path = game.stateEditorFocusPath;
      game.stateEditorFocusPath = null;
      return path;
    }),
    readStateEditorSnapshot: vi.fn(async () => ({
      characters: input.characters,
      profile: input.profile,
    })),
    commitStateEdit: vi.fn(async (_ops: unknown[], label: string) => {
      game.stateEditUndoStack.push({
        label,
        undo: { saveId: 's', characters: {}, fingerprint: '{}' },
      });
      return { ok: true, records: [], normalized: [], undo: {} };
    }),
    undoLastStateEdit: vi.fn(async () => {
      game.stateEditUndoStack.pop();
      return { ok: true };
    }),
  });
}

let game: ReturnType<typeof makeGame>;

vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => game,
}));
vi.mock('../../../../src/ui/stores/ui-store', () => ({
  useUIStore: () => ({ toast }),
}));

async function mountPanel() {
  const wrapper = mount(StateEditorPanel);
  await flushPromises();
  return wrapper;
}

function fieldEl(wrapper: ReturnType<typeof mount>, path: string) {
  return wrapper.get(`.se-field[data-path="${path}"]`);
}

beforeEach(() => {
  game = makeGame();
  toast.mockReset();
});

describe('StateEditorPanel', () => {
  it('从更新块跳过来：定位到持有该路径的节点并高亮那一格，定位只生效一次（T13）', async () => {
    game.stateEditorFocusPath = '/主角/生命值/当前';
    const wrapper = await mountPanel();
    expect(game.consumeStateEditorFocus).toHaveBeenCalledTimes(1);
    expect(fieldEl(wrapper, '/主角/生命值/当前').classes()).toContain('is-focused');
    expect(game.stateEditorFocusPath).toBeNull();
  });

  it('打开时从库读一次快照，默认选中主角', async () => {
    const wrapper = await mountPanel();
    expect(game.readStateEditorSnapshot).toHaveBeenCalledTimes(1);
    expect(wrapper.get('.se-node-name').text()).toBe('主角');
    const labels = wrapper.findAll('.se-row-name').map((b) => b.text());
    expect(labels).toEqual(
      expect.arrayContaining(['世界', '主角', '关系列表', '任务列表', '变量']),
    );
  });

  it('只读键可见、置灰、带锁与「由代码维护」，没有输入框', async () => {
    const wrapper = await mountPanel();
    await wrapper.get('.se-row-label[data-path="/主角/成长"]').trigger('click');
    const tier = fieldEl(wrapper, '/主角/成长/_生命层级');
    expect(tier.classes()).toContain('is-readonly');
    expect(tier.find('.fa-lock').exists()).toBe(true);
    expect(tier.text()).toContain('由代码维护');
    expect(tier.find('input').exists()).toBe(false);
    // 主角等级只读
    expect(fieldEl(wrapper, '/主角/成长/等级').find('input').exists()).toBe(false);
    // 累计经验值可改
    expect(fieldEl(wrapper, '/主角/成长/累计经验值').find('input').exists()).toBe(true);
  });

  it('时间只读', async () => {
    const wrapper = await mountPanel();
    await wrapper.get('.se-row-label[data-path="/世界"]').trigger('click');
    const time = fieldEl(wrapper, '/世界/时间');
    expect(time.find('input').exists()).toBe(false);
    expect(time.text()).toContain('时间只读');
  });

  it('改 HP → 预览变更（前值 → 后值）→ 确认提交 → 回读', async () => {
    const wrapper = await mountPanel();
    await wrapper.get('.se-row-label[data-path="/主角/生命值"]').trigger('click');
    await fieldEl(wrapper, '/主角/生命值/当前').get('input').setValue('120');
    expect(wrapper.get('.se-dirty-count').text()).toContain('1 项');

    await wrapper.get('[data-testid="state-editor-preview"]').trigger('click');
    const panel = wrapper.get('[data-testid="state-editor-preview-panel"]');
    expect(panel.text()).toContain('/主角/生命值/当前');
    expect(panel.get('.se-before').text()).toBe('300');
    expect(panel.get('.se-after').text()).toBe('120');

    await wrapper.get('[data-testid="state-editor-confirm"]').trigger('click');
    await flushPromises();
    expect(game.commitStateEdit).toHaveBeenCalledWith(
      [{ op: 'replace', path: '/主角/生命值/当前', value: 120 }],
      '修改 /主角/生命值/当前',
    );
    expect(game.readStateEditorSnapshot).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="state-editor-preview-panel"]').exists()).toBe(false);
    expect(toast).toHaveBeenCalledWith('修改已提交', 'success');
  });

  it('删除 NPC 也先走「将要发生的变更」，确认后才提交', async () => {
    const wrapper = await mountPanel();
    await wrapper.get('.se-row-label[data-path="/关系列表"]').trigger('click');
    await wrapper.get('.se-row-label[data-path="/关系列表/布兰"]').trigger('click');
    await wrapper.get('[data-testid="state-editor-remove"]').trigger('click');
    const panel = wrapper.get('[data-testid="state-editor-preview-panel"]');
    expect(panel.text()).toContain('删除');
    expect(panel.text()).toContain('/关系列表/布兰');
    expect(game.commitStateEdit).not.toHaveBeenCalled();
    expect(
      wrapper.get('[data-testid="state-editor-confirm"]').attributes('disabled'),
    ).toBeUndefined();
  });

  it('新增条目重名时拦在预览之前并说明', async () => {
    const wrapper = await mountPanel();
    await wrapper.get('.se-row-label[data-path="/主角/背包"]').trigger('click');
    await wrapper.findAll('.se-node-actions button')[0].trigger('click');
    await wrapper.get('.se-structural input').setValue('绳子');
    expect(wrapper.get('.se-inline-error').text()).toContain('已经有');
    await wrapper.get('.se-structural').trigger('submit');
    expect(wrapper.find('[data-testid="state-editor-preview-panel"]').exists()).toBe(false);
  });

  it('提交失败时把原因显示出来', async () => {
    game.commitStateEdit.mockImplementationOnce(
      async () =>
        ({
          ok: false,
          reasons: ['提交失败：库忙'],
          records: [],
          dropped: [],
        }) as never,
    );
    const wrapper = await mountPanel();
    await wrapper.get('.se-row-label[data-path="/主角/生命值"]').trigger('click');
    await fieldEl(wrapper, '/主角/生命值/当前').get('input').setValue('120');
    await wrapper.get('[data-testid="state-editor-preview"]').trigger('click');
    await wrapper.get('[data-testid="state-editor-confirm"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="state-editor-reasons"]').text()).toContain('库忙');
  });

  it('生成中整面只读并说明原因', async () => {
    game.isGenerating = true;
    const wrapper = await mountPanel();
    expect(wrapper.get('[data-testid="state-editor-lock"]').text()).toContain('生成中');
    await wrapper.get('.se-row-label[data-path="/主角/生命值"]').trigger('click');
    expect(fieldEl(wrapper, '/主角/生命值/当前').get('input').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="state-editor-undo"]').attributes('disabled')).toBeDefined();
  });

  it('撤销上一次修改走 store，页脚写明回退会丢本轮之后的手改', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.get('.se-foot').text()).toContain('回退本轮会连同本轮之后的手改一起丢');
    expect(wrapper.get('[data-testid="state-editor-undo"]').attributes('disabled')).toBeDefined();
    game.stateEditUndoStack.push({
      label: '修改 /主角/金钱',
      undo: { saveId: 's', characters: {}, fingerprint: '{}' },
    });
    await flushPromises();
    expect(wrapper.get('.se-foot').text()).toContain('上一次：修改 /主角/金钱');
    await wrapper.get('[data-testid="state-editor-undo"]').trigger('click');
    await flushPromises();
    expect(game.undoLastStateEdit).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('已撤销上一次修改', 'success');
  });

  it('搜索按名字过滤树', async () => {
    const wrapper = await mountPanel();
    await wrapper.get('.se-search input').setValue('药水');
    const paths = wrapper.findAll('.se-row-label').map((b) => b.attributes('data-path'));
    expect(paths).toContain('/主角/背包/治疗药水');
    expect(paths).not.toContain('/关系列表');
  });

  it('不使用 v-html', async () => {
    const { default: src } =
      await import('../../../../src/ui/components/game/StateEditorPanel.vue?raw');
    expect(src).not.toMatch(/\sv-html=/);
  });
});
