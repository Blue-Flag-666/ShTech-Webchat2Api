const numericCode = value => /^(?:[1-9]\d{0,8}|0)$/.test(String(value ?? '')) ? Number(value) : undefined;

export function upstreamBusinessFailure(value, model) {
  const code = numericCode(value?.code ?? value?.error?.code);
  const raw = typeof value?.message === 'string' ? value.message : typeof value?.msg === 'string' ? value.msg
    : typeof value?.error?.message === 'string' ? value.error.message : typeof value?.error === 'string' ? value.error : '';
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
  } else if (code === 429 || /限流|too many requests|rate.?limit/i.test(raw)) {
    status = 429; category = 'rate_limit'; hint = '上游请求频率或并发超限';
  } else if (code === 503 || /繁忙|排队|overload|busy|temporarily unavailable|服务.{0,12}(?:不可用|维护)/i.test(raw)) {
    status = 503; category = 'busy'; hint = '上游服务繁忙或暂时不可用';
  } else if (code === 504 || /超时|timed?\s*out|timeout/i.test(raw)) {
    status = 504; category = 'timeout'; hint = '上游处理超时';
  }
  const failure = Object.assign(new Error(`${hint}（模型 ${model}，上游业务码 ${code ?? '未提供'}，分类 ${category}）`), { status, category });
  if (category === 'context_length_exceeded') failure.code = category;
  return failure;
}
