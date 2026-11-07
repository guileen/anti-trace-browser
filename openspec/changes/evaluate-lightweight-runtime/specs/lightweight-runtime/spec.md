## ADDED Requirements

### Requirement: Evidence-driven acceptance
The system SHALL use a versioned, runtime-independent acceptance manifest and preserve observations separately from verdicts. Any required check with fail, unsupported, error, not_tested or review_required prevents overall acceptance. Missing, stale, incompatible or collector-failed evidence SHALL NOT be converted into pass or omitted from the denominator. Privacy, functionality, challenge outcome and performance SHALL have separate results.

#### Scenario: E1 Ordinary redirects and missing observations
- **WHEN** a visit redirects normally, times out, or produces no usable observation
- **THEN** a normal completed visit is reached, a collection failure is error, and missing evidence is not_tested; cleared requires verified challenge completion evidence.

#### Scenario: E2 Challenge evidence and human review
- **WHEN** an active challenge is served with HTTP 403, or a page contains a vendor name, or an iframe is invisible
- **THEN** the report retains HTTP status, challenge markers and phase separately; active challenge is challenge, vendor prose is passive evidence, and clearance follows a verified receipt. A reviewer can inspect redacted raw results, screenshot and timeline.

#### Scenario: E3 Independent and full-scope checks
- **WHEN** a runtime passes published probes
- **THEN** independently generated inputs also exercise text and geometry Canvas, audio input response, GL execution, Worker/iframe parity and persistence. A missing required API retains its requirement and coverage status; aggregate scores preserve that gap. Cross-site tests use two distinct schemeful sites.

### Requirement: Stable and differentiated environments
The system SHALL persist seed, overrides, resolved configuration, generator version, runtime digest and relevant assets before first navigation. Configuration precedence SHALL be explicit overrides over seeded defaults, validated against actual supported capabilities. Same-environment stability SHALL cover the recorded characteristics; different-environment differentiation SHALL cover the predefined supported feature combination, retaining shared physical outputs explicitly.

#### Scenario: I1 Two environments across lifecycles
- **WHEN** A and B use the same runtime and controlled rendering inputs through repeated reads, refresh, new pages and A1/B1/A2/B2 restarts
- **THEN** each environment retains its configuration and input-dependent outputs under recorded host/backend/resource/version conditions. The predefined A/B distinguishing feature combination is reproducible and attributed to real supported configuration differences; shared physical outputs remain recorded. Canvas pixels and export metadata, Audio samples, GL parameters/readback, fonts, screen and cores are observed separately. Missing evidence remains outstanding; historical verdicts retain their original suite version.

#### Scenario: I2 Realms, overrides and uniqueness conflicts
- **WHEN** supported overrides are applied at creation and the page creates frames and Workers
- **THEN** all supported realms and outgoing requests consume the same config revision before site code runs; illegal combinations return invalid_config, collisions return identity_collision, and API absence is reported by capability. Locale remains user-selected even when the exit country differs.

#### Scenario: I3 Upgrade or cross-host restore
- **WHEN** a profile is restored with a changed runtime, generator, font bundle or host
- **THEN** a compatibility check reports differences before use, retains the prior resolved revision, and requires explicit migration for changed output; rollback restores the previous revision and compatible storage snapshot.

### Requirement: Capability-grounded implementation
The runtime SHALL expose implemented capabilities with correct observable semantics and a feature manifest. Implementation language SHALL be evaluated through observable behavior and maintenance cost. Runtime-owned initialization is the configuration boundary; page-level API replacement is retained only as labeled experimental evidence.

#### Scenario: C1 Graphic and audio functionality
- **WHEN** rendering text in multiple scripts, transforming geometry, compiling shaders or changing oscillator frequency and graph connections
- **THEN** supported APIs produce input-dependent results with valid errors, object semantics and scheduling; unsupported APIs follow their declared absence or disabled behavior. Feature absence remains visible to product gates.

#### Scenario: C2 Header and network contract
- **WHEN** navigation, fetch, subresources, redirects and Worker requests cross HTTP/HTTPS and supported protocol versions
- **THEN** server-observed headers are compared with requested configuration and JS observations using request-context rules; unknown headers are review_required. Fetch Metadata, Client Hints, GPC/DNT and Priority are evaluated by policy, security context and protocol rather than unconditional presence rules.

#### Scenario: C3 Worker global semantics
- **WHEN** a page creates a Worker and sends a controlled input
- **THEN** the Worker observes Worker-global object semantics, independent global state and asynchronous message/termination behavior; Window and Document remain outside its API surface. Configuration parity and realm correctness retain separate evidence.

