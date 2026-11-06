'use strict';
importScripts('/authenticity-core.js');
self.onmessage = async function (event) {
  if (!event.data || !event.data.input) return;
  var result = await AuthenticityCore.collect(event.data.input, true);
  self.postMessage({ run_id: event.data.run_id, realms: result });
};
