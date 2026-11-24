'use strict';
// Discord voice <-> Ember voice, the media half (a worker thread, so chat traffic on the main thread can't make the audio
// stutter). voice-bridge.js on the main thread does the signalling: it owns the Discord gateway and the voice rooms, and
// this worker reaches both through messages:
//
//   main -> worker  { t: 'start', link }            join link.channelId over there, listen to the Ember room link.room
//                   { t: 'stop', key }              leave both sides
//                   { t: 'people', key, list }      who is in the Discord channel (each gets an Ember publisher)
//                   { t: 'vsu' | 'vsrv', d }        VOICE_STATE_UPDATE (the bot's) / VOICE_SERVER_UPDATE for the adapter
//                   { t: 'frame', sock, frame }     a chat_rtc_* reply / push for one of our pseudo sockets
//   worker -> main  { t: 'op4', d }                 send a voice state update on the Discord gateway
//                   { t: 'join', sock, room, person, nonce } / { t: 'rtc', sock, msg } / { t: 'leave', sock }
//                   { t: 'log', msg }
//
// Discord -> Ember: every Discord person has their own publisher (their own track, so Ember shows who is speaking). Their
//   Opus packets go over as they are (no decode / re-encode), re-stamped with our own RTP sequence + timestamps.
// Ember -> Discord: one hidden listener subscribes to everyone with an account here, decodes, mixes, encodes once and the
//   bot plays that into the Discord channel. Bridged people are never subscribed to, so nothing loops back.
const { parentPort } = require('worker_threads');
const { EventEmitter } = require('events');
const DV = require('@discordjs/voice');
const { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader, useOPUS } = require('werift');
const OpusScript = require('opusscript');

const RATE = 48000, FRAME = 960; // 20 ms
const PREBUF = FRAME * 3, MAXBUF = FRAME * 15; // per Ember speaker: start after 60 ms buffered, never more than 300 ms behind
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);
const REQ_TIMEOUT = 20000;
const post = m => parentPort.postMessage(m);
const log = msg => post({ t: 'log', msg: String(msg) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- signalling over the port (one per pseudo socket)
let sockSeq = 0;
const signals = new Map(); // sock id -> Signal
class Signal extends EventEmitter {
  constructor(label) { super(); this.id = `s${++sockSeq}`; this.label = label; this.pending = new Map(); this.seq = 0; signals.set(this.id, this); }
  wait(nonce, types, label) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(nonce); rej(new Error(`${label} timed out`)); }, REQ_TIMEOUT);
      this.pending.set(nonce, { res, rej, t, types });
    });
  }
  join(room, person) {
    const nonce = `j${++this.seq}`;
    const p = this.wait(nonce, ['chat_rtc_joined'], 'join');
    post({ t: 'join', sock: this.id, room, person, nonce });
    return p;
  }
  request(type, payload, types = ['chat_rtc_published', 'chat_rtc_offer', 'chat_rtc_ready']) {
    const nonce = `r${++this.seq}`;
    const p = this.wait(nonce, types, type);
    post({ t: 'rtc', sock: this.id, msg: { type, ...payload, nonce } });
    return p;
  }
  send(msg) { post({ t: 'rtc', sock: this.id, msg }); }
  frame(f) {
    const p = f?.nonce != null && this.pending.get(f.nonce);
    if (p) {
      if (f.type === 'chat_error') { this.pending.delete(f.nonce); clearTimeout(p.t); p.rej(Object.assign(new Error(f.error || 'chat_error'), { frame: f })); return; }
      if (p.types.includes(f.type)) { this.pending.delete(f.nonce); clearTimeout(p.t); p.res(f); return; }
    }
    this.emit('frame', f);
  }
  close() {
    for (const [, p] of this.pending) { clearTimeout(p.t); p.rej(new Error('cancelled')); }
    this.pending.clear();
    if (signals.get(this.id) === this) { signals.delete(this.id); post({ t: 'leave', sock: this.id }); }
  }
}

