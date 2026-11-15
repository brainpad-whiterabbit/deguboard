import { mkdir, writeFile } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { commands, findCommand, openContext, runCommand, init } from "@deguboard/core";
import {
  createFixture,
  createLocalOnlyRepo,
  type Fixture,
} from "../../core/test/helpers/git-fixture.js";
import { describeCommands, guard } from "./app.js";
import { startServer, type RunningServer } from "./server.js";
import { readBody } from "./static.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fixture(): Promise<Fixture> {
  const f = await createFixture();
  cleanups.push(f.cleanup);
  return f;
}

async function serve(cwd: string, staticDir?: string): Promise<RunningServer> {
  const running = await startServer({ cwd, port: 0, staticDir, user: "ui" });
  cleanups.push(running.close);
  return running;
}

async function post(s: RunningServer, name: string, input: unknown) {
  const res = await fetch(`${s.url}api/commands/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** fetch は Host を差し替えられないので、node:http で頭を自由に付けて送る */
function raw(
  s: RunningServer,
  method: string,
  pathname: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: s.port, method, path: `/${pathname}`, headers: options.headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // 静的ファイルなど JSON でない応答は文字列のまま
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("HTTP サーバー", () => {
  it("GET /api/commands が store の要るコマンドの一覧と入力の JSON Schema を返す", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    const res = await fetch(`${s.url}api/commands`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Array<{ name: string; input: { properties: object } }>;
    };
    expect(body.data.map((c) => c.name)).toEqual(
      commands.filter((c) => c.needs === "store").map((c) => c.name),
    );
    const create = body.data.find((c) => c.name === "ticket.create")!;
    expect(Object.keys(create.input.properties)).toContain("title");
    expect(Object.keys(create.input.properties)).toContain("acceptance");
    expect(describeCommands(commands).some((c) => c.name === "init")).toBe(false);
  });

  it("store の要るコマンドの入力の JSON Schema の説明（.describe）に日本語の文字が出ない", () => {
    // MCP のツール定義と GET /api/commands はこの JSON Schema をそのまま出す。説明はエージェントが読む文字列なので英語にする
    const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
    // 本文で dg が読む見出しの名そのもの（データの値）は説明の中に出てよい
    const dataLiterals = ["## 受け入れ条件"];
    const found: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, `${where}[${i}]`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (
          key === "description" &&
          typeof value === "string" &&
          japanese.test(dataLiterals.reduce((text, literal) => text.replaceAll(literal, ""), value))
        ) {
          found.push(`${where}: ${value}`);
        }
        walk(value, `${where}.${key}`);
      }
    };
    const descriptors = describeCommands(commands);
    // 見直しの指摘のスキーマ（reviewFindingSchema）を入力に含むコマンドが範囲に入っていることを確かめる
    expect(descriptors.some((d) => d.name === "run.handoff")).toBe(true);
    for (const d of descriptors) walk(d.input, d.name);
    expect(found).toEqual([]);
  });

  it("POST /api/commands/<name> がコマンドを実行し、CLI の --json と同じ形を返す", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    const created = await post(s, "ticket.create", { title: "画面から", labels: ["ui"] });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      ok: true,
      data: { id: "t1", labels: ["ui"] },
      warnings: [],
      write: { pushed: true },
    });
    const claimed = await post(s, "ticket.claim", { ticket: "1" });
    expect(claimed.body.data).toMatchObject({ status: "in_progress", assignee: "ui" });
    // 画面の操作は常に人として扱われる（既定では遷移に制約がないので abandoned にもできる）
    const abandoned = await post(s, "ticket.move", { ticket: "t1", status: "abandoned" });
    expect(abandoned.body.data.status).toBe("abandoned");
  });

  it("エラーは HTTP の状態に写る：入力の誤り 400、見つからない 404、拒否 409、未知のコマンド 404", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    expect((await post(s, "ticket.create", { title: "" })).status).toBe(400);
    const missing = await post(s, "ticket.show", { ticket: "t99" });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    await post(s, "ticket.create", { title: "A" });
    // todo のチケットは unclaim できない
    const rejected = await post(s, "ticket.unclaim", { ticket: "t1" });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("TRANSITION_REJECTED");
    expect((await post(s, "ticket.nope", {})).status).toBe(404);
    expect((await post(s, "init", {})).status).toBe(404);
    const badJson = await fetch(`${s.url}api/commands/ticket.list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(badJson.status).toBe(400);
  });

  it("応答の文（JSON のエラーと、静的ファイルがないときの案内と 404）は英語で、日本語を含まない（CL-8・t948）", async () => {
    const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    const json = { "content-type": "application/json" };
    const badJson = await raw(s, "POST", "api/commands/ticket.list", { headers: json, body: "{" });
    expect(badJson.body.error).toEqual({
      code: "INVALID_JSON",
      message: "The request body is not JSON",
    });
    const missing = await raw(s, "GET", "api/nope");
    expect(missing.body.error).toEqual({ code: "NOT_FOUND", message: "No API at /api/nope" });
    const refused = [
      await raw(s, "GET", "", { headers: { host: "evil.example" } }),
      await raw(s, "GET", "", { headers: { origin: "null" } }),
      await raw(s, "POST", "api/commands/ticket.list", { body: "{}" }),
      await raw(s, "GET", "%"),
    ];
    for (const res of [badJson, missing, ...refused]) {
      expect(res.body.error.message).not.toMatch(japanese);
    }
    const landing = await raw(s, "GET", "");
    expect(landing.body).toBe(
      "deguboard server. The API is at /api/commands. The web screen is not served\n",
    );
    // 静的ファイルを配るときの 404（ルートの外）
    const web = path.join(f.root, "web");
    await mkdir(web, { recursive: true });
    const withWeb = await serve(f.cloneA, web);
    const outside = await raw(withWeb, "GET", "..%2F..%2Fetc%2Fpasswd");
    expect(outside).toEqual({ status: 404, body: "Not found\n" });
    // 大きすぎる本文の文（readBody）
    await expect(readBody(Readable.from([Buffer.alloc(8)]) as IncomingMessage, 4)).rejects.toThrow(
      "The request body is too large",
    );
  });

  it("本文が上限を超えた要求に、413 と英語の文の応答を返し、残りの本文を読み捨てて接続を使い続ける（t975）", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    const host = `127.0.0.1:${s.port}`;
    // 上限（4 MiB）を超える本文の要求と、同じ接続の次の要求を、送り終えてから読み始める。
    // 応答の直後にサーバーが接続を壊すと、送り終える前に RST で切られて書き込みが失敗する
    const big = 5 * 1024 * 1024;
    const next = JSON.stringify({ input: {} });
    const text = await new Promise<string>((resolve, reject) => {
      const socket = connect(s.port, "127.0.0.1", () => {
        socket.write(
          `POST /api/commands/ticket.list HTTP/1.1\r\nhost: ${host}\r\ncontent-type: application/json\r\ncontent-length: ${big}\r\n\r\n`,
        );
        socket.write(Buffer.alloc(big, 0x20));
        socket.write(
          `POST /api/commands/ticket.list HTTP/1.1\r\nhost: ${host}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(next)}\r\nconnection: close\r\n\r\n${next}`,
          (error) => {
            if (error) return reject(error);
            let received = "";
            socket.setEncoding("utf8");
            socket.on("data", (chunk: string) => (received += chunk));
            socket.on("end", () => resolve(received));
          },
        );
      });
      socket.on("error", reject);
    });
    // 1 つ目は 413 と英語の文、2 つ目は同じ接続で答えた 200（本文はどちらも chunked の 1 塊）
    const responses = [
      ...text.matchAll(/HTTP\/1\.1 (\d+) [^\r]*\r\n[\s\S]*?\r\n\r\n[0-9a-f]+\r\n(.*)\r\n/g),
    ];
    expect(responses.map((m) => Number(m[1]))).toEqual([413, 200]);
    expect(JSON.parse(responses[0]![2]!)).toEqual({
      ok: false,
      error: { code: "BODY_TOO_LARGE", message: "The request body is too large" },
    });
  });

  it("壊れた percent-encoding と URL として読めない要求先は、API と静的ファイルの両方で 400 を返し、プロセスは落ちない（t752）", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const web = path.join(f.root, "web");
    await mkdir(web, { recursive: true });
    await writeFile(path.join(web, "index.html"), "<!doctype html><title>deguboard</title>");
    const s = await serve(f.cloneA, web);
    // 壊れた percent-encoding：API の名前と静的ファイルの両方で 400
    const badApi = await raw(s, "POST", "api/commands/%E0%A4%A", {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(badApi.status).toBe(400);
    expect(badApi.body).toMatchObject({ ok: false, error: { code: "BAD_URL" } });
    expect((await raw(s, "GET", "assets/%E0%A4%A.js")).status).toBe(400);
    expect((await raw(s, "GET", "%")).status).toBe(400);
    // URL として読めない要求先（ポートが数でない）：400 で、プロセスは落ちない
    expect((await raw(s, "GET", "/a:b")).status).toBe(400);
    expect((await raw(s, "GET", "/a:b/api/commands")).status).toBe(400);
    // 後続の要求は普通に応答する
    expect((await fetch(`${s.url}api/status`)).status).toBe(200);
    expect(await (await fetch(`${s.url}`)).text()).toContain("<title>deguboard</title>");
  });

  it("Host の名前が localhost・IP そのもの・--host の名前でない要求と、別オリジン（Origin: null を含む）の要求を 403 で断り、config.set を書かない", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    const setEach = JSON.stringify({ input: { key: "commit.mode", value: "each" } });
    const json = { "content-type": "application/json" };
    // DNS rebinding：攻撃者の名前が 127.0.0.1 を指し、Host にはその名前が来る
    const rebound = await raw(s, "POST", "api/commands/config.set", {
      headers: { ...json, host: `evil.example:${s.port}` },
      body: setEach,
    });
    expect(rebound.status).toBe(403);
    expect(rebound.body).toMatchObject({ ok: false, error: { code: "FORBIDDEN_HOST" } });
    expect(rebound.body.error.message).toMatch(/^Refused a request for the host name/);
    expect((await raw(s, "GET", "", { headers: { host: "evil.example" } })).status).toBe(403);
    for (const origin of ["http://evil.example", `http://evil.example:${s.port}`, "null"]) {
      const cross = await raw(s, "POST", "api/commands/config.set", {
        headers: { ...json, origin },
        body: setEach,
      });
      expect(cross.status, origin).toBe(403);
      expect(cross.body.error.code, origin).toBe("FORBIDDEN_ORIGIN");
    }
    expect((await post(s, "config.show", {})).body.data.commit.mode).toBe("batch");
  });

  it("JSON でない POST を 415 で断り、config.set を書かない", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    const setEach = JSON.stringify({ input: { key: "commit.mode", value: "each" } });
    // フォームの送信や text/plain の fetch はプリフライトなしで別オリジンから送れる
    for (const type of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
      const res = await raw(s, "POST", "api/commands/config.set", {
        headers: type ? { "content-type": type } : {},
        body: setEach,
      });
      expect(res.status, type).toBe(415);
      expect(res.body.error.code, type).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    expect((await post(s, "config.show", {})).body.data.commit.mode).toBe("batch");
  });

  it("同じオリジンからの application/json と、ポートの違う Host と Origin の組（転送）は通る", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    const set = (value: string, headers: Record<string, string>) =>
      raw(s, "POST", "api/commands/config.set", {
        headers: { "content-type": "application/json; charset=utf-8", ...headers },
        body: JSON.stringify({ input: { key: "commit.mode", value } }),
      });
    const same = await set("each", { origin: `http://127.0.0.1:${s.port}` });
    expect(same.status).toBe(200);
    expect((await post(s, "config.show", {})).body.data.commit.mode).toBe("each");
    // vite の proxy やポートの転送では、Host と Origin のポートが待ち受けと違う
    const forwarded = await set("manual", {
      host: "localhost:5173",
      origin: "http://localhost:5173",
    });
    expect(forwarded.status).toBe(200);
    expect((await post(s, "config.show", {})).body.data.commit.mode).toBe("manual");
    expect((await raw(s, "GET", "api/status", { headers: { host: "[::1]:9999" } })).status).toBe(
      200,
    );
  });

  it("guard は --host で指定した名前を Host の名前として受け入れる", () => {
    const req = (host: string) => ({ method: "GET", headers: { host } }) as IncomingMessage;
    expect(guard(req("devbox:4173"), "devbox")).toBeUndefined();
    expect(guard(req("DevBox"), "devbox")).toBeUndefined();
    expect(guard(req("other:4173"), "devbox")?.code).toBe("FORBIDDEN_HOST");
    expect(guard(req("10.0.0.5:4173"), "devbox")).toBeUndefined();
  });

  it("他のプロセス（CLI）の変更をリクエストごとに取り込み、初期化前は 503", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    expect((await post(s, "ticket.list", {})).body.data).toEqual([]);
    const cli = await openContext({ cwd: f.cloneA });
    await runCommand(
      commands.find((c) => c.name === "ticket.create")!,
      cli,
      { title: "CLI から" },
    );
    expect((await post(s, "ticket.list", {})).body.data.map((t: { id: string }) => t.id)).toEqual([
      "t1",
    ]);

    const local = await createLocalOnlyRepo();
    cleanups.push(local.cleanup);
    const s2 = await serve(local.dir);
    expect((await post(s2, "ticket.list", {})).status).toBe(503);
  });

  it("GET /api/status が同期の状態を返し、静的ファイルは index.html に落ちる", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const web = path.join(f.root, "web");
    await mkdir(path.join(web, "assets"), { recursive: true });
    await writeFile(path.join(web, "index.html"), "<!doctype html><title>deguboard</title>");
    await writeFile(path.join(web, "assets", "app.js"), "console.log(1)");
    const s = await serve(f.cloneA, web);
    const status = (await (await fetch(`${s.url}api/status`)).json()) as {
      data: { ahead: number; dirty: boolean; issues: number };
    };
    expect(status.data).toMatchObject({ ahead: 0, dirty: false, issues: 0 });
    expect(await (await fetch(`${s.url}`)).text()).toContain("<title>deguboard</title>");
    expect(await (await fetch(`${s.url}tickets/t1`)).text()).toContain("<title>deguboard</title>");
    const js = await fetch(`${s.url}assets/app.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(`${s.url}..%2F..%2Fetc%2Fpasswd`)).status).toBe(404); // ルートの外は拒否する
    expect((await fetch(`${s.url}api/nope`)).status).toBe(404);
    expect(s.host).toBe("127.0.0.1");
  });

  it("POST /api/commands/flow.next はプロセス内で呼んだ dg flow next と同じ結果を返す", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    await post(s, "iteration.create", { name: "S1" });
    await post(s, "ticket.create", { title: "A" });
    await post(s, "iteration.add", { iteration: "s1", tickets: ["t1"] });
    const viaHttp = await post(s, "flow.next", { targets: ["s1"] });
    expect(viaHttp.status).toBe(200);
    expect(viaHttp.body.data.stage).toMatchObject({ name: "check", rule: 2 });
    const direct = await runCommand(
      findCommand("flow.next")!,
      await openContext({ cwd: f.cloneA }),
      {
        targets: ["s1"],
      },
    );
    expect(viaHttp.body.data).toEqual(direct.data);
  });

  it("POST /api/commands/next と brief は、役ごとの文をプロセス内で呼んだ dg と同じ結果で返す（t593）", async () => {
    const f = await fixture();
    await runCommand(init, await openContext({ cwd: f.cloneA, initialize: {} }), {});
    const s = await serve(f.cloneA);
    await post(s, "ticket.create", { title: "A" });
    const ctx = await openContext({ cwd: f.cloneA });
    const findings = "1. 直す指摘";
    const roles = ["implement", "review", "fix"] as const;
    const next = await post(s, "next", { ticket: "t1" });
    expect(next.status).toBe(200);
    expect(next.body.data).toEqual(
      (await runCommand(findCommand("next")!, ctx, { ticket: "t1" })).data,
    );
    for (const role of roles) {
      const input = { ticket: "t1", role, ...(role === "fix" ? { findings } : {}) };
      const viaHttp = await post(s, "brief", input);
      expect(viaHttp.status, role).toBe(200);
      expect(viaHttp.body.data.text, role).toContain("--- Steps: ");
      expect(viaHttp.body.data, role).toEqual(
        (await runCommand(findCommand("brief")!, ctx, input)).data,
      );
    }
  });
});
