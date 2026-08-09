/**
 * comfyui.test.ts — 占位符替换与 ComfyUI 响应解析的行为固定（图像 v2 / T3）
 *
 * 🔴 本文件里最要紧的两组:
 * 1. **替换是值级的**（C11）—— 提示词里的引号 / 反斜杠 / 花括号一个都不该打断 JSON，
 *    而「整值占位符保类型」是 seed/steps 不被 ComfyUI 判成类型不匹配的全部依据。
 * 2. **`node_errors` 能带着 HTTP 200 回来**（C12）—— 只看状态码的分类器会把它当排队成功，
 *    然后去轮询一个永远不会出现的 prompt_id，600 秒后报成超时。
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_COMFY_WORKFLOW,
  COMFY_FAILURE_MESSAGES,
  comfyFail,
  isComfyPromptRunning,
  parseComfyHistory,
  parseComfyQueueResponse,
  parseComfyWorkflow,
  substituteWorkflow,
  type ComfyGraph,
  type ComfySubstitutionValues,
} from './comfyui';

const SEED_FALLBACK = 4242;

function values(overrides: Partial<ComfySubstitutionValues> = {}): ComfySubstitutionValues {
  return {
    positive: 'tavern interior, 1girl',
    negative: 'lowres, bad anatomy',
    width: 1216,
    height: 832,
    steps: 23,
    scale: 4.5,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// parseComfyWorkflow
// ═══════════════════════════════════════════════════════════

describe('parseComfyWorkflow', () => {
  it('正常的 API-format 图解析成功', () => {
    const result = parseComfyWorkflow('{"3":{"class_type":"KSampler","inputs":{}}}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.graph)).toEqual(['3']);
  });

  it('解不开的 JSON → workflow 失败（不可重试），文案里带上真因', () => {
    const result = parseComfyWorkflow('{"3": ');
    expect(result).toMatchObject({ ok: false, kind: 'workflow', retryable: false });
    if (result.ok) return;
    // 「不是合法的 JSON」这句必须出现在**给用户看的** message 里，不能只躺在 detail
    expect(result.message).toContain('JSON');
  });

  it('顶层是数组 / 空串 / 空对象都归 workflow —— 再发一次不会变好', () => {
    for (const bad of ['[]', '   ', '{}', '"a string"']) {
      expect(parseComfyWorkflow(bad)).toMatchObject({ ok: false, kind: 'workflow' });
    }
  });
});

// ═══════════════════════════════════════════════════════════
// substituteWorkflow —— 值级替换
// ═══════════════════════════════════════════════════════════

describe('substituteWorkflow：值级替换（C11）', () => {
  it('整值占位符保留类型：seed/steps/width/height/scale 出来仍是数字', () => {
    const graph: ComfyGraph = {
      '3': {
        inputs: { seed: '%seed%', steps: '%steps%', cfg: '%scale%' },
      },
      '5': { inputs: { width: '%width%', height: '%height%' } },
    };

    const out = substituteWorkflow(graph, values({ seed: 7 }), SEED_FALLBACK) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;

    expect(out['3'].inputs).toEqual({ seed: 7, steps: 23, cfg: 4.5 });
    expect(out['5'].inputs).toEqual({ width: 1216, height: 832 });
    // 字符串形态会让 ComfyUI 回一条 node_errors —— 这条断言就是那个坑的防线
    expect(typeof out['3'].inputs.seed).toBe('number');
  });

  it('字符串内嵌占位符做拼接，数字退化成字符串形态', () => {
    const graph: ComfyGraph = {
      '6': { inputs: { text: 'masterpiece, %positive%, %steps% steps' } },
    };
    const out = substituteWorkflow(graph, values(), SEED_FALLBACK) as Record<
      string,
      { inputs: { text: string } }
    >;
    expect(out['6'].inputs.text).toBe('masterpiece, tavern interior, 1girl, 23 steps');
  });

  it('🔴 提示词里的引号 / 反斜杠 / 花括号原样进值，不打断任何东西', () => {
    // 这段串放进「原文字符串替换」的实现里会当场把 JSON 撕开 —— 那正是 C11 的理由
    const nasty = 'a "quoted" girl, back\\slash, {braces}, 100% sure, <lora:x:1>';
    const graph: ComfyGraph = { '6': { inputs: { text: '%positive%' } } };

    const out = substituteWorkflow(graph, values({ positive: nasty }), SEED_FALLBACK) as Record<
      string,
      { inputs: { text: string } }
    >;

    expect(out['6'].inputs.text).toBe(nasty);
    // 再往返一次 JSON 也不失真（真正发出去的那一步就是这么做的）
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it('ST 习惯别名 %prompt% / %negative_prompt% 与正名等价', () => {
    const graph: ComfyGraph = {
      a: { text: '%prompt%' },
      b: { text: '%negative_prompt%' },
      c: { text: '%positive%' },
      d: { text: '%negative%' },
    };
    const out = substituteWorkflow(graph, values(), SEED_FALLBACK) as Record<
      string,
      { text: string }
    >;
    expect(out.a.text).toBe(out.c.text);
    expect(out.b.text).toBe(out.d.text);
    expect(out.a.text).toBe('tavern interior, 1girl');
  });

  it('%characterN% 按序取；越界的槽变成空串而不是留下字面量', () => {
    const graph: ComfyGraph = {
      a: { text: '%character1%' },
      b: { text: '%character2%' },
      c: { text: '%character3%' },
    };
    const out = substituteWorkflow(
      graph,
      values({ characters: ['red hair, knight', 'blue eyes, mage'] }),
      SEED_FALLBACK,
    ) as Record<string, { text: string }>;

    expect(out.a.text).toBe('red hair, knight');
    expect(out.b.text).toBe('blue eyes, mage');
    // 留着 `%character3%` 会让这七个字符原封不动进提示词，在画面上变成噪声
    expect(out.c.text).toBe('');
  });

  it('图里没引用到的角色不是错误（C7 的压平已经在装配层做过了）', () => {
    const graph: ComfyGraph = { a: { text: '%character1%' } };
    const out = substituteWorkflow(
      graph,
      values({ characters: ['one', 'two', 'three'] }),
      SEED_FALLBACK,
    ) as Record<string, { text: string }>;
    expect(out.a.text).toBe('one');
  });

  it('认不出的 %foo% 原样保留，不报错 —— 社区图里满是自定义约定', () => {
    const graph: ComfyGraph = {
      a: { text: '%foo% and %positive% and %bar_baz%' },
      b: { text: '%character0%' },
      c: { text: '%unknown%' },
    };
    const out = substituteWorkflow(graph, values(), SEED_FALLBACK) as Record<
      string,
      { text: string }
    >;
    expect(out.a.text).toBe('%foo% and tavern interior, 1girl and %bar_baz%');
    expect(out.b.text).toBe('%character0%');
    // 整值形态的未知 token 同样原样留着（类型不变）
    expect(out.c.text).toBe('%unknown%');
  });

  it('深走对象与数组，节点连线（["4", 0]）原样搬运', () => {
    const graph: ComfyGraph = {
      '3': { inputs: { model: ['4', 0], nested: [{ deep: ['%steps%', '%positive%'] }] } },
    };
    const out = substituteWorkflow(graph, values(), SEED_FALLBACK) as Record<
      string,
      { inputs: { model: unknown[]; nested: Array<{ deep: unknown[] }> } }
    >;
    expect(out['3'].inputs.model).toEqual(['4', 0]);
    expect(out['3'].inputs.nested[0].deep).toEqual([23, 'tavern interior, 1girl']);
  });

  it('🔴 不修改入参：同一份图能反复用（BUILTIN 是模块级常量）', () => {
    const before = JSON.stringify(BUILTIN_COMFY_WORKFLOW);
    const out = substituteWorkflow(BUILTIN_COMFY_WORKFLOW, values({ seed: 1 }), SEED_FALLBACK);
    expect(JSON.stringify(BUILTIN_COMFY_WORKFLOW)).toBe(before);
    expect(out).not.toBe(BUILTIN_COMFY_WORKFLOW);
  });

  it('🔴 本层不产随机：seed 缺省时用调用方给的 seedFallback，两次调用逐字节相同', () => {
    const graph: ComfyGraph = { '3': { inputs: { seed: '%seed%' } } };
    const a = substituteWorkflow(graph, values(), SEED_FALLBACK);
    const b = substituteWorkflow(graph, values(), SEED_FALLBACK);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toMatchObject({ '3': { inputs: { seed: SEED_FALLBACK } } });
    // 有 seed 时 fallback 不参与
    expect(substituteWorkflow(graph, values({ seed: 9 }), SEED_FALLBACK)).toMatchObject({
      '3': { inputs: { seed: 9 } },
    });
  });

  it('BUILTIN 替换后每个占位符都消失了（内置图没有拼错的 token）', () => {
    const out = JSON.stringify(
      substituteWorkflow(BUILTIN_COMFY_WORKFLOW, values({ seed: 1 }), SEED_FALLBACK),
    );
    expect(out).not.toMatch(/%[A-Za-z_][A-Za-z0-9_]*%/);
  });
});

// ═══════════════════════════════════════════════════════════
// parseComfyQueueResponse
// ═══════════════════════════════════════════════════════════

describe('parseComfyQueueResponse', () => {
  it('正常排队 → ok + promptId', () => {
    const result = parseComfyQueueResponse(200, { prompt_id: 'abc-123', number: 1 });
    expect(result).toEqual({ ok: true, promptId: 'abc-123' });
  });

  it('🔴 HTTP 200 + 非空 node_errors → workflow 失败（不可重试），文案点名节点 id', () => {
    const result = parseComfyQueueResponse(200, {
      prompt_id: 'abc-123',
      node_errors: {
        '4': {
          class_type: 'CheckpointLoaderSimple',
          errors: [
            {
              type: 'value_not_in_list',
              message: 'Value not in list',
              details: "ckpt_name: 'sd_xl_base_1.0.safetensors' not in []",
            },
          ],
        },
      },
    });

    expect(result).toMatchObject({ ok: false, kind: 'workflow', retryable: false });
    if (result.ok) return;
    expect(result.message).toContain('节点 4');
    expect(result.message).toContain('Value not in list');
    // prompt_id 在这条响应里是有的 —— 只看状态码或只看 prompt_id 都会误判成成功
    expect(result.message).not.toContain('abc-123');
  });

  it('多个节点出错时 id 全列出来', () => {
    const result = parseComfyQueueResponse(200, {
      node_errors: { '4': {}, '11': {} },
    });
    expect(result).toMatchObject({ ok: false, kind: 'workflow' });
    if (result.ok) return;
    expect(result.message).toContain('4');
    expect(result.message).toContain('11');
  });

  it('空 node_errors（`{}`）不算错 —— ComfyUI 成功时也会带这个字段', () => {
    expect(parseComfyQueueResponse(200, { prompt_id: 'x', node_errors: {} })).toEqual({
      ok: true,
      promptId: 'x',
    });
  });

  it('400 + node_errors 同样归 workflow，且点名的那句话进得了文案', () => {
    const result = parseComfyQueueResponse(400, {
      error: { type: 'prompt_outputs_failed_validation' },
      node_errors: { '9': { errors: [{ message: 'Required input is missing' }] } },
    });
    expect(result).toMatchObject({ ok: false, kind: 'workflow', retryable: false });
    if (result.ok) return;
    expect(result.message).toContain('节点 9');
    expect(result.message).toContain('Required input is missing');
  });

  it('🔴 整份提示词被拒: error 是**对象**、node_errors 是空的 —— 原因照样要冒出来', () => {
    const result = parseComfyQueueResponse(400, {
      error: {
        type: 'prompt_no_outputs',
        message: 'Prompt has no outputs',
        details: '',
        extra_info: {},
      },
      node_errors: {},
    });

    expect(result).toMatchObject({ ok: false, kind: 'workflow', retryable: false });
    if (result.ok) return;
    // 只认字符串形态时，这里曾是光秃秃的「工作流被 ComfyUI 拒绝了」+「HTTP 400」
    expect(result.message).toContain('Prompt has no outputs');
    expect(result.message).toContain('prompt_no_outputs');
    expect(result.detail).toContain('Prompt has no outputs');
  });

  it('对象 error 的 details 也带上；只有 type 时 type 自己就是那句话', () => {
    const withDetails = parseComfyQueueResponse(400, {
      error: { type: 'invalid_prompt', message: 'Cannot execute', details: 'missing node 7' },
    });
    if (withDetails.ok) throw new Error('unreachable');
    expect(withDetails.message).toContain('missing node 7');

    const typeOnly = parseComfyQueueResponse(500, { error: { type: 'internal_boom' } });
    if (typeOnly.ok) throw new Error('unreachable');
    expect(typeOnly.kind).toBe('upstream');
    expect(typeOnly.detail).toContain('internal_boom');
  });

  it('字符串形态的 error 一如既往（这次改动不许动它）', () => {
    const result = parseComfyQueueResponse(400, { error: 'bad prompt' });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('bad prompt');
  });

  it('状态码分类说的是 ComfyUI 的话，不是 NovelAI 的', () => {
    expect(parseComfyQueueResponse(500, {})).toMatchObject({ ok: false, kind: 'upstream' });
    expect(parseComfyQueueResponse(429, {})).toMatchObject({ ok: false, kind: 'rate-limit' });
    expect(parseComfyQueueResponse(404, {})).toMatchObject({ ok: false, kind: 'bad-request' });
    expect(parseComfyQueueResponse(400, {})).toMatchObject({ ok: false, kind: 'workflow' });
    expect(parseComfyQueueResponse(403, {})).toMatchObject({ ok: false, kind: 'bad-request' });

    for (const status of [400, 403, 404, 429, 500]) {
      const result = parseComfyQueueResponse(status, {});
      if (result.ok) throw new Error('unreachable');
      expect(result.message).not.toMatch(/NovelAI|Anlas/);
    }
  });

  it('2xx 但没有 prompt_id → bad-response（不是「成功」）', () => {
    expect(parseComfyQueueResponse(200, { number: 1 })).toMatchObject({
      ok: false,
      kind: 'bad-response',
    });
    expect(parseComfyQueueResponse(200, undefined)).toMatchObject({
      ok: false,
      kind: 'bad-response',
    });
  });
});

// ═══════════════════════════════════════════════════════════
// parseComfyHistory
// ═══════════════════════════════════════════════════════════

describe('parseComfyHistory', () => {
  it('空对象 = 还在跑，不是错误', () => {
    expect(parseComfyHistory({}, 'p1')).toEqual({ state: 'pending' });
  });

  it('🔴 显式的 completed:false 压过乐观的 status_str —— 这一步去取字节会取到空', () => {
    const body = {
      p1: { status: { status_str: 'success', completed: false }, outputs: {} },
    };
    expect(parseComfyHistory(body, 'p1')).toEqual({ state: 'pending' });
  });

  it('completed 字段缺席时 status_str=success 兜底 —— 否则那些图会轮询到超时', () => {
    const body = {
      p1: {
        status: { status_str: 'success' },
        outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } },
      },
    };
    expect(parseComfyHistory(body, 'p1')).toMatchObject({ state: 'done' });
  });

  it('跑完了 → done + 扁平的图片清单（多节点多图按顺序）', () => {
    const body = {
      p1: {
        status: { status_str: 'success', completed: true, messages: [] },
        outputs: {
          '9': {
            images: [
              { filename: 'fated_poem_00001_.png', subfolder: '', type: 'output' },
              { filename: 'fated_poem_00002_.png', subfolder: 'sub', type: 'output' },
            ],
          },
          '10': { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
        },
      },
    };

    const state = parseComfyHistory(body, 'p1');
    expect(state.state).toBe('done');
    if (state.state !== 'done') return;
    expect(state.images).toEqual([
      { filename: 'fated_poem_00001_.png', subfolder: '', type: 'output' },
      { filename: 'fated_poem_00002_.png', subfolder: 'sub', type: 'output' },
      { filename: 'preview.png', subfolder: '', type: 'temp' },
    ]);
  });

  it('status_str=error → execution 失败（🔴 可重试，与 workflow 相反），带节点与异常', () => {
    const body = {
      p1: {
        status: {
          status_str: 'error',
          completed: false,
          messages: [
            ['execution_start', { prompt_id: 'p1' }],
            [
              'execution_error',
              {
                node_id: '3',
                node_type: 'KSampler',
                exception_type: 'torch.cuda.OutOfMemoryError',
                exception_message: 'CUDA out of memory',
              },
            ],
          ],
        },
        outputs: {},
      },
    };

    const state = parseComfyHistory(body, 'p1');
    expect(state.state).toBe('failed');
    if (state.state !== 'failed') return;
    expect(state.failure).toMatchObject({ kind: 'execution', retryable: true });
    expect(state.failure.message).toContain('节点 3');
    expect(state.failure.message).toContain('CUDA out of memory');
  });

  it('status_str=error 但 messages 是空的 → 仍然是 execution，只是没有细节', () => {
    const state = parseComfyHistory({ p1: { status: { status_str: 'error' } } }, 'p1');
    expect(state).toMatchObject({ state: 'failed', failure: { kind: 'execution' } });
  });

  it('跑完了但没有图 → bad-response，点名缺 SaveImage', () => {
    const state = parseComfyHistory(
      { p1: { status: { status_str: 'success', completed: true }, outputs: {} } },
      'p1',
    );
    expect(state.state).toBe('failed');
    if (state.state !== 'failed') return;
    expect(state.failure.kind).toBe('bad-response');
    expect(state.failure.message).toContain('SaveImage');
  });

  it('id 对不上 → pending（别的 prompt 的历史不算数）', () => {
    const body = { other: { status: { completed: true }, outputs: {} } };
    expect(parseComfyHistory(body, 'p1')).toEqual({ state: 'pending' });
  });

  it('响应体根本不是对象 → bad-response', () => {
    expect(parseComfyHistory('nope', 'p1')).toMatchObject({
      state: 'failed',
      failure: { kind: 'bad-response' },
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 失败构造 & 内置图
// ═══════════════════════════════════════════════════════════

describe('comfyFail / BUILTIN_COMFY_WORKFLOW', () => {
  it('🔴 workflow 不可重试、execution 可重试 —— 这一对不许合并（C12）', () => {
    expect(comfyFail('workflow').retryable).toBe(false);
    expect(comfyFail('execution').retryable).toBe(true);
  });

  it('没有一句文案提到 NovelAI / Anlas（本地后端不存在这些概念）', () => {
    for (const message of Object.values(COMFY_FAILURE_MESSAGES)) {
      expect(message).not.toMatch(/NovelAI|Anlas/);
    }
  });

  it('内置图是最小 SDXL txt2img：七个节点、checkpoint 名写死（node_errors 是设计好的败法）', () => {
    const classTypes = Object.values(BUILTIN_COMFY_WORKFLOW).map(
      (node) => (node as { class_type: string }).class_type,
    );
    expect(classTypes).toEqual([
      'KSampler',
      'CheckpointLoaderSimple',
      'EmptyLatentImage',
      'CLIPTextEncode',
      'CLIPTextEncode',
      'VAEDecode',
      'SaveImage',
    ]);
    expect(JSON.stringify(BUILTIN_COMFY_WORKFLOW)).toContain('sd_xl_base_1.0.safetensors');
  });
});

// ═══════════════════════════════════════════════════════════
// isComfyPromptRunning（取消链路的「别误伤」判据）
// ═══════════════════════════════════════════════════════════

describe('isComfyPromptRunning', () => {
  const queue = {
    queue_running: [[0, 'p1', { '3': {} }, {}, []]],
    queue_pending: [[1, 'p2', { '3': {} }, {}, []]],
  };

  it('正在跑的就是这一张 → true', () => {
    expect(isComfyPromptRunning(queue, 'p1')).toBe(true);
  });

  it('🔴 只在排队里 → false：interrupt 掐的是「当前那个」，此时发出去掐的是别人的图', () => {
    expect(isComfyPromptRunning(queue, 'p2')).toBe(false);
    expect(isComfyPromptRunning(queue, 'p3')).toBe(false);
  });

  it('认不出的形状一律 false（少掐一次好过多掐一次）', () => {
    expect(isComfyPromptRunning(undefined, 'p1')).toBe(false);
    expect(isComfyPromptRunning({}, 'p1')).toBe(false);
    expect(isComfyPromptRunning({ queue_running: 'nope' }, 'p1')).toBe(false);
    expect(isComfyPromptRunning({ queue_running: [{ prompt_id: 'p1' }] }, 'p1')).toBe(false);
  });
});
