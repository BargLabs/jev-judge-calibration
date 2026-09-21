/**
 * Deterministic selection of the fifty public base cases.
 *
 * The pool is stable because the merge window is closed in the past and the sort is by creation
 * ascending, not by recency: the same query returns the same order on any later day. Survivors are
 * taken in pool order. Nothing here is shuffled and nothing is sampled at random.
 *
 * Every GitHub read goes through an injected `GitHubReader`. This module opens no connection of
 * its own, so the exclusion rules and the ordering are testable offline against a recorded pool.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  JEV_EXCLUDED_OWNERS,
  JEV_FRAME_EXCLUSION_ENV,
  JEV_PLANNED_BASE_CASES,
  JEV_POOL_SEGMENTS,
  JEV_TMP_DIR,
  type JevPoolSegment,
  resolveGhMinIntervalMs,
} from './constants.js';
import {
  type JevBaseCase,
  type JevEvidence,
  admitBaseCase,
  canonicalJson,
  containsFrameExclusion,
  jevBaseCaseSchema,
  sha256Hex,
} from './corpus.js';

export interface PoolEntry {
  repository: string;
  number: number;
}

export interface CandidateRead {
  report: string;
  evidence: JevEvidence;
  archived: boolean;
}

export interface SearchPullRequestsQuery {
  q: string;
  sort: string;
  order: string;
  perPage: number;
  maxPages: number;
  /** Resume point: the first page not yet frozen. `1` on a cold start. */
  startPage: number;
  /**
   * Invoked after each page succeeds, in page order, before the next page is requested. The
   * caller uses this to freeze the pool to disk page by page: a rate-limit failure on a later
   * page then loses at most that one page, not every page fetched before it.
   */
  onPage: (page: number, entries: PoolEntry[], isShortPage: boolean) => void | Promise<void>;
}

export interface GitHubReader {
  /**
   * Walks pages `startPage..maxPages`, calling `onPage` after each one, and stops early on a
   * short page (the last page of results). Resolves once paging stops; rejects, without
   * resolving, if a page's own request fails — whatever `onPage` already froze for earlier pages
   * stands.
   */
  searchPullRequests(query: SearchPullRequestsQuery): Promise<void>;
  /** Full record for one candidate, or `null` when it is unreadable (private, deleted, 404). */
  readCandidate(entry: PoolEntry): Promise<CandidateRead | null>;
}

export const JEV_EXCLUSION_RULES = [
  'excluded_owner',
  'frame_member',
  'unreadable_or_archived',
  'not_merged',
  'open_window_too_short',
  'body_length_out_of_range',
  'fenced_block_too_long',
  'changed_file_count_out_of_range',
  'no_check_runs',
  /** Errata 2 (2026-09-20): excluded before the admissibility filter runs, when the candidate's own
   * body or evidence record cites a frame member by the output guard's own substring test. The
   * candidate's repository having already passed rule 2 does not save it — the exclusion here is
   * about what the text says, not what repository it lives in. */
  'rule_12_frame_mention',
  'admissibility_filter',
  'repository_already_represented',
  /** A later segment's entry whose `(repository, number)` already appeared in an earlier segment.
   * Dropped before it ever reaches the exclusion-rule loop below, and counted here rather than
   * folded into `repository_already_represented`, which is a different rule (an ADMITTED base
   * case's own repository recurring), not a raw pool-membership duplicate. */
  'duplicate_of_segment_a',
] as const;
export type JevExclusionRule = (typeof JEV_EXCLUSION_RULES)[number];

export interface SegmentSelectionResult {
  id: string;
  query: string;
  sort: string;
  order: string;
  perPage: number;
  maxPages: number;
  authorisedBy: string;
  /** Pages actually fetched (or already frozen) for this segment. */
  pageCount: number;
  /** Raw entries returned by this segment's search, before cross-segment dedup. */
  entryCount: number;
  /** Entries dropped because they duplicated an entry already seen in an earlier segment. */
  duplicateCount: number;
  /** Base cases admitted whose evidence came from this segment. */
  admittedCount: number;
  exclusionCounts: Record<string, number>;
}

