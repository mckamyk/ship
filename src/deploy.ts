import { log } from "./prompts";

/** If you add an environment, add it to ship.config.schema.json too. */
export type Environment = "dev" | "staging" | "prod";

const CONFIG_FILE = "ship.config.json";

/** The command for an environment, from `{ "deploy": { "dev": "...", ... } }` in the repo root. */
async function deployCommand(env: Environment): Promise<string | undefined> {
  const file = Bun.file(CONFIG_FILE);
  if (!(await file.exists())) return undefined;
  const config: { deploy?: Partial<Record<Environment, string>> } = await file.json();
  return config.deploy?.[env];
}

/** Runs the deploy with live output and returns whether it succeeded. */
export async function deploy(env: Environment): Promise<boolean> {
  const command = await deployCommand(env);
  if (!command) {
    // Placeholder until the real command is configured, e.g. `bunx sst deploy --stage staging`.
    log.warn(`No ${env} deploy command in ${CONFIG_FILE}, so nothing was really deployed. Treating it as a success.`);
    return true;
  }

  log.info(`Deploying to ${env}: ${command}`);
  // Ctrl-C reaches the deploy too. Ignoring it here lets us clean up and return you to your branch.
  const ignoreInterrupt = () => {};
  process.on("SIGINT", ignoreInterrupt);
  try {
    const proc = Bun.spawn(["sh", "-c", command], { stdio: ["inherit", "inherit", "inherit"] });
    return (await proc.exited) === 0;
  } finally {
    process.off("SIGINT", ignoreInterrupt);
  }
}
