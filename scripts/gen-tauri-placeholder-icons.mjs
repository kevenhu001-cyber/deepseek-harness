// 生成 Tauri 占位图标的 Node.js 脚本。
//
// 输出文件位于 apps/desktop/src-tauri/icons/ 下:
//   - 32x32.png       (Windows/Linux 通用 32×32)
//   - 128x128.png     (Windows/Linux 通用 128×128)
//   - 128x128@2x.png  (Tauri 约定的 256×256 高 DPI 图层)
//   - icon.ico        (Windows 应用图标;内嵌 32×32 PNG)
//   - icon.icns       (macOS 应用图标;内嵌 256×256 PNG)
//
// 占位图统一为深蓝填充色 (#1e90ff),后续 P2 阶段会被真实品牌资源替换。
// 脚本仅使用 Node 内置 `zlib`,无需安装额外依赖。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, '..', 'apps', 'desktop', 'src-tauri', 'icons');
mkdirSync(iconsDir, { recursive: true });

// CRC32 table for PNG chunk checksums.
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(width, height, [r, g, b]) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行 1 字节 filter 字节 + width*3 字节 RGB。
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const o = y * rowSize + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 占位色:深蓝 (#1e90ff) —— 后续替换为真实品牌资源。
const color = [0x1e, 0x90, 0xff];
const png32 = makePng(32, 32, color);
const png128 = makePng(128, 128, color);
const png256 = makePng(256, 256, color);

writeFileSync(resolve(iconsDir, '32x32.png'), png32);
writeFileSync(resolve(iconsDir, '128x128.png'), png128);
writeFileSync(resolve(iconsDir, '128x128@2x.png'), png256);

// ICO 容器:Windows 应用图标;内嵌一个 32×32 PNG。
function makeIco(images) {
  const headerLen = 6;
  const entryLen = 16;
  const totalHeader = headerLen + entryLen * images.length;

  const header = Buffer.alloc(headerLen);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(entryLen * images.length);
  const payloads = [];
  let offset = totalHeader;

  images.forEach((img, i) => {
    // ICO 用 0 表示 256 像素。
    const w = img.width === 256 ? 0 : img.width;
    const h = img.height === 256 ? 0 : img.height;

    const entry = entries.subarray(i * entryLen, (i + 1) * entryLen);
    entry[0] = w;
    entry[1] = h;
    entry[2] = 0; // color palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(img.data.length, 8); // image size
    entry.writeUInt32LE(offset, 12); // image offset

    offset += img.data.length;
    payloads.push(img.data);
  });

  return Buffer.concat([header, entries, ...payloads]);
}

const ico = makeIco([{ width: 32, height: 32, data: png32 }]);
writeFileSync(resolve(iconsDir, 'icon.ico'), ico);

// ICNS 容器:macOS 应用图标;内嵌 256×256 PNG (type 'ic08')。
function makeIcns(images) {
  const chunks = [];
  let total = 8; // 'icns' + size 自身

  for (const img of images) {
    const chunkSize = 8 + img.data.length;
    const head = Buffer.alloc(8);
    head.write(img.type, 0, 4, 'ascii');
    head.writeUInt32BE(chunkSize, 4);
    chunks.push(Buffer.concat([head, img.data]));
    total += chunkSize;
  }

  const fileHead = Buffer.alloc(8);
  fileHead.write('icns', 0, 4, 'ascii');
  fileHead.writeUInt32BE(total, 4);
  return Buffer.concat([fileHead, ...chunks]);
}

const icns = makeIcns([{ type: 'ic08', data: png256 }]);
writeFileSync(resolve(iconsDir, 'icon.icns'), icns);

// 同步控制台输出便于 CI 验证。
for (const name of [
  '32x32.png',
  '128x128.png',
  '128x128@2x.png',
  'icon.ico',
  'icon.icns',
]) {
  console.log(`wrote ${name}`);
}
