import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export interface ThemeDefinition {
  id: string;
  name: string;
  nameZh: string;
  type: 'warm' | 'dark' | 'light';
  preview: string; // CSS gradient for preview swatch
}

export const THEME_LIST: ThemeDefinition[] = [
  {
    id: 'parchment',
    name: "Wayfarer's Atlas",
    nameZh: '远行者舆图',
    type: 'light',
    preview: 'linear-gradient(135deg, #f4ead8, #b99f76)',
  },
  {
    id: 'obsidian',
    name: 'Gilded Orrery',
    nameZh: '玄金星盘',
    type: 'dark',
    preview: 'linear-gradient(135deg, #090b10, #c9a85f)',
  },
  {
    id: 'crimson',
    name: 'Crimson Rose Window',
    nameZh: '血色玫瑰窗',
    type: 'dark',
    preview: 'linear-gradient(135deg, #0d0b0c, #7b1927)',
  },
  {
    id: 'indigo',
    name: 'Qinghua Porcelain',
    nameZh: '青花瓷',
    type: 'light',
    preview: 'linear-gradient(135deg, #f5f8f8, #275f9d)',
  },
  {
    id: 'bronze',
    name: 'Bronze Mechanism',
    nameZh: '古铜机巧',
    type: 'dark',
    preview: 'linear-gradient(135deg, #17100b, #8a5d34)',
  },
  {
    id: 'sakura',
    name: 'Nocturne Sakura',
    nameZh: '夜樱漆匣',
    type: 'dark',
    preview: 'linear-gradient(135deg, #0c080d, #713c58)',
  },
  {
    id: 'ivory',
    name: 'Moonwhite Brocade',
    nameZh: '月白云锦',
    type: 'light',
    preview: 'linear-gradient(135deg, #fbfaf6, #c8c2b6)',
  },
  {
    id: 'misty-lilac',
    name: 'Aurora Frostglass',
    nameZh: '极光霜晶',
    type: 'light',
    preview: 'linear-gradient(135deg, #eef3f8, #b8a9d1)',
  },
  {
    id: 'forest',
    name: 'Jade Conservatory',
    nameZh: '翡翠温室',
    type: 'light',
    preview: 'linear-gradient(135deg, #eff4ea, #9daf98)',
  },
  {
    id: 'ocean',
    name: 'Abyssal Cathedral',
    nameZh: '深海圣堂',
    type: 'dark',
    preview: 'linear-gradient(135deg, #061019, #246174)',
  },
];

/**
 * 字体族选项 —— 只有这两个，因为 index.html 只加载了这两套中文字形
 * （Cinzel 是纯装饰拉丁字体，没有中文字形，只服务 `--theme-font-display`，
 * 不进用户可选项）。
 */
export type FontFamilyChoice = 'sans' | 'serif';

/**
 * 选项 → 真正写进 CSS 变量的字体栈。
 *
 * 🔴 第一顺位是带 `Variable` 后缀的族名：自托管走 `@fontsource-variable/*`
 *    （main.ts 引入），它注册的 `@font-face` 就叫 `'Noto Sans SC Variable'`。
 *    漏掉后缀不会报错，只会安静地退回系统字体。
 *    第二顺位留不带后缀的名字，给「自托管文件没到位但系统装了同名字体」兜底。
 *
 * 与 `themes/variables.css` 的 `:root` 三行是同一套值（那边是没有 JS 时的兜底），
 * 改一处要同步另一处 —— `tests/theme-fonts-invariant.test.ts` 会对着这条断言。
 */
const FONT_STACKS: Record<FontFamilyChoice, string> = {
  sans: "'Noto Sans SC Variable', 'Noto Sans SC', sans-serif",
  serif: "'Noto Serif SC Variable', 'Noto Serif SC', serif",
};

/**
 * 出厂默认：**正文无衬线、标题衬线**。
 *
 * 与 `themes/variables.css` 的 `:root` 一致（那份仍是没有 JS 时的兜底），
 * 也就是 design.md §2.1 的「手稿标题 + 工整正文」对比。
 */
const DEFAULT_FONT_BODY: FontFamilyChoice = 'sans';
const DEFAULT_FONT_TITLE: FontFamilyChoice = 'serif';

const LS_FONT_BODY = 'fated-poem-font-body';
const LS_FONT_TITLE = 'fated-poem-font-title';
/** 旧的三档单选（'sans' | 'serif' | 'mixed'），只在迁移时读一次 */
const LS_FONTS_LEGACY = 'fated-poem-fonts';

