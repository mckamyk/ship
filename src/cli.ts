#!/usr/bin/env bun
import { $ } from "bun";
import { intro, outro, cancel, log } from "@clack/prompts";
import { bringInfraToDev, pushWork, shipToDev } from "./commands/dev";
import { pickAndShipToProd, shipToProd } from "./commands/prod";
import { pickAndShipToStaging, rebuildStagingForInfra, removeFromStaging, shipToStaging } from "./commands/staging";
import { startWork } from "./commands/start";
import {
  commitOf,
  currentBranch,
  fetchLatest,
  MAIN,
  ORIGIN_MAIN,
  out,
  PROD_LATEST,
  prodCandidates,
  sh,
  ShipError,
  stagedFeatures,
  workFromBranch,
  workOnOrigin,
} from "./git";
import { missingInfra } from "./infra";
import { Cancelled, select, type Choice } from "./prompts";

type Run = () => Promise<void>;

async function menu(): Promise<void> {
  if ((await sh`git rev-parse --show-toplevel`.nothrow()).exitCode !== 0) throw new ShipError("Not inside a git repository.");
  process.chdir(await out`git rev-parse --show-toplevel`);

  if ((await sh`git remote get-url origin`.nothrow()).exitCode !== 0) throw new ShipError("This repository has no origin remote.");
  const branch = await currentBranch();
  if (!branch) throw new ShipError("You're on a detached HEAD. Check out a branch first.");
  await fetchLatest();
  if (!(await commitOf(ORIGIN_MAIN))) throw new ShipError(`${ORIGIN_MAIN} doesn't exist. Push ${MAIN} first.`);

  const staged = await stagedFeatures();
  const prod = await commitOf(PROD_LATEST);
  const missing = { dev: await missingInfra("dev"), staging: await missingInfra("staging") };
  const status = [`Staging: ${staged.join(", ") || "nothing tagged"}`, `Prod: ${prod?.slice(0, 8) ?? "not deployed by ship yet"}`];
  if (missing.dev.length) status.push(`Infrastructure missing on dev: ${missing.dev.join(", ")}`);
  if (missing.staging.length) status.push(`Infrastructure missing on staging: ${missing.staging.join(", ")}`);
  log.info(status.join("\n"));

  // On a Work branch (usually the dev VM) the options are about that Work. Anywhere else
  // (usually main on the deploy VM) you can start Work, or pick any Work on origin to ship.
  const work = workFromBranch(branch);
  const choices: Choice<Run | null>[] = [];
  const devAndPush = () => {
    if (!work) return;
    choices.push(
      { value: () => shipToDev(work), label: "Ship to dev", hint: "deploys this branch as it is" },
      { value: () => pushWork(work), label: "Push to origin", hint: "so it can be shipped from the deploy VM" },
    );
  };
  if (work?.kind === "feature") {
    choices.push(
      { value: () => shipToDev(work), label: "Ship to dev", hint: "deploys this branch as it is" },
      { value: () => shipToStaging(work.name), label: "Ship to staging", hint: "latest main + this branch + everything on staging" },
      { value: () => shipToProd(work), label: "Ship to production", hint: "squash-merges into main and deploys" },
      { value: () => pushWork(work), label: "Push to origin", hint: "so it can be shipped from the deploy VM" },
    );
  } else if (work?.kind === "hotfix") {
    choices.push({ value: () => shipToProd(work), label: "Finish hotfix", hint: "squash-merges into main and deploys to production" });
    devAndPush();
  } else if (work?.kind === "infra") {
    choices.push({
      value: () => shipToProd(work),
      label: "Finish infrastructure change",
      hint: "squash-merges into main and deploys to production, behind its flag",
    });
    devAndPush();
  } else {
    choices.push(
      { value: () => startWork("feature"), label: "Start a new feature", hint: `branches from latest ${MAIN}` },
      { value: () => startWork("hotfix"), label: "Start a hotfix", hint: "urgent fixes, straight to production" },
      { value: () => startWork("infra"), label: "Start an infrastructure change", hint: "straight to production behind a feature flag" },
    );
    if ((await workOnOrigin("feature")).length) {
      choices.push({ value: pickAndShipToStaging, label: "Ship a feature to staging", hint: "pick from origin" });
    }
    if ((await prodCandidates("feature")).length) {
      choices.push({ value: () => pickAndShipToProd("feature"), label: "Ship a feature to production", hint: "pick from origin" });
    }
    if ((await workOnOrigin("hotfix")).length) {
      choices.push({ value: () => pickAndShipToProd("hotfix"), label: "Finish a hotfix", hint: "pick from origin" });
    }
    if ((await workOnOrigin("infra")).length) {
      choices.push({ value: () => pickAndShipToProd("infra"), label: "Finish an infrastructure change", hint: "pick from origin" });
    }
  }
  if (staged.length) {
    choices.push({ value: removeFromStaging, label: "Remove a feature from staging", hint: "rebuilds staging without it" });
  }
  if (missing.dev.length) {
    choices.push({ value: () => bringInfraToDev(missing.dev), label: "Bring missing infrastructure to dev", hint: `merges latest ${MAIN} into ${branch} and deploys` });
  }
  if (missing.staging.length) {
    choices.push({ value: () => rebuildStagingForInfra(missing.staging), label: "Bring missing infrastructure to staging", hint: "rebuilds staging" });
  }
  choices.push({ value: null, label: "Exit" });

  const run = await select("What do you want to do?", choices);
  await run?.();
}

async function main(): Promise<number> {
  intro("ship");
  try {
    await menu();
    outro("Done");
    return 0;
  } catch (error) {
    if (error instanceof Cancelled) {
      cancel("Cancelled");
      return 0;
    }
    if (error instanceof ShipError) {
      log.error(error.message);
    } else if (error instanceof $.ShellError) {
      log.error(`Command failed:\n${error.stderr.toString().trim()}`);
    } else {
      throw error;
    }
    outro("Stopped");
    return 1;
  }
}

process.exit(await main());
