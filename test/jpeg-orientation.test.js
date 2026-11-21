'use strict';
// stripJpegExif drops camera / GPS EXIF but keeps the Orientation, so phone photos don't show sideways
const test = require('node:test');
const assert = require('node:assert');
const uploads = require('../src/uploads');

const seg = (marker, payload) => { const h = Buffer.alloc(4); h.writeUInt16BE(0xff00 | marker, 0); h.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([h, payload]); };
// a little-endian EXIF with a Make string, a GPS pointer and Orientation = o
function exif(o) {
  const t = Buffer.alloc(8 + 2 + 3 * 12 + 4 + 8);
  t.write('II', 0, 'latin1'); t.writeUInt16LE(0x2a, 2); t.writeUInt32LE(8, 4); t.writeUInt16LE(3, 8);
  let e = 10;
  t.writeUInt16LE(0x010f, e); t.writeUInt16LE(2, e + 2); t.writeUInt32LE(8, e + 4); t.writeUInt32LE(50, e + 8); e += 12; // Make -> "SECRETCM"
  t.writeUInt16LE(0x0112, e); t.writeUInt16LE(3, e + 2); t.writeUInt32LE(1, e + 4); t.writeUInt16LE(o, e + 8); e += 12;
  t.writeUInt16LE(0x8825, e); t.writeUInt16LE(4, e + 2); t.writeUInt32LE(1, e + 4); t.writeUInt32LE(0, e + 8); e += 12; // GPS IFD
  t.write('SECRETCM', 50, 'latin1');
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
}
function jpeg(o) {
  const sof = Buffer.from([8, 0, 100, 0, 200, 1, 1, 0x11, 0]); // 8-bit, height 100, width 200, 1 component
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xe1, exif(o)),
    seg(0xc0, sof), seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34, 0xff, 0xd9])]);
}

test('orientation survives the EXIF strip, the rest goes', () => {
  const out = uploads.stripJpegExif(jpeg(6));
  assert.ok(!out.includes('SECRETCM'), 'camera make removed');
  assert.ok(out.includes(Buffer.from('Exif\0\0MM', 'latin1')), 'minimal EXIF added');
  assert.ok(out.length < jpeg(6).length);
  assert.deepStrictEqual(uploads.dimensions(out, 'jpg'), { width: 100, height: 200 }, 'size as shown (turned a quarter)');
  assert.ok(out.subarray(-4).equals(Buffer.from([0x12, 0x34, 0xff, 0xd9])), 'image data untouched');
  assert.strictEqual(uploads.stripJpegExif(out).length, out.length, 'stripping again keeps it');
});

test('upright photos lose all EXIF and keep their size', () => {
  const out = uploads.stripJpegExif(jpeg(1));
  assert.ok(!out.includes(Buffer.from('Exif', 'latin1')));
  assert.deepStrictEqual(uploads.dimensions(out, 'jpg'), { width: 200, height: 100 });
  assert.deepStrictEqual(uploads.dimensions(uploads.stripJpegExif(jpeg(3)), 'jpg'), { width: 200, height: 100 }, '180 keeps the size');
});