// ---------------------------------------------------------------- one Ember participant (publisher or hidden listener)
// Cloudflare hands out stun + turn; the SFU is ICE-lite on public addresses, so one STUN url is enough (see pbx-ember-bridge)
const iceFor = list => {
  const out = [];
  for (const s of list || []) for (const u of [].concat(s.urls || s.url || [])) if (/^stun:/.test(u)) out.push({ urls: u });
  return out.length ? out.slice(0, 1) : [{ urls: 'stun:stun.cloudflare.com:3478' }];
};
const newPc = ice => new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle', codecs: { audio: [useOPUS()], video: [] } });
async function waitIce(pc, ms = 3000) { const end = Date.now() + ms; while (pc.iceGatheringState !== 'complete' && Date.now() < end) await sleep(25); }
async function waitConnected(pc, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const s = pc.connectionState;
    if (s === 'connected') return;
    if (s === 'failed' || s === 'closed') throw new Error(`webrtc ${s}`);
    if (Date.now() > end) throw new Error(`webrtc connect timed out (${s})`);
    await sleep(25);
  }
}
const sdpOf = d => ({ type: d.type, sdp: d.sdp });

class EmberPeer extends EventEmitter {
  // mode 'publish': person = { principal, username, platform, name, avatar }, sends one audio track
  // mode 'listen': person = a hidden listener, subscribes to every non-bridged person's audio and emits 'audio'
  constructor(room, person, mode) {
    super();
    this.room = room; this.person = person; this.mode = mode;
    this.wanted = false; this.gen = 0; this.active = false; this.sig = null;
    this.pc = null; this.track = null; this.mids = new Map(); this.decoders = new Map();
    this.appliedSig = ''; this.serial = Promise.resolve(); this.recoveries = 0; this.subRetries = 0;
    this.seq = Math.floor(Math.random() * 65535); this.ts = Math.floor(Math.random() * 2 ** 31); this.lastAt = 0;
  }
  get tag() { return `[vbridge ${this.mode} ${this.person.username}]`; }
  async start() { this.wanted = true; this.recoveries = 0; await this.connect(); }
  async connect() {
    for (let attempt = 1; ; attempt++) {
      try { return await this.connectOnce(); } catch (e) {
        if (e.frame || e.message === 'cancelled' || attempt >= 4 || !this.wanted) throw e;
        log(`${this.tag} ${e.message} - retrying (${attempt + 1}/4)`);
        this.teardown();
      }
    }
  }
  async connectOnce() {
    const gen = ++this.gen;
    const cancelled = () => { if (gen !== this.gen || !this.wanted) throw new Error('cancelled'); };
    const sig = this.sig = new Signal(this.person.username);
    sig.on('frame', f => this.frame(f, sig));
    const joined = await sig.join(this.room, this.person);
    cancelled();
    const ice = iceFor(joined.iceServers);
    this.active = true; this.appliedSig = ''; this.serial = Promise.resolve(); this.subRetries = 0;
    this.mids.clear(); this.decoders.clear();
    const pc = this.pc = newPc(ice);
    pc.connectionStateChange.subscribe(s => { if (pc === this.pc && s === 'failed') this.rejoinSoon('webrtc failed'); });
    if (this.mode === 'publish') {
      this.track = new MediaStreamTrack({ kind: 'audio' });
      const tr = pc.addTransceiver(this.track, { direction: 'sendonly' });
      await pc.setLocalDescription(await pc.createOffer());
      await waitIce(pc);
      cancelled();
      const pub = await sig.request('chat_rtc_publish', { room: this.room, sessionDescription: sdpOf(pc.localDescription), tracks: [{ mid: String(tr.mid), trackName: 'audio' }] });
      cancelled();
      await pc.setRemoteDescription(pub.sessionDescription);
      await waitConnected(pc, 4000);
      cancelled();
      this.connected = true;
      sig.send({ type: 'chat_rtc_connected', room: this.room }); // now people see (and subscribe to) them
    } else {
      pc.ontrack = ev => this.attach(ev.track, ev.transceiver);
      this.connected = true;
      await this.queueSubscribe(joined.people || []);
    }
  }
  frame(f, sig) {
    if (sig !== this.sig || !this.active) return;
    if (f.type === 'chat_rtc_room' && this.mode === 'listen') this.queueSubscribe(f.people || []);
    else if (f.type === 'chat_rtc_left') { log(`${this.tag} removed: ${f.reason}`); this.stop(); }
  }
  queueSubscribe(people) {
    const gen = this.gen;
    this.lastPeople = people;
    this.serial = this.serial.then(() => this.subscribe(this.lastPeople, gen)).then(() => { this.subRetries = 0; }, e => {
      this.appliedSig = '';
      if (!this.active || gen !== this.gen) return;
      log(`${this.tag} subscribe failed: ${e.message}`);
      if (e.frame?.error === 'realtime_upstream' && this.pc?.connectionState !== 'connected') return this.rejoinSoon('receive session expired');
      if (this.subRetries++ < 5) setTimeout(() => { if (this.active && gen === this.gen) this.queueSubscribe(this.lastPeople); }, 1000);
    });
    return this.serial;
  }
  async subscribe(people, gen) {
    const live = () => this.active && gen === this.gen && this.pc;
    if (!live()) return;
    const uniq = new Map();
    // everyone with an account here (bridged people have a platform: never send them back where they came from)
    for (const p of people || []) if (!p.platform) for (const t of p.tracks || []) if (t.trackName === 'audio') uniq.set(`${p.userId}:${t.sessionId || ''}`, { userId: p.userId, username: p.username, trackName: 'audio' });
    const sources = [...uniq.values()], sig = [...uniq.keys()].sort().join('|');
    if (sig === this.appliedSig) return;
    const out = await this.sig.request('chat_rtc_subscribe', { room: this.room, sources });
    if (!live()) return;
    for (const [, d] of this.decoders) if (!sources.some(s => s.userId === d.userId)) this.emit('gone', d.userId);
    if (!out.sessionDescription) { this.appliedSig = sig; return; }
    for (const t of out.tracks || []) if (t?.mid != null) this.mids.set(String(t.mid), { userId: t.userId, username: t.username });
    const pc = this.pc;
    await pc.setRemoteDescription(out.sessionDescription);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce(pc);
    if (!live() || this.pc !== pc) return;
    try {
      await this.sig.request('chat_rtc_answer', { room: this.room, session: 'receive', sessionDescription: sdpOf(pc.localDescription) });
    } catch (e) {
      if (e.frame && pc.connectionState !== 'connected') { this.rejoinSoon(`receive session failed (${e.message})`); return; }
      throw e;
    }
    this.appliedSig = sig;
    if (pc.connectionState !== 'connected') setTimeout(() => { if (this.active && this.pc === pc && pc.connectionState !== 'connected') this.rejoinSoon('receive stuck'); }, 5000);
  }
  attach(track, transceiver) {
    if (track.kind !== 'audio') return;
    const mid = String(transceiver?.mid);
    track.onReceiveRtp.subscribe(rtp => {
      if (!this.active) return;
      const who = this.mids.get(mid);
      if (!who || !rtp.payload?.length) return;
      let d = this.decoders.get(mid);
      if (!d || d.userId !== who.userId) {
        try { d?.opus.delete?.(); } catch { /* fine */ }
        d = { userId: who.userId, opus: new OpusScript(RATE, 1, OpusScript.Application.VOIP), lastSeq: null };
        this.decoders.set(mid, d);
      }
      const seq = rtp.header.sequenceNumber;
      if (d.lastSeq != null) { const diff = (seq - d.lastSeq + 65536) % 65536; if (diff === 0 || diff > 32768) return; }
      d.lastSeq = seq;
      let pcm;
      try { pcm = d.opus.decode(rtp.payload); } catch { return; }
      this.emit('audio', who.userId, new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2))));
    });
  }
  // one Opus packet from Discord, as it is. The RTP timestamp follows the clock, so a pause stays a pause on the other end.
  sendOpus(payload) {
    if (!this.active || !this.connected || !this.track || !payload?.length) return;
    const now = Date.now(), gap = this.lastAt ? now - this.lastAt : 20;
    this.lastAt = now;
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + (gap > 60 ? Math.round(gap / 20) * FRAME : FRAME)) >>> 0;
    const header = new RtpHeader({ version: 2, payloadType: 111, sequenceNumber: this.seq, timestamp: this.ts, ssrc: 0, marker: gap > 60 });
    try { this.track.writeRtp(new RtpPacket(header, Buffer.from(payload))); } catch { /* closing */ }
  }
  rejoinSoon(why) {
    if (!this.wanted || this.rejoinTimer || this.recoveries >= 3) return;
    this.recoveries++;
    log(`${this.tag} dropped (${why}) - rejoining (${this.recoveries}/3)`);
    this.rejoinTimer = setTimeout(async () => {
      this.rejoinTimer = null;
      if (!this.wanted) return;
      this.teardown();
      try { await this.connect(); this.recoveries = 0; } catch (e) { log(`${this.tag} rejoin failed: ${e.message}`); this.teardown(); this.rejoinSoon('rejoin failed'); }
    }, 1000);
  }
  teardown() {
    this.active = false; this.connected = false;
    for (const d of this.decoders.values()) { this.emit('gone', d.userId); try { d.opus.delete?.(); } catch { /* fine */ } }
    this.decoders.clear(); this.mids.clear(); this.appliedSig = '';
    try { this.track?.stop(); } catch { /* fine */ }
    try { this.pc?.close(); } catch { /* fine */ }
    this.pc = null; this.track = null;
    this.sig?.close(); this.sig = null;
  }
  stop() { this.wanted = false; this.gen++; clearTimeout(this.rejoinTimer); this.rejoinTimer = null; this.teardown(); }
}

