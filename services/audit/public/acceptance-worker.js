self.onmessage = async function (event) {
  try {
    if (event.data.delayed) { setTimeout(function () { self.postMessage({ unexpected_after_termination: true }); }, 50); return; }
    var before = typeof self.__acceptance_worker_marker === 'undefined' ? null : self.__acceptance_worker_marker;
    self.__acceptance_worker_marker = event.data.marker;
    var scheduling = ['sync'];
    await new Promise(function (resolve) {
      Promise.resolve().then(function () { scheduling.push('microtask'); });
      setTimeout(function () { scheduling.push('timer'); resolve(); }, 0);
    });
    var response = await fetch('/api/echo?context=worker&run_id=' + encodeURIComponent(event.data.run_id), { cache: 'no-store' });
    if (!response.ok) throw new Error('Worker HTTP echo failed');
    self.postMessage({ challenge: event.data.challenge, answer: event.data.challenge * 7, global_before: before, scheduling: scheduling, environment: { user_agent: navigator.userAgent, language: navigator.language, platform: navigator.platform, cores: navigator.hardwareConcurrency }, realm: { document_type: typeof document, window_type: typeof window, worker_global: typeof DedicatedWorkerGlobalScope === 'function' && self instanceof DedicatedWorkerGlobalScope }, http: await response.json() });
  } catch (error) { throw error; }
};
