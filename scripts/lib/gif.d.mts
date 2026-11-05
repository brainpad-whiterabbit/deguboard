// test/scripts の型検査用。実装は gif.mjs

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}
export function decodePng(buf: Buffer): DecodedImage;
export function buildPalette(images: DecodedImage[]): {
  colors: number[][];
  palette: number[][];
};
export function checkGif(args: {
  seconds: number;
  bytes: number;
  range: [number, number];
}): boolean;
export function encodeGif(frames: { png: Buffer; delay: number }[]): Uint8Array;
