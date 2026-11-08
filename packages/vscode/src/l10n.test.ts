import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { approvalMessage, viewTitle } from "./approvals.js";
import { dgAdvice } from "./dg.js";
import { type Bundle, bundleTranslator, format, setTranslator, t } from "./l10n.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = <T>(relative: string): T =>
  JSON.parse(readFileSync(resolve(packageDir, relative), "utf8")) as T;

const enBundle = readJson<Bundle>("l10n/bundle.l10n.json");
const jaBundle = readJson<Bundle>("l10n/bundle.l10n.ja.json");
const nlsEn = readJson<Record<string, string>>("package.nls.json");
const nlsJa = readJson<Record<string, string>>("package.nls.ja.json");

/** 日本語の文字（かな・漢字・全角の記号。「・」「（」「、」なども含む） */
const JAPANESE = /[　-ヿ一-鿿＀-￯]/;

/**
 * 拡張ホストのソース（テストを除く）の、コメントを除いた行。行頭の //・/*・* の行と、行の途中の「 // 」から後ろを落とす。
 * 文字列の中の「 // 」も落とすので、文言に「 // 」を入れない（日本語の直書きが隠れるだけで、鍵の取りこぼしは bundle との突き合わせで見つかる）
 */
function sourceCode(): { file: string; code: string }[] {
  return readdirSync(resolve(packageDir, "src"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map((file) => {
      const code = readFileSync(resolve(packageDir, "src", file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .map((line) => line.replace(/\s\/\/\s.*$/, ""))
        .join("\n");
      return { file, code };
    });
}

/** ソースの t("...") の鍵。鍵は文字列リテラルで書く約束（l10n.ts） */
function sourceKeys(): Set<string> {
  const keys = new Set<string>();
  for (const { code } of sourceCode()) {
    for (const m of code.matchAll(/\bt\(\s*("(?:[^"\\]|\\.)*")/g)) {
      keys.add(JSON.parse(m[1]!) as string);
    }
  }
  return keys;
}

/** 文の中の {0}・{1} の並び */
const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();

afterEach(() => {
  // 既定（鍵をそのまま出す）に戻す
  setTranslator((message, ...args) => format(message, args));
});

describe("t と訳の表", () => {
  it("差し込む前は鍵（英語）を {0} を埋めて出す", () => {
    expect(t("Copied {0}", "t12")).toBe("Copied t12");
    expect(format("{0} and {1} more", ["a"])).toBe("a and {1} more");
  });
  it("訳の表を差し込むとその言語で出し、表にない鍵は鍵のまま出す", () => {
    setTranslator(bundleTranslator(jaBundle));
    expect(t("Copied {0}", "t12")).toBe("t12 をコピーした");
    expect(t("not in bundle {0}", 1)).toBe("not in bundle 1");
  });
  it("英語では通知とホバーが英語で出る", () => {
    expect(viewTitle(3)).toBe("Awaiting Approval/Review 3");
    expect(
      approvalMessage([
        { kind: "plan", id: "p58" },
        { kind: "ticket", id: "t1" },
        { kind: "ticket", id: "t2" },
      ]),
    ).toBe("deguboard: New items awaiting approval or review (Plan p58, t1 and 1 more)");
    expect(dgAdvice({ kind: "missing" }, "1.0.0")?.text).toMatch(/^dg is not on your PATH\./);
  });
});

describe("拡張ホストの文言の置き場所", () => {
  it("t の鍵は文字列リテラルで書く（変数やテンプレートの鍵は bundle との突き合わせから漏れるため）", () => {
    // setTranslator に渡す vscode.l10n.t(message, ...) は鍵を中継するだけなので、前が「.」の呼び出しは除く。l10n.ts の t の定義も除く
    const found = sourceCode().flatMap(({ file, code }) =>
      [...code.matchAll(/(?<![\w.$])(?<!function )t\(\s*[^"\s]/g)].map((m) => `${file}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });
  it("ソースの鍵と bundle.l10n.json・bundle.l10n.ja.json の鍵が過不足なく揃う", () => {
    const keys = [...sourceKeys()].sort();
    expect(keys.length).toBeGreaterThan(0);
    expect(Object.keys(enBundle).sort()).toEqual(keys);
    expect(Object.keys(jaBundle).sort()).toEqual(keys);
  });
  it("bundle.l10n.json は鍵そのもの（鍵が英語の文）で、日本語の訳は {0} の並びを保つ", () => {
    for (const [key, value] of Object.entries(enBundle)) expect(value).toBe(key);
    for (const [key, value] of Object.entries(jaBundle)) {
      expect(placeholders(value), key).toEqual(placeholders(key));
      expect(value, key).toMatch(JAPANESE);
    }
  });
  it("コメントを除いたソースに日本語の文言を直書きしない", () => {
    const found = sourceCode().flatMap(({ file, code }) =>
      code
        .split("\n")
        .filter((line) => JAPANESE.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });
});

/** 英語の文言にする前（日本語の直書きだったとき）の manifest の文言。表示言語が日本語なら今と同じに出ることを確かめる */
const MANIFEST_JA_BEFORE: Record<string, string> = {
  description:
    "AI エージェントに仕事を任せるためのカンバン。小さなチケットに分けて並列に進め、その働きを測れます。",
  "command.gotoTicket.title": "チケットへ移動",
  "command.sync.title": "同期",
  "command.config.title": "設定",
  "command.ask.title": "エージェントに頼む",
  "command.askInSidebar.title": "エージェントに頼む",
  "command.backlog.openTicket.title": "詳細を開く",
  "command.backlog.copyId.title": "ID をコピー",
  "walkthrough.start.title": "deguboard を始める",
  "walkthrough.start.description":
    "リポジトリの初期化から、チケットを起こしてエージェントに頼むまで。",
  "walkthrough.start.init.title": "リポジトリを初期化する",
  "walkthrough.start.init.description": "`dg init` を実行して、チケットを置く場所を作ります。",
  "walkthrough.start.ticket.title": "チケットを起こす",
  "walkthrough.start.ticket.description": "やりたいことを 1 件のチケットにします。",
  "walkthrough.start.agent.title": "エージェントに頼む",
  "walkthrough.start.agent.description": "Skill を入れ、依頼文を作ってコピーします。",
  "capabilities.untrustedWorkspaces.description":
    "deguboard はワークスペースのリポジトリで git を実行します。リポジトリの git の設定（core.fsmonitor など）は任意のコマンドを実行させ得るため、信頼していないフォルダー（制限モード）では動きません。",
  "capabilities.virtualWorkspaces.description":
    "deguboard はローカルのファイルシステムと git のコマンドを使うため、仮想ワークスペースでは動きません。",
};

/** manifest の中の文字列を、場所（JSON のパス）つきで並べる */
function manifestStrings(value: unknown, at = ""): { at: string; text: string }[] {
  if (typeof value === "string") return [{ at, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => manifestStrings(v, `${at}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => manifestStrings(v, at ? `${at}.${k}` : k));
  }
  return [];
}

describe("manifest の文言の置き場所", () => {
  const strings = manifestStrings(readJson<unknown>("package.json"));
  const used = strings.flatMap(({ text }) => {
    const m = /^%([\w.-]+)%$/.exec(text);
    return m ? [m[1]!] : [];
  });

  it("package.json の %鍵% は package.nls.json と package.nls.ja.json に過不足なくある", () => {
    expect(new Set(used).size).toBe(used.length);
    expect(Object.keys(nlsEn).sort()).toEqual([...used].sort());
    expect(Object.keys(nlsJa).sort()).toEqual([...used].sort());
  });
  it("package.json に日本語の文言を直書きしない（検索の語の keywords は除く）", () => {
    const found = strings.filter(
      ({ at, text }) => !at.startsWith("keywords") && JAPANESE.test(text),
    );
    expect(found).toEqual([]);
  });
  it("package.nls.json（既定）は英語で、表示言語が日本語なら package.nls.ja.json が今までと同じ文言を出す", () => {
    for (const [key, value] of Object.entries(nlsEn)) expect(value, key).not.toMatch(JAPANESE);
    const entries = Object.entries(nlsJa);
    const isMarkdown = ([key]: [string, string]) => key.endsWith(".markdown");
    expect(Object.fromEntries(entries.filter((e) => !isMarkdown(e)))).toEqual(MANIFEST_JA_BEFORE);
    // Walkthrough の本文は言語ごとのファイルを指す
    for (const [key, path] of entries.filter(isMarkdown)) {
      expect(path, key).toMatch(/\.ja\.md$/);
      expect(nlsEn[key], key).toBe(path.replace(/\.ja\.md$/, ".md"));
      expect(existsSync(resolve(packageDir, path)), path).toBe(true);
      expect(existsSync(resolve(packageDir, nlsEn[key]!)), nlsEn[key]).toBe(true);
    }
  });
});
