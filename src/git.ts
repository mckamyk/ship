import { $ } from "bun";
import { Cancelled, confirm, log, text } from "./prompts";

export const MAIN = "main";
export const ORIGIN_MAIN = `origin/${MAIN}`;
export const STAGING = "staging";
/** Git can't have a tag `prod` alongside `prod/<name>` tags, so the moving tag lives in the same folder. */
export const PROD_LATEST = "prod/latest";
const LOCKFILE = "bun.lock";

const WORK_NAME = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_NAMES = new Set(["latest"]);

export type WorkKind = "feature" | "hotfix";

/** A unit of work, identified by its branch: `ship/<name>` for features, `hotfix/<name>` for hotfixes. */
export interface Work {
  kind: WorkKind;
  name: string;
  branch: string;
}

const PREFIXES: Record<WorkKind, string> = { feature: "ship/", hotfix: "hotfix/" };

export const workFor = (kind: WorkKind, name: string): Work => ({ kind, name, branch: `${PREFIXES[kind]}${name}` });
export const stagingTag = (name: string) => `staging/${name}`;
export const prodTag = (name: string) => `prod/${name}`;

/** Works out what a branch is from its name. Undefined for branches ship didn't create. */
export function workFromBranch(branch: string): Work | undefined {
  for (const kind of ["feature", "hotfix"] as const) {
    const prefix = PREFIXES[kind];
    const name = branch.slice(prefix.length);
    if (branch.startsWith(prefix) && WORK_NAME.test(name)) return workFor(kind, name);
  }
  return undefined;
}

/** An expected failure, shown to the user without a stack trace. */
export class ShipError extends Error {}

/**
 * Bun Shell, without echoing output. Throws on a non-zero exit unless you add `.nothrow()`.
 *
 * Pass anything containing `^{}`, `%()` or `*` as a `${variable}`: the shell treats those
 * characters specially when they're written directly in the template, but never in a variable.
 */
export const sh = (strings: TemplateStringsArray, ...values: any[]) => $(strings, ...values).quiet();

/** Like `sh`, returning stdout as a string. */
export const out = async (strings: TemplateStringsArray, ...values: any[]) =>
  (await sh(strings, ...values).text()).trimEnd();

const toLines = (output: string) => output.split("\n").filter(Boolean);

/** Fetches branches and ship's tags. Forcing and pruning brings in tags other people moved or deleted. */
export async function fetchLatest(): Promise<void> {
  const refspecs = ["+refs/heads/*:refs/remotes/origin/*", "+refs/tags/staging/*:refs/tags/staging/*", "+refs/tags/prod/*:refs/tags/prod/*"];
  await sh`git fetch --prune origin ${refspecs}`;
}

/** The commit a branch or tag points at, or undefined if it doesn't exist. */
export async function commitOf(ref: string): Promise<string | undefined> {
  const spec = `${ref}^{commit}`;
  const result = await sh`git rev-parse --verify --quiet ${spec}`.nothrow();
  return result.exitCode === 0 ? result.text().trim() : undefined;
}

/** The checked-out branch, or "" on a detached HEAD. */
export const currentBranch = () => out`git branch --show-current`;

export const dirtyFiles = async () => toLines(await out`git status --porcelain`);

export async function requireCleanTree(): Promise<void> {
  if ((await dirtyFiles()).length) throw new ShipError("You have uncommitted changes. Commit or stash them first.");
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Why new work can't use this name, or undefined if it can. Features and hotfixes share one set of names. */
export async function nameProblem(name: string): Promise<string | undefined> {
  if (!WORK_NAME.test(name)) return "Use letters, numbers and hyphens.";
  if (RESERVED_NAMES.has(name)) return `"${name}" is reserved. Pick another name.`;
  for (const kind of ["feature", "hotfix"] as const) {
    const { branch } = workFor(kind, name);
    if ((await commitOf(branch)) || (await commitOf(`origin/${branch}`))) return `${branch} already exists.`;
  }
  if (await commitOf(prodTag(name))) return `Something called ${name} has already shipped. Pick another name.`;
  return undefined;
}

/** Features tagged on staging, oldest first so they merge in a stable order. */
export async function stagedFeatures(): Promise<string[]> {
  const format = "--format=%(refname:lstrip=3)";
  return toLines(await out`git for-each-ref --sort=creatordate ${format} refs/tags/staging/`);
}

/** Features that could go to production from a list: staged ones plus any ship branch on origin. */
export async function prodCandidates(): Promise<string[]> {
  const format = "--format=%(refname:lstrip=4)";
  const branches = toLines(await out`git for-each-ref ${format} refs/remotes/origin/ship/`);
  return [...new Set([...(await stagedFeatures()), ...branches])];
}

/** Offers to commit everything uncommitted. If `required`, declining cancels the whole ship. */
export async function commitWork({ required }: { required: boolean }): Promise<void> {
  const files = await dirtyFiles();
  if (!files.length) return;

  log.info(`Uncommitted changes:\n${files.join("\n")}`);
  if (!(await confirm("Commit all of these?"))) {
    if (required) throw new Cancelled();
    return;
  }
  const message = await text("Commit message", {
    validate: (value) => (value.trim() ? undefined : "A commit message is required."),
  });
  await sh`git add -A`;
  await sh`git commit -m ${message}`;
}

/** Creates or moves an annotated tag locally. The note is the longer human-readable message. */
export async function setTag(tag: string, commit: string, heading: string, note = ""): Promise<void> {
  const who = (await sh`git config user.name`.nothrow().text()).trim() || "unknown";
  const details = `By: ${who}\nAt: ${new Date().toISOString()}`;
  const message = [heading, note.trim(), details].filter(Boolean).join("\n\n");
  await sh`git tag -a -f -m ${message} ${tag} ${commit}`;
}

export const conflictedFiles = async () => toLines(await out`git diff --name-only --diff-filter=U`);

/**
 * Resolves a merge whose only conflict is bun.lock, which happens whenever two branches change
 * dependencies. Returns whether it worked. The resolution is staged, and the caller commits it.
 *
 * Keeps our side of the lockfile and lets bun add whatever is missing. Don't run `bun install` on the
 * conflicted file: bun can't parse it, so it discards it and moves every dependency to its newest allowed version.
 */
export async function resolveLockfileConflict(): Promise<boolean> {
  const files = await conflictedFiles();
  if (files.length !== 1 || files[0] !== LOCKFILE) return false;
  await sh`git checkout --ours -- ${LOCKFILE}`;
  if ((await sh`bun install`.nothrow()).exitCode !== 0) return false;
  await sh`git add ${LOCKFILE}`;
  return true;
}
