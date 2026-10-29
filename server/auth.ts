import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Env, actor, access, b64, cookie, encrypt, fail, hash, json, limit, now, origin, random, setCookie, uid } from './core';
const GOOGLE_KEYS=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export function authErrorPage(message:string,status=400) {
  const safe=message.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google 연결 다시 시작 · 운동방</title><style>*{box-sizing:border-box}body{margin:0;background:#fafafa;color:#111;font-family:system-ui,sans-serif;line-height:1.6}main{max-width:480px;margin:15vh auto;padding:32px 24px}small{color:#ff4f17;font-weight:700}h1{font-size:28px;line-height:1.3;letter-spacing:-.04em}p{color:#626262}a{display:flex;align-items:center;justify-content:center;background:#ff4f17;color:white;text-decoration:none;border-radius:12px;min-height:52px;margin-top:28px;font-weight:700}a:active{transform:scale(.98)}</style></head><body><main><small>운동방</small><h1>Google 연결을<br>다시 시작해주세요.</h1><p>${safe}</p><p>운동방으로 돌아가 로그인 또는 시트 연결을 다시 시작할 수 있어요.</p><a href="/">운동방으로 돌아가기</a></main></body></html>`,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"}});
}
export function authReady(env:Env) {return !!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.APP_SECRET&&env.APP_ORIGIN);}
export async function handleAuth(request:Request,env:Env) {
  const url=new URL(request.url),base=origin(request,env);
  if(!authReady(env))return json({error:'Google 로그인 연결 설정을 기다리고 있어요. 운영자에게 알려주세요.',code:'AUTH_NOT_CONFIGURED'},503);
  if(url.pathname==='/auth/google') {
    await limit(env,'auth:'+request.headers.get('cf-connecting-ip'),30,600000);
    const purpose=url.searchParams.get('purpose')==='sheets'?'sheets':'login';
    let user=null,roomId=null;
    if(purpose==='sheets'){user=await actor(request,env);roomId=url.searchParams.get('room');if(!roomId)fail(400,'운동방을 선택해주세요.');await access(env,user!,roomId,true);}
    const state=random(),nonce=random(),verifier=random(48),challenge=await hash(verifier);
    await env.DB.prepare('INSERT INTO oauth(state,nonce,verifier,purpose,user_id,room_id,expires_at) VALUES(?,?,?,?,?,?,?)').bind(await hash(state),nonce,verifier,purpose,user?.id||null,roomId,Date.now()+600000).run();
    const dest=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    const params={client_id:env.GOOGLE_CLIENT_ID!,redirect_uri:base+'/auth/callback',response_type:'code',scope:'openid email profile'+(purpose==='sheets'?' https://www.googleapis.com/auth/spreadsheets':''),state,nonce,code_challenge:challenge,code_challenge_method:'S256',...(purpose==='sheets'?{access_type:'offline',prompt:'consent'}:{prompt:'select_account'})};
    Object.entries(params).forEach(([k,v])=>dest.searchParams.set(k,v));
    return new Response(null,{status:302,headers:{location:dest.toString(),'set-cookie':setCookie(request,'workout_oauth',state,600),'cache-control':'no-store'}});
  }
  if(url.pathname==='/auth/callback') {
    const state=url.searchParams.get('state');if(!state||cookie(request,'workout_oauth')!==state)fail(400,'로그인 요청이 만료됐어요. 다시 시작해주세요.');
    const flow=await env.DB.prepare('DELETE FROM oauth WHERE state=? AND expires_at>? RETURNING *').bind(await hash(state),Date.now()).first<{nonce:string;verifier:string;purpose:string;user_id:string;room_id:string}>();
    if(!flow)fail(400,'이미 사용되었거나 만료된 로그인 요청이에요.');
    if(url.searchParams.has('error'))return new Response(null,{status:302,headers:{location:'/?auth=cancelled','set-cookie':setCookie(request,'workout_oauth','',0)}});
    const code=url.searchParams.get('code');if(!code)fail(400,'Google 인증 코드를 확인하지 못했어요.');
    const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID!,client_secret:env.GOOGLE_CLIENT_SECRET!,redirect_uri:base+'/auth/callback',grant_type:'authorization_code',code_verifier:flow.verifier}),signal:AbortSignal.timeout(15000)});
    if(!res.ok)fail(401,'Google 인증에 실패했어요. 다시 로그인해주세요.');
    const tokens=await res.json() as {id_token:string;refresh_token?:string;scope?:string};
    const {payload}=await jwtVerify(tokens.id_token,GOOGLE_KEYS,{issuer:['https://accounts.google.com','accounts.google.com'],audience:env.GOOGLE_CLIENT_ID});
    if(payload.nonce!==flow.nonce||!payload.email_verified||typeof payload.sub!=='string'||typeof payload.email!=='string')fail(401,'인증된 Google 계정을 확인하지 못했어요.');
    const existing=await env.DB.prepare('SELECT id FROM users WHERE google_sub=?').bind(payload.sub).first<{id:string}>();
    if(flow.purpose==='sheets') {
      const current=await actor(request,env);if(current?.id!==flow.user_id||existing?.id!==current.id)fail(403,'방장과 같은 Google 계정으로 시트를 연결해주세요.');await access(env,current,flow.room_id,true);
      if(!tokens.refresh_token||!tokens.scope?.includes('https://www.googleapis.com/auth/spreadsheets'))fail(400,'시트 접근을 허용해야 자동으로 동기화할 수 있어요.');
      await env.DB.prepare('UPDATE rooms SET sheet_token=?,sync_error=NULL,sync_failures=0,sync_retry_at=0 WHERE id=?').bind(await encrypt(tokens.refresh_token,env.APP_SECRET!),flow.room_id).run();
    } else {
      const id=existing?.id||uid();
      await env.DB.prepare('INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email').bind(id,payload.sub,payload.email,String(payload.name||payload.email.split('@')[0]).slice(0,60),now()).run();
      const session=random();await env.DB.prepare('INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)').bind(await hash(session),id,Date.now()+30*86400000).run();
      const headers=new Headers({location:'/', 'cache-control':'no-store'});headers.append('set-cookie',setCookie(request,'workout_session',session,30*86400));headers.append('set-cookie',setCookie(request,'workout_oauth','',0));return new Response(null,{status:302,headers});
    }
    return new Response(null,{status:302,headers:{location:'/?sheets=connected#admin','set-cookie':setCookie(request,'workout_oauth','',0),'cache-control':'no-store'}});
  }
  return json({error:'없는 경로예요.'},404);
}
