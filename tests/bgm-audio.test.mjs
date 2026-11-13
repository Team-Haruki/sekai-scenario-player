import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AudioManager } from '../src/scenario/audio';
import { ScenarioPlayer } from '../src/scenario/player';
import { Clock } from '../src/scenario/clock';
import { fetchBuffer, fetchJson, HttpError } from '../src/scenario/net';
vi.mock('../src/scenario/net', async original => ({...await original(),fetchJson:vi.fn(),fetchBuffer:vi.fn()}));
class FakeAudio {
  paused=true; volume=1;
  addEventListener() {} pause(){this.paused=true;} play(){this.paused=false;return Promise.resolve();}
}
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(0);
  vi.stubGlobal('Audio',FakeAudio);vi.stubGlobal('addEventListener',()=>{});vi.stubGlobal('removeEventListener',()=>{});
  vi.stubGlobal('location',{href:'https://example.test/'});
});
afterEach(()=>{vi.useRealTimers();vi.resetAllMocks();vi.unstubAllGlobals();});
const manifest=()=>({version:1,cue:'synthetic',waves:{a:{file:'a.wav',duration:2}},
  blocks:[0,1,2].map(i=>({duration:2,loop:i===2,transition:0,divisions:65535,events:[{at:0,wave:'a',gain:1,group:'IM_001'}]}))});
