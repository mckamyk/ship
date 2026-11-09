<img src="assets/icon.svg" width="64" height="64" alt="">

# ship-cli

Created in [T3 Code](https://t3.codes).

An interactive CLI for moving work through dev, staging and production. Run `bun ship` and the menu adapts to the branch you're on. `main` always matches production. It's built for a small team, so it doesn't guard against two people shipping at the same moment.

## Setup

This is designed to live in a Bun monorepo at `packages/ship`. When copying it in, leave out `.git`, `node_modules` and `bun.lock`, because the workspace's root lockfile takes over.

Add a script to the root `package.json`, with `packages/*` in its workspaces:

```json
{
  "workspaces": ["packages/*"],
  "scripts": { "ship": "bun packages/ship/src/cli.ts" }
}
```

Then add `ship.config.json` to the root of the repo:

```json
{
  "$schema": "./packages/ship/ship.config.schema.json",
  "deploy": {
    "dev": "bun install --frozen-lockfile && bunx sst deploy --stage dev",
    "staging": "bun install --frozen-lockfile && bunx sst deploy --stage staging",
    "prod": "bun install --frozen-lockfile && bunx sst deploy --stage prod"
  }
}
```

**Keep the `bun install` in each command.** The deploy runs in your working folder after ship has switched branches, so `node_modules` would otherwise be missing dependencies added by other features on staging.

**If an environment has no command, the deploy only prints a warning and counts as a success**, so tags still get written and branches still get deleted. The schema flags this in your editor, but the CLI doesn't check the file against it.

## Running it in a monorepo

| Where you are | Command |
|---|---|
| Repo root | `bun ship` |
| `packages/ship` | `bun ship` |
| Any other package | `bunx ship-cli`, if the root has `"devDependencies": { "ship-cli": "workspace:*" }` |

Wherever you start it, the CLI works from the repo root. That means:

- **Config and deploys:** `ship.config.json` is read from the root and deploy commands run there. If a deploy needs another folder, put `cd` in the command.
- **Commits:** committing your work includes changes across the whole monorepo, not just the package you're in. The file list is shown first so you can check.
- **Dependencies after a ship:** `node_modules` is shared between branches, and `bun install` doesn't always remove packages from an earlier one. A deploy can therefore see packages its commit doesn't declare, so delete `node_modules` and reinstall if something only works locally.
- **The CLI's own code:** it runs from your checkout, so it's the version on your current branch, and a branch that breaks `packages/ship` breaks `bun ship` on that branch. Switching branches during a ship is safe.

## Features

Normal work, on `ship/<name>` branches, usually going through staging on the way to production.

| Step | Run it from | What happens |
|---|---|---|
| Start | Any other branch | Creates `ship/<name>` from the latest `origin/main` |
| Ship to dev | `ship/<name>` | Deploys the branch as it is, with no merging or tags |
| Ship to staging | `ship/<name>` | Builds latest main + this branch + every feature with a staging tag, force-pushes that to `staging`, deploys, then tags this branch `staging/<name>` |
| Ship to production | `ship/<name>`, or pick from a list | Squash-merges onto `main` and deploys. If that succeeds, pushes `main`, updates the prod tags, and removes the staging tag and feature branch |
| Remove from staging | Any branch | Rebuilds staging without the feature and deploys, then removes its tag. Its branch is kept, so it can be shipped again |

## Hotfixes and infrastructure changes

These live on `hotfix/<name>` branches and skip staging. Infrastructure changes usually go this way too, behind feature flags you configure manually. The CLI doesn't touch the flags.

| Step | Run it from | What happens |
|---|---|---|
| Start | Any non-`ship/`, non-`hotfix/` branch | Creates `hotfix/<name>` from the latest `origin/main` |
| Ship to dev | `hotfix/<name>` | Optional. Deploys the branch as it is |
| Finish | `hotfix/<name>` | Squash-merges onto `main`, deploys to production, updates the prod tags and deletes the branch |

Finishing then offers to rebuild staging, because staging doesn't have the hotfix until it's rebuilt from the new `main`. Features already on staging stay on it. If the rebuild conflicts or fails, the hotfix still counts as shipped and you get a warning.

## Tags

| Tag | Points at | Lifetime |
|---|---|---|
| `staging/<name>` | The feature commit that was deployed | Moves on each staging ship, deleted on reaching production or when removed |
| `prod/latest` | The `main` commit running in production | Moves on each production deploy |
| `prod/<name>` | That feature's or hotfix's commit on `main` | Permanent |

Tags are annotated, so `git show staging/<name>` displays the note, who deployed it and when.

Git can't have a `prod` tag alongside `prod/<name>` tags, which is why the moving tag is `prod/latest`. It also means `latest` can't be used as a name.

## When things go wrong

- **`bun.lock` conflict:** resolved automatically when it's the only conflicting file, for both staging and production. Existing versions stay pinned. Dependencies from the incoming side get the newest version their range allows, which may not be the exact version that branch had locked.
- **Staging conflict in any other file:** nothing is pushed or deployed, and you're returned to your branch with a list of the conflicting files. If another feature is in the way, you can remove it from staging.
- **Staging deploy fails:** the `staging` branch has already been force-pushed, but no tags change. Staging ships after that won't include a feature that was never tagged.
- **Production conflict or failed deploy:** local `main` is reset, origin is untouched and you're back on your branch. Run it again to retry. A failed deploy can still have partly changed the environment, depending on your deploy tool.
- **Push fails after a production deploy:** production has the new code but origin doesn't. The error prints the exact command to run once the problem is fixed.

## Working on this code

| File | Purpose |
|---|---|
| `src/cli.ts` | Entry point, menu and error display |
| `src/commands/*.ts` | One file per flow, and the place to change behaviour |
| `src/git.ts` | Names, git queries and shared helpers |
| `src/deploy.ts` | Runs the configured deploy command |
| `src/prompts.ts` | Small wrappers around `@clack/prompts` |

Git commands use [Bun Shell](https://bun.sh/docs/runtime/shell) through the `sh` and `out` helpers. **Pass anything containing `^{}`, `%()` or `*` as a `${variable}`**, because the shell interprets those characters when they're written directly in the template.

```sh
bun test           # real git repos in a temp folder, with prompts mocked
bun run typecheck
```
