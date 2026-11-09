import { $ } from "bun";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Answers for the prompts, consumed in order. Warnings are collected so tests can check them.
const answers: unknown[] = [];
const warnings: string[] = [];
class Cancelled extends Error {}
const nextAnswer = async () => answers.shift();

mock.module("../src/prompts", () => ({
  Cancelled,
  select: nextAnswer,
  confirm: nextAnswer,
  text: nextAnswer,
  log: { info() {}, success() {}, warn: (message: string) => warnings.push(message) },
}));

const { shipToDev } = await import("../src/commands/dev");
const { shipToProd } = await import("../src/commands/prod");
const { removeFromStaging, shipToStaging } = await import("../src/commands/staging");
const { startWork } = await import("../src/commands/start");
const { commitOf, currentBranch, fetchLatest, nameProblem, stagedFeatures, workFor, workFromBranch } = await import("../src/git");

let root: string;
let failFile: string;
let deployLog: string;
const startDir = process.cwd();

const q = (strings: TemplateStringsArray, ...values: any[]) => $(strings, ...values).quiet();
const textOf = async (strings: TemplateStringsArray, ...values: any[]) => (await q(strings, ...values).text()).trim();

async function configure(dir: string) {
  await q`git -C ${dir} config user.name Tester`;
  await q`git -C ${dir} config user.email tester@example.com`;
}

async function commitAndPushConfig(config: unknown) {
  await Bun.write("ship.config.json", JSON.stringify(config));
  await q`git add -A`;
  await q`git commit -m config`;
  await q`git push -u origin main`;
}

/** Each test gets a bare origin and a clone. Deploy commands log HEAD, and fail if `failFile` exists. */
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ship-test-"));
  failFile = join(root, "fail");
  deployLog = join(root, "deploys.log");
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  await q`git init --bare -b main ${origin}`;
  await q`git clone ${origin} ${repo}`.nothrow();
  await configure(repo);
  process.chdir(repo);
  await q`git switch -c main`.nothrow();

  const step = (env: string) => `echo ${env} $(git rev-parse HEAD) >> ${deployLog}; test ! -e ${failFile}`;
  await commitAndPushConfig({ deploy: { dev: step("dev"), staging: step("staging"), prod: step("prod") } });
  answers.length = 0;
  warnings.length = 0;
});

afterEach(() => {
  process.chdir(startDir);
  rmSync(root, { recursive: true, force: true });
});

/** Starts a feature or hotfix and commits one file to it. */
async function start(kind: "feature" | "hotfix", name: string, file = `${name}.txt`) {
  await q`git switch main`;
  answers.push(name);
  await startWork(kind);
  writeFileSync(file, `${name}\n`);
  await q`git add -A`;
  await q`git commit -m ${`work on ${name}`}`;
}
const feature = (name: string, file?: string) => start("feature", name, file);

async function toStaging(name: string) {
  answers.push("a note", true);
  await shipToStaging(name);
}

async function toProd(name: string) {
  answers.push("", true);
  await shipToProd(workFor("feature", name));
}

const cloneOther = async () => {
  const other = join(root, "other");
  await q`git clone ${join(root, "origin.git")} ${other}`;
  await configure(other);
  return other;
};
const filesOn = async (ref: string) => (await textOf`git ls-tree --name-only ${ref}`).split("\n");
const lastDeploy = async () => (await Bun.file(deployLog).text()).trim().split("\n").at(-1);
const originRefs = async () => textOf`git ls-remote origin`;
const tempBranches = async () => {
  const pattern = "ship-tmp/*";
  return textOf`git branch --list ${pattern}`;
};

// --- starting work ---

test("start branches from the latest origin/main, not a stale local main", async () => {
  const other = await cloneOther();
  await q`git -C ${other} commit --allow-empty -m newer`;
  await q`git -C ${other} push origin main`;

  answers.push("Checkout Flow!");
  await startWork("feature");
  expect(await currentBranch()).toBe("ship/checkout-flow");
  expect(await commitOf("HEAD")).toBe(await commitOf("origin/main"));
  expect(await textOf`git log -1 --format=%s`).toBe("newer");
});

test("reserved and already-used names are rejected across features and hotfixes", async () => {
  expect(await nameProblem("latest")).toContain("reserved");
  await feature("one");
  expect(await nameProblem("one")).toContain("already exists");
  await start("hotfix", "two");
  expect(await nameProblem("two")).toContain("already exists");
});