// ---------------------------------------------------------------- Ember -> Discord mixer
class Mixer {
  constructor(link) {
    this.link = link; this.peers = new Map(); this.speaking = false; this.silent = 0; this.stats = { fromEmber: 0, toDiscord: 0 };
    this.enc = new OpusScript(RATE, 2, OpusScript.Application.AUDIO);
    try { this.enc.encoderCTL?.(4002, 64000); } catch { /* default bitrate */ }
    let next = performance.now() + 20;
    const tick = () => {
      if (this.stopped) return;
      try { this.tick(); } catch (e) { log(`[vbridge] mixer: ${e.message}`); }
      next += 20;
      const now = performance.now();
      if (next < now - 200) next = now + 20;
      this.timer = setTimeout(tick, Math.max(0, next - now));
    };
    this.timer = setTimeout(tick, 20);
  }
  push(userId, pcm) {
    let p = this.peers.get(userId);
    if (!p) { p = { q: [], len: 0, started: false }; this.peers.set(userId, p); }
    p.q.push(pcm); p.len += pcm.length; this.stats.fromEmber++;
    while (p.len > MAXBUF) { const h = p.q.shift(); p.len -= h.length; }
  }
  gone(userId) { this.peers.delete(userId); }
  pull(p) {
    if (!p.started) { if (p.len < PREBUF) return null; p.started = true; }
    if (p.len < FRAME) { p.started = false; return null; }
    const out = new Int16Array(FRAME);
    let need = FRAME, o = 0;
    while (need > 0) {
      const head = p.q[0], take = Math.min(need, head.length);
      out.set(head.subarray(0, take), o); o += take; need -= take;
      if (take === head.length) p.q.shift(); else p.q[0] = head.subarray(take);
    }
    p.len -= FRAME;
    return out;
  }
  tick() {
    const conn = this.link.conn;
    const acc = new Float32Array(FRAME);
    let any = false;
    for (const p of this.peers.values()) { const s = this.pull(p); if (s) { any = true; for (let i = 0; i < FRAME; i++) acc[i] += s[i]; } }
    if (!conn || conn.state.status !== DV.VoiceConnectionStatus.Ready) return;
    if (any) {
      const st = Buffer.alloc(FRAME * 4);
      for (let i = 0; i < FRAME; i++) {
        let v = acc[i];
        if (v > 24000 || v < -24000) v = Math.sign(v) * (24000 + 8767 * Math.tanh((Math.abs(v) - 24000) / 8767)); // soft knee instead of a hard clip
        const s = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
        st.writeInt16LE(s, i * 4); st.writeInt16LE(s, i * 4 + 2);
      }
      let opus;
      try { opus = this.enc.encode(st, FRAME); } catch { return; }
      conn.playOpusPacket(Buffer.from(opus));
      this.speaking = true; this.silent = 0; this.stats.toDiscord++;
    } else if (this.speaking) {
      conn.playOpusPacket(SILENCE); // five silence frames, then the speaking flag goes off (Discord's own rule)
      if (++this.silent >= 5) { this.speaking = false; this.silent = 0; conn.setSpeaking(false); }
    }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); try { this.enc.delete?.(); } catch { /* fine */ } }
}

