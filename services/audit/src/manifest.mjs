import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pngPixels } from '../../../browsers/engine-bench/scripts/png.mjs';
import { productObservations } from './product-evidence.mjs';
import { artifactVerifier } from './artifact-evidence.mjs';

export const SUITE_VERSION = '2026.11.04.4';
export const STATES = Object.freeze(['pass', 'fail', 'unsupported', 'error', 'not_tested', 'review_required']);
const feature = (id, input, comparison, scope = 'page') => ({ id, required: true, scope, input, comparison });
export const RUNTIMES = Object.freeze(['camoufox', 'obscura', 'lightpanda']);
export const PRODUCT_SCENARIOS = Object.freeze([
  ['E1', 'Ordinary redirects and missing observations', 'redirect_reached,timeout_error,missing_not_tested'],
  ['E2', 'Challenge evidence and human review', 'http_phase_separation,verified_clearance,redacted_review_timeline'],
  ['E3', 'Independent and full-scope checks', 'independent_inputs,all_required_apis,two_schemeful_sites'],
  ['I1', 'Two environments across lifecycles', 'A1_B1_A2_B2,all_identity_components,png_and_pixels'],
  ['I2', 'Realms overrides and uniqueness conflicts', 'first_script_all_realms,request_config,invalid_config,identity_collision,locale_override'],
  ['I3', 'Upgrade or cross-host restore', 'compatibility_preflight,explicit_migration,revision_retention,storage_rollback'],
  ['C1', 'Graphic and audio functionality', 'multiscript_text,geometry,shader_execution,audio_graph,objects_errors_scheduling'],
  ['C2', 'Header and network contract', 'navigation_fetch_resources_redirect_worker,http_https_protocols,policy_unknown_review'],
  ['C3', 'Worker global semantics', 'worker_brand,no_window_document,independent_global,async_message,termination'],
  ['L1', 'Concurrent start and crash', 'three_callers_one_lock,ready_after_init,crash_identity_recovery,environment_isolation'],
  ['L2', 'Persistent storage and archive', 'cookie_ls_idb_restart,cold_export_restore,cross_environment_absence,busy_export,unsafe_archive,credential_policy,session_storage'],
  ['G1', 'Human handover and resume', 'same_live_pixels,mouse_keyboard_focus_scroll_text_tabs,safe_write_boundary,explicit_resume,values_retained'],
  ['G2', 'Stale reference or disconnected viewer', 'dom_navigation_frame_page_staleness,disconnect_paused,explicit_reclaim,coordinate_input,ime_composition'],
  ['A1', 'Branch and loop with failure', 'one_session_roundtrip,branch_loop_locator_wait,json_result,source_location,completed_operations,side_effect_uncertainty,stop_after_failure'],
  ['A2', 'Bounded observation and cancellation', 'bounded_output_screenshots,deadline_cancel,axtree_coverage_masking,human_pause,external_browser_survives'],
  ['N1', 'Proxy failure and DNS coverage', 'proxy_before_access,no_direct_fallback,network_unavailable,dns_ipv4_ipv6_webrtc_udp,protocol_and_egress'],
  ['N2', 'Network and engine attribution', 'randomized_repeats,engine_mode_egress_profile_time,exit_controlled_attribution'],
  ['T1', 'Verified Turnstile attempt', 'siteverify_success_host_action_nonce_expiry,atomic_consume,replay_reject,service_error,run_bound_receipt'],
  ['T2', 'Deployment and public report safety', 'account_resource_scope,snapshot_rollback,production_unchanged,public_redaction,missing_credentials,public_overview'],
  ['K1', 'Comparable customization trial', 'source_toolchain_pins,patches,cdp_client_traces,clean_incremental_builds,dependency_license_review,remaining_effort,adapter_isolation'],
  ['K2', 'Performance and selection gate', 'identical_dom_js,identical_visual,cold_warm,ten_raw_samples,median_p95_cpu_tree_rss,resources_ipc_bytes,same_host,no_premature_winner'],
  ['K3', 'Release evidence and maintenance', 'reproducible_build,dependency_license_inventory,security_sandbox_review,clean_install_cli,human_gui_signoff,identity_matrix,regression_artifacts,own_release'],
].map(([id, title, obligations]) => Object.freeze({ id, title, required: true, obligations: obligations.split(','), sources: ['server', 'process', 'reviewer'] })));
export const MANIFEST = Object.freeze({
  schema: 2, suite_version: SUITE_VERSION,
  states: STATES, completion: 'Every required check must pass; scores never waive outstanding gates.',
  sources: ['browser', 'server', 'process', 'reviewer'],
  phases: ['A1', 'B1', 'A2', 'B2'], lifecycles: ['initial', 'repeat', 'refresh', 'new_page'],
  sites: ['http://127.0.0.1', 'http://localhost'],
  site_policy: 'Two distinct schemeful sites, not two ports. Loopback sites are controlled local evidence, not public-network or anti-bot evidence.',
  features: [
    feature('canvas_text', 'Multi-script text and changed text; decoded RGBA and PNG bytes separately.', 'stable_and_different'),
    feature('canvas_geometry', 'Transformed filled geometry and changed rotation; decoded RGBA and PNG separately.', 'stable_and_different'),
    feature('audio', 'Offline sine oscillator at independently selected frequency, doubled frequency, half gain and disconnected graph.', 'stable_and_different'),
    feature('webgl', 'Compile/link shaders, draw two uniform colors, read RGBA, collect identifier and parameters.', 'stable_and_different_each_component'),
    feature('fonts', 'Multiple script text width in explicit generic and named font families.', 'stable_and_different'),
    feature('screen', 'Screen dimensions, DPR and window geometry.', 'stable_and_different'),
    feature('cores', 'navigator.hardwareConcurrency.', 'stable_and_different'),
    feature('worker', 'Server-served Worker challenge, navigator/HTTP parity and document/window absence with Worker-global brand.', 'coherent', 'worker'),
    feature('iframe', 'Same-origin iframe challenge and navigator parity.', 'coherent', 'iframe'),
    feature('headers', 'Independent server-observed navigation/fetch/subresource/Worker/redirect headers.', 'coherent', 'server'),
    feature('persistence', 'Committed Cookie, LocalStorage and IndexedDB fixture through restart, isolated A/B and sites.', 'durable_and_isolated', 'environment'),
  ],
  external_required: ['gui_real_image_input', 'https_h2_network_context', 'public_network_egress', 'challenge_receipt', 'human_gui_signoff'],
  product_scenarios: PRODUCT_SCENARIOS,
  evidence_contract: { raw: 'Immutable schema=2 envelope; runtime artifact, environment configuration, run/race, input generation and every row are digest-bound. Producer statuses never establish pass.', verdict: 'Separate new JSON, preserving original versions and file bytes.', external: 'Separate harness-owned process/server/file artifacts, never browser product claims or user-set approvals. Scenario evaluators derive outcomes from raw observations with exact source/run/runtime/config/input binding. Human, challenge, security/legal and upgrade reviews remain pending without genuine independent evidence.' },
});
export const digest = value => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const collectorPaths = [
  'browsers/engine-bench/acceptance/camoufox-cli.mjs', 'browsers/engine-bench/acceptance/product-collector.mjs',
  'browsers/engine-bench/acceptance/archive-evidence.mjs', 'browsers/engine-bench/acceptance/scenario-events.mjs',
  'browsers/engine-bench/acceptance/process-evidence.mjs',
  'browsers/engine-bench/acceptance/selected-target.mjs', 'browsers/engine-bench/acceptance/proxy-fixture.mjs',
  'cli/bin/anti-trace', 'cli/pyproject.toml', 'cli/uv.lock',
  'browsers/engine-bench/scripts/png.mjs', 'services/audit/src/manifest.mjs',
  'services/audit/src/product-evidence.mjs', 'services/audit/src/artifact-evidence.mjs', 'services/audit/src/server.mjs',
  'services/audit/public/acceptance.html', 'services/audit/public/acceptance.js',
  'services/audit/public/acceptance-worker.js', 'services/audit/public/acceptance-frame.html',
  'services/audit/public/acceptance-frame.js', 'services/audit/public/acceptance-driver.js',
  'services/audit/public/acceptance-product.html', 'services/audit/public/acceptance-product-first.js',
  'services/audit/public/acceptance-first-worker.js', 'services/audit/public/acceptance-first-frame.html',
  'services/audit/public/acceptance-first-frame.js',
];
function productionSources(directory, include) {
  return readdirSync(fileURLToPath(new URL(`../../../${directory}`, import.meta.url)), { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__pycache__' || entry.name.startsWith('.')) return [];
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return productionSources(path, include);
    if (entry.isSymbolicLink() && include(path)) throw new Error(`Unresolved production source symlink: ${path}`);
    return entry.isFile() && include(path) ? [path] : [];
  });
}
function collectorIdentity() {
  try {
    const paths = [...new Set([...collectorPaths,
      ...productionSources('cli/anti_trace', path => path.endsWith('.py')),
      ...productionSources('cli/anti_trace/public', () => true),
    ])].sort();
    const sources = paths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)))).digest('hex') }));
    return Object.freeze({ available: true, sources, sha256: digest(sources) });
  } catch (error) { return Object.freeze({ available: false, sources: [], sha256: null, error: `Collector source unavailable: ${error.message}` }); }
}
export const COLLECTOR_IDENTITY = collectorIdentity();
export function generateInputs(seed) {
  if (typeof seed !== 'string' || !seed.length) throw new Error('Input seed must be a non-empty string');
  const bytes = createHash('sha256').update(`acceptance-input-v1:${seed}`).digest();
  return { challenge: 10000 + bytes.readUInt32BE(0) % 90000, frequency: 280 + bytes.readUInt16BE(4) % 341, rotation: (20 + bytes[6] % 70) / 100, color: [30 + bytes[7] % 70, 110 + bytes[8] % 70, 190 + bytes[9] % 45, 255], text: `Probe ${bytes.subarray(10, 18).toString('hex')} 你好 Ω مرحبا` };
}
export const generateCreationInputs = seed => Object.fromEntries(['A', 'B'].map(id => [id, { seed: digest(`${seed}:environment:${id}`) }]));
export const workloadFor = (seed, coresA = '8', coresB = '12') => ({ phases: MANIFEST.phases, sites: MANIFEST.sites, lifecycles: MANIFEST.lifecycles, features: MANIFEST.features.map(f => f.id), product_scenarios: PRODUCT_SCENARIOS.map(s => s.id), cores_a: coresA, cores_b: coresB, fonts_b: 'subset:24', mode: 'headless', allow_private_network: true, creation_inputs: generateCreationInputs(seed) });
export function generateInputVariants(input) {
  const variants = [
    { id: 'canvas_text', base: input.text, variant: input.text + ' changed' },
    { id: 'canvas_geometry', base: input.rotation, variant: input.rotation + .37 },
    { id: 'audio_frequency', base: input.frequency, variant: input.frequency * 2 },
    { id: 'audio_graph', gain: [.2, .1], connected: [true, false], stop_at_seconds: [null, 0] },
    { id: 'shader_color', base: input.color, variant: input.color.map((n, i) => i === 3 ? n : 255 - n) },
    { id: 'worker_challenge', base: input.challenge, isolated: input.challenge + 1 },
  ];
  return variants.map(value => ({ ...value, sha256: digest(value) }));
}
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function bindingValid(evidence) {
  return evidence.schema === 2 && RUNTIMES.includes(evidence.runtime?.id) && sha256(evidence.runtime?.artifact_sha256)
    && typeof evidence.race_id === 'string' && evidence.race_id.length > 0 && typeof evidence.run_id === 'string' && evidence.run_id.length > 0
    && ['A', 'B'].every(id => sha256(evidence.environments?.[id]?.sha256))
    && COLLECTOR_IDENTITY.available && evidence.collector_sha256 === COLLECTOR_IDENTITY.sha256 && evidence.input_digest === digest(evidence.inputs)
    && evidence.input_generation?.version === 1 && typeof evidence.input_generation.seed === 'string' && evidence.input_generation.seed.length > 0 && eq(generateInputs(evidence.input_generation.seed), evidence.inputs)
    && eq(evidence.input_variants, generateInputVariants(evidence.inputs)) && evidence.input_variants_digest === digest(evidence.input_variants)
    && sha256(evidence.workload_digest) && evidence.workload_digest === digest(evidence.workload)
    && eq(evidence.creation_inputs, generateCreationInputs(evidence.input_generation.seed))
    && eq(evidence.workload, workloadFor(evidence.input_generation.seed, evidence.workload?.cores_a, evidence.workload?.cores_b));
}
function evaluateProduct(scenario, evidence, records, now, checks, verifyArtifact) {
  const candidates = records.filter(row => row?.case_id === scenario.id);
  if (!candidates.length) return { status: 'not_tested', detail: 'No harness-owned product observations; page scores do not establish this scenario.', obligations: scenario.obligations.map(id => ({ id, status: 'not_tested' })) };
  const invalid = (status, detail) => ({ status, detail, obligations: scenario.obligations.map(id => ({ id, status })) });
  if (candidates.length !== 1) return invalid('error', 'Duplicate product evidence is ambiguous.');
  const record = candidates[0];
  if (!bindingValid(evidence) || evidence.suite_version !== SUITE_VERSION || record.schema !== 1 || record.suite_version !== SUITE_VERSION
    || record.source !== 'process' || record.run_id !== evidence.run_id || record.race_id !== evidence.race_id
    || record.runtime_id !== evidence.runtime.id || record.runtime_digest !== evidence.runtime.artifact_sha256
    || record.input_digest !== evidence.input_digest || !eq(record.environment_digests, evidence.environments)
    || record.collector_sha256 !== evidence.collector_sha256) return invalid('not_tested', 'Harness suite/run/runtime/configuration/input/collector binding mismatch.');
  const observed = Date.parse(record.observed_at), finished = Date.parse(evidence.finished_at);
  if (!Number.isFinite(observed) || !Number.isFinite(finished) || observed > now || now - observed > 7 * 86400000 || observed < Date.parse(evidence.started_at) || observed > finished) return invalid('not_tested', 'Harness product evidence is stale or outside this collection.');
  if (!Array.isArray(record.artifacts) || !record.artifacts.length || !record.artifacts.every(a => a && typeof a.id === 'string' && sha256(a.sha256) && a.content !== undefined && a.sha256 === digest(a.content))) return invalid('error', 'Missing or corrupt content-addressed harness artifacts.');
  const events = record.artifacts.flatMap(a => a.content?.events ?? []);
  const names = new Set();
  for (const event of events) {
    if (!event || typeof event.name !== 'string' || names.has(event.name) || !['process','server','file'].includes(event.source)) return invalid('error', 'Ambiguous or browser-supplied product observation.');
    names.add(event.name);
    if (event.content?.raw_artifact && !verifyArtifact(event.content.raw_artifact)) return invalid('error', 'A required raw artifact is missing, outside the fixture roots, stale or hash-mismatched.');
    if (event.content?.raw_artifacts !== undefined && (!Array.isArray(event.content.raw_artifacts) || !event.content.raw_artifacts.every(verifyArtifact))) return invalid('error', 'A required snapshot artifact is missing or hash-mismatched.');
    if (event.source === 'process') {
      const ledger = Array.isArray(evidence.commands) ? evidence.commands.filter(row => row && row.sequence === event.sequence) : [];
      if (ledger?.length !== 1 || !eq(event.args, ledger[0].args) || event.exit_code !== ledger[0].exit_code
        || event.started_at !== ledger[0].started_at || event.finished_at !== ledger[0].finished_at
        || typeof event.stdout !== 'string' || typeof event.stderr !== 'string'
        || createHash('sha256').update(event.stdout).digest('hex') !== ledger[0].stdout_sha256
        || createHash('sha256').update(event.stderr).digest('hex') !== ledger[0].stderr_sha256) return invalid('error', 'Product process output is not bound to its actual CLI command receipt.');
    } else if (event.source === 'server') {
      if (!Number.isInteger(event.http_status) || typeof event.request?.path !== 'string' || !event.request.path.startsWith('/api/') || typeof event.stdout !== 'string') return invalid('error', 'Product server observation lacks its harness request/response context.');
    } else if (event.content === undefined || event.stdout !== undefined) return invalid('error', 'File observations cannot substitute unbound process output.');
  }
  let observations;
  try { observations = productObservations(scenario.id, events, evidence, checks); }
  catch (error) { return invalid('error', `Malformed harness product observations: ${error.message}`); }
  const obligations = scenario.obligations.map(id => ({ id, ...(observations[id] ?? { status: 'not_tested', detail: 'No current independent observation for this obligation.' }) }));
  const outstanding = obligations.filter(row => row.status !== 'pass');
  const status = ['error', 'fail', 'unsupported', 'review_required', 'not_tested'].find(s => outstanding.some(row => row.status === s)) ?? 'pass';
  return { status, detail: outstanding.length ? `${outstanding.length}/${obligations.length} scenario obligations remain outstanding.` : 'All scenario obligations independently derived from this run’s harness observations.', obligations };
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const numbers = a => Array.isArray(a) && a.length > 0 && a.every(finite);
const siteKey = value => { const u = new URL(value); if (!['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('Unregistered controlled site'); return `${u.protocol}//${u.hostname}`; };
const identity = (id, v) => {
  if (id.startsWith('canvas_')) return v.base?.pixels;
  if (id === 'audio') return v.base?.samples;
  if (id === 'webgl') return { identifier: v.identifier, parameters: v.parameters, pixels: v.base };
  if (id === 'screen') return { width: v.width, height: v.height, dpr: v.dpr };
  return v;
};
const nearPixel = (a, b) => numbers(a) && a.length === 4 && a.every((v, i) => Math.abs(v - b[i]) <= 3);
function canvasSample(sample, width, height) {
  if (!numbers(sample?.pixels) || sample.pixels.length !== width * height * 4 || !sample.pixels.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    || typeof sample.png !== 'string' || !sample.png.startsWith('data:image/png;base64,') || sample.png.length > 4 * 1024 * 1024) return false;
  const decoded = pngPixels(Buffer.from(sample.png.slice('data:image/png;base64,'.length), 'base64'));
  if (decoded.width !== width || decoded.height !== height || sample.width !== width || sample.height !== height) return false;
  if ([0, 4].includes(decoded.color_type) && sample.pixels.some((n, i) => i % 4 < 3 && n !== sample.pixels[i - i % 4])) return false;
  const channels = sample.pixels.filter((_, i) => decoded.color_type === 6 || (decoded.color_type === 2 && i % 4 !== 3) || (decoded.color_type === 0 && i % 4 === 0) || (decoded.color_type === 4 && [0, 3].includes(i % 4)));
  return decoded.decoded_pixels_sha256 === createHash('sha256').update(Buffer.from(channels)).digest('hex');
}
function controls(id, v, input, run) {
  if (!v || typeof v !== 'object') return false;
  if (id.startsWith('canvas_')) {
    const [width, height] = id === 'canvas_text' ? [192, 64] : [64, 32];
    return [v.base, v.variant].every(x => canvasSample(x, width, height)) && !eq(v.base.pixels, v.variant.pixels) && v.base.pixels.some((n, i) => i % 4 !== 3 && n !== 255);
  }
  if (id === 'audio') {
    if (![v.base, v.frequency, v.gain, v.disconnected].every(x => numbers(x?.samples) && x.samples.length === 4096 && x.sample_rate === 44100)) return false;
    const rms = x => Math.sqrt(x.samples.reduce((sum, n) => sum + n * n, 0) / x.samples.length);
    const hz = x => x.samples.slice(1).reduce((sum, n, i) => sum + ((n >= 0) !== (x.samples[i] >= 0) ? 1 : 0), 0) * 44100 / (2 * x.samples.length);
    return Math.abs(hz(v.base) - input.frequency) < 20 && Math.abs(hz(v.frequency) - input.frequency * 2) < 20 && rms(v.base) > .1 && Math.abs(rms(v.gain) / rms(v.base) - .5) < .05 && rms(v.disconnected) < .00001 && !eq(v.base.samples, v.frequency.samples);
  }
  if (id === 'webgl') return v.compile === true && v.link === true && v.objects_valid === true && v.invalid_enum_error === 1280 && v.error === 0 && nearPixel(v.base, input.color) && nearPixel(v.variant, input.color.map((n, i) => i === 3 ? n : 255 - n)) && typeof v.identifier === 'string' && numbers(v.parameters);
  if (id === 'fonts') return Array.isArray(v.measurements) && v.measurements.length >= 4 && v.measurements.every(x => typeof x.font === 'string' && finite(x.width) && x.width > 0);
  if (id === 'screen') return ['width', 'height', 'dpr', 'inner_width', 'inner_height'].every(k => finite(v[k]) && v[k] > 0);
  if (id === 'cores') return Number.isInteger(v.cores) && v.cores > 0;
  if (id === 'worker' || id === 'iframe') return v.challenge === input.challenge && v.answer === input.challenge * 7 && ['user_agent', 'language', 'platform', 'cores'].every(k => v.main?.[k] !== undefined && eq(v.main[k], v.child?.[k])) && (id !== 'worker' || (v.http?.headers?.['user-agent'] === v.child.user_agent && v.realm?.document_type === 'undefined' && v.realm?.window_type === 'undefined' && v.realm?.worker_global === true && v.asynchronous === true && v.isolated === true && v.terminated === true && eq(v.scheduling, ['sync', 'microtask', 'timer'])));
  if (id === 'headers') {
    const contexts = ['navigation', 'fetch', 'subresource', 'worker', 'redirect'];
    return run.server_evidence?.source === 'server' && eq(run.server_evidence.receipts, v.receipts) && typeof v.language === 'string' && contexts.every(context => v.receipts?.some(r => r.source === 'server' && r.context === context && r.run_id === run.run_id && r.headers?.['user-agent'] === v.user_agent && r.headers?.['accept-language']?.split(',')[0].split(';')[0].trim().toLowerCase() === v.language.toLowerCase()));
  }
  if (id === 'persistence') return ['cookie', 'local_storage', 'indexed_db'].every(k => v[k] === `${run.environment}:${siteKey(run.site)}:${input.challenge}`) && v.prior_absent === true;
  return false;
}
export function evaluateAcceptance(evidence, { productEvidence = [], now = Date.now() } = {}) {
  evidence = evidence && typeof evidence === 'object' ? evidence : {};
  const runsValid = Array.isArray(evidence.runs);
  const runs = runsValid ? evidence.runs.filter(r => r && typeof r === 'object') : [];
  const checks = [], add = (id, status, detail, extra = {}) => checks.push({ id, required: true, status, outstanding: status !== 'pass', detail, ...extra });
  const versionOK = evidence.schema === 2 && evidence.suite_version === SUITE_VERSION;
  add('suite_version', versionOK ? 'pass' : 'not_tested', `Source suite ${evidence.suite_version ?? 'unknown'}; target ${SUITE_VERSION}. Historical evidence is not silently upgraded.`);
  const bound = bindingValid(evidence);
  const started = Date.parse(evidence.started_at), finished = Date.parse(evidence.finished_at);
  const fresh = Number.isFinite(started) && Number.isFinite(finished) && started <= finished && finished <= now && now - finished <= 7 * 86400000;
  add('evidence_bindings', bound ? 'pass' : 'not_tested', 'Pinned runtime, A/B configuration digests, deterministic input seed/digest, collector and run identity are required.');
  add('evidence_freshness', fresh ? 'pass' : 'not_tested', 'Completed observations must be current (at most seven days), chronological and not future-dated.');
  const validRun = r => bound && r.runtime_id === evidence.runtime.id && r.runtime_digest === evidence.runtime.artifact_sha256 && r.input_digest === evidence.input_digest && r.environment_digest === evidence.environments?.[r.environment]?.sha256 && r.collection_run_id === evidence.run_id && r.suite_version === SUITE_VERSION && typeof r.run_id === 'string' && r.run_id.length > 0 && !r.collection_error;
  add('collector_integrity', evidence.collection_error || !runsValid || runs.length !== MANIFEST.phases.length * MANIFEST.sites.length * MANIFEST.lifecycles.length || runs.length !== evidence.runs.length || runs.some(r => !validRun(r) || !MANIFEST.phases.includes(r.phase) || r.environment !== r.phase[0] || !MANIFEST.lifecycles.includes(r.lifecycle)) ? 'error' : 'pass', evidence.collection_error || 'Every collected row must be bound and in the identical full matrix; collection errors cannot become API success.');
  const eligible = versionOK && bound && fresh && !evidence.collection_error;
  const inputOK = bound && Number.isInteger(evidence.inputs?.challenge) && Number.isInteger(evidence.inputs?.frequency) && evidence.inputs.frequency >= 250 && evidence.inputs.frequency <= 650 && numbers(evidence.inputs?.color) && evidence.inputs.color.length === 4 && evidence.inputs.color[3] === 255 && typeof evidence.inputs?.text === 'string' && finite(evidence.inputs?.rotation);
  add('controlled_inputs', inputOK ? 'pass' : 'not_tested', 'Independent harness input retained; missing inputs are never invented.');
  const sites = [...new Set(runs.flatMap(r => { try { return [siteKey(r.site)]; } catch { return []; } }))];
  add('two_schemeful_sites', sites.length === 2 && MANIFEST.sites.every(s => sites.includes(s)) ? 'pass' : 'not_tested', 'Registered sites http://127.0.0.1 and http://localhost are required; ports do not distinguish sites.');
  for (const phase of MANIFEST.phases) for (const lifecycle of MANIFEST.lifecycles) for (const site of MANIFEST.sites) {
    const matching = runs.filter(r => r.phase === phase && r.environment === phase[0] && r.lifecycle === lifecycle && (() => { try { return siteKey(r.site) === site; } catch { return false; } })());
    const cell = `${phase}/${lifecycle}/${site}`;
    add(`coverage/${cell}`, matching.length > 1 ? 'error' : matching.length === 1 && validRun(matching[0]) ? 'pass' : matching[0]?.collection_error ? 'error' : 'not_tested', 'Exactly one bound observation per manifest lifecycle/site cell; errors remain in the denominator.');
    const run = matching.length === 1 ? matching[0] : null;
    for (const f of MANIFEST.features) {
      const row = run?.features?.[f.id];
      let status = 'not_tested';
      if (run?.collection_error) status = 'error';
      else if (eligible && inputOK && validRun(run ?? {}) && row) {
        if (!STATES.includes(row.status)) status = 'error';
        else if (row.status !== 'pass') status = row.status;
        else { try { status = controls(f.id, row.observed, evidence.inputs, run) ? 'pass' : 'fail'; } catch { status = 'fail'; } }
      }
      add(`functionality/${f.id}/${cell}`, status, row?.detail || 'Controlled observed values evaluated independently of submitted pass.', { feature: f.id });
    }
  }
  for (const f of MANIFEST.features.filter(f => f.comparison.startsWith('stable_and_different'))) {
    for (const environment of ['A', 'B']) {
      const rows = runs.filter(r => r.environment === environment);
      const available = rows.filter(r => validRun(r) && r.features?.[f.id]?.status === 'pass' && (() => { try { return controls(f.id, r.features[f.id].observed, evidence.inputs, r); } catch { return false; } })()).map(r => r.features[f.id]);
      const values = available.map(r => identity(f.id, r.observed));
      const complete = eligible && rows.length === 16 && available.length === 16;
      add(`stability/${f.id}/${environment}`, !complete ? 'not_tested' : values.every(v => eq(v, values[0])) ? 'pass' : 'fail', 'Same environment across reads, refresh, new page, restart and both sites.', { feature: f.id });
    }
    for (const site of MANIFEST.sites) for (const round of ['1', '2']) {
      const find = environment => runs.find(r => validRun(r) && r.phase === environment + round && r.lifecycle === 'initial' && (() => { try { return siteKey(r.site) === site; } catch { return false; } })())?.features?.[f.id];
      const a = find('A'), b = find('B');
      let status = !eligible || !a?.observed || !b?.observed || a.status !== 'pass' || b.status !== 'pass' ? 'not_tested' : !eq(identity(f.id, a.observed), identity(f.id, b.observed)) ? 'pass' : 'fail';
      if (status === 'pass' && f.id === 'webgl' && !['identifier', 'parameters', 'base'].every(k => !eq(a.observed[k], b.observed[k]))) status = 'fail';
      add(`differentiation/${f.id}/${round}/${site}`, status, 'Every designated feature differs; WebGL identifier, parameters and rendered pixels are separate mandatory components.', { feature: f.id });
    }
  }
  const productResults = new Map();
  const verifyArtifact = artifactVerifier([evidence.artifact_root, evidence.profile_home]);
  for (const scenario of PRODUCT_SCENARIOS) {
    const result = evaluateProduct(scenario, evidence, Array.isArray(productEvidence) ? productEvidence : [], now, checks, verifyArtifact);
    productResults.set(scenario.id, result.status);
    add(`product/${scenario.id}`, result.status, result.detail, { title: scenario.title, obligations: result.obligations, source: 'process/server/file' });
  }
  const externalScenarios = { gui_real_image_input: 'G1', https_h2_network_context: 'C2', public_network_egress: 'N1', challenge_receipt: 'T1', human_gui_signoff: 'K3' };
  for (const id of MANIFEST.external_required) add(id, productResults.get(externalScenarios[id]), `Independent product/${externalScenarios[id]} evidence required; browser claims cannot establish this gate.`);
  const outstanding = checks.filter(c => c.outstanding);
  return { schema: 2, suite_version: SUITE_VERSION, source_suite_version: evidence.suite_version ?? null, runtime_id: evidence.runtime?.id ?? null, runtime_digest: evidence.runtime?.artifact_sha256 ?? null, race_id: evidence.race_id ?? null, input_digest: evidence.input_digest ?? null, raw_sha256: digest(evidence), product_evidence_sha256: digest(productEvidence), evaluated_at: new Date(now).toISOString(), status: outstanding.length ? 'outstanding' : 'pass', overall: outstanding.length ? 'NOT_PASS' : 'PASS', coverage: { required: checks.length, passed: checks.length - outstanding.length, outstanding: outstanding.length }, product_coverage: { required: PRODUCT_SCENARIOS.length, passed: [...productResults.values()].filter(s => s === 'pass').length }, checks, gaps: outstanding.map(c => ({ id: c.id, status: c.status, detail: c.detail })), axes: { functionality: 'see functionality checks', identity: 'see stability and differentiation checks', privacy: 'see product/N1 and product/E3; cross-site correlation alone is not privacy protection', challenge: productResults.get('T1'), performance: productResults.get('K2') } };
}
export const compareRuns = evaluateAcceptance;