test("branch names are detected as features, hotfixes, or neither", () => {
  expect(workFromBranch("ship/a")?.kind).toBe("feature");
  expect(workFromBranch("hotfix/a")?.kind).toBe("hotfix");
  expect(workFromBranch("main")).toBeUndefined();
  expect(workFromBranch("ship/")).toBeUndefined();
});

// --- dev ---

test("dev deploys the branch with no tags or pushes", async () => {
  await feature("wild");
  await shipToDev("wild");
  expect(await lastDeploy()).toBe(`dev ${await commitOf("HEAD")}`);
  expect(await originRefs()).not.toContain("wild");
});

// --- staging ---

test("first staging ship builds main + feature and tags the feature's own commit", async () => {
  await feature("a");
  const tip = await commitOf("HEAD");
  await toStaging("a");

  expect(await currentBranch()).toBe("ship/a");
  expect(await commitOf("staging/a")).toBe(tip);
  expect(await filesOn("origin/staging")).toContain("a.txt");
  expect(await lastDeploy()).toBe(`staging ${await commitOf("origin/staging")}`);
  expect(await textOf`git cat-file -p staging/a`).toContain("a note");
  expect(await tempBranches()).toBe("");
});

test("a second feature joins the first, and reshipping moves the tag without duplicating", async () => {
  await feature("a");
  await toStaging("a");
  await feature("b");
  await toStaging("b");

  const staging = await filesOn("origin/staging");
  expect(staging).toContain("a.txt");
  expect(staging).toContain("b.txt");
  expect(await stagedFeatures()).toEqual(["a", "b"]);

  await q`git switch ship/a`;
  writeFileSync("a2.txt", "more\n");
  answers.push(true, "more work", "", true); // confirm commit, message, note, confirm ship
  await shipToStaging("a");

  expect(await commitOf("staging/a")).toBe(await commitOf("ship/a"));
  expect(await filesOn("origin/staging")).toEqual(expect.arrayContaining(["a2.txt", "b.txt"]));
  expect((await stagedFeatures()).sort()).toEqual(["a", "b"]);
});

test("merges the tagged version of other features, not their newer unshipped commits", async () => {
  await feature("a");
  await toStaging("a");
  writeFileSync("unshipped.txt", "wip\n");
  await q`git add -A`;
  await q`git commit -m wip`;
  await q`git push origin ship/a`;

  await feature("b");
  await toStaging("b");
  expect(await filesOn("origin/staging")).not.toContain("unshipped.txt");
});

test("a conflict leaves staging untouched and returns you to your branch", async () => {
  await feature("a", "same.txt");
  await toStaging("a");
  const before = await commitOf("origin/staging");

  await feature("b", "same.txt");
  answers.push("", true);
  await expect(shipToStaging("b")).rejects.toThrow("same.txt");
  expect(await currentBranch()).toBe("ship/b");
  expect(await commitOf("origin/staging")).toBe(before);
  expect(await commitOf("staging/b")).toBeUndefined();
  expect(await textOf`git status --porcelain`).toBe("");
  expect(await tempBranches()).toBe("");
});

test("a failed staging deploy adds no tag and returns you to your branch", async () => {
  await feature("a");
  writeFileSync(failFile, "");
  answers.push("", true);
  await expect(shipToStaging("a")).rejects.toThrow("Staging deploy failed");
  expect(await currentBranch()).toBe("ship/a");
  expect(await commitOf("staging/a")).toBeUndefined();
  expect(await textOf`git ls-remote origin refs/tags/staging/a`).toBe("");
});

test("declining to commit cancels a staging ship before anything happens", async () => {
  await feature("a");
  writeFileSync("uncommitted.txt", "x\n");
  answers.push(false);
  await expect(shipToStaging("a")).rejects.toBeInstanceOf(Cancelled);
  expect(await commitOf("origin/staging")).toBeUndefined();
  expect(await textOf`git status --porcelain`).toContain("uncommitted.txt");
});

// --- removing from staging ---

test("removing a feature rebuilds staging without it and keeps its branch", async () => {
  await feature("a");
  await toStaging("a");
  await feature("b");
  await toStaging("b");

  answers.push("a", true);
  await removeFromStaging();

  expect(await currentBranch()).toBe("ship/b");
  expect(await stagedFeatures()).toEqual(["b"]);
  expect(await textOf`git ls-remote origin refs/tags/staging/a`).toBe("");
  const staging = await filesOn("origin/staging");
  expect(staging).not.toContain("a.txt");
  expect(staging).toContain("b.txt");
  expect(await lastDeploy()).toBe(`staging ${await commitOf("origin/staging")}`);
  expect(await commitOf("ship/a")).toBeDefined();
  expect(await commitOf("origin/ship/a")).toBeDefined();
});

