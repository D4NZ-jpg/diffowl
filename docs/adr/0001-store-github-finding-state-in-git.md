# Store GitHub Finding state in a dedicated Git ref

For the default GitHub-hosted path, Diffowl stores each pull request's canonical Finding ledger in a dedicated ref in the base repository. Each transition creates a commit from the current tip and advances the ref without force, giving the ledger repository-lifetime retention, immutable history, and optimistic conflict detection without requiring an external store.

## Considered options

Checks, workflow artifacts, Actions caches, and repository variables expire or lack suitable history and concurrency guarantees. A machine-readable pull-request comment needs narrower permissions, but updates are last-writer-wins and authorized users can edit or delete it. These surfaces remain projections, not canonical state.

## Consequences

The GitHub-hosted path requires `Contents: write`; it refuses eligible runs when that permission or trustworthy state is unavailable rather than weakening its guarantees. State contains only canonical non-secret lifecycle data, is visible when the repository is public, is retained after pull-request closure in V1, and is never force-updated.
