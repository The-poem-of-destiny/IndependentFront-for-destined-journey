/**
 * no-world-content.test.ts —— 公开仓「零世界观内容」守门（内容-引擎分离波 4 / D32）
 *
 * 两轴：
 * ① **叙事内容轴**：世界专名词表扫 `public/data/**`（波 4 新增的占位内容面，
 *    最需要守的是这里——占位件夹带真实专名 = 内容泄露进公开树）。
 *    src/ 与 docs/ 的历史内容由波 5（T20）专项清洗，届时把清洗面逐步纳入本轴。
 *    词表是 floor 不是 ceiling（数值 lore 抓不到，D6）；专名本身已随公开卡片公开，
 *    词表入公开仓不构成新泄露。
 * ② **体量轴**：`public/data/worldbooks/*.json` 单本 ≤10 条 / 全集 ≤150 条、
 *    `reference/` 目录不存在、13 agent id 齐 + 各 systemPrompt 非空 +
 *    `agents.story.preset.settings.prompts[]` 非空。
 *
 * 🔴 守门测试自身在白名单里（它必须能提到专名才能断言）；占位 agent-config 的
 * 产品名引用行也在白名单。
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..');

// ═══════════════════════════════════════════════════════════
// ① 叙事内容轴：世界专名词表（研究 lexicon，D32）
// ═══════════════════════════════════════════════════════════

/** 世界专名词表（37 词，刨掉「命定之诗」产品名本身） */
const WORLD_LEXICON = [
  // 势力与地理
  '奥古斯提姆',
  '诺斯加德',
  '萨赫拉',
  '赛瑞利亚',
  '翡翠之心',
  '梵尼亚',
  '永夜盟约',
  '瓦伦蒂亚',
  '索伦蒂斯',
  '兽族联盟',
  '阿斯塔利亚',
  '艾瑟嘉德',
  '金谷城',
  '珍珠港',
  '伯伦斯法环',
  '边陲之国',
  '白曜城',
  // 纪元与叙事概念
  '复兴纪元',
  '黄昏之歌',
  '天命',
  '神陨',
  '星陨',
  '圣辉',
  '血月',
  '黑潮',
  // 种族与组织（「古龙」是通用奇幻词，占位内容可用 —— 不构成专名泄露）
  '智人种',
  '亚人种',
  '幻身种',
  '异界种',
  '晨曦教会',
  '永夜议会',
  '圣殿骑士团',
  '吟游诗人公会',
  '霜脊',
  '翠影',
  '赤砂',
];

/**
 * 路径白名单：这些 public/data 文件允许包含专名词（守门自身 / 占位内容的
 * 产品名/通用奇幻词）。
 */
const PATH_ALLOWLIST = new Set([
  'tests/no-world-content.test.ts',
  // 🔴 波 5 T19 清洗对象：占位 agent-config 的「登神」提示词待中性化为「突破要素」。
  // 清洗完成后移出白名单（守门收紧）。
  'public/data/defaults/agent-config.json',
]);

describe('① 叙事内容轴：占位内容面无世界专名', () => {
  const dataFiles = trackedDataFiles();
  expect(dataFiles.length).toBeGreaterThan(10); // 哨兵：扫描确实覆盖占位面

  it('public/data 无专名命中（守门测试自身除外）', () => {
    const offenders: string[] = [];
    for (const rel of dataFiles) {
      if (PATH_ALLOWLIST.has(rel)) continue;
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // 文件不存在（子模块/稀疏检出）跳过
      }
      for (const term of WORLD_LEXICON) {
        if (text.includes(term)) {
          offenders.push(`${rel}: 「${term}」`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/** 列 public/data 下全部文件（相对仓库根） */
function trackedDataFiles(): string[] {
  const root = join(REPO_ROOT, 'public', 'data');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        out.push(
          join('public', 'data', full.slice(root.length + 1))
            .split('\\')
            .join('/'),
        );
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

// ═══════════════════════════════════════════════════════════
// ② 体量轴：占位内容阈值 + reference 不存在 + agent 规格
// ═══════════════════════════════════════════════════════════

describe('② 体量轴：占位内容阈值（§6 / D32）', () => {
  const wbDir = join(REPO_ROOT, 'public', 'data', 'worldbooks');
  const bookFiles = existsSync(wbDir) ? readdirSync(wbDir).filter((f) => f.endsWith('.json')) : [];

  it('15 本占位世界书', () => {
    expect(bookFiles).toHaveLength(15);
  });

  it('单本 ≤10 条 / 全集 ≤150 条', () => {
    let total = 0;
    for (const f of bookFiles) {
      const book = JSON.parse(readFileSync(join(wbDir, f), 'utf8')) as {
        entries: unknown[];
      };
      expect(book.entries.length, `${f} 条目数`).toBeLessThanOrEqual(10);
      total += book.entries.length;
    }
    expect(total).toBeLessThanOrEqual(150);
  });

  it('reference/ 目录不存在（真实参考内容已离公开树）', () => {
    // 空目录 git 不追踪：断言「git 跟踪里无 reference/ 文件」才是正确判据
    const tracked = execSync('git ls-files reference/', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    expect(tracked).toBe('');
  });

  it('占位内容无真实内容目录（data/ 应只剩占位件）', () => {
    // git 跟踪里 data/ 下不应再有 worldbooks/defaults/content 真实树
    for (const sub of ['worldbooks', 'defaults', 'content']) {
      const tracked = execSync(`git ls-files data/${sub}/`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
      expect(tracked, `data/${sub} 不应有跟踪文件`).toBe('');
    }
  });
});

describe('② 体量轴：占位 agent-config 规格（§6 / D32）', () => {
  const agentConfigPath = join(REPO_ROOT, 'public', 'data', 'defaults', 'agent-config.json');
  const agentConfig = JSON.parse(readFileSync(agentConfigPath, 'utf8')) as {
    agents: Record<
      string,
      {
        systemPrompt?: string;
        preset?: { settings: { prompts?: unknown[] } };
      }
    >;
  };

  it('13 个 agent id 齐', () => {
    expect(Object.keys(agentConfig.agents)).toHaveLength(13);
  });

  it('各 agent systemPrompt 非空（image_prompt 除外 —— 它那份归方言，C5）', () => {
    for (const [id, agent] of Object.entries(agentConfig.agents)) {
      // 🔴 `image_prompt.systemPrompt` 已随图像 v2 / C5 退役到 `data/content/image-dialects.json`：
      //    方言拥有整个装配契约，两处都留着就是 D53 警告的第三份拷贝。
      //    那份提示词的体量由 placeholder-content 那条用例盯着，这里只确认它不在这儿
      if (id === 'image_prompt') {
        expect(agent.systemPrompt, 'image_prompt.systemPrompt 应已退役').toBeUndefined();
        continue;
      }
      expect(agent.systemPrompt?.trim().length, `${id}.systemPrompt`).toBeGreaterThan(0);
    }
  });

  it('story 挂占位预设且 prompts 非空', () => {
    const story = agentConfig.agents.story;
    expect(story.preset?.settings.prompts?.length, 'story.preset.prompts').toBeGreaterThan(0);
  });
});
