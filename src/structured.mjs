import { isIP } from 'node:net';

const invalid=message=>Object.assign(new Error(message),{status:400});
const failed=message=>Object.assign(new Error(message),{status:502});
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

export function outputPolicy(path,input) {
  let format;
  if(path==='/v1/chat/completions') format=input.response_format;
  else if(path==='/v1/responses') format=input.text?.format;
  else format=input.output_config?.format;
  if(format===undefined || format?.type==='text') return null;
  if(!format || typeof format!=='object' || Array.isArray(format)) throw invalid('输出格式必须是对象');
  if(format.type==='json_object') return {type:'json_object',schema:{type:'object'}};
  if(format.type!=='json_schema') throw invalid('当前仅支持 text、json_object 和 json_schema 输出格式');
  const descriptor=path==='/v1/chat/completions' ? format.json_schema : format;
  if(!descriptor || typeof descriptor!=='object' || Array.isArray(descriptor)) throw invalid('json_schema 缺少定义');
  if(path!=='/v1/messages' && (typeof descriptor.name!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(descriptor.name))) throw invalid('json_schema.name 无效');
  if(descriptor.strict!==undefined&&typeof descriptor.strict!=='boolean')throw invalid('json_schema.strict 必须是布尔值');
  checkSchema(descriptor.schema,descriptor.schema);
  if(descriptor.strict===false)return {type:'json_object',schema:{type:'object'},name:descriptor.name || 'output',strict:false};
  return {type:'json_schema',schema:descriptor.schema,name:descriptor.name || 'output',strict:true};
}

export function outputPrompt(policy) {
  if(!policy)return '';
  return `Return only one JSON value with no Markdown fences or surrounding commentary. The value must match this JSON Schema:\n${JSON.stringify(policy.schema)}`;
}

