import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {handleApi} from '../server/api';
import {hash,now,type Env} from '../server/core';
import {addDays,fineCents,distributeCents} from '../lib/domain';
import {weekAt,weekEnds} from '../server/calendar';
import {closeWeeks} from '../server/accounting';
import {cleanup} from '../server/media';

const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET']});
const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');
const env={DB:db,BUCKET:bucket,APP_ORIGIN:'https://workout.test'} as unknown as Env;
const pending:Promise<unknown>[]=[];const ctx={waitUntil:(p:Promise<unknown>)=>pending.push(p)} as unknown as ExecutionContext;
let passed=0;
async function test(name:string,fn:()=>Promise<void>|void){await fn();console.log('PASS '+name);passed++;}
async function request(path:string,method='GET',data?:unknown,who='host',sameOrigin=true){const h:Record<string,string>={Cookie:'workout_session='+who};if(method!=='GET'&&sameOrigin)h.Origin=env.APP_ORIGIN!;if(data)h['Content-Type']='application/json';const response=await handleApi(new Request(env.APP_ORIGIN+path,{method,headers:h,body:data?JSON.stringify(data):undefined}),env,ctx);const result=await response.json() as any;return {status:response.status,data:result};}
try{
 for(const file of readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort())for(const statement of readFileSync('drizzle/'+file,'utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
 const at=now(),week=weekAt(),previous=addDays(week,-7);
 for(const [id,name]of [['host','방장'],['member','회원'],['outsider','외부인']]){await db.prepare('INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)').bind(id,id,id+'@test.invalid',name,at).run();await db.prepare('INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)').bind(await hash(id),id,Date.now()+600000).run();}
 await test('DST week boundary uses New York local time',()=>{assert.equal(weekAt('2026-11-02T04:59:59Z'),'2026-10-26');assert.equal(weekAt('2026-11-02T05:00:00Z'),'2026-11-02');assert.equal(weekEnds('2026-10-26'),'2026-11-02T05:00:00Z');assert.equal(weekEnds('2026-03-02'),'2026-03-09T04:00:00Z');});
 await test('integer-cent fines and remainder conserve funds',()=>{assert.equal(fineCents(3,1,500,false),1000);assert.equal(fineCents(3,0,500,true),0);assert.equal(fineCents(3,8,500,false),0);const s=distributeCents(1000,3);assert.equal(s.perPerson*3+s.carry,1000);});
 await test('anonymous requests cannot read member data',async()=>{const r=await request('/api/history?room=anything','GET',undefined,'missing');assert.equal(r.status,401);});
 await test('cross-origin writes are rejected',async()=>{assert.equal((await request('/api/rooms','POST',{name:'우리방',goal:3,fine:5,payout:'year'},'host',false)).status,403);});
 const created=await request('/api/rooms','POST',{name:'우리방',goal:3,fine:5,payout:'year'});assert.equal(created.status,201);const rid=created.data.id;
 await test('room creation persists real host membership',async()=>{const r=await request('/api/bootstrap');assert.equal(r.data.room.id,rid);assert.equal(r.data.room.role,'host');assert.equal(r.data.members.length,1);});
 await test('invite preview and join persist membership',async()=>{assert.equal((await request('/api/join/preview','POST',{code:created.data.code},'member')).data.room.name,'우리방');assert.equal((await request('/api/join','POST',{code:created.data.code},'member')).status,201);});
 await test('outsiders cannot read feed and members cannot administer',async()=>{assert.equal((await request('/api/feed?room='+rid,'GET',undefined,'outsider')).status,403);assert.equal((await request('/api/admin?room='+rid,'GET',undefined,'member')).status,403);const b=await request('/api/bootstrap','GET',undefined,'member');assert.equal(b.data.room.invite_code,undefined);assert.equal(b.data.room.sheet_id,undefined);});
 const member=await db.prepare('SELECT * FROM members WHERE user_id=?').bind('member').first<any>();
 await db.prepare('UPDATE rooms SET created_at=? WHERE id=?').bind(weekEnds(addDays(previous,-7)),rid).run();await db.prepare('UPDATE members SET joined_at=? WHERE room_id=?').bind(weekEnds(addDays(previous,-7)),rid).run();
 for(let i=0;i<27;i++){const id='post-'+String(i).padStart(8,'0');await db.prepare('INSERT INTO posts(id,room_id,member_id,kind,caption,media_key,thumb_key,bytes,created_at,week,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,rid,member.id,'image','테스트 인증',id+'/media',id+'/thumb',100,at,week,'valid').run();}
 await test('cursor pagination has no duplicates when timestamps tie',async()=>{let cursor:string|null=null;const ids:string[]=[];do{const r=await request(`/api/feed?room=${rid}${cursor?'&cursor='+encodeURIComponent(cursor):''}`);assert.equal(r.status,200);assert.ok(r.data.posts.length<=12);ids.push(...r.data.posts.map((p:any)=>p.id));cursor=r.data.nextCursor;}while(cursor);assert.equal(ids.length,27);assert.equal(new Set(ids).size,27);});
 await test('cheer PUT is idempotent',async()=>{const path='/api/posts/post-00000000/cheer';assert.equal((await request(path,'PUT',{on:true})).status,200);await request(path,'PUT',{on:true});const c=await db.prepare('SELECT count(*) AS n FROM cheers').first<any>();assert.equal(c.n,1);await request(path,'PUT',{on:false});assert.equal((await db.prepare('SELECT count(*) AS n FROM cheers').first<any>()).n,0);});
 await test('comment retries do not duplicate',async()=>{const data={id:'comment-00000001',text:'좋아요'};await request('/api/posts/post-00000000/comments','POST',data);await request('/api/posts/post-00000000/comments','POST',data);assert.equal((await request('/api/posts/post-00000000/comments')).data.comments.length,1);});
 await test('post detail has live reactions, comments, author and membership protection',async()=>{await request('/api/posts/post-00000000/cheer','PUT',{on:true});const r=await request('/api/posts/post-00000000');assert.equal(r.status,200);assert.equal(r.data.cheers,1);assert.equal(r.data.cheered,1);assert.equal(r.data.comments,1);assert.equal(r.data.nth,1);assert.equal(r.data.member_id,member.id);assert.ok(r.data.thumb_url.includes('/thumb?'));assert.equal((await request('/api/posts/post-00000000','GET',undefined,'outsider')).status,403);await request('/api/posts/post-00000000/cheer','PUT',{on:false});});
 await test('rest requests do not grant exemptions before host approval',async()=>{await request('/api/rests','POST',{roomId:rid,weeks:[week],reason:'아픔',note:'비공개 메모'},'member');const r=await db.prepare('SELECT * FROM rests WHERE member_id=?').bind(member.id).first<any>();assert.equal(r.status,'pending');assert.equal((await request('/api/admin/action','POST',{roomId:rid,action:'rest-approve',id:r.id},'member')).status,403);assert.equal((await request('/api/admin/action','POST',{roomId:rid,action:'rest-approve',id:r.id})).status,200);const publicWeek=await request('/api/week?room='+rid);assert.ok(!JSON.stringify(publicWeek.data).includes('비공개'));assert.equal(publicWeek.data.members.find((m:any)=>m.id===member.id).exempt,1);});
 await test('profile includes zero-workout weeks and ranks real counts without private rest details',async()=>{const r=await request(`/api/profile?room=${rid}&member=${member.id}`);assert.equal(r.status,200);assert.equal(r.data.weeks.find((w:any)=>w.week===week).count,27);assert.equal(r.data.weeks.find((w:any)=>w.week===week).rest,true);assert.equal(r.data.weeks.find((w:any)=>w.week===previous).count,0);assert.equal(r.data.ranking.find((m:any)=>m.id===member.id).total,27);assert.equal(r.data.ranking.find((m:any)=>m.id===member.id).achieved,0);assert.ok(!JSON.stringify(r.data).includes('비공개'));assert.ok(!JSON.stringify(r.data.ranking).includes('@test.invalid'));assert.equal((await request(`/api/profile?room=${rid}&member=${member.id}`,'GET',undefined,'outsider')).status,403);});
 await test('week finalization is idempotent and applies missing-workout fine',async()=>{await closeWeeks(env,rid);await closeWeeks(env,rid);const f=await db.prepare('SELECT * FROM fines WHERE room_id=? AND week=?').bind(rid,previous).all<any>();assert.equal(f.results.length,2);assert.ok(f.results.every((x:any)=>x.amount_cents===1500));});
 await test('host dashboard sums all unpaid fines',async()=>{const r=await request('/api/admin?room='+rid);assert.equal(r.status,200);assert.equal(r.data.unpaid,3000);});
 await test('members only receive their own financial history',async()=>{const h=await request('/api/history?room='+rid,'GET',undefined,'member');assert.ok(h.data.fines.every((f:any)=>f.member_id===member.id));});
 await test('past-week invalidation is locked',async()=>{await db.prepare('UPDATE posts SET week=? WHERE id=?').bind(previous,'post-00000000').run();assert.equal((await request('/api/admin/action','POST',{roomId:rid,action:'post-void',id:'post-00000000'})).status,409);});
 await test('24-hour stories enumerate every member and paginate in chronological order',async()=>{const summary=await request('/api/stories?room='+rid);assert.equal(summary.data.members[0].count,27);let cursor=null;const ids:string[]=[];do{const page=await request(`/api/stories?room=${rid}&member=${member.id}${cursor?'&cursor='+encodeURIComponent(cursor):''}`);ids.push(...page.data.posts.map((p:any)=>p.id));cursor=page.data.nextCursor;}while(cursor);assert.equal(ids.length,27);assert.deepEqual(ids,[...ids].sort());});
 await test('real image upload, retry, finalize and authenticated byte range',async()=>{const id='upload-test-0001',bytes=readFileSync('public/assets/landing4.webp');const form=()=>{const f=new FormData();f.set('id',id);f.set('media',new Blob([bytes],{type:'image/webp'}),'photo.webp');f.set('thumb',new Blob([readFileSync('public/assets/cheer-heart-on.webp')],{type:'image/webp'}),'thumb.webp');return f;};for(let i=0;i<2;i++){const r=await handleApi(new Request(env.APP_ORIGIN+`/api/upload?room=${rid}`,{method:'POST',headers:{Cookie:'workout_session=host',Origin:env.APP_ORIGIN!},body:form()}),env,ctx);assert.equal(r.status,200,await r.text());}for(let i=0;i<2;i++){const r=await request('/api/posts','POST',{roomId:rid,uploadId:id,caption:'실제 저장'});assert.ok([200,201].includes(r.status));}assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM posts WHERE id=?').bind(id).first<any>()).n,1);const media=await handleApi(new Request(env.APP_ORIGIN+`/api/media/${id}?room=${rid}`,{headers:{Cookie:'workout_session=host',Range:'bytes=0-31'}}),env,ctx);assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,32);assert.equal((await request(`/api/posts/${id}`)).data.caption,'실제 저장');});
 await test('only the author can delete, including when the other user is host',async()=>{
  const p='/api/posts/upload-test-0001';
  assert.equal((await request(p,'DELETE',undefined,'missing')).status,401);
  assert.equal((await request(p,'DELETE',undefined,'outsider')).status,403);
  assert.equal((await request(p,'DELETE',undefined,'member')).status,403);
  assert.equal((await request('/api/posts/post-00000000','DELETE')).status,403);
  assert.equal((await request(p,'DELETE',undefined,'host',false)).status,403);
  assert.equal((await request(p)).status,200);
 });
 await test('author deletion removes media, reactions and counts and is safe to retry',async()=>{
  const id='upload-test-0001',p='/api/posts/'+id;
  await request(p+'/cheer','PUT',{on:true},'member');
  await request(p+'/comments','POST',{id:'delete-comment-1',text:'응원'},'member');
  const before=(await request('/api/bootstrap')).data.members.find((m:any)=>m.user_id==='host').count;
  assert.equal((await request(p,'DELETE')).status,200);
  assert.equal((await request(p,'DELETE')).status,200);
  assert.equal((await request(p)).status,404);
  assert.equal((await request(p+'/comments')).status,404);
  assert.equal((await request(p+'/cheer','PUT',{on:true})).status,404);
  assert.equal((await request(p+'/comments','POST',{id:'after-delete-1',text:'응원'})).status,404);
  assert.equal((await request(`/api/media/${id}?room=${rid}`)).status,404);
  assert.equal((await request('/api/posts','POST',{roomId:rid,uploadId:id,caption:'retry'})).status,409);
  assert.equal((await request('/api/admin/action','POST',{roomId:rid,id,action:'post-restore'})).status,404);
  assert.equal((await request('/api/bootstrap')).data.members.find((m:any)=>m.user_id==='host').count,before-1);
  assert.ok(!(await request('/api/feed?room='+rid)).data.posts.some((p:any)=>p.id===id));
  await Promise.allSettled(pending);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id=?').bind(id).first<any>()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cheers WHERE post_id=?').bind(id).first<any>()).n,0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='post-delete' AND target_id=?").bind(id).first<any>()).n,1);
  assert.ok(await db.prepare("SELECT entity_id FROM sync_outbox WHERE entity='posts' AND entity_id=?").bind(id).first());
  assert.equal(await bucket.head(rid+'/'+id+'/media'),null);
  assert.equal(await bucket.head(rid+'/'+id+'/thumb'),null);
  assert.equal(await db.prepare('SELECT id FROM uploads WHERE id=?').bind(id).first(),null);
  assert.equal((await db.prepare('SELECT bytes,caption FROM posts WHERE id=?').bind(id).first<any>()).bytes,0);
  const f=new FormData();f.set('id',id);f.set('media',new Blob([readFileSync('public/assets/landing4.webp')],{type:'image/webp'}),'photo.webp');f.set('thumb',new Blob([readFileSync('public/assets/cheer-heart-on.webp')],{type:'image/webp'}),'thumb.webp');
  assert.equal((await handleApi(new Request(env.APP_ORIGIN+`/api/upload?room=${rid}`,{method:'POST',headers:{Cookie:'workout_session=host',Origin:env.APP_ORIGIN!},body:f}),env,ctx)).status,409);
 });
 await test('deleting a closed-week photo preserves finalized financial records',async()=>{
  const before=await db.prepare('SELECT * FROM fines WHERE room_id=?').bind(rid).all();
  assert.equal((await request('/api/posts/post-00000000','DELETE',undefined,'member')).status,200);
  await closeWeeks(env,rid);
  assert.deepEqual((await db.prepare('SELECT * FROM fines WHERE room_id=?').bind(rid).all()).results,before.results);
 });
 await test('storage failure hides the post immediately and durable cleanup retries',async()=>{
  const id='post-00000026';await bucket.put(id+'/media','photo');await bucket.put(id+'/thumb','thumb');
  const failing={...env,BUCKET:{delete:async()=>{throw Error('storage unavailable');}}} as unknown as Env;
  const r=await handleApi(new Request(env.APP_ORIGIN+'/api/posts/'+id,{method:'DELETE',headers:{Cookie:'workout_session=member',Origin:env.APP_ORIGIN!}}),failing,ctx);
  assert.equal(r.status,200);await Promise.allSettled(pending);
  assert.equal((await request('/api/posts/'+id)).status,404);
  assert.equal((await db.prepare('SELECT bytes FROM posts WHERE id=?').bind(id).first<any>()).bytes,100);
  await cleanup(env);
  assert.equal(await bucket.head(id+'/media'),null);
  assert.equal((await db.prepare('SELECT bytes FROM posts WHERE id=?').bind(id).first<any>()).bytes,0);
 });
 await test('old unpaid fines stay in totals and paginated host todo',async()=>{for(let i=2;i<104;i++){const w=addDays(week,-7*i);await db.prepare('INSERT INTO fines(id,room_id,member_id,week,count,exempt,amount_cents,paid_cents,created_at) VALUES(?,?,?,?,0,0,500,0,?)').bind(member.id+':'+w,rid,member.id,w,at).run();}const h=await request(`/api/history?room=${rid}`,'GET',undefined,'member');assert.equal(h.data.fines.length,60);assert.equal(h.data.totals.unpaid,1500+102*500);let cursor=null,count=0;do{const r=await request(`/api/admin/ledger?room=${rid}&kind=unpaid${cursor?'&cursor='+encodeURIComponent(cursor):''}`);assert.equal(r.status,200);count+=r.data.rows.length;cursor=r.data.nextCursor;}while(cursor);assert.equal(count,104);});
 await test('durable sync queue captures upload, membership, rest and financial changes',async()=>{const rows=await db.prepare('SELECT DISTINCT entity FROM sync_outbox WHERE room_id=?').bind(rid).all<any>();for(const entity of ['members','posts','rests','fines'])assert.ok(rows.results.some(r=>r.entity===entity));});
 await test('weekly auto allocation conserves cents, locks fines and rejects duplicate confirmation',async()=>{await db.prepare("UPDATE rooms SET payout_period='week' WHERE id=?").bind(rid).run();const fines=await db.prepare('SELECT id FROM fines WHERE room_id=? AND week=?').bind(rid,previous).all<any>();for(const f of fines.results)assert.equal((await request('/api/admin/action','POST',{roomId:rid,id:f.id,action:'fine-paid'})).status,200);await Promise.allSettled(pending);const settlement=await db.prepare('SELECT * FROM settlements WHERE room_id=? AND month=?').bind(rid,previous).first<any>();assert.ok(settlement);assert.equal(settlement.per_person_cents*settlement.recipients+settlement.carry_cents,3000);assert.equal((await request('/api/settle','POST',{roomId:rid,month:previous,recipients:[]})).status,409);assert.equal((await request('/api/admin/action','POST',{roomId:rid,id:fines.results[0].id,action:'fine-unpaid'})).status,409);});
 await test('annual payout cannot be marked paid before the final December week closes',async()=>{await db.prepare("UPDATE rooms SET payout_period='year' WHERE id=?").bind(rid).run();const d=await db.prepare('SELECT id FROM distributions WHERE room_id=? LIMIT 1').bind(rid).first<any>();assert.ok(d);assert.equal((await request('/api/admin/action','POST',{roomId:rid,id:d.id,action:'payout-paid'})).status,409);});
 await test('expired uploads cannot turn into posts with missing media',async()=>{const host=await db.prepare("SELECT id FROM members WHERE room_id=? AND role='host'").bind(rid).first<any>();await db.prepare("INSERT INTO uploads(id,room_id,member_id,media_key,thumb_key,kind,bytes,created_at,finalized) VALUES('expired-upload',?,?, 'expired/media','expired/thumb','image',100,'2020-01-01T00:00:00Z',0)").bind(rid,host.id).run();assert.equal((await request('/api/posts','POST',{roomId:rid,uploadId:'expired-upload',caption:'expired'})).status,400);assert.equal(await db.prepare("SELECT id FROM posts WHERE id='expired-upload'").first(),null);});
 await test('removed members lose feed and media access immediately',async()=>{assert.equal((await request('/api/admin/action','POST',{roomId:rid,action:'member-remove',id:member.id})).status,200);assert.equal((await request('/api/feed?room='+rid,'GET',undefined,'member')).status,403);assert.equal((await request('/api/media/post-00000001?room='+rid,'GET',undefined,'member')).status,403);});
 await test('unconfigured OAuth never pretends to sign in',async()=>{assert.equal((await request('/auth/google')).status,503);});
 await test('expired OAuth shows a safe recovery page without granting a session',async()=>{const configured={...env,GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',APP_SECRET:'test-app-secret'};for(const headers of [new Headers(),new Headers({Cookie:'workout_oauth=expired-request'})]){const response=await handleApi(new Request(env.APP_ORIGIN+'/auth/callback?state=expired-request&code=must-not-appear',{headers}),configured,ctx);assert.equal(response.status,400);assert.ok(response.headers.get('content-type')?.startsWith('text/html'));assert.equal(response.headers.get('set-cookie'),null);const html=await response.text();assert.ok(html.includes('운동방으로 돌아가기'));assert.ok(!html.includes('must-not-appear'));}});
 console.log(`${passed} integration checks passed`);
}finally{await Promise.allSettled(pending);await mf.dispose();}
