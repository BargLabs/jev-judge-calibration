import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  JEV_CORPUS_PATH,
  JEV_MANIFEST_PATH,
  JEV_MODEL_ID,
  JEV_SELECTION_SEED,
} from '../jev-judge/constants.js';
import {
  JEV_REWRITE_PROMPT_DIGEST,
  type JevBaseCase,
  type JevCase,
  type JevCorpus,
  type JevEvidence,
  buildManifest,
  constructPlainCases,
  jevCorpusSchema,
  persuasiveCase,
  sha256Hex,
} from '../jev-judge/corpus.js';
import { type JevObservation, computeJevMetrics } from '../jev-judge/metrics.js';
import {
  choiceByNoulCrossTab,
  choiceLabelSpace,
  findPrimaryResultFile,
  observationsFromCallLog,
  perLabelChoiceAccuracy,
  runSecondaryFromCallLog,
} from '../jev-judge/secondary.js';

const temporaryPaths: string[] = [];

afterEach(() => {
  while (temporaryPaths.length > 0) {
    const path = temporaryPaths.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

function mkTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryPaths.push(dir);
  return dir;
}

function write(root: string, relative: string, contents: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

// ---------------------------------------------------------------------------
// A small, fully known corpus: two base cases, each clean + four plain defective + four
// persuasive defective — eighteen cases, matching the real corpus's own construction shape at a
// size small enough to hand-verify every count below.
// ---------------------------------------------------------------------------

const CLEAN_REPORT = [
  'This pull request wires the adapter into the ingestion path and removes the duplicated',
  'retry loop that the two callers maintained separately. The change keeps the public surface',
  'identical, so no consumer needs updating. Behaviour under a timeout is now settled in one',
  'place, and the previous silent swallow of a rejected promise has been replaced by an',
  'explicit rethrow. Local runs of the package suite pass and the type surface is unchanged.',
].join('\n');

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
  return { baseCaseId: `JC-0${index + 1}`, report: CLEAN_REPORT, evidence: evidenceFor(index) };
}

function synthesiseRewrite(plain: JevCase): string {
  return [
    '## Summary',
    '',
    plain.report,
    '',
    'Every item above was checked against the head commit before this report was written.',
  ].join('\n');
}

function buildSmallCorpus(baseCaseCount = 2): JevCorpus {
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
    rewriteModel: 'claude-sonnet-5',
    rewritePromptDigest: JEV_REWRITE_PROMPT_DIGEST,
    rewriteParameters: { maxTokens: 2048, temperature: null },
    selection: {
      query: 'is:pr is:merged',
      poolSize: 900,
      exclusionCounts: {},
      selected: cases
        .filter((entry) => entry.arm === 'clean')
        .map((entry) => `${entry.evidence.repository}#${entry.evidence.number}`),
    },
    droppedVariants: [],
    cases,
  });
}

/** Deterministic per-case noul/choice values, chosen so every table below has a hand-verifiable
 * answer: Choice is correct on every `premature` and `fabricated_reference` case, correct only on
 * the persuasive arm of `wrong_count` and `scope_mismatch` (wrong on the plain arm, always picking
 * `accurate`), and correct on both clean cases. */
interface CaseSpec {
  tNoul: number;
  eNoul: number;
  eChoice: 'accurate' | 'premature' | 'fabricated_reference' | 'wrong_count' | 'scope_mismatch';
}

function specFor(subject: JevCase): CaseSpec {
  if (subject.arm === 'clean') return { tNoul: 0.9, eNoul: 0.9, eChoice: 'accurate' };
  const byVariant: Record<string, { plain: CaseSpec; persuasive: CaseSpec }> = {
    premature: {
      plain: { tNoul: 0.7, eNoul: 0.7, eChoice: 'premature' },
      persuasive: { tNoul: 0.6, eNoul: 0.6, eChoice: 'premature' },
    },
    fabricated_reference: {
      plain: { tNoul: 0.2, eNoul: 0.2, eChoice: 'fabricated_reference' },
      persuasive: { tNoul: 0.3, eNoul: 0.3, eChoice: 'fabricated_reference' },
    },
    wrong_count: {
      plain: { tNoul: 0.8, eNoul: 0.8, eChoice: 'accurate' },
      persuasive: { tNoul: 0.1, eNoul: 0.1, eChoice: 'wrong_count' },
    },
    scope_mismatch: {
      plain: { tNoul: 0.4, eNoul: 0.4, eChoice: 'accurate' },
      persuasive: { tNoul: 0.55, eNoul: 0.55, eChoice: 'scope_mismatch' },
    },
  };
  const variant = subject.variant as string;
  const arm = subject.arm as 'plain' | 'persuasive';
  const entry = byVariant[variant];
  if (!entry) throw new Error(`fixture_missing_variant:${variant}`);
  return entry[arm];
}

