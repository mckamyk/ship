# Features ship to Production independently of what they were staged with

Staging runs the latest `main` plus every Staged Feature together, but each Feature goes to Production on its own. So Production can end up with a combination, such as `main` plus B without A, that Staging never ran. We accept this because Features are assumed to be independent. Staging checks that each Feature works on top of `main`, not that an exact set of Features works together. Forcing Features to ship together or in order would couple unrelated work and block the team.
