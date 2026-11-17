<script lang="ts">
/**
 * NarrativeParagraph — 正文的一个段落，带特效层的三种呈现（动效 v1）
 *
 * - `stream`：流式草稿。只有新追加的尾巴切成短暂的 span 由模糊洇开，约 420ms 后并回纯文本；
 *   状态机见 `lib/narrative-reveal.ts`。
 * - `ink`：整条一次到达的新消息，整段作为一块墨迹浮现（不逐词，只动 opacity、不模糊）。
 * - `plain`：什么都不动。
 *
 * 另可叠加「名字初次登场」的下划线（`marks`，字符区间）。
 *
 * 🔴 根元素永远是一个 `<p>`，其 textContent 与 `<p>{{ text }}</p>` 逐字相同 —— 动画 span 只是
 *    把同一串字切成几段，屏幕阅读器读到的内容不变；动画片标 `role="presentation"`。
 * 🔴 落定后（无存活片、无下划线、无整段墨迹）只剩一个文本节点，与不开特效时 DOM 相同。
 * 🔴 用渲染函数而非模板：模板里的换行缩进会在 `<p>` 内生出空白文本节点，而段落是
 *    `white-space: pre-wrap`，多出的空格会真的显示出来。
 * 🔴 本组件不带 scoped 样式：父组件（BeautifiedNarrative）的作用域属性落在根 `<p>` 上，
 *    `.beautified-narrative p` 的排版照常生效，DOM 上也不多一个属性。
 */
import {
  defineComponent,
  h,
  onBeforeUnmount,
  shallowRef,
  watch,
  type PropType,
  type VNodeChild,
} from 'vue';
import {
  advanceReveal,
  claimReveal,
  hasLiveChunks,
  nextExpiry,
  releaseReveal,
  settledReveal,
  type RevealMemory,
  type RevealState,
} from '../../lib/narrative-reveal';

export type ParagraphMode = 'plain' | 'stream' | 'ink';

export interface TextRange {
  start: number;
  end: number;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export default defineComponent({
  name: 'NarrativeParagraph',
  props: {
    text: { type: String, required: true },
    mode: { type: String as PropType<ParagraphMode>, default: 'plain' },
    /** `ink` 模式下的交错序号（乘以 `--motion-stagger-step`） */
    order: { type: Number, default: 0 },
    /** 名字下划线区间（按段落文本的字符下标，互不重叠、升序） */
    marks: { type: Array as PropType<readonly TextRange[]>, default: () => [] },
    /** `stream` 模式的跨重挂记忆（同一条流式正文共用一份） */
    memory: { type: Object as PropType<RevealMemory>, default: undefined },
    memoryKey: { type: String, default: '' },
  },
  setup(props, { slots }) {
    const state = shallowRef<RevealState>(settledReveal(props.text));
    let timer: ReturnType<typeof setTimeout> | null = null;

    function remember(next: RevealState) {
      state.value = next;
      if (props.memory) props.memory.states.set(props.memoryKey, next);
      schedule();
    }

    function schedule() {
      if (timer !== null || !hasLiveChunks(state.value)) return;
      const due = nextExpiry(state.value);
      if (due === null) return;
      timer = setTimeout(
        () => {
          timer = null;
          remember(advanceReveal(state.value, state.value.text, now()));
        },
        Math.max(16, due - now() + 16),
      );
    }

    if (props.mode === 'stream') {
      const start = props.memory
        ? claimReveal(props.memory, props.memoryKey, props.text)
        : settledReveal('');
      remember(advanceReveal(start, props.text, now()));
    }

    watch(
      () => [props.text, props.mode] as const,
      ([text, mode]) => {
        if (mode === 'stream') remember(advanceReveal(state.value, text, now()));
        else state.value = settledReveal(text);
      },
    );

    onBeforeUnmount(() => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (props.memory) releaseReveal(props.memory, props.memoryKey, state.value);
    });

    function markedChildren(text: string): VNodeChild[] {
      const out: VNodeChild[] = [];
      let cursor = 0;
      for (const mark of props.marks) {
        if (mark.start < cursor || mark.end > text.length || mark.end <= mark.start) continue;
        if (mark.start > cursor) out.push(text.slice(cursor, mark.start));
        out.push(h('span', { class: 'fx-first-name' }, text.slice(mark.start, mark.end)));
        cursor = mark.end;
      }
      if (cursor < text.length || out.length === 0) out.push(text.slice(cursor));
      return out;
    }

    return () => {
      let children: VNodeChild[];
      if (props.mode === 'stream' && state.value.text === props.text) {
        children = state.value.pieces.length
          ? state.value.pieces.map((piece) =>
              piece.kind === 'chunk'
                ? h(
                    'span',
                    { key: piece.id, class: 'fx-ink-chunk', role: 'presentation' },
                    piece.text,
                  )
                : piece.text,
            )
          : [props.text];
      } else if (props.marks.length > 0) {
        children = markedChildren(props.text);
      } else {
        children = [props.text];
      }
      const tail = slots.default?.();
      if (tail) children.push(...tail);
      const ink = props.mode === 'ink';
      return h(
        'p',
        ink ? { class: 'fx-ink-para', style: { '--fx-ink-order': String(props.order) } } : null,
        children,
      );
    };
  },
});
</script>

<style>
/*
 * 墨迹洇开（动效 v1 · 特效层）。全部挂在闸门 `:root[data-fx='on']` 下：闸门一关，
 * 这些类即便还在 DOM 上也不产生任何效果。
 * 🔴 一次性入场一律 `backwards` 填充，不用 `both`（design.md §6.0 第 5 条）。
 * filter 是规格点名的「由模糊到清晰」，强度压在 2px，**只**作用于短暂存活的流式 chunk span
 * （同时至多 48 个，design.md §6.4 记的例外）。
 * 🔴 整段（`.fx-ink-para`）与整块（`.fx-ink-block`，覆盖美化 iframe / 对话卡片 / 行动面板）
 *    一律只动 opacity：对整段 / 整块做 filter 动画会逐帧重栅格化大面积内容（含 iframe）。
 */
@keyframes fx-ink-bleed {
  from {
    opacity: 0.35;
    filter: blur(2px);
  }
}

@keyframes fx-ink-fade {
  from {
    opacity: 0.35;
  }
}

@keyframes fx-name-draw {
  from {
    background-size: 0% 1px;
  }
}

:root[data-fx='on'] .fx-ink-chunk {
  animation: fx-ink-bleed var(--motion-duration-page) var(--motion-ease-enter) backwards;
}

:root[data-fx='on'] .fx-ink-para,
:root[data-fx='on'] .fx-ink-block {
  animation: fx-ink-fade var(--motion-duration-page) var(--motion-ease-enter) backwards;
  animation-delay: calc(var(--motion-stagger-step) * var(--fx-ink-order, 0));
}

/* 名字初次登场：一道低透明度的强调色细线由左向右描出，停在那里 */
:root[data-fx='on'] .fx-first-name {
  background-image: linear-gradient(
    color-mix(in srgb, var(--theme-primary) 38%, transparent),
    color-mix(in srgb, var(--theme-primary) 38%, transparent)
  );
  background-repeat: no-repeat;
  background-position: 0 100%;
  background-size: 100% 1px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  animation: fx-name-draw 600ms var(--motion-ease-standard) backwards;
}

/* 整段墨迹浮现时，下划线等字落定后再描 */
:root[data-fx='on'] .fx-ink-para .fx-first-name {
  animation-delay: calc(
    var(--motion-stagger-step) * var(--fx-ink-order, 0) + var(--motion-duration-base)
  );
}
</style>
