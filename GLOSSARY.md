# Ship

How a small team moves changes through Dev, Staging and Production with the ship CLI.

## Language

### Work

**Work**:
A named change on its own branch, on its way to Production. Each Work is a Feature, a Hotfix or an Infrastructure Change.
_Avoid_: Task, change, ticket

**Feature**:
Work that normally goes through Staging before Production. Its branch uses the `ship/` prefix.
_Avoid_: Ship (as a noun), ship branch

**Hotfix**:
Work that skips Staging and goes straight to Production. Its branch uses the `hotfix/` prefix.
_Avoid_: Patch, emergency fix

**Infrastructure Change**:
Work that changes the deployed infrastructure itself. Like a Hotfix it goes straight to Production, but it's hidden behind a Feature Flag so it can bake in lower environments first. Its branch uses the `infra/` prefix.
_Avoid_: Infra hotfix

**Feature Flag**:
A switch, managed outside ship, that turns an Infrastructure Change on per environment.
_Avoid_: Toggle

**Missing Infrastructure**:
An Infrastructure Change that has reached Production but not yet Dev or Staging. An Infrastructure Change only counts as reaching an Environment once it's on `main`. Trying out its unfinished branch on Dev doesn't count.

### Environments

**Environment**:
One of Dev, Staging or Production. Nothing else.
_Avoid_: Using it for a Network

**Dev**:
A shared environment that runs whichever Work was deployed to it last. The only thing recorded about it is which Infrastructure Changes it has.

**Staging**:
A shared environment running the latest `main` plus every Staged Feature, rebuilt from scratch on each change.

**Staged Feature**:
A Feature whose `staging/<name>` tag marks the exact commit Staging was last built with. It stays staged until it reaches Production or is removed from Staging.
_Avoid_: Feature on the staging branch

**Production**:
The live environment. `main` is meant to match it, but it can drift because a manual deploy is rare but possible.
_Avoid_: Prod (except in tag and config names)

**Last Production Deploy**:
The commit ship last deployed to Production, marked by the `prod/latest` tag. It isn't necessarily what Production is running, because of manual deploys.
_Avoid_: Current production, what's live

### Networks

**Nonprod Network**:
The physically separate network holding Dev and the shared development VM where all code is written. It can't reach the Prod Network.
_Avoid_: Nonprod environment, dev side

**Prod Network**:
The physically separate network holding Staging, Production and the shared deploy VM that ships to them. It can't reach the Nonprod Network.
_Avoid_: Prod environment, live side

**Origin**:
The git remote both Networks can reach, and so the only place they share records.
