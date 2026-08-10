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
const NOCTURNE_FIDELITY_MARKER = 'Nocturne Sakura raden fidelity pass';

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

  it('forest keeps button-scale artwork off the full-height tool rail', () => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const fidelityCss = integrationCss.slice(integrationCss.indexOf(JADE_FIDELITY_MARKER));
    const railRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .side-toolbar {",
    );
    const buttonRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .top-btn,",
    );

    expect(railRule).toContain('background-image: none');
    expect(railRule).not.toContain('var(--forest-jade-tab)');
    expect(railRule).not.toContain('background-size: 100% 88px');
    expect(buttonRule).toContain('var(--forest-parchment-texture)');
    expect(buttonRule).toContain('var(--forest-jade-frame)');
  });

  it('forest keeps a desktop half-width rail with text-safe buttons', () => {
    const integrationCss = readFileSync(
      join(UI_ROOT, 'styles', 'integrated-game-surfaces.css'),
      'utf8',
    );
    const fidelityCss = integrationCss.slice(integrationCss.indexOf(JADE_FIDELITY_MARKER));
    const railWidthRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .game-body {",
    );
    const collapseRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .side-toolbar > .collapse-toggle {",
    );
    const collapsedRailRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .game-body.rail-collapsed {",
    );
    const labelRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .side-toolbar .tool-label {",
    );
    const buttonRule = readRule(
      fidelityCss,
      ":root[data-theme='forest'] body .game-page-layout .side-toolbar .tool-btn {",
    );

    expect(railWidthRule).toContain('--rail-w: 2.7rem');
    expect(fidelityCss).toMatch(
      /@media \(min-width: 1200px\) \{[\s\S]*?--rail-w: 2\.7rem;[\s\S]*?\}/,
    );
    expect(collapsedRailRule).toContain('--rail-w: 2.7rem');
    expect(collapseRule).toContain('display: none');
    expect(labelRule).toContain('display: inline !important');
    expect(buttonRule).toContain('margin-inline: 1px');
    expect(buttonRule).toContain('padding: 4px 0');
    expect(buttonRule).toContain('border-image-width: 3px');
    expect(fidelityCss).not.toContain('> .tool-btn > .tool-label');
  });

  it('forest exposes the generated material assets through theme tokens', () => {
    const themeCss = readFileSync(join(UI_ROOT, 'themes', 'forest.css'), 'utf8');

    expect(themeCss).toContain('herbarium-parchment.webp');
    expect(themeCss).toContain('jade-panel-frame.png');
    expect(themeCss).toContain('jade-tab-polished.png');
    expect(themeCss).toContain('jade-binding-clasp.png');
  });

  it('sakura keeps the message surface clean while its live frame owns the inlay', () => {
    const themeCss = readFileSync(join(UI_ROOT, 'themes', 'sakura.css'), 'utf8');
    const fidelityStart = themeCss.indexOf(NOCTURNE_FIDELITY_MARKER);
    const fidelityCss = themeCss.slice(fidelityStart);
    const chatRule = readRule(
      fidelityCss,
      ":root[data-theme='sakura'] body .game-page-layout .chat-flow {",
    );
    const playerMessageRule = readRule(
      fidelityCss,
      ":root[data-theme='sakura'] body .game-page-layout .bubble-player {",
    );
    const cornerRule = readRule(
      fidelityCss,
      ":root[data-theme='sakura'] body .game-page-layout .chat-flow::before,",
    );

    expect(fidelityStart).toBeGreaterThanOrEqual(0);
    expect(chatRule).toContain('background-color: #06080c');
    expect(chatRule).toContain('animation: none');
    expect(chatRule).not.toContain('var(--sakura-petals)');
    expect(chatRule).not.toContain('var(--sakura-field)');
    expect(playerMessageRule).toContain('background: transparent');
    expect(playerMessageRule).toContain('border: 0');
    expect(playerMessageRule).toContain('box-shadow: none');
    expect(cornerRule).toContain('var(--sakura-raden-corner)');
    expect(cornerRule).toContain('pointer-events: none');
  });

  it('sakura keeps shell and rare gold accents on authored frame nodes', () => {
    const themeCss = readFileSync(join(UI_ROOT, 'themes', 'sakura.css'), 'utf8');
    const fidelityCss = themeCss.slice(themeCss.indexOf(NOCTURNE_FIDELITY_MARKER));
    const branchRule = readRule(
      fidelityCss,
      ":root[data-theme='sakura'] body .game-page-layout .scene-panel::before {",
    );
    const titleRule = readRule(
      fidelityCss,
      ":root[data-theme='sakura'] body .game-page-layout .top-title {",
    );
    const composerAccentRule = readRule(
      fidelityCss,
      ":root[data-theme='sakura'] body .game-page-layout .input-bar::after {",
    );
    const topFrameRule = readRule(
      fidelityCss,
      ":root[data-theme='sakura'] body .game-page-layout .top-bar {",
    );

    expect(themeCss).toContain('raden-sakura-branch.png');
    expect(themeCss).toContain('raden-corner-inlay.png');
    expect(themeCss).toContain('raden-seal-accent.png');
    expect(branchRule).toContain('var(--sakura-raden-branch)');
    expect(branchRule).toContain('pointer-events: none');
    expect(titleRule).toContain('var(--sakura-raden-seal)');
    expect(composerAccentRule).toContain('var(--sakura-raden-seal)');
    expect(topFrameRule).toContain('var(--sakura-frame-line)');
    expect(topFrameRule).not.toContain('var(--sakura-gold)');
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
