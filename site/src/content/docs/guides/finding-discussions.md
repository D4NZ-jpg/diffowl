---
title: Finding discussions
description: Accept, challenge, resolve, suppress, recheck, and reassess findings in GitHub threads.
---

Each published finding carries an engine-owned identity marker. The durable finding ledger reconciles that identity across pushes, reruns, and discussion events.

## Commands

Reply to the root finding thread with one exact top-level command:

| Command                       | Effect                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| `/diffowl accept`             | Accept the finding.                                             |
| `/diffowl rebut <context>`    | Challenge the finding with additional context.                  |
| `/diffowl suppress <reason>`  | Suppress it with an explicit reason.                            |
| `/diffowl ignore <reason>`    | Record an intentional decision not to act.                      |
| `/diffowl resolved`           | Mark the finding resolved. `/diffowl resolve` is also accepted. |
| `/diffowl recheck`            | Rerun deterministic verification.                               |
| `/diffowl explain`            | Request a bounded explanation.                                  |
| `/diffowl reassess <context>` | Supply new product or technical context for reassessment.       |

`/review-owl` is accepted as an alias for `/diffowl`.

## Parsing rules

Commands must be:

- the complete top-level comment body;
- on one line;
- outside quotes and code fences;
- supplied with context or reason when the command requires it.

Quoted, fenced, multiline, and command-looking prose is ignored. `/diffowl recheck` does not accept trailing context.

## Event-driven handling

GitHub-hosted commands are processed from their event, not discovered by rescanning comment history. The trusted router:

1. resolves nested replies to the stable root finding;
2. authenticates the actor and current head revision;
3. records the command event before effects;
4. dispatches bounded discussion work or a full review when the head changed.

Accepted and coalesced requests receive an eyes reaction. Refused requests receive one short reply.

## Lifecycle and reassessment

Discussion does not replace finding identity. Accepting, rebutting, suppressing, ignoring, or resolving a finding changes its visible disposition while preserving the audited event trail. Reassessment adds context without copying or inventing a new identity.
