import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mp3LeadingSamples } from '../src/scenario/mp3-timing';
function sample() {
  const b = new Uint8Array(200), v = new DataView(b.buffer);
  b.set([255,251,224,0]); b.set(new TextEncoder().encode('Info'),36);
  v.setUint32(40,1); v.setUint32(44,72);
  b.set(new TextEncoder().encode('Lavf'),48); b[69]=36;
  return b.buffer;
}
test('retained MP3 delay is trimmed at native and resampled rates',()=>{
  assert.equal(mp3LeadingSamples(sample(),82944,44100),1105);
  assert.equal(mp3LeadingSamples(sample(),Math.round(82944*48000/44100),48000),1203);
});
test('already trimmed decoders and unknown/truncated files stay aligned',()=>{
  assert.equal(mp3LeadingSamples(sample(),81792,44100),0);
  assert.equal(mp3LeadingSamples(new ArrayBuffer(0),0,44100),0);
  assert.equal(mp3LeadingSamples(sample().slice(0,50),82944,44100),0);
});
