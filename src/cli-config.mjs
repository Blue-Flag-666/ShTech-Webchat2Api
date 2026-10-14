import { parseEnv } from 'node:util';

export function inspectionTimeout(command,timeout=120000){
  if(!['models','opencode','opencode-v2','doctor'].includes(command))return 5000;
  // Initial login + catalogue, followed by at most one forced login + read.
  return 2*(Math.min(timeout,35000)+Math.min(timeout,10000))+5000;
}

// dotenv values are not JSON strings. Check the actual runtime parser before
// saving credentials so backslashes, quotes and comment markers stay literal.
export function envValue(value){
  if(typeof value!=='string'||/[\r\n\0]/.test(value))throw new Error('配置值不能包含换行符或空字符');
  const candidates=[value,...["'",'"','`'].map(quote=>`${quote}${value}${quote}`)];
  for(const candidate of candidates){
    try{if(parseEnv(`VALUE=${candidate}\n`).VALUE===value)return candidate;}catch{}
  }
  throw new Error('配置值的引号组合无法原样保存到 .env，请使用对应的 _FILE 配置读取凭据文件');
}
