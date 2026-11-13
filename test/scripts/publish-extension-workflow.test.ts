// .github/workflows/publish-extension.yml（Release の VSIX を Marketplace と Open VSX に出す）の約束を確かめる（t866）。
// このワークフローは秘密と OIDC のトークンを持つので、きっかけ・step・秘密・権限が広がる変更をここで止める。
// build と検査を回さないのは、出すのが手元で検査を通して作り Release に添付した VSIX そのものだから（ADR-008）

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseYamlValue } from "../../packages/core/src/storage/yaml.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = path.join(root, ".github", "workflows", "publish-extension.yml");
const text = readFileSync(workflowPath, "utf8");

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { if?: string; permissions?: Record<string, string>; steps: Step[] };
type Workflow = { on: unknown; permissions: unknown; jobs: Record<string, Job> };

const { value, errors } = parseYamlValue(text);
const workflow = value as Workflow;

/** step の run のうち、build・検査・VSIX の作成に当たるものを返す */
function forbiddenRuns(steps: Step[]): string[] {
  const patterns = [
    /\bmise\s+run\b/, // mise run check・build・vsix などのタスク
    /\bpnpm\s+(run\s+)?(build|check|test|lint|typecheck|vsix|package)\b/,
    /\bpnpm\s+(-r|--recursive)\b/,
    /\bvsce\s+package\b/,
    /\b(tsc|vitest|oxlint|oxfmt)\b/,
  ];
  return steps
    .map((step) => step.run ?? "")
    .filter((run) => patterns.some((pattern) => pattern.test(run)));
}

describe("公開のワークフロー（publish-extension.yml）", () => {
  it("YAML として読める", () => {
    expect(errors).toEqual([]);
    expect(Object.keys(workflow.jobs).sort()).toEqual(["marketplace", "open-vsx"]);
  });

  it("きっかけは Release の published だけで、どの job も pre-release の Release では走らない", () => {
    expect(workflow.on).toEqual({ release: { types: ["published"] } });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe("${{ !github.event.release.prerelease }}");
    }
  });

  it("どの step も build・検査・VSIX の作成を回さない", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(forbiddenRuns(job.steps), name).toEqual([]);
      // 使う action は checkout と mise の用意だけ（他の action が build や検査を回さないように）
      const actions = job.steps.flatMap((step) => (step.uses ? [step.uses.split("@")[0]] : []));
      expect(actions, name).toEqual(["actions/checkout", "jdx/mise-action"]);
      // 依存を入れる step は、依存のスクリプト（prepare などの build）を走らせない
      const installs = job.steps.filter((step) => /\bpnpm\s+install\b/.test(step.run ?? ""));
      expect(installs.length, name).toBe(1);
      expect(installs[0]?.run, name).toContain("--ignore-scripts");
    }
  });

  it("build・検査・VSIX の作成に当たる run を見分ける（検査そのものの確かめ）", () => {
    const runs = [
      "mise run check",
      "pnpm run build",
      "pnpm build",
      "pnpm -r exec tsc",
      "pnpm --filter deguboard exec vsce package",
    ];
    expect(forbiddenRuns(runs.map((run) => ({ run })))).toEqual(runs);
    const allowed = [
      "pnpm install --frozen-lockfile --ignore-scripts --filter deguboard",
      'pnpm --filter deguboard exec vsce publish --oidc --packagePath "$RUNNER_TEMP/deguboard-vscode.vsix"',
      'pnpm --filter deguboard exec ovsx publish "$RUNNER_TEMP/deguboard-vscode.vsix"',
    ];
    expect(forbiddenRuns(allowed.map((run) => ({ run })))).toEqual([]);
  });

  it("使う秘密は OVSX_PAT だけで、Open VSX の job だけが持つ", () => {
    const secrets = [...text.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect([...new Set(secrets)]).toEqual(["OVSX_PAT"]);
    expect(text).not.toMatch(/secrets\s*:\s*inherit/);
    expect(text).not.toMatch(/secrets\[/);
    const holders = Object.entries(workflow.jobs)
      .filter(([, job]) => JSON.stringify(job).includes("secrets.OVSX_PAT"))
      .map(([name]) => name);
    expect(holders).toEqual(["open-vsx"]);
  });

  it("既定の権限は空で、id-token: write は Marketplace の job だけにある", () => {
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.marketplace?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(workflow.jobs["open-vsx"]?.permissions).toEqual({ contents: "read" });
  });
});
