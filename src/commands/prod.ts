import { deploy } from "../deploy";
import {
  commitOf,
  commitWork,
  conflictedFiles,
  currentBranch,
  fetchLatest,
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
} from "../git";
import { Cancelled, confirm, log, select, text } from "../prompts";
import { rebuildStaging, stagedCommits } from "./staging";

/** Ships a feature picked from a list, for when you aren't on its branch. */
export async function pickAndShipToProd(): Promise<void> {
  await requireCleanTree();
  const choices = [];
  for (const name of await prodCandidates()) {
    const hint = (await commitOf(stagingTag(name))) ? "on staging" : "not on staging";
    choices.push({ value: name, label: name, hint });
  }
  await shipToProd(workFor("feature", await select("Which feature?", choices)));
}

/**
 * Squash-merges onto local main and deploys that. origin only changes if the deploy
 * succeeds, so origin/main always matches production.
 */
export async function shipToProd(work: Work): Promise<void> {
  const { kind, name, branch } = work;
  const startingBranch = await currentBranch();
  const onBranch = startingBranch === branch;

  if (onBranch) {
    await commitWork({ required: true });
  } else {
    await requireCleanTree();
  }
  await fetchLatest();

  const target = onBranch
    ? await commitOf("HEAD")
    : ((await commitOf(`origin/${branch}`)) ?? (await commitOf(stagingTag(name))) ?? (await commitOf(branch)));
  if (!target) throw new ShipError(`Can't find a branch or staging tag for ${name}.`);
  // Hotfixes skip staging on purpose, so these warnings only apply to features.
  if (kind === "feature") await warnIfNotTested(work, target);

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

  await recordProdDeploy(work, subject);
  log.success(`${name} is deployed to production. You're on ${MAIN}.`);
  if (kind === "hotfix") await offerStagingRebuild();
}

async function warnIfNotTested({ name, branch }: Work, target: string): Promise<void> {
  const stagedCommit = await commitOf(stagingTag(name));
  if (!stagedCommit) {
    log.warn(`${name} has never been deployed to staging.`);
  } else if (stagedCommit !== target) {
    log.warn(`${branch} has changed since it was deployed to staging, so production would get code staging hasn't run.`);
  }
}

/** Pushes main and the prod tags, and removes the staging tag and branch. All or nothing on origin. */
async function recordProdDeploy({ kind, name, branch }: Work, subject: string): Promise<void> {
  const head = await out`git rev-parse HEAD`;
  const heading = `${name}${kind === "hotfix" ? " (hotfix)" : ""} deployed to prod`;
  await setTag(PROD_LATEST, head, heading, subject);
  await setTag(prodTag(name), head, heading, subject);

  const refspecs = [MAIN, `+refs/tags/${PROD_LATEST}`, `+refs/tags/${prodTag(name)}`];
  if (await commitOf(stagingTag(name))) refspecs.push(`:refs/tags/${stagingTag(name)}`);
  if (await commitOf(`origin/${branch}`)) refspecs.push(`:refs/heads/${branch}`);

  const push = await sh`git push --atomic origin ${refspecs}`.nothrow();
  if (push.exitCode !== 0) {
    throw new ShipError(
      `Production is deployed, but pushing to origin failed, so nothing changed there. Don't re-run ship yet.\n` +
        `Fix the problem below, then run:\n  git push --atomic origin ${refspecs.join(" ")}\n\n${push.stderr}`,
    );
  }

  await sh`git tag -d ${stagingTag(name)}`.nothrow();
  await sh`git branch -D ${branch}`.nothrow();
  await fetchLatest();
}

/** A hotfix goes around staging, so staging lacks it until it's rebuilt from the new main. */
async function offerStagingRebuild(): Promise<void> {
  if (!(await confirm("Rebuild staging so it includes this hotfix?"))) return;
  try {
    await rebuildStaging(await stagedCommits());
    log.success("Staging now includes the hotfix.");
  } catch (error) {
    if (!(error instanceof ShipError)) throw error;
    log.warn(`The hotfix is in production, but staging wasn't rebuilt.\n${error.message}`);
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
