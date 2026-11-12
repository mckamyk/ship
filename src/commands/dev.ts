import { deploy } from "../deploy";
import {
  catchUpWithOrigin,
  commitWork,
  currentBranch,
  fetchLatest,
  MAIN,
  mergeLatestMain,
  ORIGIN_MAIN,
  out,
  requireCleanTree,
  sh,
  ShipError,
  type Work,
} from "../git";
import { infraRolledBackBy, recordInfra } from "../infra";
import { confirm, log } from "../prompts";

/**
 * Dev is a free-for-all: deploy this branch as it is, with no merging or tags. The one thing
 * recorded is which Infrastructure Changes Dev ends up with, so you're warned before rolling one back.
 */
export async function shipToDev({ name, branch }: Work): Promise<void> {
  await fetchLatest();
  await catchUpWithOrigin(branch);
  await commitWork({ required: false });

  const lacking = await infraRolledBackBy("dev", await out`git rev-parse HEAD`);
  if (lacking.length) {
    const list = lacking.join(", ");
    if (await confirm(`Dev has ${list}, but ${branch} doesn't, so deploying would roll it back. Merge the latest ${MAIN} into ${branch} first?`)) {
      await requireCleanTree();
      await mergeLatestMain(branch);
    }
  }
  await deployToDev(name);
}

/** Brings Missing Infrastructure to Dev: merges the latest main into the checked-out branch, then deploys it. */
export async function bringInfraToDev(missing: string[]): Promise<void> {
  const branch = await currentBranch();
  await fetchLatest();
  await commitWork({ required: true });
  if (branch === MAIN) {
    const forward = await sh`git merge --ff-only ${ORIGIN_MAIN}`.nothrow();
    if (forward.exitCode !== 0) throw new ShipError(`Your local ${MAIN} has commits that aren't on origin. Sort those out first.\n${forward.stderr}`);
  } else {
    await mergeLatestMain(branch);
  }
  log.info(`Deploying ${branch} with the latest ${MAIN}, which has ${missing.join(", ")}.`);
  await deployToDev(branch);
}

async function deployToDev(label: string): Promise<void> {
  if (!(await deploy("dev"))) throw new ShipError(`Dev deploy of ${label} failed.`);
  await recordInfra("dev", await out`git rev-parse HEAD`);
  log.success(`${label} is deployed to dev.`);
}

/** Pushes the branch so it can be shipped from elsewhere, such as the deploy VM in the Prod Network. */
export async function pushWork({ branch }: Work): Promise<void> {
  await commitWork({ required: true });
  const push = await sh`git push -u origin ${branch}`.nothrow();
  if (push.exitCode !== 0) throw new ShipError(`Couldn't push ${branch}. If origin has newer commits, pull them first.\n${push.stderr}`);
  log.success(`${branch} is on origin, ready to ship from the deploy VM.`);
}
