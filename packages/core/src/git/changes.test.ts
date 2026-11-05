import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixture,
  createLocalOnlyRepo,
  git,
  openRepo,
  type Fixture,
} from "../../test/helpers/git-fixture.js";
import {
  listBranchChanges,
  mergeChanges,
  parseNameStatus,
  parseNumstat,
  readChangedFile,
} from "./changes.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

async function put(dir: string, file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content);
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", message]);
}

describe("git の出力の読み取り", () => {
  it("name-status の -z を、名前の変更と空白・日本語のパスも含めて読む", () => {
    const out = [
      "A",
      "新しい ファイル.md",
      "M",
      "src/a.ts",
      "D",
      "old.txt",
      "R087",
      "x y.ts",
      "z.ts",
      "",
    ].join("\0");
    expect(parseNameStatus(out)).toEqual([
      { kind: "added", path: "新しい ファイル.md", old_path: null },
      { kind: "modified", path: "src/a.ts", old_path: null },
      { kind: "deleted", path: "old.txt", old_path: null },
      { kind: "renamed", path: "z.ts", old_path: "x y.ts" },
    ]);
  });

  it("numstat の -z を、名前の変更とバイナリ（-）も含めて読み、name-status と突き合わせる", () => {
    const out = ["3\t1\tsrc/a.ts", "-\t-\timg.png", "2\t0\t", "x y.ts", "z.ts", ""].join("\0");
    const numbers = parseNumstat(out);
    expect(numbers).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "img.png", additions: null, deletions: null },
      { path: "z.ts", additions: 2, deletions: 0 },
    ]);
    const merged = mergeChanges(
      [
        { kind: "modified", path: "src/a.ts", old_path: null },
        { kind: "added", path: "img.png", old_path: null },
        { kind: "renamed", path: "z.ts", old_path: "x y.ts" },
      ],
      numbers,
    );
    expect(merged.map((f) => [f.path, f.additions, f.deletions, f.binary])).toEqual([
      ["src/a.ts", 3, 1, false],
      ["img.png", null, null, true],
      ["z.ts", 2, 0, false],
    ]);
  });
});