test("removing the last feature puts staging back to just main", async () => {
  await feature("a");
  await toStaging("a");
  answers.push("a", true);
  await removeFromStaging();
  expect(await stagedFeatures()).toEqual([]);
  expect(await filesOn("origin/staging")).toEqual(await filesOn("origin/main"));
});

test("removing a conflicting feature unblocks the feature it clashed with", async () => {
  await feature("a", "same.txt");
  await toStaging("a");
  await feature("b", "same.txt");
  answers.push("", true);
  await expect(shipToStaging("b")).rejects.toThrow("conflicts");

  answers.push("a", true);
  await removeFromStaging();
  await toStaging("b");
  expect(await stagedFeatures()).toEqual(["b"]);
});

test("a failed deploy during removal keeps the tag", async () => {
  await feature("a");
  await toStaging("a");
  writeFileSync(failFile, "");
  answers.push("a", true);
  await expect(removeFromStaging()).rejects.toThrow("Staging deploy failed");
  expect(await stagedFeatures()).toEqual(["a"]);
  expect(await textOf`git ls-remote origin refs/tags/staging/a`).not.toBe("");
});

test("removal refuses to run with uncommitted changes", async () => {
  await feature("a");
  await toStaging("a");
  writeFileSync("uncommitted.txt", "x\n");
  await expect(removeFromStaging()).rejects.toThrow("uncommitted");
  expect(await stagedFeatures()).toEqual(["a"]);
});

// --- production ---

test("production squashes, deploys, tags, and cleans up", async () => {
  await feature("a");
  await toStaging("a");
  answers.push("Add feature a", true);
  await shipToProd(workFor("feature", "a"));

  const head = await commitOf("origin/main");
  expect(await currentBranch()).toBe("main");
  expect(await commitOf("HEAD")).toBe(head);
  expect(await lastDeploy()).toBe(`prod ${head}`);
  expect(await textOf`git log -1 --format=%s origin/main`).toBe("Add feature a");
  expect(await textOf`git rev-list --count --merges origin/main`).toBe("0");
  expect(await commitOf("prod/latest")).toBe(head);
  expect(await commitOf("prod/a")).toBe(head);
  expect(await commitOf("staging/a")).toBeUndefined();
  expect(await commitOf("ship/a")).toBeUndefined();

  const remote = await originRefs();
  expect(remote).toContain("refs/tags/prod/latest");
  expect(remote).toContain("refs/tags/prod/a");
  expect(remote).not.toContain("refs/tags/staging/a");
  expect(remote).not.toContain("refs/heads/ship/a");
});

test("prod/latest moves on each ship while prod/<name> stays put", async () => {
  await feature("a");
  await toProd("a");
  const first = await commitOf("prod/a");
  await feature("b");
  await toProd("b");

  expect(await commitOf("prod/a")).toBe(first);
  expect(await commitOf("prod/latest")).toBe(await commitOf("prod/b"));
  expect(await commitOf("prod/latest")).not.toBe(first);
});

test("after a feature reaches production, the next staging build doesn't re-merge it", async () => {
  await feature("a");
  await toStaging("a");
  await feature("b");
  await toStaging("b");
  await q`git switch ship/a`;
  await toProd("a");

  await q`git switch ship/b`;
  await toStaging("b");
  expect(await stagedFeatures()).toEqual(["b"]);
  expect(await textOf`git log --format=%s origin/staging`).not.toContain("Merge a into staging");
  expect(await filesOn("origin/staging")).toContain("a.txt");
});

test("a failed production deploy leaves main and origin untouched, and shipping again works", async () => {
  await feature("a");
  await toStaging("a");
  const mainBefore = await commitOf("origin/main");
  writeFileSync(failFile, "");
  await expect(toProd("a")).rejects.toThrow("Production deploy failed");

  expect(await currentBranch()).toBe("ship/a");
  expect(await commitOf("main")).toBe(mainBefore);
  expect(await textOf`git ls-remote origin refs/heads/main`).toContain(mainBefore!);
  expect(await commitOf("prod/latest")).toBeUndefined();
  expect(await commitOf("staging/a")).toBeDefined();
  expect(await textOf`git status --porcelain`).not.toContain("a.txt");

  rmSync(failFile);
  await toProd("a");
  expect(await commitOf("prod/a")).toBe(await commitOf("origin/main"));
  expect(await commitOf("staging/a")).toBeUndefined();
});