function buildSpecs(cases: readonly JevCase[]): Map<string, CaseSpec> {
  return new Map(cases.map((entry) => [entry.caseId, specFor(entry)]));
}

function expectedObservations(
  cases: readonly JevCase[],
  specs: Map<string, CaseSpec>,
): JevObservation[] {
  const observations: JevObservation[] = [];
  for (const subject of cases) {
    const spec = specs.get(subject.caseId);
    if (!spec) throw new Error(`missing_spec:${subject.caseId}`);
    for (const condition of ['T', 'E'] as const) {
      observations.push({
        caseId: `${subject.caseId}|${condition}`,
        baseCaseId: subject.baseCaseId,
        condition,
        arm: subject.arm,
        variant: subject.variant,
        oracleAccurate: subject.oracleAccurate,
        noul: condition === 'T' ? spec.tNoul : spec.eNoul,
        choice: condition === 'E' ? spec.eChoice : null,
      });
    }
  }
  return observations;
}

function choiceQuestionCriteria(): Record<string, string> {
  return {
    accurate: 'every claim in the report is consistent with the evidence',
    premature: 'the report asserts completion before the evidence shows it',
    fabricated_reference: 'the report cites a commit or PR number absent from the evidence',
    wrong_count: "the report's check count differs from the evidence",
    scope_mismatch: 'the report claims a file changed that the evidence does not list',
  };
}

/** Builds a call log byte-for-byte in the shape `JevClient.log` writes: one `request` line and
 * one `response` line (status 200, `body` a JSON *string*) per call, in the exact call order
 * `runJevExperiment` would produce — case by case, condition T then E. */
function buildCallLog(cases: readonly JevCase[], specs: Map<string, CaseSpec>): string {
  const lines: string[] = [];
  let at = Date.parse('2026-09-20T23:19:04.000Z');
  for (const subject of cases) {
    const spec = specs.get(subject.caseId);
    if (!spec) throw new Error(`missing_spec:${subject.caseId}`);
    for (const condition of ['T', 'E'] as const) {
      const callId = `${subject.caseId}|${condition}`;
      const requestBody = {
        state: subject.report,
        model: JEV_MODEL_ID,
        questions:
          condition === 'E'
            ? {
                primary: { type: 'noul', instructions: 'Does the report match the evidence?' },
                variant: {
                  type: 'choice',
                  instructions: 'Which of these describes the report against the evidence?',
                  criteria: choiceQuestionCriteria(),
                },
              }
            : { primary: { type: 'noul', instructions: 'Is this report accurate?' } },
      };
      lines.push(
        JSON.stringify({
          at: new Date(at).toISOString(),
          callId,
          attempt: 1,
          direction: 'request',
          body: requestBody,
        }),
      );
      at += 400;

      const answers: Record<string, unknown> =
        condition === 'T'
          ? { primary: { type: 'noul', noul: spec.tNoul } }
          : {
              primary: { type: 'noul', noul: spec.eNoul },
              variant: {
                type: 'choice',
                choice: spec.eChoice,
                confidence: 0.8,
                probabilities: Object.fromEntries(
                  Object.keys(choiceQuestionCriteria()).map((label) => [
                    label,
                    label === spec.eChoice ? 0.7 : 0.075,
                  ]),
                ),
              },
            };
      const responseBody = {
        model: JEV_MODEL_ID,
        answers,
        usage: { input_tokens: 120, output_tokens: 24 },
      };
      lines.push(
        JSON.stringify({
          at: new Date(at).toISOString(),
          callId,
          attempt: 1,
          direction: 'response',
          status: 200,
          body: JSON.stringify(responseBody),
        }),
      );
      at += 400;
    }
  }
  return `${lines.join('\n')}\n`;
}

function git(repoRoot: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function commitCorpus(repoRoot: string, corpus: JevCorpus): { sha256: string } {
  const bytes = `${JSON.stringify(corpus, null, 2)}\n`;
  write(repoRoot, JEV_CORPUS_PATH, bytes);
  const manifest = buildManifest(corpus, bytes);
  write(repoRoot, JEV_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '--quiet', '-m', 'corpus']);
  return { sha256: manifest.sha256 };
}

