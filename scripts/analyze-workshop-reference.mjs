#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const DEFAULT_INPUT = 'reference/workshop-reference';
const VALID_REGEX_FLAGS = 'dgimsuvy';
const NON_NETWORK_NAMESPACE_ORIGINS = new Set([
  'http://sodipodi.sourceforge.net',
  'http://www.inkscape.org',
  'http://www.w3.org',
]);

function parseArgs(argv) {
  const args = { apply: false, input: DEFAULT_INPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--input') args.input = argv[++index];
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/analyze-workshop-reference.mjs [options]

Analyze every regex entry in a fetched Creative Workshop reference corpus.
Without --apply the report is printed but analysis-data.json is not written.

Options:
  --apply          Write analysis-data.json inside the corpus
  --input <path>   Corpus directory (${DEFAULT_INPUT})
  --help           Show this message`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCounts(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function parseFindRegex(findRegex) {
  const bare = { pattern: findRegex, flags: '', delimited: false };
  if (findRegex.length < 2 || findRegex[0] !== '/') return bare;
  let close = -1;
  for (let index = findRegex.length - 1; index > 0; index -= 1) {
    if (findRegex[index] !== '/') continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && findRegex[cursor] === '\\'; cursor -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      close = index;
      break;
    }
  }
  if (close <= 0) return bare;
  const flags = findRegex.slice(close + 1);
  const seen = new Set();
  for (const flag of flags) {
    if (!VALID_REGEX_FLAGS.includes(flag) || seen.has(flag)) return bare;
    seen.add(flag);
  }
  return { pattern: findRegex.slice(1, close), flags, delimited: true };
}

function findOrigins(value) {
  const origins = new Set();
  const urls = value.match(/https?:\/\/[^\s"'<>`\\)\]}]+/gi) ?? [];
  for (const rawUrl of urls) {
    try {
      const origin = new URL(rawUrl).origin.toLowerCase();
      if (!NON_NETWORK_NAMESPACE_ORIGINS.has(origin)) origins.add(origin);
    } catch {
      // Captures or malformed author strings are not loadable static origins.
    }
  }
  return [...origins];
}

function inspectDom(value) {
  const fragment = JSDOM.fragment(value);
  const attributes = new Set();
  const eventHandlers = new Set();
  const origins = new Set();
  const tags = new Map();
  let inlineStyleCount = 0;
  let remoteAttributeCount = 0;

  const collectOrigins = (source) => {
    for (const origin of findOrigins(source)) origins.add(origin);
  };

  for (const element of fragment.querySelectorAll('*')) {
    increment(tags, element.tagName.toLowerCase());
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      attributes.add(name);
      if (name.startsWith('on')) {
        eventHandlers.add(name);
        collectOrigins(attribute.value);
      }
      if (name === 'style') {
        inlineStyleCount += 1;
        collectOrigins(attribute.value);
      }
      if (
        ['src', 'href', 'poster', 'action', 'formaction', 'srcset', 'data'].includes(name) &&
        /https?:\/\//i.test(attribute.value)
      ) {
        remoteAttributeCount += 1;
        collectOrigins(attribute.value);
      }
    }
    if (['STYLE', 'SCRIPT'].includes(element.tagName)) collectOrigins(element.textContent ?? '');
  }

  return {
    attributes,
    eventHandlers,
    inlineStyleCount,
    remoteAttributeCount,
    origins: [...origins],
    tags,
  };
}

function has(value, expression) {
  return expression.test(value);
}

function classify(features) {
  if (features.fullDocument) return 'full-document';
  if (features.scriptTag || features.eventHandler || features.javascriptUrl) return 'executable';
  if (
    features.styleTag ||
    features.svg ||
    features.inlineStyle ||
    features.controls ||
    features.media ||
    features.canvas
  ) {
    return 'rich-static';
  }
  if (features.html) return 'html-fragment';
  return 'plain-text';
}