test("if origin rejects the push after deploying, the error says so and gives the command", async () => {
  const other = join(root, "other");
  await commitAndPushConfig({
    deploy: { prod: `git -C ${other} commit --allow-empty -m sneaky && git -C ${other} push -q origin main` },
  });
  await cloneOther();
  await feature("a");
  await expect(toProd("a")).rejects.toThrow(/Production is deployed[\s\S]*git push --atomic origin main/);
  expect(await textOf`git ls-remote origin refs/tags/prod/a`).toBe("");
  expect(await commitOf("ship/a")).toBeDefined();
});

test("a conflict with main deploys nothing and restores everything", async () => {
  await feature("a", "same.txt");
  await feature("b", "same.txt");
  await q`git switch ship/a`;
  await toProd("a");
  const main = await commitOf("origin/main");
  const deploys = await Bun.file(deployLog).text();

  await q`git switch ship/b`;
  answers.push("", true);
  await expect(shipToProd(workFor("feature", "b"))).rejects.toThrow("conflicts with main");
  expect(await currentBranch()).toBe("ship/b");
  expect(await commitOf("origin/main")).toBe(main);
  expect(await commitOf("main")).toBe(main);
  expect(await Bun.file(deployLog).text()).toBe(deploys);
  expect(await textOf`git status --porcelain`).toBe("");
});

test("warns when production would get code staging hasn't run", async () => {
  await feature("a");
  await toStaging("a");
  writeFileSync("later.txt", "later\n");
  await q`git add -A`;
  await q`git commit -m later`;
  await toProd("a");
  expect(warnings.join()).toContain("changed since it was deployed to staging");
});

test("warns when a feature skipped staging", async () => {
  await feature("a");
  await toProd("a");
  expect(warnings.join()).toContain("never been deployed to staging");
});

// --- hotfix ---

async function finishHotfix(name: string, rebuildStaging: boolean) {
  answers.push("Fix it", true, rebuildStaging);
  await shipToProd(workFor("hotfix", name));
}

test("a hotfix goes straight to production with no staging warning, and cleans up", async () => {
  await start("hotfix", "fix");
  expect(await currentBranch()).toBe("hotfix/fix");
  await finishHotfix("fix", false);

  const head = await commitOf("origin/main");
  expect(await currentBranch()).toBe("main");
  expect(await lastDeploy()).toBe(`prod ${head}`);
  expect(await commitOf("prod/latest")).toBe(head);
  expect(await commitOf("prod/fix")).toBe(head);
  expect(await commitOf("hotfix/fix")).toBeUndefined();
  expect(await textOf`git cat-file -p prod/fix`).toContain("(hotfix)");
  expect(warnings).toEqual([]);
});

test("finishing a hotfix commits uncommitted work first", async () => {
  await start("hotfix", "fix");
  writeFileSync("uncommitted.txt", "x\n");
  answers.push(true, "the fix"); // confirm commit, message
  await finishHotfix("fix", false);
  expect(await filesOn("origin/main")).toContain("uncommitted.txt");
});

test("a hotfix leaves features on staging, and rebuilding adds it alongside them", async () => {
  await feature("a");
  await toStaging("a");
  await start("hotfix", "fix");
  await finishHotfix("fix", true);

  expect(await currentBranch()).toBe("main");
  expect(await stagedFeatures()).toEqual(["a"]);
  const staging = await filesOn("origin/staging");
  expect(staging).toContain("a.txt");
  expect(staging).toContain("fix.txt");
  expect(await lastDeploy()).toBe(`staging ${await commitOf("origin/staging")}`);
});

test("declining the rebuild leaves staging alone", async () => {
  await feature("a");
  await toStaging("a");
  const before = await commitOf("origin/staging");
  await start("hotfix", "fix");
  await finishHotfix("fix", false);
  expect(await commitOf("origin/staging")).toBe(before);
});

test("a hotfix that conflicts with staging still counts as shipped, with a warning", async () => {
  await feature("a", "same.txt");
  await toStaging("a");
  await start("hotfix", "fix", "same.txt");
  await finishHotfix("fix", true);

  expect(await commitOf("prod/fix")).toBe(await commitOf("origin/main"));
  expect(warnings.join()).toContain("staging wasn't rebuilt");
  expect(await currentBranch()).toBe("main");
  expect(await tempBranches()).toBe("");
});

