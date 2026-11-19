// mise run test:related（scripts/test-related.mjs）が回すテストを、変えたファイルとテストファイルの一覧から選ぶ。
// git もファイルも読まない。振る舞いは test/scripts/related-tests.test.ts が確かめる（t1127）。
// import をたどらず名前だけで選ぶのは、vitest の --changed が import の木をたどると、core のコマンドを 1 つ変えただけで
// CLI・HTTP・画面のテストまで数百本を回し、作業の途中の確かめに数分かかったため。名前で選ばれないテスト（import で
// 関わるもの）は、push の前の dg gate <id> --only check の全体のテストが見る

/**
 * test:related の実行の印に vitest へ渡す環境変数。vitest.workers.ts の isRelatedRun が見てワーカー数を決める。
 * vitest.config.ts は DEGUBOARD_ の変数を外すが DEGUBOARD_TEST_ は残すので、この接頭辞にする
 */
export const RELATED_ENV = "DEGUBOARD_TEST_RELATED";

/** vitest.config.ts の include に当たるテストファイルか */
export function isTestFile(file) {
  return /^packages\/[^/]+\/src\/.+\.test\.tsx?$/.test(file) || /^test\/.+\.test\.ts$/.test(file);
}

/** 名前で対になるテストを探すソースのファイルか（型の宣言だけのファイルは除く） */
export function isSourceFile(file) {
  return /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) && !/\.d\.[mc]?ts$/.test(file);
}

/** 拡張子を除いたパス（a/b/foo.ts → a/b/foo） */
function stem(file) {
  return file.replace(/\.[^./]+$/, "");
}

/**
 * 変えたファイル（changed）から回すテストを選ぶ。tests はリポジトリにあるテストファイルの一覧、sources はソースのファイルの
 * 一覧（どちらもルートからの / 区切りのパス）。変えたテストファイルと、変えたソースのファイルと名前で対になるテスト
 * （同じディレクトリの <名前>.test.ts(x)、同じディレクトリの <名前>-*.test.ts(x) のうち同じ名前のソースを持たないもの、
 * test/ の下の <名前>.test.ts）を返す。対になるテストがないソースのファイルは unpaired に返す。
 * <名前>-*.test.ts(x) を選ぶのは、flow-permission.test.ts のように 1 つのソースのテストを分けたファイルがあるため。
 * hook-settings.test.ts のように hook-settings.ts を持つものは、そのソースの対なので hook.ts では選ばない
 */
export function selectRelatedTests(changed, tests, sources) {
  const testSet = new Set(tests);
  const sourceStems = new Set(sources.filter(isSourceFile).map(stem));
  const selected = new Set();
  const unpaired = [];
  for (const file of changed) {
    if (isTestFile(file)) {
      if (testSet.has(file)) selected.add(file);
      continue;
    }
    if (!isSourceFile(file)) continue;
    const slash = file.lastIndexOf("/");
    const dir = slash === -1 ? "" : file.slice(0, slash + 1);
    const name = file.slice(slash + 1).replace(/\.[^.]+$/, "");
    const paired = tests.filter(
      (test) =>
        test === `${dir}${name}.test.ts` ||
        test === `${dir}${name}.test.tsx` ||
        (test.startsWith("test/") && test.endsWith(`/${name}.test.ts`)) ||
        isSplitTest(test, `${dir}${name}-`, sourceStems),
    );
    if (paired.length === 0) unpaired.push(file);
    for (const test of paired) selected.add(test);
  }
  return { tests: [...selected].sort(), unpaired };
}

/**
 * test:related が「回す・知らせる・何もしない」のどれにするかを決める。changed は分岐点からの差分と未追跡のファイル
 * （消したファイルを含む）、files は今あるファイル（追跡しているものと未追跡のもの）の一覧。消したファイルは回せないので、
 * files にない changed を外してから選ぶ。messages は標準エラーに 1 行ずつ出す知らせで、tests が空なら vitest を起動せずに
 * 成功で終わる。振る舞いは test/scripts/related-tests.test.ts が確かめる（t1132）
 */
export function planRelatedRun(changed, files) {
  const present = new Set(files);
  const selected = selectRelatedTests(
    changed.filter((file) => present.has(file)),
    files.filter(isTestFile),
    files.filter(isSourceFile),
  );
  const messages = [];
  if (selected.unpaired.length > 0) {
    messages.push(
      `test:related: no name-paired test for ${selected.unpaired.join(", ")} (the full tests in dg gate <id> --only check cover them)`,
    );
  }
  if (selected.tests.length === 0) messages.push("test:related: no related tests to run");
  return { tests: selected.tests, messages };
}

/** test が prefix で始まる同じディレクトリの <名前>-*.test.ts(x) で、同じ名前のソースを持たないか */
function isSplitTest(test, prefix, sourceStems) {
  const match = /^(.+)\.test\.tsx?$/.exec(test);
  if (!match || !test.startsWith(prefix)) return false;
  const testStem = match[1];
  return !testStem.slice(prefix.length).includes("/") && !sourceStems.has(testStem);
}
