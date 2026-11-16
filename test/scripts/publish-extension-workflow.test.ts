// .github/workflows/publish-extension.yml（Release の VSIX を Marketplace に出す）の約束を確かめる（t866）。
// このワークフローは公開に使う OIDC のトークンを持つので、きっかけ・step・秘密・権限が広がる変更をここで止める。
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
    // スクリプト名の前に --filter <名前> などの option があっても見分ける
    /\bpnpm\b(\s+-\S+(\s+[^-\s]\S*)?)*\s+(run\s+)?(build|check|test|lint|typecheck|vsix|package)\b/,
    /\bpnpm\s+(-r|--recursive)\b/,
    /\bnpm\s+(run(-script)?|test)\b/,
    /\bnpx\b/,
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
    expect(Object.keys(workflow.jobs).sort()).toEqual(["marketplace"]);
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
      "pnpm --filter deguboard-vscode exec vsce package",
      "pnpm --filter deguboard-vscode run build",
      "pnpm --filter deguboard-vscode build",
      "npm run build",
      "npx vsce package",
    ];
    expect(forbiddenRuns(runs.map((run) => ({ run })))).toEqual(runs);
    const allowed = [
      "pnpm install --frozen-lockfile --ignore-scripts --filter deguboard-vscode",
      'pnpm --filter deguboard-vscode exec vsce publish --oidc --packagePath "$RUNNER_TEMP/deguboard-vscode.vsix"',
    ];
    expect(forbiddenRuns(allowed.map((run) => ({ run })))).toEqual([]);
  });

  it("secret を使わない（Marketplace へは OIDC のトークンだけで出す）", () => {
    expect(text).not.toMatch(/\bsecrets\b/);
  });

  it("既定の権限は空で、Marketplace の job は contents: read と id-token: write だけを持つ", () => {
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.marketplace?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
  });
});