export interface SelectionResult {
  poolSize: number;
  exclusionCounts: Record<string, number>;
  baseCases: JevBaseCase[];
  selected: string[];
  /** Whether this selection re-ran the search rather than reading the frozen pool file. */
  poolRefetched: boolean;
  /** Per-segment parameters, counts, and provenance, in pool order. */
  segments: SegmentSelectionResult[];
}

// ---------------------------------------------------------------------------
// Frozen pool and per-candidate cache, on disk under `tmp/jev-judge`
//
// The pool freezes page by page: after each search page succeeds, its entries are written to
// disk immediately, so a rate-limit failure on page N keeps pages 1..N-1 rather than discarding
// them. A rerun resumes from the first page not yet frozen rather than re-searching from page 1,
// so the selection stays the deterministic procedure the preregistration describes even though a
// live search page can differ between calendar days. The pool counts as complete once a short
// page (the last page of results) has been seen or every planned page has been fetched; only
// then does a later run skip the search entirely. Every `readCandidate` result — including a
// `null` unreadable result — is written before the next read starts, so a crash mid-run loses at
// most the one read in flight, not the ones already paid for.
// ---------------------------------------------------------------------------

interface FrozenPoolSegmentFile {
  id: string;
  query: string;
  sort: string;
  order: string;
  perPage: number;
  maxPages: number;
  /** How many pages, in order from page 1, have been frozen without a gap. */
  completedPages: number;
  /** Whether one of those completed pages came back shorter than `perPage` — the last page. */
  shortPageSeen: boolean;
  /** `completedPages` reached `maxPages`, or `shortPageSeen`: nothing left to fetch. */
  complete: boolean;
  entries: PoolEntry[];
}

interface FrozenPoolFile {
  fetchedAt: string;
  segments: FrozenPoolSegmentFile[];
}

/** The single-segment shape written before errata 1. Migrated to segment A in place, on first
 * read, without re-searching: its `complete` pool never issues a search call under the new code. */
interface LegacyFrozenPoolFile {
  query: string;
  sort: string;
  order: string;
  perPage: number;
  maxPages: number;
  fetchedAt: string;
  completedPages: number;
  shortPageSeen: boolean;
  complete: boolean;
  entries: PoolEntry[];
}

interface CandidateCacheFile {
  segmentId: string;
  segmentDigest: string;
  read: CandidateRead | null;
}

function poolFilePath(repoRoot: string): string {
  return join(repoRoot, JEV_TMP_DIR, 'pool.json');
}

function candidateCachePath(repoRoot: string, segmentId: string, entry: PoolEntry): string {
  const [owner, repo] = entry.repository.split('/');
  return join(
    repoRoot,
    JEV_TMP_DIR,
    'candidates',
    `${segmentId}__${owner}__${repo}__${entry.number}.json`,
  );
}

/** Keys a segment's own candidate cache. Computed over that segment's raw entries only, so
 * appending or resuming a later segment never invalidates an earlier segment's cached reads. */
function segmentDigest(entries: readonly PoolEntry[]): string {
  return sha256Hex(JSON.stringify(entries));
}

function isLegacyPoolFile(value: unknown): value is LegacyFrozenPoolFile {
  if (value === null || typeof value !== 'object') return false;
  const record = value as { segments?: unknown; entries?: unknown };
  return !Array.isArray(record.segments) && Array.isArray(record.entries);
}

function migrateLegacyPoolFile(legacy: LegacyFrozenPoolFile): FrozenPoolFile {
  return {
    fetchedAt: legacy.fetchedAt,
    segments: [
      {
        id: 'A',
        query: legacy.query,
        sort: legacy.sort,
        order: legacy.order,
        perPage: legacy.perPage,
        maxPages: legacy.maxPages,
        completedPages: legacy.completedPages,
        shortPageSeen: legacy.shortPageSeen,
        complete: legacy.complete,
        entries: legacy.entries,
      },
    ],
  };
}

