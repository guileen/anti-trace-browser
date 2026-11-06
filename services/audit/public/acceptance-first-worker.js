'use strict';
var firstScriptSnapshot = { user_agent: navigator.userAgent, platform: navigator.platform, locale: navigator.language, languages: Array.from(navigator.languages || []), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, hardware_concurrency: navigator.hardwareConcurrency, document_type: typeof document, window_type: typeof window };
self.onmessage = function () { self.postMessage(firstScriptSnapshot); };