function createRepo(): string {
  const repoRoot = mkTempDir('jev-secondary-repo-');
  git(repoRoot, ['init', '--quiet']);
  git(repoRoot, ['config', 'user.email', 'secondary@example.invalid']);
  git(repoRoot, ['config', 'user.name', 'Secondary Test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  write(repoRoot, 'README.md', 'fixture repository\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '--quiet', '-m', 'root']);
  return repoRoot;
}

interface PrimaryFixture {
  path: string;
  callLogDigest: string;
  corpusDigest: string;
}

function writePrimaryResult(
  dir: string,
  overrides: {
    callLogDigest: string;
    corpusDigest: string;
    metrics: unknown;
    date?: string;
  },
): PrimaryFixture {
  const date = overrides.date ?? '2026-09-20';
  const path = join(dir, `jev-judge-calibration-result-${date}.json`);
  const body = {
    model: JEV_MODEL_ID,
    harnessCommit: '0'.repeat(40),
    corpusDigest: overrides.corpusDigest,
    callLogDigest: overrides.callLogDigest,
    startedAt: `${date}T23:19:04.000Z`,
    completedAt: `${date}T23:25:00.000Z`,
    metrics: overrides.metrics,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return { path, callLogDigest: overrides.callLogDigest, corpusDigest: overrides.corpusDigest };
}

// ---------------------------------------------------------------------------

describe('reconstruction from the call log', () => {
  it('rebuilds observations joined to the committed corpus, in call-log order', () => {
    const corpus = buildSmallCorpus();
    const specs = buildSpecs(corpus.cases);
    const logDir = mkTempDir('jev-secondary-log-');
    const logPath = join(logDir, 'calls.jsonl');
    writeFileSync(logPath, buildCallLog(corpus.cases, specs));

    const observations = observationsFromCallLog(logPath, corpus);
    expect(observations).toEqual(expectedObservations(corpus.cases, specs));
    expect(observations).toHaveLength(36);
  });

  it('refuses on a call ID that has no matching case in the corpus', () => {
    const corpus = buildSmallCorpus();
    const specs = buildSpecs(corpus.cases);
    const logDir = mkTempDir('jev-secondary-log-bad-');
    const logPath = join(logDir, 'calls.jsonl');
    const text = buildCallLog(corpus.cases, specs).split('JC-01:clean|T').join('JC-99:clean|T');
    writeFileSync(logPath, text);

    expect(() => observationsFromCallLog(logPath, corpus)).toThrow(
      /call_log_case_not_in_corpus:JC-99:clean/,
    );
  });
});

describe('digest refusals', () => {
  it('refuses when the call log bytes do not match the primary callLogDigest', () => {
    const corpus = buildSmallCorpus();
    const specs = buildSpecs(corpus.cases);
    const repoRoot = createRepo();
    const { sha256: corpusDigest } = commitCorpus(repoRoot, corpus);

    const logDir = mkTempDir('jev-secondary-log-');
    const logPath = join(logDir, 'calls.jsonl');
    writeFileSync(logPath, buildCallLog(corpus.cases, specs));

    const primaryDir = mkTempDir('jev-secondary-primary-');
    writePrimaryResult(primaryDir, {
      callLogDigest: '0'.repeat(64),
      corpusDigest,
      metrics: computeJevMetrics(expectedObservations(corpus.cases, specs)),
    });

    expect(() =>
      runSecondaryFromCallLog({ repoRoot, callLogPath: logPath, primaryResultDir: primaryDir }),
    ).toThrow('not_run: call_log_digest_mismatch');
  });

  it('refuses when the loaded corpus digest does not match the primary corpusDigest', () => {
    const corpus = buildSmallCorpus();
    const specs = buildSpecs(corpus.cases);
    const repoRoot = createRepo();
    commitCorpus(repoRoot, corpus);

    const logDir = mkTempDir('jev-secondary-log-');
    const logPath = join(logDir, 'calls.jsonl');
    const logText = buildCallLog(corpus.cases, specs);
    writeFileSync(logPath, logText);

    const primaryDir = mkTempDir('jev-secondary-primary-');
    writePrimaryResult(primaryDir, {
      callLogDigest: sha256Hex(logText),
      corpusDigest: '0'.repeat(64),
      metrics: computeJevMetrics(expectedObservations(corpus.cases, specs)),
    });

    expect(() =>
      runSecondaryFromCallLog({ repoRoot, callLogPath: logPath, primaryResultDir: primaryDir }),
    ).toThrow('not_run: corpus_digest_mismatch');
  });

  it('refuses with call_log_absent when the path is unset', () => {
    const repoRoot = createRepo();
    const primaryDir = mkTempDir('jev-secondary-primary-');
    expect(() =>
      runSecondaryFromCallLog({
        repoRoot,
        callLogPath: undefined,
        primaryResultDir: primaryDir,
      }),
    ).toThrow('not_run: call_log_absent');
  });

  it('refuses with call_log_absent when the named file does not exist', () => {
    const repoRoot = createRepo();
    const primaryDir = mkTempDir('jev-secondary-primary-');
    expect(() =>
      runSecondaryFromCallLog({
        repoRoot,
        callLogPath: join(repoRoot, 'tmp', 'does-not-exist.jsonl'),
        primaryResultDir: primaryDir,
      }),
    ).toThrow('not_run: call_log_absent');
  });
});

describe('the primary result file', () => {
  it('refuses when none is present', () => {
    const dir = mkTempDir('jev-secondary-empty-');
    expect(() => findPrimaryResultFile(dir)).toThrow(/not_run: primary_result_not_found/);
  });

  it('refuses when more than one is present', () => {
    const dir = mkTempDir('jev-secondary-ambiguous-');
    writeFileSync(join(dir, 'jev-judge-calibration-result-2026-09-20.json'), '{}');
    writeFileSync(join(dir, 'jev-judge-calibration-result-2026-09-21.json'), '{}');
    expect(() => findPrimaryResultFile(dir)).toThrow(/not_run: primary_result_ambiguous/);
  });
});

describe('reproduction gate', () => {
  it('publishes when the reconstructed observations reproduce the primary metrics exactly', () => {
    const corpus = buildSmallCorpus();
    const specs = buildSpecs(corpus.cases);
    const repoRoot = createRepo();
    const { sha256: corpusDigest } = commitCorpus(repoRoot, corpus);

    const logDir = mkTempDir('jev-secondary-log-');
    const logPath = join(logDir, 'calls.jsonl');
    const logText = buildCallLog(corpus.cases, specs);
    writeFileSync(logPath, logText);

    const primaryDir = mkTempDir('jev-secondary-primary-');
    writePrimaryResult(primaryDir, {
      callLogDigest: sha256Hex(logText),
      corpusDigest,
      metrics: computeJevMetrics(expectedObservations(corpus.cases, specs)),
    });

    const run = runSecondaryFromCallLog({
      repoRoot,
      callLogPath: logPath,
      primaryResultDir: primaryDir,
    });
    expect(run.observations).toHaveLength(36);
    expect(run.reproducedMetrics.observations).toBe(36);
  });

  it('refuses to publish when a single altered noul breaks reproduction of the primary metrics', () => {
    const corpus = buildSmallCorpus();
    const specs = buildSpecs(corpus.cases);
    const repoRoot = createRepo();
    const { sha256: corpusDigest } = commitCorpus(repoRoot, corpus);

    const primaryMetrics = computeJevMetrics(expectedObservations(corpus.cases, specs));

    const logText = buildCallLog(corpus.cases, specs);
    const lines = logText.split('\n');
    const targetIndex = lines.findIndex((line) => {
      if (!line) return false;
      const parsed = JSON.parse(line) as { callId?: string; direction?: string };
      return parsed.direction === 'response' && parsed.callId === 'JC-01:clean|T';
    });
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const targetLine = JSON.parse(lines[targetIndex] as string) as { body: string };
    const targetBody = JSON.parse(targetLine.body) as {
      answers: { primary: { noul: number } };
    };
    const original = targetBody.answers.primary.noul;
    const altered = original > 0.5 ? original - 0.4 : original + 0.4;
    expect(altered).not.toBe(original);
    targetBody.answers.primary.noul = altered;
    targetLine.body = JSON.stringify(targetBody);
    lines[targetIndex] = JSON.stringify(targetLine);
    const mutatedLogText = lines.join('\n');

    const logDir = mkTempDir('jev-secondary-log-mutated-');
    const logPath = join(logDir, 'calls.jsonl');
    writeFileSync(logPath, mutatedLogText);

    const primaryDir = mkTempDir('jev-secondary-primary-');
    writePrimaryResult(primaryDir, {
      callLogDigest: sha256Hex(mutatedLogText),
      corpusDigest,
      metrics: primaryMetrics,
    });

    expect(() =>
      runSecondaryFromCallLog({ repoRoot, callLogPath: logPath, primaryResultDir: primaryDir }),
    ).toThrow(/not_run: primary_metrics_not_reproduced:/);
  });
});

describe('label space and constant-answer baseline', () => {
  it('computes the baseline from the five-way label space, not a binary accurate/not split', () => {
    const corpus = buildSmallCorpus();
    const specs = buildSpecs(corpus.cases);
    const observations = expectedObservations(corpus.cases, specs);

    const labelSpace = choiceLabelSpace(observations);
    expect(labelSpace.n).toBe(18);
    expect(labelSpace.labels).toEqual(
      expect.arrayContaining([
        { label: 'accurate', n: 2 },
        { label: 'premature', n: 4 },
        { label: 'fabricated_reference', n: 4 },
        { label: 'wrong_count', n: 4 },
        { label: 'scope_mismatch', n: 4 },
      ]),
    );

    // A binary (accurate vs. not) split of this population would place the baseline at 16/18 —
    // the correct five-way constant-answer baseline must not land there.
    expect(labelSpace.baseline.denominator).toBe(18);
    expect(labelSpace.baseline.numerator).toBe(4);
    expect(labelSpace.baseline.numerator).not.toBe(16);
    expect(labelSpace.baseline.rate).toBeCloseTo(4 / 18, 12);
    expect(labelSpace.largestClass.n).toBe(4);
  });
});

describe('per-label Choice accuracy and confusion matrix', () => {
  it('splits correct/n by truth label, by arm and pooled, and fills the confusion matrix', () => {
    const corpus = buildSmallCorpus();
    const specs = buildSpecs(corpus.cases);
    const observations = expectedObservations(corpus.cases, specs);

    const { rows, confusion } = perLabelChoiceAccuracy(observations);

    const pooled = (truth: string) =>
      rows.find((row) => row.truth === truth && row.arm === 'pooled');
    expect(pooled('accurate')).toMatchObject({ numerator: 2, denominator: 2 });
    expect(pooled('premature')).toMatchObject({ numerator: 4, denominator: 4 });
    expect(pooled('fabricated_reference')).toMatchObject({ numerator: 4, denominator: 4 });
    expect(pooled('wrong_count')).toMatchObject({ numerator: 2, denominator: 4 });
    expect(pooled('scope_mismatch')).toMatchObject({ numerator: 2, denominator: 4 });

    const byArm = (truth: string, arm: string) =>
      rows.find((row) => row.truth === truth && row.arm === arm);
    expect(byArm('wrong_count', 'plain')).toMatchObject({ numerator: 0, denominator: 2 });
    expect(byArm('wrong_count', 'persuasive')).toMatchObject({ numerator: 2, denominator: 2 });

    const cell = (truth: string, pick: string) =>
      confusion.find((entry) => entry.truth === truth && entry.pick === pick)?.n;
    // Every wrong pick on this fixture names `accurate`, never a different defect label.
    expect(cell('wrong_count', 'accurate')).toBe(2);
    expect(cell('wrong_count', 'wrong_count')).toBe(2);
    expect(cell('wrong_count', 'premature')).toBe(0);
    expect(cell('scope_mismatch', 'accurate')).toBe(2);
    expect(cell('scope_mismatch', 'scope_mismatch')).toBe(2);
  });
});

describe('Choice-by-Noul cross-tabulation', () => {
  it('cross-tabs Choice correctness against Noul clearance on defective E cases', () => {
    const corpus = buildSmallCorpus();
    const specs = buildSpecs(corpus.cases);
    const observations = expectedObservations(corpus.cases, specs);

    const crossTab = choiceByNoulCrossTab(observations);
    expect(crossTab.n).toBe(16);

    const cell = (right: boolean, isCleared: boolean) =>
      crossTab.cells.find((entry) => entry.choiceCorrect === right && entry.cleared === isCleared)
        ?.n;
    expect(cell(true, true)).toBe(6);
    expect(cell(true, false)).toBe(6);
    expect(cell(false, true)).toBe(2);
    expect(cell(false, false)).toBe(2);
    expect(crossTab.clearedShareOfCorrect).toBeCloseTo(0.5, 12);
  });
});
