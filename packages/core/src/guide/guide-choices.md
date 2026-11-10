## Asking with choices

Tickets advance in this order: import (`dg guide import`) → assign (`dg guide assign`) → check (`dg guide check`) → plan (`dg guide plan`) → work (`dg guide work`) → audit (`dg guide audit`, when an Iteration or Epic ends) → release (`dg guide release`; if there are no release steps, clean up with `dg guide done`). Done (`dg guide done`) comes after every merge. To carry on from assign through release, use `dg guide all`. When asking a human for a decision (approval, correction, which one to choose), and when a step is finished and the next step must be decided, show the choices and ask.

- When the agent can offer choices, ask with that mechanism (in Claude Code, the AskUserQuestion tool). If it cannot, show the numbered choices in text
- Show the material for the decision (tables, Plans, lists of PRs) before the choices. Do not ask for a decision with only the choices' descriptions
- Offer 2 to 4 choices, put the recommended one first, and give its reason. An answer that cannot be a choice, such as the content of a correction, is taken as free input outside the choices
- Ask questions where several can be chosen (such as which lines to reflect) with multiple selection. Ask about deletion, abandoned, and close operations one at a time
- When deciding the next step, make the next step in the flow and "stop here" the choices (see the "Choosing the next step" section of each guide). When the next step is chosen, if a Skill is available (for example `/dgwork p3`), start it. If not, read `dg guide <topic>` and continue with that step. Do not do the next step's work inside the current step.
