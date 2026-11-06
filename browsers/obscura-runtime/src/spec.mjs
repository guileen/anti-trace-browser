import { createHash } from 'node:crypto';

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isInteger(seed)) return seed >>> 0;
  const h = createHash('sha256').update(String(seed)).digest();
  return h.readUInt32BE(0);
}

export const COHERENT_PRESETS = Object.freeze({
  'mac-m1': {
    os: 'macos',
    platform: 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    screen: { width: 1512, height: 945, availWidth: 1512, availHeight: 945, colorDepth: 30, pixelDepth: 30, dpr: 2 },
    gpu: { vendor: 'Apple', renderer: 'Apple M1, or similar', subpixelBits: 4, maxTextureSize: 8192 },
    fonts: ['Arial', 'Times New Roman', 'Courier New', 'Helvetica Neue'],
  },
  'mac-m2': {
    os: 'macos',
    platform: 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    hardwareConcurrency: 12,
    deviceMemory: 16,
    screen: { width: 1728, height: 1117, availWidth: 1728, availHeight: 1117, colorDepth: 30, pixelDepth: 30, dpr: 2 },
    gpu: { vendor: 'Apple', renderer: 'Apple M2 Pro, or similar', subpixelBits: 4, maxTextureSize: 16384 },
    fonts: ['Menlo', 'Georgia', 'Helvetica Neue', 'SF Pro'],
  },
  'win-intel': {
    os: 'windows',
    platform: 'Win32',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24, dpr: 1 },
    gpu: { vendor: 'Intel Inc.', renderer: 'Intel(R) Iris(R) Xe Graphics, or similar', subpixelBits: 8, maxTextureSize: 16384 },
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Consolas'],
  },
  'win-amd': {
    os: 'windows',
    platform: 'Win32',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    hardwareConcurrency: 12,
    deviceMemory: 16,
    screen: { width: 1440, height: 900, availWidth: 1440, availHeight: 860, colorDepth: 24, pixelDepth: 24, dpr: 1 },
    gpu: { vendor: 'Google Inc. (AMD)', renderer: 'AMD Radeon(TM) Graphics, or similar', subpixelBits: 8, maxTextureSize: 16384 },
    fonts: ['Georgia', 'Segoe UI', 'Tahoma', 'Verdana'],
  },
});

export function createEnvironmentSpec(options = {}) {
  const seed = hashSeed(options.seed ?? 1337);
  const prng = mulberry32(seed);
  const presetKeys = Object.keys(COHERENT_PRESETS);
  const basePreset = options.preset && COHERENT_PRESETS[options.preset]
    ? COHERENT_PRESETS[options.preset]
    : COHERENT_PRESETS[presetKeys[Math.floor(prng() * presetKeys.length)]];

  const spec = {
    schemaVersion: 1,
    seed,
    name: options.name || `env-${seed.toString(16)}`,
    preset: options.preset || 'auto',
    os: basePreset.os,
    platform: options.platform || basePreset.platform,
    userAgent: options.userAgent || basePreset.userAgent,
    hardwareConcurrency: options.hardwareConcurrency ?? basePreset.hardwareConcurrency,
    deviceMemory: options.deviceMemory ?? basePreset.deviceMemory,
    screen: {
      width: options.screen?.width ?? basePreset.screen.width,
      height: options.screen?.height ?? basePreset.screen.height,
      availWidth: options.screen?.availWidth ?? basePreset.screen.availWidth,
      availHeight: options.screen?.availHeight ?? basePreset.screen.availHeight,
      colorDepth: options.screen?.colorDepth ?? basePreset.screen.colorDepth,
      pixelDepth: options.screen?.pixelDepth ?? basePreset.screen.pixelDepth,
      dpr: options.screen?.dpr ?? basePreset.screen.dpr,
    },
    gpu: {
      vendor: options.gpu?.vendor || basePreset.gpu.vendor,
      renderer: options.gpu?.renderer || basePreset.gpu.renderer,
      subpixelBits: options.gpu?.subpixelBits ?? basePreset.gpu.subpixelBits,
      maxTextureSize: options.gpu?.maxTextureSize ?? basePreset.gpu.maxTextureSize,
    },
    fonts: options.fonts ? [...options.fonts] : [...basePreset.fonts],
    audioSeed: (seed ^ 0x9e3779b9) >>> 0,
    timezone: options.timezone || 'Asia/Shanghai',
    locale: options.locale || 'zh-CN',
  };

  validateSpec(spec);
  return spec;
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Spec must be an object');
  if (typeof spec.seed !== 'number') throw new Error('Spec requires a numeric seed');
  if (typeof spec.hardwareConcurrency !== 'number' || spec.hardwareConcurrency < 1) throw new Error('Invalid hardwareConcurrency');
  if (typeof spec.deviceMemory !== 'number' || spec.deviceMemory < 0.25) throw new Error('Invalid deviceMemory');
  if (!spec.screen || typeof spec.screen.width !== 'number' || typeof spec.screen.height !== 'number') throw new Error('Invalid screen dimensions');
  if (!Array.isArray(spec.fonts) || spec.fonts.length === 0) throw new Error('Fonts must be a non-empty array');
  return true;
}

export function digestSpec(spec) {
  return createHash('sha256')
    .update(JSON.stringify(spec, Object.keys(spec).sort()))
    .digest('hex');
}
