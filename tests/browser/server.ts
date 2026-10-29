// Local-only browser QA: production components and handlers, isolated D1/R2.
// This module is never imported by the Worker or production app.
import {Miniflare} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
import {handleApi} from '../../server/api';
import {hash,type Env} from '../../server/core';
import {weekAt,weekEnds} from '../../server/calendar';
import {addDays} from '../../lib/domain';
import {closeWeeks} from '../../server/accounting';

export const origin='http://127.0.0.1:4190';
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("QA")}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET']});
const env={DB:await mf.getD1Database('DB'),BUCKET:await mf.getR2Bucket('BUCKET'),APP_ORIGIN:origin,APP_SECRET:'local-qa-only-not-a-production-secret'} as unknown as Env;
const pending=new Set<Promise<unknown>>();
const ctx={waitUntil(p:Promise<unknown>){pending.add(p);void p.finally(()=>pending.delete(p)).catch(()=>{});}} as unknown as ExecutionContext;
export const roomId='qa-primary-room',week=weekAt(),previous=addDays(week,-7);
const started=weekEnds(addDays(week,-35));
for(const file of (await readdir('drizzle')).filter(n=>n.endsWith('.sql')).sort())for(const sql of (await readFile('drizzle/'+file,'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await env.DB.prepare(sql).run();
for(const [role,name] of [['host','검증 방장'],['member','검증 회원'],['long','이름이 아주 긴 운동방 검증 회원'],['new','신규 검증'],['join','가입 검증']]){
 const id='qa-user-'+role;
 await env.DB.prepare('INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)').bind(id,id,role+'@example.invalid',name,started).run();
 if(['host','member','long'].includes(role)){
  if(role==='host')await env.DB.prepare("INSERT INTO rooms(id,name,host_id,goal,fine_cents,timezone,payout_period,invite_code,created_at) VALUES(?,?,?,3,500,'America/New_York','week','QA1234',?)").bind(roomId,'모바일 검증 운동방',id,started).run();
  await env.DB.prepare("INSERT INTO members(id,room_id,user_id,name,role,status,joined_at) VALUES(?,?,?,?,?,'active',?)").bind('qa-member-'+role,roomId,id,name,role==='host'?'host':'member',started).run();
 }
}
const photo=await readFile('public/assets/landing4.webp'),thumb=await readFile('public/assets/cheer-heart-on.webp');
for(let i=0;i<31;i++){
 const id='qa-post-'+String(i).padStart(4,'0'),member=i%3===0?'host':i%3===1?'member':'long';
 const created=i<7?new Date(Date.now()-i*60000).toISOString():new Date(Date.parse(weekEnds(addDays(week,-14)))-i*3600000).toISOString();
 await env.BUCKET.put(`${roomId}/${id}/media`,photo,{httpMetadata:{contentType:'image/webp'}});await env.BUCKET.put(`${roomId}/${id}/thumb`,thumb,{httpMetadata:{contentType:'image/webp'}});
 await env.DB.prepare("INSERT INTO posts(id,room_id,member_id,kind,caption,media_key,thumb_key,bytes,created_at,week,status) VALUES(?,?,?,'image',?,?,?,?,?,?,'valid')").bind(id,roomId,'qa-member-'+member,`모바일 검증 인증 ${i+1}`,`${roomId}/${id}/media`,`${roomId}/${id}/thumb`,photo.length+thumb.length,created,weekAt(created)).run();
}
await closeWeeks(env,roomId);
await env.DB.prepare("INSERT INTO rests(id,room_id,member_id,week,reason,note,status,created_at) VALUES('qa-rest-pending',?,?,?,'출장','검증용 신청','pending',?)").bind(roomId,'qa-member-long',week,new Date().toISOString()).run();
export async function login(role:string){
 if(!['host','member','long','new','join','anonymous'].includes(role))throw Error('Unknown QA role');
 if(role==='anonymous')return '';
 const token='local-qa-session-'+role;
 await env.DB.prepare('INSERT OR REPLACE INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)').bind(await hash(token),'qa-user-'+role,Date.now()+8*3600000).run();return token;
}
export async function dispatch(req:Request){return handleApi(req,env,ctx);}
export async function state(){
 const tables=['users','members','posts','comments','cheers','rests','fines','settlements','distributions','incidents'];
 const rows=await Promise.all(tables.map(async t=>[t,(await env.DB.prepare(`SELECT * FROM ${t}`).all()).results]));
 return Object.fromEntries(rows);
}
export async function stop(){await Promise.allSettled(pending);await mf.dispose();}
