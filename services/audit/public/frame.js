'use strict';
window.addEventListener('message', function (event) {
  if (event.source !== parent || event.origin !== location.origin || !event.data || event.data.challenge !== 'audit-challenge-7319' || event.data.input !== 7319) return;
  parent.postMessage({ challenge: event.data.challenge, answer: event.data.input * 2, environment: { user_agent: navigator.userAgent, language: navigator.language, platform: navigator.platform, webdriver: navigator.webdriver, hardware_concurrency: navigator.hardwareConcurrency } }, location.origin);
});