function audioFixture(){
  const audio=new AudioManager(),sources=[];
  const ctx={state:'running',get currentTime(){return Date.now()/1000;},close:async()=>{},
    decodeAudioData:vi.fn(async()=>({duration:2})),
    createGain(){return {gain:{value:1,setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),cancelAndHoldAtTime:vi.fn()},connect:to=>to,disconnect:vi.fn()};},
    createBufferSource(){const s={connect:to=>to,start:vi.fn(),stop:vi.fn(),disconnect:vi.fn()};sources.push(s);return s;}};
  audio.ctx=ctx;audio.master=ctx.createGain();
  fetchJson.mockResolvedValue(manifest());fetchBuffer.mockResolvedValue(new ArrayBuffer(4));
  return {audio,sources};
}
const flush=()=>vi.advanceTimersByTimeAsync(0);
test('prepared block BGM uses decoded waves, preserves same cue, and handles block requests',async()=>{
  const {audio,sources}=audioFixture();
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    await Promise.all([audio.prepareBgm(['cue.mp3'],['sequence.json']),audio.prepareBgm(['cue.mp3'],['sequence.json'])]);
    await audio.prepareBgm(['cue.mp3'],['sequence.json']);
    assert.equal(fetchJson.mock.calls.length,1);
    audio.playBgm(['cue.mp3'],.7,0);await flush();
    assert.equal(sources.length,1);assert.ok(audio.bgmTracks.every(t=>t.el.paused));
    audio.playBgm(['cue.mp3']);await flush();assert.equal(sources.length,1);
    audio.setBgmBlockIndex(2);assert.equal(audio.sequence.block,2);
    audio.setBgmBlockIndex(9);assert.equal(warn.mock.calls.length,1); // not a block of this cue
    audio.stopBgm();assert.equal(vi.getTimerCount(),0);
    audio.setBgmBlockIndex(2);assert.equal(warn.mock.calls.length,1); // no BGM: nothing to say
    audio.playBgm(['plain.mp3'],.7,0);audio.setBgmBlockIndex(2);
    assert.match(warn.mock.calls[1][0],/no block sequence/);
  }finally{warn.mockRestore();audio.destroy();}
});
test('a jump keeps the same BGM playing and restarts a block cue only in another block',async()=>{
  const {audio,sources}=audioFixture();
  try {
    audio.playBgm(['plain.mp3'],.7,0);const track=audio.bgm;
    audio.restoreBgm(['plain.mp3'],.7);assert.equal(audio.bgm,track);assert.equal(track.el.paused,false);
    await audio.prepareBgm(['cue.mp3'],['sequence.json']);
    audio.restoreBgm(['cue.mp3'],.7,2);await flush();
    assert.equal(track.el.paused,true);assert.equal(audio.sequence.block,2);
    const playing=audio.sequence,count=sources.length;
    audio.restoreBgm(['cue.mp3'],.7,2);assert.equal(audio.sequence,playing);assert.equal(sources.length,count);
    audio.restoreBgm(['cue.mp3'],.7);assert.equal(audio.sequence,playing);assert.equal(playing.block,0);
    assert.ok(sources.length>count);
    audio.restoreBgm(['cue.mp3'],.7,9);await flush(); // not a block: from the start
    assert.notEqual(audio.sequence,playing);assert.equal(audio.sequence.block,0);
    audio.restoreBgm(['plain.mp3'],.7);assert.equal(audio.sequence,undefined);assert.equal(audio.bgm.el.paused,false);
  }finally{audio.destroy();}
});
test('the scenario volume survives cue changes and combines with listener and cue gain',async()=>{
  const {audio}=audioFixture();
  try {
    audio.playBgm(['plain.mp3'],.7,0);
    audio.setVolume('bgm',.5);audio.setBgmVolume(.2);
    assert.ok(Math.abs(audio.bgm.el.volume-.07)<1e-9);assert.equal(audio.bgmVolume,.2);
    await audio.prepareBgm(['cue.mp3'],['sequence.json']);
    audio.playBgm(['cue.mp3'],.7,250);
    await vi.advanceTimersByTimeAsync(3000);
    assert.equal(audio.bgmGain.gain.value,.1);
    assert.ok(audio.bgmTracks.every(t=>t.el.paused));
    audio.setBgmVolume(.4);assert.equal(audio.bgmGain.gain.value,.2);
    audio.setBgmVolume(NaN);assert.equal(audio.bgmVolume,1);
  }finally{audio.destroy();}
});
test('crossfading sequences and plain cues releases old graphs and timers',async()=>{
  const {audio}=audioFixture();
  try {
    await audio.prepareBgm(['a.mp3'],['a.json']);await audio.prepareBgm(['b.mp3'],['b.json']);
    audio.playBgm(['a.mp3'],1,0);audio.playBgm(['b.mp3'],1,100);
    assert.equal(audio.fadingSequences.size,1);vi.advanceTimersByTime(100);assert.equal(audio.fadingSequences.size,0);
    audio.playBgm(['a.mp3'],1,0);assert.equal(audio.fadingSequences.size,0);
    audio.playBgm(['plain.mp3'],1,100);assert.equal(audio.fadingSequences.size,1);
    audio.stopBgm();assert.equal(audio.fadingSequences.size,0);assert.equal(vi.getTimerCount(),0);
    audio.playBgm(['plain.mp3'],1,0);audio.playBgm([],1,100);vi.advanceTimersByTime(132);
    assert.ok(audio.bgmTracks.every(t=>t.el.paused));
  }finally{audio.destroy();}
});
test('a cue whose sequence is missing, unreachable or not understood plays its flat track',async()=>{
  const {audio}=audioFixture();
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    fetchJson.mockRejectedValueOnce(new HttpError('sequence.json',404));
    await audio.prepareBgm(['absent.mp3'],['sequence.json']);
    assert.equal(warn.mock.calls.length,0);
    fetchJson.mockRejectedValueOnce(new Error('offline'));
    await audio.prepareBgm(['offline.mp3'],['sequence.json']);
    fetchJson.mockResolvedValueOnce({version:9});
    await audio.prepareBgm(['unknown.mp3'],['sequence.json']);
    assert.deepEqual(warn.mock.calls.map(c=>c[1]),['offline.mp3','unknown.mp3']);
    await audio.prepareBgm(['none.mp3'],[]);
    assert.equal(fetchJson.mock.calls.length,3);assert.equal(audio.sequences.size,0);
    audio.playBgm(['offline.mp3'],.7,0);
    assert.equal(audio.sequence,undefined);assert.equal(audio.bgm.el.paused,false);
    audio.destroy();await audio.prepareBgm(['after-close.mp3'],['sequence.json']);
    assert.equal(fetchJson.mock.calls.length,3);
  }finally{warn.mockRestore();audio.destroy();}
});
test('closing during sequence loading does not retain late buffers',async()=>{
  const {audio}=audioFixture();let resolve;
  fetchJson.mockImplementation(()=>new Promise(r=>resolve=r));
  const pending=audio.prepareBgm(['cue'],['sequence.json']);audio.destroy();resolve(manifest());await pending;
  assert.equal(audio.sequences.size,0);
});
test('only the sequences of the loaded scenario are kept, and the one still playing',async()=>{
  const {audio}=audioFixture();
  try {
    for(const cue of ['a','b','c']) await audio.prepareBgm([cue+'.mp3'],[cue+'.json']);
    audio.playBgm(['a.mp3'],1,0);audio.playBgm(['b.mp3'],1,100); // a fades out, b plays
    const dropped=audio.sequences.get('c.mp3'),release=vi.spyOn(dropped,'release');
    audio.retainBgm([['d.mp3']]);
    assert.deepEqual([...audio.sequences.keys()],['a.mp3','b.mp3']);assert.equal(release.mock.calls.length,1);
    let resolve;fetchJson.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const late=audio.prepareBgm(['e.mp3'],['e.json']); // of the scenario before: arrives after the switch
    await audio.prepareBgm(['d.mp3'],['d.json']);
    resolve(manifest());await late;
    audio.stopBgm();audio.retainBgm([['d.mp3']]);
    assert.deepEqual([...audio.sequences.keys()],['d.mp3']);
  }finally{audio.destroy();}
  assert.equal(audio.sequences.size,0);
});
test('scenario preloading looks for the sequence of every BGM cue and keeps only those',async()=>{
  const calls=[],audio={prepareBgm:async(...args)=>calls.push(args),retainBgm:(...args)=>calls.push(['retain',...args])};
  const scenario={FirstBgm:'bgm00000',AppearCharacters:[],FirstLayout:[],TalkData:[],SpecialEffectData:[],
    SoundData:[{PlayMode:0,Bgm:'cue'},{PlayMode:6,Bgm:'',BgmBlockIndex:2},{PlayMode:0,Bgm:'cue'}],
    Snippets:[{Action:7,ReferenceIndex:0},{Action:7,ReferenceIndex:1}]};
  const player=new ScenarioPlayer(scenario,{preloadAll:async()=>{}},{},audio,{}, {bgm:id=>[id],bgmSequence:id=>[id+'.json']},new Clock());
  await player.preload();assert.deepEqual(calls,[['retain',[['cue']]],[['cue'],['cue.json']]]);
  calls.length=0;
  const plain=new ScenarioPlayer(scenario,{preloadAll:async()=>{}},{},audio,{}, {bgm:id=>[id]},new Clock());
  await plain.preload();assert.deepEqual(calls,[['retain',[['cue']]],[['cue'],[]]]);
});
test('the first line does not wait long for a slow sequence descriptor',async()=>{
  const audio={prepareBgm:()=>new Promise(()=>{}),retainBgm(){}};
  const scenario={FirstBgm:'cue',AppearCharacters:[],FirstLayout:[],TalkData:[],SpecialEffectData:[],SoundData:[],Snippets:[]};
  const player=new ScenarioPlayer(scenario,{preloadAll:async()=>{}},{},audio,{}, {bgm:id=>[id],bgmSequence:id=>[id+'.json']},new Clock());
  let done=false;void player.preload().then(()=>{done=true;});
  await vi.advanceTimersByTimeAsync(3999);assert.equal(done,false);
  await vi.advanceTimersByTimeAsync(1);assert.equal(done,true);
});
test('jump restores the latest block and volume, and new cues reset block state',async()=>{
  const calls=[],audio={stopVoice(){},stopSe(){},stopBgm:()=>calls.push(['stop']),restoreBgm:(...v)=>calls.push(['bgm',...v]),
    setBgmVolume:v=>calls.push(['volume',v]),setBgmBlockIndex:(...v)=>calls.push(['block',...v])};
  const stage=Object.fromEntries(['clear','resetView','setLayoutMode','setBackground','restoreView','setColorEffect','setAmbient'].map(k=>[k,()=>{}]));
  const scenario={FirstBgm:'',FirstBackground:'',FirstLayout:[],SoundData:[{PlayMode:0,Bgm:'cue'},{PlayMode:6,BgmBlockIndex:2},{PlayMode:4,Volume:.4},{PlayMode:0,Bgm:'other'}],
    Snippets:[0,1,2,3].map(ReferenceIndex=>({Action:7,ReferenceIndex})).concat({Action:0})};
  const player=new ScenarioPlayer(scenario,stage,{reset(){}},audio,{reset(){}},{bgm:id=>[id]},new Clock());
  player.finished=()=>{};player.playFrom=()=>{};
  await player.jumpTo(3);assert.deepEqual(calls,[['bgm',['cue'],.7,2],['volume',.4]]);
  calls.length=0;await player.jumpTo(4);assert.deepEqual(calls,[['bgm',['other'],.7,0],['volume',.4]]);
  calls.length=0;await player.jumpTo(0);assert.deepEqual(calls,[['stop'],['volume',1]]);
  player.handleSound(1);assert.deepEqual(calls.at(-1),['block',2]);
});
test('BgmVolume fades on the timeline clock; a newer one or a jump takes over',async()=>{
  const audio={bgmVolume:1,setBgmVolume(v){this.bgmVolume=v;},stopVoice(){},stopSe(){},stopBgm(){},restoreBgm(){}};
  const stage=Object.fromEntries(['clear','resetView','setLayoutMode','setBackground','restoreView','setColorEffect','setAmbient'].map(k=>[k,()=>{}]));
  const scenario={FirstBgm:'',FirstBackground:'',FirstLayout:[],
    SoundData:[{PlayMode:4,Volume:.2,Duration:4},{PlayMode:4,Volume:1,Duration:0},{PlayMode:4,Volume:0}],Snippets:[{Action:0}]};
  const clock=new Clock(),player=new ScenarioPlayer(scenario,stage,{reset(){}},audio,{reset(){}},{bgm:id=>[id]},clock);
  player.finished=()=>{};player.playFrom=()=>{};
  player.handleSound(0);vi.advanceTimersByTime(2000);
  assert.ok(Math.abs(audio.bgmVolume-.6)<.01,String(audio.bgmVolume));
  clock.scale=3;player.handleSound(0);vi.advanceTimersByTime(1400); // fast-forward: 4 s in 1.33 s
  assert.equal(audio.bgmVolume,.2);
  clock.scale=1;player.handleSound(1);assert.equal(audio.bgmVolume,1);
  player.handleSound(0);vi.advanceTimersByTime(1000);player.handleSound(2); // no Duration: at once
  vi.advanceTimersByTime(4000);assert.equal(audio.bgmVolume,0);
  player.handleSound(0);vi.advanceTimersByTime(1000);await player.jumpTo(0);
  vi.advanceTimersByTime(4000);assert.equal(audio.bgmVolume,1);
});
test('an AISAC value the exported mix does not assume is reported, not applied',async()=>{
  const {audio}=audioFixture();
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    audio.setBgmAisac(.3); // no layered BGM playing
    fetchJson.mockResolvedValue({...manifest(),aisac:[{control:'BGM_VERTICAL',value:0}]});
    await audio.prepareBgm(['cue.mp3'],['sequence.json']);
    audio.playBgm(['cue.mp3'],.7,0);
    audio.setBgmAisac(0);
    assert.equal(warn.mock.calls.length,0);
    audio.setBgmAisac(.3);
    assert.equal(warn.mock.calls.length,1);
    assert.match(warn.mock.calls[0][0],/BGM_VERTICAL 0.3/);
  }finally{warn.mockRestore();audio.destroy();}
});
test('scenario sound mode 5 hands its value to the BGM AISAC check',()=>{
  const calls=[],audio={setBgmAisac:v=>calls.push(v)};
  const scenario={FirstBgm:'',FirstBackground:'',FirstLayout:[],SoundData:[{PlayMode:5,Bgm:'cue',Volume:0}],Snippets:[]};
  const player=new ScenarioPlayer(scenario,{},{},audio,{},{bgm:id=>[id]},new Clock());
  player.handleSound(0);assert.deepEqual(calls,[0]);
});
