/**
 * `pnpm --filter @alfred/bede experiment:jev-judge [--dry-run] [--out <dir>]`
 * `pnpm --filter @alfred/bede experiment:jev-judge build-corpus [--force] [--refetch-pool]`
 * `pnpm --filter @alfred/bede experiment:jev-judge secondary --call-log <path> --out <dir>`
 *
 * `secondary` is post hoc: it opens no connection, makes no live call, and never edits the
 * committed primary result. It reads the one `jev-judge-calibration-result-*.json` already
 * committed under `--out`, the frozen corpus, and the operator-held call log named by `--call-log`
 * (or `JEV_CALL_LOG` when the flag is omitted) — refusing with `not_run: call_log_absent` when
 * neither names an existing file. It reproduces the primary result's metrics from that call log and
 * that corpus exactly before computing or writing anything else, and writes
 * `jev-judge-calibration-secondary-<date>.{json,md}` beside the primary on success.
 *
 * `--dry-run` constructs no client and opens no connection: it reports the case plan and the cost
 * from the frozen budget, plus the realized corpus figures when the corpus has been built.
 *
 * `build-corpus` is operator step 3. It reads GitHub through the operator's own `gh` login and
 * rewrites through the Anthropic Messages API with `ANTHROPIC_API_KEY` from the environment. It
 * refuses without the frame-exclusion list, and refuses to overwrite a built corpus without
 * `--force`. GitHub reads are paced (`JEV_GH_MIN_INTERVAL_MS`, default 250ms); `search/issues`
 * calls are paced on their own, tighter interval (`JEV_GH_SEARCH_MIN_INTERVAL_MS`, default
 * 2500ms), since that endpoint's secondary limit is stricter than the rest of the REST surface.
 * Both back off on a rate limit read from the failed call's stdout, stderr, or message. The
 * search pool freezes to `tmp/jev-judge/pool.json` page by page as each page succeeds, and every
 * candidate read is cached under `tmp/jev-judge/candidates/`, so a restart resumes from the first
 * incomplete page rather than re-spending the requests already paid for. `--refetch-pool` forces
 * a fresh search from page 1.
 *
 * Any `not_run:` refusal exits 3 with the reason on stderr and writes no result file. Exit 3 is
 * distinct from 1 on purpose: a refusal is a recorded outcome, and it must not be mistakable for
 * either a crash or a success.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AnthropicRewriter,
  GhGitHubReader,
  buildJevCorpus,
  resolveRewriteApiKey,
} from './build-corpus.js';
import { constructedDefectsLimitsParagraph, publishJevResult } from './publish.js';
import {
  dryRun,
  renderDryRun,
  resolveJevRepoRoot,
  resultDirectoryName,
  runJevExperiment,
} from './runner.js';
import { publishSecondaryResult, runSecondaryFromCallLog } from './secondary.js';

/** Names the operator-held call log path. Never defaulted: absence is a refusal, not an empty
 * string standing in for one. */
const JEV_CALL_LOG_ENV = 'JEV_CALL_LOG';

interface CliOptions {
  mode: 'dry-run' | 'run' | 'build-corpus' | 'secondary';
  outDir: string;
  force: boolean;
  refetchPool: boolean;
  callLog: string | undefined;
}

function parseArgs(args: readonly string[]): CliOptions {
  let mode: CliOptions['mode'] = 'run';
  let outDir = 'tmp/jev-judge';
  let force = false;
  let refetchPool = false;
  let callLog: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === 'build-corpus') {
      mode = 'build-corpus';
      continue;
    }
    if (arg === 'secondary') {
      mode = 'secondary';
      continue;
    }
    if (arg === '--dry-run') {
      mode = 'dry-run';
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--refetch-pool') {
      refetchPool = true;
      continue;
    }
    if (arg === '--out') {
      const value = args[index + 1];
      if (!value) throw new Error('missing_value:--out');
      outDir = value;
      index += 1;
      continue;
    }
    if (arg === '--call-log') {
      const value = args[index + 1];
      if (!value) throw new Error('missing_value:--call-log');
      callLog = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown_argument:${arg}`);
  }
  return { mode, outDir, force, refetchPool, callLog };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolveJevRepoRoot();

  if (options.mode === 'dry-run') {
    process.stdout.write(`${renderDryRun(dryRun(repoRoot))}\n`);
    return;
  }

  if (options.mode === 'build-corpus') {
    const result = await buildJevCorpus({
      repoRoot,
      reader: new GhGitHubReader(),
      rewriter: new AnthropicRewriter({ apiKey: resolveRewriteApiKey() }),
      force: options.force,
      refetchPool: options.refetchPool,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`corpus: ${result.corpusPath}\n`);
    process.stdout.write(`manifest: ${result.manifestPath} (sha256 ${result.manifest.sha256})\n`);
    process.stdout.write(
      `cases: clean=${result.counts.clean} plain_defective=${result.counts.plain} ` +
        `persuasive_defective=${result.counts.persuasive} total=${result.counts.total}\n`,
    );
    process.stdout.write(`dropped variants: ${result.droppedVariants.length}\n`);
    // The count, never the membership.
    process.stdout.write(`frame exclusions applied: ${result.frameExclusionCount}\n`);
    process.stdout.write(`forced overwrite: ${result.manifest.forced ? 'yes' : 'no'}\n`);
    process.stdout.write(`pool refetched: ${result.manifest.poolRefetched ? 'yes' : 'no'}\n`);
    for (const segment of result.manifest.segments) {
      process.stdout.write(
        `segment ${segment.id}: pages=${segment.pageCount} entries=${segment.entryCount} ` +
          `duplicates=${segment.duplicateCount} admitted=${segment.admittedCount} ` +
          `authorised_by=${segment.authorisedBy}\n`,
      );
    }
    return;
  }

  if (options.mode === 'secondary') {
    const callLogPath = options.callLog ?? process.env[JEV_CALL_LOG_ENV];
    const primaryResultDir = join(repoRoot, options.outDir);
    const run = runSecondaryFromCallLog({ repoRoot, callLogPath, primaryResultDir });
    const published = publishSecondaryResult(
      run,
      constructedDefectsLimitsParagraph(run.primary.model),
    );
    const date = run.primary.startedAt.slice(0, 10);
    writeFileSync(
      join(primaryResultDir, `jev-judge-calibration-secondary-${date}.json`),
      published.json,
    );
    writeFileSync(
      join(primaryResultDir, `jev-judge-calibration-secondary-${date}.md`),
      published.markdown,
    );
    process.stdout.write(`secondary result: ${primaryResultDir}\n`);
    process.stdout.write(`call log digest: ${run.callLogDigest}\n`);
    process.stdout.write(`corpus digest: ${run.corpusDigest}\n`);
    return;
  }

  const callLogPath = join(repoRoot, options.outDir, 'calls.jsonl');
  const run = await runJevExperiment({
    repoRoot,
    callLogPath,
    onProgress: (message) => process.stderr.write(`${message}\n`),
  });

  const published = publishJevResult({ run });
  const directory = join(repoRoot, options.outDir, resultDirectoryName(run));
  mkdirSync(directory, { recursive: true });
  const date = run.startedAt.slice(0, 10);
  writeFileSync(join(directory, `jev-judge-calibration-result-${date}.json`), published.json);
  writeFileSync(join(directory, `jev-judge-calibration-result-${date}.md`), published.markdown);
  process.stdout.write(`result directory: ${directory}\n`);
  for (const prediction of published.predictions) {
    process.stdout.write(`${prediction.id}: ${prediction.verdict} — ${prediction.measured}\n`);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(message.startsWith('not_run:') ? 3 : 1);
}
