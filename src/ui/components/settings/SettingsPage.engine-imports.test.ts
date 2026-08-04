/**
 * 设置页各分区 —— 动态引擎导入的名字守护
 *
 * 为什么需要这么一条源码级的测试：
 *
 * 设置页的重活都走 `const { fn } = await import('@engine/database')`。这种解构里的
 * 名字**运行前不会有人看**：
 *   · Vite 构建只做转译，不做类型检查；
 *   · 名字不存在时解构出 `undefined`，直到用户真的点下那个按钮才炸成
 *     `TypeError: x is not a function`。
 *
 * ⚠️ 本文件的开篇理由曾写着「`npm run typecheck` 是裸 `tsc`，不解析 `.vue`
 *    （项目没装 vue-tsc）」——**那句已经过期**：`package.json` 有
 *    `typecheck:vue: vue-tsc --noEmit`，CI 也在跑它（Q-20 查出）。vue-tsc 确实
 *    会检查 SFC 里的这些解构，所以本测试**不是**唯一的网。留着它是因为它比
 *    类型检查更直白地钉住「这个名字必须存在」，红起来的信息也更具体。
 *
 * 这个洞真实咬过一次：`clearAll()` 解构的是 `deleteDatabase`，而 database.ts 导出的是
 * `clearAllData` —— 于是「清除所有数据」抛在关弹窗与 toast 之前，表现为"点了没反应"，
 * 而且大概从来没成功过。
 *
 * 🔴 Q-25 之后这些调用点**散在多个 SFC 里**（导出/导入/清除随 DataSection 走了，
 *    预设那 6 处随 agent/PresetManager 走了，restoreAgentDefaults 随 agent/AgentConfigPanel
 *    走了 —— SettingsPage 自己已经一处都不剩）。所以本测试扫的是一张**文件表**，
 *    新分区若也用动态导入，往 `SOURCES` 里加一行 —— 忘了加不会红，
 *    这是本测试已知的边界（源码级扫描无法发现"没被扫到的文件"）。
 */
import { describe, it, expect } from 'vitest';
import * as engineDatabase from '@engine/database';
// 源码用 Vite 的 `?raw` 拿，**不用 node 的 fs / path / __dirname**:
//   · 仓库没装 `@types/node` —— `src/**` 下 `import 'fs'` 会让裸 tsc 报 TS2307，
//     `__dirname` 在 ESM 里也不存在（TS2304）；
//   · `?raw` 的环境声明由 `src/env.d.ts` 引的 `vite/client` 提供，类型就是 string；
//   · 走 `@ui` / `@engine` 别名而不是相对路径算术 —— 本文件挪窝也不用改，
//     真解析不到时是**导入期硬报错**，不会退化成静默通过。
import dataSectionSource from '@ui/components/settings/DataSection.vue?raw';
import presetManagerSource from '@ui/components/settings/agent/PresetManager.vue?raw';
// 🔴 `restoreAgentDefaults` 那处随配置面从 AgentSection 抽进了 AgentConfigPanel
//    （AgentSection 现在只剩外框 + 页头，一处动态导入都不剩）——
//    扫错文件会退化成"扫了个空文件然后全绿"，正是本测试最怕的失败形态。
import agentConfigPanelSource from '@ui/components/settings/agent/AgentConfigPanel.vue?raw';
import databaseSource from '@engine/database.ts?raw';

/** 会用到 `await import('@engine/…')` 的设置页 SFC */
const SOURCES: { file: string; source: string }[] = [
  { file: 'DataSection.vue', source: dataSectionSource },
  // Q-25 第 9 步：预设子系统那 6 处与 restoreAgentDefaults 那 1 处随 Agent 分区搬走了，
  // SettingsPage 自己已经一处动态引擎导入都不剩 —— 所以它退出这张表。
  { file: 'agent/PresetManager.vue', source: presetManagerSource },
  { file: 'agent/AgentConfigPanel.vue', source: agentConfigPanelSource },
];

/** 本测试能对照的引擎模块（静态 import 拿到真实导出面） */
const KNOWN_MODULES: Record<string, Record<string, unknown>> = {
  '@engine/database': engineDatabase as unknown as Record<string, unknown>,
};

interface DestructureSite {
  file: string;
  module: string;
  /** 解构出来的**导出名**（`savePreset: sp` 取 `savePreset`，别名与本测试无关） */
  names: string[];
}

