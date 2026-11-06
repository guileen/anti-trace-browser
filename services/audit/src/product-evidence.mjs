import { drainValid } from '../../../browsers/engine-bench/acceptance/process-evidence.mjs';

// Only the versioned process harness supplies these artifacts. No submitted
// `pass`, `approved`, or browser product_evidence is an assertion.
export function productObservations(caseID, events, evidence, checks) {
  const out = {}, find = name => events.find(e => e?.name === name);
  const parsed = event => { try { return JSON.parse(event?.stdout ?? 'null'); } catch { return null; } };
  const body = name => parsed(find(name));
  const value = name => body(name)?.result;
  const run = name => { const b = body(name); return b?.result?.completed ? b.result : b; };
  const state = name => body(name)?.state ?? body(name)?.result?.state ?? body(name)?.result ?? body(name);
  const text = name => `${find(name)?.stderr ?? ''} ${find(name)?.stdout ?? ''}`;
  const ok = name => find(name)?.exit_code === 0 && !find(name)?.error && !find(name)?.collection_failure && body(name)?.status !== 'error' && !body(name)?.error;
  const code = name => run(name)?.error?.code ?? body(name)?.error?.code ?? body(name)?.code;
  const set = (id, names, predicate, detail) => {
    const absent = names.filter(name => !find(name));
    if (absent.length) { out[id] = { status: 'not_tested', detail: `Missing process observations: ${absent.join(', ')}` }; return; }
    try { out[id] = { status: predicate() ? 'pass' : names.some(name => /capability_unavailable/.test(text(name))) ? 'unsupported' : 'fail', detail }; }
    catch (error) { out[id] = { status: 'error', detail: `Malformed observations: ${error.message}` }; }
  };
  const matrix = (id, selector) => {
    const rows = checks.filter(selector);
    out[id] = { status: !rows.length ? 'not_tested' : rows.every(r => r.status === 'pass') ? 'pass' : ['error','fail','unsupported','review_required','not_tested'].find(s => rows.some(r => r.status === s)) ?? 'not_tested', detail: `${rows.filter(r => r.status === 'pass').length}/${rows.length} independently evaluated matrix controls.` };
  };
  const functional = (id, features) => matrix(id, c => c.id.startsWith('functionality/') && features.includes(c.feature));
  if (caseID === 'E1') {
    set('redirect_reached', ['field_redirect'], () => { const b = body('field_redirect'); return ok('field_redirect') && (b?.sites ?? b?.visits ?? b?.results ?? []).some(v => v.verdict === 'reached') && !(b?.sites ?? b?.visits ?? b?.results ?? []).some(v => v.verdict === 'cleared'); }, 'Ordinary redirect is observed through the real field command, never treated as clearance.');
    set('timeout_error', ['field_unavailable'], () => { const b = body('field_unavailable'); return (b?.sites ?? b?.visits ?? b?.results ?? []).some(v => v.verdict === 'error'); }, 'A real unreachable controlled destination must produce collection error.');
  }
  if (caseID === 'E3') {
    matrix('independent_inputs', c => ['controlled_inputs','evidence_bindings'].includes(c.id));
    matrix('all_required_apis', c => c.id.startsWith('functionality/'));
    matrix('two_schemeful_sites', c => c.id === 'two_schemeful_sites');
  }
  if (caseID === 'I1') {
    matrix('A1_B1_A2_B2', c => c.id.startsWith('coverage/'));
    matrix('all_identity_components', c => /^(stability|differentiation)\//.test(c.id));
    functional('png_and_pixels', ['canvas_text','canvas_geometry']);
  }
  if (caseID === 'I2') {
    set('first_script_all_realms', ['first_script_observations'], () => {
      const observed = value('first_script_observations'), expected = evidence.runtime.A?.configuration?.resolved;
      if (!expected) return false;
      const fields = ['user_agent','platform','locale','languages','timezone','hardware_concurrency'];
      return ['main','worker','frame'].every(realm => fields.every(key => JSON.stringify(observed?.[realm]?.[key]) === JSON.stringify(expected[key])))
        && ['main','frame'].every(realm => ['screen_width','screen_height'].every(key => observed[realm][key] === expected[key]));
    }, 'Head-loaded controlled scripts retain the initial configuration in main/frame/Worker before later Agent evaluation.');
    set('request_config', ['first_script_observations','first_script_server_events'], () => {
      const expected = evidence.runtime.A?.configuration?.resolved, receipts = find('first_script_server_events').content?.receipts;
      return expected && ['navigation','worker'].every(context => receipts?.some(r => r.source === 'server' && r.context === context && r.headers?.['user-agent'] === expected.user_agent && r.headers?.['accept-language']?.split(',')[0].split(';')[0].toLowerCase() === expected.locale.toLowerCase()));
    }, 'Harness-fetched first navigation/Worker server receipts, not browser assertions, bind outgoing identity to the resolved input.');
    set('invalid_config', ['invalid_config'], () => find('invalid_config').exit_code !== 0 && /invalid_config/.test(text('invalid_config')), 'Illegal creation inputs must fail with typed invalid_config.');
    set('identity_collision', ['identity_collision'], () => find('identity_collision').exit_code !== 0 && /identity_collision/.test(text('identity_collision')), 'A duplicate requested identity must be rejected, not silently reseeded.');
    set('locale_override', ['locale_create','locale_info','locale_first_scripts','locale_server_events'], () => {
      const observations = value('locale_first_scripts'), receipts = find('locale_server_events').content?.receipts;
      return ok('locale_create') && ['main','worker','frame'].every(realm => observations?.[realm]?.locale === 'fr-FR') && receipts?.some(r => r.context === 'navigation' && r.headers?.['accept-language']?.toLowerCase().startsWith('fr-fr'));
    }, 'An explicit nondefault locale is exercised before first script in every realm and independently observed request.');
    if (out.locale_override?.status === 'pass' && (!body('locale_info')?.network?.egress?.locale || body('locale_info').network.egress.locale.toLowerCase() === 'fr-fr')) out.locale_override = { status: 'not_tested', detail: 'Explicit locale was observed; a measured different-exit locale is still required to establish the exit-country conflict case.' };
  }
  if (caseID === 'I3') {
    const cases = ['runtime','generator','fonts'];
    const subchecks = cases.map(kind => {
      const attempt = find(`preflight_${kind}`), server = find(`preflight_${kind}_server_events`);
      return { id: kind, status: !attempt || !server ? 'not_tested' : attempt.exit_code !== 0 && /incompatible_profile|invalid_config/.test(text(`preflight_${kind}`)) && server.content?.receipts?.length === 0 ? 'pass' : 'fail' };
    });
    out.compatibility_preflight = { status: subchecks.some(r => r.status === 'fail') ? 'fail' : 'not_tested', detail: 'Runtime/generator/font pin mutations are exercised before page access; genuine different-host restore evidence remains required.', subchecks };
    set('explicit_migration', ['explicit_migration','migration_before_config','migration_after_config','migration_after_storage'], () => {
      const before = find('migration_before_config').content?.config, after = find('migration_after_config').content?.config, receipt = body('explicit_migration');
      return ok('explicit_migration') && receipt?.status === 'ok' && after?.revision > before?.revision && receipt.revision === after.revision && after.resolved?.locale === 'fr-FR' && value('migration_after_storage')?.indexed_db === evidence.run_id;
    }, 'The actual CLI commits an explicit revision change and restores its real committed storage.');
    set('revision_retention', ['migration_snapshot_inventory','migration_before_config','explicit_migration'], () => {
      const snapshot = find('migration_snapshot_inventory').content, before = find('migration_before_config').content;
      return snapshot?.path === body('explicit_migration')?.snapshot && snapshot.files?.some(f => (f.path === 'config.json' || f.path.endsWith('/config.json')) && f.sha256 === before?.sha256) && snapshot.files.some(f => f.path.split('/').includes('data')) && snapshot.files.some(f => /manifest|integrity/.test(f.path));
    }, 'The returned cold snapshot is independently inventoried and contains the retained original config, storage and integrity metadata.');
    set('storage_rollback', ['explicit_rollback','rollback_config','migration_before_config','rollback_start','rollback_storage','migration_before_storage'], () => {
      const before = find('migration_before_config').content?.config, rolled = find('rollback_config').content?.config;
      return ok('explicit_rollback') && body('explicit_rollback')?.rolled_back === true && ok('rollback_start') && rolled?.revision === before?.revision && JSON.stringify(rolled?.resolved) === JSON.stringify(before?.resolved) && JSON.stringify(value('rollback_storage')) === JSON.stringify(value('migration_before_storage')) && value('rollback_storage')?.indexed_db === evidence.run_id;
    }, 'Actual rollback restores the previous resolved revision and the matching committed Cookie/LS/IDB snapshot.');
  }
  if (caseID === 'C1') {
    functional('multiscript_text', ['canvas_text','fonts']); functional('geometry', ['canvas_geometry']);
    functional('shader_execution', ['webgl']); functional('audio_graph', ['audio']);
    const rows = Array.isArray(evidence.runs) ? evidence.runs.filter(row => row && typeof row === 'object') : [], semantics = rows.map(row => ({ text: row.features?.canvas_text?.observed, geometry: row.features?.canvas_geometry?.observed, audio: row.features?.audio?.observed, gl: row.features?.webgl?.observed }));
    const available = rows.length === 32 && semantics.every(row => row.text?.base?.semantics && row.geometry?.base?.semantics && row.audio?.base?.semantics && row.audio?.stopped && row.gl?.semantics);
    const valid = row => {
      const canvas = value => ['context_brand','canvas_brand','context_identity','invalid_context_null'].every(key => value?.semantics?.[key] === true) && value.semantics.zero_size_error === 'IndexSizeError';
      const audio = value => ['context_brand','oscillator_brand','gain_brand','buffer_brand','connect_chain','asynchronous','completion_event','closed_state'].every(key => value?.semantics?.[key] === true) && value.semantics.invalid_channel_error === 'IndexSizeError' && value.semantics.duplicate_start_error === 'InvalidStateError';
      return [row.text.base,row.text.variant,row.geometry.base,row.geometry.variant].every(canvas)
        && ['base','frequency','gain','disconnected','stopped'].every(key => audio(row.audio[key]))
        && row.audio.stopped.samples?.length === 4096 && row.audio.stopped.samples.every(sample => typeof sample === 'number' && Math.abs(sample) < .00001)
        && ['context_brand','program_brand','buffer_brand','invalid_shader_rejected'].every(key => row.gl.semantics[key] === true);
    };
    out.objects_errors_scheduling = { status: !available ? 'not_tested' : semantics.every(valid) ? 'pass' : 'fail', detail: 'Every real lifecycle measures Canvas/Audio/GL brands, invalid operations, repeated-start errors, completion scheduling and stop-at-zero sample silence.' };
  }
  if (caseID === 'C3') for (const id of ['worker_brand','no_window_document','independent_global','async_message','termination']) functional(id, ['worker']);
  if (caseID === 'L1') {
    const starts = ['concurrent_start_1','concurrent_start_2','concurrent_start_3'];
    set('three_callers_one_lock', [...starts,'concurrent_info','concurrent_state','busy_export'], () => {
      const state = find('concurrent_state')?.content, info = body('concurrent_info');
      const pids = starts.map(name => body(name)?.pid ?? body(name)?.live?.pid ?? body(name)?.state?.pid).filter(Number.isInteger);
      return starts.every(name => ok(name) || /busy|in progress/.test(text(name))) && pids.length > 0 && new Set(pids).size === 1 && pids[0] === state?.pid && info?.live?.pid === state.pid && /busy/.test(text('busy_export'));
    }, 'Three genuinely concurrent CLI callers, persisted owner identity, live owner and held export lock must agree.');
    set('ready_after_init', ['concurrent_info','concurrent_state'], () => find('concurrent_state').content?.status === 'READY' && body('concurrent_info')?.status === 'RUNNING' && Number.isInteger(body('concurrent_info')?.live?.pid), 'Readiness is checked after the real start barrier against persisted/live state.');
    set('crash_identity_recovery', ['crash_owner','crash_drain','crash_commit_before','crash_commit_after','recovery_start','recovery_info','concurrent_state'], () => {
      const old = find('crash_owner').content, info = body('recovery_info'), before = value('crash_commit_before'), after = value('crash_commit_after');
      return old?.signal === 'SIGKILL' && Number.isInteger(old.pid) && old.pid > 1 && old.signal_target === old.pid && old.group === undefined
        && drainValid(find('crash_drain').content) && ['crash_commit_before','crash_commit_after','recovery_start','recovery_info'].every(ok)
        && ['cookie','local_storage','indexed_db'].every(key => before?.[key] === evidence.run_id && after?.[key] === evidence.run_id)
        && info?.live?.pid !== old.pid && Number.isInteger(info?.live?.pid) && find('concurrent_state').content?.pid === old.pid;
    }, 'Only the verified manager PID is killed. Original children must drain without forced cleanup, keep the global flock while alive across the probe, exit/quiesce, and preserve newly committed Cookie/LS/IDB before a new owner is admitted.');
    set('environment_isolation', ['other_before','other_after','other_state_before','other_state_after'], () => {
      const before = find('other_state_before').content, after = find('other_state_after').content;
      return ok('other_before') && ok('other_after') && value('other_before') === evidence.run_id && value('other_after') === evidence.run_id && Number.isInteger(before?.pid) && before.pid === after?.pid && Number.isFinite(before.process_start) && before.process_start === after.process_start;
    }, 'B retains its own value and the same PID/birthtime while only A’s manager is killed and recovered.');
  }
  if (caseID === 'L2') {
    functional('cookie_ls_idb_restart', ['persistence']); functional('cross_environment_absence', ['persistence']);
    set('cold_export_restore', ['storage_before_archive','cold_export','remove_archived','cold_import','restored_start','storage_after_archive','archive_bytes'], () => {
      const before = value('storage_before_archive'), after = value('storage_after_archive');
      return ['storage_before_archive','cold_export','remove_archived','cold_import','restored_start','storage_after_archive'].every(ok) && before?.cookie === evidence.run_id && before?.local_storage === evidence.run_id && before?.indexed_db === evidence.run_id && JSON.stringify(before) === JSON.stringify(after) && find('archive_bytes').content?.byte_length > 0;
    }, 'Committed Cookie/LS/IDB are compared after an actual stop, archive, original removal, import and fresh start.');
    set('busy_export', ['busy_export'], () => find('busy_export').exit_code !== 0 && /busy/.test(text('busy_export')), 'Export of an actually active environment must fail busy.');
    set('unsafe_archive', ['unsafe_import','corrupt_import'], () => find('unsafe_import').exit_code !== 0 && /unsafe archive path/.test(text('unsafe_import')) && find('corrupt_import').exit_code !== 0 && /digest mismatch|size mismatch|integrity/.test(text('corrupt_import')), 'Real traversal and content-integrity corrupt archives are rejected.');
    set('credential_policy', ['proxy_create','credential_export','credential_archive_scan','credential_archive_config'], () => {
      const file = find('credential_archive_scan').content, c = find('credential_archive_config').content;
      const proxy = c?.network?.proxy ?? c?.network?.proxy_ref, declared = c?.network?.proxy_credentials_required === true || (typeof c?.network?.proxy_ref === 'string' && c.network.proxy_ref.length > 0);
      const provided = find('proxy_create').args?.some(value => value.includes('fixture-user:fixture-password@'));
      return ok('proxy_create') && ok('credential_export') && provided && declared && file.raw_artifact?.byte_length > 0 && file.files?.some(row => row.name.endsWith('/config.json')) && file.credential_counts?.username === 0 && file.credential_counts?.password === 0 && typeof proxy === 'string' && !find('credential_export').args.includes('--include-credentials');
    }, 'A real credentialed fixture is exported with the default policy; independently retained complete archive bytes must omit the controlled credentials and retain explicit re-credential/reference metadata.');
    set('session_storage', ['session_write','session_new_page','session_after_restart'], () => ['session_write','session_new_page','session_after_restart'].every(ok) && value('session_write') === evidence.run_id && value('session_new_page') === null && value('session_after_restart') === null, 'SessionStorage is retained only within its original live page session.');
  }
  if (caseID === 'A1') {
    const operations = () => run('script_flow')?.completed ?? [];
    set('one_session_roundtrip', ['script_flow'], () => ok('script_flow') && run('script_flow')?.status === 'ok' && typeof run('script_flow')?.run_id === 'string' && new Set(operations().map(o => o.page_id).filter(Boolean)).size === 1, 'One real CLI run retains a single page/session for the complete script.');
    set('branch_loop_locator_wait', ['script_flow'], () => ok('script_flow') && run('script_flow')?.status === 'ok' && run('script_flow')?.result?.sum === 10 && run('script_flow')?.result?.branch === 'taken' && operations().some(o => /wait_for/.test(o.operation)) && operations().filter(o => /fill/.test(o.operation)).length === 4, 'Actual Python branch/loop executes four locator fills and a locator wait.');
    set('json_result', ['script_flow'], () => {
      const result = run('script_flow')?.result;
      return ok('script_flow') && run('script_flow')?.status === 'ok' && result?.value === 'loop-4' && result.expression_value === 'loop-4' && result.marker === evidence.run_id && result.expression_marker === evidence.run_id;
    }, 'The real Python consumer evaluates bare JS expressions with the default None argument, invokes an argument-taking function, and independently reads back its DOM write; all values must match this run’s controlled input.');
    set('source_location', ['script_failure'], () => run('script_failure')?.failed_location?.line > 0 && typeof run('script_failure')?.failed_location?.path === 'string', 'Failure response retains the local script source location.');
    set('completed_operations', ['script_failure'], () => run('script_failure')?.completed?.some(o => o.status === 'ok' && /evaluate/.test(o.operation)), 'Completed side effects before the actual script error are retained.');
    set('side_effect_uncertainty', ['script_failure'], () => ['completed','unknown'].includes(run('script_failure')?.side_effects?.state) && Object.hasOwn(run('script_failure')?.side_effects ?? {}, 'uncertain'), 'Failure explicitly reports completed/uncertain side effects.');
    set('stop_after_failure', ['script_failure','failure_page_state'], () => ['error','partial'].includes(run('script_failure')?.status) && run('script_failure')?.error && value('failure_page_state')?.before === evidence.run_id && value('failure_page_state')?.after === null, 'A real failure stops later writes; independent page read retains only the preceding write.');
  }
  if (caseID === 'A2') {
    set('bounded_output_screenshots', ['script_output','script_screenshot','screenshot_artifact'], () => code('script_output') === 'output_limit' && run('script_output')?.output_bytes <= 4096 && Buffer.byteLength((run('script_output')?.stdout ?? '') + (run('script_output')?.stderr ?? '')) <= 4096 && ok('script_screenshot') && find('screenshot_artifact').content?.signature === '89504e470d0a1a0a' && find('screenshot_artifact').content?.byte_length > 0 && find('screenshot_artifact').content.byte_length <= 1024 * 1024, 'Output overflow is rejected and an actual same-runtime PNG remains within the declared bound.');
    set('deadline_cancel', ['script_deadline','script_cancel','cancel_page_state'], () => code('script_deadline') === 'timeout' && (run('script_cancel')?.status === 'cancelled' || code('script_cancel') === 'cancelled') && value('cancel_page_state') === null, 'Deadline and actual CLI interruption terminate the owned task and prevent delayed writes.');
    set('axtree_coverage_masking', ['script_observation'], () => {
      const t = run('script_observation')?.result, serialized = JSON.stringify(t);
      return t && (t.coverage || t.truncated !== undefined) && (t.source || t.page_id) && !serialized.includes('private-fixture-password');
    }, 'A real bounded axtree contains coverage/source metadata and excludes the controlled password.');
    set('human_pause', ['agent_pause','agent_paused_state','agent_still_paused_state','agent_resume','script_control_boundary'], () => ['agent_pause','agent_paused_state','agent_still_paused_state','agent_resume','script_control_boundary'].every(ok) && state('agent_paused_state')?.owner === 'paused' && state('agent_still_paused_state')?.owner === 'paused' && state('agent_paused_state')?.in_flight === false && state('agent_still_paused_state')?.in_flight === false && run('script_control_boundary')?.status === 'ok', 'An actual ongoing script pauses at an action boundary until the explicit resume; physical human GUI review remains separate.');
  }
  if (caseID === 'G1') {
    set('same_live_pixels', ['viewer_before_input','viewer_after_input','viewer_retained_page_state'], () => {
      const a = find('viewer_before_input').content, b = find('viewer_after_input').content;
      return ok('viewer_retained_page_state') && a?.byte_length > 0 && b?.byte_length > 0 && a.width === b.width && a.height === b.height && typeof a.decoded_pixels_sha256 === 'string' && typeof b.decoded_pixels_sha256 === 'string' && a.decoded_pixels_sha256 !== b.decoded_pixels_sha256 && typeof a.metadata?.page_id === 'string' && a.metadata.page_id === b.metadata?.page_id && value('viewer_retained_page_state')?.value === 'handover-中文-' + evidence.run_id;
    }, 'Real same-runtime decoded frame pixels change on the same page and independent DOM state retains viewer input.');
    set('mouse_keyboard_focus_scroll_text_tabs', ['viewer_coordinate_click','viewer_select_text','viewer_insert_text','viewer_focus_next','viewer_scroll','viewer_select_tab','viewer_restore_tab','viewer_retained_page_state'], () => ['viewer_coordinate_click','viewer_select_text','viewer_insert_text','viewer_focus_next','viewer_scroll','viewer_select_tab','viewer_restore_tab'].every(ok) && value('viewer_retained_page_state')?.focus === 'secret-input' && value('viewer_retained_page_state')?.scroll_y > 0 && value('viewer_retained_page_state')?.value === 'handover-中文-' + evidence.run_id, 'Actual coordinates, keyboard focus, text, scrolling and target selection are exercised through the authenticated viewer against the live runtime.');
    set('safe_write_boundary', ['agent_pause','agent_paused_state','agent_still_paused_state'], () => ['agent_pause','agent_paused_state','agent_still_paused_state'].every(ok) && state('agent_paused_state')?.owner === 'paused' && state('agent_still_paused_state')?.owner === 'paused' && state('agent_paused_state')?.in_flight === false && state('agent_still_paused_state')?.in_flight === false && Number.isInteger(state('agent_paused_state')?.observation_revision) && state('agent_paused_state').observation_revision === state('agent_still_paused_state')?.observation_revision, 'Pause waits for a real operation boundary and no queued action executes while paused.');
    set('explicit_resume', ['agent_resume','agent_resumed_state','script_control_boundary','agent_resumed_value','script_control_boundary_selected','viewer_selection_expected','viewer_selection_before_resume','viewer_selection_resume','viewer_selection_after_resume','viewer_selection_after_reclaim','viewer_selection_original_value'], () => {
      const expected = find('viewer_selection_expected').content, chosen = expected?.selected_page_id;
      return ['agent_resume','agent_resumed_state','script_control_boundary','agent_resumed_value','viewer_selection_before_resume','viewer_selection_resume','viewer_selection_after_resume','viewer_selection_after_reclaim','viewer_selection_original_value'].every(ok)
        && state('agent_resumed_state')?.owner === 'agent' && run('script_control_boundary')?.status === 'ok' && value('agent_resumed_value') === 'boundary-5'
        && typeof chosen === 'string' && chosen !== expected.original_page_id && ['viewer_selection_before_resume','viewer_selection_after_resume','viewer_selection_after_reclaim'].every(name => body(name)?.state?.page_id === chosen)
        && find('script_control_boundary_selected').exit_code !== 0 && ['partial','error'].includes(run('script_control_boundary_selected')?.status) && code('script_control_boundary_selected') === 'stale_reference'
        && value('viewer_selection_original_value') === 'old-target-' + evidence.run_id;
    }, 'Explicit resume is exercised both on the same page and after a genuinely different human-selected tab; the stale pending write must stop without silently restoring or changing its original page.');
    set('values_retained', ['viewer_retained_page_state'], () => ok('viewer_retained_page_state') && value('viewer_retained_page_state')?.value === 'handover-中文-' + evidence.run_id, 'Viewer edits survive disconnect and explicit reclaim in the same live page.');
  }
  if (caseID === 'G2') {
    set('dom_navigation_frame_page_staleness', ['stale_dom','stale_navigation','stale_page','stale_frame'], () => ['stale_dom','stale_navigation','stale_page','stale_frame'].every(name => find(name).exit_code !== 0 && /stale_reference/.test(text(name))), 'Each real DOM/navigation/page/frame invalidation must reject the old reference before acting.');
    set('disconnect_paused', ['viewer_disconnect','viewer_state_paused'], () => ok('viewer_disconnect') && ok('viewer_state_paused') && body('viewer_state_paused')?.state?.owner === 'paused', 'Disconnected human control must remain paused.');
    set('explicit_reclaim', ['viewer_reclaim','viewer_state_reclaimed'], () => ok('viewer_reclaim') && ok('viewer_state_reclaimed') && body('viewer_state_reclaimed')?.state?.owner === 'agent', 'Explicit reclaim, not disconnect, restores Agent ownership.');
    set('coordinate_input', ['viewer_coordinate_click','viewer_insert_text','viewer_retained_page_state'], () => ['viewer_coordinate_click','viewer_insert_text','viewer_retained_page_state'].every(ok) && value('viewer_retained_page_state')?.value === 'handover-中文-' + evidence.run_id, 'Actual viewer coordinate/keyboard actions are verified against the authoritative runtime DOM; this does not substitute for IME composition review.');
  }
  if (caseID === 'N1') {
    set('proxy_before_access', ['proxy_create','proxy_info'], () => {
      const network = body('proxy_info')?.network;
      return ok('proxy_create') && ok('proxy_info') && network?.egress_policy === 'strict' && typeof (network.proxy_ref ?? network.proxy) === 'string' && (network.proxy_ref ?? network.proxy).length > 0 && find('proxy_create').args?.some(value => value.includes('127.0.0.1:'));
    }, 'The controlled unreachable proxy or private proxy reference and strict policy are persisted before starting the environment.');
    set('no_direct_fallback', ['proxy_create','proxy_start','proxy_navigation','proxy_server_events'], () => ok('proxy_create') && find('proxy_navigation').exit_code !== 0 && /network_unavailable/.test(text('proxy_start') + text('proxy_navigation')) && find('proxy_server_events').content?.receipts?.length === 0, 'Independent controlled-server receipts must remain empty on a real typed strict-proxy navigation failure.');
    set('network_unavailable', ['proxy_start','proxy_navigation'], () => /network_unavailable/.test(text('proxy_start') + text('proxy_navigation')), 'Strict proxy failure must return the typed network_unavailable result.');
  }
  return out;
}