function checkSchema(schema,root,depth=0) {
  if(depth>64 || !schema || typeof schema!=='object' || Array.isArray(schema)) throw invalid('JSON Schema 无效或嵌套过深');
  const allowed=new Set(['$schema','$id','$ref','$defs','definitions','$comment','title','description','default','examples','deprecated','readOnly','writeOnly','nullable','type','enum','const','anyOf','oneOf','allOf','properties','required','additionalProperties','minProperties','maxProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','pattern','format','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf']);
  for(const key of Object.keys(schema)) if(!allowed.has(key)) throw invalid(`暂不支持 JSON Schema 关键字 ${key}`);
  if(schema.$ref!==undefined) resolveRef(schema.$ref,root);
  const validTypes=new Set(['null','boolean','object','array','number','integer','string']);
  const types=Array.isArray(schema.type)?schema.type:schema.type===undefined?[]:[schema.type];
  if(!types.every(x=>typeof x==='string'&&validTypes.has(x)) || Array.isArray(schema.type)&&(!types.length||new Set(types).size!==types.length)) throw invalid('JSON Schema type 无效');
  if(schema.required!==undefined && (!Array.isArray(schema.required) || !schema.required.every(x=>typeof x==='string') || new Set(schema.required).size!==schema.required.length))throw invalid('JSON Schema required 无效');
  if(schema.enum!==undefined && (!Array.isArray(schema.enum) || !schema.enum.length))throw invalid('JSON Schema enum 无效');
  if(schema.pattern!==undefined) {
    if(typeof schema.pattern!=='string')throw invalid('JSON Schema pattern 无效');
    try{new RegExp(schema.pattern,'u');}catch{throw invalid('JSON Schema pattern 无效');}
  }
  for(const key of ['minItems','maxItems','minProperties','maxProperties','minLength','maxLength'])if(schema[key]!==undefined&&(!Number.isInteger(schema[key])||schema[key]<0))throw invalid(`JSON Schema ${key} 无效`);
  if(schema.uniqueItems!==undefined&&typeof schema.uniqueItems!=='boolean')throw invalid('JSON Schema uniqueItems 无效');
  for(const key of ['deprecated','readOnly','writeOnly','nullable'])if(schema[key]!==undefined&&typeof schema[key]!=='boolean')throw invalid(`JSON Schema ${key} 无效`);
  if(schema.format!==undefined&&!['date-time','date','time','email','hostname','ipv4','ipv6','uri','uuid'].includes(schema.format))throw invalid('JSON Schema format 无效');
  for(const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum'])if(schema[key]!==undefined&&typeof schema[key]!=='number')throw invalid(`JSON Schema ${key} 无效`);
  if(schema.multipleOf!==undefined&&(!(schema.multipleOf>0)||!Number.isFinite(schema.multipleOf)))throw invalid('JSON Schema multipleOf 无效');
  for(const key of ['anyOf','oneOf','allOf']) if(schema[key]!==undefined) {
    if(!Array.isArray(schema[key]) || !schema[key].length) throw invalid(`JSON Schema ${key} 无效`);
    for(const child of schema[key])checkSchema(child,root,depth+1);
  }
  if(schema.properties!==undefined) {
    if(!schema.properties || typeof schema.properties!=='object' || Array.isArray(schema.properties)) throw invalid('JSON Schema properties 无效');
    for(const child of Object.values(schema.properties))checkSchema(child,root,depth+1);
  }
  if(schema.items!==undefined)checkSchema(schema.items,root,depth+1);
  if(schema.additionalProperties!==undefined && typeof schema.additionalProperties!=='boolean')checkSchema(schema.additionalProperties,root,depth+1);
  for(const defs of [schema.$defs,schema.definitions]) if(defs!==undefined) {
    if(!defs || typeof defs!=='object' || Array.isArray(defs))throw invalid('JSON Schema definitions 无效');
    for(const child of Object.values(defs))checkSchema(child,root,depth+1);
  }
}

function resolveRef(ref,root) {
  if(typeof ref!=='string' || !ref.startsWith('#/')) throw invalid('仅支持本地 JSON Schema $ref');
  let value=root;
  for(const part of ref.slice(2).split('/').map(x=>x.replaceAll('~1','/').replaceAll('~0','~'))) {
    if(!value || typeof value!=='object' || !own(value,part))throw invalid('JSON Schema $ref 无法解析');
    value=value[part];
  }
  return value;
}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function validFormat(value,format){
  if(format==='email')return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if(format==='hostname')return value.length<=253&&value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if(format==='ipv4')return isIP(value)===4;
  if(format==='ipv6')return isIP(value)===6;
  if(format==='uuid')return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if(format==='uri'){try{const url=new URL(value);return Boolean(url.protocol);}catch{return false;}}
  if(format==='date')return /^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if(format==='time')return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value);
  if(format==='date-time')return /^\d{4}-\d{2}-\d{2}T/.test(value)&&!Number.isNaN(Date.parse(value));
  return true;
}
function validate(value,schema,root,path='$',depth=0) {
  if(depth>64)throw failed('结构化输出嵌套过深');
  if(schema.$ref)return validate(value,resolveRef(schema.$ref,root),root,path,depth+1);
  if(schema.const!==undefined && !equal(value,schema.const))throw failed(`结构化输出 ${path} 不符合 const`);
  if(schema.enum && !schema.enum.some(x=>equal(value,x)))throw failed(`结构化输出 ${path} 不符合 enum`);
  if(value===null&&schema.nullable===true)return;
  if(schema.allOf)for(const child of schema.allOf)validate(value,child,root,path,depth+1);
  if(schema.anyOf && !schema.anyOf.some(child=>{try{validate(value,child,root,path,depth+1);return true;}catch{return false;}}))throw failed(`结构化输出 ${path} 不符合 anyOf`);
  if(schema.oneOf && schema.oneOf.filter(child=>{try{validate(value,child,root,path,depth+1);return true;}catch{return false;}}).length!==1)throw failed(`结构化输出 ${path} 不符合 oneOf`);
  const types=Array.isArray(schema.type)?schema.type:schema.type?[schema.type]:[];
  const actual=value===null?'null':Array.isArray(value)?'array':Number.isInteger(value)?'integer':typeof value;
  if(types.length && !types.includes(actual) && !(actual==='integer'&&types.includes('number')))throw failed(`结构化输出 ${path} 类型错误`);
  if(value && typeof value==='object' && !Array.isArray(value)) {
    const count=Object.keys(value).length;
    if(schema.minProperties!==undefined&&count<schema.minProperties)throw failed(`结构化输出 ${path} 属性过少`);
    if(schema.maxProperties!==undefined&&count>schema.maxProperties)throw failed(`结构化输出 ${path} 属性过多`);
    for(const key of schema.required || [])if(!own(value,key))throw failed(`结构化输出缺少 ${path}.${key}`);
    for(const [key,child] of Object.entries(schema.properties || {}))if(own(value,key))validate(value[key],child,root,`${path}.${key}`,depth+1);
    for(const key of Object.keys(value))if(!own(schema.properties || {},key)) {
      if(schema.additionalProperties===false)throw failed(`结构化输出包含未允许字段 ${path}.${key}`);
      if(schema.additionalProperties && typeof schema.additionalProperties==='object')validate(value[key],schema.additionalProperties,root,`${path}.${key}`,depth+1);
    }
  }
  if(Array.isArray(value)) {
    if(schema.minItems!==undefined&&value.length<schema.minItems)throw failed(`结构化输出 ${path} 项数过少`);
    if(schema.maxItems!==undefined&&value.length>schema.maxItems)throw failed(`结构化输出 ${path} 项数过多`);
    if(schema.items)value.forEach((x,i)=>validate(x,schema.items,root,`${path}[${i}]`,depth+1));
    if(schema.uniqueItems&&new Set(value.map(x=>JSON.stringify(x))).size!==value.length)throw failed(`结构化输出 ${path} 包含重复项`);
  }
  if(typeof value==='string') {
    if(schema.minLength!==undefined&&[...value].length<schema.minLength)throw failed(`结构化输出 ${path} 字符过短`);
    if(schema.maxLength!==undefined&&[...value].length>schema.maxLength)throw failed(`结构化输出 ${path} 字符过长`);
    if(schema.pattern!==undefined) { let pattern;try{pattern=new RegExp(schema.pattern,'u');}catch{throw invalid('JSON Schema pattern 无效');}if(!pattern.test(value))throw failed(`结构化输出 ${path} 不匹配 pattern`); }
    if(schema.format!==undefined&&!validFormat(value,schema.format))throw failed(`结构化输出 ${path} 不符合 ${schema.format} 格式`);
  }
  if(typeof value==='number') {
    if(schema.minimum!==undefined&&value<schema.minimum)throw failed(`结构化输出 ${path} 小于 minimum`);
    if(schema.maximum!==undefined&&value>schema.maximum)throw failed(`结构化输出 ${path} 大于 maximum`);
    if(schema.exclusiveMinimum!==undefined&&value<=schema.exclusiveMinimum)throw failed(`结构化输出 ${path} 不大于 exclusiveMinimum`);
    if(schema.exclusiveMaximum!==undefined&&value>=schema.exclusiveMaximum)throw failed(`结构化输出 ${path} 不小于 exclusiveMaximum`);
    if(schema.multipleOf!==undefined&&Math.abs(value/schema.multipleOf-Math.round(value/schema.multipleOf))>1e-9)throw failed(`结构化输出 ${path} 不符合 multipleOf`);
  }
}

// Tool declarations use the same JSON Schema vocabulary as structured output.
// Keep the validator separate from output parsing so tool arguments can be
// checked after a model-generated call has been decoded.
export function validateSchemaValue(value,schema) {
  checkSchema(schema,schema);
  validate(value,schema,schema);
  return value;
}

export function parseStructured(content,policy) {
  if(!policy)return content;
  if(typeof content!=='string')throw failed('模型没有返回有效 JSON');
  const fenced=[...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match=>match[1]);
  let value;const candidates=[content,content.trim().replace(/^```(?:json)?\s*|\s*```$/gi,''),...fenced];
  const start=content.search(/[\[{]/),end=Math.max(content.lastIndexOf('}'),content.lastIndexOf(']'));
  if(start>=0&&end>start)candidates.push(content.slice(start,end+1));
  for(const candidate of candidates){try{value=JSON.parse(candidate);break;}catch{}}
  if(value===undefined)throw failed('模型没有返回有效 JSON');
  if(policy.type==='json_object' && (!value || typeof value!=='object' || Array.isArray(value)))throw failed('模型没有返回 JSON 对象');
  validate(value,policy.schema,policy.schema);
  return JSON.stringify(value);
}
