/**
 * Phase 10a: Template Resolver — Unified {{PLACEHOLDER}} Resolution Engine
 *
 * Resolves placeholders in template strings by consulting:
 * 1. localParams (highest priority — chain caller overrides)
 * 2. PLACEHOLDER_REGISTRY (global resolvers from placeholder-registry)
 * 3. Keep as-is (unrecognized placeholders pass through unchanged)
 *
 * Placeholder syntax:
 *   {{NAME}}                        — basic
 *   {{NAME:key1=val1:key2=val2}}    — with params (params passed as Record<string,string>)
 */

import { PLACEHOLDER_REGISTRY, setPlaceholderGlobals } from './placeholder-registry';
import type { AgentContext, AgentConfig, WorldBook } from './types';

// ═══════════════════════════════════════════════════════════
// Regex & Parsing
// ═══════════════════════════════════════════════════════════

/**
 * Matches {{NAME}} and {{NAME:key1=val1:key2=val2}} patterns.
 *
 * Rules:
 * - Name must start with uppercase A-Z
 * - Name can contain uppercase A-Z, underscore, and dot
 * - Optional params separated by colons, each as key=value
 *
 * Capturing groups:
 * - Group 1: placeholder name
 * - Group 2: optional params string (colon-separated key=value pairs)
 */
const PLACEHOLDER_RE = /\{\{([A-Z][A-Z_.]*)(?::([^}]*))?\}\}/g;

/**
 * Parse a params string into a Record<string, string>.
 *
 * Format: "key1=val1:key2=val2" → { key1: "val1", key2: "val2" }
 *
 * Edge cases handled:
 * - Empty string → empty object
 * - Trailing colons are ignored
 * - Empty key=value pairs are skipped
 * - Values may contain '=' (split only on first '=')
 * - Newlines in params are stripped
 */
export function parseParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!raw) return params;

  const segments = raw.split(':');
  for (const segment of segments) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx <= 0 || eqIdx >= segment.length - 1) continue; // skip empty key or value
    const key = segment.slice(0, eqIdx).trim();
    const value = segment.slice(eqIdx + 1).trim();
    if (key) {
      params[key] = value;
    }
  }

  return params;
}

/**
 * Find the next {{...}} placeholder in a string starting from a given position.
 * Returns [fullMatch, name, paramsString, startIndex] or null if none found.
 *
 * Exposed for testing the internal regex behavior.
 */
export function findNextPlaceholder(
  template: string,
  startPos: number = 0,
): [string, string, string, number] | null {
  // Reset regex state for fresh search
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  re.lastIndex = startPos;
  const match = re.exec(template);
  if (!match) return null;
  return [match[0], match[1], match[2] ?? '', match.index];
}

// ═══════════════════════════════════════════════════════════
// Core Resolution
// ═══════════════════════════════════════════════════════════

/**
 * Resolve a single placeholder by name with params.
 *
 * Resolution order:
 * 1. localParams[name] — highest priority
 * 2. PLACEHOLDER_REGISTRY[name] — global resolver function
 * 3. undefined — placeholder is unknown
 *
 * @returns The resolved string, or undefined if the placeholder is unrecognized.
 */
function resolvePlaceholder(
  name: string,
  params: Record<string, string>,
  ctx: AgentContext,
  config: AgentConfig,
  localParams?: Record<string, string>,
): string | undefined {
  // 1. Local params override
  if (localParams && name in localParams) {
    return localParams[name];
  }

  // 2. Global registry
  const resolver = PLACEHOLDER_REGISTRY[name];
  if (resolver) {
    const result = resolver(ctx, config, params);
    // Allow resolvers to return undefined (treat as unresolved)
    if (result === undefined) return undefined;
    return String(result);
  }

  // 3. Unknown placeholder — leave as-is
  return undefined;
}

/**
 * Resolve a template string by replacing all {{PLACEHOLDER}} references with their resolved values.
 *
 * Resolution order:
 * 1. localParams (highest priority — chain caller overrides)
 * 2. PLACEHOLDER_REGISTRY (global resolvers)
 * 3. Keep as-is (unrecognized placeholders are not replaced)
 *
 * Placeholder syntax:
 *   {{NAME}}                    — basic
 *   {{NAME:key1=val1:key2=val2}} — with params (params passed as Record<string,string>)
 *
 * @param template - The template string containing {{PLACEHOLDER}} references
 * @param agentId - The agent ID (for context-sensitive resolvers)
 * @param ctx - AgentContext with all runtime data
 * @param config - AgentConfig with per-agent settings
 * @param localParams - Optional local overrides (chain caller injected values)
 * @returns The resolved template with all placeholders replaced
 */
export function resolveTemplate(
  template: string,
  agentId: string,
  ctx: AgentContext,
  config: AgentConfig,
  localParams?: Record<string, string>,
): string {
  if (!template) return template;

  // Reset the regex for a fresh global scan
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');

  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(template)) !== null) {
    const [fullMatch, name, rawParams] = match;
    const matchIndex = match.index;

    // Append text between last match and this one
    result += template.slice(lastIndex, matchIndex);

    // Parse params
    const params = parseParams(rawParams ?? '');

    // Resolve
    const resolved = resolvePlaceholder(name, params, ctx, config, localParams);

    if (resolved !== undefined) {
      result += resolved;
    } else {
      // Unknown placeholder — keep as-is
      result += fullMatch;
    }

    lastIndex = matchIndex + fullMatch.length;
  }

  // Append remaining text after last match
  result += template.slice(lastIndex);

  return result;
}

// ═══════════════════════════════════════════════════════════
// Convenience Functions
// ═══════════════════════════════════════════════════════════

/**
 * Resolve a template with global state pre-set.
 *
 * This is the preferred entry point when calling from buildAgentMessages or
 * similar context where worldBooks and all agent configs are available.
 * It calls setPlaceholderGlobals() before resolving so that resolvers can
 * access cross-agent and world-book data.
 *
 * @param template - The template string containing {{PLACEHOLDER}} references
 * @param agentId - The agent ID
 * @param ctx - AgentContext with all runtime data
 * @param config - AgentConfig with per-agent settings
 * @param worldBooks - All world books (for cross-reference resolvers)
 * @param configs - All agent configs (for AGENT.* placeholders)
 * @param localParams - Optional local overrides
 * @returns The resolved template
 */
export function resolveTemplateWithGlobals(
  template: string,
  agentId: string,
  ctx: AgentContext,
  config: AgentConfig,
  worldBooks: WorldBook[],
  configs: AgentConfig[],
  localParams?: Record<string, string>,
): string {
  setPlaceholderGlobals(worldBooks, configs);
  return resolveTemplate(template, agentId, ctx, config, localParams);
}

/**
 * Resolve multiple template strings at once (for sections of a prompt).
 * Each template is resolved independently; localParams are shared.
 *
 * @returns Array of resolved strings in the same order as input templates.
 */
export function resolveTemplates(
  templates: string[],
  agentId: string,
  ctx: AgentContext,
  config: AgentConfig,
  localParams?: Record<string, string>,
): string[] {
  return templates.map((tpl) => resolveTemplate(tpl, agentId, ctx, config, localParams));
}
