/**
 * Story output projection.
 *
 * The model-facing response is a structured envelope. This module is the one
 * seam that turns that envelope into player-visible prose and action options,
 * both while streaming and after completion.
 */

import { stripPlayAudioMarkers } from './marker-protocol';

export interface StoryProjection {
  content: string;
  options: string[];
}

const LEADING_FENCE = /^\s*```[^\n]*\n?/;
const TRAILING_FENCE = /\n?\s*```\s*$/;
const MAIN_TEXT_OPEN = /<maintext\b[^>]*>/gi;
const MAIN_TEXT_CLOSE = /<\/maintext\s*>/i;
const STREAM_MAIN_TEXT_OPEN = /(?:^|\r?\n)[ \t]*<maintext\b[^>]*>/gi;
const CONTROL_TAGS = ['options', 'option', 'sum', 'vars', 'thinking', 'think', 'summary'];
const STREAM_CONTROL_TAGS = ['maintext', 'play_audio', ...CONTROL_TAGS];

function stripCodeFences(text: string): string {
  return text.replace(LEADING_FENCE, '').replace(TRAILING_FENCE, '');
}

function lastMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  pattern.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) last = match;
  return last;
}

function extractMainText(raw: string): string {
  const open = lastMatch(raw, MAIN_TEXT_OPEN);
  if (!open) return raw;

  const afterOpen = raw.slice(open.index + open[0].length);
  const close = MAIN_TEXT_CLOSE.exec(afterOpen);
  return close ? afterOpen.slice(0, close.index) : afterOpen;
}

function parseOptionLines(body: string, requireNumber: boolean): string[] {
  const options: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const numbered = line.match(/^\d+\s*(?:[.、．)）:：-]\s*|\s+)(.+)$/);
    if (numbered) {
      const value = numbered[1].trim();
      if (value) options.push(value);
    } else if (!requireNumber) {
      options.push(line);
    }
  }
  return options;
}

function extractOptions(raw: string): string[] {
  const options: string[] = [];
  const block = /<(options|option)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = block.exec(raw)) !== null) {
    options.push(...parseOptionLines(match[2], match[1].toLowerCase() === 'options'));
  }

  const lastOpen = lastMatch(raw, /<(options|option)\b[^>]*>/gi);
  if (lastOpen) {
    const tag = lastOpen[1].toLowerCase();
    const tail = raw.slice(lastOpen.index + lastOpen[0].length);
    if (!new RegExp(`<\\/${tag}\\s*>`, 'i').test(tail)) {
      options.push(...parseOptionLines(tail.split(/<\/?[a-z]/i)[0], tag === 'options'));
    }
  }
  return options;
}

function stripControlSection(text: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const complete = new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}\\s*>`, 'gi');
  let result = text.replace(complete, '');

  const open = new RegExp(`<${escaped}\\b[^>]*>`, 'gi');
  const close = new RegExp(`<\\/${escaped}\\s*>`, 'gi');
  const lastOpen = lastMatch(result, open);
  const lastClose = lastMatch(result, close);
  if (lastOpen && (!lastClose || lastOpen.index > lastClose.index)) {
    result = result.slice(0, lastOpen.index);
  }

  return result.replace(new RegExp(`<\\/?${escaped}\\b[^>]*>`, 'gi'), '');
}

function stripTrailingPartialControlTag(text: string): string {
  const start = text.lastIndexOf('<');
  if (start < 0 || text.indexOf('>', start) >= 0) return text;

  const fragment = text.slice(start).toLowerCase();
  const isControlFragment = STREAM_CONTROL_TAGS.some((tag) => {
    const open = `<${tag}`;
    const close = `</${tag}`;
    return open.startsWith(fragment) || close.startsWith(fragment) || fragment.startsWith(open);
  });
  return isControlFragment || fragment === '<' || fragment === '</' ? text.slice(0, start) : text;
}

function project(raw: string, partial: boolean): StoryProjection {
  const options = extractOptions(raw);
  let content = extractMainText(stripCodeFences(raw));

  for (const tag of CONTROL_TAGS) content = stripControlSection(content, tag);

  if (partial) content = stripTrailingPartialControlTag(content);

  content = stripPlayAudioMarkers(content)
    .replace(/<\/?maintext\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { content, options };
}

/** Normalize a completed story response for persistence and rendering. */
export function projectStoryOutput(raw: string): StoryProjection {
  return project(raw, false);
}

/** Normalize the accumulated raw response while it is still streaming. */
export function projectStreamingStory(raw: string): string {
  // The story prompt requires a <maintext> envelope. Buffer everything before its
  // opener so content-channel reasoning cannot flash in the player-facing preview.
  // Completed output still keeps the bare-text compatibility fallback above.
  if (!lastMatch(stripCodeFences(raw), STREAM_MAIN_TEXT_OPEN)) return '';
  return project(raw, true).content;
}
