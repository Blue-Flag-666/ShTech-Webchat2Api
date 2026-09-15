import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractImages, prepareImages } from '../src/images.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('三种协议的图片块转成文本消息和统一图片输入',()=>{
  const chat=extractImages('/v1/chat/completions',{messages:[{role:'user',content:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:`data:image/png;base64,${png}`}}]}]});
  assert.equal(chat.input.messages[0].content,'看图');assert.equal(chat.images.length,1);
  const responses=extractImages('/v1/responses',{input:[{role:'user',content:[{type:'input_text',text:'看图'},{type:'input_image',image_url:'https://example.com/a.png'}]}]});
  assert.equal(responses.input.input[0].content,'看图');assert.equal(responses.images.length,1);
  const messages=extractImages('/v1/messages',{messages:[{role:'user',content:[{type:'text',text:'看图'},{type:'image',source:{type:'base64',media_type:'image/png',data:png}}]}]});
  assert.equal(messages.input.messages[0].content.length,1);assert.match(messages.images[0],/^data:image\/png/);
});

test('图片上传生成 Webchat 图片字段且不泄露上传响应',async()=>{
  let request;
  const fetcher=async(url,options)=>{request={url,options};return new Response(JSON.stringify({success:true,result:{url:'abc.png',width:1,height:2}}),{headers:{'content-type':'application/json'}});};
  const result=await prepareImages([`data:image/png;base64,${png}`],{uploadToken:'upload'},'access',AbortSignal.timeout(1000),fetcher);
  assert.equal(request.url,'https://genaipic.shanghaitech.edu.cn/sys/common/upload');assert.equal(request.options.headers.token,'upload');
  assert.deepEqual(result,{imageUrl:'https://genaipic.shanghaitech.edu.cn/sys/common/static/abc.png',imageUrls:['https://genaipic.shanghaitech.edu.cn/sys/common/static/abc.png'],width:1,height:2});
});

test('拒绝视频、非用户图片和不支持格式',async()=>{
  assert.throws(()=>extractImages('/v1/chat/completions',{messages:[{role:'assistant',content:[{type:'image_url',image_url:{url:'https://example.com/a.png'}}]}]}),/user/);
  assert.throws(()=>extractImages('/v1/responses',{input:[{role:'user',content:[{type:'input_video',video_url:'x'}]}]}),/内容块/);
  await assert.rejects(()=>prepareImages(['data:image/svg+xml;base64,YQ=='],{uploadToken:'x'},'x',AbortSignal.timeout(1000)),/不支持/);
});
