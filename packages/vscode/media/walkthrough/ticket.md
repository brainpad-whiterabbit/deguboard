# 2. Create a ticket

Split what you want done into small tickets. The easiest way is to ask the agent in Claude Code to create them with `/dgimport`. The Skill it uses was installed by step 1.

1. Open the request box with the link below. Choose **Create tickets**, then write what you want done.
2. Copy the request and paste it into Claude Code, or pick an open terminal and **Send** the request to it. The agent proposes tickets, and they are created after you approve.

[Open the request box for the agent](command:deguboard.askInSidebar)

Or create one from a terminal. This needs `dg` on your PATH. If `dg` is not found, run [Install dg command](command:deguboard.installDg) first.

```sh
dg ticket create "My first ticket"
```

The ticket shows up in the sidebar's backlog and kanban. Click a row to open its details in the editor.
