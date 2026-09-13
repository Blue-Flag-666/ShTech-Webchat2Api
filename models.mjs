// Conservative catalogue policy: a domestic model family AND an explicit
// self-hosted Xinference route are required. Unknown providers are not guessed.
const domestic = /^(?:qwen|deepseek|chatglm|glm|mini[-_]?max|kimi|internlm|yi)(?:$|[-_.\d])/i;
const foreign = /(?:gpt|claude|gemini|llama|mistral|gemma|grok|command-r|openai|anthropic|azure)/i;
export function isDomesticSelfHosted(record) {
  return typeof record?.aiType === 'string'
    && record.rootAiType === 'xinference'
    && domestic.test(record.aiType)
    && !foreign.test(record.aiType + ' ' + (record.aiName || ''));
}
export function modelDirectory(records) {
  if (!Array.isArray(records)) throw new Error('Invalid model directory');
  return [...new Map(records.filter(isDomesticSelfHosted).map(x => [x.aiType, {
    id: x.aiType, object: 'model', created: 0, owned_by: 'shanghaitech',
    root_ai_type: x.rootAiType,
    ...(Number.isInteger(x.maxToken) && x.maxToken > 0 ? { max_tokens: x.maxToken } : {}),
  }])).values()];
}
