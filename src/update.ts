import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { log } from "./prompts";

/** Set to anything to skip the check. Also set on the relaunched process so it can't loop. */
export const SKIP_ENV = "SHIP_SKIP_UPDATE_CHECK";
const TIMEOUT_MS = 5000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
/** Holds when GitHub was last asked, so the check runs at most hourly. Delete it to check on the next run. */
const LAST_CHECK_FILE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ship-cli", "last-update-check");

/** What a global `bun add -g github:<repo>#<ref>` install asked for, and the commit it got. */
export interface GlobalInstall {
  repo: string;
  ref: string;
  /** Bun records a short SHA. */
  commit: string;
}

/** Reads the ship-cli entry from Bun's global lockfile. Undefined unless it was installed from GitHub. */
export function parseGlobalLock(lock: string): GlobalInstall | undefined {
  const requested = lock.match(/"ship-cli":\s*"github:([\w.-]+\/[\w.-]+)#([^"]+)"/);
  const resolved = lock.match(/"ship-cli@github:[\w.-]+\/[\w.-]+#([0-9a-f]+)"/);
  if (!requested || !resolved) return undefined;
  return { repo: requested[1]!, ref: requested[2]!, commit: resolved[1]! };
}

/** Bun's global install folder, or undefined if ship isn't running from it (a checkout, a monorepo, a project dependency). */
function globalDir(): string | undefined {
  const packageDir = resolve(import.meta.dir, "..");
  const nodeModules = resolve(packageDir, "..");
  if (basename(packageDir) !== "ship-cli" || basename(nodeModules) !== "node_modules") return undefined;
  const expected = process.env.BUN_INSTALL_GLOBAL_DIR ?? join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "install", "global");
  const actual = resolve(nodeModules, "..");
  try {
    return realpathSync(actual) === realpathSync(expected) ? actual : undefined;
  } catch {
    return undefined;
  }
}

async function checkedRecently(): Promise<boolean> {
  try {
    const checkedAt = Number(await Bun.file(LAST_CHECK_FILE).text());
    return Date.now() - checkedAt < CHECK_EVERY_MS;
  } catch {
    return false;
  }
}

async function recordCheck(): Promise<void> {
  try {
    await Bun.write(LAST_CHECK_FILE, String(Date.now()));
  } catch {
    // Without the record we just check again next run.
  }
}

async function readInstall(dir: string): Promise<GlobalInstall | undefined> {
  const lock = Bun.file(join(dir, "bun.lock"));
  return (await lock.exists()) ? parseGlobalLock(await lock.text()) : undefined;
}

/** The commit at the tip of `ref` on GitHub. Undefined if `ref` isn't a branch (a pinned SHA or tag). Throws if GitHub can't be reached. */
async function latestCommit(repo: string, ref: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "ls-remote", `https://github.com/${repo}.git`, `refs/heads/${ref}`], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "ignore",
    timeout: TIMEOUT_MS,
  });
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ls-remote exited with ${code}`);
  return output.split(/\s/)[0] || undefined;
}

/**
 * When ship is a global install that tracks a branch, and GitHub hasn't been asked in the last
 * hour, updates it if GitHub has a newer commit, then runs the new version in place of this one.
 * Returns the new version's exit code if it relaunched, or undefined to carry on with this version.
 * Never stops ship from running.
 */
export async function updateAndRelaunch(): Promise<number | undefined> {
  if (process.env[SKIP_ENV]) return undefined;
  const dir = globalDir();
  if (!dir) return undefined;
  const installed = await readInstall(dir);
  if (!installed || (await checkedRecently())) return undefined;

  let latest: string | undefined;
  try {
    latest = await latestCommit(installed.repo, installed.ref);
  } catch {
    // Recorded too, so a machine that can't reach GitHub only waits for the timeout once an hour.
    await recordCheck();
    log.warn(`Couldn't reach GitHub to check for a newer ship-cli. Carrying on with ${installed.commit}.`);
    return undefined;
  }
  await recordCheck();
  if (!latest || latest.startsWith(installed.commit)) return undefined;

  log.step(`Updating ship-cli ${installed.commit} → ${latest.slice(0, 7)}`);
  const update = Bun.spawn(["bun", "update", "-g", "ship-cli"], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(update.stderr).text(), update.exited]);
  const after = await readInstall(dir);
  if (code !== 0 || !after || !latest.startsWith(after.commit)) {
    log.warn(`Couldn't update ship-cli, so carrying on with ${installed.commit}. Run \`bun update -g ship-cli\` to try yourself.${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
    return undefined;
  }

  // The new code is on disk but this process has the old code loaded, so run it fresh.
  // Ctrl-C reaches both processes; let the child handle it and report its exit code.
  process.on("SIGINT", () => {});
  // Run this file's path, not argv[1]: that may be a bin link the update renamed or removed.
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...process.argv.slice(2)], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, [SKIP_ENV]: "1" },
  });
  return await child.exited;
}
