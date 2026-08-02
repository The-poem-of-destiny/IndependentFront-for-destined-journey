#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const API_BASE = 'https://poemofdestinycreativeworkshop.1528779666.workers.dev';
const DEFAULT_OUTPUT = 'reference/workshop-reference';
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 6;
const RETRY_DELAYS_MS = [500, 1_500, 4_000];

function parseArgs(argv) {
  const args = {
    apply: false,
    output: DEFAULT_OUTPUT,
    pageSize: DEFAULT_PAGE_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--page-size') args.pageSize = Number(argv[++index]);
    else if (arg === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(args.pageSize) || args.pageSize < 1) {
    throw new Error('--page-size must be a positive integer');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 16) {
    throw new Error('--concurrency must be an integer from 1 to 16');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/fetch-workshop-reference.mjs [options]

Fetch the public Creative Workshop catalog, every project detail response, and
every advertised project payload. Without --apply this is a read-only dry run.

Options:
  --apply                 Write the fetched corpus
  --output <path>         Output directory (${DEFAULT_OUTPUT})
  --page-size <number>    Public list page size (${DEFAULT_PAGE_SIZE})
  --concurrency <number>  Detail/payload request concurrency (${DEFAULT_CONCURRENCY})
  --help                  Show this message`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeProjectId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe or missing project id: ${id}`);
  return id;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchBytes(url) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok && (response.status === 429 || response.status >= 500)) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.bytes = bytes;
        error.response = response;
        throw error;
      }
      return { response, bytes };
    } catch (error) {
      lastError = error;
      if (error?.status && error.status < 500 && error.status !== 429) break;
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function parseJson(bytes, url) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Malformed JSON from ${url}: ${error.message}`);
  }
}

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, data);
  await rename(temporaryPath, path);
}

async function maybeExistingHash(path) {
  try {
    const file = await readFile(path);
    return sha256(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeFetched(outputRoot, relativePath, fetched, apply) {
  const absolutePath = join(outputRoot, relativePath);
  const digest = sha256(fetched.bytes);
  const unchanged = (await maybeExistingHash(absolutePath)) === digest;
  if (apply && !unchanged) await atomicWrite(absolutePath, fetched.bytes);
  return {
    file: relative(outputRoot, absolutePath).replaceAll('\\', '/'),
    sha256: digest,
    bytes: fetched.bytes.length,
    unchanged,
  };
}

function responseEvidence(kind, url, fetched, saved, fetchedAt, extra = {}) {
  const headers = fetched.response.headers;
  return {
    kind,
    ...extra,
    url,
    finalUrl: fetched.response.url,
    status: fetched.response.status,
    fetchedAt,
    contentType: headers.get('content-type') ?? '',
    cacheControl: headers.get('cache-control') ?? '',
    etag: headers.get('etag') ?? '',
    lastModified: headers.get('last-modified') ?? '',
    ...saved,
  };
}

function listProjects(raw) {
  if (isRecord(raw) && Array.isArray(raw.projects)) return raw.projects;
  if (Array.isArray(raw)) return raw;
  return [];
}

function readTotal(raw, fallback) {
  return isRecord(raw) && Number.isFinite(raw.total) ? raw.total : fallback;
}

function projectFromDetail(raw) {
  return isRecord(raw?.project) ? raw.project : raw;
}

function detailRegexEntries(raw) {
  if (Array.isArray(raw?.regexEntriesPreview)) return raw.regexEntriesPreview;
  if (Array.isArray(raw?.project?.regexEntriesPreview)) return raw.project.regexEntriesPreview;
  return [];
}

function detailWorldbookPreview(raw) {
  if (Array.isArray(raw?.worldbookEntriesPreview)) return raw.worldbookEntriesPreview;
  if (Array.isArray(raw?.project?.worldbookEntriesPreview))
    return raw.project.worldbookEntriesPreview;
  return [];
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const outputRoot = resolve(args.output);
  const fetchedAt = new Date().toISOString();
  console.log(`${args.apply ? 'APPLY' : 'DRY RUN'}: ${API_BASE}`);
  console.log(`Output: ${outputRoot}`);

  const requestEvidence = [];
  const projectsById = new Map();
  let reportedTotal = 0;
  let page = 0;
  let terminalPage = -1;

  while (true) {
    const url = `${API_BASE}/api/projects?page=${page}&pageSize=${args.pageSize}&sort=published`;
    const fetched = await fetchBytes(url);
    const raw = parseJson(fetched.bytes, url);
    const projects = listProjects(raw);
    reportedTotal = Math.max(reportedTotal, readTotal(raw, projects.length));
    const saved = await writeFetched(
      outputRoot,
      `raw/list/page-${String(page).padStart(4, '0')}.json`,
      fetched,
      args.apply,
    );
    requestEvidence.push(responseEvidence('list', url, fetched, saved, fetchedAt, { page }));

    for (const project of projects) {
      const id = safeProjectId(project?.id);
      if (projectsById.has(id)) throw new Error(`Duplicate project id across list pages: ${id}`);
      projectsById.set(id, project);
    }
    console.log(
      `List page ${page}: ${projects.length} rows; ${projectsById.size}/${reportedTotal} unique`,
    );

    if (projects.length === 0) {
      terminalPage = page;
      break;
    }
    if (projectsById.size >= reportedTotal) {
      page += 1;
      continue;
    }
    page += 1;
  }

  if (projectsById.size !== reportedTotal) {
    throw new Error(
      `Incomplete list: reported total ${reportedTotal}, found ${projectsById.size} unique ids`,
    );
  }

  const projects = [...projectsById.values()];
  let completed = 0;
  let regexCount = 0;
  let worldbookPreviewCount = 0;
  let payloadCount = 0;
  let payloadFailureCount = 0;
  let payloadInvalidJsonCount = 0;

  const projectResults = await mapConcurrent(projects, args.concurrency, async (listedProject) => {
    const id = safeProjectId(listedProject.id);
    const detailUrl = `${API_BASE}/api/projects/${encodeURIComponent(id)}`;
    const detailFetched = await fetchBytes(detailUrl);
    const detail = parseJson(detailFetched.bytes, detailUrl);
    const detailSaved = await writeFetched(
      outputRoot,
      `raw/projects/${id}/detail.json`,
      detailFetched,
      args.apply,
    );
    requestEvidence.push(
      responseEvidence('detail', detailUrl, detailFetched, detailSaved, fetchedAt, {
        projectId: id,
      }),
    );

    const detailProject = projectFromDetail(detail);
    const regexEntries = detailRegexEntries(detail);
    const previewEntries = detailWorldbookPreview(detail);
    const downloadUrl =
      typeof detailProject?.downloadUrl === 'string' ? detailProject.downloadUrl.trim() : '';
    regexCount += regexEntries.length;
    worldbookPreviewCount += previewEntries.length;

    if (args.apply) {
      await atomicWrite(
        join(outputRoot, 'regex', `${id}.json`),
        `${JSON.stringify(regexEntries, null, 2)}\n`,
      );
    }

    let payload = null;
    if (downloadUrl) {
      try {
        const parsedUrl = new URL(downloadUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error(`Unsupported payload URL protocol: ${parsedUrl.protocol}`);
        }
        const payloadFetched = await fetchBytes(downloadUrl);
        const payloadSaved = await writeFetched(
          outputRoot,
          `raw/projects/${id}/payload.json`,
          payloadFetched,
          args.apply,
        );
        requestEvidence.push(
          responseEvidence('payload', downloadUrl, payloadFetched, payloadSaved, fetchedAt, {
            projectId: id,
          }),
        );
        payloadCount += 1;
        try {
          parseJson(payloadFetched.bytes, downloadUrl);
          payload = { ...payloadSaved, validJson: true };
        } catch (error) {
          payloadInvalidJsonCount += 1;
          payload = { ...payloadSaved, validJson: false, error: error.message };
          console.warn(`Payload JSON invalid for ${id}: ${error.message}`);
        }
      } catch (error) {
        payloadFailureCount += 1;
        payload = { error: error.message, url: downloadUrl };
        console.warn(`Payload failed for ${id}: ${error.message}`);
      }
    }

    completed += 1;
    if (completed % 25 === 0 || completed === projects.length) {
      console.log(
        `Projects: ${completed}/${projects.length}; regexes: ${regexCount}; payloads: ${payloadCount}`,
      );
    }

    return {
      id,
      name: typeof detailProject?.name === 'string' ? detailProject.name : '',
      version: typeof detailProject?.version === 'string' ? detailProject.version : '',
      status: typeof detailProject?.status === 'string' ? detailProject.status : '',
      visibility: typeof detailProject?.visibility === 'string' ? detailProject.visibility : '',
      tags: Array.isArray(detailProject?.tags) ? detailProject.tags : [],
      detailFile: detailSaved.file,
      regexFile: `regex/${id}.json`,
      regexCount: regexEntries.length,
      worldbookPreviewCount: previewEntries.length,
      downloadUrl,
      payload,
    };
  });

  const manifest = {
    schemaVersion: 1,
    fetchedAt,
    source: {
      apiBase: API_BASE,
      listSort: 'published',
      pageSize: args.pageSize,
    },
    completeness: {
      reportedTotal,
      uniqueProjectIds: projectsById.size,
      terminalEmptyPage: terminalPage,
      detailResponses: projectResults.length,
      detailFailures: 0,
      advertisedPayloads: projectResults.filter((project) => project.downloadUrl).length,
      payloadResponses: payloadCount,
      payloadFailures: payloadFailureCount,
      payloadInvalidJson: payloadInvalidJsonCount,
      regexEntries: regexCount,
      worldbookPreviewEntries: worldbookPreviewCount,
    },
    projects: projectResults,
    requests: requestEvidence,
  };

  if (args.apply) {
    await atomicWrite(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const totalBytes = requestEvidence.reduce((sum, request) => sum + request.bytes, 0);
  console.log(
    JSON.stringify(
      {
        apply: args.apply,
        reportedTotal,
        uniqueProjectIds: projectsById.size,
        terminalEmptyPage: terminalPage,
        details: projectResults.length,
        advertisedPayloads: manifest.completeness.advertisedPayloads,
        payloadResponses: payloadCount,
        payloadFailures: payloadFailureCount,
        payloadInvalidJson: payloadInvalidJsonCount,
        regexEntries: regexCount,
        fetchedBytes: totalBytes,
      },
      null,
      2,
    ),
  );

  if (payloadFailureCount > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