### Requirement: Isolated durable environment lifecycle
The manager SHALL own one process lease per managed environment, store profile data separately, and provide crash-safe export/import. Attached runtimes SHALL retain external lifecycle ownership.

#### Scenario: L1 Concurrent start and crash
- **WHEN** three callers start one environment or the lease owner crashes
- **THEN** exactly one owner holds the OS lock; readiness is published after initialization; stale metadata is reconciled with process identity and lock ownership before recovery; a second environment remains independent.

#### Scenario: L2 Persistent storage and archive
- **WHEN** a committed Cookie, LocalStorage and IndexedDB fixture is restarted or cold-exported and restored
- **THEN** its content is preserved within that environment and absent from the other environment; an active environment returns busy for export; unsafe archive paths are rejected and credentials follow an explicit export policy. SessionStorage follows page-session semantics.

### Requirement: Basic GUI and shared control
Each of Camoufox, Obscura and Lightpanda SHALL be evaluated against the same basic GUI contract: real page imagery and mouse, keyboard, focus, scroll, text input and tab selection, sharing the same live environment with Agent execution. Headless execution and an on-demand viewer SHALL share page/storage ownership.

#### Scenario: G1 Human handover and resume
- **WHEN** an Agent fills a form, yields to a person, and the person edits text or selects another tab
- **THEN** pending Agent writes stop at a safe boundary, the viewer shows the same session, and explicit resume refreshes the selected target and observation revision before the next action; values persist through handover.

#### Scenario: G2 Stale reference or disconnected viewer
- **WHEN** DOM ordering, navigation, frame identity or selected page changes after axtree, or the viewer disconnects while holding control
- **THEN** an outdated reference returns stale_reference before acting; disconnected human control remains paused until an explicit reclaim. Screenshot/coordinate input is tested against the actual page, including IME composition.

### Requirement: Familiar single-session scripting
The CLI SHALL provide run as a trusted local Python asynchronous Playwright script entry with page, context and bounded axtree/result helpers. It SHALL retain one browser connection and serialized control lease for the script. Only the declared Playwright-compatible subset is advertised per runtime.

#### Scenario: A1 Branch and loop with failure
- **WHEN** one script navigates, loops through items, conditionally clicks, waits for a locator and returns JSON
- **THEN** it runs in one session with one caller round trip; a failure yields source location, completed operation evidence and side-effect uncertainty, with subsequent writes stopped. Retries require explicit caller action.

#### Scenario: A2 Bounded observation and cancellation
- **WHEN** a script emits large output, reaches its deadline, is cancelled or is paused for human control
- **THEN** output and screenshots are bounded by the run policy, axtree carries source/coverage metadata and masks sensitive values, and the owned task terminates without terminating an externally owned browser.

### Requirement: Controlled proxy and egress behavior
The system SHALL apply the declared proxy before page access, retain user identity settings across restarts, and record observed egress independently. Strict proxy policy SHALL stop protected navigation when the proxy is unavailable.

#### Scenario: N1 Proxy failure and DNS coverage
- **WHEN** a proxy disconnects or routing changes during navigation
- **THEN** strict mode returns network_unavailable with no direct fallback; DNS, IPv4/IPv6, WebRTC and UDP paths are checked with controlled endpoints or packet evidence. SOCKS protocol selection and cf-ray location are recorded separately from measured egress.

#### Scenario: N2 Network and engine attribution
- **WHEN** comparing engines and exit networks
- **THEN** randomized repeated runs record engine, headless mode, egress, profile state and time; same-exit shared failures remain a correlation until exit-controlled observations update the attribution. Real accounts remain outside experiments.

### Requirement: Authoritative self-hosted challenge lab
The lab SHALL preserve the indexable fingerprint-test.ipub.io overview and isolate consented experiments, secrets and challenge policy. It SHALL distinguish synthetic PoW, Turnstile Siteverify and WAF Managed Challenge evidence.

#### Scenario: T1 Verified Turnstile attempt
- **WHEN** a browser submits a fresh token for a server-issued experiment nonce
- **THEN** the server validates Siteverify success, expected hostname, action, nonce binding and expiry, atomically consumes the nonce, and issues a run-bound receipt. Replayed/invalid tokens are rejected, service failure yields error, and cleared follows receipt verification.

#### Scenario: T2 Deployment and public report safety
- **WHEN** deploying challenge policy or publishing a report
- **THEN** deployment records exact account/resource scope, current-state snapshot and rollback; existing production rules remain intact. Public reports contain no tokens, proxy credentials, Cookie values, raw personal IP or private seeds. Absent challenge credentials are capability_unavailable; the public overview continues to work.

