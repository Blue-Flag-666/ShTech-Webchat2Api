const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const controls = new Set(['ping', 'pong', 'heartbeat', 'keepalive', 'keep-alive']);
const metadata = new Set(['id', 'object', 'created', 'model', 'system_fingerprint', 'success', 'code', 'message', 'msg', 'status', 'type', 'event', 'chatGroupId', 'chatId', 'requestId', 'conversationId', 'chat_group_id', 'chat_id', 'request_id', 'conversation_id', 'sessionId', 'session_id', 'traceId', 'trace_id', 'title', 'timestamp', 'data', 'result', 'ping', 'pong', 'heartbeat']);
const markers = new Set(['[DONE]', '[done]']);

export function protocolFailure(message) {
  return Object.assign(new Error(message), { status: 502, upstreamProtocol: true });
}

function parse(data) {
  try { return JSON.parse(data); }
  catch { throw protocolFailure('上游 SSE 包含无效 JSON'); }
}

// Normalize only explicit envelopes and recognizable control records. Arbitrary
// text/content payloads are never guessed to be deltas (they may be cumulative).
export function normalizeUpstreamEvent(item) {
  const data = item.data.trim();
  const event = (item.event || 'message').toLowerCase();
  if (markers.has(data)) return { event: 'message', data: '[DONE]' };
  if (!data || controls.has(data.toLowerCase())) return null;
  if (controls.has(event) && !/^[{["]/.test(data)) return null;
  let value = parse(data);
  const inherited = {};
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === 'string') {
      if (markers.has(value.trim())) return { event: 'message', data: '[DONE]' };
      if (controls.has(value.toLowerCase())) return null;
      value = parse(value); continue;
    }
    if (!record(value)) break;
    // Preserve application errors for the authentication/retry layer, including
    // errors hidden inside a successful HTTP 200 SSE response.
    if (value.error || value.success === false || Number(value.code) >= 400) break;
    if (Array.isArray(value.choices)) break;
    const nested = value.result ?? value.data;
    if (record(nested) || typeof nested === 'string') {
      for (const key of ['id', 'created', 'model', 'usage', 'other']) if (value[key] !== undefined) inherited[key] = value[key];
      value = nested; continue;
    }
    break;
  }
  if (record(value)) {
    value = { ...inherited, ...value };
    if (value.error || value.success === false || Number(value.code) >= 400) return { event: 'message', data: JSON.stringify(value) };
    if (Array.isArray(value.choices)) {
      const choices = value.choices.map((choice, index) => record(choice) ? {
        ...choice, index: choice.index ?? index,
        ...(choice.delta === undefined && record(choice.message) ? { delta: choice.message } : {}),
        ...(choice.delta === undefined && typeof choice.text === 'string' ? { delta: { content: choice.text } } : {})
      } : choice);
      return { event: 'message', data: JSON.stringify({ ...value, choices }) };
    }
    if (value.usage !== undefined || value.other !== undefined) return { event: 'message', data: JSON.stringify(value) };
    const keys = Object.keys(value);
    const kind = value.type ?? value.event;
    const status = value.status;
    const safeStatus = status === undefined || [0, 200, 'ok', 'success', 'start', 'processing', 'running', 'connected'].includes(status) || controls.has(String(status).toLowerCase());
    const explicitControl = controls.has(event) || kind !== undefined || status !== undefined && safeStatus || value.success === true || value.code !== undefined && [0, 200].includes(Number(value.code));
    if ((!keys.length || keys.every(key => metadata.has(key))) &&
      (kind === undefined || controls.has(String(kind).toLowerCase()) || ['metadata', 'status', 'start'].includes(kind)) &&
      safeStatus && (explicitControl || value.message === undefined && value.msg === undefined && status === undefined) &&
      (value.data === undefined || value.data === null) && (value.result === undefined || value.result === null)) return null;
  }
  // Include only structural hints. Never put response text, tokens or arbitrary
  // upstream errors into logs or client-visible diagnostics.
  const known = record(value) ? Object.keys(value).filter(key => metadata.has(key)).sort().join(',') : '';
  const shape = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  throw protocolFailure(`未知上游 SSE 格式（结构 ${shape}${known ? `，已知字段 ${known}` : ''}）；请提供网页 EventStream 的脱敏样例`);
}
