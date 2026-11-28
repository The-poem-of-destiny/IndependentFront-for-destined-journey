import { describe, expect, it } from 'vitest';
import {
  deriveOnboardingSteps,
  onboardingEntryLabel,
  resolveOnboardingPanel,
  type OnboardingInput,
  type OnboardingStep,
  type OnboardingStepId,
} from '../../../src/ui/lib/onboarding';

const llm = {
  id: 'chat',
  name: 'Local',
  baseUrl: 'http://localhost:1234/v1',
  model: 'local-model',
  apiType: 'chat',
};

const embedding = {
  id: 'emb',
  name: 'Emb',
  baseUrl: 'https://emb.example.com/v1',
  model: 'emb-model',
  apiType: 'embedding',
  kind: 'embedding',
};

/** 全部已加载、什么都没做的新玩家 */
const fresh: OnboardingInput = {
  contentLoaded: true,
  contentStatus: 'placeholder',
  activePackId: null,
  apiLoaded: true,
  apiPool: [],
  savesLoaded: true,
  saveCount: 0,
};

/** 三步全做完 */
const complete: OnboardingInput = {
  ...fresh,
  contentStatus: 'pack',
  activePackId: 'fated-poem',
  apiPool: [llm],
  saveCount: 2,
};

function step(input: OnboardingInput, id: OnboardingStepId): OnboardingStep {
  const found = deriveOnboardingSteps(input).steps.find((s) => s.id === id);
  if (!found) throw new Error(`缺步骤 ${id}`);
  return found;
}

describe('deriveOnboardingSteps', () => {
  it('顺序固定为 内容包 → API → 存档，必需性与角标对齐 README', () => {
    const model = deriveOnboardingSteps(fresh);
    expect(model.steps.map((s) => [s.id, s.index, s.required, s.badge])).toEqual([
      ['content', 1, false, '建议'],
      ['api', 2, true, '必须'],
      ['save', 3, true, '必须'],
    ]);
    expect(model.total).toBe(3);
  });

  describe('内容包步', () => {
    it.each([
      ['未装包（占位内容）', { contentStatus: 'placeholder', activePackId: null }, 'todo'],
      ['已装包且有 id', { contentStatus: 'pack', activePackId: 'p1' }, 'done'],
      ['状态为 pack 但没有 id', { contentStatus: 'pack', activePackId: null }, 'todo'],
      ['状态为 pack 但 id 为空串', { contentStatus: 'pack', activePackId: '' }, 'todo'],
      ['需要处理', { contentStatus: 'needs_attention', activePackId: 'p1' }, 'attention'],
      ['载入出错', { contentStatus: 'error', activePackId: null }, 'attention'],
      [
        '受保护包授权锁定（占位态但保留 id）',
        { contentStatus: 'placeholder', activePackId: 'p1' },
        'attention',
      ],
    ] as const)('%s → %s', (_label, patch, expected) => {
      expect(step({ ...fresh, ...patch }, 'content').status).toBe(expected);
    });

    it('未加载完时为 unknown', () => {
      expect(step({ ...complete, contentLoaded: false }, 'content').status).toBe('unknown');
    });

    it('内容包不是必需步：只差它时 requiredDone 为真、allDone 为假', () => {
      const model = deriveOnboardingSteps({
        ...complete,
        contentStatus: 'placeholder',
        activePackId: null,
      });
      expect(model.requiredDone).toBe(true);
      expect(model.allDone).toBe(false);
    });

    it('授权锁定时提示重新登录或检查更新，不说只有占位内容', () => {
      const locked = step(
        { ...fresh, contentStatus: 'placeholder', activePackId: 'p1' },
        'content',
      );
      expect(locked.hint).toContain('授权');
      expect(locked.hint).toContain('设置 → 内容包');
      expect(locked.hint).toContain('重新登录');
      expect(locked.hint).not.toContain('演示级占位内容');
    });

    it('todo 文案提到 README 里的两条入口', () => {
      const hint = step(fresh, 'content').hint;
      expect(hint).toContain('导入 / 升级内容包');
      expect(hint).toContain('登录 Discord');
    });
  });

  describe('API 步', () => {
    it.each([
      ['空池', [], 'todo'],
      ['一个可用的文字 LLM 源（无 Key 也行）', [llm], 'done'],
      ['https 地址', [{ ...llm, baseUrl: 'https://api.example.com/v1' }], 'done'],
      ['旧条目无 kind 也无 apiType 按 LLM 处理', [{ ...llm, apiType: undefined }], 'done'],
      ['缺模型', [{ ...llm, model: '' }], 'attention'],
      ['模型只有空白', [{ ...llm, model: '   ' }], 'attention'],
      ['缺地址', [{ ...llm, baseUrl: '' }], 'attention'],
      ['地址不是 http(s)', [{ ...llm, baseUrl: 'ftp://example.com' }], 'attention'],
      ['地址不是 URL', [{ ...llm, baseUrl: 'localhost:1234' }], 'attention'],
      ['只有 Embedding 源', [embedding], 'todo'],
      ['只有出图源', [{ ...llm, apiType: 'image' }], 'todo'],
      [
        '一坏一好，有可用的就算完成',
        [
          { ...llm, model: '' },
          { ...llm, id: 'b' },
        ],
        'done',
      ],
    ] as const)('%s → %s', (_label, pool, expected) => {
      expect(step({ ...fresh, apiPool: pool }, 'api').status).toBe(expected);
    });

    it('未加载完时为 unknown，副项也为 unknown', () => {
      const api = step({ ...complete, apiLoaded: false }, 'api');
      expect(api.status).toBe('unknown');
      expect(api.sub?.status).toBe('unknown');
    });

    it.each([
      ['无 Embedding 源', [llm], 'todo'],
      ['有 Embedding 源', [llm, embedding], 'done'],
      ['Embedding 源地址无效', [llm, { ...embedding, baseUrl: '' }], 'todo'],
    ] as const)('Embedding 副项：%s → %s', (_label, pool, expected) => {
      const sub = step({ ...fresh, apiPool: pool }, 'api').sub;
      expect(sub?.status).toBe(expected);
      expect(sub?.hint).toContain('可选');
    });

    it('Embedding 副项不影响 API 步本身', () => {
      expect(step({ ...fresh, apiPool: [embedding] }, 'api').status).toBe('todo');
      expect(step({ ...fresh, apiPool: [llm] }, 'api').status).toBe('done');
    });

    it('坏形状的池条目不抛', () => {
      expect(() => deriveOnboardingSteps({ ...fresh, apiPool: [null, 1, 'x', {}] })).not.toThrow();
    });
  });

  describe('存档步', () => {
    it.each([
      [0, 'todo'],
      [1, 'done'],
      [5, 'done'],
    ] as const)('存档数 %d → %s', (count, expected) => {
      expect(step({ ...fresh, saveCount: count }, 'save').status).toBe(expected);
    });

    it('未加载完时为 unknown', () => {
      expect(step({ ...complete, savesLoaded: false }, 'save').status).toBe('unknown');
    });

    it('todo 文案提到「启程前的准备」', () => {
      expect(step(fresh, 'save').hint).toContain('启程前的准备');
    });
  });

  it('全部完成时 requiredDone / allDone 为真、doneCount 为 3', () => {
    const model = deriveOnboardingSteps(complete);
    expect(model).toMatchObject({
      requiredDone: true,
      allDone: true,
      loading: false,
      doneCount: 3,
    });
  });

  it('任一步加载中时 loading 为真，unknown 不计入完成', () => {
    const model = deriveOnboardingSteps({ ...complete, savesLoaded: false });
    expect(model.loading).toBe(true);
    expect(model.requiredDone).toBe(false);
    expect(model.doneCount).toBe(2);
  });

  it('收起态入口文案为「开始前的三步 · n/3」', () => {
    expect(onboardingEntryLabel(deriveOnboardingSteps(fresh))).toBe('开始前的三步 · 0/3');
    expect(onboardingEntryLabel(deriveOnboardingSteps({ ...fresh, apiPool: [llm] }))).toBe(
      '开始前的三步 · 1/3',
    );
  });
});

