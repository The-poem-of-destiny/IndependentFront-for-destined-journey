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

function readRule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  const end = css.indexOf('}', start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return css.slice(start, end + 1);
}

function readLastRule(css: string, selector: string): string {
  const start = css.lastIndexOf(selector);
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

  it.each([
    ['forest', '--forest-chassis'],
    ['ocean', '--abyssal-chassis'],
  ])('%s keeps its framed narrative raster uniformly scaled', (theme, assetVariable) => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const ownershipCss = integrationCss.slice(integrationCss.indexOf(OWNERSHIP_MARKER));
    const rule = readRule(
      ownershipCss,
      `:root[data-theme='${theme}'] body .game-page-layout .chat-flow`,
    );

    expect(rule).toContain(`var(${assetVariable})`);
    expect(rule).toMatch(/background-size:\s*100% 100%,\s*200% auto;/);
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

  it('keeps the Crimson right-panel artwork covered at wide viewports', () => {
    const crimsonCss = readFileSync(join(UI_ROOT, 'themes', 'crimson.css'), 'utf8');
    const rule = readLastRule(
      crimsonCss,
      ":root[data-theme='crimson'] body .game-page-layout .status-hud::after",
    );

    expect(rule).toContain('background-image: var(--crimson-right-panel);');
    expect(rule).toContain('background-size: cover;');
    expect(rule).toContain('background-position: right bottom;');
  });

  it('slides one shared Crimson cap between stationary tab buttons', () => {
    const crimsonCss = readFileSync(join(UI_ROOT, 'themes', 'crimson.css'), 'utf8');
    const appTabs = readFileSync(join(UI_ROOT, 'components', 'shared', 'AppTabs.vue'), 'utf8');
    const activeTabRule = readLastRule(
      crimsonCss,
      ":root[data-theme='crimson'] body .game-page-layout .hold-body > .tab-bar .tab-active {",
    );

    expect(appTabs).toContain('class="tab-selection"');
    expect(appTabs).toContain("'--tab-selection-offset': `${activeIndex * 100}%`");
    expect(appTabs).toContain("'--tab-selection-width': `${100 / count}%`");
    expect(crimsonCss).toContain('background-image: var(--crimson-tab-cap);');
    expect(crimsonCss).toContain('transform: translateX(var(--tab-selection-offset));');
    expect(crimsonCss).toContain('transition: transform 180ms ease;');
    expect(activeTabRule).toContain('transform: none !important;');
    expect(crimsonCss).not.toContain('translateY(3px)');
    expect(crimsonCss).not.toContain('.tab-active::before');
    expect(crimsonCss).not.toContain('animation:');
    expect(crimsonCss).not.toContain('@keyframes');
  });
});