function readFrozenPoolFile(path: string): FrozenPoolFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FrozenPoolFile | LegacyFrozenPoolFile;
    return isLegacyPoolFile(parsed) ? migrateLegacyPoolFile(parsed) : (parsed as FrozenPoolFile);
  } catch {
    return null;
  }
}

function writeFrozenPoolFile(path: string, file: FrozenPoolFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

interface FetchedSegment {
  definition: JevPoolSegment;
  pageCount: number;
  entries: PoolEntry[];
}

/**
 * Fetches every pool segment in `JEV_POOL_SEGMENTS` order, resuming each from the first page not
 * yet frozen and freezing each new page to disk as soon as it succeeds — the whole segments array
 * is rewritten on every page, so an earlier segment's already-frozen state is never lost while a
 * later one is still being paged. `refetchPool` discards all frozen state and starts every segment
 * fresh from page 1. A legacy single-segment file is migrated to segment A in place on read, before
 * any segment is fetched, so a complete segment A never issues a search call after the migration.
 */
async function fetchSegments(options: {
  reader: GitHubReader;
  repoRoot: string;
  refetchPool: boolean;
  now: () => Date;
}): Promise<{ segments: FetchedSegment[]; refetched: boolean }> {
  const poolPath = poolFilePath(options.repoRoot);
  const frozen = options.refetchPool ? null : readFrozenPoolFile(poolPath);
  const frozenById = new Map((frozen?.segments ?? []).map((segment) => [segment.id, segment]));

  const segmentFiles: FrozenPoolSegmentFile[] = [];
  const persist = (): void => {
    writeFrozenPoolFile(poolPath, {
      fetchedAt: options.now().toISOString(),
      segments: segmentFiles,
    });
  };

  for (const definition of JEV_POOL_SEGMENTS) {
    const existing = frozenById.get(definition.id);
    const segmentFile: FrozenPoolSegmentFile = {
      id: definition.id,
      query: definition.query,
      sort: definition.sort,
      order: definition.order,
      perPage: definition.perPage,
      maxPages: definition.maxPages,
      completedPages: existing?.completedPages ?? 0,
      shortPageSeen: existing?.shortPageSeen ?? false,
      complete: existing?.complete ?? false,
      entries: existing ? [...existing.entries] : [],
    };
    segmentFiles.push(segmentFile);

    if (!segmentFile.complete) {
      await options.reader.searchPullRequests({
        q: definition.query,
        sort: definition.sort,
        order: definition.order,
        perPage: definition.perPage,
        maxPages: definition.maxPages,
        startPage: segmentFile.completedPages + 1,
        onPage: (page, pageEntries, isShortPage) => {
          segmentFile.entries.push(...pageEntries);
          segmentFile.completedPages = page;
          if (isShortPage) segmentFile.shortPageSeen = true;
          segmentFile.complete =
            segmentFile.shortPageSeen || segmentFile.completedPages >= definition.maxPages;
          persist();
        },
      });
    }
  }

  return {
    segments: segmentFiles.map((file, index) => ({
      definition: JEV_POOL_SEGMENTS[index] as JevPoolSegment,
      pageCount: file.completedPages,
      entries: file.entries,
    })),
    refetched: options.refetchPool === true,
  };
}

/** `undefined` is a cache miss: absent, corrupted, keyed to a different segment, or keyed to a
 * segment that has since been refetched. */
function readCandidateCache(
  path: string,
  segmentId: string,
  digest: string,
): CandidateRead | null | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CandidateCacheFile;
    if (parsed.segmentId !== segmentId || parsed.segmentDigest !== digest) return undefined;
    return parsed.read;
  } catch {
    return undefined;
  }
}

