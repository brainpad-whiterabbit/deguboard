// scripts/lib/gif.mjs（録画スクリプトの PNG の読み込みと GIF への書き出し）を、小さな画像で確かめる（t412）。
// GIF は自前の小さな読み取り（ブロックの走査と LZW の展開）で中身の画素の番号まで見る

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildPalette, checkGif, decodePng, encodeGif } from "../../scripts/lib/gif.mjs";

type Rgb = [number, number, number];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 1 行ごとのフィルタ（0〜4）を指定して PNG を組み立てる。pixels は行ごとの RGB */
function makePng(
  pixels: Rgb[][],
  { channels = 3, filters = [0], bitDepth = 8, alpha = 255 } = {},
): Buffer {
  const height = pixels.length;
  const width = pixels[0]!.length;
  const lines = pixels.map((row) =>
    Buffer.from(row.flatMap((p) => (channels === 4 ? [...p, alpha] : p))),
  );
  const stride = width * channels;
  const rows: Buffer[] = [];
  lines.forEach((line, y) => {
    const filter = filters[y % filters.length]!;
    const prev = y > 0 ? lines[y - 1]! : Buffer.alloc(stride);
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i + 1] = (line[i]! - pred) & 0xff;
    }
    rows.push(out);
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 縦横 w×h を fn(x, y) の色で塗った画像 */
const paint = (w: number, h: number, fn: (x: number, y: number) => Rgb): Rgb[][] =>
  Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => fn(x, y)));

interface GifFrame {
  delay: number;
  transparent: number | null;
  dispose: number;
  indices: Uint8Array;
}

/** gifenc が書く GIF（全コマが全面）を読む。LZW を展開して画素の番号を返す */
function readGif(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  const header = b.toString("latin1", 0, 6);
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  let pos = 13;
  if (b[10]! & 0x80) pos += 3 * 2 ** ((b[10]! & 7) + 1);
  const frames: GifFrame[] = [];
  let gce = { delay: 0, transparent: null as number | null, dispose: 0 };
  const subBlocks = () => {
    const parts: Buffer[] = [];
    for (;;) {
      const n = b[pos++]!;
      if (n === 0) break;
      parts.push(b.subarray(pos, pos + n));
      pos += n;
    }
    return Buffer.concat(parts);
  };
  while (pos < b.length) {
    const tag = b[pos++]!;
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      const label = b[pos++]!;
      const data = subBlocks();
      if (label === 0xf9) {
        gce = {
          delay: data.readUInt16LE(1) * 10,
          transparent: data[0]! & 1 ? data[3]! : null,
          dispose: (data[0]! >> 2) & 7,
        };
      }
    } else if (tag === 0x2c) {
      const flags = b[pos + 8]!;
      pos += 9;
      if (flags & 0x80) pos += 3 * 2 ** ((flags & 7) + 1);
      const minCode = b[pos++]!;
      frames.push({ ...gce, indices: lzwDecode(subBlocks(), minCode, width * height) });
    }
  }
  return { header, width, height, frames };
}

function lzwDecode(data: Buffer, minCode: number, count: number): Uint8Array {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const out: number[] = [];
  let table: number[][] = [];
  const reset = () => {
    table = Array.from({ length: eoi + 1 }, (_, i) => (i < clear ? [i] : []));
  };
  reset();
  let size = minCode + 1;
  let bits = 0;
  let acc = 0;
  let prev: number[] | null = null;
  for (const byte of data) {
    acc |= byte << bits;
    bits += 8;
    while (bits >= size) {
      const code = acc & ((1 << size) - 1);
      acc >>>= size;
      bits -= size;
      if (code === clear) {
        reset();
        size = minCode + 1;
        prev = null;
        continue;
      }
      if (code === eoi) return Uint8Array.from(out.slice(0, count));
      const entry: number[] = table[code] ?? [...prev!, prev![0]!];
      out.push(...entry);
      if (prev) table.push([...prev, entry[0]!]);
      prev = entry;
      if (table.length === 1 << size && size < 12) size++;
    }
  }
  return Uint8Array.from(out.slice(0, count));
}

describe("decodePng", () => {
  const image = paint(5, 4, (x, y) => [x * 40, y * 60, (x + y) * 20]);
  const expected = image.flatMap((row) => row.flatMap((p) => [...p, 255]));

  it.each([0, 1, 2, 3, 4])("RGB の PNG をフィルタ %i で読める", (filter) => {
    const { width, height, rgba } = decodePng(makePng(image, { filters: [filter] }));
    expect([width, height]).toEqual([5, 4]);
    expect([...rgba]).toEqual(expected);
  });

  it("RGBA の PNG も読め、透明度は不透明にそろえる", () => {
    const { rgba } = decodePng(makePng(image, { channels: 4, filters: [4, 3, 2, 1], alpha: 128 }));
    expect([...rgba]).toEqual(expected);
  });

  it("行ごとにフィルタが違っても読める", () => {
    const { rgba } = decodePng(makePng(image, { filters: [1, 2, 3, 4] }));
    expect([...rgba]).toEqual(expected);
  });

  it("8 bit でない PNG は読めないと伝える", () => {
    expect(() => decodePng(makePng(image, { bitDepth: 16 }))).toThrow("8 bit");
  });
});

