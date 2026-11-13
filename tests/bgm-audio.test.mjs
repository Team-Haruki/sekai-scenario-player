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
test('prepared block BGM uses decoded waves, preserves same cue, and handles block requests',async()=>{
  const {audio,sources}=audioFixture();
  try {
    await audio.prepareBgm(['cue.mp3'],['sequence.json'],true);
    await audio.prepareBgm(['cue.mp3'],['sequence.json'],true);
    assert.equal(fetchJson.mock.calls.length,1);
    audio.playBgm(['cue.mp3'],.7,0);
    assert.equal(sources.length,1);assert.ok(audio.bgmTracks.every(t=>t.el.paused));
    audio.playBgm(['cue.mp3']);assert.equal(sources.length,1);
    audio.setBgmBlockIndex(2);audio.setBgmBlockIndex(2,true);
    assert.ok(sources.length>1);
    audio.stopBgm();assert.equal(vi.getTimerCount(),0);
    assert.throws(()=>audio.setBgmBlockIndex(2),/not prepared/);
  }finally{audio.destroy();}
});
test('category fade survives cue changes and combines with listener and cue gain',async()=>{
  const {audio}=audioFixture();
  try {
    audio.playBgm(['plain.mp3'],.7,0);
    audio.setVolume('bgm',.5);audio.setBgmVolume(.2);
    assert.ok(Math.abs(audio.bgm.el.volume-.07)<1e-9);
    audio.setBgmVolume(1,6000);vi.advanceTimersByTime(3000);
    assert.ok(Math.abs(audio.bgm.el.volume-.21)<.001);
    await audio.prepareBgm(['cue.mp3'],['sequence.json']);
    audio.playBgm(['cue.mp3'],.7,250);
    vi.advanceTimersByTime(3000);
    assert.equal(audio.bgmGain.gain.value,.5);
    assert.ok(audio.bgmTracks.every(t=>t.el.paused));
    audio.setBgmVolume(.4);assert.equal(audio.bgmGain.gain.value,.2);
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
test('missing required sequence fails instead of silently looping the flat MP3',async()=>{
  const {audio}=audioFixture();
  try {
    fetchJson.mockRejectedValue(new HttpError('sequence.json',404));
    await audio.prepareBgm(['optional'],['sequence.json']);
    await assert.rejects(audio.prepareBgm(['required'],['sequence.json'],true),/Missing/);
    await assert.rejects(audio.prepareBgm(['required'],[],true),/Missing/);
    audio.destroy();await audio.prepareBgm(['after-close'],[],true);
  }finally{audio.destroy();}
});
test('closing during sequence loading does not retain late buffers',async()=>{
  const {audio}=audioFixture();let resolve;
  fetchJson.mockImplementation(()=>new Promise(r=>resolve=r));
  const pending=audio.prepareBgm(['cue'],['sequence.json']);audio.destroy();resolve(manifest());await pending;
  assert.equal(audio.sequences.size,0);
});
test('scenario preloading requires the current cue for block commands even without a Bgm field',async()=>{
  const calls=[],audio={prepareBgm:async(...args)=>calls.push(args)};
  const scenario={FirstBgm:'bgm00000',AppearCharacters:[],FirstLayout:[],TalkData:[],SpecialEffectData:[],
    SoundData:[{PlayMode:0,Bgm:'cue'},{PlayMode:6,Bgm:'',BgmBlockIndex:2}],
    Snippets:[{Action:7,ReferenceIndex:0},{Action:7,ReferenceIndex:1}]};
  const player=new ScenarioPlayer(scenario,{preloadAll:async()=>{}},{},audio,{}, {bgm:id=>[id],bgmSequence:id=>[id+'.json']},new Clock());
  await player.preload();assert.deepEqual(calls,[[['cue'],['cue.json'],true]]);
});
test('jump restores the latest block and volume, and new cues reset block state',async()=>{
  const calls=[],audio={stopVoice(){},stopSe(){},stopBgm(){},playBgm(){},setBgmVolume:v=>calls.push(['volume',v]),setBgmBlockIndex:(...v)=>calls.push(['block',...v])};
  const stage=Object.fromEntries(['clear','resetView','setLayoutMode','setBackground','restoreView','setColorEffect','setAmbient'].map(k=>[k,()=>{}]));
  const scenario={FirstBgm:'',FirstBackground:'',FirstLayout:[],SoundData:[{PlayMode:0,Bgm:'cue'},{PlayMode:6,BgmBlockIndex:2},{PlayMode:4,Volume:.4},{PlayMode:0,Bgm:'other'}],
    Snippets:[0,1,2,3].map(ReferenceIndex=>({Action:7,ReferenceIndex})).concat({Action:0})};
  const player=new ScenarioPlayer(scenario,stage,{reset(){}},audio,{reset(){}},{bgm:id=>[id]},new Clock());
  player.finished=()=>{};player.playFrom=()=>{};
  await player.jumpTo(3);assert.deepEqual(calls,[['volume',.4],['block',2,true]]);
  calls.length=0;await player.jumpTo(4);assert.deepEqual(calls,[['volume',.4]]);
  player.handleSound(1);assert.deepEqual(calls.at(-1),['block',2]);
});
test('an AISAC value the exported mix does not assume is reported, not applied',async()=>{
  const {audio}=audioFixture();
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    audio.setBgmAisac(.3); // no layered BGM playing
    fetchJson.mockResolvedValue({...manifest(),aisac:[{control:'BGM_VERTICAL',value:0}]});
    await audio.prepareBgm(['cue.mp3'],['sequence.json'],true);
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
