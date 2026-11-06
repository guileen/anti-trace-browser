import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pngPixels } from '../scripts/png.mjs';
import { inspectArchive, corruptArchive } from './archive-evidence.mjs';
import { initialChildren, observeDrain, PS_ENV } from './process-evidence.mjs';
import { collectSelectedTarget } from './selected-target.mjs';
import { proxyFixture } from './proxy-fixture.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPath = async path => { const value = createHash('sha256'); for await (const chunk of createReadStream(path)) value.update(chunk); return value.digest('hex'); };
const json = event => { try { return JSON.parse(event?.stdout ?? 'null'); } catch { return null; } };
export function cliCollectionFailure(receipt, rejection) {
  if (receipt.error || !Number.isInteger(receipt.exit_code)) return rejection || receipt.error || 'CLI transport failed';
  try { const reply = JSON.parse(receipt.stdout); if (!reply || typeof reply !== 'object') throw new Error('CLI reply is not an object/array'); }
  catch (error) { return rejection || error.message; }
  return null; // A valid exit-1 error receipt is a measured CLI outcome.
}
function traversalArchive() {
  const header = Buffer.alloc(512); header.write('../escape.txt'); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write('00000000001\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, Buffer.from('x'), Buffer.alloc(511 + 1024)]));
}

// This module drives the same real CLI as the matrix collector. Every failure
// becomes a raw receipt; unavailable APIs are never supplied by a second browser.
export async function collectProductEvidence({ evidence, output, home, port, command }) {
  const events = [], scripts = join(output, 'scripts'), marker = evidence.run_id, firstRunID = `${marker}_product`, url = `http://127.0.0.1:${port}/acceptance-product.html?context=navigation&run_id=${firstRunID}`;
  await mkdir(scripts, { recursive: false, mode: 0o700 });
  const append = (name, content) => { const event = { name, source: 'file', observed_at: new Date().toISOString(), content }; events.push(event); return event; };
  const invoke = async (name, ...args) => {
    const sequence = evidence.commands.length; let failure;
    try { await command(...args); } catch (error) { failure = error.message; }
    let receipt;
    try { receipt = JSON.parse(await readFile(join(output, `command-${sequence}.json`), 'utf8')); }
    catch (error) { receipt = { sequence, args, exit_code: null, stdout: '', stderr: '', error: failure || error.message }; }
    const event = { ...receipt, name, source: 'process', collection_failure: cliCollectionFailure(receipt, failure) }; events.push(event); return event;
  };
  const attempt = async (name, fn) => { try { await fn(); } catch (error) { append(`${name}_collector_error`, { error: error.message }); } };
  const evaluate = (name, expression, environment = 'acceptA') => invoke(name, 'exec', environment, 'eval', expression, '--timeout', '15000', '--json');
  const source = async (name, text) => { const path = join(scripts, `${name}.py`); await writeFile(path, text, { flag: 'wx', mode: 0o600 }); append(`source_${name}`, { path, sha256: hash(Buffer.from(text)), source: text }); return path; };
  const run = async (name, script, extra = []) => invoke(name, 'run', 'acceptA', script, '--args', JSON.stringify({ url, marker, screenshot_path: join(output, 'script-screenshot.png') }), '--timeout', '15', '--max-output-bytes', '65536', ...extra, '--json');
  const state = async name => { const path = join(home, 'profiles', 'acceptA', 'state.json'), bytes = await readFile(path); append(name, { ...JSON.parse(bytes), file_sha256: hash(bytes) }); };
  const refs = tree => { const rows = []; const walk = value => { if (!value || typeof value !== 'object') return; if (typeof value.ref === 'string') rows.push(value); for (const child of Object.values(value)) { if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child); } }; walk(tree); return rows; };
  const reference = async () => { const event = await invoke(`axtree_${events.length}`, 'axtree', 'acceptA', '--json'); const rows = refs(json(event)); return rows.find(r => /Apply|work-button/.test(JSON.stringify(r)))?.ref; };
  await attempt('creation_validation', async () => {
    await invoke('invalid_config', 'create', 'invalidFixture', '--runtime', evidence.runtime.id, '--seed', hash(Buffer.from(marker + ':invalid')), '--allow-private-network', '--overrides', '{"hardware_concurrency":-1}', '--json');
    await invoke('identity_collision', 'create', 'collisionFixture', '--runtime', evidence.runtime.id, '--seed', evidence.creation_inputs.A.seed, '--allow-private-network', '--cores', evidence.workload.cores_a, '--json');
  });
  await attempt('locale_override', async () => {
    const localeRun = `${marker}_locale`, localeURL = `http://127.0.0.1:${port}/acceptance-product.html?context=navigation&run_id=${localeRun}`;
    await invoke('locale_create', 'create', 'localeFixture', '--runtime', evidence.runtime.id, '--seed', hash(Buffer.from(marker + ':locale')), '--allow-private-network', '--overrides', '{"locale":"fr-FR","languages":["fr-FR","fr"]}', '--json');
    await invoke('locale_info', 'info', 'localeFixture', '--json');
    await invoke('locale_start', 'start', 'localeFixture', '--headless', '--url', localeURL, '--json');
    await evaluate('locale_first_scripts', `(async()=>{const end=Date.now()+5000;while(Date.now()<end&&(!document.documentElement.getAttribute('data-first-frame')||!document.documentElement.getAttribute('data-first-worker')))await new Promise(r=>setTimeout(r,25));const get=k=>{const v=document.documentElement.getAttribute(k);return v?JSON.parse(v):null};return {main:get('data-first-main'),worker:get('data-first-worker'),frame:get('data-first-frame')}})()`, 'localeFixture');
    append('locale_server_events', await (await fetch(`http://127.0.0.1:${port}/api/echo/events?run_id=${localeRun}`)).json());
    await invoke('locale_stop', 'stop', 'localeFixture', '--json');
  });
  await attempt('lifecycle_concurrency', async () => {
    await Promise.all([1, 2, 3].map(index => invoke(`concurrent_start_${index}`, 'start', 'acceptA', '--headless', '--url', url, '--json')));
    await invoke('concurrent_info', 'info', 'acceptA', '--json'); await state('concurrent_state');
    await invoke('busy_export', 'export', 'acceptA', join(output, 'busy.atb.tar.gz'), '--json');
    await invoke('other_start', 'start', 'acceptB', '--headless', '--url', url, '--json');
    await evaluate('other_before', `(() => {localStorage.setItem('crash-isolation',${JSON.stringify(marker)});return localStorage.getItem('crash-isolation')})()`, 'acceptB');
    append('other_state_before', JSON.parse(await readFile(join(home, 'profiles', 'acceptB', 'state.json'), 'utf8')));
    const crashMarker = JSON.stringify(marker), crashRead = `(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('owner-crash',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const indexed_db=await new Promise((resolve,reject)=>{const r=db.transaction('values','readonly').objectStore('values').get('marker');r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error)});db.close();const cookie=document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('owner-crash='));return {local_storage:localStorage.getItem('owner-crash'),cookie:cookie?decodeURIComponent(cookie.slice(12)):null,indexed_db}})()`;
    await evaluate('crash_commit', `(async()=>{localStorage.setItem('owner-crash',${crashMarker});document.cookie='owner-crash='+encodeURIComponent(${crashMarker})+'; Path=/; Max-Age=3600';const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('owner-crash',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});await new Promise((resolve,reject)=>{const t=db.transaction('values','readwrite');t.objectStore('values').put(${crashMarker},'marker');t.oncomplete=resolve;t.onerror=()=>reject(t.error)});db.close();return 'committed'})()`);
    await evaluate('crash_commit_before', crashRead);
    const current = events.find(e => e.name === 'concurrent_state')?.content;
    const beforeKill = JSON.parse(await readFile(join(home, 'profiles', 'acceptA', 'state.json'), 'utf8'));
    if (!Number.isInteger(current?.pid) || current.pid <= 1 || !Number.isFinite(current.process_start) || beforeKill.pid !== current.pid || beforeKill.process_start !== current.process_start) throw new Error('Owned fixture PID/birthtime changed; refusing crash injection');
    const description = await exec('ps', ['-ww', '-p', String(current.pid), '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='], { env: PS_ENV });
    const match = description.stdout.trim().match(/^(\d+)\s+(.{24})\s+(.+)$/);
    const birthtime = match ? Date.parse(match[2] + ' UTC') / 1000 : NaN;
    append('crash_os_observation', { stdout: description.stdout, state_pid: current.pid, process_start: current.process_start });
    if (!match || Number(match[1]) !== current.pid || !Number.isFinite(birthtime) || Math.abs(birthtime - current.process_start) > 1.5 || !/anti_trace\.engine/.test(match[3]) || !/--profile\s+acceptA(?:\s|$)/.test(match[3])) throw new Error('OS process/group identity does not match this owned CLI fixture; refusing crash injection');
    append('crash_os_identity', { pid: current.pid, group: Number(match[1]), start: match[2], command: match[3] });
    const children = await initialChildren(current.pid, current.process_start);
    append('crash_children_before', { rows: children.map(row => row.raw) });
    const finalIdentity = await exec('ps', ['-ww', '-p', String(current.pid), '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='], { env: PS_ENV });
    if (finalIdentity.stdout.trim() !== description.stdout.trim()) throw new Error('Manager OS identity changed before owner-only injection');
    process.kill(current.pid, 'SIGKILL'); append('crash_owner', { pid: current.pid, process_start: current.process_start, signal: 'SIGKILL', signal_target: current.pid, state_file_pid: beforeKill.pid });
    append('crash_drain', await observeDrain(children, join(home, 'profiles', 'acceptA', 'data'), join(home, '.leases', hash(Buffer.from('acceptA')) + '.engine')));
    await invoke('recovery_start', 'start', 'acceptA', '--headless', '--url', url, '--json');
    await invoke('recovery_info', 'info', 'acceptA', '--json');
    await evaluate('crash_commit_after', crashRead);
    await evaluate('other_after', "localStorage.getItem('crash-isolation')", 'acceptB');
    append('other_state_after', JSON.parse(await readFile(join(home, 'profiles', 'acceptB', 'state.json'), 'utf8')));
  });
  await attempt('scripts', async () => {
    await invoke('script_start', 'start', 'acceptA', '--headless', '--url', url, '--json');
    const flow = await source('flow', `async def main(page, context, tools):
    await page.goto(tools.args['url'])
    target = page.locator('#work-input')
    await target.wait_for(state='visible')
    total = 0
    for value in range(1, 5):
        total += value
        await target.fill('loop-' + str(value))
    branch = 'taken' if total == 10 else 'wrong'
    expression_value = await page.evaluate("document.querySelector('#work-input').value")
    argument_value = await page.evaluate("value => { const output = document.getElementById('work-output'); output.textContent = value; return output.textContent; }", tools.args['marker'])
    expression_marker = await page.evaluate("document.getElementById('work-output').textContent")
    return {'sum': total, 'branch': branch, 'value': await target.input_value(), 'marker': argument_value, 'expression_value': expression_value, 'expression_marker': expression_marker}
`);
    await run('script_flow', flow);
    await invoke('script_flow_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    await evaluate('first_script_observations', `(async()=>{const end=Date.now()+5000;while(Date.now()<end&&(!document.documentElement.getAttribute('data-first-frame')||!document.documentElement.getAttribute('data-first-worker')))await new Promise(r=>setTimeout(r,25));const get=k=>{const v=document.documentElement.getAttribute(k);return v?JSON.parse(v):null};return {main:get('data-first-main'),worker:get('data-first-worker'),frame:get('data-first-frame')}})()`);
    append('first_script_server_events', await (await fetch(`http://127.0.0.1:${port}/api/echo/events?run_id=${firstRunID}`)).json());
    const failure = await source('failure', `async def main(page, context, tools):\n    await page.evaluate('(m) => document.body.setAttribute("data-before", m)', tools.args['marker'])\n    raise RuntimeError('controlled-script-failure')\n    await page.evaluate('() => document.body.setAttribute("data-after", "unexpected")')\n`);
    await run('script_failure', failure);
    await invoke('script_failure_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    await evaluate('failure_page_state', "({before:document.body.getAttribute('data-before'),after:document.body.getAttribute('data-after')})");
    const outputScript = await source('output', `async def main(page, context, tools):\n    print('controlled-output-' * 2000)\n    return {'unexpected': 'overflow accepted'}\n`);
    await run('script_output', outputScript, ['--max-output-bytes', '4096']);
    await invoke('script_output_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    const deadline = await source('deadline', `import asyncio\nasync def main(page, context, tools):\n    await asyncio.sleep(3)\n    await page.evaluate('() => document.body.setAttribute("data-after-deadline", "unexpected")')\n`);
    await run('script_deadline', deadline, ['--timeout', '0.3']);
    await invoke('script_deadline_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    const cancellation = await source('cancel', `import asyncio\nasync def main(page, context, tools):\n    await page.evaluate('() => document.body.removeAttribute("data-after-cancel")')\n    await asyncio.sleep(4)\n    await page.evaluate('() => document.body.setAttribute("data-after-cancel", "unexpected")')\n`);
    const pending = run('script_cancel', cancellation); await pause(350);
    await invoke('cancel_current', 'control', 'acceptA', 'cancel', '--json'); await pending;
    await invoke('script_cancel_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    await evaluate('cancel_page_state', "document.body.getAttribute('data-after-cancel')");
    const observation = await source('observation', `async def main(page, context, tools):\n    return await tools.axtree(page=page, max_elements=2, max_text=20)\n`);
    await run('script_observation', observation);
    await invoke('script_observation_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    const screenshot = await source('screenshot', `from pathlib import Path\nasync def main(page, context, tools):\n    image = await page.screenshot()\n    Path(tools.args['screenshot_path']).write_bytes(image)\n    return {'screenshot_bytes': len(image)}\n`);
    await run('script_screenshot', screenshot, ['--max-output-bytes', '1048576']);
    try { const path = join(output, 'script-screenshot.png'), bytes = await readFile(path), raw_artifact = { path, byte_length: bytes.length, sha256: hash(bytes) }; append('screenshot_artifact', { ...raw_artifact, raw_artifact, signature: bytes.subarray(0, 8).toString('hex') }); } catch (error) { append('screenshot_artifact_error', { error: error.message }); }
    await invoke('post_script_info', 'info', 'acceptA', '--json');
  });
  await attempt('stale_references', async () => {
    await invoke('stale_begin_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    await invoke('stale_fixture_goto', 'exec', 'acceptA', 'goto', url, '--json');
    let ref = await reference();
    await evaluate('mutate_dom', "(() => {const e=document.createElement('button');e.textContent='Inserted before';document.body.insertBefore(e,document.body.firstChild);return document.querySelectorAll('button').length})()");
    if (ref) await invoke('stale_dom', 'exec', 'acceptA', 'click', ref.startsWith('@') ? ref : '@' + ref, '--json');
    await invoke('stale_dom_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    ref = await reference(); await invoke('mutate_navigation', 'exec', 'acceptA', 'goto', url + '&navigation=changed', '--json');
    if (ref) await invoke('stale_navigation', 'exec', 'acceptA', 'click', ref.startsWith('@') ? ref : '@' + ref, '--json');
    await invoke('stale_navigation_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    ref = await reference(); const tab = json(await invoke('mutate_page', 'exec', 'acceptA', 'tab_new', url, '--json'));
    if (Number.isInteger(tab?.index)) await invoke('select_other_page', 'exec', 'acceptA', 'use', String(tab.index), '--json');
    if (ref) await invoke('stale_page', 'exec', 'acceptA', 'click', ref.startsWith('@') ? ref : '@' + ref, '--json');
    await invoke('stale_page_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    await invoke('select_original_page', 'exec', 'acceptA', 'use', '0', '--json');
    const frameTree = json(await invoke('axtree_child_frame', 'axtree', 'acceptA', '--frame', '#work-frame', '--json'));
    const child = refs(frameTree).find(row => /Frame action|frame-button/.test(JSON.stringify(row)) && row.frame_id === frameTree?.frame_id);
    await evaluate('mutate_frame_navigation', `(() => {const frame=document.getElementById('work-frame');frame.src='/acceptance-first-frame.html?changed=${marker}';return frame.src})()`);
    await pause(100);
    if (child) await invoke('stale_frame', 'exec', 'acceptA', 'click', child.ref.startsWith('@') ? child.ref : '@' + child.ref, '--json');
    await invoke('stale_frame_reclaim', 'control', 'acceptA', 'reclaim', '--json');
  });
  await attempt('viewer_control', async () => {
    await invoke('viewer_fixture_goto', 'exec', 'acceptA', 'goto', url, '--json');
    const rect = json(await evaluate('viewer_input_geometry', "(() => {const r=document.getElementById('work-input').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()"))?.result;
    const response = json(await invoke('viewer_open_private', 'viewer', 'acceptA', '--json'));
    const address = response?.url ?? response?.viewer?.url;
    if (typeof address !== 'string') throw new Error('CLI did not return a real viewer URL');
    const viewer = new URL(address), token = new URLSearchParams(viewer.hash.slice(1)).get('token'), viewerID = randomUUID();
    if (!token || !['127.0.0.1', 'localhost'].includes(viewer.hostname)) throw new Error('Viewer endpoint is not authenticated loopback');
    // The private CLI command receipt is retained mode0600; no token enters product events.
    const openingIndex = events.findIndex(e => e.name === 'viewer_open_private'), opening = events[openingIndex];
    events.splice(openingIndex, 1, { name: 'viewer_endpoint', source: 'file', observed_at: new Date().toISOString(), content: { origin: viewer.origin, source_command_sequence: opening.sequence, source_stdout_sha256: opening.stdout_sha256 } });
    const http = async (name, path, payload) => {
      const response = await fetch(viewer.origin + path, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'X-Viewer-Id': viewerID, ...(payload ? { Origin: viewer.origin, 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      const text = await response.text(); const event = { name, source: 'server', exit_code: response.ok ? 0 : response.status, stdout: text, stderr: '', http_status: response.status, request: { path, payload }, observed_at: new Date().toISOString() }; events.push(event); return json(event);
    };
    const frame = async name => {
      const response = await fetch(viewer.origin + '/api/frame', { headers: { Authorization: `Bearer ${token}`, 'X-Viewer-Id': viewerID }, signal: AbortSignal.timeout(15000) });
      const bytes = Buffer.from(await response.arrayBuffer()), encoded = response.headers.get('X-Viewer-Frame');
      if (!response.ok || !encoded) { events.push({ name, source: 'server', exit_code: response.status, stdout: bytes.toString(), stderr: '', http_status: response.status, request: { path: '/api/frame' }, observed_at: new Date().toISOString() }); throw new Error('Viewer failed to return actual same-runtime pixels and frame metadata'); }
      const metadata = JSON.parse(Buffer.from(encoded, 'base64').toString()), decoded = pngPixels(bytes), path = join(output, `${name}.png`);
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      append(name, { metadata, path, byte_length: bytes.length, sha256: hash(bytes), raw_artifact: { path, byte_length: bytes.length, sha256: hash(bytes) }, decoded_pixels_sha256: decoded.decoded_pixels_sha256, width: decoded.width, height: decoded.height });
      return metadata;
    };
    const action = async (name, operation, args) => {
      const metadata = await frame(`${name}_frame`);
      return await http(name, '/api/action', { operation, args, page_id: metadata.page_id, frame_id: metadata.frame_id, observation_id: metadata.observation_id, image_id: metadata.image_id, owner_revision: metadata.state?.owner_revision });
    };
    await http('viewer_human', '/api/control', { operation: 'request_human' });
    const original = await frame('viewer_before_input');
    if (!Number.isFinite(rect?.x) || !Number.isFinite(rect?.y)) throw new Error('No genuine input geometry available for coordinate input');
    await action('viewer_coordinate_click', 'mouse.click', { x: rect.x, y: rect.y, button: 'left', click_count: 1 });
    await action('viewer_select_text', 'keyboard.press', { key: 'Meta+A' });
    await action('viewer_insert_text', 'keyboard.insert_text', { text: 'handover-中文-' + marker });
    await frame('viewer_after_input');
    await action('viewer_focus_next', 'keyboard.press', { key: 'Tab' });
    await action('viewer_scroll', 'mouse.wheel', { delta_x: 0, delta_y: 500 });
    let previousScrollFrame, stableScrollFrames = 0;
    for (let index = 0; index < 20 && stableScrollFrames < 2; index++) {
      const name = `viewer_scroll_settle_${index}`, metadata = await frame(name), captured = events.find(event => event.name === name).content;
      const signature = JSON.stringify([metadata.page_id, metadata.frame_id, metadata.viewport, captured.decoded_pixels_sha256]);
      stableScrollFrames = signature === previousScrollFrame ? stableScrollFrames + 1 : 0;
      previousScrollFrame = signature;
      if (stableScrollFrames < 2) await pause(75);
    }
    if (stableScrollFrames < 2) throw new Error('Actual scroll/frame geometry did not settle before taking the next control reference');
    const pages = await http('viewer_pages', '/api/pages'), list = Array.isArray(pages) ? pages : pages?.pages;
    const other = list?.find(page => (page.page_id ?? page.id) !== original.page_id);
    if (other) {
      await action('viewer_select_tab', 'context.select_page', { target_page_id: other.page_id ?? other.id });
      await http('viewer_other_tab_state', '/api/state');
      await action('viewer_restore_tab', 'context.select_page', { target_page_id: original.page_id });
    }
    await http('viewer_disconnect', '/api/control', { operation: 'disconnect' });
    const paused = await http('viewer_state_paused', '/api/state');
    await http('viewer_reclaim', '/api/control', { operation: 'reclaim', owner_revision: paused?.state?.owner_revision, run_id: paused?.state?.run_id });
    await http('viewer_state_reclaimed', '/api/state');
    await evaluate('viewer_retained_page_state', "({value:document.getElementById('work-input').value,focus:document.activeElement.id,scroll_y:window.scrollY})");
  });
  await invoke('viewer_cleanup_reclaim', 'control', 'acceptA', 'reclaim', '--json');
  await attempt('script_control_boundary', async () => {
    const controlled = await source('control_boundary', `async def main(page, context, tools):\n    await page.goto(tools.args['url'])\n    for index in range(6):\n        await page.locator('#work-input').fill('boundary-' + str(index))\n        await page.wait_for_timeout(250)\n    return {'value': await page.locator('#work-input').input_value()}\n`);
    const pending = run('script_control_boundary', controlled); await pause(400);
    await invoke('agent_pause', 'control', 'acceptA', 'pause', '--json');
    await invoke('agent_paused_state', 'control', 'acceptA', 'status', '--json');
    await pause(500);
    await invoke('agent_still_paused_state', 'control', 'acceptA', 'status', '--json');
    await invoke('agent_resume', 'control', 'acceptA', 'resume', '--json');
    await pending;
    await invoke('agent_resumed_state', 'control', 'acceptA', 'status', '--json');
    await evaluate('agent_resumed_value', "document.getElementById('work-input').value");
  });
  await attempt('selected_target_resume', () => collectSelectedTarget({ invoke, source, run, evaluate, append, marker, events }));
  const cookieKey = 'product-durable', storageKey = 'product-durable';
  const readStorage = `(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('product-durable',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const indexed_db=await new Promise((resolve,reject)=>{const t=db.transaction('values','readonly'),r=t.objectStore('values').get('marker');r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error)});db.close();const c=document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('${cookieKey}='));return {cookie:c?decodeURIComponent(c.slice('${cookieKey}='.length)):null,local_storage:localStorage.getItem('${storageKey}'),indexed_db}})()`;
  await attempt('cold_archive', async () => {
    await invoke('archive_fixture_goto', 'exec', 'acceptA', 'goto', url, '--json');
    await evaluate('storage_commit', `(async()=>{document.cookie='${cookieKey}='+encodeURIComponent(${JSON.stringify(marker)})+'; Path=/; Max-Age=3600';localStorage.setItem('${storageKey}',${JSON.stringify(marker)});const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('product-durable',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});await new Promise((resolve,reject)=>{const t=db.transaction('values','readwrite');t.objectStore('values').put(${JSON.stringify(marker)},'marker');t.oncomplete=resolve;t.onerror=()=>reject(t.error)});db.close();return 'committed'})()`);
    await evaluate('storage_before_archive', readStorage);
    await evaluate('session_write', `(() => {sessionStorage.setItem('product-session',${JSON.stringify(marker)});return sessionStorage.getItem('product-session')})()`);
    const tab = json(await invoke('session_tab_new', 'exec', 'acceptA', 'tab_new', url, '--json'));
    if (Number.isInteger(tab?.index)) await invoke('session_tab_select', 'exec', 'acceptA', 'use', String(tab.index), '--json');
    await evaluate('session_new_page', "sessionStorage.getItem('product-session')");
    await invoke('session_original_select', 'exec', 'acceptA', 'use', '0', '--json');
    await invoke('archive_stop', 'stop', 'acceptA', '--json');
    const archive = join(output, 'cold.atb.tar.gz');
    await invoke('cold_export', 'export', 'acceptA', archive, '--json');
    const inspected = await inspectArchive(archive);
    append('archive_bytes', { ...inspected.raw_artifact, raw_artifact: inspected.raw_artifact });
    if (!inspected.config) throw new Error('Export omitted actual config.json');
    const corruptPath = join(output, 'corrupt.atb.tar.gz'); await corruptArchive(archive, corruptPath, inspected.config_offset);
    await invoke('corrupt_import', 'import', corruptPath, '--name', 'corruptFixture', '--json');
    const unsafePath = join(output, 'unsafe.atb.tar.gz'); await writeFile(unsafePath, traversalArchive(), { flag: 'wx', mode: 0o600 });
    await invoke('unsafe_import', 'import', unsafePath, '--name', 'unsafeFixture', '--json');
    await invoke('remove_archived', 'rm', 'acceptA', '--force', '--json');
    await invoke('cold_import', 'import', archive, '--name', 'acceptA', '--json');
    await invoke('restored_start', 'start', 'acceptA', '--headless', '--url', url, '--json');
    await evaluate('storage_after_archive', readStorage);
    await evaluate('session_after_restart', "sessionStorage.getItem('product-session')");
  });
  await attempt('strict_proxy', async () => {
    const proxy = await proxyFixture(port);
    try {
      await invoke('proxy_create', 'create', 'proxyFixture', '--runtime', evidence.runtime.id, '--seed', hash(Buffer.from(marker + ':proxy')), '--allow-private-network', '--proxy', proxy.url, '--egress-policy', 'strict', '--json');
      await invoke('proxy_info', 'info', 'proxyFixture', '--json');
      proxy.disconnect();
      const proxyRunID = randomUUID(), destination = `http://127.0.0.1:${port}/api/echo?context=navigation&run_id=${proxyRunID}`;
      await invoke('proxy_start', 'start', 'proxyFixture', '--headless', '--url', destination, '--json');
      await invoke('proxy_navigation', 'exec', 'proxyFixture', 'goto', destination, '--timeout', '3000', '--json');
      const response = await fetch(`http://127.0.0.1:${port}/api/echo/events?run_id=${proxyRunID}`); append('proxy_server_events', await response.json());
      await invoke('proxy_stop', 'stop', 'proxyFixture', '--json');
      const archive = join(output, 'credential-policy.atb.tar.gz'); await invoke('credential_export', 'export', 'proxyFixture', archive, '--json');
      const inspected = await inspectArchive(archive);
      append('credential_archive_scan', inspected);
      if (inspected.config) append('credential_archive_config', inspected.config);
    } finally { append('proxy_fixture_transport', { events: proxy.events }); await proxy.close(); }
  });
  await attempt('migration', async () => {
    await evaluate('migration_before_storage', readStorage);
    await invoke('migration_stop', 'stop', 'acceptA', '--json');
    const configPath = evidence.runtime.A?.config_path || join(home, 'profiles', 'acceptA', 'config.json');
    const original = await readFile(configPath), before = JSON.parse(original);
    append('migration_before_config', { config: before, sha256: hash(original) });
    await writeFile(join(output, 'preflight-original.config.json'), original, { flag: 'wx', mode: 0o600 });
    for (const [kind, mutate] of [
      ['runtime', cfg => { cfg.runtime.artifact_sha256 = '0'.repeat(64); }],
      ['generator', cfg => { cfg.generator_version = 'incompatible-controlled-fixture'; }],
      ['fonts', cfg => { cfg.assets = { ...cfg.assets, fonts_sha256: '0'.repeat(64) }; }],
    ]) {
      const changed = structuredClone(before), preflightRun = randomUUID(); mutate(changed);
      try {
        await writeFile(configPath, JSON.stringify(changed), { mode: 0o600 });
        append(`preflight_${kind}_input`, { original_sha256: hash(original), mutated_sha256: hash(Buffer.from(JSON.stringify(changed))), field: kind });
        await invoke(`preflight_${kind}`, 'start', 'acceptA', '--headless', '--url', `http://127.0.0.1:${port}/api/echo?context=navigation&run_id=${preflightRun}`, '--json');
        append(`preflight_${kind}_server_events`, await (await fetch(`http://127.0.0.1:${port}/api/echo/events?run_id=${preflightRun}`)).json());
      } finally {
        await invoke(`preflight_${kind}_stop`, 'stop', 'acceptA', '--json');
        await writeFile(configPath, original, { mode: 0o600 });
      }
    }
    const migration = json(await invoke('explicit_migration', 'migrate', 'acceptA', '--overrides', '{"locale":"fr-FR","languages":["fr-FR","fr"]}', '--json'));
    const migrated = await readFile(configPath); append('migration_after_config', { config: JSON.parse(migrated), sha256: hash(migrated) });
    if (typeof migration?.snapshot === 'string') {
      if ((await stat(migration.snapshot)).isFile()) {
        const archive = await inspectArchive(migration.snapshot);
        append('migration_snapshot_inventory', { path: migration.snapshot, files: archive.files.map(file => ({ path: file.name, size: file.size, sha256: file.sha256 })), raw_artifact: archive.raw_artifact });
      } else {
        const names = await readdir(migration.snapshot, { recursive: true }), files = [];
        if (names.length > 5000) throw new Error('Migration snapshot inventory exceeded fixture bound');
        for (const name of names) { const path = join(migration.snapshot, name), details = await stat(path); if (details.isFile()) files.push({ path: name, size: details.size, sha256: await hashPath(path) }); }
        append('migration_snapshot_inventory', { path: migration.snapshot, files, raw_artifacts: files.map(file => ({ path: join(migration.snapshot, file.path), byte_length: file.size, sha256: file.sha256 })) });
      }
    }
    await invoke('migration_start', 'start', 'acceptA', '--headless', '--url', url, '--json');
    await evaluate('migration_after_storage', readStorage);
    await invoke('rollback_stop', 'stop', 'acceptA', '--json');
    if (typeof migration?.snapshot === 'string') {
      await invoke('explicit_rollback', 'migrate', 'acceptA', '--rollback', migration.snapshot, '--json');
      const rollback = await readFile(configPath); append('rollback_config', { config: JSON.parse(rollback), sha256: hash(rollback) });
      await invoke('rollback_start', 'start', 'acceptA', '--headless', '--url', url, '--json');
      await evaluate('rollback_storage', readStorage);
    }
  });
  await attempt('field', async () => {
    await invoke('field_redirect', 'field', 'acceptA', '--sites', `http://127.0.0.1:${port}/api/echo/redirect`, '--out', join(output, 'field-redirect'), '--settle', '0', '--timeout', '5', '--json');
    await invoke('field_unavailable', 'field', 'acceptA', '--sites', 'http://127.0.0.1:1/controlled-unavailable', '--out', join(output, 'field-unavailable'), '--settle', '0', '--timeout', '1', '--json');
  });
  for (const name of ['acceptA', 'acceptB', 'localeFixture', 'proxyFixture', 'collisionFixture', 'invalidFixture', 'corruptFixture', 'unsafeFixture']) await invoke(`cleanup_stop_${name}`, 'stop', name, '--json');
  await writeFile(join(output, 'product-observations.json'), JSON.stringify({ schema: 1, events }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return events;
}
