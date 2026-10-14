import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverUploadToken, extractImages, retainedImages, prepareImages } from '../src/images.mjs';
import { normalizeRequest } from '../src/protocols.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('三种协议的图片块转成文本消息和统一图片输入',()=>{
  const chat=extractImages('/v1/chat/completions',{messages:[{role:'user',content:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:`data:image/png;base64,${png}`}}]}]});
  assert.match(chat.input.messages[0].content,/看图\n\[shtech-image-/);assert.equal(chat.images.length,1);
  const responses=extractImages('/v1/responses',{input:[{role:'user',content:[{type:'input_text',text:'看图'},{type:'input_image',image_url:'https://example.com/a.png'}]}]});
  assert.match(responses.input.input[0].content,/看图\n\[shtech-image-/);assert.equal(responses.images.length,1);
  const toolOutput=extractImages('/v1/responses',{input:[{type:'function_call_output',call_id:'call_1',output:[{type:'input_text',text:'截图'},{type:'input_image',image_url:`data:image/png;base64,${png}`}]}]});
  assert.match(toolOutput.input.input[0].output,/截图\n\[Tool result image attached\] \[shtech-image-/);
  assert.equal(toolOutput.images.length,1);
  const computer=extractImages('/v1/responses',{input:[{type:'computer_call_output',call_id:'call_2',output:{type:'computer_screenshot',image_url:`data:image/png;base64,${png}`}}]});
  assert.equal(computer.images.length,1);assert.equal(computer.input.input[0].output.image_url,undefined);
  const messages=extractImages('/v1/messages',{messages:[{role:'user',content:[{type:'text',text:'看图'},{type:'image',source:{type:'base64',media_type:'image/png',data:png}}]}]});
  assert.equal(messages.input.messages[0].content.length,2);assert.match(messages.images[0],/^data:image\/png/);
  const resultImage=extractImages('/v1/messages',{messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'tool_1',content:[{type:'text',text:'截图'},{type:'image',source:{type:'base64',media_type:'image/png',data:png}}]}]}]});
  assert.equal(resultImage.images.length,1);
  assert.equal(resultImage.input.messages[0].content[0].content[0].text,'截图');
  assert.match(resultImage.input.messages[0].content[0].content[1].text,/^\[Tool result image attached\] \[shtech-image-/);
});

test('历史缩减后仅保留仍在消息中的图片，并清除内部标记',()=>{
  const media=extractImages('/v1/chat/completions',{messages:[
    {role:'user',content:[{type:'text',text:'旧图'},{type:'image_url',image_url:'https://example.com/old.png'}]},
    {role:'assistant',content:'已看'},
    {role:'user',content:[{type:'text',text:'新图'},{type:'image_url',image_url:'https://example.com/new.png'}]}
  ]});
  const kept=[media.input.messages.at(-1)];
  assert.deepEqual(retainedImages(media,kept),['https://example.com/new.png']);
  assert.equal(kept[0].content,'新图\n[Image attached]');
  assert.equal(media.input.messages[0].content,'旧图\n[Image attached]');
  assert.doesNotMatch(JSON.stringify(media.input),/shtech-image-/);
});

test('Responses 电脑截图在协议转换后仍与工具结果关联',()=>{
  const media=extractImages('/v1/responses',{input:[
    {type:'computer_call',call_id:'call_screen',action:{type:'screenshot'}},
    {type:'computer_call_output',call_id:'call_screen',output:{type:'computer_screenshot',image_url:'https://example.com/screen.png'}}
  ]});
  const normalized=normalizeRequest('/v1/responses',media.input);
  assert.deepEqual(retainedImages(media,normalized.messages),['https://example.com/screen.png']);
  assert.equal(normalized.messages.at(-1).content,'Computer screenshot captured.');
  assert.equal(media.input.input[1].output.image_marker,undefined);
});

test('Responses Agent 结果内容块中的图片随工具文本一起保留',()=>{
  const media=extractImages('/v1/responses',{input:[
    {type:'program',call_id:'call_program',code:'return 1'},
    {type:'program_output',call_id:'call_program',result:[
      {type:'output_text',text:'生成图表'},
      {type:'input_image',image_url:'https://example.com/chart.png'}
    ]}
  ]});
  const messages=normalizeRequest('/v1/responses',media.input).messages;
  assert.deepEqual(retainedImages(media,messages),['https://example.com/chart.png']);
  assert.equal(messages.at(-1).content,'生成图表\n[Tool result image attached]');
  assert.doesNotMatch(JSON.stringify(media.input),/shtech-image-/);
});