describe('resolveOnboardingPanel', () => {
  const freshModel = deriveOnboardingSteps(fresh);
  const requiredOnly = deriveOnboardingSteps({
    ...complete,
    contentStatus: 'placeholder',
    activePackId: null,
  });
  const completeModel = deriveOnboardingSteps(complete);
  const loadingModel = deriveOnboardingSteps({ ...fresh, apiLoaded: false });

  it.each([
    ['新玩家自动展开', freshModel, false, null, 'expanded'],
    ['必需步全满足自动收起', requiredOnly, false, null, 'collapsed'],
    ['三步全完成隐藏入口', completeModel, false, null, 'hidden'],
    ['三步全完成时手动打开也隐藏', completeModel, false, true, 'hidden'],
    ['加载中不展开（不闪现）', loadingModel, false, null, 'hidden'],
    ['加载中手动打开也不展开', loadingModel, false, true, 'hidden'],
    ['不再显示 → 只留收起入口', freshModel, true, null, 'collapsed'],
    ['不再显示后手动重开', freshModel, true, true, 'expanded'],
    ['手动关闭', freshModel, false, false, 'collapsed'],
    ['自动收起后手动重开', requiredOnly, false, true, 'expanded'],
  ] as const)('%s', (_label, model, dismissed, manualOpen, expected) => {
    expect(resolveOnboardingPanel({ model, dismissed, manualOpen })).toBe(expected);
  });

  it('manualOpen 省略时按自动规则', () => {
    expect(resolveOnboardingPanel({ model: freshModel, dismissed: false })).toBe('expanded');
  });
});
