import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { BlockBgmPlayer, blockVisits, waveformNotes, loadBgmSequence, prepareBgm, validateSequence } from '../src/scenario/bgm-sequence';
import { fetchBuffer, fetchJson, HttpError } from '../src/scenario/net';
vi.mock('../src/scenario/net', async importOriginal => ({ ...await importOriginal(), fetchBuffer: vi.fn(), fetchJson: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const block = (duration = 2, loop = false, transition = 0, divisions = 65535) => ({ duration, loop, transition, divisions,
  loopCount: loop ? 65535 : 0, events: [{ at: 0, wave: 'a', gain: 1, group: 'IM_001' }] });
const cue = blocks => ({ version: 1, cue: 'synthetic', blocks, waves: { a: { file: 'a.wav', duration: 4 } } });
const transitionCue = () => cue([block(), block(), block(8, true, 1, 2), block(), block(3, true)]);

test('intro plays once, then only the specified final block repeats', () => {
  assert.deepEqual(blockVisits(cue([block(), block(3,true)]), 10), [
    {block:0,start:0,end:2},{block:1,start:2,end:5},{block:1,start:5,end:8},{block:1,start:8,end:10},
  ]);
});
test('block change crosses a subdivision and transition block before target', () => {
  assert.deepEqual(blockVisits(transitionCue(), 16, [{t:6,index:4}]), [
    {block:0,start:0,end:2},{block:1,start:2,end:4},{block:2,start:4,end:8},
    {block:3,start:8,end:10},{block:4,start:10,end:13},{block:4,start:13,end:16},
  ]);
});
test('a request on an odd block waits for the next even block', () => {
  const visits=blockVisits(transitionCue(),13,[{t:3,index:4}]);
  assert.deepEqual(visits.map(v=>v.block),[0,1,2,3,4]); assert.equal(visits[2].end,8);
});
test('request at a boundary applies to the new block', () => {
  const visits=blockVisits(transitionCue(),13,[{t:4,index:4}]);
  assert.equal(visits[2].end,8); assert.equal(visits[3].block,3);
});
test('finite repeat count is honored and non-loop cues end', () => {
  const b=block(2,true); b.loopCount=1;
  assert.deepEqual(blockVisits(cue([b,block()]),10).map(v=>v.block),[0,0,1]);
});
test('immediate transitions suppress later notes in the old block', () => {
  const b=block(8,true,2);b.events.push({at:6,wave:'a',gain:1});
  const m=cue([b,block(),block(3,true)]), visits=blockVisits(m,6,[{t:1,index:2}]);
  assert.equal(visits[0].end,1);assert.equal(visits[1].start,1);
  assert.equal(waveformNotes(m,visits).filter(n=>n.key.startsWith('0:')).length,1);
});
test('a new note replaces only the previous note in the same voice group', () => {
  const b=block(5);b.events.push({at:1,wave:'a',gain:1,group:'IM_002'},{at:2,wave:'a',gain:1,group:'IM_001'});
  assert.deepEqual(waveformNotes(cue([b]),[{block:0,start:0,end:5}]).map(n=>n.stop),[2,5,6]);
});
test('restore starts directly in the requested block', () => {
  assert.deepEqual(blockVisits(transitionCue(),5,[],4).map(v=>v.block),[4,4]);
  assert.throws(()=>blockVisits(transitionCue(),5,[{t:1,index:9}]),/Invalid/);
  assert.throws(()=>blockVisits(transitionCue(),5,[],-1),/Invalid/);
});
test('validation rejects unsupported metadata rather than treating it as flat music', () => {
  validateSequence(transitionCue());
  const mutations=[m=>m.version=9,m=>m.blocks=[],m=>m.waves.a.file='../bad.wav',m=>m.waves.a.duration=Infinity,
    m=>m.blocks[0].duration=0,m=>m.blocks[0].transition=4,m=>{m.blocks[0].transition=1;m.blocks[0].divisions=65535;},
    m=>m.blocks[0].loopCount=-1,m=>m.blocks[0].events[0].group='unknown',m=>m.blocks[0].events[0].wave='missing'];
  for(const mutate of mutations){const m=transitionCue();mutate(m);assert.throws(()=>validateSequence(m));}
});
test('sequence loader falls through missing candidates and decodes relative waves', async () => {
  vi.stubGlobal('location',{href:'https://example.test/'});
  fetchJson.mockRejectedValueOnce(new HttpError('missing',404)).mockResolvedValueOnce(cue([block()]));
  const bytes=new ArrayBuffer(4), buffer={duration:4};fetchBuffer.mockResolvedValue(bytes);
  const ctx={decodeAudioData:vi.fn(async()=>buffer)};
  const result=await loadBgmSequence(['https://example.test/missing.json','https://example.test/bgm/cue/sequence.json'],ctx);
  assert.equal(fetchBuffer.mock.calls.length,0);assert.equal(result.buffers.size,0);
  await result.load(['a','unknown']);
  assert.equal(result.buffers.get('a'),buffer);
  assert.equal(fetchBuffer.mock.calls[0][0],'https://example.test/bgm/cue/a.wav');
  assert.equal(ctx.decodeAudioData.mock.calls.length,1);
});
test('optional absent manifests are skipped; network and invalid manifests fail', async () => {
  fetchJson.mockRejectedValueOnce(new HttpError('missing',404));
  assert.equal(await loadBgmSequence(['missing'],{}),undefined);
  fetchJson.mockRejectedValueOnce(new Error('network'));
  await assert.rejects(loadBgmSequence(['missing'],{}),/network/);
  fetchJson.mockResolvedValueOnce({version:9});
  await assert.rejects(loadBgmSequence(['invalid'],{}),/Invalid/);
});
function graph(m=transitionCue()) {
  vi.useFakeTimers();vi.setSystemTime(0);
  const sources=[], gains=[];
  const param=()=>({value:1,setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),cancelAndHoldAtTime:vi.fn()});
  const ctx={get currentTime(){return Date.now()/1000;},
    createGain(){const g={gain:param(),connect:to=>to,disconnect:vi.fn()};gains.push(g);return g;},
    createBufferSource(){const s={connect:to=>to,start:vi.fn(),stop:vi.fn(),disconnect:vi.fn()};sources.push(s);return s;}};
  const prepared={manifest:m,buffers:new Map([['a',{duration:4}],['b',{duration:8}]]),load:vi.fn(async()=>{}),keep:vi.fn(),release:vi.fn()};
  return {player:new BlockBgmPlayer(ctx,prepared,{}),sources,gains,prepared,ctx};
}
test('scheduler schedules on the audio clock, restores block and stops all nodes', async () => {
  const {player,sources,gains}=graph();
  try {
    await player.start(.7,250);
    assert.deepEqual(sources[0].start.mock.calls[0],[.05,0]);
    assert.deepEqual(gains[0].gain.linearRampToValueAtTime.mock.calls[0],[.7,.3]);
    vi.advanceTimersByTime(6000);player.setBlock(4);
    vi.advanceTimersByTime(4000);
    assert.ok(sources.some(s=>s.start.mock.calls.some(([t])=>t===10.05)));
    player.setBlock(2,true);
    assert.ok(sources.at(-1).start.mock.calls[0][0]>=10);
    assert.throws(()=>player.setBlock(-1),/Invalid/);
    player.stop();assert.ok(sources.every(s=>s.disconnect.mock.calls.length>0));
    assert.equal(vi.getTimerCount(),0);
  } finally {player.stop();}
});
test('ended waveform is not restarted and fade-out cleans up the scheduler', async () => {
  const {player,sources,gains}=graph(cue([block(10)]));
  await player.start(1,0);sources[0].onended();vi.advanceTimersByTime(250);
  assert.equal(sources.length,1);
  const done=vi.fn();player.fadeOut(200,done);vi.advanceTimersByTime(200);
  assert.equal(done.mock.calls.length,1);assert.equal(gains[0].disconnect.mock.calls.length,1);
  assert.equal(vi.getTimerCount(),0);
});
test('a changed plan cancels a future note already inside the lookahead window', async () => {
  const b=block(8,true,2);b.events=[{at:.2,wave:'a',gain:1}];
  const {player,sources}=graph(cue([b,block(),block(3,true)]));
  await player.start(1,0);const future=sources[0];
  player.setBlock(2);
  assert.equal(future.onended,null);assert.ok(future.disconnect.mock.calls.length);
  player.stop();
});
// CRI TransitionMode 1: blocks 2 and 3 are same-length variants on a two-beat grid.
const syncCue = (mode = 1) => {
  const variant = (loop) => ({ ...block(8, loop, 1, 2), transitionMode: mode, events: [{ at: 0, wave: 'b', gain: 1 }] });
  const m = cue([block(), block(), variant(true), variant(false), block(3, true)]);
  m.waves.b = { file: 'b.wav', duration: 8 };
  return m;
};
test('a beat-synchronised transition enters the destination at the same beat', () => {
  const m = syncCue(), visits = blockVisits(m, 16, [{ t: 5, index: 4 }]);
  assert.deepEqual(visits.slice(2, 5), [
    { block: 2, start: 4, end: 8 }, { block: 3, start: 8, end: 12, offset: 4 }, { block: 4, start: 12, end: 15 },
  ]);
  // The destination's whole-block note continues from the entry beat instead of restarting.
  const note = waveformNotes(m, visits).find(n => n.key.startsWith('3:'));
  assert.deepEqual([note.start, note.stop, note.offset], [8, 12, 4]);
  // Mode 0 starts the destination from its beginning.
  const plain = blockVisits(syncCue(0), 16, [{ t: 5, index: 4 }]);
  assert.deepEqual(plain[3], { block: 3, start: 8, end: 12 });
  assert.equal(waveformNotes(syncCue(0), plain).find(n => n.key.startsWith('3:')).offset, 0);
});
test('no synchronised entry when the destination has too few beats or is not on a beat grid', () => {
  const m = syncCue();
  m.blocks[3].divisions = 1;
  assert.equal(blockVisits(m, 16, [{ t: 5, index: 4 }])[3].offset, undefined);
  const n = syncCue();
  n.blocks[3].transition = 0;
  assert.equal(blockVisits(n, 16, [{ t: 5, index: 4 }])[3].offset, undefined);
});
test('notes that ended before the entry point are not replayed', () => {
  const m = syncCue();
  m.blocks[3].events.push({ at: 1, wave: 'a', gain: 1 }); // 'a' lasts 4 s, ends at 5 > 4: continues
  m.waves.c = { file: 'c.wav', duration: 2 };
  m.blocks[3].events.push({ at: 1, wave: 'c', gain: 1 }); // ends at 3 < 4: skipped
  const notes = waveformNotes(m, blockVisits(m, 16, [{ t: 5, index: 4 }])).filter(n => n.key.startsWith('3:'));
  assert.deepEqual(notes.map(n => [n.wave, n.start, n.offset]), [['b', 8, 4], ['a', 8, 3]]);
});
test('a jump block continues at its destination when it ends', () => {
  const first = block(); first.next = 2;
  assert.deepEqual(blockVisits(cue([first, block(), block(3, true)]), 8).map(v => v.block), [0, 2, 2]);
});
test('validation accepts the new block fields and every one-voice group, and rejects bad values', () => {
  const m = syncCue(); m.blocks[0].next = 4; m.aisac = [{ control: 'BGM_VERTICAL', value: 0 }];
  m.blocks[0].events[0].group = 'IM_008';
  validateSequence(m);
  const mutations = [x => x.blocks[2].transitionMode = 2, x => x.blocks[0].next = 5, x => x.blocks[0].next = 1.5,
    x => x.aisac = {}, x => x.aisac = [{ control: 1, value: 0 }], x => x.aisac = [{ control: 'x', value: NaN }],
    x => x.blocks[0].events[0].group = 'IM_009'];
  for (const mutate of mutations) { const x = syncCue(); mutate(x); assert.throws(() => validateSequence(x)); }
});
test('scheduler starts a continuing note inside its waveform', async () => {
  const m = syncCue();
  const { player, sources } = graph(m);
  try {
    await player.start(1, 0);
    vi.advanceTimersByTime(5000); player.setBlock(4);
    vi.advanceTimersByTime(3500);
    assert.ok(sources.some(s => s.start.mock.calls.some(([t, offset]) => Math.abs(t - 8.05) < 1e-6 && offset === 4)));
    assert.deepEqual(player.aisac, []);
  } finally { player.stop(); }
});
test('a voice-group replacement before the entry point is resolved before notes continue', () => {
  const m = syncCue();
  // In the destination, b (8 s) is replaced at 1 s by a (4 s): neither sounds at the entry beat 4,
  // except a, which still lasts until 5.
  m.blocks[3].events = [{ at: 0, wave: 'b', gain: 1, group: 'IM_001' }, { at: 1, wave: 'a', gain: 1, group: 'IM_001' }];
  let notes = waveformNotes(m, blockVisits(m, 16, [{ t: 5, index: 4 }])).filter(n => n.key.startsWith('3:'));
  assert.deepEqual(notes.map(n => [n.wave, n.start, n.stop, n.offset]), [['a', 8, 9, 3]]);
  m.waves.c = { file: 'c.wav', duration: 2 };
  m.blocks[3].events[1].wave = 'c'; // the replacement ended before the entry point too
  notes = waveformNotes(m, blockVisits(m, 16, [{ t: 5, index: 4 }])).filter(n => n.key.startsWith('3:'));
  assert.deepEqual(notes, []);
});
test('long sessions of short looping blocks keep planning', () => {
  const visits = blockVisits(cue([block(.1, true)]), 3600);
  assert.ok(Math.abs(visits.length - 36000) <= 1, String(visits.length));
  assert.equal(visits.at(-1).end, 3600);
  assert.throws(() => blockVisits(cue([block(0, true)]), 1), /progress/);
});

// ── waves on demand ─────────────────────────────────────────────────────────
const twoWaves = () => {
  const m = cue([block(2), { ...block(4, true), events: [{ at: 0, wave: 'b', gain: 1 }] }]);
  m.waves.b = { file: 'b.wav', duration: 4 };
  return m;
};
test('the scheduler asks for the waves of the coming blocks only and lets the others go', async () => {
  const only = (wave, duration = 4, loop = false) => ({ ...block(duration, loop), events: [{ at: 0, wave, gain: 1 }] });
  const m = cue([block(2), block(2), only('b', 4, true), block(2), only('c')]);
  m.waves.b = { file: 'b.wav', duration: 4 }; m.waves.c = { file: 'c.wav', duration: 4 };
  const { player, prepared } = graph(m);
  try {
    await player.start(1, 0);
    assert.deepEqual(prepared.load.mock.calls.slice(0, 2).map(([ids]) => [...ids]), [['a'], ['a', 'b']]); // the first notes, then the window; block 4 is not reached by itself
    vi.advanceTimersByTime(4500);
    assert.deepEqual([...prepared.keep.mock.calls.at(-1)[0]], ['a', 'b']); // the intro's last note sounds on into the loop
    vi.advanceTimersByTime(2000);
    assert.deepEqual([...prepared.keep.mock.calls.at(-1)[0]], ['b']);
    assert.equal(player.block, 0);
    player.setBlock(4); // through the transition block 3
    assert.deepEqual([...prepared.keep.mock.calls.at(-1)[0]].sort(), ['a', 'b', 'c']);
    assert.equal(player.block, 4);
  } finally { player.stop(); }
});
test('a wave decoded late joins inside its waveform', async () => {
  const { player, sources, prepared } = graph(cue([block(4, true)]));
  try {
    prepared.buffers.clear();
    await player.start(1, 0);
    vi.advanceTimersByTime(1000);
    assert.equal(sources.length, 0);
    prepared.buffers.set('a', { duration: 4 });
    vi.advanceTimersByTime(100);
    const [at, offset] = sources[0].start.mock.calls[0];
    assert.ok(Math.abs(at - 1.1) < 1e-6 && Math.abs(offset - 1.05) < 1e-6, `${at} ${offset}`);
  } finally { player.stop(); }
});
test('a wave that outlasts its block is still wanted, and joins when it is decoded after the block', async () => {
  const { player, sources, prepared } = graph(twoWaves()); // a: 4 s in a 2 s block, then b
  try {
    prepared.buffers.delete('a');
    await player.start(1, 0);
    vi.advanceTimersByTime(3000);
    assert.ok(prepared.keep.mock.calls.at(-1)[0].has('a'));
    prepared.buffers.set('a', { duration: 4 });
    vi.advanceTimersByTime(100);
    const late = sources.at(-1).start.mock.calls[0];
    assert.ok(Math.abs(late[1] - 3.05) < 1e-6, String(late));
    vi.advanceTimersByTime(1500);
    assert.deepEqual([...prepared.keep.mock.calls.at(-1)[0]], ['b']);
  } finally { player.stop(); }
});
test('a cue starts in the block it is given, once its first waves are there or after the wait', async () => {
  const { player, sources, prepared, gains } = graph(twoWaves());
  const pending = []; prepared.load.mockImplementation(() => new Promise(r => { pending.push(r); }));
  try {
    const started = player.start(.7, 250, 1);
    assert.deepEqual([...prepared.load.mock.calls[0][0]], ['b']);
    player.setBlock(0); // a change before the first note counts from time 0
    vi.advanceTimersByTime(1000);
    assert.equal(sources.length, 0);
    pending[0](); await started; // the first notes' waves; the rest of the window is still loading
    assert.deepEqual(sources[0].start.mock.calls[0], [1.05, 0]);
    assert.deepEqual(gains[0].gain.linearRampToValueAtTime.mock.calls[0], [.7, 1.3]);
    assert.throws(() => player.start(1, 0, 9), /Invalid/);
  } finally { player.stop(); }
  const late = graph(twoWaves());
  late.prepared.load.mockImplementation(() => new Promise(() => {}));
  late.prepared.buffers.clear();
  const started = late.player.start(1, 0);
  late.player.setBlock(1, true); // a restore before the first note changes where it starts
  vi.advanceTimersByTime(3000); await started;
  assert.deepEqual([...late.prepared.keep.mock.calls[0][0]], ['b']);
  late.player.stop();
  const stopped = graph(twoWaves()), ended = stopped.player.start(1, 0);
  stopped.player.stop(); await ended;
  assert.equal(stopped.sources.length, 0); assert.equal(vi.getTimerCount(), 0);
});
test('a cue faded out before it started stays silent, also where cancelAndHoldAtTime is missing', async () => {
  const { player, gains, ctx } = graph(twoWaves());
  const g = gains[0].gain; g.cancelAndHoldAtTime = undefined; g.cancelScheduledValues = vi.fn(); g.value = .4;
  const started = player.start(.7, 250), done = vi.fn();
  player.fadeOut(200, done); await started;
  assert.deepEqual(g.cancelScheduledValues.mock.calls[0], [ctx.currentTime]);
  assert.deepEqual(g.setValueAtTime.mock.calls.at(-1), [.4, 0]);
  assert.deepEqual(g.linearRampToValueAtTime.mock.calls, [[0, .2]]); // no fade-in over the fade-out
  vi.advanceTimersByTime(200);
  assert.equal(done.mock.calls.length, 1); assert.equal(vi.getTimerCount(), 0);
});
const waves = (decoded = { duration: 4 }) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.stubGlobal('location', { href: 'https://example.test/' });
  fetchBuffer.mockImplementation(async () => new ArrayBuffer(4));
  const ctx = { decodeAudioData: vi.fn(async () => decoded) };
  return { ctx, prepared: prepareBgm(twoWaves(), 'https://example.test/bgm/cue/sequence.json', ctx) };
};
test('a dropped wave is decoded again from the bytes already fetched', async () => {
  const { ctx, prepared } = waves();
  await Promise.all([prepared.load(['a', 'b']), prepared.load(['a'])]);
  assert.equal(fetchBuffer.mock.calls.length, 2); assert.equal(ctx.decodeAudioData.mock.calls.length, 2);
  prepared.keep(new Set(['b']));
  assert.deepEqual([...prepared.buffers.keys()], ['b']);
  await prepared.load(['a']); // decoded, but no longer wanted
  assert.equal(prepared.buffers.has('a'), false);
  prepared.keep(new Set(['a', 'b'])); await prepared.load(['a', 'b']);
  assert.equal(prepared.buffers.size, 2);
  assert.equal(fetchBuffer.mock.calls.length, 2); assert.equal(ctx.decodeAudioData.mock.calls.length, 4);
  prepared.release();
  assert.equal(prepared.buffers.size, 0);
  await prepared.load(['a']); prepared.keep(new Set(['a']));
  assert.equal(fetchBuffer.mock.calls.length, 2);
});
test('a small cue is fetched whole once it plays; a failed wave is asked for again later', async () => {
  const { prepared } = waves();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    fetchBuffer.mockRejectedValueOnce(new Error('offline'));
    await prepared.load(['a']);
    assert.equal(warn.mock.calls.length, 1); assert.equal(prepared.buffers.size, 0);
    await prepared.load(['a']); // not before the retry delay
    assert.equal(fetchBuffer.mock.calls.length, 1);
    fetchBuffer.mockRejectedValueOnce(new Error('offline'));
    prepared.keep(new Set(['a'])); prepared.keep(new Set(['a']));
    assert.equal(fetchBuffer.mock.calls.length, 3); // both waves, once
    await vi.advanceTimersByTimeAsync(5000);
    await prepared.load(['a']);
    assert.equal(fetchBuffer.mock.calls.length, 4); assert.equal(prepared.buffers.size, 1);
    const big = prepareBgm({ ...twoWaves(), waves: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`w${i}`, { file: `w${i}.mp3`, duration: 1 }])) }, 'https://example.test/s.json', {});
    big.keep(new Set());
    assert.equal(fetchBuffer.mock.calls.length, 4);
    const closed = prepareBgm(twoWaves(), 'https://example.test/s.json', { decodeAudioData: async () => { throw new Error('late'); } });
    const pending = closed.load(['a']); closed.release(); await pending;
    assert.equal(warn.mock.calls.length, 1);
  } finally { warn.mockRestore(); }
});
test('an MP3 wave is cut to the samples the descriptor counts', async () => {
  const data = new Float32Array(3000).map((_, i) => i);
  const decoded = { length: 3000, sampleRate: 1000, numberOfChannels: 1, getChannelData: () => data };
  const made = [];
  vi.stubGlobal('location', { href: 'https://example.test/' });
  fetchBuffer.mockImplementation(async () => new ArrayBuffer(4));
  const ctx = { decodeAudioData: async () => decoded,
    createBuffer: (channels, length, rate) => { const b = { channels, length, rate, copyToChannel: vi.fn() }; made.push(b); return b; } };
  const m = twoWaves(); m.waves.a = { file: 'a.mp3', duration: 2 }; m.waves.b = { file: 'b.mp3', duration: 3 };
  const prepared = prepareBgm(m, 'https://example.test/s.json', ctx);
  await prepared.load(['a', 'b']);
  assert.equal(prepared.buffers.get('b'), decoded); // nothing to cut
  assert.deepEqual([made[0].channels, made[0].length, made[0].rate], [1, 2000, 1000]);
  assert.equal(made[0].copyToChannel.mock.calls[0][0].length, 2000);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.waves.a.duration = 1e-9; prepared.keep(new Set(['b'])); prepared.keep(new Set(['a', 'b']));
  await prepared.load(['a']);
  assert.match(String(warn.mock.calls[0][2]), /Invalid decoded/);
  warn.mockRestore();
});
