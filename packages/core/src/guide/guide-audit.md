---
description: Once every ticket of a deguboard Iteration (or Epic) is done, and before release, reviews the whole repository by viewpoint with subagents (documents and implementation, tests, architecture, README, dependencies, config files). Shows the findings in a table and, after approval, files them as tickets. The review does not change files. Use when asked「リリースの前に見直して」「リポジトリ全体を見直して」.
argument-hint: "[Iteration|Epic]"
---

# Audit (audit)

After all tickets of an Iteration (or Epic) are done, and before release, reviews the whole repository by viewpoint, and after approval files the findings as tickets. The review does not change files. What is found becomes tickets, which are fixed through a plan and PRs. The form and writing of the tickets follow `dg guide import`.

## Deciding the target

- Iteration (`s3`) and Epic (`e3`): the place to put the tickets to fix, and the unit for deciding whether the review is finished. The range reviewed is always the whole repository
- No target given: suggests the active Iteration and asks to confirm it. If there is none, asks which one. If the answer is to review without deciding a target, the findings are filed without putting them anywhere
- If the target still has tickets that are neither done nor abandoned, confirm whether the review may start

Below, the target's ID is written as `<S>`.

## Audit steps

1. **Read the state**: after `dg --json --actor agent sync`, read the target (`iteration show <S>` or `epic show <S>`) and the tickets filed by the previous review (those whose label starts with `audit-`; find them with `ticket list --label`). From the repository's rules (CLAUDE.md, README, development docs), take the documents that are the sources of truth, the check commands, and any additions or removals to the viewpoints. From the tag of the previous release (`git tag --sort=-creatordate`), decide the range to look at first (what changed after it)
2. **Make a temporary worktree**: after `git fetch {{git.remote}} {{git.base_branch}}`, run `git worktree add --detach {{worktree.root}}/audit-<S> {{git.remote}}/{{git.base_branch}}`. If it remains, remove it with `git worktree remove --force` before making it. Then run the install, build, and check steps that the rules write, in this order, only once. Note the result of each, and the last part of the output on failure. Do not stop on failure
3. **Decide the viewpoints**: apply the rules' decisions to the "Viewpoints" section below. For a viewpoint whose target is not in the repository, skip it and give the reason
4. **Review by viewpoint with subagents**: run them side by side, as in the "Delegating to subagents" section below
5. **Collect and match**: merge findings of the same target and the same mismatch across viewpoints into one. As in the "Not repeating the same findings" section below, remove those already handled, or make them `ticket update` proposals. Do not bring the contents of the files read into the session running this step
6. **Show the table of findings**: in the table below, in order of severity from high to low. Put low-severity findings into one line per viewpoint. Handling is one of "File", "`ticket update <ID>`", or "Do not fix (reason)"

   | #   | Viewpoint | Severity | Target | Finding | Where | Handling |
   | --- | --------- | -------- | ------ | ------- | ----- | -------- |

7. **Get approval**: ask once, with multiple selection (`#`), which rows to reflect (include "Do not reflect"). Write nothing until approval is obtained
8. **Reflect**: file the approved rows by the steps of `dg guide import` (see the "Filing tickets" section below). For overlapping tickets, add the findings with `ticket update <ID> --acceptance` or in the body
9. **Clean up and report the result**: remove the worktree with `git worktree remove {{worktree.root}}/audit-<S>` (also when stopped). If it cannot be removed, show the changed files from `git -C <path> status --short` in the result, then remove it with `--force`. Report the viewpoints reviewed and skipped, the tickets filed, and the findings not fixed

Running the review (subagents, read-only commands, the temporary worktree) proceeds without waiting for approval. Approval is asked only once, in step 7.

## Viewpoints

