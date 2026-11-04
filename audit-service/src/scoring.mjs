export const SUITE_VERSION = '2026.11.03.1';
export const SCHEMA_VERSION = 1;
export const STATUSES = Object.freeze(['pass', 'fail', 'unsupported', 'error', 'not_tested']);
const rule = (id, label, category, weight, probe, description, budget_ms) => Object.freeze({ id, label, category, weight, probe, description, ...(budget_ms ? { budget_ms } : {}) });
export const RULES = Object.freeze([
  rule('canvas_render', 'Canvas 真实绘制与导出', 'functionality', 15, 'canvas', '红色控制像素、文字绘制、PNG 签名和输入差异必须全部成立。'),
  rule('webgl_render', 'WebGL 清屏读回', 'functionality', 10, 'webgl', '真实 clear(红色) 后 readPixels，检查 RGBA 和 GL 错误。'),
  rule('audio_render', 'Audio 频率响应', 'functionality', 10, 'audio', '离线合成 440/880 Hz，检查非静音、RMS、过零频率与差异。'),
  rule('cookie', 'Cookie 实际往返', 'functionality', 10, 'cookie', '合成 Cookie 写入、精确读取、删除并确认删除。'),
  rule('local_storage', 'LocalStorage 实际往返', 'functionality', 10, 'local_storage', '合成键值写入、精确读取、删除并确认删除。'),
  rule('indexed_db', 'IndexedDB 事务往返', 'functionality', 10, 'indexed_db', '独立数据库内真实事务写入、读取、删除与清理。'),
  rule('dom_events', 'DOM 与事件行为', 'functionality', 15, 'dom', '节点选择、属性、文本与真实分派的冒泡事件。不是可信用户事件测试。'),
  rule('layout', 'CSS 几何布局', 'functionality', 10, 'layout', '固定尺寸元素与子元素位置的实际几何读回。'),
  rule('worker_execution', 'Worker 执行', 'functionality', 5, 'worker', '同源静态 Worker 接收挑战并实际计算响应。'),
  rule('iframe_execution', 'iframe 执行', 'functionality', 5, 'iframe', '同源 iframe 执行脚本并通过带挑战的 postMessage 返回。'),
  rule('navigator_http', 'Navigator / HTTP 家族', 'automation', 20, 'navigator', '服务实际接收的 UA 与页面 UA 家族、系统家族保持一致。'),
  rule('language_http', '语言声明一致性', 'automation', 10, 'navigator', 'navigator.language / languages 与服务收到的 Accept-Language 一致。'),
  rule('webdriver', '自动化可见标志', 'automation', 25, 'navigator', '仅明确的 navigator.webdriver === false 得分；缺失不当作隐藏成功。'),
  rule('geometry', '屏幕 / 窗口一致性', 'automation', 15, 'geometry', '屏幕、可用区域、DPR、布局视口及窗口几何关系。'),
  rule('worker_coherence', 'Worker 声明一致性', 'automation', 15, 'worker', '实际执行后比较 Worker 与主世界 UA、语言、平台和核心数。'),
  rule('iframe_coherence', 'iframe 声明一致性', 'automation', 15, 'iframe', '实际执行后比较同源 iframe 与主世界 UA、语言、平台和 webdriver。'),
  rule('canvas_privacy', 'Canvas 输出作用域证据', 'privacy', 25, 'canvas', '记录同源像素重复性、输入差异与 PNG 字节。保护评分需要独立站点作用域实验；本地重复结果列为未测。'),
  rule('audio_privacy', 'Audio 输出作用域证据', 'privacy', 15, 'audio', '记录实际音频重复性与频率差异。保护评分需要独立站点作用域实验；本地重复结果列为未测。'),
  rule('webgl_privacy', 'WebGL 调试标识收敛', 'privacy', 10, 'webgl', '只有 WebGL 实际可用且调试渲染器扩展不可用才记暴露面减少。'),
  rule('media_privacy', '媒体标识暴露收敛', 'privacy', 10, 'media', '不申请权限。仅实际存在设备、未授权、且标签和设备标识均隐藏时得分；零设备不当作保护成功。'),
  rule('font_privacy', '字体标准化证据', 'privacy', 10, 'fonts', '保留字体真实宽度；标准化评分需要参考人群或受控字体基线，当前列为未测。'),
  rule('cross_site', '跨站关联与存储隔离', 'privacy', 20, 'unmeasured', '独立站点及经验证控制通道由外部实验提供；当前固定分母内记未测。'),
  rule('public_network', '公网 IP / DNS / TLS', 'privacy', 10, 'unmeasured', '当前采样范围为本地 HTTP；公网网络栈项目单列未测。'),
  rule('cpu_workload', '确定性 CPU 工作负载', 'performance', 50, 'cpu', '8 × 1,000,000 次取模累加，校验完整结果。得分 min(1, 30ms / 实测耗时)。', 30),
  rule('dom_workload', 'DOM 构建与布局工作负载', 'performance', 50, 'dom_workload', '构建 600 个节点并选择、读文本与触发布局；校验节点数、校验和、几何。得分 min(1, 25ms / 实测耗时)。', 25),
]);
export const LIMITATIONS = Object.freeze([
  '报告来源：浏览器自报观察；评分：服务端版本化规则；底层 API 真实性认证属于外部实验范围。',
  '隐私分表示已验证的局部暴露收敛证据下界；跨站保护、匿名集和真实挑战结果分别登记覆盖。',
  '当前站点：127.0.0.1；Cookie 分区、第三方阻断、跨站指纹作用域与跨 Profile 隔离由独立控制实验补充。',
  '公网 IP、DNS、TLS、代理泄漏、真实挑战站和生产账号风控状态：not_tested；采集请求范围：本机同源。',
  '页面性能范围：确定性 CPU 与 DOM 任务；冷启动、完整进程树 RSS/CPU 和长期状态持久化由外部运行器测量。',
  '事件范围：脚本分派的合成事件；字体范围：有限候选集实际宽度；媒体范围：权限状态与设备枚举，权限请求次数为零。',
]);
const byId = new Map(RULES.map(r => [r.id, r]));
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const positive = v => finite(v) && v > 0;
const hash = v => typeof v === 'string' && /^[0-9a-f]{8}$/.test(v);
const near = (a, b, tolerance = 1) => finite(a) && Math.abs(a - b) <= tolerance;
const validTime = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s));
function jsonValue(v, depth = 0, state = { count: 0 }) {
  if (++state.count > 12000 || depth > 12) return false;
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'string') return v.length <= 65536;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 2048 && v.every(x => jsonValue(x, depth + 1, state));
  return object(v) && Object.keys(v).length <= 256 && Object.entries(v).every(([k, x]) => k.length <= 128 && !['__proto__', 'constructor', 'prototype'].includes(k) && jsonValue(x, depth + 1, state));
}
export function validateSubmission(input) {
  if (!object(input) || input.schema_version !== SCHEMA_VERSION || input.suite_version !== SUITE_VERSION) throw new Error('schema_version / suite_version 不匹配');
  if (!validTime(input.started_at) || !validTime(input.finished_at) || Date.parse(input.finished_at) < Date.parse(input.started_at)) throw new Error('运行时间无效');
  if (!Array.isArray(input.observations) || input.observations.length > RULES.length) throw new Error('observations 必须为有界数组');
  if (input.environment !== undefined && (!object(input.environment) || !jsonValue(input.environment))) throw new Error('environment 无效');
  const seen = new Set();
  for (const o of input.observations) {
    if (!object(o) || typeof o.id !== 'string' || !byId.has(o.id) || seen.has(o.id)) throw new Error('观察 ID 未知或重复');
    seen.add(o.id);
    if (!STATUSES.includes(o.status)) throw new Error('观察 status 无效');
    if (o.detail !== undefined && (typeof o.detail !== 'string' || o.detail.length > 4096)) throw new Error('观察 detail 无效');
    if (o.duration_ms !== undefined && (!finite(o.duration_ms) || o.duration_ms < 0 || o.duration_ms > 120000)) throw new Error('观察 duration_ms 无效');
    if (o.value !== undefined && !jsonValue(o.value)) throw new Error('观察 value 无效');
  }
  return input;
}
const ok = reason => ({ status: 'pass', fraction: 1, reason });
const no = reason => ({ status: 'fail', fraction: 0, reason });
const unknown = reason => ({ status: 'not_tested', fraction: 0, reason });
const canvasWorks = v => v && v.red_pixel?.length === 4 && near(v.red_pixel[0], 255, 2) && near(v.red_pixel[1], 0, 2) && near(v.red_pixel[2], 0, 2) && near(v.red_pixel[3], 255, 2) && v.painted_pixels > 20 && v.png_signature === '89504e470d0a1a0a' && [v.pixel_hash, v.repeat_pixel_hash, v.variant_pixel_hash, v.png_hash, v.repeat_png_hash].every(hash) && v.pixel_hash !== v.variant_pixel_hash;
const audioWorks = v => v && [v.hash, v.repeat_hash, v.variant_hash].every(hash) && v.hash !== v.variant_hash && v.samples === 4096 && v.sample_rate === 44100 && v.rms > 0.1 && v.rms < 0.2 && v.variant_rms > 0.1 && v.variant_rms < 0.2 && v.zero_crossings > 50 && v.zero_crossings < 100 && v.variant_zero_crossings / v.zero_crossings > 1.6 && v.variant_zero_crossings / v.zero_crossings < 2.4;
const glWorks = v => v && Array.isArray(v.pixel) && v.pixel.length === 4 && near(v.pixel[0], 255, 1) && near(v.pixel[1], 0, 1) && near(v.pixel[2], 0, 1) && near(v.pixel[3], 255, 1) && v.error === 0;
export function browserFamily(ua) {
  if (typeof ua !== 'string') return null;
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Chrome\/|Chromium\//i.test(ua)) return 'chromium';
  if (/Version\/.*Safari\//i.test(ua)) return 'safari';
  if (/Lightpanda/i.test(ua)) return 'lightpanda';
  return null;
}
function osFamily(ua) {
  if (typeof ua !== 'string') return null;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}
function verdict(id, v, duration, r) {
  switch (id) {
    case 'canvas_render': return canvasWorks(v) ? ok('真实像素、输入差异与 PNG 签名控制通过') : no('绘制、像素、输入差异或 PNG 控制未通过');
    case 'canvas_privacy': return !canvasWorks(v) ? unknown('Canvas 功能控制证据待补齐；作用域评分等待独立站点实验') : unknown(v.pixel_hash !== v.repeat_pixel_hash ? '已观察到同源像素扰动；作用域评分等待独立站点实验' : v.png_hash !== v.repeat_png_hash ? '已观察到稳定像素和变化的 PNG 字节；作用域评分等待独立站点实验' : '已观察到稳定的同源像素与 PNG；作用域评分等待独立站点实验');
    case 'webgl_render': return glWorks(v) ? ok('GL 红色清屏读回及错误控制通过') : no('真实 GL 像素或错误码不符合控制');
    case 'webgl_privacy': return glWorks(v) && v.debug_extension === false ? ok('真实 WebGL 功能控制通过，调试渲染器扩展收敛') : no('调试标识可读取，或 GL 功能控制证据待补齐');
    case 'audio_render': return audioWorks(v) ? ok('非静音、幅度与倍频控制通过') : no('样本、幅度、频率或输入差异控制失败');
    case 'audio_privacy': return unknown(audioWorks(v) ? (v.hash !== v.repeat_hash ? '已观察到同源音频样本扰动；作用域评分等待独立站点实验' : '已观察到稳定的同源音频样本；作用域评分等待独立站点实验') : 'Audio 功能控制证据待补齐；作用域评分等待独立站点实验');
    case 'cookie': case 'local_storage': return v.written === 'audit-value-7319' && v.read === 'audit-value-7319' && v.deleted === true ? ok('写入、精确读取与删除均通过') : no('存储往返或删除不正确');
    case 'indexed_db': return v.read?.marker === 'audit-value-7319' && v.read?.number === 7319 && v.deleted === true ? ok('事务完成、结构化读取与删除通过') : no('IndexedDB 事务证据不完整或被破坏');
    case 'dom_events': return v.selected === true && v.text === 'audit:7319' && v.attribute === '7319' && v.events?.join(',') === 'child,parent' && v.event_detail === 7319 ? ok('真实 DOM 状态与事件冒泡符合预期') : no('DOM 状态或事件传播与控制不符');
    case 'layout': return near(v.width, 240) && near(v.height, 80) && near(v.child_width, 48) && near(v.offset_x, 12) && near(v.offset_y, 9) ? ok('实际尺寸及相对位置正确') : no('布局几何缺失或与 CSS 控制不符');
    case 'navigator_http': {
      const a = browserFamily(v.user_agent), b = browserFamily(v.http?.user_agent), osA = osFamily(v.user_agent), osB = osFamily(v.http?.user_agent);
      return a && b && osA && osB && a === b && osA === osB && !/Headless|PhantomJS|Selenium|Playwright|Puppeteer/i.test(v.user_agent + v.http.user_agent) ? ok(`页面 / HTTP 家族一致：${a} / ${osA}；真实挑战结果由外部实验补充`) : no('家族未知、不一致或包含显式自动化标识');
    }
    case 'language_http': {
      const lang = typeof v.language === 'string' ? v.language.toLowerCase() : '';
      const header = typeof v.http?.accept_language === 'string' ? v.http.accept_language.split(',')[0].split(';')[0].trim().toLowerCase() : '';
      return lang && Array.isArray(v.languages) && v.languages[0]?.toLowerCase() === lang && lang === header ? ok('主语言、语言列表与 HTTP 首选语言一致') : no('语言声明缺失或不一致');
    }
    case 'webdriver': return v.webdriver === false ? ok('webdriver 明确为 false；仅一个可见信号') : no(v.webdriver === true ? 'webdriver 明确暴露自动化' : 'webdriver 无明确 false 证据，缺失不算通过');
    case 'geometry': return ['screen_width', 'screen_height', 'avail_width', 'avail_height', 'inner_width', 'inner_height', 'outer_width', 'outer_height', 'dpr', 'client_width'].every(k => positive(v[k])) && v.avail_width <= v.screen_width && v.avail_height <= v.screen_height && v.outer_width >= v.inner_width - 2 && v.outer_height >= v.inner_height - 2 && Math.abs(v.client_width - v.inner_width) <= 24 ? ok('屏幕、窗口与布局视口几何关系自洽') : no('几何值缺失、为零或关系矛盾');
    case 'worker_execution': case 'iframe_execution': return v.challenge === 'audit-challenge-7319' && v.answer === 14638 && v.channel_verified === true ? ok('子上下文执行并返回正确挑战响应') : no('子上下文控制通道或计算结果失败');
    case 'worker_coherence': case 'iframe_coherence': {
      const keys = id === 'worker_coherence' ? ['user_agent', 'language', 'platform', 'hardware_concurrency'] : ['user_agent', 'language', 'platform', 'webdriver'];
      return v.channel_verified === true && v.answer === 14638 && keys.every(k => v.main?.[k] !== undefined && v.child?.[k] !== undefined && v.main[k] === v.child[k]) && typeof v.child.user_agent === 'string' && v.child.user_agent.length > 5 ? ok('实际子上下文与主世界声明一致') : no('上下文通道未验证、声明缺失或不一致');
    }
    case 'media_privacy': return Array.isArray(v.devices) && v.devices.length > 0 && ['denied', 'prompt'].includes(v.camera_permission) && ['denied', 'prompt'].includes(v.microphone_permission) && v.devices.every(d => d.label === '' && d.device_id === '' && d.group_id === '') ? ok('实际设备在未授权状态下标签与标识均隐藏') : no('设备标识暴露，或零设备 / 权限未知不足以证明保护');
    case 'font_privacy': return unknown(Array.isArray(v.measurements) && v.measurements.some(m => positive(m.width) && Math.abs(m.width - v.baseline) > 0.1) ? '已记录可区分字体宽度；标准化评分等待参考人群或受控基线' : '已记录字体宽度；标准化评分等待参考人群或受控基线');
    case 'cross_site': case 'public_network': return unknown('当前范围为单站点本地 HTTP；独立站点与公网测量由外部实验补充');
    case 'cpu_workload': {
      const n = 1000000, q = Math.floor(n / 97), rest = n % 97;
      if (v.iterations !== n * 8 || v.checksum !== 8 * (q * 4656 + rest * (rest - 1) / 2)) return no('CPU 工作负载结果损坏或未完整执行');
      break;
    }
    case 'dom_workload': if (v.nodes !== 600 || v.checksum !== 179700 || v.last_text !== 'row-599' || !positive(v.layout_height)) return no('DOM 工作负载节点、校验和、文本或布局不正确'); break;
    default: return no('未定义规则');
  }
  if (!positive(duration)) return no('缺少有效实测耗时；零耗时不算无限快');
  return { status: 'pass', fraction: Math.min(1, r.budget_ms / duration), reason: `完整工作负载 ${duration.toFixed(3)} ms；预算 ${r.budget_ms} ms，按预算 / 耗时计分` };
}
export function scoreSubmission(input) {
  validateSubmission(input);
  const submitted = new Map(input.observations.map(o => [o.id, o]));
  const observations = RULES.map(r => {
    const o = submitted.get(r.id);
    let result;
    if (r.probe === 'unmeasured') result = unknown(r.description);
    else if (!o || o.value === undefined || o.value === null) result = { status: o && ['unsupported', 'error', 'not_tested'].includes(o.status) ? o.status : 'not_tested', fraction: 0, reason: o?.detail || '未提供可评分的实际观察；提交 pass 不会获得分数' };
    else if (!object(o.value)) result = no('观察值必须为带实际控制结果的对象');
    else { try { result = verdict(r.id, o.value, o.duration_ms, r); } catch { result = no('观察字段类型无效或证据结构损坏'); } }
    return { id: r.id, label: r.label, category: r.category, submitted_status: o?.status ?? 'not_tested', status: result.status, value: o?.value ?? null, detail: o?.detail ?? '', duration_ms: o?.duration_ms ?? null, reason: result.reason, earned: Number((r.weight * result.fraction).toFixed(4)), possible: r.weight };
  });
  const statuses = Object.fromEntries(STATUSES.map(s => [s, observations.filter(o => o.status === s).length]));
  const observed = statuses.pass + statuses.fail;
  const scores = Object.fromEntries(['privacy', 'automation', 'functionality', 'performance'].map(category => {
    const rows = observations.filter(o => o.category === category), possible = rows.reduce((s, o) => s + o.possible, 0), earned = rows.reduce((s, o) => s + o.earned, 0);
    return [category, { score: Number((100 * earned / possible).toFixed(2)), earned: Number(earned.toFixed(4)), possible, coverage: Number((rows.filter(o => ['pass', 'fail'].includes(o.status)).length / rows.length).toFixed(4)) }];
  }));
  return { schema_version: SCHEMA_VERSION, suite_version: SUITE_VERSION, started_at: input.started_at, finished_at: input.finished_at, environment: input.environment ?? {}, scores, coverage: { total: RULES.length, observed, ratio: Number((observed / RULES.length).toFixed(4)), statuses }, observations, limitations: LIMITATIONS, scoring: { denominator: 'fixed', missing_earned: 0, authority: 'server-recomputed-from-self-reported-observations', performance_formula: '100 × min(1, budget_ms / duration_ms), after workload integrity checks' } };
}
