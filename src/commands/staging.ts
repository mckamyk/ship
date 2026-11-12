import { deploy } from "../deploy";
import {
  catchUpWithOrigin,
  commitOf,
  commitWork,
  conflictedFiles,
  currentBranch,
  fetchLatest,
  ORIGIN_MAIN,
  out,
  requireCleanTree,
  resolveLockfileConflict,
  setTag,
  sh,
  ShipError,
  stagedFeatures,
  STAGING,
  stagingTag,
  workFor,
  workOnOrigin,
} from "../git";
import { recordInfra } from "../infra";
import { Cancelled, confirm, log, select, text } from "../prompts";

interface StagedCommit {
  name: string;
  commit: string;
}

/** Adds the checked-out Feature to staging, then tags it once the deploy succeeds. */
export async function shipToStaging(name: string): Promise<void> {
  const { branch } = workFor("feature", name);
  await fetchLatest();
  await catchUpWithOrigin(branch);
  await commitWork({ required: true });
  // Pushed so someone else, or the deploy VM, can ship it to production later.
  const push = await sh`git push -u origin ${branch}`.nothrow();
  if (push.exitCode !== 0) {
    throw new ShipError(`Couldn't push ${branch}. If origin has newer commits, pull them first.\n${push.stderr}`);
  }
  await stageFeature(name, await out`git rev-parse HEAD`);
}

/** Adds a Feature to staging from its branch on origin, for when you aren't on it (e.g. on the deploy VM). */
export async function pickAndShipToStaging(): Promise<void> {
  await requireCleanTree();
  await fetchLatest();
  const staged = new Set(await stagedFeatures());
  const choices = (await workOnOrigin("feature")).map((name) => ({
    value: name,
    label: name,
    hint: staged.has(name) ? "on staging, reships its latest commit" : "not on staging",
  }));
  if (!choices.length) throw new ShipError("No Feature branches on origin to ship.");
  const name = await select("Which Feature should go to staging?", choices);
  const commit = await commitOf(`origin/${workFor("feature", name).branch}`);
  if (!commit) throw new ShipError(`Can't find origin/${workFor("feature", name).branch}.`);
  await stageFeature(name, commit);
}

async function stageFeature(name: string, commit: string): Promise<void> {
  const others = await stagedCommits(name);
  const note = await text("Note for the staging tag (optional)", { placeholder: "What's in this deploy?" });
  const summary = others.length ? `${name} will join ${others.map((o) => o.name).join(", ")} on staging.` : `${name} will be alone on staging.`;
  if (!(await confirm(`${summary} Deploy staging?`))) throw new Cancelled();

  await rebuildStaging([{ name, commit }, ...others], name);

  const tag = stagingTag(name);
  await setTag(tag, commit, `${name} deployed to staging`, note);
  const refspec = `+refs/tags/${tag}`;
  await sh`git push origin ${refspec}`;
  log.success(`${name} is deployed to staging and tagged ${tag}.`);
}

/** Takes a feature off staging by rebuilding without it. Its branch is left alone, so it can be shipped again. */
export async function removeFromStaging(): Promise<void> {
  await requireCleanTree();
  const staged = await stagedFeatures();
  const name = await select(
    "Which feature should come off staging?",
    staged.map((feature) => ({ value: feature, label: feature })),
  );
  if (!(await confirm(`Rebuild staging without ${name} and deploy?`))) throw new Cancelled();

  await rebuildStaging(await stagedCommits(name));
  await removeStagingTags([name]);
  log.success(`${name} is off staging. Its branch is still there.`);
}

/** Rebuilds staging from the latest main, which brings it any Missing Infrastructure. */
export async function rebuildStagingForInfra(missing: string[]): Promise<void> {
  await requireCleanTree();
  if (!(await confirm(`Rebuild staging from the latest main so it gets ${missing.join(", ")}?`))) throw new Cancelled();
  await rebuildStaging(await stagedCommits());
  log.success(`Staging now has ${missing.join(", ")}.`);
}

/** Everything tagged on staging except `exclude`, using the commit that was deployed rather than the branch's latest. */
export async function stagedCommits(exclude?: string): Promise<StagedCommit[]> {
  const staged: StagedCommit[] = [];
  for (const name of await stagedFeatures()) {
    const commit = await commitOf(stagingTag(name));
    if (name !== exclude && commit) staged.push({ name, commit });
  }
  return staged;
}

async function removeStagingTags(names: string[]): Promise<void> {
  if (!names.length) return;
  const refspecs = names.map((name) => `:refs/tags/${stagingTag(name)}`);
  await sh`git push origin ${refspecs}`;
  for (const name of names) await sh`git tag -d ${stagingTag(name)}`.nothrow();
}

/**
 * Staging is rebuilt from scratch every time: latest main plus the given features, on a temporary
 * branch, deployed, and only then force-pushed to `staging`. Returns you to the branch you were on.
 *
 * If a Staged Feature other than `own` (the one being shipped) conflicts, you're offered to take it
 * off staging and carry on. Throws on any other conflict or a failed deploy, and callers only change
 * tags if this succeeds.
 */
export async function rebuildStaging(features: StagedCommit[], own?: string): Promise<void> {
  const startingBranch = await currentBranch();
  const tempBranch = `ship-tmp/staging-${crypto.randomUUID().slice(0, 8)}`;
  const dropped: string[] = [];

  await sh`git switch --no-track -c ${tempBranch} ${ORIGIN_MAIN}`;
  try {
    for (const feature of features) {
      if (!(await mergeIntoTemp(feature, feature.name === own))) dropped.push(feature.name);
    }
    const built = await out`git rev-parse HEAD`;
    if (!(await deploy("staging"))) throw new ShipError("Staging deploy failed, so the staging branch and tags weren't changed.");
    const push = await sh`git push --force origin HEAD:refs/heads/${STAGING}`.nothrow();
    if (push.exitCode !== 0) {
      throw new ShipError(`Staging is deployed, but pushing the ${STAGING} branch failed, so no tags were changed.\n${push.stderr}`);
    }
    await removeStagingTags(dropped);
    await recordInfra("staging", built);
  } finally {
    await sh`git reset --merge`.nothrow();
    await sh`git switch ${startingBranch}`;
    await sh`git branch -D ${tempBranch}`;
  }
  if (dropped.length) log.warn(`Took ${dropped.join(", ")} off staging. Their branches are still there.`);
}

/** Returns false if the feature conflicted and you chose to take it off staging instead. */
async function mergeIntoTemp({ name, commit }: StagedCommit, isOwn: boolean): Promise<boolean> {
  const message = `Merge ${name} into ${STAGING}`;
  const merge = await sh`git merge --no-ff --no-edit -m ${message} ${commit}`.nothrow();
  if (merge.exitCode === 0) return true;
  if (await resolveLockfileConflict()) {
    await sh`git commit --no-edit`;
    return true;
  }
  const files = await conflictedFiles();
  const details = files.length ? `Conflicting files:\n  ${files.join("\n  ")}` : `${merge.stderr}`;
  if (!isOwn) {
    log.warn(`${name} is on staging but conflicts with the rest of what's going there.\n${details}`);
    if (await confirm(`Take ${name} off staging and carry on? Its branch is kept, so it can be shipped again once fixed.`)) {
      await sh`git merge --abort`;
      return false;
    }
  }
  throw new ShipError(`${name} conflicts with the other work going to staging, so nothing was pushed or deployed.\n${details}`);
}
