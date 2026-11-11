import assert from 'node:assert/strict';
import { afterAll, test, vi } from 'vitest';
import { FxManager } from '../src/scenario/particles';
import { AudioManager } from '../src/scenario/audio';
import { Clock } from '../src/scenario/clock';
import { ScenarioPlayer } from '../src/scenario/player';
import { SoundPlayMode } from '../src/scenario/types';

afterAll(() => vi.unstubAllGlobals());
const data = { nodes: [], roots: [], materials: {}, sprites: {}, meshes: {}, clips: {} };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function fxFixture() {
  const manager = new FxManager({ add() {}, remove() {} }, {}, x => x);
  const loading = deferred();
  manager.load = () => loading.promise;
  return { manager, loading };
}
for (const action of ['stop', 'clear', 'destroy', 'detach']) {
  test(`pending effect cannot appear after ${action}`, async () => {
    const { manager, loading } = fxFixture();
    const pending = manager.play('rain', action === 'detach' ? () => null : undefined);
    if (action === 'stop') manager.stop('rain');
    else if (action === 'detach') manager.detach(() => true);
    else manager[action]();
    loading.resolve(data);
    assert.equal(await pending, undefined);
    assert.deepEqual(manager.names(), []);
    manager.destroy();
  });
}
test('clear cancels only the old request, allowing a restored instance', async () => {
  const { manager, loading } = fxFixture();
  const old = manager.play('rain');
  manager.clear();
  const restored = manager.play('rain');
  loading.resolve(data);
  assert.equal(await old, undefined);
  assert.ok(await restored);
  assert.deepEqual(manager.names(), ['rain']);
  manager.destroy();
});
test('background A → B → A ignores the first pending index callback', async () => {
  const { manager } = fxFixture();
  const index = deferred();
  manager.bgIndex = index.promise;
  const calls = [];
  manager.play = async name => { calls.push(name); };
  manager.background('a', {});
  manager.background('b', {});
  manager.background('a', {});
  index.resolve(new Set(['a', 'b']));
  await index.promise;
  assert.deepEqual(calls, ['bg/a']);
  manager.destroy();
});
class FakeAudio {
  volume = 1; paused = true;
  addEventListener() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
}
vi.stubGlobal('Audio', FakeAudio);
vi.stubGlobal('addEventListener', () => {});
vi.stubGlobal('removeEventListener', () => {});
test('stopping a decoding SE prevents its later playback', async () => {
  const audio = new AudioManager();
  const decoded = deferred();
  audio.clip = () => ({});
  audio.decoded = () => decoded.promise;
  audio.ctx = { state: 'running', createBufferSource() { assert.fail('stale SE played'); }, close: async () => {} };
  audio.playSe(['rain.mp3']);
  audio.stopSe();
  decoded.resolve({});
  await decoded.promise;
  assert.equal(audio.soundEffects.size, 0);
  audio.destroy();
});
test('active direct SE follows volume/mute and a named stop', async () => {
  const audio = new AudioManager();
  audio.clip = () => ({});
  audio.playSe(['rain.mp3'], 0.5);
  audio.playSe(['bell.mp3']);
  const [rain, bell] = [...audio.soundEffects];
  audio.setVolume('se', 0.4);
  audio.setMuted(true);
  assert.equal(rain.track.el.volume, 0.2);
  assert.equal(rain.track.el.muted, true);
  audio.stopSe(['rain.mp3']);
  assert.equal(rain.track.el.paused, true);
  assert.equal(bell.track.el.paused, false);
  audio.destroy();
  assert.equal(bell.track.el.paused, true);
});
test('stopBgm stops both sides of a crossfade', () => {
  const audio = new AudioManager();
  for (const track of audio.bgmTracks) track.el.paused = false;
  audio.bgm = audio.bgmTracks[1];
  audio.stopBgm();
  assert.ok(audio.bgmTracks.every(t => t.el.paused));
  audio.destroy();
});
test('jump cancellation prevents a delayed scenario SE', async () => {
  const clock = new Clock();
  const audio = { playSe() { assert.fail('delayed SE played after jump'); } };
  const player = new ScenarioPlayer({ SoundData: [{ PlayMode: SoundPlayMode.Stack, Se: 'bell', Duration: 0.01 }] }, {}, {}, audio, {}, { se: x => [x] }, clock);
  player.handleSound(0);
  clock.cancelAll();
  await new Promise(r => setTimeout(r, 30));
});

