export function generatePreloadScript(spec) {
  return `(() => {
  'use strict';
  const SPEC = ${JSON.stringify(spec)};

  // 1. Fix Obscura internal seed if accessible
  try {
    if (typeof _fpSeed !== 'undefined') _fpSeed = SPEC.seed;
    globalThis.__obscura_hw_override = SPEC.hardwareConcurrency;
    globalThis.__obscura_mem_override = SPEC.deviceMemory;
  } catch (_) {}

  // 2. Navigator properties
  try {
    const navProto = Object.getPrototypeOf(navigator) || Navigator.prototype;
    for (const target of [navProto, navigator]) {
      Object.defineProperty(target, 'hardwareConcurrency', {
        get: () => SPEC.hardwareConcurrency, configurable: true, enumerable: true
      });
      Object.defineProperty(target, 'deviceMemory', {
        get: () => SPEC.deviceMemory, configurable: true, enumerable: true
      });
      Object.defineProperty(target, 'platform', {
        get: () => SPEC.platform, configurable: true, enumerable: true
      });
      Object.defineProperty(target, 'userAgent', {
        get: () => SPEC.userAgent, configurable: true, enumerable: true
      });
      Object.defineProperty(target, 'webdriver', {
        get: () => false, configurable: true, enumerable: true
      });
    }
  } catch (_) {}

  // 3. Screen & Window Geometry Coherence
  try {
    const s = SPEC.screen;
    const screenProto = Object.getPrototypeOf(screen) || Screen.prototype;
    for (const target of [screenProto, screen]) {
      for (const [prop, val] of Object.entries({
        width: s.width, height: s.height,
        availWidth: s.availWidth, availHeight: s.availHeight,
        colorDepth: s.colorDepth, pixelDepth: s.pixelDepth
      })) {
        Object.defineProperty(target, prop, {
          get: () => val, configurable: true, enumerable: true
        });
      }
    }
    Object.defineProperty(window, 'devicePixelRatio', {
      get: () => s.dpr, configurable: true, enumerable: true
    });
    Object.defineProperty(window, 'outerWidth', {
      get: () => Math.max(window.innerWidth || 1280, 1280), configurable: true, enumerable: true
    });
    Object.defineProperty(window, 'outerHeight', {
      get: () => Math.max((window.innerHeight || 800) + 72, 872), configurable: true, enumerable: true
    });
  } catch (_) {}

  // 4. Deterministic Functional OfflineAudioContext
  try {
    function CustomOfflineAudioContext(channels, length, sampleRate) {
      let freq = 440;
      let gainVal = 0.2;
      return {
        sampleRate: sampleRate || 44100,
        length: length || 4096,
        destination: {},
        createOscillator() {
          return {
            type: 'sine',
            frequency: {
              set value(v) { freq = v; },
              get value() { return freq; }
            },
            connect(dest) {},
            start(time) {}
          };
        },
        createGain() {
          return {
            gain: {
              set value(v) { gainVal = v; },
              get value() { return gainVal; }
            },
            connect(dest) {}
          };
        },
        async startRendering() {
          const totalSamples = length || 4096;
          const sr = sampleRate || 44100;
          const data = new Float32Array(totalSamples);
          const seedMod = ((SPEC.audioSeed % 10000) / 100000000);
          for (let i = 0; i < totalSamples; i++) {
            const t = i / sr;
            data[i] = gainVal * Math.sin(2 * Math.PI * freq * t) + Math.sin(i * 0.001) * seedMod;
          }
          return {
            sampleRate: sr,
            length: totalSamples,
            getChannelData(channel) {
              return data;
            }
          };
        }
      };
    }
    window.OfflineAudioContext = CustomOfflineAudioContext;
    window.webkitOfflineAudioContext = CustomOfflineAudioContext;
  } catch (_) {}

  // 5. Functional WebGL Context
  try {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
        const existing = origGetContext.call(this, type, options);
        if (existing) return existing;

        let clearR = 0, clearG = 0, clearB = 0, clearA = 1;
        const ctx = {
          canvas: this,
          COLOR_BUFFER_BIT: 0x00004000,
          RGBA: 0x1908,
          UNSIGNED_BYTE: 0x1401,
          VENDOR: 0x1F00,
          RENDERER: 0x1F01,
          MAX_TEXTURE_SIZE: 0x0D33,
          SUBPIXEL_BITS: 0x0D50,
          clearColor(r, g, b, a) {
            clearR = Math.round(r * 255);
            clearG = Math.round(g * 255);
            clearB = Math.round(b * 255);
            clearA = Math.round(a * 255);
          },
          clear(mask) {},
          readPixels(x, y, w, h, format, type, pixels) {
            if (pixels && pixels.length >= 4) {
              pixels[0] = clearR;
              pixels[1] = clearG;
              pixels[2] = clearB;
              pixels[3] = clearA;
            }
          },
          getError() { return 0; },
          getParameter(pname) {
            if (pname === 0x1F00) return SPEC.gpu.vendor;
            if (pname === 0x1F01) return SPEC.gpu.renderer;
            if (pname === 0x0D33) return SPEC.gpu.maxTextureSize;
            if (pname === 0x0D50) return SPEC.gpu.subpixelBits;
            if (pname === 0x9245) return SPEC.gpu.vendor;
            if (pname === 0x9246) return SPEC.gpu.renderer;
            return null;
          },
          getExtension(name) {
            if (name === 'WEBGL_debug_renderer_info') {
              return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
            }
            if (name === 'WEBGL_lose_context') {
              return { loseContext() {} };
            }
            return null;
          },
          getSupportedExtensions() {
            return ['WEBGL_debug_renderer_info', 'WEBGL_lose_context'];
          }
        };
        if (typeof window.WebGLRenderingContext === 'undefined') {
          window.WebGLRenderingContext = function () {};
          window.WebGLRenderingContext.SUBPIXEL_BITS = 0x0D50;
          window.WebGLRenderingContext.MAX_TEXTURE_SIZE = 0x0D33;
          window.WebGLRenderingContext.VENDOR = 0x1F00;
          window.WebGLRenderingContext.RENDERER = 0x1F01;
        }
        return ctx;
      }
      return origGetContext.call(this, type, options);
    };
  } catch (_) {}

  // 6. Deterministic Canvas Glyph Rendering & Font-Metric Isolation
  try {
    const dummyCanvas = document.createElement('canvas');
    const ctx2D = dummyCanvas.getContext('2d');
    const ctxProto = ctx2D ? Object.getPrototypeOf(ctx2D) : (globalThis.CanvasRenderingContext2D?.prototype);

    if (ctxProto) {
      const FONT_METRIC_RATIOS = {
        'Times New Roman': 0.94,
        'Courier New': 0.81,
        'Menlo': 0.85,
        'Georgia': 0.98,
        'Helvetica Neue': 1.02,
        'Arial': 1.0,
        'Microsoft YaHei': 1.05,
        'Noto Sans CJK SC': 1.04,
      };

      const origMeasureText = ctxProto.measureText;
      ctxProto.measureText = function (text) {
        const base = origMeasureText ? origMeasureText.call(this, text) : { width: String(text).length * 6 };
        let ratio = 1.0;
        if (this.font) {
          for (const fontName of SPEC.fonts) {
            if (this.font.includes(fontName) && FONT_METRIC_RATIOS[fontName]) {
              ratio = FONT_METRIC_RATIOS[fontName];
              break;
            }
          }
        }
        return {
          width: Math.round(base.width * ratio * 100) / 100,
          actualBoundingBoxAscent: base.actualBoundingBoxAscent || 7,
          actualBoundingBoxDescent: base.actualBoundingBoxDescent || 2,
        };
      };

      ctxProto.fillText = function (text, x, y) {
        const [r, g, b, a] = this._parseColor(this.fillStyle);
        const fontSize = parseInt(this.font) || 10;
        const scale = Math.max(1, Math.round(fontSize / 10));
        const str = String(text);
        let cx = Math.round(x);
        const envSeed = SPEC.seed;
        function envRand(salt) {
          let h = (envSeed ^ (salt || 0)) | 0;
          h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
          h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
          return ((h ^ (h >>> 16)) >>> 0) / 0xFFFFFFFF;
        }
        for (let i = 0; i < str.length; i++) {
          const code = str.charCodeAt(i);
          for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 5; col++) {
              const on = ((envRand(code * 100 + row * 10 + col) > 0.45) &&
                          (row > 0 && row < 6 && col > 0 && col < 4)) ||
                         (envRand(code * 200 + row * 7 + col) > 0.7);
              if (on) {
                for (let sy = 0; sy < scale; sy++) {
                  for (let sx = 0; sx < scale; sx++) {
                    this._setPixel(cx + col * scale + sx, Math.round(y) - 7 * scale + row * scale + sy, r, g, b, a);
                  }
                }
              }
            }
          }
          cx += 6 * scale;
        }
        this._markPaintDamage();
      };
    }
  } catch (_) {}
})();
`;
}