function writeCandidateCache(
  path: string,
  segmentId: string,
  digest: string,
  read: CandidateRead | null,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ segmentId, segmentDigest: digest, read }, null, 2)}\n`);
}

/**
 * Reads the operator's frame-exclusion file. Absence refuses; it never defaults to an empty set,
 * because an empty set and an unconfigured path are indistinguishable at the call site and the
 * second one silently publishes a frame member.
 */
export function readFrameExclusions(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const path = env[JEV_FRAME_EXCLUSION_ENV];
  if (!path || !existsSync(path)) {
    throw new Error('not_run: frame_exclusion_list_absent');
  }
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
}

function baseCaseId(index: number): string {
  return `JC-${String(index + 1).padStart(2, '0')}`;
}

interface JoinedPoolEntry extends PoolEntry {
  segmentId: string;
}

function freshExclusionCounts(): Record<string, number> {
  return Object.fromEntries(JEV_EXCLUSION_RULES.map((rule) => [rule, 0]));
}

/**
 * Concatenates every fetched segment's entries in `JEV_POOL_SEGMENTS` order into the join pool
 * selection walks. An entry whose `(repository, number)` already appeared in an earlier segment is
 * dropped here, before it ever reaches the per-candidate exclusion loop, and counted against its
 * own segment under `duplicate_of_segment_a` — segment A itself never drops anything, since nothing
 * has been seen yet when it is walked.
 */
function joinSegments(fetched: readonly FetchedSegment[]): {
  pool: JoinedPoolEntry[];
  segments: Map<string, SegmentSelectionResult>;
  digests: Map<string, string>;
} {
  const pool: JoinedPoolEntry[] = [];
  const segments = new Map<string, SegmentSelectionResult>();
  const digests = new Map<string, string>();
  const seen = new Set<string>();

  for (const segment of fetched) {
    const { id, query, sort, order, perPage, maxPages, authorisedBy } = segment.definition;
    digests.set(id, segmentDigest(segment.entries));
    const exclusionCounts = freshExclusionCounts();
    let duplicateCount = 0;

    for (const entry of segment.entries) {
      const key = `${entry.repository.toLowerCase()}#${entry.number}`;
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
      pool.push({ ...entry, segmentId: id });
    }

    exclusionCounts.duplicate_of_segment_a = duplicateCount;
    segments.set(id, {
      id,
      query,
      sort,
      order,
      perPage,
      maxPages,
      authorisedBy,
      pageCount: segment.pageCount,
      entryCount: segment.entries.length,
      duplicateCount,
      admittedCount: 0,
      exclusionCounts,
    });
  }

  return { pool, segments, digests };
}

/**
 * Applies the pre-registered exclusion rules in order and returns the first
 * `JEV_PLANNED_BASE_CASES` survivors. Refuses on a short pool rather than shrinking the corpus:
 * a short pool is a result about the selection rule, and the remedy is an operator decision. The
 * pool walked here is the join of every segment in `JEV_POOL_SEGMENTS`, in order — rule 11
 * (`repository_already_represented`) and every other rule apply across that join exactly as they
 * did within a single segment; nothing about the per-candidate rules changes.
 */
