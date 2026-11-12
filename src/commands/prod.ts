import { deploy } from "../deploy";
import {
  catchUpWithOrigin,
  commitOf,
  commitWork,
  conflictedFiles,
  contains,
  currentBranch,
  fetchLatest,
  KIND_LABELS,
  MAIN,
  ORIGIN_MAIN,
  out,
  PROD_LATEST,
  prodCandidates,
  prodTag,
  requireCleanTree,
  resolveLockfileConflict,
  setTag,
  sh,
  ShipError,
  stagingTag,
  workFor,
  type Work,
  type WorkKind,
} from "../git";
import { markInfraInProd } from "../infra";
import { Cancelled, confirm, log, select, text } from "../prompts";
import { rebuildStaging, stagedCommits } from "./staging";

/** Ships Work picked from a list, for when you aren't on its branch (e.g. on the deploy VM). */
export async function pickAndShipToProd(kind: WorkKind = "feature"): Promise<void> {
  await requireCleanTree();
  const choices = [];
  for (const name of await prodCandidates(kind)) {
    const hint = kind !== "feature" ? undefined : (await commitOf(stagingTag(name))) ? "on staging" : "not on staging";
    choices.push({ value: name, label: name, hint });
  }
  if (!choices.length) throw new ShipError(`No ${KIND_LABELS[kind]} branches on origin to ship.`);
  await shipToProd(workFor(kind, await select(`Which ${KIND_LABELS[kind]}?`, choices)));
}

/**
 * Squash-merges onto local main and deploys that. origin only changes if the deploy
 * succeeds, so origin/main always matches production.
 */
export async function shipToProd(work: Work): Promise<void> {
  const { kind, name, branch } = work;
  const startingBranch = await currentBranch();
  const onBranch = startingBranch === branch;

  if (!onBranch) await requireCleanTree();
  await fetchLatest();
  if (onBranch) {
    await catchUpWithOrigin(branch);
    await commitWork({ required: true });
  }

  const tip = onBranch
    ? await commitOf("HEAD")
    : ((await commitOf(`origin/${branch}`)) ?? (await commitOf(stagingTag(name))) ?? (await commitOf(branch)));
  if (!tip) throw new ShipError(`Can't find a branch or staging tag for ${name}.`);
  // Hotfixes and Infrastructure Changes skip staging on purpose, so only Features are checked.
  const target = kind === "feature" ? await chooseVersion(work, tip) : tip;

  const subject = (await text("Commit message for main", { placeholder: name })).trim() || name;
  if (!(await confirm(`Squash-merge ${name} into ${MAIN} and deploy to production?`))) throw new Cancelled();

  await moveToLatestMain(startingBranch);
  const beforeMerge = await out`git rev-parse HEAD`;
  try {
    await squashOntoMain(work, target, subject);
    if (!(await deploy("prod"))) {
      throw new ShipError(`Production deploy failed, so ${MAIN} is unchanged and ${branch} is still there. Run this again to retry.`);
    }
  } catch (error) {
    await sh`git reset --hard ${beforeMerge}`;
    await sh`git switch ${startingBranch}`;
    throw error;
  }

  await recordProdDeploy(work, subject, target);
  log.success(`${name} is deployed to production. You're on ${MAIN}.`);
  if (kind !== "feature") await offerStagingRebuild(name);
}

/**
 * Picks which commit of a Feature goes to production. If it was staged at a different commit than
 * its latest, you choose, with the latest first.
 */
async function chooseVersion({ name, branch }: Work, tip: string): Promise<string> {
  const staged = await commitOf(stagingTag(name));
  if (!staged) {
    log.warn(`${name} has never been deployed to staging.`);
    return tip;
  }
  if (staged === tip) return tip;
  return select(`${branch} has changed since it was deployed to staging. Which version should go to production?`, [
    { value: tip, label: "The latest", hint: `${tip.slice(0, 8)}, which staging hasn't run` },
    { value: staged, label: "What staging ran", hint: `${staged.slice(0, 8)}, leaving the newer commits on the branch` },
  ]);
}

