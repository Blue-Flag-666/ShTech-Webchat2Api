const numericCode = value => /^(?:[1-9]\d{0,8}|0)$/.test(String(value ?? '')) ? Number(value) : undefined;
const textFields = ['message', 'msg', 'errorMessage', 'error_description', 'detail', 'errMsg', 'errorMsg', 'reason'];
function errorTexts(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3 || value.choices) return [];
  const texts = textFields.flatMap(key => typeof value[key] === 'string' && value[key] ? [value[key]] : []);
  if (typeof value.error === 'string') texts.push(value.error);
  for (const key of ['error', 'result', 'data']) texts.push(...errorTexts(value[key], depth + 1));
  return texts;
}

export function upstreamDiagnostic(value, secrets = []) {
  const redact = text => {
    for (const secret of [...secrets].filter(item => typeof item === 'string' && item.length >= 4).sort((a,b)=>b.length-a.length)) text = text.split(secret).join('[redacted]');
    text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
      .replace(/\bBearer\s+[^\s"',;}]+/gi, 'Bearer [redacted]')
      .replace(/(["']?(?:x-access-token|authorization|cookie|password|api[_-]?key|token|username)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]');
    return text.slice(0, 1024);
  };
  return { business_code: numericCode(value?.code ?? value?.error?.code) ?? null,
    errors: errorTexts(value).slice(0, 4).map(redact) };
}

export function upstreamBusinessFailure(value, model, secrets = []) {
  const code = numericCode(value?.code ?? value?.error?.code);
  const raw = errorTexts(value).join('\n');
  let status = [401, 403, 429, 502, 503, 504].includes(code) ? code : 502;
  let category = 'unknown', hint = '上游未能完成请求';
  if (code === 401 || /token.*(?:失效|过期|expired|invalid)|请重新登录|登录已过期|unauthorized/i.test(raw)) {
    status = 401; category = 'authentication'; hint = '登录已失效';
  } else if (code === 403 || /无权限|没有权限|permission denied|forbidden/i.test(raw)) {
    status = 403; category = 'permission'; hint = '模型访问权限不足';
  } else if (/上下文|context.{0,30}(?:length|window)|(?:input|prompt).{0,20}too long|输入.{0,12}过长/i.test(raw)) {
    status = 400; category = 'context_length_exceeded'; hint = '请求超过上游上下文限制，请缩短历史或降低输出额度';
  } else if (code === 400 || /参数|invalid.{0,20}(?:parameter|argument)|model.{0,20}(?:not found|not exist)|模型.{0,12}(?:不存在|无效)/i.test(raw)) {
    status = 400; category = 'invalid_request'; hint = '上游不接受请求参数或模型配置';
  } else if (/额度|余额|quota|balance/i.test(raw)) {
    status = 429; category = 'quota'; hint = '上游额度不足';
  } else if (code === 429 || /限流|请求.{0,8}(?:频繁|过快|超频)|并发.{0,8}(?:超限|超过)|too many requests|rate.?limit/i.test(raw)) {
    status = 429; category = 'rate_limit'; hint = '上游请求频率或并发超限';
  } else if (code === 503 || /繁忙|排队|overload|busy|temporarily unavailable|服务.{0,12}(?:不可用|维护)/i.test(raw)) {
    status = 503; category = 'busy'; hint = '上游服务繁忙或暂时不可用';
  } else if (code === 504 || /超时|timed?\s*out|timeout/i.test(raw)) {
    status = 504; category = 'timeout'; hint = '上游处理超时';
  }
  // Classification guides recovery, but must not replace an explicit upstream status.
  if (code >= 400 && code <= 599) status = code;
  const messages = upstreamDiagnostic(value, secrets).errors;
  const failure = Object.assign(new Error(messages.join('; ') || `${hint}（模型 ${model}，上游业务码 ${code ?? '未提供'}，分类 ${category}）`), { status, category });
  if (code !== undefined) failure.code = code;
  else if (category === 'context_length_exceeded') failure.code = category;
  return failure;
}

export async function upstreamHttpFailure(response, model, secrets = []) {
  const reader = response.body?.getReader(), pieces = [];
  let size = 0;
  try {
    while (reader && size < 16384) {
      const {done, value} = await reader.read();
      if (done) break;
      const piece = value.subarray(0, 16384 - size);
      pieces.push(piece); size += piece.length;
    }
  } finally { if (reader) { void reader.cancel().catch(()=>{}); reader.releaseLock(); } }
  const text = Buffer.concat(pieces).toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch { value = {message:text}; }
  const diagnostic = upstreamDiagnostic(value, secrets);
  const failure = Object.assign(new Error(diagnostic.errors.join('; ') || `上游 HTTP ${response.status}`), {status:response.status});
  const code = value?.error?.code ?? value?.code;
  if (typeof code === 'number' || typeof code === 'string') failure.code = upstreamDiagnostic({message:String(code)}, secrets).errors[0];
  if (typeof code === 'number' && Number.isFinite(code)) failure.code = code;
  return failure;
}
