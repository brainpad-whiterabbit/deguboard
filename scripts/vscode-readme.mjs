// ルートの README.md の「Other ways to use it」より前を packages/vscode/README.md に書き出す。mise run vsix（packages/vscode の package script）から呼ぶ（t429）。
// 書き出した README は git の管理に入れない（.gitignore）

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionReadme } from "./lib/vscode-readme.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = extensionReadme(await readFile(path.join(root, "README.md"), "utf8"));
await writeFile(path.join(root, "packages", "vscode", "README.md"), text);
