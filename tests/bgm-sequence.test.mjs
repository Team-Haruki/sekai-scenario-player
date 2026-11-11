import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { BlockBgmPlayer, blockVisits, waveformNotes, loadBgmSequence, validateSequence } from '../src/scenario/bgm-sequence';
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
  return {player:new BlockBgmPlayer(ctx,{manifest:m,buffers:new Map([['a',{duration:4}]])},{}),sources,gains};
}
test('scheduler schedules on the audio clock, restores block and stops all nodes', () => {
  const {player,sources,gains}=graph();
  try {
    player.start(.7,250);
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
test('ended waveform is not restarted and fade-out cleans up the scheduler', () => {
  const {player,sources,gains}=graph(cue([block(10)]));
  player.start(1,0);sources[0].onended();vi.advanceTimersByTime(50);
  assert.equal(sources.length,1);
  const done=vi.fn();player.fadeOut(200,done);vi.advanceTimersByTime(200);
  assert.equal(done.mock.calls.length,1);assert.equal(gains[0].disconnect.mock.calls.length,1);
  assert.equal(vi.getTimerCount(),0);
});
test('a changed plan cancels a future note already inside the lookahead window', () => {
  const b=block(8,true,2);b.events=[{at:.2,wave:'a',gain:1}];
  const {player,sources}=graph(cue([b,block(),block(3,true)]));
  player.start(1,0);const future=sources[0];
  player.setBlock(2);
  assert.equal(future.onended,null);assert.ok(future.disconnect.mock.calls.length);
  player.stop();
});
