import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const invalid=()=>Object.assign(new Error('reasoning.encrypted_content 无效或无法解密'),{status:400,param:'input'});
const key=secret=>createHash('sha256').update('shtech-webchat2api-reasoning-v1\0').update(String(secret)).digest();

export function sealReasoning(text,secret){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),nonce);
  const encrypted=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return `enc_v1_${Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url')}`;
}

export function openReasoning(token,secret){
  if(typeof token!=='string'||!/^enc_v1_[A-Za-z0-9_-]+$/.test(token)||token.length>12*1024*1024)throw invalid();
  try{
    const data=Buffer.from(token.slice(7),'base64url');
    if(data.length<28)throw invalid();
    const decipher=createDecipheriv('aes-256-gcm',key(secret),data.subarray(0,12));
    decipher.setAuthTag(data.subarray(12,28));
    return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');
  }catch{throw invalid();}
}
