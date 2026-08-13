/**
 * Convert a source PNG icon into the Tauri desktop icon set.
 *
 * Reads the source PNG (any size, RGB or RGBA), downscales to the
 * required sizes using box averaging, and writes:
 *   32x32.png, 128x128.png, 128x128@2x.png, icon.ico, icon.icns
 *
 * Uses only Node built-ins: fs, zlib. No external dependencies.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, '..', 'apps', 'desktop', 'src-tauri', 'icons');
mkdirSync(iconsDir, { recursive: true });

const SOURCE = resolve(process.argv[2] || 'deepseek-logo.png');

// ── CRC32 table (for PNG chunk checksums) ───────────────────────

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tbuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tbuf, data])), 0);
  return Buffer.concat([len, tbuf, data, crc]);
}

// ── PNG reader ─────────────────────────────────────────────────

function readPng(filePath) {
  const buf = readFileSync(filePath);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error('not a PNG file');

  let pos = 8;
  let ihdr = null;
  const idatChunks = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;

    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idatChunks.push(data);
    else if (type === 'IEND') break;
  }

  if (!ihdr) throw new Error('missing IHDR chunk');

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];

  // Reconstruct raw pixel data from IDAT chunks
  const compressed = Buffer.concat(idatChunks);
  const raw = inflateSync(compressed);

  // Compute bytes-per-pixel from color type
  let bpp;
  if (colorType === 2) bpp = 3;       // RGB
  else if (colorType === 6) bpp = 4;  // RGBA
  else throw new Error(`unsupported PNG color type ${colorType}`);

  // Remove filter bytes (1 per row) and extract RGBA pixels
  const stride = 1 + width * bpp;
  const pixels = Buffer.alloc(width * height * 4); // always RGBA output

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride + 1; // skip filter byte
    for (let x = 0; x < width; x++) {
      const srcOff = rowStart + x * bpp;
      const dstOff = (y * width + x) * 4;
      pixels[dstOff] = raw[srcOff];
      pixels[dstOff + 1] = raw[srcOff + 1];
      pixels[dstOff + 2] = raw[srcOff + 2];
      pixels[dstOff + 3] = bpp === 4 ? raw[srcOff + 3] : 255;
    }
  }

  return { width, height, pixels };
}

// ── Downscale: box averaging ─────────────────────────────────

function downscale(pixels, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor((dy / dstH) * srcH);
    const y1 = Math.floor(((dy + 1) / dstH) * srcH);

    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor((dx / dstW) * srcW);
      const x1 = Math.floor(((dx + 1) / dstW) * srcW);

      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const off = (sy * srcW + sx) * 4;
          r += pixels[off];
          g += pixels[off + 1];
          b += pixels[off + 2];
          a += pixels[off + 3];
          count++;
        }
      }

      const dstOff = (dy * dstW + dx) * 4;
      if (count > 0) {
        out[dstOff] = Math.round(r / count);
        out[dstOff + 1] = Math.round(g / count);
        out[dstOff + 2] = Math.round(b / count);
        out[dstOff + 3] = Math.round(a / count);
      }
    }
  }

  return out;
}

// ── PNG writer (RGBA output) ──────────────────────────────────

function makePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = 6;          // color type 6 = RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const srcOff = (y * width + x) * 4;
      const dstOff = y * rowSize + 1 + x * 4;
      raw[dstOff] = pixels[srcOff];
      raw[dstOff + 1] = pixels[srcOff + 1];
      raw[dstOff + 2] = pixels[srcOff + 2];
      raw[dstOff + 3] = pixels[srcOff + 3];
    }
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── ICO writer ─────────────────────────────────────────────────

function makeIco(images) {
  const entryLen = 16;
  const totalHeader = 6 + entryLen * images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(entryLen * images.length);
  const payloads = [];
  let offset = totalHeader;

  images.forEach((img, i) => {
    const w = img.width === 256 ? 0 : img.width;
    const h = img.height === 256 ? 0 : img.height;
    const entry = entries.subarray(i * entryLen, (i + 1) * entryLen);
    entry[0] = w; entry[1] = h;
    entry[2] = 0; entry[3] = 0; // palette / reserved
    entry.writeUInt16LE(1, 4);   // planes
    entry.writeUInt16LE(32, 6);  // bpp
    entry.writeUInt32LE(img.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += img.data.length;
    payloads.push(img.data);
  });

  return Buffer.concat([header, entries, ...payloads]);
}

// ── ICNS writer ────────────────────────────────────────────────

function makeIcns(images) {
  const chunks = [];
  let total = 8;
  for (const img of images) {
    const cs = 8 + img.data.length;
    const head = Buffer.alloc(8);
    head.write(img.type, 0, 4, 'ascii');
    head.writeUInt32BE(cs, 4);
    chunks.push(Buffer.concat([head, img.data]));
    total += cs;
  }
  const fileHead = Buffer.alloc(8);
  fileHead.write('icns', 0, 4, 'ascii');
  fileHead.writeUInt32BE(total, 4);
  return Buffer.concat([fileHead, ...chunks]);
}

// ── Main ────────────────────────────────────────────────────────

const src = readPng(SOURCE);
console.log(`source: ${src.width}x${src.height} (${src.pixels.length} bytes of pixels)`);

const png32  = makePng(32, 32, downscale(src.pixels, src.width, src.height, 32, 32));
const png128 = makePng(128, 128, downscale(src.pixels, src.width, src.height, 128, 128));
const png256 = makePng(256, 256, downscale(src.pixels, src.width, src.height, 256, 256));

writeFileSync(resolve(iconsDir, '32x32.png'), png32);
writeFileSync(resolve(iconsDir, '128x128.png'), png128);
writeFileSync(resolve(iconsDir, '128x128@2x.png'), png256);

const ico = makeIco([{ width: 32, height: 32, data: png32 }]);
writeFileSync(resolve(iconsDir, 'icon.ico'), ico);

const icns = makeIcns([{ type: 'ic08', data: png256 }]);
writeFileSync(resolve(iconsDir, 'icon.icns'), icns);

for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico', 'icon.icns']) {
  console.log(`wrote ${resolve(iconsDir, name)}`);
}