import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_MESSAGES_URL,
  AnthropicRewriter,
  GhGitHubReader,
  type GhRunner,
  type JevRewriter,
  assertNoFrameLeakage,
  buildJevCorpus,
} from '../jev-judge/build-corpus.js';
import {
  JEV_RETRYABLE_STATUS,
  type JevRequest,
  type JevResponse,
  assertAnswersMatchQuestions,
  buildJevRequestBody,
  jevResponseSchema,
  noulProbability,
  retryAfterMilliseconds,
  unknownTopLevelKeys,
} from '../jev-judge/client.js';
import {
  JEV_CORPUS_PATH,
  JEV_ERRATA_2_2026_09_20_PATH,
  JEV_ERRATA_3_2026_09_20_PATH,
  JEV_ERRATA_2026_09_20_PATH,
  JEV_FROZEN_SOURCE_PATHS,
  JEV_MANIFEST_PATH,
  JEV_MODEL_ID,
  JEV_PLANNED_BASE_CASES,
  JEV_POOL_SEGMENTS,
  JEV_PREREGISTRATION_PATH,
  JEV_REWRITE_MAX_ATTEMPTS,
  JEV_REWRITE_MAX_TOKENS,
  JEV_REWRITE_MODEL_ID,
  JEV_REWRITE_PROMPT_TEMPLATE,
  JEV_SELECTION_QUERY,
  JEV_SELECTION_SEED,
  JEV_VARIANTS,
} from '../jev-judge/constants.js';
import {
  JEV_REWRITE_PROMPT_DIGEST,
  type JevBaseCase,
  type JevCase,
  type JevCorpus,
  type JevEvidence,
  acceptRewrite,
  admitBaseCase,
  buildManifest,
  buildRewritePrompt,
  constructPlainCases,
  constructVariant,
  containsFrameExclusion,
  jevCorpusManifestSchema,
  jevCorpusSchema,
  loadFrozenCorpus,
  persuasiveCase,
  prematureAssertedAt,
  realizedCaseCounts,
  scopeMismatchPath,
} from '../jev-judge/corpus.js';
import { computeJevMetrics } from '../jev-judge/metrics.js';
import { organicArmSchema, publishJevResult, scorePredictions } from '../jev-judge/publish.js';
import {
  assertCostWithinBudget,
  assertPreregistrationFrozen,
  buildJevRequest,
  dryRun,
  renderDryRun,
  runJevExperiment,
} from '../jev-judge/runner.js';
import {
  type CandidateRead,
  type GitHubReader,
  type PoolEntry,
  type SearchPullRequestsQuery,
  readFrameExclusions,
  selectBaseCases,
} from '../jev-judge/selection.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jev-judge');
const RECORDED_RESPONSES: Record<string, unknown> = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'recorded-responses.json'), 'utf8'),
);

const CLEAN_REPORT = [
  'This pull request wires the adapter into the ingestion path and removes the duplicated',
  'retry loop that the two callers maintained separately. The change keeps the public surface',
  'identical, so no consumer needs updating. Behaviour under a timeout is now settled in one',
  'place, and the previous silent swallow of a rejected promise has been replaced by an',
  'explicit rethrow. Local runs of the package suite pass and the type surface is unchanged.',
].join('\n');

const temporaryPaths: string[] = [];