export const useThemeStore = defineStore('theme', () => {
  const current = ref('obsidian');
  const fontBody = ref<FontFamilyChoice>(DEFAULT_FONT_BODY);
  const fontTitle = ref<FontFamilyChoice>(DEFAULT_FONT_TITLE);
  const fontSize = ref('16');

  function setFontSize(size: string) {
    fontSize.value = size;
    document.documentElement.style.fontSize = size + 'px';
    try {
      localStorage.setItem('fated-poem-font-size', size);
    } catch {
      // 隐私模式 / 配额满：字号记不住而已，本次设置已经生效，不值得打断用户
    }
  }

  function initFontSize() {
    try {
      const saved = localStorage.getItem('fated-poem-font-size');
      if (saved) setFontSize(saved);
    } catch {
      // 读不到就用默认字号，没有可降级的余地也没有可报的错
    }
  }

  const currentTheme = computed(() => THEME_LIST.find((t) => t.id === current.value));

  function apply(themeId: string) {
    document.documentElement.setAttribute('data-theme', themeId);
    current.value = themeId;
    try {
      localStorage.setItem('fated-poem-theme', themeId);
    } catch {
      /* localStorage not available */
    }
  }

  function init() {
    try {
      const saved = localStorage.getItem('fated-poem-theme');
      if (saved && THEME_LIST.some((t) => t.id === saved)) {
        apply(saved);
      } else {
        apply('obsidian');
      }
    } catch {
      apply('obsidian');
    }
  }

  /**
   * 写一格字体。
   *
   * 🔴 **一律写内联变量，哪怕值就是出厂默认**。内联样式压得过任何 `[data-theme]`
   *    规则，所以「设置说了算」这件事是靠这两行内联变量强制的 —— 主题 CSS 想改字体
   *    也改不动。这正是「严格按设置」的执行点，别改成「和默认值相同就不写」：
   *    那等于把决定权在默认档上又交还给主题。
   */
  function applyFontVar(slot: 'body' | 'title', choice: FontFamilyChoice) {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty(`--theme-font-${slot}`, FONT_STACKS[choice]);
  }

  function persist(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 隐私模式 / 配额满：记不住而已，本次设置已经生效，不值得打断用户
    }
  }

  /** 正文字体（UI 标签、表单、列表、说明文字） */
  function setFontBody(choice: FontFamilyChoice) {
    fontBody.value = choice;
    applyFontVar('body', choice);
    persist(LS_FONT_BODY, choice);
  }

  /** 标题字体（分区标题、叙事正文、角色名/物品名 —— `--theme-font-title` 的全部 111 处） */
  function setFontTitle(choice: FontFamilyChoice) {
    fontTitle.value = choice;
    applyFontVar('title', choice);
    persist(LS_FONT_TITLE, choice);
  }

  function readChoice(key: string): FontFamilyChoice | null {
    try {
      const v = localStorage.getItem(key);
      return v === 'sans' || v === 'serif' ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * 读回两格字体设置并落到 DOM 上。**必须在挂载前调用一次**（main.ts）。
   *
   * 🔴 这个函数此前**根本不存在**，是 design.md §7.4 那条 bug 的一半：`setFonts()`
   *    往 `fated-poem-fonts` 写了值，而全项目没有任何读取点 —— 刷新后 ref 重置成默认、
   *    DOM 上也没有内联覆盖，于是字体退回主题说了算，而下拉框还显示着用户选的值。
   *    另一半是 parchment/ivory 把 `--theme-font-body` 改成了衬线（已从主题 CSS 移除）。
   *
   * 迁移：旧的三档单选只影响正文（`mixed` 那档写的是 `'Noto Sans SC', 'Noto Serif SC',
   * sans-serif` —— 有中文字形的字符全部命中第一个，所以它渲染出来和 `sans` 一模一样）。
   * 因此 legacy 'serif' → 正文衬线，其余 → 正文无衬线；标题一律取默认衬线，
   * 因为旧实现从来没碰过 `--theme-font-title`。**照用户实际看到的样子迁**，不是照字面。
   */
  function initFonts() {
    let body = readChoice(LS_FONT_BODY);
    const title = readChoice(LS_FONT_TITLE);

    if (body === null && title === null) {
      try {
        const legacy = localStorage.getItem(LS_FONTS_LEGACY);
        if (legacy) body = legacy === 'serif' ? 'serif' : 'sans';
      } catch {
        // 读不到旧值就当没设过，走默认
      }
    }

    setFontBody(body ?? DEFAULT_FONT_BODY);
    setFontTitle(title ?? DEFAULT_FONT_TITLE);
  }

  return {
    current,
    fontBody,
    fontTitle,
    fontSize,
    currentTheme,
    THEME_LIST,
    apply,
    init,
    initFonts,
    initFontSize,
    setFontBody,
    setFontTitle,
    setFontSize,
  };
});
