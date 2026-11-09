import { fetchLatest, MAIN, nameProblem, ORIGIN_MAIN, sh, ShipError, slugify, workFor, type WorkKind } from "../git";
import { log, text } from "../prompts";

/** Creates `ship/<name>` or `hotfix/<name>` from the latest main. */
export async function startWork(kind: WorkKind): Promise<void> {
  const label = kind === "hotfix" ? "Hotfix name" : "Feature name";
  const name = slugify(await text(label, { placeholder: kind === "hotfix" ? "fix-login" : "checkout-flow" }));
  const problem = await nameProblem(name);
  if (problem) throw new ShipError(problem);

  const { branch } = workFor(kind, name);
  await fetchLatest();
  await sh`git switch --no-track -c ${branch} ${ORIGIN_MAIN}`;
  log.success(`On ${branch}, branched from the latest ${MAIN}. Do your work, then run this again.`);
}