export async function selectBaseCases(options: {
  reader: GitHubReader;
  frameExclusions: Set<string>;
  target?: number;
  /** Where `tmp/jev-judge/pool.json` and the per-candidate cache live. */
  repoRoot: string;
  /** Re-runs the search instead of reading the frozen pool. Recorded in the manifest by the caller. */
  refetchPool?: boolean;
  onProgress?: (message: string) => void;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}): Promise<SelectionResult> {
  const target = options.target ?? JEV_PLANNED_BASE_CASES;
  const progress = options.onProgress ?? (() => {});
  const now = options.now ?? (() => new Date());

  const { segments: fetchedSegments, refetched } = await fetchSegments({
    reader: options.reader,
    repoRoot: options.repoRoot,
    refetchPool: options.refetchPool === true,
    now,
  });
  const { pool, segments: segmentStats, digests: segmentDigests } = joinSegments(fetchedSegments);
  const pacingMs = resolveGhMinIntervalMs(options.env);

  const exclusionCounts = freshExclusionCounts();
  for (const stats of segmentStats.values()) {
    exclusionCounts.duplicate_of_segment_a =
      (exclusionCounts.duplicate_of_segment_a ?? 0) + stats.duplicateCount;
  }

  const representedRepositories = new Set<string>();
  const baseCases: JevBaseCase[] = [];
  const bump = (rule: string, segmentId: string): void => {
    exclusionCounts[rule] = (exclusionCounts[rule] ?? 0) + 1;
    const stats = segmentStats.get(segmentId);
    if (stats) stats.exclusionCounts[rule] = (stats.exclusionCounts[rule] ?? 0) + 1;
  };

  let processed = 0;
  const reportProgress = (): void => {
    if (processed % 25 !== 0) return;
    const excluded = Object.values(exclusionCounts).reduce((sum, count) => sum + count, 0);
    progress(
      `read=${processed} admitted=${baseCases.length} excluded=${excluded} ` +
        `remaining=${pool.length - processed} pacing=${pacingMs}ms`,
    );
  };

  for (const entry of pool) {
    if (baseCases.length >= target) break;
    processed += 1;
    const repository = entry.repository.toLowerCase();
    const owner = repository.split('/')[0];
    const segmentId = entry.segmentId;

    if (JEV_EXCLUDED_OWNERS.includes(owner as never)) {
      bump('excluded_owner', segmentId);
      reportProgress();
      continue;
    }
    if (options.frameExclusions.has(repository)) {
      bump('frame_member', segmentId);
      reportProgress();
      continue;
    }
    if (representedRepositories.has(repository)) {
      bump('repository_already_represented', segmentId);
      reportProgress();
      continue;
    }

    const cachePath = candidateCachePath(options.repoRoot, segmentId, entry);
    const digest = segmentDigests.get(segmentId) ?? '';
    const cached = readCandidateCache(cachePath, segmentId, digest);
    const read = cached === undefined ? await options.reader.readCandidate(entry) : cached;
    if (cached === undefined) writeCandidateCache(cachePath, segmentId, digest, read);

    if (read === null || read.archived) {
      bump('unreadable_or_archived', segmentId);
      reportProgress();
      continue;
    }
    if (read.evidence.state !== 'closed' || read.evidence.isMerged !== true) {
      bump('not_merged', segmentId);
      reportProgress();
      continue;
    }

    // Rule 12 (errata 2, 2026-09-20): the same substring test the output guard applies to the
    // corpus, applied here to the candidate's own body and evidence record before either ever
    // reaches the admissibility filter. `containsFrameExclusion` is the one predicate both this
    // rule and `assertNoFrameLeakage` call, so they cannot drift apart. Never checked against the
    // repository name alone — rule 2 already did that — only against what the candidate's text
    // says.
    const candidateBytes = [read.report, canonicalJson(read.evidence)].join('\n');
    if (containsFrameExclusion(candidateBytes, options.frameExclusions)) {
      bump('rule_12_frame_mention', segmentId);
      reportProgress();
      continue;
    }

    const verdict = admitBaseCase({ report: read.report, evidence: read.evidence });
    if (!verdict.admitted) {
      // Route the specific rule to its own counter when one of the named pre-filters caught it,
      // so the published exclusion table says which rule fired rather than only that one did.
      const named = verdict.reasons.find((reason) => reason in exclusionCounts);
      bump(named ?? 'admissibility_filter', segmentId);
      reportProgress();
      continue;
    }

    representedRepositories.add(repository);
    baseCases.push(
      jevBaseCaseSchema.parse({
        baseCaseId: baseCaseId(baseCases.length),
        report: read.report,
        evidence: read.evidence,
      }),
    );
    const stats = segmentStats.get(segmentId);
    if (stats) stats.admittedCount += 1;
    reportProgress();
  }

  if (baseCases.length < target) {
    throw new Error(`not_run: insufficient_base_cases:${baseCases.length}`);
  }

  return {
    poolSize: pool.length,
    exclusionCounts,
    baseCases,
    selected: baseCases.map(({ evidence }) => `${evidence.repository}#${evidence.number}`),
    poolRefetched: refetched,
    segments: fetchedSegments.map(
      (segment) => segmentStats.get(segment.definition.id) as SegmentSelectionResult,
    ),
  };
}
