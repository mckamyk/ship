# Which Environments have each Infrastructure Change is recorded as tags on origin

Dev is in the Nonprod Network, and Staging and Production are in the Prod Network. The two can't reach each other, so no ship run can see every Environment. Origin is the only thing both can reach, so ship records that an Infrastructure Change has reached an Environment with an `infra/<env>/<name>` tag there. That tells people when infra is in Production but missing from Dev or Staging, and lets ship offer to deploy it.

Ship doesn't know which Network it's running in. A deploy started on the wrong VM simply fails. We rejected a per-machine setting because it's one more thing to configure for little gain.
