// 画面がコマンドを 1 本読んで状態に持つためのフック（useCommandData）。詳細・Run・経過・履歴など、一覧（store.tsx）の外で読むものに使う。
// 一覧（store.tickets）が読み直されるたび（書き込み・同期のあと）と、入力が変わったときに読み直す。
// 読み直す間は前の結果を出したままにし、成功したら結果と警告を入れてエラーを消し、失敗したらエラーだけを入れる（前の結果と警告は残す）。
// 古い読み込み（入力が変わった・画面を離れた）の結果は捨てる。
// 2 本を並べて読む・始めに前の結果を消す・失敗を通知に出すなど、形の違う読み込みはこのフックを使わず、使わない理由をその場所に書く

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useStore } from "./store.js";

export interface CommandData<O> {
  /** 読み終えるまでは null */
  data: O | null;
  /** 最後に成功した読み込みの警告 */
  warnings: string[];
  /** 最後の読み込みが失敗した理由。成功したら null に戻す */
  error: string | null;
  /** 書き込みの結果を、読み直しを待たずに入れる */
  setData: Dispatch<SetStateAction<O | null>>;
}

/**
 * name のコマンドを input で読む。input が null のあいだは読まない。
 * input は JSON にして比べるので、描画のたびに作り直したオブジェクトでよい。
 * also を渡すと、それが変わったときにも読み直す（一覧のほかに Epic・Iteration の読み直しを待つときなど）
 */
export function useCommandData<O>(
  name: string,
  input: object | null,
  also?: unknown,
): CommandData<O> {
  const { client, tickets } = useStore();
  const [data, setData] = useState<O | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = input === null ? null : JSON.stringify(input);
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    client
      .run<O>(name, JSON.parse(key))
      .then((r) => {
        if (!alive) return;
        setData(r.data);
        setWarnings(r.warnings);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [client, name, key, tickets, also]);
  return { data, warnings, error, setData };
}
