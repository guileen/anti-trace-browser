// Reviewed source facts, kept with runner evidence rather than claiming vendor
// benchmark ratios are local measurements. Build metadata is not a binary SBOM.
export const runtimeFacts = {
  lightpanda: {
    release: '1.0.2',
    source_tag_commit: 'c5f7bb29b127040c899d4e181b5709f76fc71a6f',
    license: 'AGPL-3.0-or-later (source headers); AGPL v3 LICENSE',
    language_boundary: 'Browser coordination, DOM/WebAPI wrappers, networking and protocol integration have Zig sources. JavaScript executes in V8 C++, exposed through zig-v8 C bindings; HTML parsing uses Rust html5ever; HTTP uses libcurl. This is not a pure-Zig JavaScript engine or dependency-free Zig build.',
    build_boundary: 'build.zig links libc/libc++, V8, Curl, Rust, SQLite and PCRE2; prebuilt_v8_path accepts an already-built V8 library. make download-v8 can supply a cache. Changing Zig browser code can reuse V8; changing V8 needs its separate toolchain. Prebuilt browser executable used here, no source compilation.',
    toolchain_conflict: 'The observed 1.0.2 README says Zig 0.15.2, but build.zig.zon at the same tag declares minimum_zig_version 0.17.0 and version 1.1.0-dev. The manifest and build check are the authority for a source build; do not promise the README toolchain works. Downloaded version command independently returned 1.0.2.',
    interfaces: ['CLI fetch', 'CDP WebSocket on /', 'WebDriver BiDi/classic server mode', 'MCP stdio/HTTP', 'V8-backed Runtime.evaluate'],
    rendering: 'README describes PNG/PDF as text-only rendering. Source screenshot.zig delegates font/layout/raster work to Rust and exposes PNG output; that is not equivalent to a full CSS/compositor webpage renderer. Real webpage CSS pixels are not credited merely because Page.captureScreenshot returns PNG.',
    resources: 'serve defaults do not load iframe, worker, stylesheet or image resource families. The comparison explicitly enables all four; images are not decoded (help says only the first 16KB is read for natural dimensions).',
    telemetry: 'Upstream enables usage telemetry by default. Runner sets LIGHTPANDA_DISABLE_TELEMETRY=true and LIGHTPANDA_DISABLE_CORE_DUMP=1.',
    development_assessment: 'Suitable for Zig-side DOM/CDP/network changes and DOM-first workload evaluation. V8 remains the JS runtime; full visual browser parity is a separate development project. Local performance and probe evidence, not implementation language, decide suitability.',
    sources: [
      'https://github.com/lightpanda-io/browser/releases/tag/1.0.2',
      'https://api.github.com/repos/lightpanda-io/browser/git/ref/tags/1.0.2',
      'https://github.com/lightpanda-io/browser/blob/1.0.2/README.md',
      'https://github.com/lightpanda-io/browser/blob/1.0.2/LICENSE',
      'https://github.com/lightpanda-io/browser/blob/1.0.2/build.zig',
      'https://github.com/lightpanda-io/browser/blob/1.0.2/build.zig.zon',
      'https://github.com/lightpanda-io/browser/blob/1.0.2/src/lightpanda.zig',
      'https://github.com/lightpanda-io/browser/blob/1.0.2/src/browser/js/js.zig',
      'https://github.com/lightpanda-io/browser/blob/1.0.2/src/browser/screenshot.zig',
    ],
  },
  obscura: {
    release: '0.2.6', license: 'Apache-2.0 (upstream README)',
    architecture: 'Rust, V8, independent CSS layout/paint; render+stealth release selected. Stealth transport uses wreq/BoringSSL. No Chromium subprocess required by upstream architecture.',
    development_inputs: 'Compare actual CDP method failures, WebAPI probes, CSS pixel correctness and persistent storage evidence before accepting compatibility claims. Local stealth evidence is not a third-party challenge result.',
    sources: ['https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.6', 'https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/README.md'],
  },
  moli: {
    release: '1.1.21', installed_comparator_version: '1.1.20', license: 'Apache-2.0 license file is present; dependency licenses require separate review',
    architecture: 'Rust/V8 with Taffy layout and Parley text layout, on-demand layout/paint. Default mock geometry is not real layout; runner opts into --layout and --resource. Screenshot rebuilds current DOM/style rather than assuming geometry reads continuously refresh frozen layout.',
    development_inputs: 'Use paired installed/current measurements, protocol receipts and per-probe gaps; do not treat default mock geometry or disabled resources as a performance win.',
    sources: ['https://github.com/lexmount/moli/releases/tag/v1.1.21', 'https://github.com/lexmount/moli/blob/v1.1.21/README.md', 'https://github.com/lexmount/moli/blob/v1.1.21/LICENSE-APACHE'],
  },
};