const KIND_SUFFIX: Record<WorkKind, string> = { feature: "", hotfix: " (hotfix)", infra: " (infra)" };

/**
 * Pushes main and the prod tags, and removes the staging tag and branch. All or nothing on origin.
 * The branch is kept if it has commits that weren't shipped, so they aren't lost.
 */
async function recordProdDeploy({ kind, name, branch }: Work, subject: string, shipped: string): Promise<void> {
  const head = await out`git rev-parse HEAD`;
  const heading = `${name}${KIND_SUFFIX[kind]} deployed to prod`;
  await setTag(PROD_LATEST, head, heading, subject);
  await setTag(prodTag(name), head, heading, subject);

  const refspecs = [MAIN, `+refs/tags/${PROD_LATEST}`, `+refs/tags/${prodTag(name)}`];
  if (kind === "infra") refspecs.push(await markInfraInProd(name, head, heading));
  if (await commitOf(stagingTag(name))) refspecs.push(`:refs/tags/${stagingTag(name)}`);
  const originTip = await commitOf(`origin/${branch}`);
  const localTip = await commitOf(branch);
  const unshipped = async (tip?: string) => Boolean(tip) && !(await contains(shipped, tip!));
  const keepBranch = (await unshipped(originTip)) || (await unshipped(localTip));
  if (originTip && !keepBranch) refspecs.push(`:refs/heads/${branch}`);

  const push = await sh`git push --atomic origin ${refspecs}`.nothrow();
  if (push.exitCode !== 0) {
    throw new ShipError(
      `Production is deployed, but pushing to origin failed, so nothing changed there. Don't re-run ship yet.\n` +
        `Fix the problem below, then run:\n  git push --atomic origin ${refspecs.join(" ")}\n\n${push.stderr}`,
    );
  }

  await sh`git tag -d ${stagingTag(name)}`.nothrow();
  if (keepBranch) {
    log.warn(`Kept ${branch} because it has commits that weren't shipped.`);
  } else {
    await sh`git branch -D ${branch}`.nothrow();
  }
  await fetchLatest();
}

/** Hotfixes and Infrastructure Changes go around staging, so staging lacks them until it's rebuilt from the new main. */
async function offerStagingRebuild(name: string): Promise<void> {
  if (!(await confirm(`Rebuild staging so it includes ${name}?`))) return;
  try {
    await rebuildStaging(await stagedCommits());
    log.success(`Staging now includes ${name}.`);
  } catch (error) {
    if (!(error instanceof ShipError)) throw error;
    log.warn(`${name} is in production, but staging wasn't rebuilt.\n${error.message}`);
  }
}

async function squashOntoMain({ name, branch }: Work, commit: string, subject: string): Promise<void> {
  const merge = await sh`git merge --squash ${commit}`.nothrow();
  if (merge.exitCode !== 0 && !(await resolveLockfileConflict())) {
    const files = await conflictedFiles();
    throw new ShipError(
      `${name} conflicts with ${MAIN}, so nothing was deployed. Merge ${MAIN} into ${branch}, resolve it, and ship again.\n` +
        (files.length ? `Conflicting files:\n  ${files.join("\n  ")}` : `${merge.stderr}`),
    );
  }
  if ((await sh`git diff --cached --quiet`.nothrow()).exitCode === 0) {
    throw new ShipError(`${name} has no changes that aren't already on ${MAIN}.`);
  }
  await sh`git commit -m ${subject}`;
}

async function moveToLatestMain(startingBranch: string): Promise<void> {
  await sh`git switch ${MAIN}`;
  const forward = await sh`git merge --ff-only ${ORIGIN_MAIN}`.nothrow();
  if (forward.exitCode !== 0) {
    await sh`git switch ${startingBranch}`;
    throw new ShipError(`Your local ${MAIN} has commits that aren't on origin. Sort those out first.\n${forward.stderr}`);
  }
}
