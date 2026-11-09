import { deploy } from "../deploy";
import { commitWork, ShipError } from "../git";
import { log } from "../prompts";

/** Dev is a free-for-all: deploy this branch as it is, with no merging or tags. */
export async function shipToDev(name: string): Promise<void> {
  await commitWork({ required: false });
  if (!(await deploy("dev"))) throw new ShipError(`Dev deploy of ${name} failed.`);
  log.success(`${name} is deployed to dev.`);
}