test('图片上传生成 Webchat 图片字段且不泄露上传响应',async()=>{
  let request;
  const fetcher=async(url,options)=>{request={url,options};return new Response(JSON.stringify({success:true,result:{url:'abc.png'}}),{headers:{'content-type':'application/json'}});};
  const result=await prepareImages([`data:image/png;base64,${png}`],{uploadToken:'upload'},'access',AbortSignal.timeout(1000),fetcher);
  assert.equal(request.url,'https://genaipic.shanghaitech.edu.cn/sys/common/upload');assert.equal(request.options.headers.token,'upload');
  assert.ok(!Object.keys(request.options.headers).some(name=>['x-access-token','authorization','cookie'].includes(name.toLowerCase())));
  assert.ok(!Object.values(request.options.headers).includes('access'));
  assert.deepEqual(result,{imageUrl:'https://genaipic.shanghaitech.edu.cn/sys/common/static/abc.png',imageUrls:['https://genaipic.shanghaitech.edu.cn/sys/common/static/abc.png'],width:1,height:1});
});

test('从公开前端自动发现图片上传 token',async()=>{
  const calls=[];
  const frontend=async url=>{
    calls.push(url);
    const path=new URL(url).pathname;
    if(path==='/dashboard/analysis')return new Response('<script src="/js/app.abc.js"></script><link href=/js/chunk-image.def.js rel=prefetch>');
    if(path==='/js/app.abc.js')return new Response('"./dashboard/Analysis.vue":["chunk-base","chunk-image"]');
    if(path==='/js/chunk-image.def.js')return new Response('uploadImageFile:function(){var f=new FormData;f.set("uploadType","local");return "/sys/common/upload",{Accept:"*/*",token:"public-upload-token-123"}}');
    return new Response('',{status:404});
  };
  assert.equal(await discoverUploadToken(AbortSignal.timeout(1000),frontend),'public-upload-token-123');
  assert.equal(calls.length,3);
});

test('未配置上传 token 时自动发现后上传',async()=>{
  let token;
  const upload=async(_,options)=>{token=options.headers.token;return new Response(JSON.stringify({success:true,result:{url:'auto.png'}}));};
  const frontend=async url=>{
    const path=new URL(url).pathname;
    if(path==='/dashboard/analysis')return new Response('<script src=/js/app.abc.js></script><link href=/js/chunk-image.def.js>');
    if(path==='/js/app.abc.js')return new Response('"./dashboard/Analysis.vue":["chunk-image"]');
    return new Response('uploadImageFile:function(){var f=new FormData;f.set("uploadType","local");return "/sys/common/upload",{token:"auto-public-token-456"}}');
  };
  await prepareImages([`data:image/png;base64,${png}`],{},'access',AbortSignal.timeout(1000),upload,frontend);
  assert.equal(token,'auto-public-token-456');
});

test('上传配置可直接放在新版入口中并保留资源版本查询参数',async()=>{
  const paths=[];
  const frontend=async url=>{
    const parsed=new URL(url);paths.push(parsed.pathname+parsed.search);
    if(parsed.pathname==='/dashboard/analysis')return new Response('<script type="module" src="/assets/index-ABC_123.js?v=2&amp;build=3"></script>');
    return new Response('uploadImageFile:function(){return "/sys/common/upload",{token:"entry-upload-token-123"}}');
  };
  assert.equal(await discoverUploadToken(AbortSignal.timeout(1000),frontend),'entry-upload-token-123');
  assert.deepEqual(paths,['/dashboard/analysis','/assets/index-ABC_123.js?v=2&build=3']);
});

