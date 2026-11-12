// What the pre-push hook checks: only the files the push changes, in seconds. CI still checks everything. This stops
// the failures that are certain on every platform before they cost a CI run. Only a finding about this push stops it: no
// origin/main, a dependency out of step, the time budget running out or main's own red all leave the push to CI.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET_MS = 30_000;
const CODE = /\.[cm]?[jt]sx?$/;
// The tree the size ratchet counts, without tests, and the sources the vocabulary test reads.
const RATCHETED = /^(?:server|shared|src|scripts|evals|electron|companion)\/.+\.(?:ts|tsx|mjs|cjs)$/;
const WORDED = /^(?:src|server)\/.+\.(?:ts|tsx|json)$/;
const isTest = (file) => /\.test\.[cm]?[jt]sx?$/.test(file) || file.includes("/testing/");

/** The commits this push sends, from the hook's stdin: "<local ref> <local sha> <remote ref> <remote sha>" per line; a delete sends none. */
export function pushedCommits(stdin) {
  return stdin.split("\n").map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 4 && !/^0+$/.test(fields[1]))
    .map((fields) => fields[1]);
}

/** The commands these files call for; none for a push that changes nothing they read. */
export function checksFor(files) {
  const checks = [];
  const code = files.filter((file) => CODE.test(file));
  if (code.length > 0) checks.push({ name: "lint", command: "node_modules/.bin/oxlint", args: ["--deny-warnings", ...code] });
  if (files.some((file) => file.startsWith("src/locales/"))) checks.push({ name: "locale catalogs", command: "node", args: ["scripts/generate-locale.mjs", "--check"] });
  const guards = [
    ...(files.some((file) => RATCHETED.test(file) && !isTest(file)) ? ["scripts/testing/file-size-ratchet.test.ts"] : []),
    ...(files.some((file) => WORDED.test(file) && !isTest(file)) ? ["src/locales/vocabulary.test.ts"] : []),
  ];
  if (guards.length > 0) checks.push({ name: "source guards", guards });
  return checks;
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** How to start a command without a shell. A tool under node_modules/.bin is a shell script on every platform but
 * Windows, where spawnSync cannot run it at all (ENOENT, and the .cmd next to it is refused too), so run the package's
 * own entry file with this node instead. Anything else starts as it is. A tool that is not installed throws. */
export function launcher(command, args, root = process.cwd()) {
  const tool = /^node_modules\/\.bin\/([^/]+)$/.exec(command)?.[1];
  if (!tool) return { command, args };
  const manifest = join(root, "node_modules", tool, "package.json");
  if (!existsSync(manifest)) throw new Error(`${tool} is not installed (${manifest} is missing)`);
  const bin = JSON.parse(readFileSync(manifest, "utf8")).bin;
  const file = typeof bin === "string" ? bin : bin?.[tool];
  const entry = file ? join(root, "node_modules", tool, file) : "";
  if (!file || !existsSync(entry)) throw new Error(`${tool} has no entry file (${entry || "no bin in its package.json"})`);
  return { command: process.execPath, args: [entry, ...args] };
}

/** What a spawn that returned an error means for the push. Out of time is CI's to settle; a tool that could not start
 * is a broken checkout, and passing it on would let the push go with nothing checked. */
const startFailure = (error) => error && error.code !== "ETIMEDOUT" ? `${error.code ?? "error"}: ${error.message}` : undefined;

/** Vitest's own verdict from its report, since a dependency out of step fails before any test runs. A guard reads the
 * whole tree, so a failure that names none of the push's files is main's own, and that is CI's to report. */
function runGuards(guards, files, timeout) {
  const dir = mkdtempSync(join(tmpdir(), "omb-pre-push-"));
  const report = join(dir, "report.json");
  try {
    const tool = launcher("node_modules/.bin/vitest", ["run", ...guards, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`]);
    const run = spawnSync(tool.command, tool.args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
    if (run.error?.code === "ETIMEDOUT") return { unknown: `past ${BUDGET_MS / 1000} s` };
    if (run.error) return { failed: true, why: startFailure(run.error) };
    if (!existsSync(report)) return { unknown: "it did not start" };
    if (JSON.parse(readFileSync(report, "utf8")).numFailedTests === 0) return {};
    const output = `${run.stdout}${run.stderr}`;
    // The vocabulary test names a catalog's key, not the catalog.
    if (files.some((file) => output.includes(file) || file === "src/locales/en.json")) {
      console.error(output);
      return { failed: true };
    }
    return { unknown: "a failure that names no file of this push, so main may be red" };
  } catch (error) {
    return { failed: true, why: error.message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const started = Date.now();
  const head = git("rev-parse", "HEAD").trim();
  let files = [];
  for (const sha of pushedCommits(readFileSync(0, "utf8"))) {
    // The checks read the working tree, so they can only speak for what is checked out.
    if (sha !== head) {
      console.log(`pre-push: ${sha.slice(0, 9)} is not checked out here, so CI will check it`);
      continue;
    }
    const base = git("merge-base", "origin/main", sha).trim();
    files = git("diff", "--name-only", "--no-renames", "--diff-filter=d", "-z", base, sha).split("\0").filter(Boolean);
  }
  const present = files.filter((file) => existsSync(file));
  for (const { name, command, args, guards } of checksFor(present)) {
    const left = BUDGET_MS - (Date.now() - started);
    if (left <= 0) {
      console.log(`pre-push: out of time before ${name}, so CI will check it`);
      break;
    }
    let bad;
    if (guards) {
      const verdict = runGuards(guards, present, left);
      if (verdict.unknown) console.log(`pre-push: ${name} did not settle it (${verdict.unknown}), so CI will check them`);
      bad = verdict.failed;
      if (verdict.why) console.error(`pre-push: ${name} could not run: ${verdict.why}`);
    } else {
      let run;
      try {
        const tool = launcher(command, args);
        run = spawnSync(tool.command, tool.args, { encoding: "utf8", timeout: left, maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        run = { error };
      }
      if (run.error?.code === "ETIMEDOUT") console.log(`pre-push: ${name} did not finish in time, so CI will check it`);
      else if (run.error) console.error(`pre-push: ${name} could not run: ${startFailure(run.error) ?? run.error.message}`);
      bad = run.error ? run.error.code !== "ETIMEDOUT" : run.status !== 0;
      if (bad && !run.error) console.error(`${run.stdout}${run.stderr}`);
    }
    if (bad) {
      console.error(`pre-push: ${name} failed. Fix it, or push with OMB_SKIP_HOOKS=1 to let CI report it.`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`pre-push: ${files.length} changed file(s) checked in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.log(`pre-push: could not read this push (${String(error.message).split("\n")[0]}), so CI will check it`);
  }
}
