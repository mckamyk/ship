#!/usr/bin/env bun
import { $ } from "bun";
import { intro, outro, cancel, log } from "@clack/prompts";
import { shipToDev } from "./commands/dev";
import { pickAndShipToProd, shipToProd } from "./commands/prod";
import { removeFromStaging, shipToStaging } from "./commands/staging";
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
} from "./git";
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
  log.info(`Staging: ${staged.join(", ") || "nothing tagged"}\nProd: ${prod?.slice(0, 8) ?? "not deployed by ship yet"}`);

  // The options depend on the branch name: ship/ is a feature, hotfix/ is a hotfix, anything else can start one.
  const work = workFromBranch(branch);
  const choices: Choice<Run | null>[] = [];
  if (work?.kind === "feature") {
    choices.push(
      { value: () => shipToDev(work.name), label: "Ship to dev", hint: "deploys this branch as it is" },
      { value: () => shipToStaging(work.name), label: "Ship to staging", hint: "latest main + this branch + everything on staging" },
      { value: () => shipToProd(work), label: "Ship to production", hint: "squash-merges into main and deploys" },
    );
  } else if (work?.kind === "hotfix") {
    choices.push(
      { value: () => shipToProd(work), label: "Finish hotfix", hint: "squash-merges into main and deploys to production" },
      { value: () => shipToDev(work.name), label: "Ship to dev", hint: "deploys this branch as it is" },
    );
  } else {
    choices.push(
      { value: () => startWork("feature"), label: "Start a new feature", hint: `branches from latest ${MAIN}` },
      { value: () => startWork("hotfix"), label: "Start a hotfix", hint: "urgent fixes and infrastructure changes, straight to production" },
    );
    if ((await prodCandidates()).length) {
      choices.push({ value: pickAndShipToProd, label: "Ship a feature to production", hint: "pick from a list" });
    }
  }
  if (staged.length) {
    choices.push({ value: removeFromStaging, label: "Remove a feature from staging", hint: "rebuilds staging without it" });
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