### Requirement: Three-runtime racing and evidence-gated release
The project SHALL implement both Obscura and Lightpanda and evaluate them alongside the pinned Camoufox reference with the same required contracts. No primary-runtime choice SHALL be a prerequisite for implementation. Reused components SHALL preserve one authoritative DOM, network and storage owner per environment. Eventual selection SHALL follow complete evidence for configuration, GUI, storage, protocol, security, licensing, maintenance and performance; no winner is predetermined.

#### Scenario: K1 Comparable customization trial
- **WHEN** each candidate implements the same persistent configuration-to-page/network slice and attempts the GUI/persistence fixture
- **THEN** the report includes pinned source/toolchain, patch boundaries, raw CDP and client traces, clean and incremental build times, dependencies, license review and remaining implementation effort. Adapter failures are isolated from runtime failures before kernel patches are planned.

#### Scenario: K2 Performance and selection gate
- **WHEN** the candidates complete identical DOM/JS and separately identical visual tasks on the same host
- **THEN** cold/warm startup, task latency median/p95, CPU time, process-tree sampled peak RSS, resources loaded, IPC round trips and output bytes are reported with at least ten measured runs and raw samples. Both implementations continue independently of eventual ranking. Missing mandatory GUI or identity behavior keeps that candidate experimental; a winner is considered only after full functional and cost evidence, not published probe counts.

#### Scenario: K3 Release evidence and maintenance
- **WHEN** promoting any of the three runtimes
- **THEN** its reproducible build, dependency/license inventory, security/sandbox review, clean-install CLI smoke, human GUI sign-off, identity matrix and regression artifacts are linked to its own release. All required product scenarios SHALL have current comparable evidence; component tests or another runtime's pass SHALL NOT substitute. Camoufox security updates use the same pinned-version protocol.

### Requirement: Independent Lightpanda headless project
The headless service SHALL be separately runnable through a versioned local process protocol. Headless SHALL own page execution, network, storage, rendering and input state. Client-only changes SHALL leave browser-kernel source and standalone headless operation unchanged. Platform claims SHALL identify the native runtime separately.

#### Scenario: D1 Headless navigation and real page input
- **WHEN** a local client requests an HTTP(S) address, history navigation, reload, tab creation/selection/closure and page typing or clicking
- **THEN** the actual headless page supplies every returned content pixel, input uses the same page/observation/control revision, and remote page content executes solely in headless.

#### Scenario: D2 Owned service lifecycle and failure
- **WHEN** startup fails, another process owns the profile, the child disconnects or the client exits
- **THEN** errors remain explicit, the existing owner remains alive, the service closes only its own runtime, and a reopen restores committed profile data. A disconnected human lease stays paused until explicit handover.

#### Scenario: D3 Independent installation and platform evidence
- **WHEN** running headless on a supported platform
- **THEN** it starts without a GUI dependency, packaged artifacts identify runtime/font/license inputs, and untested or unavailable native-runtime platforms retain their actual status.

### Requirement: Authentic and stable fingerprint computation
Lightweight runtimes SHALL generate Canvas, Audio and WebGL outputs through real rendering and computation. Acceptance SHALL combine input-response semantics, data provenance, input-conditioned statistics, environment stability and reproducible environment differentiation. Chrome provides a compatibility and empirical reference rather than byte-identical output targets.

#### Scenario: F1 Real computation and input-conditioned observations
- **WHEN** independent tests vary text/fonts, geometry, colors, alpha, transforms, audio graphs or shader inputs across Window, iframe and supported Worker paths
- **THEN** outputs respond through actual rendering/computation; decoded exports, readback and displayed content agree. The report preserves raw pixels/samples and hash, color/alpha/spatial/edge or frequency/energy statistics with their input and reference coverage. Functional and metamorphic assertions validate meaning; missing required behavior remains outstanding.

#### Scenario: F2 Stable environments and explainable differentiation
- **WHEN** A and B persist different supported configuration combinations across repeat reads, refreshes, new pages and A1/B1/A2/B2 restarts
- **THEN** each retains its fixed-input outputs, each predefined distinguishing item has a real configuration cause and reproducible difference, and API/realm/declaration consistency and storage isolation also hold. Shared outputs remain visible; runtime/assets/backend changes require explicit revision. Engine-specific output differences from Chrome are evaluated by function and evidence rather than byte equality.

#### Scenario: F3 Independent negative controls and empirical bounds
- **WHEN** the judge receives valid monochrome fixtures, forged constant outputs, spatially shuffled images with matching histograms, or audio that ignores graph inputs
- **THEN** valid fixtures satisfy their input-specific assertions while each semantically wrong result is rejected. Statistical rules and reference-derived bounds are versioned and frozen before candidate scoring, with sample size and host coverage recorded. A close hash or statistic alone does not grant passage; historical verdicts remain unchanged.
