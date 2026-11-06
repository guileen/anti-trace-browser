import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// Decode actual non-interlaced 8-bit samples, independently of browser claims.
export function decodePNG(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Not a PNG');
  let width, height, color, channels; const chunks = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset); const kind = buffer.toString('ascii', offset + 4, offset + 8); const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); color = data[9]; channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[color]; if (data[8] !== 8 || data[12] !== 0 || !channels) throw new Error('Unsupported PNG encoding for pixel comparison'); }
    if (kind === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  if (!width || !height || width * height > 16_000_000) throw new Error('PNG dimensions out of bound');
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (width * channels + 1) * height }); const stride = width * channels; const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0; const b = y ? pixels[(y - 1) * stride + x] : 0; const c = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = Math.floor((a + b) / 2);
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new Error(`Invalid PNG filter ${filter}`);
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, color_type: color, channels, pixels };
}

export function pngPixels(buffer) {
  const { width, height, color_type: color, channels, pixels } = decodePNG(buffer);
  const x = Math.min(20, width - 1), y = Math.min(20, height - 1), index = (y * width + x) * channels;
  const rgb = color === 0 || color === 4 ? [pixels[index], pixels[index], pixels[index]] : [...pixels.subarray(index, index + 3)];
  return { width, height, color_type: color, rgb_at_20_20: rgb, decoded_pixels_sha256: createHash('sha256').update(pixels).digest('hex') };
}
