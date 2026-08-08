/**
 * NAI 回归冒烟（图像 v2 DoD 最后一项，2026-08-08）—— 一次生成，🔴 不进循环
 * （.env.local 里的 token 是免费额度，约 30 次）。
 *
 * 走**生产代码路径**: 方言解析(danbooru-anime, 与应用同一份内容 JSON) →
 * composePrompt(方言参数化) → buildNaiRequest(三重冗余) → generateNaiImage
 * (真实客户端: 超时/分类/parseNaiZip) → 同源 BFF /api/image/generate (dev 5173) → NovelAI。
 *
 * 用法: npx vite-node scripts/nai-regression-smoke.ts   （需要 dev server 已在 5173）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseImageDialects, resolveImageDialect } from '@engine/image-dialect';
import { composePrompt } from '@engine/image-prompt';
import { buildNaiRequest } from '@engine/image-providers/novelai';
import { DEFAULT_IMAGE_MODEL } from '@engine/image-defaults';
import { generateNaiImage, setImageFetch } from '@ui/lib/image-client';

async function main(): Promise<void> {
  // 1. key 从 .env.local 读（绝不打印）
  const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
  const m = env.match(/^NOVELAI_API_KEY=(\S+)/m);
  if (!m) throw new Error('NOVELAI_API_KEY not found in .env.local');
  const token = m[1];

  // 2. 方言从内容 JSON 解析（与应用同一份数据）
  const raw: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'public/data/content/image-dialects.json'), 'utf8'),
  );
  const dialect = resolveImageDialect(parseImageDialects(raw), 'danbooru-anime', {});
  console.log('[dialect]', dialect.id, '| suffix:', `${dialect.qualitySuffix.slice(0, 40)}…`);

  // 3. 生产装配（NAI 有角色槽，不压平；无预设角色 → 只画场景）
  const composed = composePrompt(
    'tavern interior, warm candlelight, fireplace, wooden door opening, adventurer entering, cozy atmosphere, from side',
    '',
    { characters: [], rating: 'general' },
    new Map(),
    {
      dialect,
      qualitySuffix: dialect.qualitySuffix,
      baseNegative: dialect.baseNegative,
      extraNegative: '',
      compositionTags: dialect.composition,
      maxRating: 'general',
      worldTags: 'night',
    },
  );
  console.log('[composed] base tail:', composed.base.slice(-80));

  // 4. 三重冗余请求体（v1 真机 2026-08-04 核准过的默认参数）
  const body = buildNaiRequest(composed, {
    model: DEFAULT_IMAGE_MODEL,
    width: 1216,
    height: 832,
    steps: 23,
    scale: 5,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    ucPreset: 0,
  });
  console.log('[request] model:', body.model);

  // 5. 真实客户端经 dev server 的 BFF —— node 里把相对 BFF 路径钉到 5173
  setImageFetch((url, init) => fetch(`http://localhost:5173${url}`, init as RequestInit) as never);
  const t0 = Date.now();
  const result = await generateNaiImage({ token, body });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (!result.ok) {
    console.error('[FAIL]', result.kind, '|', result.message, '|', result.detail ?? '');
    process.exitCode = 1;
    return;
  }
  const png = result.images[0]!;
  const magic = Buffer.from(png.slice(0, 8)).toString('hex');
  const out = resolve(process.cwd(), 'nai_regression.png');
  writeFileSync(out, png);
  console.log(
    `[OK] ${secs}s | ${png.length} bytes | magic ${magic} | content-type ${result.contentType} | saved ${out}`,
  );
}

main().catch((e: unknown) => {
  console.error('[UNCAUGHT]', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
