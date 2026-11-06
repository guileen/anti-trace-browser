import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvironmentSpec, digestSpec } from '../src/spec.mjs';
import { ObscuraManager } from '../src/manager.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function measured(v) {
  return v !== null && v !== undefined && v !== '' && (!Array.isArray(v) || v.length > 0);
}

function compare(left, right) {
  const result = {};
  for (const key of Object.keys(left)) {
    const l = left[key];
    const r = right[key];
    if (measured(l) && measured(r)) {
      result[key] = {
        status: JSON.stringify(l) === JSON.stringify(r) ? 'same' : 'different',
        left: l,
        right: r,
      };
    } else {
      result[key] = { status: 'unobserved', left: l, right: r };
    }
  }
  return result;
}

function extractFeatures(report) {
  const obs = Object.fromEntries(report.observations.map(o => [o.id, o]));
  const canvas = obs.canvas_render?.value || {};
  const webgl = obs.webgl_render?.value || {};
  const audio = obs.audio_render?.value || {};
  const geom = obs.geometry?.value || {};
  const nav = obs.navigator_http?.value || {};
  const fonts = obs.font_privacy?.value || {};

  return {
    canvas_pixels: canvas.pixel_hash || null,
    canvas_png: canvas.png_hash || null,
    audio_samples: audio.hash || null,
    webgl_renderer: webgl.unmasked_renderer || null,
    webgl_parameters: webgl.subpixel_bits !== undefined ? {
      max_texture_size: webgl.max_texture_size,
      subpixel_bits: webgl.subpixel_bits,
    } : null,
    font_widths: fonts.measurements ? fonts.measurements.map(m => ({ font: m.font, width: m.width })) : null,
    screen: geom.screen_width ? {
      width: geom.screen_width,
      height: geom.screen_height,
      colorDepth: geom.color_depth,
      dpr: geom.dpr,
    } : null,
    hardware_concurrency: nav.hardware_concurrency || null,
    device_memory: nav.device_memory || null,
  };
}

