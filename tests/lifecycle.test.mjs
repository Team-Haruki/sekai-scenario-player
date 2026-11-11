import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, server: { middlewareMode: true } });
after(() => server.close());
const { FxManager } = await server.ssrLoadModule('/src/scenario/particles.ts');
const { AudioManager } = await server.ssrLoadModule('/src/scenario/audio.ts');
const { Clock } = await server.ssrLoadModule('/src/scenario/clock.ts');
const { ScenarioPlayer } = await server.ssrLoadModule('/src/scenario/player.ts');
const { SoundPlayMode } = await server.ssrLoadModule('/src/scenario/types.ts');
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
globalThis.Audio = FakeAudio;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
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
