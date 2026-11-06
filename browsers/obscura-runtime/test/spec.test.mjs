import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentSpec, digestSpec } from '../src/spec.mjs';
import { generatePreloadScript } from '../src/preload.mjs';

test('createEnvironmentSpec produces deterministic output for same seed', () => {
  const spec1 = createEnvironmentSpec({ seed: 42, name: 'env-a' });
  const spec2 = createEnvironmentSpec({ seed: 42, name: 'env-a' });
  assert.equal(digestSpec(spec1), digestSpec(spec2));
  assert.equal(spec1.hardwareConcurrency, spec2.hardwareConcurrency);
  assert.equal(spec1.deviceMemory, spec2.deviceMemory);
  assert.equal(spec1.screen.width, spec2.screen.width);
});

test('createEnvironmentSpec produces differentiated outputs for different seeds', () => {
  const specA = createEnvironmentSpec({ seed: 1001, preset: 'mac-m1', fonts: ['Arial', 'Times New Roman'] });
  const specB = createEnvironmentSpec({ seed: 2002, preset: 'mac-m2', fonts: ['Menlo', 'Georgia'] });
  assert.notEqual(digestSpec(specA), digestSpec(specB));
  assert.notEqual(specA.hardwareConcurrency, specB.hardwareConcurrency);
  assert.notEqual(specA.screen.width, specB.screen.width);
  assert.notEqual(specA.fonts[0], specB.fonts[0]);
});

test('generatePreloadScript includes all key spec properties', () => {
  const spec = createEnvironmentSpec({ seed: 9999, hardwareConcurrency: 8, deviceMemory: 8 });
  const code = generatePreloadScript(spec);
  assert.match(code, /hardwareConcurrency/);
  assert.match(code, /deviceMemory/);
  assert.match(code, /devicePixelRatio/);
  assert.match(code, /OfflineAudioContext/);
  assert.match(code, /HTMLCanvasElement/);
});