describe("作業ブランチの変更", () => {
  /** main にファイルを置き、作業ブランチ feat/x で追加・変更・削除・名前の変更・バイナリを作る */
  async function prepare(f: Fixture) {
    const a = f.cloneA;
    await put(a, "keep.txt", "1\n2\n3\n");
    await put(a, "gone.txt", "消す\n");
    await put(a, "名前 前.txt", "同じ中身の行\nもう 1 行\nさらに 1 行\n");
    await commitAll(a, "main の土台");
    await git(a, ["push", "-q", "origin", "main"]);
    await git(a, ["switch", "-qc", "feat/x"]);
    await put(a, "keep.txt", "1\n2 変えた\n3\n4\n");
    await git(a, ["rm", "-q", "gone.txt"]);
    await git(a, ["mv", "名前 前.txt", "名前 後.txt"]);
    await put(a, "dir/新しい.md", "足した\n");
    await put(a, "img.bin", Buffer.from([0, 1, 2, 3]));
    await commitAll(a, "作業");
    await git(a, ["switch", "-q", "main"]);
    // main が進んでも、作業ブランチの merge-base からの変更だけを出す（PR と同じ）
    await put(a, "main-only.txt", "main だけ\n");
    await commitAll(a, "main だけの変更");
    await git(a, ["push", "-q", "origin", "main"]);
  }

  it("ローカルのブランチの変更を、種類と行数つきで merge-base から出す", async () => {
    const f = await fixture();
    await prepare(f);
    const { repo } = await openRepo(f.cloneA);
    const r = await listBranchChanges(repo, "feat/x");
    expect(r.base_ref).toBe("origin/main");
    expect(r.head_ref).toBe("feat/x");
    expect(r.files).toEqual([
      {
        kind: "added",
        path: "dir/新しい.md",
        old_path: null,
        additions: 1,
        deletions: 0,
        binary: false,
      },
      {
        kind: "deleted",
        path: "gone.txt",
        old_path: null,
        additions: 0,
        deletions: 1,
        binary: false,
      },
      {
        kind: "added",
        path: "img.bin",
        old_path: null,
        additions: null,
        deletions: null,
        binary: true,
      },
      {
        kind: "modified",
        path: "keep.txt",
        old_path: null,
        additions: 2,
        deletions: 1,
        binary: false,
      },
      {
        kind: "renamed",
        path: "名前 後.txt",
        old_path: "名前 前.txt",
        additions: 0,
        deletions: 0,
        binary: false,
      },
    ]);
  });

  it("片側の中身を読み、ない側は空、バイナリは中身を出さない", async () => {
    const f = await fixture();
    await prepare(f);
    const { repo } = await openRepo(f.cloneA);
    expect(await readChangedFile(repo, "feat/x", "base", "keep.txt")).toMatchObject({
      exists: true,
      binary: false,
      text: "1\n2\n3\n",
    });
    const head = await readChangedFile(repo, "feat/x", "head", "keep.txt");
    expect(head.text).toBe("1\n2 変えた\n3\n4\n");
    // 一覧で読んだコミットを渡せば同じものを読み、違えば断る
    const listed = await listBranchChanges(repo, "feat/x");
    expect(listed.head_commit).toBe(head.commit);
    expect(
      (await readChangedFile(repo, "feat/x", "base", "keep.txt", listed.base_commit)).text,
    ).toBe("1\n2\n3\n");
    await expect(
      readChangedFile(repo, "feat/x", "head", "keep.txt", listed.base_commit),
    ).rejects.toMatchObject({ code: "REJECTED" });
    // 追加の左と削除の右は空
    expect(await readChangedFile(repo, "feat/x", "base", "dir/新しい.md")).toMatchObject({
      exists: false,
      text: "",
    });
    expect(await readChangedFile(repo, "feat/x", "head", "gone.txt")).toMatchObject({
      exists: false,
      text: "",
    });
    // main だけに足したファイルは merge-base にないので、左にも出ない
    expect((await readChangedFile(repo, "feat/x", "base", "main-only.txt")).exists).toBe(false);
    expect(await readChangedFile(repo, "feat/x", "head", "img.bin")).toMatchObject({
      exists: true,
      binary: true,
      text: "",
    });
  });

  it("リモートにだけあるブランチは fetch せずに追跡ブランチで比べ、ローカルが先ならローカルを使う", async () => {
    const f = await fixture();
    await prepare(f);
    await git(f.cloneA, ["push", "-q", "origin", "feat/x"]);
    await git(f.cloneB, ["fetch", "-q", "origin"]);
    const b = await openRepo(f.cloneB);
    const before = await git(f.cloneB, ["for-each-ref"]);
    const r = await listBranchChanges(b.repo, "feat/x");
    expect(r.head_ref).toBe("origin/feat/x");
    expect(r.files).toHaveLength(5);
    // 読むだけで、ref を足さない・動かさない
    expect((await git(f.cloneB, ["for-each-ref"])).stdout).toBe(before.stdout);
    // ローカルがリモートより先なら、ローカルの方を出す
    await git(f.cloneA, ["switch", "-q", "feat/x"]);
    await put(f.cloneA, "more.txt", "未 push\n");
    await commitAll(f.cloneA, "未 push の作業");
    const a = await openRepo(f.cloneA);
    const ahead = await listBranchChanges(a.repo, "feat/x");
    expect(ahead.head_ref).toBe("feat/x");
    expect(ahead.files.map((x) => x.path)).toContain("more.txt");
  });

  it("ローカルにもリモートにもないブランチは理由つきの NOT_FOUND にする", async () => {
    const f = await fixture();
    const { repo } = await openRepo(f.cloneA);
    await expect(listBranchChanges(repo, "feat/none")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/feat\/none.*dg sync/),
    });
    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    await git(local.dir, ["commit", "-q", "--allow-empty", "-m", "最初"]);
    const opened = await openRepo(local.dir, { remote: null });
    await expect(listBranchChanges(opened.repo, "feat/none")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("リモートがない"),
    });
  });
});
