import type { Environment } from "./deploy";
import { commitOf, contains, infraTag, out, setTag, sh } from "./git";
import { log } from "./prompts";

/** Environments other than Production, where an Infrastructure Change can still be missing. */
export type LowerEnvironment = Exclude<Environment, "prod">;

const toLines = (output: string) => output.split("\n").filter(Boolean);

/** Infrastructure Changes recorded on an Environment, as name → their commit on main. */
async function recorded(env: Environment): Promise<Map<string, string>> {
  const format = "--format=%(refname:lstrip=4)";
  const folder = `refs/tags/infra/${env}/`;
  const map = new Map<string, string>();
  for (const name of toLines(await out`git for-each-ref ${format} ${folder}`)) {
    const commit = await commitOf(infraTag(env, name));
    if (commit) map.set(name, commit);
  }
  return map;
}

/**
 * Every Infrastructure Change ship knows about. They all reach Production the moment they're
 * finished, so `infra/prod/*` is the full list, and each tag points at the change's commit on main.
 */
export const allInfraChanges = () => recorded("prod");

/** Infrastructure Changes in Production that an Environment doesn't have yet, oldest-name first. */
export async function missingInfra(env: LowerEnvironment): Promise<string[]> {
  const have = await recorded(env);
  return [...(await allInfraChanges()).keys()].filter((name) => !have.has(name)).sort();
}

/** Infrastructure Changes recorded on an Environment that `commit` doesn't contain, so deploying it would roll them back. */
export async function infraRolledBackBy(env: LowerEnvironment, commit: string): Promise<string[]> {
  const lacking: string[] = [];
  for (const [name, infraCommit] of await recorded(env)) {
    if (!(await contains(commit, infraCommit))) lacking.push(name);
  }
  return lacking.sort();
}

/**
 * After a successful deploy of `deployed`, records which Infrastructure Changes the Environment now
 * has: adds the ones the commit contains and removes the ones it rolled back. An unfinished
 * `infra/` branch never counts, because only changes already on main are considered.
 * Recording is best-effort: a failed push only warns, and the next fetch puts local tags back in line.
 */
export async function recordInfra(env: LowerEnvironment, deployed: string): Promise<void> {
  const have = await recorded(env);
  const refspecs: string[] = [];
  const removed: string[] = [];
  for (const [name, infraCommit] of await allInfraChanges()) {
    const tag = infraTag(env, name);
    const included = await contains(deployed, infraCommit);
    if (included && !have.has(name)) {
      await setTag(tag, infraCommit, `${name} reached ${env}`, `Deployed in ${deployed.slice(0, 8)}`);
      refspecs.push(`+refs/tags/${tag}`);
    } else if (!included && have.has(name)) {
      refspecs.push(`:refs/tags/${tag}`);
      removed.push(tag);
    }
  }
  if (!refspecs.length) return;

  const push = await sh`git push --atomic origin ${refspecs}`.nothrow();
  if (push.exitCode !== 0) {
    log.warn(`Deployed, but couldn't record which infrastructure ${env} has on origin.\n${push.stderr}`);
    return;
  }
  for (const tag of removed) await sh`git tag -d ${tag}`.nothrow();
  if (removed.length) log.warn(`${env} no longer has: ${removed.map((t) => t.split("/").at(-1)).join(", ")}.`);
}

/** Records an Infrastructure Change's commit as in Production. Returns the refspec to push with the rest of the prod deploy. */
export async function markInfraInProd(name: string, commit: string, heading: string): Promise<string> {
  const tag = infraTag("prod", name);
  await setTag(tag, commit, heading);
  return `+refs/tags/${tag}`;
}
