// SHA-256 of a file's bytes, as lower-case hex: the name the Mac stores an original under.
// A page on a secure address (the Mac's own localhost) asks the browser. A phone reaches the
// Mac on a plain-http address, where the browser offers no hashing, so the same sum is worked
// out here, a few megabytes at a time with a pause between, so the page stays responsive.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

// Work `count` whole 64-byte blocks of `bytes`, starting at `start`, into the state `h`.
function blocks(h, bytes, start, count, w) {
  let [a0, b0, c0, d0, e0, f0, g0, h0] = h;
  for (let n = 0, p = start; n < count; n++, p += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[p + i * 4] << 24 | bytes[p + i * 4 + 1] << 16 | bytes[p + i * 4 + 2] << 8 | bytes[p + i * 4 + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = (w[i - 16] + ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)) + w[i - 7] + ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10))) >>> 0;
    }
    let a = a0, b = b0, c = c0, d = d0, e = e0, f = f0, g = g0, hh = h0;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0; e0 = (e0 + e) >>> 0; f0 = (f0 + f) >>> 0; g0 = (g0 + g) >>> 0; h0 = (h0 + hh) >>> 0;
  }
  h[0] = a0; h[1] = b0; h[2] = c0; h[3] = d0; h[4] = e0; h[5] = f0; h[6] = g0; h[7] = h0;
}

// The sum worked out here, without the browser's help. `pause()` is awaited between stretches
// of `stretch` bytes (a multiple of 64).
export async function sha256Here(buffer, { stretch = 4 * 1024 * 1024, pause = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  const bytes = new Uint8Array(buffer), size = bytes.length;
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
  const whole = size - size % 64;
  for (let at = 0; at < whole; at += stretch) {
    blocks(h, bytes, at, Math.min(stretch, whole - at) / 64, w);
    if (at + stretch < whole) await pause();
  }
  // The rest, a 1 bit, zeros, and the length in bits as 64 bits.
  const rest = size - whole, tail = new Uint8Array(rest + 9 > 64 ? 128 : 64);
  tail.set(bytes.subarray(whole)); tail[rest] = 0x80;
  const bits = size * 8, view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32)); view.setUint32(tail.length - 4, bits >>> 0);
  blocks(h, tail, 0, tail.length / 64, w);
  return Array.from(h, x => x.toString(16).padStart(8, '0')).join('');
}

// The sum from the browser where it offers one, worked out here where it does not.
export async function sha256(buffer) {
  if (typeof Blob !== 'undefined' && buffer instanceof Blob) return sha256Blob(buffer);
  if (globalThis.crypto && globalThis.crypto.subtle) {
    try { return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer)), b => b.toString(16).padStart(2, '0')).join(''); }
    catch (error) { /* worked out here instead */ }
  }
  return sha256Here(buffer);
}

// Fixed-size slices bound hashing memory even for large original videos on HTTP phones.
export async function sha256Blob(blob, chunkSize = 4 * 1024 * 1024) {
  if (!Number.isInteger(chunkSize) || chunkSize < 64 || chunkSize % 64) throw new Error('Hash chunk must be a multiple of 64 bytes');
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), w = new Uint32Array(64);
  const whole = blob.size - blob.size % 64;
  for (let at=0; at<whole; at+=chunkSize) {
    const bytes = new Uint8Array(await blob.slice(at, Math.min(whole,at+chunkSize)).arrayBuffer());
    blocks(h,bytes,0,bytes.length/64,w);
    await new Promise(resolve => setTimeout(resolve,0));
  }
  const rest = blob.size-whole, tail = new Uint8Array(rest+9 > 64 ? 128 : 64);
  tail.set(new Uint8Array(await blob.slice(whole).arrayBuffer())); tail[rest]=0x80;
  const bits=blob.size*8, view=new DataView(tail.buffer);
  view.setUint32(tail.length-8,Math.floor(bits/2**32)); view.setUint32(tail.length-4,bits>>>0);
  blocks(h,tail,0,tail.length/64,w);
  return Array.from(h,x=>x.toString(16).padStart(8,'0')).join('');
}