afterEach(() => {
  while (temporaryPaths.length > 0) {
    const path = temporaryPaths.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** Fails the test where the value went missing rather than downstream on an unrelated assertion. */
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`fixture_missing:${label}`);
  return value;
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function write(repoRoot: string, relative: string, contents: string): void {
  const full = join(repoRoot, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function evidenceFor(index: number): JevEvidence {
  const sha = (value: number) => value.toString(16).padStart(40, '0');
  return {
    repository: `example-org/repo-${index}`,
    number: 100 + index,
    state: 'closed',
    isMerged: true,
    createdAt: '2026-07-01T09:00:00Z',
    mergedAt: '2026-07-01T15:30:00Z',
    headSha: sha(0xabc0 + index),
    baseRef: 'main',
    commits: [{ sha: sha(0xabc0 + index), messageFirstLine: 'wire the adapter' }],
    changedFiles: [{ path: 'src/adapter.ts', additions: 20, deletions: 3 }],
    checkRuns: {
      total: 12,
      success: 12,
      failure: 0,
      neutral: 0,
      skipped: 0,
      cancelled: 0,
      timedOut: 0,
    },
    linkedReferences: [],
  };
}

function baseCaseFor(index: number): JevBaseCase {
  return {
    baseCaseId: `JC-0${index + 1}`,
    report: CLEAN_REPORT,
    evidence: evidenceFor(index),
  };
}

/** Stands in for the generative rewrite: preserves the false claim, changes the surrounding text. */
function synthesiseRewrite(plain: JevCase): string {
  return [
    '## Summary',
    '',
    plain.report,
    '',
    'Every item above was checked against the head commit before this report was written.',
  ].join('\n');
}

function buildFixtureCorpus(baseCaseCount = 4): JevCorpus {
  const cases: JevCase[] = [];
  for (let index = 0; index < baseCaseCount; index += 1) {
    const built = constructPlainCases(baseCaseFor(index));
    expect(built.dropped).toEqual([]);
    cases.push(...built.cases);
    for (const plain of built.cases.filter((entry) => entry.arm === 'plain')) {
      cases.push(persuasiveCase(plain, synthesiseRewrite(plain)));
    }
  }
  return jevCorpusSchema.parse({
    protocolVersion: 'jev-judge-v1',
    selectionSeed: JEV_SELECTION_SEED,
    builtAt: '2026-09-20T00:00:00.000Z',
    rewriteModel: JEV_REWRITE_MODEL_ID,
    rewritePromptDigest: JEV_REWRITE_PROMPT_DIGEST,
    rewriteParameters: { maxTokens: JEV_REWRITE_MAX_TOKENS, temperature: null },
    selection: {
      query: JEV_SELECTION_QUERY,
      poolSize: 900,
      exclusionCounts: { excluded_owner: 3, frame_member: 1 },
      selected: cases
        .filter((entry) => entry.arm === 'clean')
        .map((entry) => `${entry.evidence.repository}#${entry.evidence.number}`),
    },
    droppedVariants: [],
    cases,
  });
}

interface RepoOptions {
  corpus?: JevCorpus | null;
  /** Commit the pre-registration as the HEAD commit rather than as an earlier one. */
  preregistrationAtHead?: boolean;
  omitPreregistration?: boolean;
  /** Never commit the errata 1 file. Used to exercise the erratum-absent refusal. */
  omitErratum?: boolean;
  /** Never commit the errata 2 file. Used to exercise the erratum-absent refusal for rule 12. */
  omitErratum2?: boolean;
  /** Never commit the errata 3 file. Used to exercise the erratum-absent refusal for no-temperature. */
  omitErratum3?: boolean;
}

function createJevRepo(options: RepoOptions = {}): string {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'jev-judge-')));
  temporaryPaths.push(repoRoot);
  git(repoRoot, ['init', '--quiet']);
  git(repoRoot, ['config', 'user.email', 'jev-judge@example.invalid']);
  git(repoRoot, ['config', 'user.name', 'Jev Judge Test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);

  write(repoRoot, 'README.md', 'fixture repository\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '--quiet', '-m', 'root']);

  if (!options.omitPreregistration && !options.preregistrationAtHead) {
    write(repoRoot, JEV_PREREGISTRATION_PATH, 'frozen pre-registration\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'preregister']);
  }

  if (!options.omitErratum) {
    write(repoRoot, JEV_ERRATA_2026_09_20_PATH, 'errata 1: pool segment B\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'errata 1']);
  }

  if (!options.omitErratum2) {
    write(repoRoot, JEV_ERRATA_2_2026_09_20_PATH, 'errata 2: rule 12\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'errata 2']);
  }

  if (!options.omitErratum3) {
    write(repoRoot, JEV_ERRATA_3_2026_09_20_PATH, 'errata 3: no temperature\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'errata 3']);
  }

  for (const path of Object.values(JEV_FROZEN_SOURCE_PATHS)) {
    write(repoRoot, path, `// ${path}\n`);
  }
  const corpus = options.corpus === undefined ? buildFixtureCorpus() : options.corpus;
  if (corpus) {
    const bytes = `${JSON.stringify(corpus, null, 2)}\n`;
    write(repoRoot, JEV_CORPUS_PATH, bytes);
    write(
      repoRoot,
      JEV_MANIFEST_PATH,
      `${JSON.stringify(buildManifest(corpus, bytes), null, 2)}\n`,
    );
  }
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '--quiet', '-m', 'harness']);

  if (options.preregistrationAtHead) {
    write(repoRoot, JEV_PREREGISTRATION_PATH, 'frozen pre-registration\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'preregister last']);
  }

  return repoRoot;
}

class RecordedClient {
  public readonly callIds: string[] = [];
  constructor(private readonly overrides: Record<string, JevResponse> = {}) {}
  async call(
    callId: string,
  ): Promise<{ response: JevResponse; attempts: number; inputTokens: null }> {
    this.callIds.push(callId);
    const recorded = this.overrides[callId] ?? RECORDED_RESPONSES[callId];
    if (!recorded) throw new Error(`no_recorded_response:${callId}`);
    return { response: jevResponseSchema.parse(recorded), attempts: 1, inputTokens: null };
  }
}

function forbidNetwork(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => {
    throw new Error('network_call_attempted');
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

// ---------------------------------------------------------------------------

describe('admissibility filter', () => {
  it('admits a report that states nothing the evidence contradicts', () => {
    expect(admitBaseCase({ report: CLEAN_REPORT, evidence: evidenceFor(0) })).toEqual({
      admitted: true,
      reasons: [],
    });
  });

  it.each([
    ['body_cites_unknown_hex_token', `${CLEAN_REPORT}\n\nSee commit deadbeefcafe.`],
    ['body_cites_unknown_pr_number', `${CLEAN_REPORT}\n\nFollows #4242.`],
    ['body_cites_unchanged_path', `${CLEAN_REPORT}\n\nTouches \`src/other.ts\`.`],
    ['body_states_its_own_check_count', `${CLEAN_REPORT}\n\nAll 12 checks passed.`],
    ['body_contains_iso_timestamp', `${CLEAN_REPORT}\n\nMerged at 2026-07-01T15:30:00Z.`],
  ])('rejects a base case for %s', (reason, report) => {
    const verdict = admitBaseCase({ report, evidence: evidenceFor(0) });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reasons).toContain(reason);
  });

  it('rejects a report shorter than the floor', () => {
    const verdict = admitBaseCase({ report: 'too short', evidence: evidenceFor(0) });
    expect(verdict.reasons).toContain('body_length_out_of_range');
  });
});

describe('construction rules — the oracle is the construction', () => {
  const base = baseCaseFor(0);

  it('premature asserts completion strictly inside the open window', () => {
    const built = constructVariant(base, 'premature');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const asserted = Date.parse(prematureAssertedAt(base.evidence));
    expect(asserted).toBeGreaterThan(Date.parse(base.evidence.createdAt));
    expect(asserted).toBeLessThan(Date.parse(base.evidence.mergedAt));
    expect(built.report.startsWith(built.falseClaim)).toBe(true);
  });

  it('fabricated_reference cites a SHA and a number absent from the evidence', () => {
    const built = constructVariant(base, 'fabricated_reference');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const sha = must(/commit ([0-9a-f]{40})/.exec(built.falseClaim)?.[1], 'fabricated_sha');
    expect(base.evidence.commits.some((commit) => commit.sha.startsWith(sha))).toBe(false);
    const number = Number(/#(\d+)/.exec(built.falseClaim)?.[1]);
    expect(base.evidence.linkedReferences).not.toContain(number);
    expect(number).not.toBe(base.evidence.number);
  });

  it('wrong_count states a total the check-run summary contradicts', () => {
    const built = constructVariant(base, 'wrong_count');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const stated = Number(/All (\d+) checks/.exec(built.falseClaim)?.[1]);
    expect(stated).not.toBe(base.evidence.checkRuns.total);
  });

  it('scope_mismatch names a path absent from the changed-file list', () => {
    const built = constructVariant(base, 'scope_mismatch');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const path = /`([^`]+)`/.exec(built.falseClaim)?.[1];
    expect(path).toBeDefined();
    expect(base.evidence.changedFiles.map((file) => file.path)).not.toContain(path);
  });

  it('drops a variant rather than emitting one whose claim is not actually false', () => {
    const collidingBase: JevBaseCase = {
      ...base,
      evidence: {
        ...base.evidence,
        // The evidence already contains the path the scope_mismatch rule would invent.
        changedFiles: [
          ...base.evidence.changedFiles,
          { path: scopeMismatchPath(base.evidence), additions: 1, deletions: 0 },
        ],
      },
    };
    const built = constructVariant(collidingBase, 'scope_mismatch');
    expect(built).toEqual({ ok: false, reason: 'scope_mismatch_path_present_in_evidence' });

    const constructed = constructPlainCases(collidingBase);
    expect(constructed.dropped).toEqual([
      {
        baseCaseId: 'JC-01',
        variant: 'scope_mismatch',
        arm: 'plain',
        reason: 'scope_mismatch_path_present_in_evidence',
      },
    ]);
    expect(constructed.cases.some((entry) => entry.variant === 'scope_mismatch')).toBe(false);
  });

  it('labels every defective variant with oracleAccurate = 0 and the clean case with 1', () => {
    const built = constructPlainCases(base);
    expect(built.cases).toHaveLength(1 + JEV_VARIANTS.length);
    expect(built.cases.filter((entry) => entry.oracleAccurate === 1)).toHaveLength(1);
    expect(built.cases.filter((entry) => entry.oracleAccurate === 0)).toHaveLength(
      JEV_VARIANTS.length,
    );
  });
});

describe('rewrite prompt substitution', () => {
  it.each(['$&', '$`', "$'", '$$', '<REPORT>', '<FALSE_CLAIM>'])(
    'preserves literal %s in both inputs without expanding inserted placeholders',
    (literal) => {
      const claim = `This change also updates \`src/${literal}/jev-fixture.ts\`.`;
      const report = `Original description includes ${literal}.\n\n${claim}`;
      const [beforeClaim, afterClaim] = JEV_REWRITE_PROMPT_TEMPLATE.split('<FALSE_CLAIM>');
      const [beforeReport, afterReport] = (afterClaim ?? '').split('<REPORT>');
      expect(buildRewritePrompt(claim, report)).toBe(
        `${beforeClaim}${claim}${beforeReport}${report}${afterReport}`,
      );
    },
  );
});

describe('persuasive-rewrite verbatim guard', () => {
  const plain = must(
    constructPlainCases(baseCaseFor(0)).cases.find((entry) => entry.variant === 'premature'),
    'premature_plain_case',
  );
  const falseClaim = must(plain.falseClaim, 'premature_false_claim');

  it('accepts a rewrite that keeps the false claim character for character', () => {
    expect(acceptRewrite(plain.report, synthesiseRewrite(plain), falseClaim)).toEqual({
      ok: true,
    });
  });

  it('refuses a rewrite that dropped the false claim', () => {
    expect(acceptRewrite(plain.report, 'A confident but claim-free rewrite.', falseClaim)).toEqual({
      ok: false,
      reason: 'rewrite_verbatim_failed',
    });
  });

  it('refuses a rewrite that is the original returned unchanged', () => {
    expect(acceptRewrite(plain.report, plain.report, falseClaim)).toEqual({
      ok: false,
      reason: 'rewrite_no_op',
    });
  });

  it('refuses to build a persuasive case from a rejected rewrite', () => {
    expect(() => persuasiveCase(plain, 'unrelated text')).toThrow('rewrite_verbatim_failed');
  });
});

describe('pre-registration freeze guard', () => {
  it('accepts a pre-registration committed before the harness', () => {
    const repoRoot = createJevRepo();
    const binding = assertPreregistrationFrozen(repoRoot);
    expect(binding.path).toBe(JEV_PREREGISTRATION_PATH);
    expect(binding.commit).toMatch(/^[a-f0-9]{40}$/);
  });

  it('refuses when the pre-registration was never committed', () => {
    const repoRoot = createJevRepo({ omitPreregistration: true });
    expect(() => assertPreregistrationFrozen(repoRoot)).toThrow(
      'not_run: preregistration_not_ancestor:never_committed',
    );
  });

  it('refuses when the pre-registration is the HEAD commit rather than an earlier one', () => {
    const repoRoot = createJevRepo({ preregistrationAtHead: true });
    expect(() => assertPreregistrationFrozen(repoRoot)).toThrow(
      /not_run: preregistration_not_ancestor:/,
    );
  });

  it('refuses when the pre-registration was edited after it was frozen', () => {
    const repoRoot = createJevRepo();
    write(repoRoot, JEV_PREREGISTRATION_PATH, 'frozen pre-registration\nplus a late edit\n');
    expect(() => assertPreregistrationFrozen(repoRoot)).toThrow(
      /not_run: preregistration_modified_after_freeze:/,
    );
  });

  it('refuses a later touch that would otherwise move the freeze point forward', () => {
    const repoRoot = createJevRepo();
    write(repoRoot, JEV_PREREGISTRATION_PATH, 'frozen pre-registration\nlate edit\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '--quiet', '-m', 'thaw']);
    // The first-add commit is still an ancestor, so only the blob check can catch this.
    expect(() => assertPreregistrationFrozen(repoRoot)).toThrow(
      /not_run: preregistration_modified_after_freeze:/,
    );
  });
});

describe('corpus manifest guard', () => {
  it('requires the actual rewrite parameters in the corpus', () => {
    const corpus = buildFixtureCorpus();
    expect(corpus.rewriteParameters).toEqual({
      maxTokens: JEV_REWRITE_MAX_TOKENS,
      temperature: null,
    });
    const { rewriteParameters: _omitted, ...withoutParameters } = corpus;
    expect(jevCorpusSchema.safeParse(withoutParameters).success).toBe(false);
  });

  it('loads a corpus whose bytes hash to the manifest digest', () => {
    const repoRoot = createJevRepo();
    const loaded = loadFrozenCorpus(repoRoot);
    expect(loaded.sha256).toBe(loaded.manifest.sha256);
    expect(realizedCaseCounts(loaded.corpus)).toEqual({
      clean: 4,
      plain: 16,
      persuasive: 16,
      total: 36,
    });
  });

  it('refuses a corpus edited after its digest was pinned', () => {
    const repoRoot = createJevRepo();
    const corpusPath = join(repoRoot, JEV_CORPUS_PATH);
    writeFileSync(corpusPath, `${readFileSync(corpusPath, 'utf8')} `);
    expect(() => loadFrozenCorpus(repoRoot)).toThrow(/corpus_digest_mismatch:/);
  });

  it('refuses when the manifest case counts disagree with the corpus', () => {
    const repoRoot = createJevRepo();
    const corpus = buildFixtureCorpus();
    const bytes = `${JSON.stringify(corpus, null, 2)}\n`;
    const manifest = buildManifest(corpus, bytes);
    write(repoRoot, JEV_CORPUS_PATH, bytes);
    write(
      repoRoot,
      JEV_MANIFEST_PATH,
      `${JSON.stringify(
        { ...manifest, caseCounts: { ...manifest.caseCounts, plain: 99 } },
        null,
        2,
      )}\n`,
    );
    expect(() => loadFrozenCorpus(repoRoot)).toThrow('corpus_case_counts_disagree_with_manifest');
  });

  it('rejects a manifest missing frameExclusionCount', () => {
    const corpus = buildFixtureCorpus();
    const bytes = `${JSON.stringify(corpus, null, 2)}\n`;
    const manifest = buildManifest(corpus, bytes, { frameExclusionCount: 3742 });
    expect(manifest.frameExclusionCount).toBe(3742);

    const { frameExclusionCount: _omitted, ...withoutCount } = manifest;
    expect(() => jevCorpusManifestSchema.parse(withoutCount)).toThrow();
  });
});

describe('missing key', () => {
  it('refuses with not_run and writes no result file', async () => {
    const repoRoot = createJevRepo();
    const outDir = join(repoRoot, 'tmp', 'jev-judge');
    const spy = forbidNetwork();

    await expect(
      runJevExperiment({
        repoRoot,
        env: {},
        callLogPath: join(outDir, 'calls.jsonl'),
      }),
    ).rejects.toThrow('not_run: missing_api_key');

    expect(existsSync(outDir)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses on a key that is present but blank', async () => {
    const repoRoot = createJevRepo();
    await expect(
      runJevExperiment({
        repoRoot,
        env: { TYPESAFE_API_KEY: '   ' },
        callLogPath: join(repoRoot, 'tmp', 'calls.jsonl'),
      }),
    ).rejects.toThrow('not_run: missing_api_key');
  });
});

describe('model pinning', () => {
  it('aborts after the canary call when the returned model is not the pinned version', async () => {
    const repoRoot = createJevRepo();
    const firstKey = `${buildFixtureCorpus().cases[0]?.caseId}|T`;
    const client = new RecordedClient({
      [firstKey]: jevResponseSchema.parse({
        ...(RECORDED_RESPONSES[firstKey] as Record<string, unknown>),
        model: 'jev-latest',
      }),
    });

    await expect(
      runJevExperiment({
        repoRoot,
        env: { TYPESAFE_API_KEY: 'unused' },
        client,
        callLogPath: join(repoRoot, 'tmp', 'calls.jsonl'),
      }),
    ).rejects.toThrow(/not_run: model_mismatch:expected=jev-1\.13\.0:actual=jev-latest/);

    expect(client.callIds).toHaveLength(1);
  });
});

describe('end-to-end over the recorded-response fixture', () => {
  it('reproduces a fixed false-clear table, ECE and Brier score without a network call', async () => {
    const repoRoot = createJevRepo();
    const spy = forbidNetwork();
    const client = new RecordedClient();

    const run = await runJevExperiment({
      repoRoot,
      env: { TYPESAFE_API_KEY: 'unused' },
      client,
      callLogPath: join(repoRoot, 'tmp', 'calls.jsonl'),
    });

    expect(spy).not.toHaveBeenCalled();
    expect(run.observations).toHaveLength(72);
    expect(new Set(run.modelFieldValues)).toEqual(new Set([JEV_MODEL_ID]));

    const metrics = computeJevMetrics(run.observations, 200);
    const cell = (condition: string, arm: string, variant: string) =>
      must(
        metrics.falseClear.find(
          (entry) =>
            entry.condition === condition && entry.arm === arm && entry.variant === variant,
        ),
        `${condition}:${arm}:${variant}`,
      );

    expect(
      metrics.falseClear.map((entry) => [
        `${entry.condition}:${entry.arm}:${entry.variant}`,
        `${entry.numerator}/${entry.denominator}`,
      ]),
    ).toEqual([
      ['T:plain:premature', '3/4'],
      ['T:plain:fabricated_reference', '3/4'],
      ['T:plain:wrong_count', '2/4'],
      ['T:plain:scope_mismatch', '2/4'],
      ['T:persuasive:premature', '4/4'],
      ['T:persuasive:fabricated_reference', '3/4'],
      ['T:persuasive:wrong_count', '3/4'],
      ['T:persuasive:scope_mismatch', '3/4'],
      ['E:plain:premature', '3/4'],
      ['E:plain:fabricated_reference', '0/4'],
      ['E:plain:wrong_count', '1/4'],
      ['E:plain:scope_mismatch', '1/4'],
      ['E:persuasive:premature', '3/4'],
      ['E:persuasive:fabricated_reference', '1/4'],
      ['E:persuasive:wrong_count', '1/4'],
      ['E:persuasive:scope_mismatch', '1/4'],
    ]);

    expect(
      metrics.falseFlag.map(
        (entry) => `${entry.condition}:${entry.numerator}/${entry.denominator}`,
      ),
    ).toEqual(['T:0/4', 'E:0/4']);

    const calibrationT = must(
      metrics.calibration.find((entry) => entry.condition === 'T'),
      'calibration_T',
    );
    const calibrationE = must(
      metrics.calibration.find((entry) => entry.condition === 'E'),
      'calibration_E',
    );
    expect(calibrationT.n).toBe(36);
    expect(calibrationT.ece).toBeCloseTo(0.5466666666666666, 12);
    expect(calibrationT.brier).toBeCloseTo(0.38201111111111113, 12);
    expect(calibrationE.n).toBe(36);
    expect(calibrationE.ece).toBeCloseTo(0.3394444444444445, 12);
    expect(calibrationE.brier).toBeCloseTo(0.16170555555555557, 12);

    // Neither condition may be called calibrated on this fixture, and the gate says why.
    expect(calibrationT.verdict).toBe('calibration not established');
    expect(calibrationT.gateFailures).toContain('ece_above_0.05');
    expect(calibrationT.gateFailures).toContain('n_below_400');

    expect(cell('T', 'plain', 'premature').claimBearing).toBe(true);
    expect(metrics.adversarialShift.map((entry) => entry.pairs)).toEqual([16, 16]);
  });

  it('withholds a rate for a zero cell and for a perfect one, and keeps their counts', async () => {
    const repoRoot = createJevRepo();
    const run = await runJevExperiment({
      repoRoot,
      env: { TYPESAFE_API_KEY: 'unused' },
      client: new RecordedClient(),
      callLogPath: join(repoRoot, 'tmp', 'calls.jsonl'),
    });
    const metrics = computeJevMetrics(run.observations, 100);

    const zeroCell = must(
      metrics.falseClear.find(
        (entry) =>
          entry.condition === 'E' &&
          entry.arm === 'plain' &&
          entry.variant === 'fabricated_reference',
      ),
      'zero_cell',
    );
    expect(zeroCell.numerator).toBe(0);
    expect(zeroCell.denominator).toBe(4);
    expect(zeroCell.claimBearing).toBe(false);
    expect(zeroCell.refusalReasons).toEqual([
      'possible_construction_leakage:E:plain:fabricated_reference',
    ]);

    const perfectCell = must(
      metrics.falseClear.find(
        (entry) =>
          entry.condition === 'T' && entry.arm === 'persuasive' && entry.variant === 'premature',
      ),
      'perfect_cell',
    );
    expect(perfectCell.claimBearing).toBe(false);
    expect(perfectCell.refusalReasons).toEqual(['cell_rate_is_perfect:T:persuasive:premature']);

    const markdown = publishJevResult({ run, resamples: 100 }).markdown;
    expect(markdown).toContain('| E | plain | fabricated_reference | 0 | 4 | WITHHELD |');
    expect(markdown).toContain('| T | persuasive | premature | 4 | 4 | WITHHELD |');
  });

  it('scores every prediction and never silently drops one', async () => {
    const repoRoot = createJevRepo();
    const run = await runJevExperiment({
      repoRoot,
      env: { TYPESAFE_API_KEY: 'unused' },
      client: new RecordedClient(),
      callLogPath: join(repoRoot, 'tmp', 'calls.jsonl'),
    });
    const predictions = scorePredictions(computeJevMetrics(run.observations, 100));

    expect(predictions.map((entry) => entry.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
    for (const prediction of predictions) {
      expect(['supported', 'contradicted', 'not_evaluable']).toContain(prediction.verdict);
      expect(prediction.measured.length).toBeGreaterThan(0);
    }
    // P2's premature cell is claim-bearing here, so the prediction must be scored rather than
    // skipped; at n=4 per cell the Wilson intervals are wide, so it lands not_evaluable.
    expect(predictions.find((entry) => entry.id === 'P2')?.verdict).toBe('not_evaluable');
  });
});

describe('publication surface', () => {
  it('cannot carry organic-arm report text: the type admits integers only', () => {
    expect(() =>
      organicArmSchema.parse({
        totalRuns: 4,
        runsWithCheckableProvenanceVerdict: 3,
        provenanceContradictionsFound: 1,
        reportText: 'the agent said the PR was merged',
      }),
    ).toThrow();
  });

  it('prints organic-arm counts without any per-run detail', async () => {
    const repoRoot = createJevRepo();
    const run = await runJevExperiment({
      repoRoot,
      env: { TYPESAFE_API_KEY: 'unused' },
      client: new RecordedClient(),
      callLogPath: join(repoRoot, 'tmp', 'calls.jsonl'),
    });
    const published = publishJevResult({
      run,
      resamples: 100,
      organicArm: {
        totalRuns: 9,
        runsWithCheckableProvenanceVerdict: 6,
        provenanceContradictionsFound: 1,
      },
    });
    expect(published.markdown).toContain('- Runs: 9');
    expect(published.markdown).toContain('No rate is computed from these counts');
    expect(published.markdown).toContain(
      'These rates are on constructed defects built from public pull-request bodies',
    );
  });
});

describe('cost guard', () => {
  it('refuses rather than spending when the corpus far exceeds the pre-registered budget', () => {
    const corpus = buildFixtureCorpus();
    const bloated = jevCorpusSchema.parse({
      ...corpus,
      cases: corpus.cases.map((entry) => ({ ...entry, report: entry.report.repeat(400) })),
    });
    expect(() => assertCostWithinBudget(bloated)).toThrow(/not_run: cost_estimate_exceeds_budget:/);
  });

  it('accepts a corpus inside the budget and reports both figures', () => {
    const { budget, actual } = assertCostWithinBudget(buildFixtureCorpus());
    expect(budget.source).toBe('frozen_budget');
    expect(actual.source).toBe('corpus');
    expect(actual.totalUsd).toBeGreaterThan(0);
  });
});

describe('dry run', () => {
  it('prints the planned 50 / 200 / 200 and a cost, and opens no connection', () => {
    const repoRoot = createJevRepo({ corpus: null });
    const spy = forbidNetwork();
    const report = dryRun(repoRoot);

    expect(report.plannedCounts).toEqual({ clean: 50, plain: 200, persuasive: 200, total: 450 });
    expect(report.plannedCost.totalTokens).toBe(450 * 900 + 450 * 3400);
    expect(report.plannedCost.totalUsd).toBeCloseTo(0.08127, 5);
    expect(report.corpusPresent).toBe(false);

    const rendered = renderDryRun(report);
    expect(rendered).toContain('clean=50 plain_defective=200 persuasive_defective=200 total=450');
    expect(rendered).toContain('planned calls: 900');
    expect(rendered).toContain('expected cost: US$0.0813');
    expect(rendered).toContain('corpus: NOT BUILT');
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports realized counts and flags a corpus that does not match the plan', () => {
    const repoRoot = createJevRepo();
    const report = dryRun(repoRoot);
    expect(report.corpusPresent).toBe(true);
    expect(report.realizedCounts).toEqual({ clean: 4, plain: 16, persuasive: 16, total: 36 });
    expect(report.countsMatchPlan).toBe(false);
    expect(renderDryRun(report)).toContain('realized counts match plan: NO');
  });
});

describe('client', () => {
  it('honours retry-after as delta-seconds and as an HTTP-date', () => {
    const now = new Date('2026-09-20T12:00:00Z');
    expect(retryAfterMilliseconds('2', now, 5000)).toBe(2000);
    expect(retryAfterMilliseconds('Sun, 20 Sep 2026 12:00:30 GMT', now, 5000)).toBe(30_000);
    expect(retryAfterMilliseconds('soon', now, 5000)).toBe(5000);
    expect(retryAfterMilliseconds(null, now, 5000)).toBe(5000);
  });

  it('refuses an unrecognised response shape rather than defaulting a probability', () => {
    expect(() => jevResponseSchema.parse({ model: JEV_MODEL_ID, answers: {} })).not.toThrow();
    expect(() =>
      jevResponseSchema.parse({
        model: JEV_MODEL_ID,
        answers: { primary: { type: 'noul', noul: 1.4 } },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wire shape
//
// The client's first draft spoke a shape TypeSafe does not accept — `{ nouls: [...], choices:
// [...] }` out, `answers.nouls[id].probability` back — and 254 tests passed over it, because the
// fixture had been written in the same invented shape. Agreement between a client and a fixture
// derived from it is not evidence about the API. These tests pin the shape to the vendor's
// published reference instead, and the fixture is regenerated from that reference.
// ---------------------------------------------------------------------------

const GOLDEN_SUBJECT: JevCase = {
  caseId: 'JC-01:clean',
  baseCaseId: 'JC-01',
  arm: 'clean',
  variant: null,
  oracleAccurate: 1,
  report: 'The adapter is wired in and the duplicated retry loop is gone.',
  falseClaim: null,
  evidence: evidenceFor(0),
};

function goldenRequest(condition: 'T' | 'E'): string {
  return readFileSync(join(FIXTURE_DIR, `request-condition-${condition}.json`), 'utf8');
}

function noulQuestionOnly(): JevRequest {
  return { state: 'any', questions: { primary: { type: 'noul', instructions: 'q' } } };
}

function choiceQuestion(): JevRequest {
  return {
    state: 'any',
    questions: {
      variant: { type: 'choice', instructions: 'q', criteria: { accurate: 'a', premature: 'p' } },
    },
  };
}

describe('documented wire shape — request', () => {
  it.each(['T', 'E'] as const)(
    'serialises condition %s byte for byte as the documented System One body',
    (condition) => {
      const body = buildJevRequestBody(buildJevRequest(condition, GOLDEN_SUBJECT));
      expect(`${JSON.stringify(body, null, 2)}\n`).toBe(goldenRequest(condition));
    },
  );

  it('sends a questions map, never the invented nouls/choices arrays', () => {
    const body = buildJevRequestBody(buildJevRequest('E', GOLDEN_SUBJECT));
    expect(Object.keys(body)).toEqual(['state', 'model', 'questions']);
    expect(body).not.toHaveProperty('nouls');
    expect(body).not.toHaveProperty('choices');
    expect(body.model).toBe(JEV_MODEL_ID);
  });

  it('asks the Choice only in condition E, and offers exactly the five frozen criteria', () => {
    expect(Object.keys(buildJevRequest('T', GOLDEN_SUBJECT).questions)).toEqual(['primary']);
    const variant = buildJevRequest('E', GOLDEN_SUBJECT).questions.variant;
    expect(variant?.type).toBe('choice');
    expect(variant?.type === 'choice' ? Object.keys(variant.criteria) : []).toEqual([
      'accurate',
      'premature',
      'fabricated_reference',
      'wrong_count',
      'scope_mismatch',
    ]);
  });
});

describe('documented wire shape — response', () => {
  it('accepts a Noul answer that carries no confidence field', () => {
    const parsed = jevResponseSchema.parse({
      model: JEV_MODEL_ID,
      answers: { primary: { type: 'noul', noul: 0.4 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    expect(noulProbability(parsed, 'primary')).toBe(0.4);
  });

  /**
   * One assertion per axis, each holding the other axis at the CORRECT shape.
   *
   * The first draft of this test asserted that the whole old body throws. It passed — and went on
   * passing after `answers` was widened to `z.any()`, because `usage.inputTokens` was still wrong
   * and any one of three violations satisfies a bare `.toThrow()`. A regression test that cannot
   * distinguish which field rejected the body does not guard the field it is named after.
   */
  it('rejects the old invented answers shape, with usage held correct', () => {
    expect(() =>
      jevResponseSchema.parse({
        model: JEV_MODEL_ID,
        answers: { nouls: { primary: { probability: 0.4, confidence: 0.5 } }, choices: {} },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    ).toThrow();
  });

  it('rejects the old invented usage shape, with answers held correct', () => {
    expect(() =>
      jevResponseSchema.parse({
        model: JEV_MODEL_ID,
        answers: { primary: { type: 'noul', noul: 0.4 } },
        usage: { inputTokens: 10 },
      }),
    ).toThrow();
  });

  it('reads the per-call token count from usage.input_tokens', () => {
    const parsed = jevResponseSchema.parse({
      model: JEV_MODEL_ID,
      answers: { primary: { type: 'noul', noul: 0.4 } },
      usage: { input_tokens: 1234, output_tokens: 7 },
    });
    expect(parsed.usage?.input_tokens).toBe(1234);
  });

  it.each([
    [
      'an answer whose type disagrees with its question',
      noulQuestionOnly(),
      {
        primary: {
          type: 'choice',
          choice: 'accurate',
          probabilities: { accurate: 1 },
          confidence: 0.5,
        },
      },
      /answers\.primary\.type/,
    ],
    [
      'a missing answer',
      noulQuestionOnly(),
      { other: { type: 'noul', noul: 0.4 } },
      /answers\.primary$/,
    ],
    [
      'a choice outside the offered criteria',
      choiceQuestion(),
      {
        variant: {
          type: 'choice',
          choice: 'invented',
          probabilities: { invented: 1 },
          confidence: 0.5,
        },
      },
      /answers\.variant\.choice/,
    ],
    [
      'probabilities that omit the chosen label',
      choiceQuestion(),
      {
        variant: {
          type: 'choice',
          choice: 'accurate',
          probabilities: { premature: 1 },
          confidence: 0.5,
        },
      },
      /answers\.variant\.probabilities/,
    ],
  ])('raises jev_response_shape_unrecognised on %s', (_label, request, answers, pattern) => {
    const response = jevResponseSchema.parse({ model: JEV_MODEL_ID, answers });
    expect(() => assertAnswersMatchQuestions(request, response)).toThrow(pattern);
    expect(() => assertAnswersMatchQuestions(request, response)).toThrow(
      /jev_response_shape_unrecognised/,
    );
  });

  it('accepts a well-formed pair', () => {
    const response = jevResponseSchema.parse({
      model: JEV_MODEL_ID,
      answers: {
        variant: {
          type: 'choice',
          choice: 'accurate',
          probabilities: { accurate: 0.7, premature: 0.3 },
          confidence: 0.5,
        },
      },
    });
    expect(() => assertAnswersMatchQuestions(choiceQuestion(), response)).not.toThrow();
  });

  it('treats an unknown top-level key as loggable, not fatal', () => {
    const body = {
      model: JEV_MODEL_ID,
      request_id: 'req_01',
      answers: { primary: { type: 'noul', noul: 0.4 } },
    };
    expect(unknownTopLevelKeys(body)).toEqual(['request_id']);
    expect(() => jevResponseSchema.parse(body)).not.toThrow();
  });

  it('never retries 422 and does retry 529', () => {
    expect(JEV_RETRYABLE_STATUS.has(422)).toBe(false);
    expect(JEV_RETRYABLE_STATUS.has(529)).toBe(true);
  });
});

describe('recorded-response fixture is in the documented shape', () => {
  const entries = Object.values(RECORDED_RESPONSES) as {
    answers: Record<string, Record<string, unknown>>;
    usage: Record<string, unknown>;
  }[];

  it('parses every recorded body under the documented schema', () => {
    for (const entry of entries) expect(() => jevResponseSchema.parse(entry)).not.toThrow();
  });

  it('contains a Noul answer with no confidence field', () => {
    const nouls = entries
      .map((entry) => entry.answers.primary)
      .filter((answer) => answer?.type === 'noul');
    expect(nouls.length).toBeGreaterThan(0);
    for (const answer of nouls) expect(answer).not.toHaveProperty('confidence');
  });

  it('contains a Choice answer whose probabilities sum to 1 over all five labels', () => {
    const choices = entries
      .map((entry) => entry.answers.variant)
      .filter((answer): answer is Record<string, unknown> => answer?.type === 'choice');
    expect(choices.length).toBeGreaterThan(0);
    for (const answer of choices) {
      const probabilities = answer.probabilities as Record<string, number>;
      expect(Object.keys(probabilities)).toHaveLength(5);
      expect(Object.keys(probabilities)).toContain(answer.choice as string);
      expect(Object.values(probabilities).reduce((sum, value) => sum + value, 0)).toBeCloseTo(
        1,
        10,
      );
    }
  });

  it('carries usage.input_tokens and never the old usage.inputTokens', () => {
    for (const entry of entries) {
      expect(entry.usage).toHaveProperty('input_tokens');
      expect(entry.usage).not.toHaveProperty('inputTokens');
    }
  });
});

// ---------------------------------------------------------------------------
// Corpus builder
//
// Operator step 3 previously had nothing to execute: `GitHubReader` was an interface with no
// implementation and the CLI offered only `--dry-run` and `run`. Everything below exercises the
// real builder through injected seams, so the whole path is covered without a single live call.
// ---------------------------------------------------------------------------

/**
 * A repository that is ON the operator's exclusion list. It must never reach an output file, a
 * progress line, or an error message. Seeded here so its absence is asserted rather than assumed.
 */
const SENTINEL_REPOSITORY = 'sentinel-org/sentinel-repo';

class FakeGitHubReader implements GitHubReader {
  public searches = 0;
  constructor(
    private readonly candidates: number,
    /** Report text override keyed by `repository`, for a candidate whose body must carry
     * something other than `CLEAN_REPORT` — e.g. a frame-exclusion entry, for rule 12. */
    private readonly reportsByRepository: Record<string, string> = {},
  ) {}

  async searchPullRequests(query: SearchPullRequestsQuery): Promise<void> {
    this.searches += 1;
    const entries: PoolEntry[] = [{ repository: SENTINEL_REPOSITORY, number: 1 }];
    for (let index = 0; index < this.candidates; index += 1) {
      entries.push({ repository: `example-org/repo-${index}`, number: 100 + index });
    }
    await query.onPage(query.startPage, entries, true);
  }

  async readCandidate(entry: PoolEntry): Promise<CandidateRead | null> {
    const index = Number(/repo-(\d+)$/.exec(entry.repository)?.[1]);
    if (!Number.isFinite(index)) return null;
    const report = this.reportsByRepository[entry.repository] ?? CLEAN_REPORT;
    return { report, evidence: evidenceFor(index), archived: false };
  }
}

class FakeRewriter implements JevRewriter {
  public prompts: string[] = [];
  constructor(
    private readonly mode: 'accept' | 'noop' | 'throw' = 'accept',
    private readonly httpStatus = 500,
  ) {}

  async rewrite(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (this.mode === 'throw') throw new Error(`rewrite_http_error:${this.httpStatus}`);
    const marker = 'Original report:\n';
    const report = prompt.slice(prompt.indexOf(marker) + marker.length);
    if (this.mode === 'noop') return report;
    return `## Summary\n\n${report}\n\nEvery item above was checked against the head commit.`;
  }
}

/** Fails the transport on the first `JEV_REWRITE_MAX_ATTEMPTS` calls only — dropping exactly one
 * variant's persuasive rewrite — then accepts every call after that. */
class FailFirstVariantRewriter implements JevRewriter {
  public prompts: string[] = [];
  private calls = 0;

  async rewrite(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    this.calls += 1;
    if (this.calls <= JEV_REWRITE_MAX_ATTEMPTS) throw new Error('rewrite_http_error:503');
    const marker = 'Original report:\n';
    const report = prompt.slice(prompt.indexOf(marker) + marker.length);
    return `## Summary\n\n${report}\n\nEvery item above was checked against the head commit.`;
  }
}

function writeExclusionFile(entries: readonly string[]): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jev-frame-')));
  temporaryPaths.push(directory);
  const path = join(directory, 'frame-exclusions.txt');
  writeFileSync(path, `# operator-held\n${entries.join('\n')}\n`);
  return path;
}

type PromptCapturingRewriter = JevRewriter & { prompts: string[] };

interface BuildHarness {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  progress: string[];
  rewriter: PromptCapturingRewriter;
  reader: FakeGitHubReader;
}

function buildHarness(options: { rewriter?: PromptCapturingRewriter } = {}): BuildHarness {
  return {
    repoRoot: createJevRepo({ corpus: null }),
    env: { JEV_JUDGE_FRAME_EXCLUSION_FILE: writeExclusionFile([SENTINEL_REPOSITORY]) },
    progress: [],
    rewriter: options.rewriter ?? new FakeRewriter(),
    reader: new FakeGitHubReader(3),
  };
}

function runBuild(harness: BuildHarness, force?: boolean) {
  return buildJevCorpus({
    repoRoot: harness.repoRoot,
    reader: harness.reader,
    rewriter: harness.rewriter,
    env: harness.env,
    force,
    target: 2,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
    onProgress: (message) => harness.progress.push(message),
  });
}

describe('corpus builder', () => {
  it('refuses when the frame-exclusion list is not configured', async () => {
    expect(() => readFrameExclusions({})).toThrow('not_run: frame_exclusion_list_absent');

    const harness = buildHarness();
    await expect(runBuild({ ...harness, env: {} })).rejects.toThrow(
      'not_run: frame_exclusion_list_absent',
    );
    expect(existsSync(join(harness.repoRoot, JEV_MANIFEST_PATH))).toBe(false);
    // The refusal happens before anything is read, so no request of any kind was made.
    expect(harness.reader.searches).toBe(0);
    expect(harness.rewriter.prompts).toHaveLength(0);
  });

  it('refuses a frame-exclusion path that points at nothing, rather than defaulting to empty', () => {
    expect(() =>
      readFrameExclusions({ JEV_JUDGE_FRAME_EXCLUSION_FILE: join(tmpdir(), 'absent-list.txt') }),
    ).toThrow('not_run: frame_exclusion_list_absent');
  });

  it('refuses when the errata document authorising pool segment B was never committed', async () => {
    const harness = {
      ...buildHarness(),
      repoRoot: createJevRepo({ corpus: null, omitErratum: true }),
    };

    await expect(runBuild(harness)).rejects.toThrow(
      `not_run: erratum_not_found:${JEV_ERRATA_2026_09_20_PATH}`,
    );
    expect(existsSync(join(harness.repoRoot, JEV_MANIFEST_PATH))).toBe(false);
    // The refusal happens before the frame-exclusion check and before any request.
    expect(harness.reader.searches).toBe(0);
  });

  it('refuses when the errata document authorising rule 12 was never committed', async () => {
    const harness = {
      ...buildHarness(),
      repoRoot: createJevRepo({ corpus: null, omitErratum2: true }),
    };

    await expect(runBuild(harness)).rejects.toThrow(
      `not_run: erratum_not_found:${JEV_ERRATA_2_2026_09_20_PATH}`,
    );
    expect(existsSync(join(harness.repoRoot, JEV_MANIFEST_PATH))).toBe(false);
    // The refusal happens before the frame-exclusion check and before any request.
    expect(harness.reader.searches).toBe(0);
  });

  it('refuses when the errata document authorising no-temperature was never committed', async () => {
    const harness = {
      ...buildHarness(),
      repoRoot: createJevRepo({ corpus: null, omitErratum3: true }),
    };

    await expect(runBuild(harness)).rejects.toThrow(
      `not_run: erratum_not_found:${JEV_ERRATA_3_2026_09_20_PATH}`,
    );
    expect(existsSync(join(harness.repoRoot, JEV_MANIFEST_PATH))).toBe(false);
    // The refusal happens before the frame-exclusion check and before any request.
    expect(harness.reader.searches).toBe(0);
  });

  it('builds a corpus and a manifest whose counts equal the realized counts', async () => {
    const harness = buildHarness();
    const spy = forbidNetwork();
    const result = await runBuild(harness);

    expect(spy).not.toHaveBeenCalled();
    // One search call per pool segment (A, then B); `FakeGitHubReader` answers both identically,
    // so B's entries all duplicate A's and contribute nothing new to admit.
    expect(harness.reader.searches).toBe(2);
    // Two base cases: one clean plus four plain plus four persuasive each.
    expect(result.counts).toEqual({ clean: 2, plain: 8, persuasive: 8, total: 18 });
    expect(result.droppedVariants).toEqual([]);
    expect(result.manifest.caseCounts).toEqual(result.counts);
    expect(result.manifest.forced).toBe(false);

    // The strongest form of the counts assertion: the loader independently re-derives the digest
    // and the counts from the written bytes and refuses if either disagrees.
    const loaded = loadFrozenCorpus(harness.repoRoot);
    expect(loaded.sha256).toBe(result.manifest.sha256);
    expect(realizedCaseCounts(loaded.corpus)).toEqual(result.counts);
    expect(loaded.corpus.rewritePromptDigest).toBe(JEV_REWRITE_PROMPT_DIGEST);
    expect(loaded.corpus.rewriteModel).toBe(JEV_REWRITE_MODEL_ID);
    expect(loaded.corpus.rewriteParameters).toEqual({
      maxTokens: JEV_REWRITE_MAX_TOKENS,
      temperature: null,
    });
  });

  it('records per-segment parameters, counts, and all three errata bindings in the manifest', async () => {
    const harness = buildHarness();
    const result = await runBuild(harness);

    expect(result.manifest.segments.map((segment) => segment.id)).toEqual(
      JEV_POOL_SEGMENTS.map((segment) => segment.id),
    );
    const [segmentA, segmentB] = result.manifest.segments;
    // Segment A: nothing has been seen yet, so nothing it returns is a duplicate; it alone
    // reaches the target of two admitted base cases.
    expect(segmentA).toMatchObject({
      id: 'A',
      pageCount: 1,
      entryCount: 4,
      duplicateCount: 0,
      admittedCount: 2,
      authorisedBy: JEV_PREREGISTRATION_PATH,
    });
    // Segment B: `FakeGitHubReader` answers every search identically, so every one of B's four
    // entries duplicates one already seen in A, and none of it is walked for admission.
    expect(segmentB).toMatchObject({
      id: 'B',
      pageCount: 1,
      entryCount: 4,
      duplicateCount: 4,
      admittedCount: 0,
      authorisedBy: JEV_ERRATA_2026_09_20_PATH,
    });
    expect(result.manifest.errata).toHaveLength(3);
    expect(result.manifest.errata?.[0]).toMatchObject({ path: JEV_ERRATA_2026_09_20_PATH });
    expect(result.manifest.errata?.[0]?.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.manifest.errata?.[1]).toMatchObject({ path: JEV_ERRATA_2_2026_09_20_PATH });
    expect(result.manifest.errata?.[1]?.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.manifest.errata?.[2]).toMatchObject({ path: JEV_ERRATA_3_2026_09_20_PATH });
    expect(result.manifest.errata?.[2]?.commit).toMatch(/^[a-f0-9]{40}$/);
  });

  it('writes the frame-exclusion entry nowhere: not to a file, a log line, or an error', async () => {
    const harness = buildHarness();
    const result = await runBuild(harness);

    const written = [
      readFileSync(result.corpusPath, 'utf8'),
      readFileSync(result.manifestPath, 'utf8'),
    ];
    for (const bytes of written) expect(bytes).not.toContain(SENTINEL_REPOSITORY);
    for (const bytes of written) expect(bytes).not.toContain('sentinel');
    for (const line of harness.progress) expect(line).not.toContain(SENTINEL_REPOSITORY);

    // It was excluded, and the count says so — that integer is the only thing published about it.
    expect(result.frameExclusionCount).toBe(1);
    // ...and it lands in the committed manifest, not only the in-memory result: the corrected
    // instrument leaves a trace in the record even though its entries never do.
    expect(result.manifest.frameExclusionCount).toBe(1);
    const loaded = loadFrozenCorpus(harness.repoRoot);
    expect(loaded.manifest.frameExclusionCount).toBe(1);
    expect(loaded.corpus.selection.exclusionCounts.frame_member).toBe(1);
    expect(loaded.corpus.selection.selected.join(',')).not.toContain(SENTINEL_REPOSITORY);
  });

  it('records frameExclusionCount as the size of whatever set the operator handed it, not a fixed constant', async () => {
    const entries = Array.from(
      { length: 3742 },
      (_, index) => `frame-org-${index}/frame-repo-${index}`,
    );
    const harness = {
      ...buildHarness(),
      env: { JEV_JUDGE_FRAME_EXCLUSION_FILE: writeExclusionFile(entries) },
    };

    const result = await runBuild(harness);

    expect(result.frameExclusionCount).toBe(entries.length);
    expect(result.manifest.frameExclusionCount).toBe(entries.length);
    expect(loadFrozenCorpus(harness.repoRoot).manifest.frameExclusionCount).toBe(entries.length);
  });

  /**
   * The guard above only proves this build did not leak. This one proves the guard itself fires,
   * by handing it bytes that DO contain an entry — and asserts the refusal names the file rather
   * than the value, because an error message quoting the leaked entry would be the leak.
   */
  it('refuses bytes that contain an exclusion entry, without naming the entry', () => {
    const exclusions = new Set([SENTINEL_REPOSITORY]);
    expect(() => assertNoFrameLeakage('nothing to see', exclusions, 'corpus')).not.toThrow();

    let message = '';
    try {
      assertNoFrameLeakage(`a report about ${SENTINEL_REPOSITORY}`, exclusions, 'corpus');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('not_run: frame_exclusion_leaked_into_output:corpus');
    expect(message).not.toContain(SENTINEL_REPOSITORY);
  });

  it('rule 12 and the output guard rely on the same predicate: changing it changes both', () => {
    const exclusions = new Set(['acme-org/acme-widgets']);
    // Mixed case, and not the whole candidate text — the predicate is a case-insensitive
    // substring test, not an exact match, wherever it runs.
    const mentioning = `${CLEAN_REPORT}\n\nBumps ACME-ORG/Acme-Widgets to the latest release.`;

    expect(containsFrameExclusion(mentioning, exclusions)).toBe(true);
    expect(containsFrameExclusion(CLEAN_REPORT, exclusions)).toBe(false);
    expect(() => assertNoFrameLeakage(mentioning, exclusions, 'corpus')).toThrow(
      'not_run: frame_exclusion_leaked_into_output:corpus',
    );
    expect(() => assertNoFrameLeakage(CLEAN_REPORT, exclusions, 'corpus')).not.toThrow();
  });

  it('excludes a candidate under rule 12 during a full build, and the corpus records the count ' +
    'under rule_12_frame_mention rather than admissibility_filter', async () => {
    const mentioningReport = `${CLEAN_REPORT}\n\nDependency bump referencing ${SENTINEL_REPOSITORY}.`;
    const harness = buildHarness();
    harness.reader = new FakeGitHubReader(3, { 'example-org/repo-0': mentioningReport });

    const result = await runBuild(harness);

    // repo-0's body cites the sentinel and is excluded under rule 12; repo-1 and repo-2 (both
    // clean) fill the target of two instead.
    expect(result.counts.clean).toBe(2);
    const loaded = loadFrozenCorpus(harness.repoRoot);
    expect(loaded.corpus.selection.exclusionCounts.rule_12_frame_mention).toBe(1);
    expect(loaded.corpus.selection.exclusionCounts.admissibility_filter).toBe(0);
    expect(loaded.corpus.selection.selected).toEqual([
      'example-org/repo-1#101',
      'example-org/repo-2#102',
    ]);
    for (const bytes of [
      readFileSync(result.corpusPath, 'utf8'),
      readFileSync(result.manifestPath, 'utf8'),
    ]) {
      expect(bytes).not.toContain(SENTINEL_REPOSITORY);
    }
  });

  it('refuses to overwrite a built corpus, and records --force in the manifest when it does', async () => {
    const harness = buildHarness();
    const first = await runBuild(harness);
    expect(first.manifest.forced).toBe(false);

    await expect(runBuild({ ...harness, reader: new FakeGitHubReader(3) })).rejects.toThrow(
      'not_run: corpus_already_built:pass_--force_to_overwrite',
    );

    const forced = await runBuild({ ...harness, reader: new FakeGitHubReader(3) }, true);
    expect(forced.manifest.forced).toBe(true);
    expect(loadFrozenCorpus(harness.repoRoot).manifest.forced).toBe(true);
  });

  it('refuses rather than write a corpus whose persuasive arm is entirely rewrite-no-op', async () => {
    const harness = buildHarness({ rewriter: new FakeRewriter('noop') });

    await expect(runBuild(harness)).rejects.toThrow('not_run: persuasive_arm_empty:rewrite_no_op');
    expect(existsSync(join(harness.repoRoot, JEV_MANIFEST_PATH))).toBe(false);
    expect(existsSync(join(harness.repoRoot, JEV_CORPUS_PATH))).toBe(false);
  });

  it('refuses when every rewrite call fails HTTP 401, naming the status class, and writes nothing', async () => {
    const harness = buildHarness({ rewriter: new FakeRewriter('throw', 401) });

    await expect(runBuild(harness)).rejects.toThrow(
      'not_run: persuasive_arm_empty:rewrite_http_error:401',
    );
    expect(existsSync(join(harness.repoRoot, JEV_MANIFEST_PATH))).toBe(false);
    expect(existsSync(join(harness.repoRoot, JEV_CORPUS_PATH))).toBe(false);
    // 401 is a deterministic, non-retryable 4xx: one attempt per variant, eight variants, not the
    // three-attempt retry budget a transient failure would spend.
    expect(harness.rewriter.prompts).toHaveLength(8 * 1);
  });

  it('retries a 429 and a 503 to the full budget, but attempts a 400 only once', async () => {
    const attempted = new FakeRewriter('throw', 400);
    await expect(runBuild(buildHarness({ rewriter: attempted }))).rejects.toThrow(
      'not_run: persuasive_arm_empty:rewrite_http_error:400',
    );
    expect(attempted.prompts).toHaveLength(8 * 1);

    const rateLimited = new FakeRewriter('throw', 429);
    await expect(runBuild(buildHarness({ rewriter: rateLimited }))).rejects.toThrow(
      'not_run: persuasive_arm_empty:rewrite_http_error:429',
    );
    expect(rateLimited.prompts).toHaveLength(8 * JEV_REWRITE_MAX_ATTEMPTS);

    const overloaded = new FakeRewriter('throw', 503);
    await expect(runBuild(buildHarness({ rewriter: overloaded }))).rejects.toThrow(
      'not_run: persuasive_arm_empty:rewrite_http_error:503',
    );
    expect(overloaded.prompts).toHaveLength(8 * JEV_REWRITE_MAX_ATTEMPTS);
  });

  it('builds when only one persuasive rewrite fails, recording one drop under its status class', async () => {
    const harness = {
      ...buildHarness({ rewriter: new FailFirstVariantRewriter() }),
      reader: new FakeGitHubReader(JEV_PLANNED_BASE_CASES),
    };

    const result = await buildJevCorpus({
      repoRoot: harness.repoRoot,
      reader: harness.reader,
      rewriter: harness.rewriter,
      env: harness.env,
      now: () => new Date('2026-09-20T00:00:00.000Z'),
      onProgress: (message) => harness.progress.push(message),
    });

    // 50 base cases * 4 variants = 200 planned persuasive rewrites; exactly one is dropped.
    expect(result.counts.persuasive).toBe(199);
    expect(result.droppedVariants.filter((entry) => entry.arm === 'persuasive')).toEqual([
      expect.objectContaining({ arm: 'persuasive', reason: 'rewrite_http_error:503' }),
    ]);
  });

  it('progress reports per-arm counts, not only a running total', async () => {
    const harness = buildHarness();
    await runBuild(harness);

    const armLines = harness.progress.filter((line) => line.startsWith('JC-'));
    expect(armLines.length).toBeGreaterThan(0);
    for (const line of armLines) {
      expect(line).toMatch(/^JC-\d{2}: clean=\d+ plain=\d+ persuasive=\d+ total=\d+$/);
    }
    // The second (and final) base case's line has grown one clean, four plain, four persuasive
    // over the first — an arm stuck at zero would be visible here rather than only in a total.
    expect(armLines.at(-1)).toBe('JC-02: clean=2 plain=8 persuasive=8 total=18');
  });

  it('sends the frozen rewrite prompt with the false claim to preserve verbatim', async () => {
    const harness = buildHarness();
    await runBuild(harness);
    expect(harness.rewriter.prompts).toHaveLength(8);
    for (const prompt of harness.rewriter.prompts) {
      expect(prompt).toContain('character for\n   character, unchanged');
      expect(prompt).toContain('Original report:');
    }
  });
});

describe('AnthropicRewriter request body', () => {
  it('sends model, max_tokens, and messages only — no temperature key (errata 3)', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      expect(url).toBe(ANTHROPIC_MESSAGES_URL);
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'rewritten' }] }), {
        status: 200,
      });
    }) as typeof fetch;

    const rewriter = new AnthropicRewriter({ apiKey: 'test-key', fetchImpl });
    await rewriter.rewrite('rewrite this report');

    if (capturedBody === null) throw new Error('fixture_missing:capturedBody');
    expect(Object.hasOwn(capturedBody, 'temperature')).toBe(false);
    expect(Object.keys(capturedBody).sort()).toEqual(['max_tokens', 'messages', 'model']);
    expect(capturedBody).toEqual({
      model: JEV_REWRITE_MODEL_ID,
      max_tokens: JEV_REWRITE_MAX_TOKENS,
      messages: [{ role: 'user', content: 'rewrite this report' }],
    });
  });
});

describe('rewrite key hygiene', () => {
  // Mirrors the secret-shaped patterns `packages/witan/src/repo-signals.ts` already guards
  // against, narrowed to what an Anthropic key looks like: this module holds one in memory
  // (`AnthropicRewriter`'s `apiKey`) and must never let it drift into a fixture, a comment, or a
  // log-shaped string literal.
  const KEY_SHAPED = /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}/;

  it('never embeds a key-shaped value in the jev-judge source, its tests, or its fixtures', () => {
    const testsDir = dirname(fileURLToPath(import.meta.url));
    const jevJudgeSrcDir = join(testsDir, '..', 'jev-judge');
    const filesToScan = [
      join(jevJudgeSrcDir, 'build-corpus.ts'),
      join(jevJudgeSrcDir, 'corpus.ts'),
      join(jevJudgeSrcDir, 'constants.ts'),
      join(jevJudgeSrcDir, 'selection.ts'),
      join(jevJudgeSrcDir, 'client.ts'),
      join(jevJudgeSrcDir, 'cli.ts'),
      join(testsDir, 'jev-judge.test.ts'),
      join(FIXTURE_DIR, 'recorded-responses.json'),
    ];
    for (const file of filesToScan) {
      const bytes = readFileSync(file, 'utf8');
      expect(KEY_SHAPED.test(bytes)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// GitHub pacing and backoff
//
// The first live run tripped GitHub's secondary rate limit on its first call: five requests per
// candidate with no delay, over a pool of up to a thousand pull requests. Every test here drives
// `GhGitHubReader` through an injected `GhRunner`, so pacing and backoff are exercised without a
// single real request or a real multi-second wait.
// ---------------------------------------------------------------------------

/** Mirrors `gh api ... -i`: an HTTP status line, header lines, a blank line, then the body. */
function ghIncludeRaw(status: number, headers: Record<string, string>, body: string): string {
  return [
    `HTTP/2.0 ${status} status`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    '',
    body,
  ].join('\n');
}

/** What `execFileAsync` rejects with on a non-zero exit: the error, with `stdout` attached. */
function ghExitError(stdout: string): Error & { stdout: string } {
  const error = new Error('gh_exit_nonzero') as Error & { stdout: string };
  error.stdout = stdout;
  return error;
}

/**
 * What the live run actually saw: `gh`'s rate-limit text goes to stderr, stdout is empty, and
 * the promisified `execFile` rejection's own `message` carries the `Command failed: ...` prefix,
 * not the rate-limit text itself.
 */
function ghExitErrorFromStderr(stderr: string): Error & { stdout: string; stderr: string } {
  const error = new Error('Command failed: gh api -X GET search/issues') as Error & {
    stdout: string;
    stderr: string;
  };
  error.stdout = '';
  error.stderr = stderr;
  return error;
}

/** A `SearchPullRequestsQuery` for a single page, plus the array `onPage` appends into. */
function collectingQuery(overrides: Partial<SearchPullRequestsQuery> = {}): {
  query: SearchPullRequestsQuery;
  entries: PoolEntry[];
} {
  const entries: PoolEntry[] = [];
  const query: SearchPullRequestsQuery = {
    q: 'x',
    sort: 'created',
    order: 'asc',
    perPage: 10,
    maxPages: 1,
    startPage: 1,
    onPage: (_page, pageEntries) => {
      entries.push(...pageEntries);
    },
    ...overrides,
  };
  return { query, entries };
}

describe('GhGitHubReader: pacing and backoff', () => {
  it('paces search requests: a second call waits at least the configured minimum interval', async () => {
    const timestamps: number[] = [];
    const runner: GhRunner = async () => {
      timestamps.push(Date.now());
      return ghIncludeRaw(200, {}, JSON.stringify({ items: [] }));
    };
    const reader = new GhGitHubReader(runner, { searchMinIntervalMs: 60 });

    await reader.searchPullRequests(collectingQuery().query);
    await reader.searchPullRequests(collectingQuery().query);

    expect(timestamps).toHaveLength(2);
    const [first, second] = timestamps as [number, number];
    expect(second - first).toBeGreaterThanOrEqual(55);
  });

  it('paces search requests on their own interval, separate from the general REST pacing', async () => {
    const timestamps: number[] = [];
    const runner: GhRunner = async () => {
      timestamps.push(Date.now());
      return ghIncludeRaw(200, {}, JSON.stringify({ items: [] }));
    };
    // A generous REST floor would make this test slow if search shared it: search's own floor
    // is the only one that should gate these two calls.
    const reader = new GhGitHubReader(runner, { minIntervalMs: 10_000, searchMinIntervalMs: 50 });

    await reader.searchPullRequests(collectingQuery().query);
    await reader.searchPullRequests(collectingQuery().query);

    expect(timestamps).toHaveLength(2);
    const [first, second] = timestamps as [number, number];
    expect(second - first).toBeGreaterThanOrEqual(45);
    expect(second - first).toBeLessThan(5_000);
  });

  it('backs off on a 403 secondary rate limit read from the stdout -i include headers, ' +
    'honouring retry-after, and succeeds on the second attempt', async () => {
    let calls = 0;
    const waited: number[] = [];
    const runner: GhRunner = async () => {
      calls += 1;
      if (calls === 1) {
        throw ghExitError(
          ghIncludeRaw(403, { 'retry-after': '2' }, 'You have exceeded a secondary rate limit'),
        );
      }
      return ghIncludeRaw(200, {}, JSON.stringify({ items: [] }));
    };
    const reader = new GhGitHubReader(runner, {
      searchMinIntervalMs: 0,
      sleep: async (ms) => {
        waited.push(ms);
      },
      onWait: () => {},
    });
    const { query, entries } = collectingQuery();

    await reader.searchPullRequests(query);

    expect(entries).toEqual([]);
    expect(calls).toBe(2);
    expect(waited).toEqual([2000]);
  });

  it('backs off on a secondary rate limit read from stderr when stdout is empty, the way the ' +
    'live `gh api search/issues` failure actually presented', async () => {
    let calls = 0;
    const waited: number[] = [];
    const runner: GhRunner = async () => {
      calls += 1;
      if (calls === 1) {
        throw ghExitErrorFromStderr(
          'gh: You have exceeded a secondary rate limit. Please wait a few minutes before ' +
            'you try again. ... (HTTP 403)',
        );
      }
      return ghIncludeRaw(200, {}, JSON.stringify({ items: [] }));
    };
    const reader = new GhGitHubReader(runner, {
      searchMinIntervalMs: 0,
      sleep: async (ms) => {
        waited.push(ms);
      },
      onWait: () => {},
    });
    const { query, entries } = collectingQuery();

    await reader.searchPullRequests(query);

    expect(entries).toEqual([]);
    expect(calls).toBe(2);
    // No `retry-after` or `x-ratelimit-reset` header is available from stderr text: falls
    // back to exponential backoff from 30s, the same as a headerless 429.
    expect(waited).toEqual([30_000]);
  });

  it('backs off on a 429, and falls back to exponential backoff with no rate-limit headers', async () => {
    let calls = 0;
    const waited: number[] = [];
    const runner: GhRunner = async () => {
      calls += 1;
      if (calls === 1) {
        throw ghExitError(ghIncludeRaw(429, {}, 'rate limit exceeded'));
      }
      return ghIncludeRaw(200, {}, JSON.stringify({ items: [] }));
    };
    const reader = new GhGitHubReader(runner, {
      searchMinIntervalMs: 0,
      sleep: async (ms) => {
        waited.push(ms);
      },
      onWait: () => {},
    });

    await reader.searchPullRequests(collectingQuery().query);

    expect(calls).toBe(2);
    expect(waited).toEqual([30_000]);
  });

  it('fails with a named refusal after exhausting the retry budget on a persistent rate limit', async () => {
    let calls = 0;
    const runner: GhRunner = async () => {
      calls += 1;
      throw ghExitError(ghIncludeRaw(403, {}, 'You have exceeded a secondary rate limit'));
    };
    const reader = new GhGitHubReader(runner, {
      searchMinIntervalMs: 0,
      sleep: async () => {},
      onWait: () => {},
    });

    await expect(reader.searchPullRequests(collectingQuery().query)).rejects.toThrow(
      'not_run: github_rate_limited_after_retries',
    );
    // At most six attempts per request: the loop must not spend a seventh.
    expect(calls).toBe(6);
  });

  it('does not retry a 403 whose body is an ordinary permission error, not a rate limit', async () => {
    let calls = 0;
    const runner: GhRunner = async () => {
      calls += 1;
      throw ghExitError(ghIncludeRaw(403, {}, 'Resource not accessible by integration'));
    };
    const reader = new GhGitHubReader(runner, { searchMinIntervalMs: 0, sleep: async () => {} });

    await expect(reader.searchPullRequests(collectingQuery().query)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Frozen pool and per-candidate cache
//
// A rerun that re-issues the search can see a different page (the merge window keeps closing new
// PRs into a query written in the past), so the pool freezes on first fetch. Every candidate read
// is cached so a restart resumes rather than re-spending the requests already paid for.
// ---------------------------------------------------------------------------

/**
 * A `GitHubReader` fake that answers a segment's search by its `order`, matching each pool
 * segment's own definition (`A` is `order: 'asc'`, `B` is `order: 'desc'`) rather than by an
 * artificial segment id — so a test that constructs one is exercising the same query shape
 * `JEV_POOL_SEGMENTS` actually defines, not a stand-in for it.
 */
class SegmentAwareReader implements GitHubReader {
  public searchCalls: { sort: string; order: string; startPage: number }[] = [];
  public readCalls: PoolEntry[] = [];
  constructor(
    private readonly bySegment: { A?: PoolEntry[]; B?: PoolEntry[] } = {},
    /** Report text override keyed by `repository`, for candidates whose body needs to carry
     * something other than `CLEAN_REPORT` — e.g. a frame-exclusion entry. */
    private readonly reportsByRepository: Record<string, string> = {},
  ) {}

  async searchPullRequests(query: SearchPullRequestsQuery): Promise<void> {
    this.searchCalls.push({ sort: query.sort, order: query.order, startPage: query.startPage });
    const entries = (query.order === 'asc' ? this.bySegment.A : this.bySegment.B) ?? [];
    await query.onPage(query.startPage, entries, true);
  }

  async readCandidate(entry: PoolEntry): Promise<CandidateRead | null> {
    this.readCalls.push(entry);
    const index = Number(/repo-(\d+)$/.exec(entry.repository)?.[1]);
    if (!Number.isFinite(index)) return null;
    const report = this.reportsByRepository[entry.repository] ?? CLEAN_REPORT;
    return { report, evidence: evidenceFor(index), archived: false };
  }
}

function freshRepoRoot(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryPaths.push(directory);
  return directory;
}

describe('selectBaseCases: frozen pool and candidate cache', () => {
  it('freezes the pool on first fetch, and a rerun makes zero search calls', async () => {
    const repoRoot = freshRepoRoot('jev-pool-');
    const segmentA: PoolEntry[] = [
      { repository: 'example-org/repo-0', number: 100 },
      { repository: 'example-org/repo-1', number: 101 },
    ];

    const first = new SegmentAwareReader({ A: segmentA });
    const firstResult = await selectBaseCases({
      reader: first,
      frameExclusions: new Set(),
      target: 2,
      repoRoot,
    });
    // One search call per pool segment — A returns the two entries above, B returns none.
    expect(first.searchCalls).toHaveLength(JEV_POOL_SEGMENTS.length);
    expect(firstResult.baseCases).toHaveLength(2);

    const second = new SegmentAwareReader({ A: segmentA });
    const secondResult = await selectBaseCases({
      reader: second,
      frameExclusions: new Set(),
      target: 2,
      repoRoot,
    });
    expect(second.searchCalls).toHaveLength(0);
    expect(secondResult.poolSize).toBe(firstResult.poolSize);
    expect(secondResult.baseCases).toHaveLength(2);
    expect(secondResult.poolRefetched).toBe(false);
  });

  it('reads only the candidates missing from the cache on a resumed run', async () => {
    const repoRoot = freshRepoRoot('jev-cache-');
    const segmentA: PoolEntry[] = [
      { repository: 'example-org/repo-0', number: 100 },
      { repository: 'example-org/repo-1', number: 101 },
      { repository: 'example-org/repo-2', number: 102 },
    ];

    const first = new SegmentAwareReader({ A: segmentA });
    await selectBaseCases({ reader: first, frameExclusions: new Set(), target: 3, repoRoot });
    expect(first.readCalls).toHaveLength(3);

    // Simulate a crash after only the first candidate's read was cached. Cache filenames now
    // carry the segment id, since the cache key includes it.
    rmSync(join(repoRoot, 'tmp', 'jev-judge', 'candidates', 'A__example-org__repo-1__101.json'));
    rmSync(join(repoRoot, 'tmp', 'jev-judge', 'candidates', 'A__example-org__repo-2__102.json'));

    const second = new SegmentAwareReader({ A: segmentA });
    const result = await selectBaseCases({
      reader: second,
      frameExclusions: new Set(),
      target: 3,
      repoRoot,
    });
    expect(second.readCalls.map((entry) => entry.number)).toEqual([101, 102]);
    expect(result.baseCases).toHaveLength(3);
  });

  it('invalidates the candidate cache when the pool is refetched', async () => {
    const repoRoot = freshRepoRoot('jev-refetch-');
    const poolA: PoolEntry[] = [
      { repository: 'example-org/repo-0', number: 100 },
      { repository: 'example-org/repo-1', number: 101 },
    ];
    const reorderedA: PoolEntry[] = [
      { repository: 'example-org/repo-1', number: 101 },
      { repository: 'example-org/repo-0', number: 100 },
    ];

    const first = new SegmentAwareReader({ A: poolA });
    await selectBaseCases({ reader: first, frameExclusions: new Set(), target: 2, repoRoot });
    expect(first.readCalls).toHaveLength(2);

    const second = new SegmentAwareReader({ A: reorderedA });
    const result = await selectBaseCases({
      reader: second,
      frameExclusions: new Set(),
      target: 2,
      repoRoot,
      refetchPool: true,
    });
    // Every segment is refetched from scratch, including the empty segment B.
    expect(second.searchCalls).toHaveLength(JEV_POOL_SEGMENTS.length);
    expect(second.readCalls).toHaveLength(2);
    expect(result.poolRefetched).toBe(true);
  });

  it('freezes segment A page by page, and a resumed run makes no search calls for pages ' +
    'already frozen', async () => {
    const repoRoot = freshRepoRoot('jev-page-resume-');
    const pages: PoolEntry[][] = [
      [{ repository: 'example-org/repo-0', number: 100 }],
      [{ repository: 'example-org/repo-1', number: 101 }],
      [{ repository: 'example-org/repo-2', number: 102 }],
    ];

    class PagedReader implements GitHubReader {
      public pagesRequested: { order: string; page: number }[] = [];
      constructor(private readonly failOnPage: number | null) {}

      async searchPullRequests(query: SearchPullRequestsQuery): Promise<void> {
        // Segment B contributes nothing in this test, so its own paging never obscures the
        // segment-A resume behaviour under test: one short, empty page.
        if (query.order !== 'asc') {
          this.pagesRequested.push({ order: query.order, page: query.startPage });
          await query.onPage(query.startPage, [], true);
          return;
        }
        for (let page = query.startPage; page <= query.maxPages; page += 1) {
          this.pagesRequested.push({ order: query.order, page });
          if (page === this.failOnPage) {
            throw new Error('not_run: github_rate_limited_after_retries');
          }
          const entries = pages[page - 1];
          if (!entries) break;
          const isShortPage = page === pages.length;
          await query.onPage(page, entries, isShortPage);
          if (isShortPage) break;
        }
      }

      async readCandidate(entry: PoolEntry): Promise<CandidateRead | null> {
        const index = Number(/repo-(\d+)$/.exec(entry.repository)?.[1]);
        if (!Number.isFinite(index)) return null;
        return { report: CLEAN_REPORT, evidence: evidenceFor(index), archived: false };
      }
    }

    // Page 3 of segment A fails after the retry budget is exhausted, mirroring a rate limit that
    // survives every retry. Pages 1 and 2 must already be on disk when that happens, and segment
    // B must never have been attempted — the failure never let `fetchSegments` reach it.
    const first = new PagedReader(3);
    await expect(
      selectBaseCases({ reader: first, frameExclusions: new Set(), target: 1, repoRoot }),
    ).rejects.toThrow('not_run: github_rate_limited_after_retries');
    expect(first.pagesRequested).toEqual([
      { order: 'asc', page: 1 },
      { order: 'asc', page: 2 },
      { order: 'asc', page: 3 },
    ]);

    const frozen = JSON.parse(
      readFileSync(join(repoRoot, 'tmp', 'jev-judge', 'pool.json'), 'utf8'),
    ) as {
      segments: { id: string; completedPages: number; complete: boolean; entries: PoolEntry[] }[];
    };
    const segmentA = frozen.segments.find((segment) => segment.id === 'A');
    expect(segmentA?.completedPages).toBe(2);
    expect(segmentA?.complete).toBe(false);
    expect(segmentA?.entries).toHaveLength(2);
    expect(frozen.segments.find((segment) => segment.id === 'B')).toBeUndefined();

    // The resumed run must not re-request segment A's pages 1 or 2: the reader never fails this
    // time, so a call for either would mean the freeze was discarded rather than resumed. It then
    // walks segment B fresh, since B was never attempted on the first, failed run.
    const second = new PagedReader(null);
    const result = await selectBaseCases({
      reader: second,
      frameExclusions: new Set(),
      target: 3,
      repoRoot,
    });
    expect(second.pagesRequested).toEqual([
      { order: 'asc', page: 3 },
      { order: 'desc', page: 1 },
    ]);
    expect(result.poolSize).toBe(3);
    expect(result.baseCases).toHaveLength(3);
  });

  it('migrates a legacy single-segment pool file to segment A, issuing zero search calls for it', async () => {
    const repoRoot = freshRepoRoot('jev-migrate-');
    const legacyEntries: PoolEntry[] = [
      { repository: 'example-org/repo-0', number: 100 },
      { repository: 'example-org/repo-1', number: 101 },
    ];
    const poolPath = join(repoRoot, 'tmp', 'jev-judge', 'pool.json');
    mkdirSync(dirname(poolPath), { recursive: true });
    writeFileSync(
      poolPath,
      `${JSON.stringify(
        {
          query: JEV_SELECTION_QUERY,
          sort: 'created',
          order: 'asc',
          perPage: 100,
          maxPages: 10,
          fetchedAt: '2026-09-19T00:00:00.000Z',
          completedPages: 1,
          shortPageSeen: true,
          complete: true,
          entries: legacyEntries,
        },
        null,
        2,
      )}\n`,
    );

    const segmentB: PoolEntry[] = [{ repository: 'example-org/repo-2', number: 102 }];
    const reader = new SegmentAwareReader({ B: segmentB });
    const result = await selectBaseCases({
      reader,
      frameExclusions: new Set(),
      target: 3,
      repoRoot,
    });

    // The migrated segment A is already complete: only segment B is actually searched.
    expect(reader.searchCalls).toEqual([{ sort: 'created', order: 'desc', startPage: 1 }]);
    expect(result.segments[0]).toMatchObject({ id: 'A', entryCount: 2, pageCount: 1 });
    expect(result.segments[1]).toMatchObject({ id: 'B', entryCount: 1, pageCount: 1 });
    // Pool order is the join, A's entries then B's — not re-sorted.
    expect(result.selected).toEqual([
      'example-org/repo-0#100',
      'example-org/repo-1#101',
      'example-org/repo-2#102',
    ]);

    const migrated = JSON.parse(readFileSync(poolPath, 'utf8')) as { segments: { id: string }[] };
    expect(migrated.segments.map((segment) => segment.id)).toEqual(['A', 'B']);
  });

  it('drops a segment-B entry that duplicates a segment-A entry, and counts it', async () => {
    const repoRoot = freshRepoRoot('jev-dedupe-');
    const segmentA: PoolEntry[] = [
      { repository: 'example-org/repo-0', number: 100 },
      { repository: 'example-org/repo-1', number: 101 },
    ];
    const segmentB: PoolEntry[] = [
      { repository: 'example-org/repo-1', number: 101 }, // duplicates segment A
      { repository: 'example-org/repo-2', number: 102 },
    ];
    const reader = new SegmentAwareReader({ A: segmentA, B: segmentB });

    const result = await selectBaseCases({
      reader,
      frameExclusions: new Set(),
      target: 3,
      repoRoot,
    });

    // Two from A plus one new from B; the duplicate never joins the pool at all.
    expect(result.poolSize).toBe(3);
    expect(result.exclusionCounts.duplicate_of_segment_a).toBe(1);
    expect(result.segments.find((segment) => segment.id === 'B')).toMatchObject({
      entryCount: 2,
      duplicateCount: 1,
      admittedCount: 1,
    });
    expect(result.selected).toEqual([
      'example-org/repo-0#100',
      'example-org/repo-1#101',
      'example-org/repo-2#102',
    ]);
  });

  it('applies rule 11 (repository_already_represented) across the segment join', async () => {
    const repoRoot = freshRepoRoot('jev-rule11-');
    const segmentA: PoolEntry[] = [{ repository: 'example-org/repo-0', number: 100 }];
    // Same repository as A's admitted case but a different PR number: not a raw pool duplicate,
    // so it must reach the per-candidate rules and be caught by rule 11, not by the join dedupe.
    const segmentB: PoolEntry[] = [
      { repository: 'example-org/repo-0', number: 999 },
      { repository: 'example-org/repo-1', number: 101 },
    ];
    const reader = new SegmentAwareReader({ A: segmentA, B: segmentB });

    const result = await selectBaseCases({
      reader,
      frameExclusions: new Set(),
      target: 2,
      repoRoot,
    });

    expect(result.exclusionCounts.duplicate_of_segment_a).toBe(0);
    expect(result.exclusionCounts.repository_already_represented).toBe(1);
    expect(result.selected).toEqual(['example-org/repo-0#100', 'example-org/repo-1#101']);
  });

  it('refuses after reading both segments when the join is still short, never a third segment', async () => {
    const repoRoot = freshRepoRoot('jev-short-');
    const segmentA: PoolEntry[] = [{ repository: 'example-org/repo-0', number: 100 }];
    const segmentB: PoolEntry[] = [{ repository: 'example-org/repo-1', number: 101 }];
    const reader = new SegmentAwareReader({ A: segmentA, B: segmentB });

    await expect(
      selectBaseCases({ reader, frameExclusions: new Set(), target: 3, repoRoot }),
    ).rejects.toThrow('not_run: insufficient_base_cases:2');
    // Exactly one search call per defined segment — there is no third segment to read.
    expect(reader.searchCalls).toHaveLength(JEV_POOL_SEGMENTS.length);
  });

  it('rule 12 excludes a candidate whose body cites a frame-exclusion entry, counts it, and never ' +
    'sends it to the admissibility filter', async () => {
    const repoRoot = freshRepoRoot('jev-rule12-body-');
    const sentinel = 'sentinel-org/sentinel-repo';
    // Well under JEV_BODY_MIN_LENGTH: if this candidate ever reached the admissibility filter it
    // would fail there too, under `body_length_out_of_range`. It must not reach it at all.
    const mentioningReport = `too short but mentions ${sentinel} by name`;
    const segmentA: PoolEntry[] = [
      { repository: 'example-org/repo-0', number: 100 },
      { repository: 'example-org/repo-1', number: 101 },
    ];
    const reader = new SegmentAwareReader(
      { A: segmentA },
      { 'example-org/repo-0': mentioningReport },
    );

    const result = await selectBaseCases({
      reader,
      frameExclusions: new Set([sentinel]),
      target: 1,
      repoRoot,
    });

    expect(result.selected).toEqual(['example-org/repo-1#101']);
    expect(result.exclusionCounts.rule_12_frame_mention).toBe(1);
    expect(result.exclusionCounts.body_length_out_of_range).toBe(0);
    expect(result.exclusionCounts.admissibility_filter).toBe(0);
    const [segmentStats] = result.segments;
    expect(segmentStats?.exclusionCounts.rule_12_frame_mention).toBe(1);
  });

  it('counts a candidate whose own repository is the sentinel under rule 2, not rule 12', async () => {
    const repoRoot = freshRepoRoot('jev-rule2-vs-12-');
    const sentinel = 'sentinel-org/sentinel-repo';
    const segmentA: PoolEntry[] = [
      { repository: sentinel, number: 1 },
      { repository: 'example-org/repo-0', number: 100 },
    ];
    const reader = new SegmentAwareReader({ A: segmentA });

    const result = await selectBaseCases({
      reader,
      frameExclusions: new Set([sentinel]),
      target: 1,
      repoRoot,
    });

    expect(result.exclusionCounts.frame_member).toBe(1);
    expect(result.exclusionCounts.rule_12_frame_mention).toBe(0);
    expect(result.selected).toEqual(['example-org/repo-0#100']);
  });
});

describe('result artifacts', () => {
  it('writes a result JSON that carries the frozen bindings', async () => {
    const repoRoot = createJevRepo();
    const run = await runJevExperiment({
      repoRoot,
      env: { TYPESAFE_API_KEY: 'unused' },
      client: new RecordedClient(),
      callLogPath: join(repoRoot, 'tmp', 'calls.jsonl'),
    });
    const parsed = JSON.parse(publishJevResult({ run, resamples: 100 }).json);
    expect(parsed.model).toBe(JEV_MODEL_ID);
    expect(parsed.preregistrationCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(parsed.corpusDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.callLogDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.metrics.observations).toBe(72);
  });

  /**
   * The first draft of this harness hashed the call log's PATH instead of its bytes. That value
   * was 64 hex characters and satisfied every shape assertion, so a shape test would have passed
   * over a digest that could never detect a rewritten log. This asserts sensitivity, not shape.
   */
  it('takes the call-log digest over the log bytes, so rewriting the log changes it', async () => {
    const repoRoot = createJevRepo();
    const callLogPath = join(repoRoot, 'tmp', 'calls.jsonl');
    const options = {
      repoRoot,
      env: { TYPESAFE_API_KEY: 'unused' },
      client: new RecordedClient(),
      callLogPath,
    };

    mkdirSync(dirname(callLogPath), { recursive: true });
    writeFileSync(callLogPath, '{"callId":"one"}\n');
    const first = await runJevExperiment(options);

    writeFileSync(callLogPath, '{"callId":"two"}\n');
    const second = await runJevExperiment({ ...options, client: new RecordedClient() });

    expect(first.callLogPath).toBe(second.callLogPath);
    expect(first.callLogDigest).not.toBe(second.callLogDigest);
  });

  it('still refuses a tree dirtied anywhere but the run output directory', async () => {
    const repoRoot = createJevRepo();
    write(repoRoot, 'packages/bede/src/jev-judge/metrics.ts', '// edited after the commit\n');

    await expect(
      runJevExperiment({
        repoRoot,
        env: { TYPESAFE_API_KEY: 'unused' },
        client: new RecordedClient(),
        callLogPath: join(repoRoot, 'tmp', 'jev-judge', 'calls.jsonl'),
      }),
    ).rejects.toThrow(/not_run: dirty_worktree:.*metrics\.ts/);
  });

  /**
   * Before this fix, a missing corpus surfaced as a raw `ENOENT` from `readFileSync` and exited 1
   * — indistinguishable from a crash. The operator's actual next step, `build-corpus`, is a named
   * refusal that exits 3 instead.
   */
  it('names the refusal instead of a raw ENOENT when run mode finds no built corpus', async () => {
    const repoRoot = createJevRepo({ corpus: null });

    await expect(
      runJevExperiment({
        repoRoot,
        env: { TYPESAFE_API_KEY: 'unused' },
        client: new RecordedClient(),
        callLogPath: join(repoRoot, 'tmp', 'jev-judge', 'calls.jsonl'),
      }),
    ).rejects.toThrow('not_run: corpus_not_built:run build-corpus first');
  });
});
