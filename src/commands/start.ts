import { fetchLatest, KIND_LABELS, MAIN, nameProblem, ORIGIN_MAIN, sh, ShipError, slugify, workFor, type WorkKind } from "../git";
import { log, text } from "../prompts";

const PLACEHOLDERS: Record<WorkKind, string> = { feature: "checkout-flow", hotfix: "fix-login", infra: "split-vpc" };

/** Creates `ship/<name>`, `hotfix/<name>` or `infra/<name>` from the latest main. */
export async function startWork(kind: WorkKind): Promise<void> {
  const name = slugify(await text(`${KIND_LABELS[kind]} name`, { placeholder: PLACEHOLDERS[kind] }));
  const problem = await nameProblem(name);
  if (problem) throw new ShipError(problem);

  const { branch } = workFor(kind, name);
  await fetchLatest();
  await sh`git switch --no-track -c ${branch} ${ORIGIN_MAIN}`;
  log.success(`On ${branch}, branched from the latest ${MAIN}. Do your work, then run this again.`);
}
