import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// A pending script keeps its original page handle. Human selection must not be
// silently undone when that old handle attempts its first write after resume.
export async function collectSelectedTarget({ invoke, source, run, evaluate, append, marker, events }) {
  await invoke('viewer_selection_begin_reclaim', 'control', 'acceptA', 'reclaim', '--json');
  const script = await source('control_boundary_selected', `from pathlib import Path\nasync def main(page, context, tools):\n    await page.locator('#work-input').fill('old-target-' + tools.args['marker'])\n    Path(__file__).with_suffix('.ready').write_text(tools.args['marker'])\n    await page.wait_for_timeout(4000)\n    await page.locator('#work-input').fill('stale-target-write-' + tools.args['marker'])\n    return {'unexpected': 'old page write accepted'}\n`);
  const pending = run('script_control_boundary_selected', script);
  try {
    const readyPath = script.slice(0, -3) + '.ready', deadline = Date.now() + 5000;
    let ready;
    while (Date.now() < deadline && ready !== marker) { try { ready = await readFile(readyPath, 'utf8'); } catch {} if (ready !== marker) await new Promise(resolve => setTimeout(resolve, 25)); }
    if (ready !== marker) throw new Error('Pending script never completed its real original-page write');
    append('viewer_selection_script_ready', { path: readyPath, marker: ready });
    await invoke('viewer_selection_pause', 'control', 'acceptA', 'pause', '--json');
    const opening = await invoke('viewer_selection_private', 'viewer', 'acceptA', '--json');
    const body = JSON.parse(opening.stdout), url = new URL(body.url ?? body.viewer?.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('token'), owner = randomUUID();
    if (!token || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('No authenticated loopback viewer for selected-target exercise');
    events.splice(events.indexOf(opening), 1, { name: 'viewer_selection_endpoint', source: 'file', content: { origin: url.origin, source_command_sequence: opening.sequence, source_stdout_sha256: opening.stdout_sha256 } });
    const http = async (name, path, payload) => {
      const response = await fetch(url.origin + path, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'X-Viewer-Id': owner, ...(payload ? { Origin: url.origin, 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(15000) });
      const stdout = await response.text(); events.push({ name, source: 'server', exit_code: response.ok ? 0 : response.status, stdout, stderr: '', http_status: response.status, request: { path, payload }, observed_at: new Date().toISOString() });
      return JSON.parse(stdout);
    };
    await http('viewer_selection_human', '/api/control', { operation: 'request_human' });
    const state = await http('viewer_selection_original', '/api/state');
    const pages = await http('viewer_selection_pages', '/api/pages'), list = Array.isArray(pages) ? pages : pages.pages;
    const other = list?.find(page => (page.page_id ?? page.id) !== state.state?.page_id);
    if (!other) throw new Error('No actual second page; selected-target requirement remains unavailable');
    const response = await fetch(url.origin + '/api/frame', { headers: { Authorization: `Bearer ${token}`, 'X-Viewer-Id': owner }, signal: AbortSignal.timeout(15000) });
    const image = await response.arrayBuffer(), header = response.headers.get('X-Viewer-Frame');
    if (!response.ok || !header || !image.byteLength) throw new Error('No actual selected-page frame metadata');
    const frame = JSON.parse(Buffer.from(header, 'base64').toString());
    await http('viewer_selection_change', '/api/action', { operation: 'context.select_page', args: { target_page_id: other.page_id ?? other.id }, page_id: frame.page_id, frame_id: frame.frame_id, observation_id: frame.observation_id, image_id: frame.image_id, owner_revision: frame.state?.owner_revision });
    const selected = await http('viewer_selection_before_resume', '/api/state');
    await http('viewer_selection_resume', '/api/control', { operation: 'resume_agent', owner_revision: selected.state?.owner_revision, run_id: selected.state?.run_id });
    await pending;
    await http('viewer_selection_after_resume', '/api/state');
    await invoke('viewer_selection_after_error_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    await http('viewer_selection_after_reclaim', '/api/state');
    await evaluate('viewer_selection_current_value', "document.getElementById('work-input').value");
    // Only after recording the selected-target result do we deliberately return
    // to page zero to inspect whether the stale script changed the original DOM.
    await invoke('viewer_selection_inspect_original', 'exec', 'acceptA', 'use', '0', '--json');
    await evaluate('viewer_selection_original_value', "document.getElementById('work-input').value");
    append('viewer_selection_expected', { original_page_id: state.state?.page_id, selected_page_id: other.page_id ?? other.id, expected_original_value: 'old-target-' + marker });
  } finally {
    await invoke('viewer_selection_cleanup_cancel', 'control', 'acceptA', 'cancel', '--json');
    await invoke('viewer_selection_cleanup_reclaim', 'control', 'acceptA', 'reclaim', '--json');
    await pending;
  }
}
