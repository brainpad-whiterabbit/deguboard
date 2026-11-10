// Project の操作（requirements.md 5.3）

import { z } from "zod";
import { OperationError } from "../errors.js";
import { withWrite } from "../git/write.js";
import { slugSchema } from "../model/common.js";
import { PROJECT_STATUSES } from "../model/project.js";
import { defineCommand, ok } from "./define.js";

export const projectCreate = defineCommand({
  name: "project.create",
  positionals: ["id"],
  group: "project",
  summary: "Create a Project",
  input: z.object({
    id: slugSchema.describe("slug. Becomes the file name"),
    name: z.string().min(1).optional().describe("Display name. Defaults to id when omitted"),
    description: z.string().optional().describe("Description"),
    workflow: slugSchema.optional().describe("Default Workflow. Defaults to general when omitted"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const workflow = input.workflow ?? "general";
        if (!ctx.store.workflows.has(workflow))
          throw new OperationError("NOT_FOUND", `Workflow ${workflow} not found`);
        return ctx.store.create("project", {
          id: input.id,
          name: input.name ?? input.id,
          description: input.description ?? "",
          workflow,
          status: "active",
        });
      },
      { message: (doc) => `Project ${doc.id} を作成`, immediate: true },
    );
    return ok(result.value.data, result.write);
  },
});

export const projectList = defineCommand({
  name: "project.list",
  group: "project",
  summary: "List Projects",
  input: z.object({
    status: z.array(z.enum(PROJECT_STATUSES)).optional().describe("Filter by Status. Omit for all"),
  }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const docs = [...ctx.store.projects.values()]
      .filter((d) => !input.status || input.status.includes(d.data.status))
      .sort((a, b) => a.id.localeCompare(b.id));
    return ok(docs.map((d) => d.data));
  },
});

export const projectShow = defineCommand({
  name: "project.show",
  positionals: ["project"],
  group: "project",
  summary: "Show a Project and its ticket count",
  input: z.object({ project: slugSchema.describe("Project ID (slug)") }),
  write: false,
  needs: "store",
  async run(ctx, input) {
    const doc = ctx.store.requireProject(input.project);
    const tickets = [...ctx.store.tickets.values()].filter((t) => t.data.project === doc.id);
    return ok({ ...doc.data, ticket_count: tickets.length });
  },
});

export const projectArchive = defineCommand({
  name: "project.archive",
  positionals: ["project"],
  group: "project",
  summary: "Archive a Project. New tickets can no longer be created in it",
  input: z.object({ project: slugSchema.describe("Project ID (slug)") }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.requireProject(input.project);
        if (doc.data.status === "archived")
          throw new OperationError("REJECTED", `${doc.id} is already archived`);
        return ctx.store.update("project", doc.id, { status: "archived" });
      },
      { message: (doc) => `Project ${doc.id} をアーカイブ` },
    );
    return ok(result.value.data, result.write);
  },
});

export const projectCommands = [projectCreate, projectList, projectShow, projectArchive];
