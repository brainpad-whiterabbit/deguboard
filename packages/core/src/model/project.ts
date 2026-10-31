// Project（projects/<slug>.yaml。requirements.md 5.3）

import { z } from "zod";
import { slugSchema } from "./common.js";

export const PROJECT_STATUSES = ["active", "archived"] as const;

export const projectSchema = z.looseObject({
  id: slugSchema,
  name: z.string().min(1),
  description: z.string().default(""),
  workflow: slugSchema,
  status: z.enum(PROJECT_STATUSES).default("active"),
});
export type Project = z.output<typeof projectSchema>;
