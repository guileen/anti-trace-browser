// Keep independent scenario evidence separate: a missing GUI artifact must not
// erase valid script/Worker observations, and neither may waive the GUI gate.
const selections = {
  E1: /^field_(redirect|unavailable)$/,
  E2: /^field_challenge|^challenge_/,
  I2: /^(invalid_config|identity_collision|locale_|first_script_)/,
  I3: /^(migration_|preflight_|explicit_migration|explicit_rollback|rollback_)/,
  L1: /^(concurrent_|busy_export|other_|crash_|recovery_)/,
  L2: /^(storage_|archive_|cold_|busy_export|remove_archived|restored_start|session_|unsafe_import|corrupt_import|credential_|proxy_create)/,
  G1: /^(viewer_|agent_|script_control_boundary|source_control_boundary)/,
  G2: /^(stale_|axtree_|mutate_|select_|viewer_)/,
  A1: /^(script_flow|script_failure|failure_page_state|source_flow|source_failure)$/,
  A2: /^(script_(output|deadline|cancel|observation|screenshot|control_boundary)|source_(output|deadline|cancel|observation|screenshot|control_boundary)|screenshot_|cancel_|agent_|post_script_info)/,
  N1: /^proxy_/,
  T1: /^field_challenge|^challenge_/,
  T2: /^deployment_|^public_report_/,
  K1: /^customization_/,
  K2: /^performance_/,
  K3: /^release_/,
};
export const eventsForScenario = (id, events) => events.filter(event => selections[id]?.test(event.name));
