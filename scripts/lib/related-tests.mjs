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

/**
 * 変えたファイル（changed）から回すテストを選ぶ。tests はリポジトリにあるテストファイルの一覧（ルートからの / 区切りのパス）。
 * 変えたテストファイルと、変えたソースのファイルと名前で対になるテスト（同じディレクトリの <名前>.test.ts(x) と、
 * test/ の下の <名前>.test.ts）を返す。対になるテストがないソースのファイルは unpaired に返す
 */
export function selectRelatedTests(changed, tests) {
  const testSet = new Set(tests);
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
        (test.startsWith("test/") && test.endsWith(`/${name}.test.ts`)),
    );
    if (paired.length === 0) unpaired.push(file);
    for (const test of paired) selected.add(test);
  }
  return { tests: [...selected].sort(), unpaired };
}