/**
 * 抠出所有 `const { a, b: c } = await import('@engine/x')`。
 *
 * 刻意宽松匹配空白：这些文件里两种写法都有（分区代码是压行的，
 * 预设那几处是展开的），任何一种漏掉都等于守不住。
 */
function collectDynamicImports(file: string, source: string): DestructureSite[] {
  const re = /const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"](@engine\/[^'"]+)['"]\s*\)/g;
  const out: DestructureSite[] = [];
  for (const m of source.matchAll(re)) {
    const names = m[1]
      .split(',')
      .map((part) => part.split(':')[0].trim())
      .filter(Boolean);
    out.push({ file, module: m[2], names });
  }
  return out;
}

describe('设置页各分区的动态引擎导入', () => {
  const sites = SOURCES.flatMap((s) => collectDynamicImports(s.file, s.source));

  it('确实抓到了动态导入（正则本身别悄悄失效）', () => {
    // 正则匹不到时，下面那条"每个名字都存在"会因为集合为空而恒真 —— 先把它钉死
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((s) => s.names.length > 0)).toBe(true);
  });

  it('🔴 两个文件都各自抓到了（拆分后别只剩一个文件在被扫）', () => {
    // Q-25 把 exportAll / importAll / clearAll 挪进了 DataSection，把预设子系统
    // 挪进了 agent/PresetManager。若哪天有人把 SOURCES 里的某一行删了、或分区又
    // 搬了家，这条会立刻红 —— 否则测试会"扫了一个空文件然后全绿"，
    // 正是本测试最怕的失败形态。
    for (const { file } of SOURCES) {
      expect(
        sites.some((s) => s.file === file),
        `${file} 里一个动态引擎导入都没扫到 —— 它是不是搬走了？`,
      ).toBe(true);
    }
  });

  it('每个解构出来的名字都是对应引擎模块的真实导出', () => {
    const missing: string[] = [];
    for (const site of sites) {
      const mod = KNOWN_MODULES[site.module];
      // 出现了本测试没覆盖的引擎模块 → 明确失败并要求扩表，而不是静默放过
      expect(mod, `本测试尚未覆盖模块 ${site.module}，请在 KNOWN_MODULES 里补上`).toBeDefined();
      for (const name of site.names) {
        if (typeof mod[name] !== 'function') missing.push(`${site.file}: ${site.module} → ${name}`);
      }
    }
    expect(missing, `这些名字在引擎里不存在（运行时会 TypeError）：${missing.join('、')}`).toEqual(
      [],
    );
  });

  it('清除全部数据走真名 clearAllData，且 deleteDatabase 这个幽灵名字不再出现', () => {
    expect(dataSectionSource).toMatch(
      /const\s*\{\s*clearAllData\s*\}\s*=\s*await\s+import\(['"]@engine\/database['"]\)/,
    );
    // 注释里提到历史名字是可以的，代码里不行 —— 只查有效代码行
    for (const { file, source } of SOURCES) {
      const codeLines = source
        .split('\n')
        .filter((line: string) => !/^\s*(\*|\/\/|<!--|-->)/.test(line))
        .join('\n');
      expect(codeLines, `${file} 里又出现了 deleteDatabase(`).not.toMatch(/\bdeleteDatabase\s*\(/);
    }
  });

  it('clearAllData 整库删除，因此音频与素材两库确实会一起消失', () => {
    // 存档数据分区的文案对用户承诺了这件事（素材设计 §4.5）。承诺的依据是
    // clearAllData 走 `db.delete()` 删整个库，而不是逐表清空 —— 逐表清空的写法
    // 一旦漏了新表（assetMeta / assetBlobs 就是最新的两张），文案立刻变成假话。
    //
    // 🔴 断言范围是**整个函数体**而不是"前 200 字符"（Q-20 指出后者太脆：
    //    在开头加一行日志就会误伤）。函数体切到下一个顶层 `export ` 为止。
    const from = databaseSource.indexOf('export async function clearAllData');
    expect(from).toBeGreaterThan(-1);
    const rest = databaseSource.slice(from + 1);
    const to = rest.indexOf('\nexport ');
    const body = to >= 0 ? rest.slice(0, to) : rest;
    expect(body).toContain('db.delete()');
  });
});