| Viewpoint     | What to check                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents and implementation | Mismatches between the sources of truth and the implementation. Decided work with neither an implementation nor a follow-up ticket. The length and organization of ADRs (for filing, see the "Filing tickets" section) |
| Tests         | Missing tests for the specs and acceptance criteria, flaky tests, skips without a reason, failures of the checks in step 2                                                          |
| Architecture  | Violations of the structure, dependency direction, or code conventions in the rules. Unused code, duplicated processing                                                              |
| README        | Whether the steps, commands, and options for users match the current implementation. Broken links                                                                                   |
| Dependencies  | Known vulnerabilities; dependencies that are far behind, stopped being updated, or unused; missing license notices                                                                  |
| Config files  | Inconsistencies among the settings of packages, builds, lint, type checks, and tool versions; unused settings; settings that differ from what the rules write                      |

The specifics of each viewpoint (the documents to read and the check commands) are read from the rules and are not written here. Look first at what changed since the previous release.

## Delegating to subagents

Start one subagent for each viewpoint, and run them side by side. This session only collects, matches, makes the table, asks for approval, and files tickets.

- **What to pass**: the viewpoint and what to check (the table above and the specifics from the rules), the location of the rules, the path of the temporary worktree, and the range to look at first (for example `git diff <tag>..{{git.remote}}/{{git.base_branch}}`). For the test viewpoint, also pass the results of the checks noted in step 2
- **What it may do**: read files in the temporary worktree, and run read-only commands that write no generated files (audit, individual lint or type checks, and so on)
- **What it must not do**: install dependencies again, rebuild, run the whole check, or delete generated files (they share one worktree, so they would break each other). Fix files. Write with `dg`
- **What it returns**: for each finding, the target (file and line), both sides of the mismatch, the basis (the output or the place in the document), a severity proposal, and a fix proposal. If there are no findings, the range it looked at

## Not repeating the same findings

- **Unfinished tickets**: if a ticket with the same target and the same mismatch exists, do not file it. Make it a `ticket update` proposal, or remove it
- **done tickets**: if a record of handling the same target exists, remove it. If it came back after being fixed, file it as new, and write the original ticket in the body
- **Items not to fix because of the intended design**: put them under "Do not fix", and propose filing a ticket that holds the intent in tests or comments (do not add it to an ADR; show it in tests or comments). The next review reads it from the tests or comments and removes it

## Severity and where to put it

| Severity | Applies to          | priority |
| -------- | ------------------- | -------- |
| High     | {{priority.high}}   | high     |
| Medium   | {{priority.medium}} | medium   |
| Low      | {{priority.low}}    | low      |

The place suggested for a finding is the target (fixed before release). Only findings that need a design decision, wait for something outside, cannot be fixed in one PR, or fit another theme are suggested to be left out of the target (unassigned), with the reason given.

## Filing tickets

- Attach the label `audit-<S>` (for example `audit-s3`). If the review was done without a target, use `audit`. If the target is an Iteration, write `<S>` in `iteration`; if it is an Epic, write it in `epic`
- If tickets with the label `audit-<S>` exist, `<S>` counts as already reviewed. Do not add or remove this label except when filing by this procedure
- File a mismatch between an ADR's details and the implementation with the title "Remove ADR details" (with the ADR number). Keep the decision as it is, and move the details to code, tests, and help
- When an ADR has grown long (the guide is 8,000 characters), an ADR is no longer needed, or decisions on the same theme are scattered, file with the title "Split and organize ADRs". Gather into one ticket: splitting, merging, deleting, deleting details, matching against the implementation, and listing the decisions that can move to tests or lint
- In the summary, write the viewpoint, the target, and both sides of the mismatch. Do not decide which side to match (decide it in planning)

{{choices}}

## Choosing the next step

After showing the result (also when there were no findings), ask with the following choices.

- **Make a plan** (recommended when something was filed for the target): plan the target's todos by the steps of `dg guide plan` (if a Skill is available, `/dgplan <S>`)
- **Release** (recommended when nothing was filed): release and close by the steps of `dg guide release` (if a Skill is available, `/dgrelease <S>`). If the target is an Epic, clean up with `dg guide done`
- **Stop here**
