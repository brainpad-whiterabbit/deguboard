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
  summary: "Project を作る",
  input: z.object({
    id: slugSchema.describe("slug。ファイル名になる"),
    name: z.string().min(1).optional().describe("表示名。省略時は id"),
    description: z.string().optional(),
    workflow: slugSchema.optional().describe("既定の Workflow。省略時は general"),
  }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const workflow = input.workflow ?? "general";
        if (!ctx.store.workflows.has(workflow))
          throw new OperationError("NOT_FOUND", `Workflow ${workflow} が見つからない`);
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
  summary: "Project を出す",
  input: z.object({ status: z.array(z.enum(PROJECT_STATUSES)).optional() }),
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
  summary: "Project とチケットの件数を出す",
  input: z.object({ project: slugSchema }),
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
  summary: "Project をアーカイブする。新しいチケットを作れなくなる",
  input: z.object({ project: slugSchema }),
  write: true,
  needs: "store",
  async run(ctx, input) {
    const result = await withWrite(
      ctx,
      async () => {
        const doc = ctx.store.requireProject(input.project);
        if (doc.data.status === "archived")
          throw new OperationError("REJECTED", `${doc.id} は既にアーカイブ済み`);
        return ctx.store.update("project", doc.id, { status: "archived" });
      },
      { message: (doc) => `Project ${doc.id} をアーカイブ` },
    );
    return ok(result.value.data, result.write);
  },
});

export const projectCommands = [projectCreate, projectList, projectShow, projectArchive];