// ---------------------------------------------------------------- links
const adapters = new Map(); // guild id -> the methods @discordjs/voice gave our adapter
const links = new Map();    // link key -> { key, guildId, channelId, room, botId, conn, listener, mixer, pubs, people }
const adapterFor = guildId => methods => {
  adapters.set(guildId, methods);
  return {
    sendPayload: payload => { post({ t: 'op4', d: payload.d }); return true; },
    destroy: () => { if (adapters.get(guildId) === methods) adapters.delete(guildId); },
  };
};

function startLink(l) {
  if (links.has(l.key)) return;
  const link = { ...l, pubs: new Map(), people: [], stopped: false };
  links.set(l.key, link);
  log(`[vbridge] ${l.key}: joining discord ${l.channelId} <-> ${l.room}`);
  link.mixer = new Mixer(link);
  link.listener = new EmberPeer(l.room, { principal: `x:listen:${l.key}`, username: `bridge:listener:${l.key}` }, 'listen');
  link.listener.on('audio', (id, pcm) => link.mixer.push(id, pcm));
  link.listener.on('gone', id => link.mixer.gone(id));
  link.listener.start().catch(e => log(`[vbridge] ${l.key}: listener failed: ${e.message}`));
  joinDiscord(link);
  syncPubs(link);
}

