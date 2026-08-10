import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_ROOT = join('src', 'ui');
const REVIEWED_THEMES = [
  'parchment',
  'forest',
  'ivory',
  'misty-lilac',
  'obsidian',
  'bronze',
  'ocean',
];

const OWNERSHIP_MARKER = 'Live-region ownership correction.';
const JADE_FIDELITY_MARKER = 'Jade Conservatory reference-fidelity pass';

function readRule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  const end = css.indexOf('}', start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return css.slice(start, end + 1);
}

describe('play-area theme surface ownership', () => {
  it('does not bake responsive panel frames into fixed 16:9 viewport plates', () => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const ownershipStart = integrationCss.indexOf(OWNERSHIP_MARKER);
    const ownershipCss = integrationCss.slice(ownershipStart);

    expect(ownershipStart).toBeGreaterThanOrEqual(0);
    expect(ownershipCss).not.toMatch(/chassis-16x9/i);
    expect(ownershipCss).not.toMatch(/background-size:\s*100vw\s+auto/i);
    expect(readFileSync(join(UI_ROOT, 'main.ts'), 'utf8')).toContain(
      "import './styles/integrated-game-surfaces.css';",
    );
  });

  it.each(REVIEWED_THEMES)('%s is included in the live-region correction', (theme) => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const ownershipCss = integrationCss.slice(integrationCss.indexOf(OWNERSHIP_MARKER));

    expect(ownershipCss).toContain(`[data-theme='${theme}']`);
  });

  it('ocean keeps its framed narrative raster uniformly scaled', () => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const ownershipCss = integrationCss.slice(integrationCss.indexOf(OWNERSHIP_MARKER));
    const rule = readRule(
      ownershipCss,
      ":root[data-theme='ocean'] body .game-page-layout .chat-flow",
    );

    expect(rule).toContain('var(--abyssal-chassis)');
    expect(rule).toMatch(/background-size:\s*100% 100%,\s*200% auto;/);
  });

  it('forest uses live herbarium paper instead of a framed viewport raster', () => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const fidelityStart = integrationCss.indexOf(JADE_FIDELITY_MARKER);
    const fidelityCss = integrationCss.slice(fidelityStart);
    const rule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .chat-flow",
    );

    expect(fidelityStart).toBeGreaterThanOrEqual(0);
    expect(rule).toContain('var(--forest-parchment-texture)');
    expect(rule).toContain('var(--forest-jade-frame)');
    expect(rule).not.toContain('--forest-chassis');
    expect(fidelityCss).toContain('var(--forest-herbarium-sprig)');
  });

  it('forest active tabs do not alter the base tab geometry', () => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const fidelityStart = integrationCss.indexOf(JADE_FIDELITY_MARKER);
    const fidelityCss = integrationCss.slice(fidelityStart);
    const baseRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .tab-item {",
    );
    const activeRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .tab-active {",
    );

    expect(fidelityStart).toBeGreaterThanOrEqual(0);
    expect(baseRule).toContain('box-sizing: border-box');
    expect(baseRule).toContain('background-image: var(--forest-jade-tab)');
    expect(activeRule).toContain('background-image: var(--forest-jade-tab)');
    expect(activeRule).not.toMatch(/\b(?:margin|padding|width|height|transform)\s*:/);
    expect(activeRule).not.toMatch(/border-width\s*:/);
  });

  it('forest keeps the notebook hinges at the four corners', () => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const fidelityCss = integrationCss.slice(integrationCss.indexOf(JADE_FIDELITY_MARKER));
    const rule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .chat-flow::before,",
    );

    expect(rule.match(/var\(--forest-binding-clasp\)/g)).toHaveLength(2);
    expect(rule).toContain('center 7%');
    expect(rule).toContain('center 93%');
    expect(rule).not.toContain('center 34%');
    expect(rule).not.toContain('center 66%');
  });

  it('forest keeps stretched panel artwork off the composer', () => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const fidelityCss = integrationCss.slice(integrationCss.indexOf(JADE_FIDELITY_MARKER));
    const inputBarRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .input-bar {",
    );
    const sendButtonRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .input-btn,",
    );

    expect(inputBarRule).toContain('border-image: var(--forest-jade-frame)');
    expect(inputBarRule).toContain('background-image: none');
    expect(inputBarRule).not.toContain('var(--forest-jade-tab)');
    expect(sendButtonRule).toContain('background-image: var(--forest-jade-tab)');
  });

  it('forest exposes the generated material assets through theme tokens', () => {
    const themeCss = readFileSync(join(UI_ROOT, 'themes', 'forest.css'), 'utf8');

    expect(themeCss).toContain('herbarium-parchment.webp');
    expect(themeCss).toContain('jade-panel-frame.png');
    expect(themeCss).toContain('jade-tab-polished.png');
    expect(themeCss).toContain('jade-binding-clasp.png');
  });

  it('keeps Orrery artwork frame-free and uniformly covered', () => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const ownershipCss = integrationCss.slice(integrationCss.indexOf(OWNERSHIP_MARKER));
    const rule = readRule(ownershipCss, ":root[data-theme='obsidian'] body .game-page-layout {");

    expect(rule).toContain('gilded-orrery-field-v2.webp');
    expect(rule).toMatch(/background-size:\s*100% 100%,\s*cover;/);
  });
});
