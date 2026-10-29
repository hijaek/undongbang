// Run: node scripts/mobile-qa.mjs. Binds loopback only; no production credentials.
import {build} from 'esbuild';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,sep} from 'node:path';
await mkdir('.sites-runtime/mobile-e2e',{recursive:true});
await Promise.all([
 build({entryPoints:['tests/browser/entry.tsx'],outfile:'.sites-runtime/mobile-e2e/app.js',bundle:true,platform:'browser',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}}),
 build({entryPoints:['tests/browser/server.ts'],outfile:'.sites-runtime/mobile-e2e/api.mjs',bundle:true,platform:'node',format:'esm',packages:'external'})
]);
const qa=await import('../.sites-runtime/mobile-e2e/api.mjs');
let fault='';const requests=[];
const controls=()=>`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>격리된 모바일 검사</title><style>body{font:16px sans-serif;padding:16px}a{display:block;padding:12px;border:1px solid #aaa;margin:8px 0}pre{white-space:pre-wrap}</style><h1>격리된 모바일 검사</h1><p>로컬 데이터만 사용합니다. 초대 코드 QA1234.</p>${['host','member','long','new','join','anonymous'].map(r=>`<a href="/__qa/login?as=${r}">${r} 계정으로 앱 열기</a>`).join('')}<h2>다음 요청 오류</h2>${['comments','rests','upload','delete','admin','none'].map(k=>`<a href="/__qa/fault?kind=${k}">${k} 오류 1회</a>`).join('')}<p>대기 중: ${fault||'없음'}</p><a href="/__qa/state">저장된 테스트 데이터</a><a href="/__qa/requests">요청 결과</a>`;
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,qa.origin);
 if(url.pathname==='/__qa'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(controls());return;}
 if(url.pathname==='/__qa/login'){const token=await qa.login(url.searchParams.get('as'));res.writeHead(302,{'set-cookie':`workout_session=${token}; Path=/; HttpOnly; SameSite=Lax`,location:'/'});res.end();return;}
 if(url.pathname==='/__qa/fault'){fault=url.searchParams.get('kind');if(fault==='none')fault='';res.writeHead(302,{location:'/__qa'});res.end();return;}
 if(url.pathname==='/__qa/state'||url.pathname==='/__qa/requests'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(url.pathname.endsWith('state')?await qa.state():requests));return;}
 if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/auth/')){
  const parts=[];for await(const part of req)parts.push(part);
  const fail=fault&&req.method!=='GET'&&({comments:url.pathname.endsWith('/comments'),rests:url.pathname==='/api/rests',upload:url.pathname==='/api/upload',delete:req.method==='DELETE',admin:url.pathname==='/api/admin/action'})[fault];
  if(fail){fault='';requests.push({method:req.method,path:req.url,status:503,injected:true});res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'검증용 연결 오류예요. 다시 시도해주세요.'}));return;}
  const started=Date.now(),response=await qa.dispatch(new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(parts)}));
  requests.push({method:req.method,path:req.url,status:response.status,ms:Date.now()-started});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
 }
 if(url.pathname==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile('.sites-runtime/mobile-e2e/app.js'));return;}
 if(url.pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(await readFile('app/globals.css','utf8')+'\n'+await readFile('app/design.css','utf8'));return;}
 if(url.pathname.startsWith('/assets/')){const root=resolve('public'),path=resolve(root,'.'+url.pathname);if(!path.startsWith(root+sep))throw Error('Invalid asset');res.setHeader('Content-Type',path.endsWith('.webp')?'image/webp':'image/svg+xml');res.end(await readFile(path));return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="ko"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>운동방 로컬 검증</title><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
}catch(e){console.error(e);res.statusCode=500;res.end('Local QA server error');}});
server.listen(4190,'127.0.0.1',()=>console.log('Local QA: http://127.0.0.1:4190/__qa'));
process.on('SIGINT',()=>server.close(async()=>{await qa.stop();process.exit(0);}));