function graphAudio() {
  const audio = new AudioManager();
  audio.clip = () => ({});
  const decode = deferred();
  audio.decoded = () => decode.promise;
  const sources = [], gains = [];
  audio.master = { gain: { value: 1 } };
  audio.ctx = {
    state: 'running', close: async () => {},
    createBufferSource() {
      const node = { connect: to => to, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
      sources.push(node);
      return node;
    },
    createGain() {
      const node = { gain: { value: 1 }, connect: to => to, disconnect: vi.fn() };
      gains.push(node);
      return node;
    },
  };
  return { audio, decode, sources, gains };
}
test('Web Audio SE follows current volume and releases its graph on end', async () => {
  const { audio, decode, sources, gains } = graphAudio();
  try {
    audio.playSe(['bell.mp3'], 0.5);
    audio.setVolume('se', 0.4);
    decode.resolve({});
    await decode.promise;
    assert.equal(sources[0].start.mock.calls.length, 1);
    assert.equal(gains[0].gain.value, 0.2);
    audio.setVolume('se', 0.8);
    assert.equal(gains[0].gain.value, 0.4);
    audio.setMuted(true);
    assert.equal(audio.master.gain.value, 0);
    sources[0].onended();
    assert.equal(audio.soundEffects.size, 0);
    assert.equal(sources[0].disconnect.mock.calls.length, 1);
    assert.equal(gains[0].disconnect.mock.calls.length, 1);
  } finally { audio.destroy(); }
});
test('named stop cuts only the matching Web Audio SE', async () => {
  const { audio, decode, sources, gains } = graphAudio();
  try {
    audio.playSe(['rain.mp3']);
    audio.playSe(['bell.mp3']);
    decode.resolve({});
    await decode.promise;
    audio.stopSe(['rain.mp3']);
    assert.equal(sources[0].stop.mock.calls.length, 1);
    assert.equal(sources[0].onended, null);
    assert.equal(gains[0].disconnect.mock.calls.length, 1);
    assert.equal(sources[1].stop.mock.calls.length, 0);
    assert.equal(audio.soundEffects.size, 1);
    audio.stopSe();
    assert.equal(sources[1].stop.mock.calls.length, 1);
    assert.equal(audio.soundEffects.size, 0);
  } finally { audio.destroy(); }
});
for (const failure of ['decode', 'suspended', 'late']) {
  test(`an SE that becomes ${failure} before decoding finishes is discarded`, async () => {
    const { audio, decode, sources } = graphAudio();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      audio.playSe(['bell.mp3']);
      if (failure === 'suspended') audio.ctx.state = 'suspended';
      if (failure === 'late') now.mockReturnValue(4000);
      decode.resolve(failure === 'decode' ? null : {});
      await decode.promise;
      assert.equal(sources.length, 0);
      assert.equal(audio.soundEffects.size, 0);
    } finally { now.mockRestore(); audio.destroy(); }
  });
}
test('refused direct audio playback does not remain active', async () => {
  const audio = new AudioManager();
  audio.clip = () => ({});
  const play = vi.spyOn(FakeAudio.prototype, 'play').mockRejectedValue(new Error('autoplay denied'));
  try {
    audio.playSe(['bell.mp3']);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(audio.soundEffects.size, 0);
  } finally { play.mockRestore(); audio.destroy(); }
});
for (const operation of ['stop', 'jump']) {
  test(`scenario ${operation} cuts active SEs and cancels scheduled SEs`, async () => {
    const audio = new AudioManager();
    audio.clip = () => ({});
    const clock = new Clock();
    const stage = Object.fromEntries(['clear', 'resetView', 'setLayoutMode', 'setBackground', 'restoreView', 'setColorEffect', 'setAmbient'].map(k => [k, vi.fn()]));
    const scenario = { FirstBackground: '', FirstBgm: '', FirstLayout: [], Snippets: [{ Action: 0 }],
      SoundData: [{ PlayMode: SoundPlayMode.Stack, Se: 'later', Duration: 0.01 }] };
    const player = new ScenarioPlayer(scenario, stage, { reset() {} }, audio, { reset() {} }, { se: x => [x] }, clock);
    player.finished = () => {};
    player.playFrom = vi.fn(); // the next timeline is outside this lifecycle test
    audio.playSe(['active']);
    const active = [...audio.soundEffects][0].track;
    player.handleSound(0);
    try {
      if (operation === 'stop') player.stop();
      else await player.jumpTo(0);
      assert.equal(active.el.paused, true);
      await new Promise(r => setTimeout(r, 30));
      assert.equal(audio.soundEffects.size, 0);
      if (operation === 'jump') assert.equal(player.playFrom.mock.calls[0][0], 0);
    } finally { audio.destroy(); }
  });
}
test('scenario Stop sound command preserves BGM and unrelated SEs', () => {
  const audio = new AudioManager();
  audio.clip = () => ({});
  audio.playSe(['rain']);
  audio.playSe(['bell']);
  const bgm = audio.bgmTracks[0];
  bgm.el.paused = false;
  audio.bgm = bgm;
  const player = new ScenarioPlayer({ SoundData: [{ PlayMode: SoundPlayMode.Stop, Se: 'rain' }] }, {}, {}, audio, {}, { se: x => [x] }, new Clock());
  try {
    player.handleSound(0);
    assert.deepEqual([...audio.soundEffects].map(s => s.key), ['bell']);
    assert.equal(bgm.el.paused, false);
  } finally { audio.destroy(); }
});
