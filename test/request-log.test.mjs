import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestLogger, routeLabel } from '../src/request-log.mjs';

test('访问日志仅使用归一化路由，轮转时不记录敏感路径或正文',()=>{
  const dir=mkdtempSync(join(tmpdir(),'shtech-access-log-'));
  try{
    const file=join(dir,'access.log'),logger=new RequestLogger(file,{maxBytes:120,backups:2});
    assert.equal(routeLabel('/v1/responses/secret-response-id/input_items'),'/v1/responses/:id');
    for(let index=0;index<5;index++)logger.observe({requestId:`req-${index}`,method:'POST',path:'/v1/responses/secret-response-id/input_items',status:200,durationMs:12.4});
    const names=readdirSync(dir).filter(name=>name.startsWith('access.log'));
    assert.ok(names.length>=2);assert.ok(names.length<=3);
    const contents=names.map(name=>readFileSync(join(dir,name),'utf8')).join('');
    assert.match(contents,/"route":"\/v1\/responses\/:id"/);
    assert.match(contents,/"request_id_hash":"[0-9a-f]{16}"/);
    assert.doesNotMatch(contents,/secret-response-id|req-\d|authorization|cookie|messages/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
