(function () {
  'use strict';
  var suite, report, activeRun, selectedCategory = 'all';
  var labels = { pass: '通过', fail: '失败', unsupported: '不支持', error: '错误', not_tested: '未测' };
  function byId(id) { return document.getElementById(id); }
  function text(id, value) { var node = byId(id); if (node) node.textContent = value; }
  function el(tag, className, value) { var node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }
  function safeUI(action) { try { action(); } catch (error) { console.warn('Audit UI:', error.message); } }
  function message(value) { safeUI(function () { text('run-message', value); }); }
  function showError(error) { safeUI(function () { var node = byId('error-box'); node.hidden = false; node.textContent = error.message || String(error); }); }
  function deadline(promise, ms, name) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(name + ' 超时（' + Math.round(ms) + ' ms）')); }, Math.max(1, ms));
      Promise.resolve(promise).then(function (value) { clearTimeout(timer); resolve(value); }, function (error) { clearTimeout(timer); reject(error); });
    });
  }
  async function jsonRequest(path, options, timeout) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeout) : null;
    options = options || {}; options.cache = 'no-store'; if (controller) options.signal = controller.signal;
    try {
      return await deadline(fetch(path, options).then(async function (response) {
        var value = await response.json();
        if (!response.ok) throw new Error(value.error || ('HTTP ' + response.status));
        return value;
      }), timeout, path);
    } finally { clearTimeout(timer); }
  }
  function progress(done, total, name) {
    safeUI(function () { text('progress-count', done + ' / ' + total); byId('run-progress').value = total ? 100 * done / total : 0; text('run-state', name); });
  }
  function renderRows(rows) {
    var container = byId('observations'); container.replaceChildren();
    rows.filter(function (row) { return selectedCategory === 'all' || row.category === selectedCategory; }).forEach(function (row) {
      var rule = suite && suite.rules.find(function (item) { return item.id === row.id; });
      var details = el('details', 'observation'), summary = el('summary');
      var title = el('span', 'rule-title'), titleText = el('span', '', row.label || (rule && rule.label) || row.id);
      titleText.appendChild(el('span', 'rule-id', row.id)); title.appendChild(titleText);
      summary.appendChild(title); summary.appendChild(el('span', 'status status-' + (row.status || 'not_tested'), labels[row.status] || '待运行'));
      summary.appendChild(el('span', 'rule-score', row.earned !== undefined ? row.earned.toFixed(2).replace(/\.00$/, '') + ' / ' + row.possible : '— / ' + (rule ? rule.weight : row.weight)));
      details.appendChild(summary);
      var body = el('div', 'observation-body');
      body.appendChild(el('p', '', rule ? rule.description : '规则版本：' + (report ? report.suite_version : '')));
      var reason = el('p'); reason.appendChild(el('strong', '', '判分理由：')); reason.appendChild(document.createTextNode(row.reason || '开始测试后记录真实结果；缺失不算通过。')); body.appendChild(reason);
      if (row.detail) body.appendChild(el('p', '', '采集说明：' + row.detail));
      if (row.duration_ms !== null && row.duration_ms !== undefined) body.appendChild(el('p', '', '实测耗时：' + row.duration_ms.toFixed(3) + ' ms'));
      if (row.submitted_status !== undefined) body.appendChild(el('p', '', '浏览器提交状态：' + row.submitted_status + '；上方状态由服务器依据实际值重算。'));
      body.appendChild(el('pre', '', JSON.stringify(row.value === undefined ? { state: 'not_started' } : row.value, null, 2)));
      details.appendChild(body); container.appendChild(details);
    });
    if (!container.childNodes.length) container.appendChild(el('p', 'empty-message', '此评分轴没有项目。'));
  }
  function renderLimitations(items) { var list = byId('limitations'); list.replaceChildren(); items.forEach(function (item) { list.appendChild(el('li', '', item)); }); }
  function renderReport(value) {
    report = value; window.__auditReport = value;
    safeUI(function () {
      Object.keys(value.scores).forEach(function (axis) {
        var score = value.scores[axis]; text('score-' + axis, Number(score.score.toFixed(1)).toString());
        byId('bar-' + axis).style.width = score.score + '%';
        text('detail-' + axis, '证据覆盖 ' + Math.round(score.coverage * 100) + '% · 获得 ' + Number(score.earned.toFixed(2)) + ' / 固定权重 ' + score.possible + (axis === 'privacy' ? '；局部证据下界' : ''));
      });
      text('coverage-main', '证据覆盖 ' + value.coverage.observed + ' / ' + value.coverage.total + ' · ' + Math.round(value.coverage.ratio * 100) + '%');
      var counts = byId('status-counts'); counts.replaceChildren();
      Object.keys(labels).forEach(function (status) { counts.appendChild(el('span', '', labels[status] + ' ' + value.coverage.statuses[status])); });
      text('report-meta', '本机已保存 · ' + new Date(value.finished_at).toLocaleString('zh-CN', { hour12: false }));
      byId('download-button').disabled = false;
      renderRows(value.observations); renderLimitations(value.limitations);
      if (typeof history.replaceState === 'function') history.replaceState(null, '', '/?report=' + encodeURIComponent(value.id));
    });
  }
  function setBusy(busy) {
    safeUI(function () { byId('start-button').disabled = busy || !byId('consent').checked; byId('consent').disabled = busy; text('start-button', busy ? '审计运行中…' : (report ? '重新运行审计 ↗' : '开始浏览器审计 ↗')); });
  }
  var ready = jsonRequest('/api/suite', {}, 8000).then(function (value) {
    suite = value;
    safeUI(function () { text('suite-version', 'SUITE ' + value.suite_version); progress(0, value.rules.length, '等待授权'); renderRows(value.rules); renderLimitations(value.limitations); });
    return value;
  });
  // Explicit automation entry point; the page itself never starts probes on load.
  window.runAudit = function () {
    if (activeRun) return activeRun;
    activeRun = (async function () {
      await ready;
      setBusy(true); safeUI(function () { byId('error-box').hidden = true; });
      var started = new Date(), deadlineAt = Date.now() + suite.deadlines.total_ms;
      var groups = [], observations = [], done = 0;
      suite.rules.forEach(function (rule) { if (groups.indexOf(rule.probe) < 0) groups.push(rule.probe); });
      for (var index = 0; index < groups.length; index++) {
        var name = groups[index], matching = suite.rules.filter(function (rule) { return rule.probe === name; });
        var start = performance.now(), result;
        if (name === 'unmeasured') result = { status: 'not_tested', detail: '当前单站点本地 HTTP 实验没有有效独立站点 / 公网控制通道。' };
        else if (Date.now() >= deadlineAt) result = { status: 'not_tested', detail: '达到全局 30 秒探针截止时间；不把未运行项目计作通过。' };
        else {
          message('正在采集：' + matching[0].label + '；单项失败会保留证据并继续。');
          try {
            var budget = Math.min(name === 'audio' ? suite.deadlines.audio_ms : suite.deadlines.probe_ms, deadlineAt - Date.now());
            var value = await deadline(Promise.resolve().then(function () { return window.AuditProbes.collect(name); }), budget, name);
            result = { status: 'pass', value: (name === 'cpu' || name === 'dom_workload') ? value.value : value, duration_ms: (name === 'cpu' || name === 'dom_workload') ? value.duration_ms : performance.now() - start };
          } catch (error) { result = { status: error.auditStatus === 'unsupported' ? 'unsupported' : 'error', detail: (error.name + ': ' + error.message).slice(0, 4096), duration_ms: Math.min(120000, Math.max(0, performance.now() - start)) }; }
        }
        matching.forEach(function (rule) { var observation = { id: rule.id, status: result.status }; if (result.value !== undefined) observation.value = result.value; if (result.detail) observation.detail = result.detail; if (result.duration_ms !== undefined) observation.duration_ms = result.duration_ms; observations.push(observation); done++; });
        progress(done, suite.rules.length, '采集中');
        // Yield between bounded workloads so progress is visible in graphical engines.
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
      message('探针已完成，正在提交原始观察并由服务器重新判分…'); progress(done, suite.rules.length, '服务器判分');
      var environment = { url: location.origin, user_agent: navigator.userAgent, collection: 'self-reported-local-browser-observations', total_probe_duration_ms: Date.now() - started.getTime(), global_deadline_ms: suite.deadlines.total_ms };
      var payload = { schema_version: suite.schema_version, suite_version: suite.suite_version, started_at: started.toISOString(), finished_at: new Date().toISOString(), observations: observations, environment: environment };
      var saved = await jsonRequest('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 10000);
      renderReport(saved); progress(done, suite.rules.length, '已保存 · 服务端判分');
      message('报告已写入本机。展开探针查看失败、缺失与未测原因；刷新或分享此本机链接可重新读取。');
      return saved;
    }()).catch(function (error) { showError(error); text('run-state', '运行未完成'); message('采集或保存遇到错误，具体原因已显示；可以重新运行。'); throw error; }).finally(function () { activeRun = null; setBusy(false); });
    return activeRun;
  };
  safeUI(function () {
    byId('consent').addEventListener('change', function () { setBusy(!!activeRun); text('run-state', byId('consent').checked ? '准备就绪' : '等待授权'); });
    byId('start-button').addEventListener('click', function () { window.runAudit().catch(function () {}); });
    byId('download-button').addEventListener('click', function () {
      if (!report) return;
      var blob = new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }), url = URL.createObjectURL(blob), link = el('a');
      link.href = url; link.download = 'browser-audit-' + report.id + '.json'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
    Array.from(byId('filters').querySelectorAll('button')).forEach(function (button) { button.addEventListener('click', function () { selectedCategory = button.getAttribute('data-category'); Array.from(byId('filters').querySelectorAll('button')).forEach(function (item) { var active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); renderRows(report ? report.observations : suite.rules); }); });
  });
  ready.then(async function () {
    var id = new URLSearchParams(location.search).get('report');
    if (!id) return;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('报告链接中的 ID 无效');
    message('正在读取本机已保存报告…');
    var value = await jsonRequest('/api/reports/' + encodeURIComponent(id), {}, 8000);
    renderReport(value); progress(value.coverage.total, value.coverage.total, '已读取保存报告'); message('当前显示已保存报告；不会因为打开报告链接而重新运行探针。');
  }).catch(showError);
}());