test("a failed hotfix deploy returns you to the hotfix branch with main untouched", async () => {
  await start("hotfix", "fix");
  const main = await commitOf("origin/main");
  writeFileSync(failFile, "");
  answers.push("Fix it", true);
  await expect(shipToProd(workFor("hotfix", "fix"))).rejects.toThrow("Production deploy failed");
  expect(await currentBranch()).toBe("hotfix/fix");
  expect(await commitOf("main")).toBe(main);
});

// --- bun.lock conflicts ---

/** Turns the repo into a Bun workspace with a lockfile on main. */
async function useWorkspace() {
  await q`git switch main`;
  const pkg = { name: "mono", private: true, workspaces: ["packages/*"] };
  await Bun.write("package.json", JSON.stringify(pkg));
  await Bun.write("packages/base/package.json", JSON.stringify({ name: "base", version: "1.0.0" }));
  await Bun.write(".gitignore", "node_modules/\n");
  await q`bun install`;
  await q`git add -A`;
  await q`git commit -m workspace`;
  await q`git push origin main`;
}

/** Starts a feature that adds a workspace package, which changes bun.lock with no network needed. */
async function featureChangingLockfile(name: string) {
  await feature(name);
  await Bun.write(`packages/${name}/package.json`, JSON.stringify({ name, version: "1.0.0" }));
  await q`bun install`;
  await q`git add -A`;
  await q`git commit -m ${`add ${name} package`}`;
}

async function expectLockfileConflictBetween(left: string, right: string) {
  const conflict = await q`git merge-tree --write-tree --name-only ${left} ${right}`.nothrow();
  expect(conflict.exitCode).toBe(1);
  expect(conflict.text()).toContain("bun.lock");
}

test("two features that change bun.lock can both go on staging", async () => {
  await useWorkspace();
  await featureChangingLockfile("aaa");
  await toStaging("aaa");
  await featureChangingLockfile("aab");
  await expectLockfileConflictBetween("ship/aaa", "ship/aab");
  await toStaging("aab");

  expect(await stagedFeatures()).toEqual(["aaa", "aab"]);
  expect(await currentBranch()).toBe("ship/aab");
  expect(await textOf`git status --porcelain`).toBe("");
  const lock = await textOf`git show origin/staging:bun.lock`;
  expect(lock).not.toContain("<<<<<<<");
  expect(lock).toContain("packages/aaa");
  expect(lock).toContain("packages/aab");
  expect(await textOf`git log --format=%s origin/staging`).toContain("Merge aaa into staging");
});

test("a feature that changes bun.lock can squash onto a main whose lockfile moved", async () => {
  await useWorkspace();
  await featureChangingLockfile("aaa");
  await featureChangingLockfile("aab");
  await expectLockfileConflictBetween("ship/aaa", "ship/aab");
  await q`git switch ship/aaa`;
  await toProd("aaa");

  await q`git switch ship/aab`;
  await toProd("aab");
  const lock = await textOf`git show origin/main:bun.lock`;
  expect(lock).not.toContain("<<<<<<<");
  expect(lock).toContain("packages/aaa");
  expect(lock).toContain("packages/aab");
  expect(await commitOf("prod/aab")).toBe(await commitOf("origin/main"));
  expect(await textOf`git status --porcelain`).toBe("");
});

test("a real conflict alongside bun.lock still stops the ship", async () => {
  await useWorkspace();
  await featureChangingLockfile("aaa");
  writeFileSync("same.txt", "one\n");
  await q`git add -A`;
  await q`git commit -m one`;
  await toStaging("aaa");
  const before = await commitOf("origin/staging");

  await featureChangingLockfile("aab");
  writeFileSync("same.txt", "two\n");
  await q`git add -A`;
  await q`git commit -m two`;
  answers.push("", true);
  await expect(shipToStaging("aab")).rejects.toThrow("same.txt");
  expect(await commitOf("origin/staging")).toBe(before);
  expect(await currentBranch()).toBe("ship/aab");
  expect(await textOf`git status --porcelain`).toBe("");
});

// --- syncing ---

test("another clone sees tag moves and deletions, and keeps unrelated tags", async () => {
  const other = await cloneOther();
  await feature("a");
  await toStaging("a");
  const repo = process.cwd();

  process.chdir(other);
  await q`git tag my-own-tag`;
  await fetchLatest();
  expect(await commitOf("staging/a")).toBeDefined();

  process.chdir(repo);
  await toProd("a");

  process.chdir(other);
  await fetchLatest();
  expect(await commitOf("staging/a")).toBeUndefined();
  expect(await commitOf("prod/a")).toBeDefined();
  expect(await commitOf("my-own-tag")).toBeDefined();
});
