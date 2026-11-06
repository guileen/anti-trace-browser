window.addEventListener('message', function (event) {
  if (event.source !== parent || event.origin !== location.origin || !Number.isInteger(event.data.challenge)) return;
  parent.postMessage({ challenge: event.data.challenge, answer: event.data.challenge * 7, environment: { user_agent: navigator.userAgent, language: navigator.language, platform: navigator.platform, cores: navigator.hardwareConcurrency } }, event.origin);
});
