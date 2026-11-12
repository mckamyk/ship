# A missing deploy command counts as a successful deploy

If `ship.config.json` has no command for an environment, ship warns and carries on as if the deploy worked, so tags move and branches are deleted. This is deliberate. It lets a repo use ship before deploys are wired up, and lets something else, such as GitHub Actions on push, do the actual deploying.

## Consequences

In that mode, ship's ordering guarantees don't hold. Normally ship deploys first and pushes `main` only if the deploy succeeds. With external deploys the push is the deploy, so a failed CI run leaves `main` pushed and the Work tagged as shipped, and staging tags are written before CI has run. CI then owns whether the deploy succeeded.
