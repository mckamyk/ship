import { deploy } from "../deploy";
import {
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
} from "../git";
import { Cancelled, confirm, log, select, text } from "../prompts";

interface StagedCommit {
  name: string;
  commit: string;
}

/** Adds the current feature to staging, then tags it once the deploy succeeds. */
export async function shipToStaging(name: string): Promise<void> {
  await commitWork({ required: true });
  // Pushed so someone else, or you on another machine, can ship it to production later.
  const { branch } = workFor("feature", name);
  const push = await sh`git push -u origin ${branch}`.nothrow();
  if (push.exitCode !== 0) {
    throw new ShipError(`Couldn't push ${branch}. If origin has newer commits, pull them first.\n${push.stderr}`);
  }
  await fetchLatest();

  const others = await stagedCommits(name);
  const note = await text("Note for the staging tag (optional)", { placeholder: "What's in this deploy?" });
  const summary = others.length ? `${name} will join ${others.map((o) => o.name).join(", ")} on staging.` : `${name} will be alone on staging.`;
  if (!(await confirm(`${summary} Force-push staging and deploy?`))) throw new Cancelled();

  const commit = await out`git rev-parse HEAD`;
  await rebuildStaging([{ name, commit }, ...others]);

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

  const tag = stagingTag(name);
  const refspec = `:refs/tags/${tag}`;
  await sh`git push origin ${refspec}`;
  await sh`git tag -d ${tag}`;
  log.success(`${name} is off staging. Its branch is still there.`);
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

/**
 * Staging is rebuilt from scratch every time: latest main plus the given features, on a
 * temporary branch, force-pushed to `staging` and deployed. Returns you to the branch you were on.
 * Throws on a conflict or failed deploy, and callers only change tags if this succeeds.
 */
export async function rebuildStaging(features: StagedCommit[]): Promise<void> {
  const startingBranch = await currentBranch();
  const tempBranch = `ship-tmp/staging-${crypto.randomUUID().slice(0, 8)}`;

  await sh`git switch --no-track -c ${tempBranch} ${ORIGIN_MAIN}`;
  try {
    for (const { name, commit } of features) await mergeIntoTemp(name, commit);
    await sh`git push --force origin HEAD:refs/heads/${STAGING}`;
    if (!(await deploy("staging"))) throw new ShipError("Staging deploy failed, so no staging tags were changed.");
  } finally {
    await sh`git reset --merge`.nothrow();
    await sh`git switch ${startingBranch}`;
    await sh`git branch -D ${tempBranch}`;
  }
}

async function mergeIntoTemp(name: string, commit: string): Promise<void> {
  const message = `Merge ${name} into ${STAGING}`;
  const merge = await sh`git merge --no-ff --no-edit -m ${message} ${commit}`.nothrow();
  if (merge.exitCode === 0) return;
  if (await resolveLockfileConflict()) {
    await sh`git commit --no-edit`;
    return;
  }
  const files = await conflictedFiles();
  throw new ShipError(
    `${name} conflicts with the other work going to staging, so nothing was pushed or deployed.\n` +
      (files.length ? `Conflicting files:\n  ${files.join("\n  ")}` : `${merge.stderr}`),
  );
}
