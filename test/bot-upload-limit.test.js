'use strict';
// bot / webhook uploads follow the server's upload limit, not readForm's 8 MB default
const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
require('./helpers');
const uploads = require('../src/uploads');

const form = async (...sizes) => {
  const fd = new FormData();
  sizes.forEach((n, i) => fd.append(`files[${i}]`, new Blob([new Uint8Array(n)]), `f${i}.bin`));
  const r = new Response(fd);
  const req = Readable.from([Buffer.from(await r.arrayBuffer())]);
  req.headers = { 'content-type': r.headers.get('content-type') };
  return req;
};
const MB = 1024 * 1024;

test('readForm: per-file limit is the one passed in', async () => {
  const ok = await uploads.readForm(await form(16 * MB), { maxBytes: 100 * MB });
  assert.equal(ok.files[0].buffer.length, 16 * MB);
  await assert.rejects(uploads.readForm(await form(3 * MB), { maxBytes: 2 * MB }), { code: 'file_too_large' });
});

test('readForm: all files together are capped', async () => {
  await assert.rejects(uploads.readForm(await form(2 * MB, 2 * MB), { maxBytes: 2 * MB, maxTotal: 3 * MB }), { code: 'file_too_large' });
});