async function atomicWrite(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, value);
  await rename(temporaryPath, path);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const inputRoot = resolve(args.input);
  const manifest = JSON.parse(await readFile(join(inputRoot, 'manifest.json'), 'utf8'));
  const featureCounts = new Map();
  const classCounts = new Map();
  const flagSets = new Map();
  const tagRuleCounts = new Map();
  const tagOccurrenceCounts = new Map();
  const attributeRuleCounts = new Map();
  const eventHandlerRuleCounts = new Map();
  const originRules = new Map();
  const projectRegexCounts = new Map();
  const duplicateIds = [];
  const rules = [];
  let compileFailures = 0;
  let delimitedPatterns = 0;
  let barePatterns = 0;
  let maxCaptureReference = 0;

  for (const project of manifest.projects) {
    const entries = JSON.parse(await readFile(join(inputRoot, project.regexFile), 'utf8'));
    projectRegexCounts.set(project.id, entries.length);
    const seenIds = new Set();

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const findRegex = typeof entry.findRegex === 'string' ? entry.findRegex : '';
      const replacement = typeof entry.replaceString === 'string' ? entry.replaceString : '';
      const parsed = parseFindRegex(findRegex);
      parsed.delimited ? (delimitedPatterns += 1) : (barePatterns += 1);
      increment(flagSets, parsed.flags || '(none)');

      let compiles = true;
      try {
        new RegExp(parsed.pattern, parsed.flags);
      } catch {
        compiles = false;
        compileFailures += 1;
      }

      const id = typeof entry.id === 'string' ? entry.id : `#${index}`;
      if (seenIds.has(id)) duplicateIds.push({ projectId: project.id, id, index });
      seenIds.add(id);

      const dom = inspectDom(replacement);
      const tags = dom.tags;
      for (const [tag, count] of tags) {
        increment(tagRuleCounts, tag);
        increment(tagOccurrenceCounts, tag, count);
      }
      for (const attribute of dom.attributes) increment(attributeRuleCounts, attribute);
      for (const eventHandler of dom.eventHandlers) increment(eventHandlerRuleCounts, eventHandler);

      const origins = dom.origins;
      for (const origin of origins) {
        if (!originRules.has(origin)) originRules.set(origin, new Set());
        originRules.get(origin).add(`${project.id}:${id}`);
      }

      const captureReferences = [...replacement.matchAll(/\$(\d{1,2})/g)].map((match) =>
        Number(match[1]),
      );
      if (captureReferences.length > 0) {
        maxCaptureReference = Math.max(maxCaptureReference, ...captureReferences);
      }

      const features = {
        html: has(replacement, /<[a-z][\w:-]*[\s>]/i),
        markdownFence: has(replacement, /^\s*```/),
        fullDocument: has(replacement, /<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i),
        styleTag: has(replacement, /<style[\s>]/i),
        inlineStyle: dom.inlineStyleCount > 0,
        scriptTag: has(replacement, /<script[\s>]/i),
        eventHandler: dom.eventHandlers.size > 0,
        javascriptUrl: has(replacement, /(?:href|src|action)\s*=\s*["']?\s*javascript:/i),
        metaRefresh: has(replacement, /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i),
        directLocationNavigation: has(
          replacement,
          /\b(?:(?:window|globalThis|document)\s*\.\s*)?location\s*(?:=|\.\s*(?:href\s*=|assign\s*\(|replace\s*\())/i,
        ),
        svg: has(replacement, /<svg[\s>]/i),
        controls: has(
          replacement,
          /<(?:input|button|select|textarea|form|label|details|summary)[\s>]/i,
        ),
        media: has(replacement, /<(?:img|picture|audio|video|source|track)[\s>]/i),
        canvas: has(replacement, /<canvas[\s>]/i),
        iframe: has(replacement, /<(?:iframe|frame)[\s>]/i),
        objectEmbed: has(replacement, /<(?:object|embed)[\s>]/i),
        remoteOrigin: origins.length > 0,
        dataUrl: has(replacement, /data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,]/i),
        blobUrl: has(replacement, /\bblob:/i),
        cssImport: has(replacement, /@import\b/i),
        cssUrl: has(replacement, /url\s*\(/i),
        networkApi: has(
          replacement,
          /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*(?:\.|\()/,
        ),
        worker: has(replacement, /\b(?:SharedWorker|Worker)\s*\(/),
        parentAccess: has(
          replacement,
          /\b(?:window\s*\.\s*(?:parent|top|opener)|parent\s*\.|top\s*\.\s*document|opener\s*\.)/,
        ),
        browserStorage: has(replacement, /\b(?:localStorage|sessionStorage|indexedDB)\b/),
        hostApi: has(
          replacement,
          /\b(?:SillyTavern|getContext|getVariables|setVariables|tavern_events|SlashCommandParser|eventSource)\b/,
        ),
        captureReference: captureReferences.length > 0,
        namedCaptureReference: has(replacement, /\$<[^>]+>/),
        replacementSpecialToken: has(replacement, /\$(?:[$&'`]|\d{1,2}|<[^>]+>)/),
        handlebarsMacro: has(replacement, /\{\{[^}]+\}\}/),
        ejsMacro: has(replacement, /<%[=-]?/),
        lookbehindPattern: has(parsed.pattern, /\(\?<(?!!|=)/),
        namedCapturePattern: has(parsed.pattern, /\(\?<[^=!][^>]*>/),
        unicodePropertyPattern: has(parsed.pattern, /\\[pP]\{/),
        findPatternMacro: has(parsed.pattern, /\{\{[^}]+\}\}/),
      };
      const classification = classify(features);
      increment(classCounts, classification);
      for (const [feature, present] of Object.entries(features)) {
        if (present) increment(featureCounts, feature);
      }

      rules.push({
        projectId: project.id,
        projectName: project.name,
        projectVersion: project.version,
        id,
        scriptName: typeof entry.scriptName === 'string' ? entry.scriptName : '',
        index,
        enabledUpstream: entry.disabled !== true,
        markdownOnly: entry.markdownOnly === true,
        promptOnly: entry.promptOnly === true,
        runOnEdit: entry.runOnEdit === true,
        substituteRegex: Number.isFinite(entry.substituteRegex) ? entry.substituteRegex : 0,
        minDepth: Number.isFinite(entry.minDepth) ? entry.minDepth : null,
        maxDepth: Number.isFinite(entry.maxDepth) ? entry.maxDepth : null,
        placement: Array.isArray(entry.placement) ? entry.placement : [],
        trimStringCount: Array.isArray(entry.trimStrings) ? entry.trimStrings.length : 0,
        patternLength: findRegex.length,
        parsedPatternLength: parsed.pattern.length,
        flags: parsed.flags,
        delimited: parsed.delimited,
        compiles,
        replacementLength: replacement.length,
        patternSha256: sha256(findRegex),
        replacementSha256: sha256(replacement),
        tags: [...tags.keys()].sort(),
        attributes: [...dom.attributes].sort(),
        eventHandlers: [...dom.eventHandlers].sort(),
        inlineStyleCount: dom.inlineStyleCount,
        remoteAttributeCount: dom.remoteAttributeCount,
        origins,
        maxCaptureReference: captureReferences.length > 0 ? Math.max(...captureReferences) : 0,
        classification,
        features,
      });
    }
  }

  const countField = (predicate) => rules.filter(predicate).length;
  const analysis = {
    schemaVersion: 1,
    analyzedAt: new Date().toISOString(),
    sourceFetchedAt: manifest.fetchedAt,
    corpus: manifest.completeness,
    regex: {
      projectsWithRegex: [...projectRegexCounts.values()].filter((count) => count > 0).length,
      totalEntries: rules.length,
      upstreamEnabled: countField((rule) => rule.enabledUpstream),
      upstreamDisabled: countField((rule) => !rule.enabledUpstream),
      promptOnly: countField((rule) => rule.promptOnly),
      markdownOnly: countField((rule) => rule.markdownOnly),
      runOnEdit: countField((rule) => rule.runOnEdit),
      nonzeroSubstituteRegex: countField((rule) => rule.substituteRegex !== 0),
      activeSubstituteRegex: countField(
        (rule) => rule.substituteRegex !== 0 && rule.features.findPatternMacro,
      ),
      depthConstrained: countField((rule) => rule.minDepth !== null || rule.maxDepth !== null),
      placementConstrained: countField((rule) => rule.placement.length > 0),
      placementSets: sortedCounts(
        rules.reduce((counts, rule) => {
          increment(counts, JSON.stringify(rule.placement));
          return counts;
        }, new Map()),
      ),
      minDepthValues: sortedCounts(
        rules.reduce((counts, rule) => {
          if (rule.minDepth !== null) increment(counts, String(rule.minDepth));
          return counts;
        }, new Map()),
      ),
      maxDepthValues: sortedCounts(
        rules.reduce((counts, rule) => {
          if (rule.maxDepth !== null) increment(counts, String(rule.maxDepth));
          return counts;
        }, new Map()),
      ),
      trimStrings: countField((rule) => rule.trimStringCount > 0),
      delimitedPatterns,
      barePatterns,
      compileFailures,
      duplicateIdsWithinProject: duplicateIds,
      maxCaptureReference,
      flagSets: sortedCounts(flagSets),
      classification: sortedCounts(classCounts),
      features: sortedCounts(featureCounts),
    },
    html: {
      tagsByRuleCount: sortedCounts(tagRuleCounts),
      tagsByOccurrence: sortedCounts(tagOccurrenceCounts),
      attributesByRuleCount: sortedCounts(attributeRuleCounts),
      eventHandlersByRuleCount: sortedCounts(eventHandlerRuleCounts),
    },
    networkOrigins: [...originRules.entries()]
      .map(([origin, refs]) => ({ origin, ruleCount: refs.size, rules: [...refs].sort() }))
      .sort(
        (left, right) =>
          right.ruleCount - left.ruleCount || left.origin.localeCompare(right.origin),
      ),
    rules,
  };

  if (args.apply) {
    await atomicWrite(
      join(inputRoot, 'analysis-data.json'),
      `${JSON.stringify(analysis, null, 2)}\n`,
    );
  }

  console.log(
    JSON.stringify(
      {
        apply: args.apply,
        sourceFetchedAt: manifest.fetchedAt,
        projects: manifest.completeness.uniqueProjectIds,
        projectsWithRegex: analysis.regex.projectsWithRegex,
        regexEntries: rules.length,
        compileFailures,
        classification: analysis.regex.classification,
        features: analysis.regex.features,
        networkOrigins: analysis.networkOrigins.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
