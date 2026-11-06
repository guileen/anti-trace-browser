import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { createAuditServer } from '../../../services/audit/src/server.mjs';
import { AUTHENTICITY_MANIFEST, generateAuthenticityInputs, evaluateAuthenticity } from '../../../services/audit/src/authenticity.mjs';
import { harness, save, digest, sha256 } from './runtime-harness.mjs';
import { pngPixels, decodePNG } from '../scripts/png.mjs';
import { COLLECTOR_IDENTITY } from '../../../services/audit/src/manifest.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
// Historical build records retain their original paths; resolve relocated inputs without rewriting evidence.
const buildInput = path => join(root, path.startsWith('engine-bench/') ? `browsers/${path}` : path);
const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${key} requires a value`); return args[i + 1]; };
if (args.includes('--help')) {
  console.log('node browsers/engine-bench/acceptance/authenticity-race.mjs --runtime camoufox|lightpanda|obscura [--output NEW-DIR] [--seed SEED]\nRuns real CLI A1/B1/A2/B2 × two sites × repeat/refresh/new-page, keeps raw output and independent verdicts. Exit 1 means required observations outstanding. No global-population or challenge claim.');
  process.exit(0);
}
const runtime = option('--runtime', 'lightpanda');
if (!['camoufox', 'lightpanda', 'obscura'].includes(runtime)) throw new Error('Unknown runtime');
const output = resolve(option('--output', join(root, 'browsers/engine-bench/.local/authenticity', `${runtime}-${Date.now()}`)));
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: false, mode: 0o700 });
const kit = await harness(root, output), seed = option('--seed', randomUUID()), input = generateAuthenticityInputs(seed);
const sourcePaths = ['browsers/engine-bench/acceptance/authenticity-race.mjs', 'browsers/engine-bench/acceptance/runtime-harness.mjs', 'browsers/engine-bench/scripts/png.mjs', 'services/audit/src/authenticity.mjs', 'services/audit/src/server.mjs', 'services/audit/public/authenticity.html', 'services/audit/public/authenticity-core.js', 'services/audit/public/authenticity-driver.js', 'services/audit/public/authenticity-inputs.cjs', 'services/audit/public/authenticity-frame.html', 'services/audit/public/authenticity-frame.js', 'services/audit/public/authenticity-worker.js', 'cli/anti_trace/native_spec.py', 'cli/anti_trace/native.py', 'cli/anti_trace/identity.py', 'cli/anti_trace/engine.py', 'cli/anti_trace/actions.py'];
if (!COLLECTOR_IDENTITY.available) throw new Error(COLLECTOR_IDENTITY.error);
sourcePaths.push(...COLLECTOR_IDENTITY.sources.map(source => source.path));
const sources = [];
for (const path of [...new Set(sourcePaths)].sort()) {
  const bytes = await readFile(join(root, path)), snapshot = join('sources', path);
  await mkdir(dirname(join(output, snapshot)), { recursive: true, mode: 0o700 });
  await writeFile(join(output, snapshot), bytes, { flag: 'wx', mode: 0o600 });
  sources.push({ path, snapshot, sha256: sha256(bytes) });
}
const run = { schema: 1, suite_version: AUTHENTICITY_MANIFEST.suite_version, run_id: randomUUID(), runtime, seed, input, input_sha256: digest(input), sources, source_sha256: digest(sources), started_at: new Date().toISOString(), host: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, node: process.version }, budgets: { command_timeout_seconds: 150, fixture_timeout_seconds: 100, maximum_raw_response_bytes: 32 * 1024 * 1024, reference_coverage: 'One controlled host. Analytic semantic bounds; no global device-distribution claim.' }, profile_home: kit.home, environments: {}, rows: [], checks: [], failures: [] };
const server = createAuditServer({ dataDir: join(output, 'server-reports') });
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().filter(key => !['png', 'display'].includes(key)).map(key => [key, canonical(value[key])])) : value;
const projection = raw => Object.fromEntries(Object.entries(raw.realms ?? {}).map(([realm, value]) => [realm, { environment: value.environment, ...Object.fromEntries(['canvas', 'audio', 'webgl'].map(feature => [feature, value[feature]?.status === 'ok' ? digest(canonical(value[feature].observed)) : value[feature]?.status])) }]));
const add = (id, condition, detail, observed) => run.checks.push({ id, required: true, status: condition ? 'pass' : 'fail', detail, ...(observed === undefined ? {} : { observed }) });
let port;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
  await save(join(output, 'manifest.json'), AUTHENTICITY_MANIFEST);
  const fontIntervention = ['Verdana', 'Georgia', 'Times New Roman', 'Times', 'Courier New', 'Courier', 'Monaco', 'Palatino', 'Optima', 'Futura', 'Gill Sans', 'Baskerville', 'Avenir', 'Avenir Next', 'Lucida Grande', 'Geneva', 'PingFang SC', 'Hiragino Sans', 'Songti SC', 'Tahoma', 'Trebuchet MS', 'Apple SD Gothic Neo', 'Arial Unicode MS', 'American Typewriter'];
  run.font_intervention = { A: 'Full available host family inventory', B: fontIntervention, fixed: 'seed, non-font configuration, font file assets, runtime, backend and input', default_sans: { A: 'Arial', B: 'Verdana' } };
  for (const environment of ['A', 'B']) {
    const name = `real${environment}`;
    const overrides = { screen_width: 1280, screen_height: 800, device_scale_factor: 1, locale: 'en-US', languages: ['en-US', 'en'], timezone: 'UTC' };
    if (runtime === 'camoufox') overrides.default_sans = environment === 'A' ? 'Arial' : 'Verdana';
    if (environment === 'B') {
      overrides.fonts = fontIntervention.filter(family => run.environments.A.configuration.resolved.fonts.includes(family));
      if (!overrides.fonts.includes('Verdana') || !overrides.fonts.includes('Courier New')) throw new Error('Font intervention requires actual Verdana and Courier New faces');
      run.font_intervention.B = overrides.fonts;
    }
    await kit.call('create', name, '--runtime', runtime, '--seed', digest(`${seed}:controlled-font-intervention`), '--cores', '8', '--allow-private-network', '--overrides', JSON.stringify(overrides), '--json');
    const configurationBytes = await readFile(join(kit.home, 'profiles', name, 'config.json'));
    const configuration = JSON.parse(configurationBytes), binary = configuration.runtime.binary || configuration.runtime.executable;
    const configurationSnapshot = `${environment}.config.json`;
    await writeFile(join(output, configurationSnapshot), configurationBytes, { flag: 'wx', mode: 0o600 });
    run.environments[environment] = { configuration, configuration_snapshot: configurationSnapshot, configuration_sha256: sha256(configurationBytes), artifact_sha256: sha256(await readFile(binary)), executable: binary };
  }
  add('same_runtime_binary', run.environments.A.artifact_sha256 === run.environments.B.artifact_sha256, 'A and B use identical executable bytes.');
  if (runtime !== 'camoufox') {
    const path = `browsers/engine-bench/candidates/${runtime}/current-build.json`;
    const build = JSON.parse(await readFile(join(root, path), 'utf8'));
    const receiptBytes = await readFile(buildInput(build.build_receipt)), receipt = JSON.parse(receiptBytes);
    const artifact = receipt.binary || receipt.artifact;
    const patchSHA = receipt.patch?.sha256 || receipt.input_patch?.sha256;
    const patchMatches = build.patch.sha256 === sha256(await readFile(buildInput(build.patch.path)));
    const rendererMatches = !build.renderer_patch || build.renderer_patch.sha256 === sha256(await readFile(buildInput(build.renderer_patch.path)));
    run.build_provenance = { ...build, receipt, receipt_sha256: sha256(receiptBytes) };
    for (const part of [build.patch, build.renderer_patch].filter(Boolean)) {
      const bytes = await readFile(buildInput(part.path)), snapshot = `source-${sha256(bytes)}.patch`;
      try { await writeFile(join(output, snapshot), bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      part.snapshot = snapshot;
    }
    add('native_build_binding', build.runtime === runtime && build.artifact.sha256 === run.environments.A.artifact_sha256 && artifact?.sha256 === build.artifact.sha256 && patchSHA === build.patch.sha256 && patchMatches && rendererMatches, 'Measured executable, pinned source commit, runtime/shared-renderer patches and successful build receipt are bound together.');
  }
  for (const phase of ['A1', 'B1', 'A2', 'B2']) {
    const environment = phase[0], name = `real${environment}`;
    try {
      await kit.call('start', name, '--headless', '--url', 'about:blank', '--json');
      for (const site of ['http://127.0.0.1', 'http://localhost']) {
        for (const lifecycle of ['initial', 'repeat', 'refresh', 'new_page']) {
          const id = randomUUID(), url = `${site}:${port}/authenticity.html?context=navigation&run_id=${id}`;
          const row = { phase, environment, site, lifecycle, run_id: id, input_sha256: run.input_sha256, configuration_sha256: run.environments[environment].configuration_sha256, artifact_sha256: run.environments[environment].artifact_sha256 };
          run.rows.push(row);
          try {
            if (lifecycle === 'initial') await kit.call('exec', name, 'goto', url, '--json');
            if (lifecycle === 'refresh') {
              await kit.call('exec', name, 'eval', `history.replaceState(null,'',${JSON.stringify(url)})`, '--json');
              await kit.call('exec', name, 'reload', '--json');
            }
            if (lifecycle === 'new_page') { const tab = await kit.call('exec', name, 'tab_new', url, '--json'); if (!Number.isInteger(tab.index)) throw new Error('tab_new omitted real index'); await kit.call('exec', name, 'use', String(tab.index), '--json'); }
            const request_id = randomUUID(), request = { request_id, options: { seed, input, run_id: id } };
            const expression = `(async()=>{const end=Date.now()+100000;while(!document.getElementById('authenticity-output')){if(Date.now()>end)throw new Error('fixture load timeout');await new Promise(r=>setTimeout(r,25))}document.documentElement.setAttribute('data-authenticity-request',${JSON.stringify(JSON.stringify(request))});document.dispatchEvent(new Event('authenticity-collect'));const out=document.getElementById('authenticity-output');while(Date.now()<end){if(out.getAttribute('data-request-id')===${JSON.stringify(request_id)}&&out.getAttribute('data-status')==='complete'){const result=JSON.parse(out.textContent);if(result.error)throw new Error(result.error);return result}await new Promise(r=>setTimeout(r,25))}throw new Error('authenticity fixture timeout')})()`;
            const raw = (await kit.call('exec', name, 'eval', expression, '--timeout', '110000', '--json')).result;
            if (!raw || typeof raw !== 'object' || raw.run_id !== id || raw.suite_version !== run.suite_version || digest(raw.input) !== run.input_sha256) throw new Error('Raw fixture input/version/observation binding mismatch');
            const filename = `${phase}-${new URL(site).hostname}-${lifecycle}.raw.json`;
            await save(join(output, filename), raw);
            row.raw_path = filename; row.raw_sha256 = digest(raw); row.projection = projection(raw);
            row.verdict = evaluateAuthenticity(raw);
            const marker = `${run.run_id}:${environment}:${site}`, write = phase.endsWith('1') && lifecycle === 'initial';
            const storageExpression = `(async()=>{const key='authenticity-persistence', expected=${JSON.stringify(marker)}, write=${JSON.stringify(write)};const cookie=()=>{const entry=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith(key+'='));return entry?decodeURIComponent(entry.slice(key.length+1)):null};const prior={cookie:cookie(),local:localStorage.getItem(key)};const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(key,1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const get=()=>new Promise((resolve,reject)=>{const r=db.transaction('values','readonly').objectStore('values').get('marker');r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error)});prior.idb=await get();if(write){document.cookie=key+'='+encodeURIComponent(expected)+'; Path=/; Max-Age=86400; SameSite=Lax';localStorage.setItem(key,expected);await new Promise((resolve,reject)=>{const t=db.transaction('values','readwrite');t.objectStore('values').put(expected,'marker');t.oncomplete=resolve;t.onerror=()=>reject(t.error)})}const result={prior,cookie:cookie(),local:localStorage.getItem(key),idb:await get()};db.close();return result})()`;
            row.storage = (await kit.call('exec', name, 'eval', storageExpression, '--json')).result;
            add(`storage/${phase}/${site}/${lifecycle}`, !!row.storage && ['cookie', 'local', 'idb'].every(key => row.storage[key] === marker) && (!write || Object.values(row.storage.prior).every(value => value === null)), 'Independent per-environment and per-site committed Cookie/LocalStorage/IndexedDB markers survive repeated reads, reload, new page and restart.', row.storage);
            row.server_evidence = await (await fetch(`http://127.0.0.1:${port}/api/echo/events?run_id=${id}`)).json();
            const expectedUA = run.environments[environment].configuration.resolved?.user_agent;
            const metadata = raw.realms?.window?.environment;
            const receipts = row.server_evidence.receipts.filter(r => r.headers?.['user-agent']);
            const workerAvailable = !!raw.realms?.worker?.environment;
            const realms = ['window', 'iframe', ...(workerAvailable ? ['worker'] : [])].map(realm => raw.realms?.[realm]?.environment);
            const contexts = ['fetch', ...(workerAvailable ? ['worker'] : []), ...(lifecycle !== 'repeat' ? ['navigation'] : [])];
            const brandList = value => [...String(value || '').matchAll(/"([^"]+)";v="([^"]+)"/g)].map(match => ({ brand: match[1], version: match[2] }));
            const allCoherent = metadata && expectedUA && row.server_evidence.run_id === id && contexts.every(context => receipts.some(receipt => receipt.run_id === id && receipt.context === context)) && realms.every(value => value?.user_agent === expectedUA && value.language === run.environments[environment].configuration.resolved.locale && value.platform === metadata.platform && digest(value.user_agent_data) === digest(metadata.user_agent_data)) && receipts.every(receipt => {
              const headers = receipt.headers, data = metadata.user_agent_data;
              return headers['user-agent'] === expectedUA && (data ? digest(brandList(headers['sec-ch-ua'])) === digest(data.brands) && headers['sec-ch-ua-platform'] === JSON.stringify(data.platform) && headers['sec-ch-ua-mobile'] === (data.mobile ? '?1' : '?0') : !headers['sec-ch-ua']);
            });
            add(`declarations/${phase}/${site}/${lifecycle}`, allCoherent, 'Persisted UA and locale agree across Window/iframe/Worker and independent server receipts; JS and wire brands/platform/mobile agree.', { expected: expectedUA, environment: metadata, receipts });
            if (lifecycle === 'initial') {
              const image = `${phase}-${new URL(site).hostname}.png`;
              await kit.call('exec', name, 'screenshot', join(output, image), '--json');
              const imageBytes = await readFile(join(output, image)), decoded = decodePNG(imageBytes);
              row.screenshot = { path: image, sha256: sha256(imageBytes), ...pngPixels(imageBytes) };
              const colors = input.canvas.colors, box = raw.realms?.window?.canvas?.observed?.regions?.display?.css_box;
              const dpr = metadata?.dpr;
              const samples = box && Number.isFinite(dpr) ? [5, 15, 25].map((x, band) => {
                const px = Math.floor((box.x + (x + .5) * box.width / 32) * dpr), py = Math.floor((box.y + box.height / 2) * dpr), at = (py * decoded.width + px) * decoded.channels;
                const rgb = decoded.color_type === 0 || decoded.color_type === 4 ? [decoded.pixels[at], decoded.pixels[at], decoded.pixels[at]] : [...decoded.pixels.subarray(at, at + 3)];
                return { x: px, y: py, rgb, expected: colors[band].slice(0, 3), in_bounds: px >= 0 && py >= 0 && px < decoded.width && py < decoded.height };
              }) : [];
              add(`display_readback/${phase}/${site}`, samples.length === 3 && samples.every(sample => sample.in_bounds && sample.rgb.length === 3 && sample.rgb.every((n, i) => Math.abs(n - sample.expected[i]) <= 2)), 'Independently decoded real viewport pixels match commanded Canvas bands at screen locations.', samples);
            }
          } catch (error) { row.error = error.message; run.failures.push({ phase, site, lifecycle, error: error.message }); }
        }
      }
    } finally { await kit.call('stop', name, '--json'); }
  }
  for (const environment of ['A', 'B']) {
    const rows = run.rows.filter(row => row.environment === environment);
    add(`coverage/${environment}`, rows.length === 16 && rows.every(row => row.projection && !row.error), 'Sixteen actual same-environment observations across two sites, four lifecycle states and two cold processes.');
    for (const realm of ['window', 'iframe', 'worker']) for (const feature of ['canvas', 'audio', 'webgl']) {
      const values = rows.map(row => row.projection?.[realm]?.[feature]);
      const intended = realm !== 'worker' || feature !== 'audio';
      if (!intended) continue;
      const supported = values.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
      const conditionallyAbsent = realm === 'worker' && values.every(value => value === 'unsupported');
      run.checks.push({ id: `stability/${environment}/${realm}/${feature}`, required: !conditionallyAbsent, status: conditionallyAbsent ? 'unsupported' : supported ? values.every(value => value === values[0]) ? 'pass' : 'fail' : 'not_tested', detail: 'Real output projection excludes PNG encoding and display metadata; unsupported Worker paths retain their status and declared optional scope.' });
    }
    const current = sha256(await readFile(join(kit.home, 'profiles', `real${environment}`, 'config.json')));
    add(`configuration_stable/${environment}`, current === run.environments[environment].configuration_sha256, 'Launch/read/reload/new page/restart never regenerates configuration.');
  }
  for (const round of ['1', '2']) for (const site of ['http://127.0.0.1', 'http://localhost']) {
    const a = run.rows.find(row => row.phase === 'A' + round && row.site === site && row.lifecycle === 'initial');
    const b = run.rows.find(row => row.phase === 'B' + round && row.site === site && row.lifecycle === 'initial');
    const read = async row => row?.raw_path ? JSON.parse(await readFile(join(output, row.raw_path), 'utf8')) : null;
    const ar = await read(a), br = await read(b);
    const text = value => value?.realms?.window?.canvas?.observed?.text?.pixels;
    const actualA = text(ar), actualB = text(br);
    const ca = run.environments.A.configuration, cb = run.environments.B.configuration;
    const withoutFonts = config => Object.fromEntries(Object.entries(config.resolved).filter(([key]) => !['fonts', 'default_sans'].includes(key)));
    const controlled = ca.seed === cb.seed && digest(withoutFonts(ca)) === digest(withoutFonts(cb)) && digest(ca.asset_paths) === digest(cb.asset_paths) && digest(ca.resolved.fonts) !== digest(cb.resolved.fonts);
    add(`differentiation/text/${round}/${site}`, controlled && Array.isArray(actualA) && Array.isArray(actualB) && digest(actualA) !== digest(actualB), 'Predeclared font intervention: identical seed, non-font resolved configuration, font file assets, executable, backend, DPR and inputs; only supported font selection/default differs. Text pixels must change. Physical Audio/geometry/GL equality remains visible.', { a: actualA ? digest(actualA) : null, b: actualB ? digest(actualB) : null, controlled, cause: { a_fonts: ca.resolved.fonts, b_fonts: cb.resolved.fonts, a_font_metrics: ar?.realms?.window?.canvas?.observed?.text?.metrics, b_font_metrics: br?.realms?.window?.canvas?.observed?.text?.metrics, asset_a: ca.assets, asset_b: cb.assets } });
  }
} catch (error) { run.failures.push({ error: error.message }); }
finally {
  for (const environment of Object.keys(run.environments)) try { await kit.call('stop', `real${environment}`, '--json'); } catch (error) { run.failures.push({ cleanup: environment, error: error.message }); }
  for (const source of sources) {
    try { add(`source_unchanged/${source.path}`, sha256(await readFile(join(root, source.path))) === source.sha256, 'Collector, fixture, judge and adapter sources remain unchanged during this observation.'); }
    catch (error) { add(`source_unchanged/${source.path}`, false, error.message); }
  }
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  try {
    for (const environment of Object.keys(run.environments)) await kit.call('rm', `real${environment}`, '--json');
    await rm(kit.home, { recursive: true });
    run.profile_cleanup = 'removed owned synthetic profiles after stop; exact configurations retained in evidence';
  } catch (error) { run.failures.push({ cleanup: kit.home, error: error.message }); }
  run.finished_at = new Date().toISOString(); run.commands = kit.commands;
  run.coverage = { cells: run.rows.length, expected_cells: 32, judge_passed: run.rows.filter(row => row.verdict?.overall === 'pass').length, local_checks: run.checks.length, local_passed: run.checks.filter(check => check.status === 'pass').length };
  run.overall = !run.failures.length && run.rows.length === 32 && run.rows.every(row => row.verdict?.overall === 'pass') && run.checks.filter(check => check.required).every(check => check.status === 'pass') ? 'PASS' : 'NOT_PASS';
  await save(join(output, 'report.json'), run);
  console.log(JSON.stringify({ output, runtime, overall: run.overall, coverage: run.coverage, failures: run.failures }));
  process.exitCode = run.overall === 'PASS' ? 0 : 1;
}