export async function runPairedBenchmark(outputDir, auditUrl = 'http://127.0.0.1:8765') {
  await mkdir(outputDir, { recursive: true });

  const specs = {
    A: createEnvironmentSpec({
      seed: 1001,
      name: 'env-a',
      preset: 'mac-m1',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screen: { width: 1512, height: 945, availWidth: 1512, availHeight: 945, colorDepth: 30, pixelDepth: 30, dpr: 2 },
      gpu: { vendor: 'Apple', renderer: 'Apple M1, or similar', subpixelBits: 4, maxTextureSize: 8192 },
      fonts: ['Arial', 'Times New Roman', 'Courier New'],
    }),
    B: createEnvironmentSpec({
      seed: 2002,
      name: 'env-b',
      preset: 'mac-m2',
      hardwareConcurrency: 12,
      deviceMemory: 16,
      screen: { width: 1728, height: 1117, availWidth: 1728, availHeight: 1117, colorDepth: 30, pixelDepth: 30, dpr: 2 },
      gpu: { vendor: 'Intel Inc.', renderer: 'Intel(R) Iris(R) Xe Graphics, or similar', subpixelBits: 8, maxTextureSize: 16384 },
      fonts: ['Menlo', 'Georgia', 'Helvetica Neue'],
    }),
  };

  const report = {
    schema_version: 1,
    engine: 'obscura',
    started_at: new Date().toISOString(),
    specs: {
      A: { spec: specs.A, sha256: digestSpec(specs.A) },
      B: { spec: specs.B, sha256: digestSpec(specs.B) },
    },
    sessions: {},
  };

  // Run sequence: A1 -> B1 -> A2 -> B2
  for (const iteration of [1, 2]) {
    for (const name of ['A', 'B']) {
      const sessionId = `${name}${iteration}`;
      const sessionDir = join(outputDir, name, `run-${iteration}`);
      await mkdir(sessionDir, { recursive: true });
      const profileDir = join(outputDir, name, 'profile');

      const manager = new ObscuraManager(specs[name], { profileDir });
      try {
        await manager.launch();
        await manager.navigate(auditUrl);

        // Check and record persistent local state (localStorage on auditUrl origin)
        const localStateKey = 'obscura_identity_marker';
        const previousState = await manager.evaluate(`localStorage.getItem('${localStateKey}')`);
        await manager.evaluate(`localStorage.setItem('${localStateKey}', '${name}')`);
        const currentState = await manager.evaluate(`localStorage.getItem('${localStateKey}')`);

        const audit = await manager.runAudit(auditUrl);
        await writeFile(join(sessionDir, 'audit-report.json'), JSON.stringify(audit, null, 2));

        report.sessions[sessionId] = {
          status: 'complete',
          browser_closed: true,
          spec_sha256: digestSpec(specs[name]),
          local_state: { previous: previousState, current: currentState },
          scores: audit.scores,
          features: extractFeatures(audit),
        };
      } catch (error) {
        report.sessions[sessionId] = {
          status: 'error',
          error: error.stack || String(error),
        };
      } finally {
        await manager.close();
      }
    }
  }

  const S = report.sessions;
  if (['A1', 'B1', 'A2', 'B2'].every(k => S[k]?.status === 'complete')) {
    report.between_environments = compare(S.A1.features, S.B1.features);
    report.between_environments_after_restart = compare(S.A2.features, S.B2.features);
    report.restart = {
      A: compare(S.A1.features, S.A2.features),
      B: compare(S.B1.features, S.B2.features),
    };

    const requiredDifferent = [
      'canvas_pixels',
      'audio_samples',
      'webgl_renderer',
      'webgl_parameters',
      'font_widths',
      'screen',
      'hardware_concurrency',
      'device_memory',
    ];
    const requiredStable = [
      'canvas_pixels',
      'audio_samples',
      'webgl_renderer',
      'webgl_parameters',
      'font_widths',
      'screen',
      'hardware_concurrency',
      'device_memory',
    ];

    report.gates = {
      all_sessions_completed: true,
      distinct_environment_specs: digestSpec(specs.A) !== digestSpec(specs.B),
      all_required_hardware_different: requiredDifferent.every(
        k => report.between_environments[k]?.status === 'different' &&
             report.between_environments_after_restart[k]?.status === 'different'
      ),
      stable_required_hardware_on_restart: requiredStable.every(
        k => report.restart.A[k]?.status === 'same' && report.restart.B[k]?.status === 'same'
      ),
      independent_persistent_local_state:
        S.A1.local_state.previous === null && S.A1.local_state.current === 'A' &&
        S.A2.local_state.previous === 'A' && S.A2.local_state.current === 'A' &&
        S.B1.local_state.previous === null && S.B1.local_state.current === 'B' &&
        S.B2.local_state.previous === 'B' && S.B2.local_state.current === 'B',
      functionality_controls: ['A1', 'B1', 'A2', 'B2'].every(
        k => S[k].scores?.functionality?.score === 100
      ),
      automation_controls: ['A1', 'B1', 'A2', 'B2'].every(
        k => S[k].scores?.automation?.score === 100
      ),
    };

    report.gates.joint_acceptance = (
      report.gates.all_sessions_completed &&
      report.gates.distinct_environment_specs &&
      report.gates.all_required_hardware_different &&
      report.gates.stable_required_hardware_on_restart &&
      report.gates.independent_persistent_local_state &&
      report.gates.functionality_controls &&
      report.gates.automation_controls
    );
  }

  report.finished_at = new Date().toISOString();
  report.execution_status = report.gates?.joint_acceptance ? 'complete' : 'fail';
  const comparisonFile = join(outputDir, 'comparison.json');
  await writeFile(comparisonFile, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    output: comparisonFile,
    execution_status: report.execution_status,
    gates: report.gates,
    between_environments: Object.fromEntries(
      Object.entries(report.between_environments || {}).map(([k, v]) => [k, v.status])
    ),
  }, null, 2));

  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(root, '.local', 'reports', 'paired', timestamp);
  runPairedBenchmark(out).catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