test('入口动态加载的同源脚本也可发现上传配置，跳过外站与 API 路径',async()=>{
  const paths=[];
  const frontend=async url=>{
    const parsed=new URL(url),path=parsed.pathname+parsed.search;paths.push(path);
    if(path==='/dashboard/analysis')return new Response('<script src="/assets/index.js"></script>');
    if(path==='/assets/index.js')return new Response('import("./Analysis-123.js?v=2"); import("https://example.com/assets/upload.js"); import("/htk/user/private.js");');
    if(path==='/assets/Analysis-123.js?v=2')return new Response('export { upload } from "./upload-456.mjs";');
    if(path==='/assets/upload-456.mjs')return new Response('uploadType:"local",FormData,{token:"dynamic-upload-token-789"}');
    throw new Error(`Unexpected frontend request: ${path}`);
  };
  assert.equal(await discoverUploadToken(AbortSignal.timeout(1000),frontend),'dynamic-upload-token-789');
  assert.deepEqual(paths,['/dashboard/analysis','/assets/index.js','/assets/Analysis-123.js?v=2','/assets/upload-456.mjs']);
});

test('动态脚本链和循环引用仍受每页八个候选脚本的读取上限约束',async()=>{
  const paths=[];
  const frontend=async url=>{
    const path=new URL(url).pathname;paths.push(path);
    if(path==='/'||path==='/dashboard/analysis')return new Response('<script src="/assets/index.js"></script>');
    if(path==='/assets/index.js')return new Response('import("./chunk0.js")');
    const number=Number(/chunk(\d+)\.js$/.exec(path)?.[1]);
    assert.ok(Number.isInteger(number)&&number<8);
    return new Response(`import("./index.js"); import("./chunk${number+1}.js");`);
  };
  await assert.rejects(discoverUploadToken(AbortSignal.timeout(1000),frontend),/upload token not found/);
  assert.equal(paths.length,20);
  assert.equal(paths.filter(path=>path==='/assets/index.js').length,2);
});

test('无 Vue 路由映射时检查同源预加载脚本并跳过缺失资源',async()=>{
  const paths=[];
  const frontend=async url=>{
    const path=new URL(url).pathname;paths.push(path);
    if(path==='/dashboard/analysis')return new Response('<script src="/assets/index.js"></script><link rel="modulepreload" href="/assets/missing.js"><link rel="modulepreload" href="/assets/upload.js"><script src="https://example.com/js/foreign.js"></script>');
    if(path==='/assets/index.js')return new Response('export const app = {};');
    if(path==='/assets/missing.js')return new Response('',{status:404});
    return new Response('uploadType:"local",FormData,{token:"preload-upload-token-456"}');
  };
  assert.equal(await discoverUploadToken(AbortSignal.timeout(1000),frontend),'preload-upload-token-456');
  assert.deepEqual(paths,['/dashboard/analysis','/assets/index.js','/assets/missing.js','/assets/upload.js']);
});

test('图片上传凭据发现可在聊天页不可用时回退到站点首页',async()=>{
  const calls=[];
  const frontend=async url=>{
    const path=new URL(url).pathname;calls.push(path);
    if(path==='/dashboard/analysis')return new Response('',{status:503});
    if(path==='/')return new Response('<script src=/js/app.fallback.js></script><link href=/js/chunk-image.fallback.js>');
    if(path==='/js/app.fallback.js')return new Response('"./dashboard/Analysis.vue":["chunk-image"]');
    return new Response('uploadImageFile:function(){var f=new FormData;f.set("uploadType","local");return "/sys/common/upload",{token:"fallback-upload-token-789"}}');
  };
  assert.equal(await discoverUploadToken(AbortSignal.timeout(1000),frontend),'fallback-upload-token-789');
  assert.deepEqual(calls.slice(0,2),['/dashboard/analysis','/']);
});

test('拒绝视频、非用户图片和不支持格式',async()=>{
  assert.throws(()=>extractImages('/v1/chat/completions',{messages:[{role:'assistant',content:[{type:'image_url',image_url:{url:'https://example.com/a.png'}}]}]}),/user/);
  assert.throws(()=>extractImages('/v1/responses',{input:[{role:'user',content:[{type:'input_video',video_url:'x'}]}]}),/内容块/);
  await assert.rejects(()=>prepareImages(['data:image/svg+xml;base64,YQ=='],{uploadToken:'x'},'x',AbortSignal.timeout(1000)),/不支持/);
});

test('图片必须严格小于 10 MiB',async()=>{
  const exact=Buffer.alloc(10*1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(exact);
  await assert.rejects(()=>prepareImages([`data:image/png;base64,${exact.toString('base64')}`],{uploadToken:'x'},'x',AbortSignal.timeout(1000)),/小于 10 MiB/);
});
