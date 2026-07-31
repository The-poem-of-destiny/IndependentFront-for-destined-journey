/**
 * progress.ts — 导入进度条的「永不倒退」判定
 *
 * 为什么单拎出来: 这段判定看着就四个 if，但它要同时扛住**三种**分母不作准的情形，
 * 而三种都是真实存在、且都会让朴素的 `done/total` 在屏幕上往回抽:
 *
 *   ① **解压段**（`phase: 'read'`）—— zip 的条目总数写在文件末尾的中央目录里，
 *      而读包是从头往后流式扫本地头，于是分母边读边长。store 现在干脆把这一段的
 *      `progressTotal` 钉成 0（"没有分母"）。
 *   ② **混合导入**（一个包 + 一批散图，或多个包）—— 后面几批各有多少行，要等它们
 *      各自规划完才知道，所以 store 同样不给分母（`progressTotal` 恒 0），
 *      但此时 `phase` 已经是 `'write'` 且 `done` 从上一批的累计值接着往上走。
 *      **这是第三个到达 `total === 0` 的新路径**，与①的相位不同，不能只认相位。
 *   ③ 万一哪天分母又变成"会长的数"（口径回退）—— 高水位仍然兜得住。
 *
 * 所以这里刻意**不依赖 `progressPhase`** 做判定（相位只用来挑文案）: 判定只看
 * 这两个数本身，于是 store 换口径时最坏也只是退化成转圈，绝不会出现倒退的进度条。
 * 一条会倒退的 scaleX 比一个转圈更糟 —— 前者读起来像 bug，后者只是没信息。
 *
 * 纯度: 无 Vue、无 store、无浏览器全局，就是个带状态的小归约器（工厂返回实例，
 * 对齐 lib/asset-url.ts 的风格），于是它可以被穷举测试。
 */

export interface ProgressState {
  /** 真为「给不出可信百分比」—— UI 应当渲染不确定态（来回扫的窄带） */
  indeterminate: boolean;
  /** 0..1 的高水位比例。`indeterminate` 时不该渲染它，但它**永不下降** */
  ratio: number;
}

export interface ProgressTracker {
  /** 喂一次 `(progressDone, progressTotal)` 观测，拿回该怎么画 */
  observe(done: number, total: number): ProgressState;
  /** 手动复位（新一轮导入）。`observe(0, 0)` 也会自动复位 */
  reset(): void;
  /** 当前高水位，便于断言单调性 */
  readonly ratio: number;
}

export function createProgressTracker(): ProgressTracker {
  /**
   * 已经渲染过的最高比例 —— 比它低的一律不画。
   *
   * ⚠️ 这里**只有高水位，没有"分母变了就清零"那条规则**。曾经有过，是错的:
   * 清零之后下一帧就会用新分母算出一个更小的比例并**当成确定态画出来**，于是屏幕上
   * 是 66% → 转圈 → 25%。中间垫一帧转圈并不能让它不算倒退，只是把倒退洗白了一下。
   * 是 progress.test.ts 的单调性断言把它抓出来的。
   *
   * 现在分母变化不单独处理: 新比例更高就画（本来就是上升），更低就退回转圈等它追上来。
   * 少一条规则，且"渲染出来的比例永不下降"成了无条件成立的不变式。
   */
  let shown = 0;

  function reset(): void {
    shown = 0;
  }

  return {
    get ratio(): number {
      return shown;
    },

    reset,

    observe(done: number, total: number): ProgressState {
      // importZip / importFiles / importAny 起手都把两个数归零 —— 这就是
      // "新一轮开始"的信号，不必另设标志位
      if (done === 0 && total === 0) {
        reset();
        return { indeterminate: true, ratio: 0 };
      }
      // 没有分母（解压段 / 混合导入）——「已处理 n」是此刻唯一诚实的说法
      if (total <= 0) return { indeterminate: true, ratio: shown };

      const ratio = Math.min(1, Math.max(0, done / total));
      // 比高水位低（分子回退，或分母刚变大）→ 宁可转圈，绝不把条往回抽
      if (ratio < shown) return { indeterminate: true, ratio: shown };

      shown = ratio;
      return { indeterminate: false, ratio };
    },
  };
}
