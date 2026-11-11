/** Xing/LAME timing for browsers that retain MP3 encoder/decoder delay. */
export function mp3LeadingSamples(bytes: ArrayBuffer, decodedLength: number, decodedRate: number): number {
  const b = new Uint8Array(bytes), v = new DataView(bytes);
  let start = 0;
  if (b[0] === 73 && b[1] === 68 && b[2] === 51 && b.length >= 10)
    start = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | b[9] & 127);
  if (start + 4 > b.length || b[start] !== 255 || (b[start + 1] & 254) !== 250) return 0;
  // MPEG-1 Layer III; other formats retain their existing decoding behavior.
  const rate = [44100, 48000, 32000][(b[start + 2] >> 2) & 3];
  if (!rate) return 0;
  const mono = (b[start + 3] >> 6) === 3;
  let p = start + 4 + ((b[start + 1] & 1) ? 0 : 2) + (mono ? 17 : 32);
  const tag = String.fromCharCode(...b.subarray(p, p + 4));
  if (!['Info', 'Xing'].includes(tag) || p + 12 > b.length) return 0;
  const flags = v.getUint32(p + 4); p += 8;
  if (!(flags & 1)) return 0;
  const frames = v.getUint32(p); p += 4;
  if (flags & 2) p += 4;
  if (flags & 4) p += 100;
  if (flags & 8) p += 4;
  if (p + 24 > b.length || !/^(LAME|Lavf|Lavc)/.test(String.fromCharCode(...b.subarray(p, p + 4)))) return 0;
  const delay = (b[p + 21] << 4) | (b[p + 22] >> 4);
  const rawLength = frames * 1152 * decodedRate / rate;
  // Already-trimmed decoders must not be shifted a second time.
  if (Math.abs(decodedLength - rawLength) > 2) return 0;
  return Math.round((delay + 529) * decodedRate / rate);
}
