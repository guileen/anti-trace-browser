'use strict';
self.onmessage = function (event) {
  if (!event.data || event.data.challenge !== 'audit-challenge-7319' || event.data.input !== 7319) return;
  self.postMessage({ challenge: event.data.challenge, answer: event.data.input * 2, environment: { user_agent: navigator.userAgent, language: navigator.language, platform: navigator.platform, hardware_concurrency: navigator.hardwareConcurrency } });
};