describe("buildPalette", () => {
  it("255 色に画素を割り当て、256 色目の透明の番号は空ける", () => {
    const img = decodePng(makePng(paint(4, 4, (x) => [x * 60, 0, 0])));
    const { colors, palette } = buildPalette([img]);
    expect(colors).toHaveLength(255);
    expect(palette).toHaveLength(256);
    expect(palette[255]).toEqual([0, 0, 0]);
  });
});

describe("buildPalette の間引き", () => {
  it("13 コマ以上でも、間引きで落ちる位置にある最後のコマの色を見本に入れる", () => {
    // 26 コマだと間引きの幅は 2 で、最後（25）は幅では拾われず「必ず入れる」枝だけで入る
    const img = (rgb: Rgb) => decodePng(makePng(paint(4, 4, () => rgb)));
    const images = Array.from({ length: 26 }, (_, i) =>
      img(i === 25 ? [10, 200, 30] : [200, 0, 0]),
    );
    const { colors } = buildPalette(images);
    expect(colors.some(([r, g, b]) => g! > 150 && r! < 60 && b! < 80)).toBe(true);
  });
});

describe("encodeGif", () => {
  const BLACK: Rgb = [0, 0, 0];
  const RED: Rgb = [255, 0, 0];
  const w = 8;
  const h = 6;
  const png = (fn: (x: number, y: number) => Rgb) => makePng(paint(w, h, fn));
  const black = png(() => BLACK);
  const blackWithRed = png((x, y) => (x === 2 && y === 3 ? RED : BLACK));
  const redAll = png(() => RED);

  it("寸法・コマ数・コマの長さが入る", () => {
    const gif = readGif(
      encodeGif([
        { png: black, delay: 100 },
        { png: blackWithRed, delay: 250 },
      ]),
    );
    expect(gif.header).toBe("GIF89a");
    expect([gif.width, gif.height]).toEqual([w, h]);
    expect(gif.frames.map((f) => f.delay)).toEqual([100, 250]);
  });

  it("真っ黒の画素が透明の番号（255）に割り当たらない", () => {
    const gif = readGif(
      encodeGif([
        { png: black, delay: 100 },
        { png: blackWithRed, delay: 100 },
      ]),
    );
    const first = gif.frames[0]!;
    expect(first.transparent).toBeNull();
    expect(first.indices).toHaveLength(w * h);
    expect(first.indices.includes(255)).toBe(false);
  });

  it("2 コマ目は前と同じ画素を透明にし、変わった画素だけ色の番号を持つ", () => {
    const gif = readGif(
      encodeGif([
        { png: black, delay: 100 },
        { png: blackWithRed, delay: 100 },
      ]),
    );
    const second = gif.frames[1]!;
    expect(second.transparent).toBe(255);
    expect(gif.frames.map((f) => f.dispose)).toEqual([1, 1]);
    const changed = [...second.indices].flatMap((v, i) => (v === 255 ? [] : [i]));
    expect(changed).toEqual([3 * w + 2]);
  });

  it("前のコマと同じコマは足されず、前のコマの長さに足される", () => {
    const gif = readGif(
      encodeGif([
        { png: black, delay: 100 },
        { png: black, delay: 150 },
        { png: redAll, delay: 200 },
        { png: redAll, delay: 50 },
      ]),
    );
    expect(gif.frames.map((f) => f.delay)).toEqual([250, 250]);
  });
});

describe("checkGif", () => {
  const range: [number, number] = [6, 10];
  it("秒数が範囲に入り 1MB 以下なら合格", () => {
    expect(checkGif({ seconds: 8, bytes: 1024 * 1024, range })).toBe(true);
    expect(checkGif({ seconds: 6, bytes: 1, range })).toBe(true);
    expect(checkGif({ seconds: 10, bytes: 1, range })).toBe(true);
  });
  it("短すぎる・長すぎる・大きすぎるときは不合格", () => {
    expect(checkGif({ seconds: 5.9, bytes: 1, range })).toBe(false);
    expect(checkGif({ seconds: 10.1, bytes: 1, range })).toBe(false);
    expect(checkGif({ seconds: 8, bytes: 1024 * 1024 + 1, range })).toBe(false);
  });
});
