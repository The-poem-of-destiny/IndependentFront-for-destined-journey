/**
 * SettingsPage.vue —— 动态引擎导入的名字守护
 *
 * 为什么需要这么一条源码级的测试：
 *
 * 设置页的重活都走 `const { fn } = await import('@engine/database')`。这种解构里的
 * 名字**没有任何工具在看**：
 *   · `npm run typecheck` 是裸 `tsc`，不解析 `.vue`（项目没装 vue-tsc）；
 *   · Vite 构建只做转译，不做类型检查；
 *   · 名字不存在时解构出 `undefined`，直到用户真的点下那个按钮才炸成
 *     `TypeError: x is not a function`。
 *
 * 这个洞真实咬过一次：`clearAll()` 解构的是 `deleteDatabase`，而 database.ts 导出的是
 * `clearAllData` —— 于是「清除所有数据」抛在关弹窗与 toast 之前，表现为"点了没反应"，
 * 而且大概从来没成功过。修在 SettingsPage.vue 的 clearAll()，这条测试负责它不再烂回去。
 *
 * 做法：读 SFC 源码，把所有 `await import('@engine/…')` 的解构名字抠出来，逐个对照
 * 模块真实导出。刻意不 mount 组件 —— 这个洞在类型层与源码层，跟渲染无关，而 mount
 * 整个设置页要拖进 API 池 / 世界书 / Agent 配置一整片启动逻辑，得不偿失。
 */
import { describe, it, expect } from 'vitest';
import * as engineDatabase from '@engine/database';
// 源码用 Vite 的 `?raw` 拿，**不用 node 的 fs / path / __dirname**:
//   · 仓库没装 `@types/node` —— `src/**` 下 `import 'fs'` 会让裸 tsc 报 TS2307，
//     `__dirname` 在 ESM 里也不存在（TS2304）；
//   · `?raw` 的环境声明由 `src/env.d.ts` 引的 `vite/client` 提供，类型就是 string；
//   · 走 `@ui` / `@engine` 别名而不是相对路径算术 —— 本文件挪窝也不用改，
//     真解析不到时是**导入期硬报错**，不会退化成静默通过。
import settingsPageSource from '@ui/components/settings/SettingsPage.vue?raw';
import databaseSource from '@engine/database.ts?raw';

/** 本测试能对照的引擎模块（静态 import 拿到真实导出面） */
const KNOWN_MODULES: Record<string, Record<string, unknown>> = {
  '@engine/database': engineDatabase as unknown as Record<string, unknown>,
};

interface DestructureSite {
  module: string;
  /** 解构出来的**导出名**（`savePreset: sp` 取 `savePreset`，别名与本测试无关） */
  names: string[];
}

/**
 * 抠出所有 `const { a, b: c } = await import('@engine/x')`。
 *
 * 刻意宽松匹配空白：这个文件里两种写法都有（分区代码是压行的，
 * 预设那几处是展开的），任何一种漏掉都等于守不住。
 */
function collectDynamicImports(source: string): DestructureSite[] {
  const re = /const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"](@engine\/[^'"]+)['"]\s*\)/g;
  const out: DestructureSite[] = [];
  for (const m of source.matchAll(re)) {
    const names = m[1]
      .split(',')
      .map((part) => part.split(':')[0].trim())
      .filter(Boolean);
    out.push({ module: m[2], names });
  }
  return out;
}

describe('SettingsPage.vue 的动态引擎导入', () => {
  const source = settingsPageSource;
  const sites = collectDynamicImports(source);

  it('确实抓到了动态导入（正则本身别悄悄失效）', () => {
    // 正则匹不到时，下面那条"每个名字都存在"会因为集合为空而恒真 —— 先把它钉死
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((s) => s.names.length > 0)).toBe(true);
  });

  it('每个解构出来的名字都是对应引擎模块的真实导出', () => {
    const missing: string[] = [];
    for (const site of sites) {
      const mod = KNOWN_MODULES[site.module];
      // 出现了本测试没覆盖的引擎模块 → 明确失败并要求扩表，而不是静默放过
      expect(mod, `本测试尚未覆盖模块 ${site.module}，请在 KNOWN_MODULES 里补上`).toBeDefined();
      for (const name of site.names) {
        if (typeof mod[name] !== 'function') missing.push(`${site.module} → ${name}`);
      }
    }
    expect(missing, `这些名字在引擎里不存在（运行时会 TypeError）：${missing.join('、')}`).toEqual(
      [],
    );
  });

  it('清除全部数据走真名 clearAllData，且 deleteDatabase 这个幽灵名字不再出现', () => {
    expect(source).toMatch(
      /const\s*\{\s*clearAllData\s*\}\s*=\s*await\s+import\(['"]@engine\/database['"]\)/,
    );
    // 注释里提到历史名字是可以的，代码里不行 —— 只查有效代码行
    const codeLines = source
      .split('\n')
      .filter((line: string) => !/^\s*(\*|\/\/|<!--|-->)/.test(line))
      .join('\n');
    expect(codeLines).not.toMatch(/\bdeleteDatabase\s*\(/);
  });

  it('clearAllData 整库删除，因此音频与素材两库确实会一起消失', () => {
    // 存档数据分区的文案对用户承诺了这件事（素材设计 §4.5）。承诺的依据是
    // clearAllData 走 `db.delete()` 删整个库，而不是逐表清空 —— 逐表清空的写法
    // 一旦漏了新表（assetMeta / assetBlobs 就是最新的两张），文案立刻变成假话。
    const body = databaseSource.slice(databaseSource.indexOf('export async function clearAllData'));
    expect(body.slice(0, 200)).toContain('db.delete()');
  });
});
