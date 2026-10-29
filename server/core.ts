export interface Env {
  DB: D1Database; BUCKET: R2Bucket; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; APP_SECRET?: string; APP_ORIGIN?: string; CRON_SECRET?: string; OPS_OWNER_EMAIL?:string; OPS_SERVICE_HASH?:string;
}
export type Actor = { id:string; name:string; email:string };
export type Access = { id:string; room_id:string; user_id:string; name:string; role:string; status:string; joined_at:string; [key:string]:unknown };
export class HttpError extends Error { constructor(public status:number, message:string) { super(message); } }
export function fail(status:number, message:string):never { throw new HttpError(status,message); }
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const json = (data:unknown,status=200) => new Response(JSON.stringify(data), {status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin'}});
export const b64 = (bytes:Uint8Array) => {let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
export const unb64 = (text:string) => Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
export const random = (n=32) => b64(crypto.getRandomValues(new Uint8Array(n)));
export async function hash(text:string) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))); }
export function cookie(request:Request,name:string) { const match=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='));return match?.slice(name.length+1)||''; }
export function origin(request:Request,env:Env) { const current=new URL(request.url).origin; if(env.APP_ORIGIN && current!==env.APP_ORIGIN) fail(403,'허용되지 않은 주소예요.');return env.APP_ORIGIN||current; }
export function checkOrigin(request:Request,env:Env) { if(request.headers.get('origin')!==origin(request,env)) fail(403,'요청 출처를 확인하지 못했어요. 새로고침 후 다시 시도해주세요.'); }
export function setCookie(request:Request,name:string,value:string,seconds:number) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${new URL(request.url).protocol==='https:'?'; Secure':''}`; }
export async function actor(request:Request,env:Env,required=true):Promise<Actor|null> {
  const token=cookie(request,'workout_session');
  const user=token?await env.DB.prepare('SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?').bind(await hash(token),Date.now()).first<Actor>():null;
  if(!user&&required)fail(401,'Google로 로그인해주세요.');return user;
}
export async function access(env:Env,user:Actor,roomId:string,host=false) {
  const m=await env.DB.prepare("SELECT * FROM members WHERE room_id=? AND user_id=? AND status='active'").bind(roomId,user.id).first<Access>();
  if(!m)fail(403,'이 운동방의 참여 권한이 없어요.');if(host&&m.role!=='host')fail(403,'방장만 할 수 있어요.');return m;
}
export async function body(request:Request,maxBytes=16000) {
  if(Number(request.headers.get('content-length')||0)>maxBytes)fail(413,'입력 내용이 너무 길어요.');
  const reader=request.body?.getReader();let size=0,text='';const decoder=new TextDecoder();if(reader)for(;;){const part=await reader.read();if(part.done){text+=decoder.decode();break;}size+=part.value.byteLength;if(size>maxBytes){await reader.cancel();fail(413,'입력 내용이 너무 길어요.');}text+=decoder.decode(part.value,{stream:true});}
  try { const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,unknown>; } catch {return fail(400,'입력 내용을 확인해주세요.');}
}
export function str(value:unknown,max:number,min=0) { if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)fail(400,'입력 길이를 확인해주세요.');return value.trim(); }
export async function limit(env:Env,key:string,max:number,windowMs:number) {
  const t=Date.now();const row=await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END RETURNING count').bind(key,t+windowMs,t,t).first<{count:number}>();
  if(row&&row.count>max)fail(429,'잠시 후 다시 시도해주세요.');
}
export function changed(env:Env,roomId:string,userId:string,action:string,targetId:string) {
  const statements=[env.DB.prepare('UPDATE rooms SET revision=revision+1,sync_version=sync_version+1 WHERE id=?').bind(roomId),env.DB.prepare('INSERT INTO audit(id,room_id,actor_id,action,target_id,created_at) VALUES(?,?,?,?,?,?)').bind(uid(),roomId,userId,action,targetId,now())];
  const entity=['join','leave','member-remove','name'].includes(action)?'members':action.startsWith('post')?'posts':action.startsWith('rest')?'rests':action.startsWith('fine')||action==='week-close'?'fines':action.startsWith('payout')||action==='settlement'?'distributions':null;
  if(entity){const condition=action==='rest-request'?'member_id=?':action==='week-close'?'week=?':action==='settlement'?'settlement_id=?':'id=?';statements.push(env.DB.prepare(`INSERT INTO sync_outbox(room_id,entity,entity_id,version) SELECT room_id,?,id,1 FROM ${entity} WHERE room_id=? AND ${condition} ON CONFLICT(room_id,entity,entity_id) DO UPDATE SET version=sync_outbox.version+1`).bind(entity,roomId,targetId));}
  return statements;
}
export async function encrypt(value:string,secret:string) { const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret)),'AES-GCM',false,['encrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));return b64(iv)+'.'+b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(value)))); }
export async function decrypt(value:string,secret:string) {const [iv,data]=value.split('.');const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret)),'AES-GCM',false,['decrypt']);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv)},key,unb64(data)));}
