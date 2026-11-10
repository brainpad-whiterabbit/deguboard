# Recording a Run (run)

A Run is the record of one piece of work, and it keeps the usage (tokens). This guide covers only the claim and PR recording when the parent does the work itself, and cleaning up a stopped Run.

## When the parent advances work itself

- Call the claim that opens a Run alone, and do not chain other commands to it (if the ID shows up late in the conversation record, the responses of Runs stacked in the same conversation cannot be told apart correctly)
- `ticket claim` opens the implementation Run. Its step is the Workflow's `opens_on: claim` one (`implement` if there is none). The ID is in `data.run`
- `ticket update --pr <number>` closes the implementation Run as `success` (finished_at is the time the PR was created). `run finish` is not needed. For work that needs no PR, `ticket move` to done or review closes it
- To stop, `ticket unclaim` closes it as `failure`. To leave a reason, first run `run finish <Run ID> --result failure --error <reason>`
- To fix findings yourself, claim a ticket that you already claimed and that has a PR, with `ticket claim <id> --retry-reason <one-line summary of each finding>`. Repeat it once per finding. The ticket does not change, and the fix Run (the one with `opens_on: reclaim`, or `fix` if there is none) opens. The start of the next review Run or `sync` closes it at the time of the last push
- Keep each reason to one line, and do not write secrets, command strings, or paths

## Stopped Run

Find a Run that is still open and has not returned with `dg --json --actor agent run list --running --ticket <id>`, and close it with `run finish <Run ID> --result interrupted --error <reason>`. After that, follow `dg next` for the next step.
</content>
