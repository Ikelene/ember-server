'use strict';
// Notification text: Ember's message tokens become readable (notif-text.js), only in the notification copies.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readable, readableEvent } = require('../src/notif-text');

test('custom emojis show as :name:, Unicode emojis stay', () => {
  assert.equal(readable('nice <:fire_cat:e1a2b3c4d5f> 🔥'), 'nice :fire_cat: 🔥');
  assert.equal(readable('<a:party:e0000000000><:x:eabcdefabcd>'), ':party::x:');
  assert.equal(readable('c:e1a2b3c4d5f'), ':emoji:');
});
test('roles, times and spoilers', () => {
  assert.equal(readable('hey <@&r0a1b2c3d4e>'), 'hey @role');
  assert.equal(readable('hey <@&r0a1b2c3d4e>', { roles: () => 'mods' }), 'hey @mods');
  assert.match(readable('at <t:1700000000:R>'), /^at Nov 14, 2023/);
  assert.equal(readable('the killer is ||bob|| lol'), 'the killer is [spoiler] lol');
  assert.equal(readable('plain @ikelene in #general'), 'plain @ikelene in #general');
});
test('events: only the notification copy changes; encrypted DMs are left alone', () => {
  const dm = { type: 'im_received', message: { id: 1, from: 'a', body: '<:wave:e1a2b3c4d5f> hi' } };
  assert.equal(readableEvent(dm).message.body, ':wave: hi');
  assert.equal(dm.message.body, '<:wave:e1a2b3c4d5f> hi');
  const enc = { type: 'im_received', message: { id: 2, enc: { ct: 'x' }, body: '' } };
  assert.equal(readableEvent(enc), enc);
  assert.equal(readableEvent({ type: 'roomMessage', message: '||x||' }).message, '[spoiler]');
  assert.equal(readableEvent({ type: 'bonfire_notice', body: '<:a:e1a2b3c4d5f>' }).body, ':a:');
  assert.equal(readableEvent({ type: 'bonfire_relay', title: 'x <:b:e1a2b3c4d5f>', body: 'y' }).title, 'x :b:');
  assert.equal(readableEvent({ type: 'voice_call_incoming' }).type, 'voice_call_incoming');
});
