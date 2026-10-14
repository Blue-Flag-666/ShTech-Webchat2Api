// The upstream route, not a model name, identifies school-hosted models.
const modelId = /^[a-z0-9][a-z0-9._:/@+-]{0,127}$/i;
export const validModelId = value => typeof value === 'string' && modelId.test(value);
// Family recognition controls defaults only; hosting is checked separately.
export function isKimiK3Model(model) {
  const names=typeof model==='string'?[model]:[model?.id,model?.upstream_id,model?.display_name];
  return names.some(name=>typeof name==='string'&&/kimi[-_ ]?k3(?:\b|_)/i.test(name));
}
export function modelBudget(model){
  const context=Number.isInteger(model.context_window)&&model.context_window>0?model.context_window
    :Number.isInteger(model.max_tokens)&&model.max_tokens>0?model.max_tokens:16384;
  const output=Math.min(isKimiK3Model(model)?131072:16384,Math.max(1,Math.floor(context/4)));
  return{context,output};
}
export function isSelfHostedChatModel(record) {
  return validModelId(record?.aiType)
    && record.rootAiType === 'xinference'
    && (record.status===undefined||['1','3'].includes(String(record.status)));
}
export function modelDirectory(records) {
  if (!Array.isArray(records)) throw new Error('Invalid model directory');
  const result=new Map();
  const hosted=records.filter(isSelfHostedChatModel);
  const caseVariants=new Map();
  for(const record of hosted){const lower=record.aiType.toLowerCase();if(!caseVariants.has(lower))caseVariants.set(lower,new Set());caseVariants.get(lower).add(record.aiType);}
  const canonical=record=>caseVariants.get(record.aiType.toLowerCase()).size>1?record.aiType:record.aiType.toLowerCase();
  const canonicalIds=new Set(hosted.map(canonical));
  for(const record of hosted) {
    const description=[record.aiType,record.simpleName,record.aiName].filter(x=>typeof x==='string').join(' ').toLowerCase();
    const canonicalId=canonical(record);
    const aliases=new Set([canonicalId,record.aiType]);
    for(const candidate of [record.simpleName,record.aiName])if(typeof candidate==='string'){
      const alias=candidate.trim().toLowerCase().replace(/[ _]+/g,'-');
      if(modelId.test(alias))aliases.add(alias);
    }
    if(/deepseek[-_ ]?r1/.test(description)){aliases.add('deepseek-r1');aliases.add('deepseek-r1:671b');aliases.add('deepseek-reasoner');}
    if(/deepseek[-_ ]?v3/.test(description)){aliases.add('deepseek-v3');aliases.add('deepseek-v3:671b');}
    if(/deepseek[-_ ]?math/.test(description))aliases.add('deepseek-math');
    if(/qwen.*(?:code|coder)/.test(description)){aliases.add('qwen-code');aliases.add('qwen3-coder');}
    if(/qwen.*(?:instruct|3\.5)/.test(description)){aliases.add('qwen-instruct');if(/3\.5/.test(description))aliases.add('qwen3.5-397b-a17b');}
    if(/(?:chat)?glm.*5\.1/.test(description)){aliases.add('glm-5.1');aliases.add('chatglm');}
    if(/minimax.*m1/.test(description))aliases.add('minimax-m1');
    const kimiK3=isKimiK3Model({id:record.aiType,upstream_id:record.simpleName,display_name:record.aiName});
    if(kimiK3)aliases.add('kimi-k3');
    const capabilities={text:true,vision:kimiK3||/(?:vl|vision|视觉|ocr)|glm.*4v/.test(description)||aliases.has('qwen-instruct'),tools:'emulated',reasoning:Number(record.enableDeepThink)===1||kimiK3||/r1|reason|thinking|qwq|qwen3\.5|minimax.*m1/.test(description),partial:kimiK3};
    const displayName=[record.aiName,record.simpleName,record.aiType].find(value=>typeof value==='string'&&value.trim())?.trim()||record.aiType;
    for(const id of aliases) if((id===canonicalId||!canonicalIds.has(id))&&!result.has(id))result.set(id,{
      id,display_name:displayName,primary:id===canonicalId,object:'model',created:0,owned_by:'shanghaitech',root_ai_type:record.rootAiType,
      upstream_id:record.aiType,capabilities,
      ...(Number(record.enableDeepThink)===1?{webchat_thinking:true}:{}),
      ...(Number.isInteger(record.maxToken)&&record.maxToken>0?{max_tokens:record.maxToken,context_window:record.maxToken}:{}),
    });
  }
  return [...result.values()];
}