function joinDiscord(link) {
  if (link.stopped) return;
  const conn = link.conn = DV.joinVoiceChannel({ guildId: link.guildId, channelId: link.channelId, adapterCreator: adapterFor(link.guildId), selfDeaf: false, selfMute: false });
  conn.on('error', e => log(`[vbridge] ${link.key}: discord voice error: ${e.message}`));
  conn.on('stateChange', (a, b) => {
    if (b.status === DV.VoiceConnectionStatus.Ready && a.status !== b.status) log(`[vbridge] ${link.key}: discord voice ready`);
    if (b.status === DV.VoiceConnectionStatus.Disconnected) {
      // moved / kicked / a network blip: give it 5 s to reconnect by itself, else start over
      Promise.race([DV.entersState(conn, DV.VoiceConnectionStatus.Signalling, 5000), DV.entersState(conn, DV.VoiceConnectionStatus.Connecting, 5000)])
        .catch(() => { if (link.conn !== conn) return; try { conn.destroy(); } catch { /* gone */ } link.conn = null; if (!link.stopped) setTimeout(() => joinDiscord(link), 5000); });
    }
  });
  const rx = conn.receiver;
  rx.speaking.on('start', userId => {
    if (userId === link.botId || rx.subscriptions.has(userId)) return;
    const stream = rx.subscribe(userId, { end: { behavior: DV.EndBehaviorType.Manual } });
    stream.on('data', pkt => { link.fromDiscord = (link.fromDiscord || 0) + 1; link.pubs.get(String(userId))?.sendOpus(pkt); });
    stream.on('error', () => {});
  });
}

// one Ember publisher per Discord person in the channel (made when they join, so their first words aren't lost to setup)
function syncPubs(link) {
  if (link.stopped) return;
  const want = new Map(link.people.map(p => [String(p.id), p]));
  for (const [id, pub] of link.pubs) if (!want.has(id)) { pub.stop(); link.pubs.delete(id); }
  for (const [id, p] of want) {
    if (link.pubs.has(id)) continue;
    const pub = new EmberPeer(link.room, { principal: p.principal, username: p.username, platform: 'discord', name: p.name, avatar: p.avatar }, 'publish');
    link.pubs.set(id, pub);
    pub.start().catch(e => { log(`[vbridge] ${link.key}: publisher for ${p.name} failed: ${e.message}`); if (link.pubs.get(id) === pub) link.pubs.delete(id); });
  }
}

function stopLink(key) {
  const link = links.get(key);
  if (!link) return;
  links.delete(key);
  link.stopped = true;
  log(`[vbridge] ${key}: leaving (Ember -> Discord ${link.mixer.stats.fromEmber} frames in, ${link.mixer.stats.toDiscord} sent; Discord -> Ember ${link.fromDiscord || 0} packets, ${link.pubs.size} people)`);
  link.mixer.stop();
  link.listener.stop();
  for (const pub of link.pubs.values()) pub.stop();
  link.pubs.clear();
  try { link.conn?.destroy(); } catch { /* gone */ }
  link.conn = null;
}

parentPort.on('message', m => {
  try {
    if (m.t === 'start') startLink(m.link);
    else if (m.t === 'stop') stopLink(m.key);
    else if (m.t === 'people') { const l = links.get(m.key); if (l) { l.people = m.list || []; syncPubs(l); } }
    else if (m.t === 'vsu') adapters.get(String(m.d.guild_id))?.onVoiceStateUpdate(m.d);
    else if (m.t === 'vsrv') adapters.get(String(m.d.guild_id))?.onVoiceServerUpdate(m.d);
    else if (m.t === 'frame') signals.get(m.sock)?.frame(m.frame);
  } catch (e) { log(`[vbridge] ${m.t}: ${e.stack || e.message}`); }
});
process.on('unhandledRejection', e => log(`[vbridge] unhandled: ${e?.message || e}`));
