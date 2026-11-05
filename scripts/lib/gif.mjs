// scripts/record-gifs.mjs の PNG の読み込みと GIF への書き出し。test/scripts/gif.test.ts が小さな画像で確かめる（t412）

import { inflateSync } from "node:zlib";
import * as gifencModule from "gifenc";

// gifenc は CommonJS で、素の node では default に、vitest（vite）では名前つきの export に出るので、どちらでも取れるようにする
const gifenc = gifencModule.quantize ? gifencModule : gifencModule.default;
const { GIFEncoder, applyPalette, quantize } = gifenc;

/** Playwright の PNG（8 bit の RGB か RGBA、インターレースなし）を RGBA の画素に戻す */
export function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0)
        throw new Error("8 bit・インターレースなしの PNG だけ読める");
      channels = { 2: 3, 6: 4 }[data[9]];
      if (!channels) throw new Error(`読めない PNG の色の型: ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = cur[x * channels];
      rgba[o + 1] = cur[x * channels + 1];
      rgba[o + 2] = cur[x * channels + 2];
      rgba[o + 3] = 255;
    }
    cur.copy(prev);
  }
  return { width, height, rgba };
}

/**
 * 全コマから間引いて集めた色で、共通のパレットを作る。255 色は画素に割り当て、256 色目（番号 255）は透明用に空ける。
 * 色の割り当ては 255 色だけで行い、透明の番号に画素が割り当たらないようにする（真っ黒が透明にならない）
 */
export function buildPalette(images) {
  const { width, height } = images[0];
  const sampleStep = Math.max(1, Math.floor(images.length / 12));
  const samples = images.filter((_, i) => i % sampleStep === 0 || i === images.length - 1);
  const pool = new Uint8Array(samples.length * width * height * 4);
  samples.forEach((img, i) => pool.set(img.rgba, i * width * height * 4));
  const colors = quantize(pool, 255).slice(0, 255);
  while (colors.length < 255) colors.push([0, 0, 0]);
  return { colors, palette: [...colors, [0, 0, 0]] };
}

/** 秒数が範囲に入り、大きさが 1MB 以下なら true（録画の合否） */
export function checkGif({ seconds, bytes, range: [min, max] }) {
  return seconds >= min && seconds <= max && bytes <= 1024 * 1024;
}

/**
 * コマを GIF にまとめる。色は全コマから間引いて集めた 255 色の共通のパレットにし、
 * 2 コマ目からは前のコマと同じ画素を透明（256 色目）にして、変わったところだけを書く（大きさを抑える）
 */
export function encodeGif(frames) {
  const images = frames.map((f) => decodePng(f.png));
  const { width, height } = images[0];
  const { colors, palette } = buildPalette(images);
  const TRANSPARENT = 255;
  const gif = GIFEncoder();
  let previous = null;
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const first = previous === null;
    gif.writeFrame(pending.out, width, height, {
      palette: first ? palette : undefined,
      delay: pending.delay,
      transparent: !first,
      transparentIndex: TRANSPARENT,
      dispose: 1,
    });
    previous = pending.index;
  };
  for (const [i, img] of images.entries()) {
    const index = applyPalette(img.rgba, colors);
    const base = pending ? pending.index : previous;
    if (base && index.every((v, k) => v === base[k])) {
      // 前のコマと同じなら、前のコマを長く出す
      pending.delay += frames[i].delay;
      continue;
    }
    flush();
    const out = base ? index.map((v, k) => (v === previous[k] ? TRANSPARENT : v)) : index;
    pending = { index, out, delay: frames[i].delay };
  }
  flush();
  gif.finish();
  return gif.bytes();
}
