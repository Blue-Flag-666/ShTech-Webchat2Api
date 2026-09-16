// Conservative catalogue policy: a domestic model family AND an explicit
// self-hosted Xinference route are required. Unknown providers are not guessed.
const domestic = /^(?:qwen|qwq|deepseek|chatglm|glm|mini[-_]?max|kimi|moonshot|internlm|internvl|yi|baichuan|ernie|wenxin|doubao|seed|hunyuan|spark|xinghuo|stepfun|step|abab|xverse|aquila|skywork|telechat|cogvlm|codegeex)(?:$|[-_.:\d])/i;
const foreign = /(?:gpt|claude|gemini|llama|mistral|mixtral|gemma|grok|command-r|openai|anthropic|azure|cohere|phi[-_.\d]|falcon)/i;
export function isDomesticSelfHosted(record) {
  return typeof record?.aiType === 'string'
    && record.rootAiType === 'xinference'
    && domestic.test(record.aiType)
    && !foreign.test([record.aiType,record.aiName,record.simpleName].filter(value=>typeof value==='string').join(' '));
}
export function modelDirectory(records) {
  if (!Array.isArray(records)) throw new Error('Invalid model directory');
  const result=new Map();
  for(const record of records.filter(isDomesticSelfHosted)) {
    const description=[record.aiType,record.simpleName,record.aiName].filter(x=>typeof x==='string').join(' ').toLowerCase();
    const aliases=new Set([record.aiType]);
    for(const candidate of [record.simpleName,record.aiName])if(typeof candidate==='string'){
      const alias=candidate.trim().toLowerCase().replace(/[ _]+/g,'-');
      if(/^[a-z0-9][a-z0-9.:-]{0,127}$/.test(alias)&&domestic.test(alias)&&!foreign.test(alias))aliases.add(alias);
    }
    if(/deepseek[-_ ]?r1/.test(description)){aliases.add('deepseek-r1');aliases.add('deepseek-r1:671b');aliases.add('deepseek-reasoner');}
    if(/deepseek[-_ ]?v3/.test(description)){aliases.add('deepseek-v3');aliases.add('deepseek-v3:671b');}
    if(/deepseek[-_ ]?math/.test(description))aliases.add('deepseek-math');
    if(/qwen.*(?:code|coder)/.test(description)){aliases.add('qwen-code');aliases.add('qwen3-coder');}
    if(/qwen.*(?:instruct|3\.5)/.test(description)){aliases.add('qwen-instruct');if(/3\.5/.test(description))aliases.add('qwen3.5-397b-a17b');}
    if(/(?:chat)?glm.*5\.1/.test(description)){aliases.add('glm-5.1');aliases.add('chatglm');}
    if(/minimax.*m1/.test(description))aliases.add('minimax-m1');
    const kimiK3=/kimi[-_ ]?k3/.test(description);
    if(kimiK3)aliases.add('kimi-k3');
    const capabilities={text:true,vision:kimiK3||/(?:vl|vision|视觉|ocr)|glm.*4v/.test(description)||aliases.has('qwen-instruct'),tools:'emulated',reasoning:kimiK3||/r1|reason|thinking|qwq|qwen3\.5|minimax.*m1/.test(description),partial:kimiK3};
    for(const id of aliases) if(!result.has(id))result.set(id,{
      id,object:'model',created:0,owned_by:'shanghaitech',root_ai_type:record.rootAiType,
      upstream_id:record.aiType,capabilities,
      ...(Number.isInteger(record.maxToken)&&record.maxToken>0?{max_tokens:record.maxToken,context_window:record.maxToken}:{}),
    });
  }
  return [...result.values()];
}
