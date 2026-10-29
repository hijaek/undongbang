import {addDays,FEED_PAGE_SIZE,validId} from '../lib/domain';
import {weekAt,weekEnds,isWeek} from './calendar';
import { Env, Actor, Access, HttpError, access, actor, body, changed, checkOrigin, cookie, fail, hash, json, limit, now, random, setCookie, str, uid } from './core';
import { handleAuth, authReady, authErrorPage } from './auth';
import { closeWeeks, settle, settlementPreview, reconcileRestFines, closeAllocations, payoutAvailable, nextAllocation } from './accounting';
import { upload, serveMedia, cleanup, purgeDeletedPost } from './media';
import { syncSheets, attachSheet } from './sheets';
import {operationsStatus,runMaintenance,handleOpsService} from './operations';
import {recordIncident,resolveIncident} from './incidents';
type DbPost={id:string;room_id:string;member_id:string;week:string;status:string;[key:string]:unknown};
type RoomRow={id:string;name:string;goal:number;fine_cents:number;timezone:string;payout_period:string;created_at:string;revision:number;invite_code:string;sheet_id:string|null;sheet_url:string|null;[key:string]:unknown};
const publicRoom=(r:RoomRow,m:Access)=>({id:r.id,name:r.name,goal:r.goal,fine_cents:r.fine_cents,timezone:r.timezone,payout_period:r.payout_period,created_at:r.created_at,role:m.role,member_id:m.id,...(m.role==='host'?{invite_code:r.invite_code,sheet_id:r.sheet_id,sheet_url:r.sheet_url}:{})});
const roomSql='SELECT id,name,goal,fine_cents,timezone,payout_period,created_at,revision,invite_code,sheet_id,sheet_url FROM rooms WHERE id=?';
async function roomData(env:Env,id:string){const r=await env.DB.prepare(roomSql).bind(id).first<RoomRow>();if(!r)fail(404,'운동방을 찾을 수 없어요.');return r;}
function scheduleSync(env:Env,ctx:ExecutionContext,roomId:string){ctx.waitUntil((async()=>{await closeAllocations(env,roomId);await syncSheets(env,roomId);})().catch(()=>recordIncident(env,'sync','자동 반영에 실패했어요. 다음 실행에서 다시 시도해요.',roomId)));ctx.waitUntil((async()=>{const claim=await env.DB.prepare("INSERT INTO rate_limits(key,count,expires_at) VALUES('maintenance',1,?) ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at WHERE rate_limits.expires_at<? RETURNING key").bind(Date.now()+3600000,Date.now()).first();if(claim)await cleanup(env);})().catch(()=>recordIncident(env,'cleanup','미완료 업로드 정리를 재시도하고 있어요.')));}
async function postAccess(env:Env,user:Actor,id:string,host=false,includeDeleted=false) {const post=await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(id).first<DbPost>();if(!post||(!includeDeleted&&post.status==='deleted'))fail(404,'인증을 찾지 못했어요.');const member=await access(env,user,post.room_id,host);return {post,member};}
async function weekly(env:Env,roomId:string,week:string){return (await env.DB.prepare(`SELECT m.id,m.user_id,m.name,m.role,m.status,m.joined_at,
  (SELECT count(*) FROM posts p WHERE p.member_id=m.id AND p.week=? AND p.status='valid') AS count,
  EXISTS(SELECT 1 FROM rests r WHERE r.member_id=m.id AND r.week=? AND r.status='approved') AS exempt,
  ((SELECT COUNT(*) FROM rests r WHERE r.member_id=m.id AND substr(r.week,1,7)=substr(?,1,7) AND r.status='approved')>=2) AS month_excluded
  FROM members m WHERE m.room_id=? AND m.status='active' ORDER BY m.joined_at,m.id`).bind(week,week,week,roomId).all()).results;}
function cursorOf(p:Record<string,unknown>){return btoa(JSON.stringify([p.created_at,p.id]));}
function parseCursor(value:string|null){if(!value)return null;try{const x=JSON.parse(atob(value));if(!Array.isArray(x)||x.length!==2||typeof x[0]!=='string'||!/^[0-9TZ:.-]+$/.test(x[0])||typeof x[1]!=='string'||!/^[A-Za-z0-9:_-]{8,100}$/.test(x[1]))throw Error();return x as [string,string];}catch{return fail(400,'피드 위치가 유효하지 않아요. 새로고침해주세요.');}}

export async function handleApi(request:Request,env:Env,ctx:ExecutionContext):Promise<Response> {
 try {
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(path==='/api/operations')return await handleOpsService(request,env);
  if(path.startsWith('/auth/'))return await handleAuth(request,env);
  if(method!=='GET'&&method!=='HEAD')checkOrigin(request,env);
  if(path==='/api/health'){await env.DB.prepare('SELECT 1').first();return json({ready:true,authReady:authReady(env)});}
  if(path==='/api/bootstrap'){
    const user=await actor(request,env,false);if(!user)return json({user:null,room:null,authReady:authReady(env)});
    const m=await env.DB.prepare("SELECT * FROM members WHERE user_id=? AND status='active' ORDER BY joined_at DESC LIMIT 1").bind(user.id).first<Access>();if(!m)return json({user,room:null,authReady:authReady(env)});
    await closeWeeks(env,m.room_id);const room=await roomData(env,m.room_id),week=weekAt(now(),room.timezone);scheduleSync(env,ctx,room.id);
    return json({user,room:publicRoom(room,m),week,weekEnds:weekEnds(week,room.timezone),members:await weekly(env,room.id,week),revision:room.revision,authReady:authReady(env)});
  }
  const user=(await actor(request,env))!;
  if(method!=='GET')await limit(env,'write:'+user.id,120,60000);
  if(path==='/api/logout'&&method==='POST'){
    await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(await hash(cookie(request,'workout_session'))).run();const res=json({ok:true});res.headers.set('set-cookie',setCookie(request,'workout_session','',0));return res;
  }
  if(path==='/api/me'&&method==='PATCH'){
    const b=await body(request),name=str(b.name,30,1),active=await env.DB.prepare("SELECT id,room_id FROM members WHERE user_id=? AND status='active'").bind(user.id).all<{id:string;room_id:string}>();await env.DB.batch([env.DB.prepare('UPDATE users SET name=? WHERE id=?').bind(name,user.id),env.DB.prepare("UPDATE members SET name=? WHERE user_id=? AND status='active'").bind(name,user.id),...active.results.flatMap(m=>changed(env,m.room_id,user.id,'name',m.id))]);for(const m of active.results)scheduleSync(env,ctx,m.room_id);return json({ok:true});
  }
  // Existing rooms are invite-only. Keep this denial for clients with an older cached UI.
  if(path==='/api/rooms'&&method==='POST')fail(403,'새 운동방은 만들 수 없어요. 기존 방의 초대 코드로 참여해주세요.');
  if((path==='/api/join/preview'||path==='/api/join')&&method==='POST'){
    await limit(env,'invite:'+user.id,12,600000);const b=await body(request),code=str(b.code,6,6).toUpperCase();
    const room=await env.DB.prepare('SELECT id,name,goal,fine_cents,timezone,payout_period,created_at FROM rooms WHERE invite_code=?').bind(code).first<RoomRow>();if(!room)fail(404,'초대 코드를 다시 확인해주세요.');
    const count=await env.DB.prepare("SELECT count(*) AS n FROM members WHERE room_id=? AND status='active'").bind(room.id).first<{n:number}>();
    if(path.endsWith('preview'))return json({room:{name:room.name,goal:room.goal,fine_cents:room.fine_cents,timezone:room.timezone,payout_period:room.payout_period},members:count?.n});
    if(await env.DB.prepare("SELECT id FROM members WHERE user_id=? AND status='active'").bind(user.id).first())fail(409,'이미 참여 중인 운동방이 있어요.');
    if((count?.n||0)>=100)fail(409,'이 운동방의 정원이 찼어요.');
    const id=uid();await env.DB.batch([env.DB.prepare('INSERT INTO members(id,room_id,user_id,name,role,status,joined_at) VALUES(?,?,?,?,?,?,?)').bind(id,room.id,user.id,user.name,'member','active',now()),...changed(env,room.id,user.id,'join',id)]);scheduleSync(env,ctx,room.id);return json({id},201);
  }
  const roomId=url.searchParams.get('room');
  if(path==='/api/admin/operations'&&method==='GET'){if(!roomId)fail(400,'운동방을 선택해주세요.');await access(env,user,roomId,true);return json(await operationsStatus(env,roomId));}
  if(path==='/api/admin/maintenance'&&method==='POST'){const b=await body(request),rid=str(b.roomId,80,8);await access(env,user,rid,true);await limit(env,'maintenance:'+rid,3,3600000);await runMaintenance(env);return json(await operationsStatus(env,rid));}
  if(path==='/api/admin/incident'&&method==='POST'){const b=await body(request),rid=str(b.roomId,80,8);await access(env,user,rid,true);const id=str(b.id,200,1);await env.DB.prepare('UPDATE incidents SET resolved_at=? WHERE id=? AND (room_id=? OR room_id IS NULL)').bind(now(),id,rid).run();return json({ok:true});}
  if(path==='/api/admin/ledger'&&method==='GET'){
    if(!roomId)fail(400,'운동방을 선택해주세요.');await access(env,user,roomId,true);
    const kind=url.searchParams.get('kind'),cursor=parseCursor(url.searchParams.get('cursor'));
    if(!['fines','unpaid','distributions'].includes(kind||''))fail(400,'기록 종류를 확인해주세요.');
    const ledgerRoom=await roomData(env,roomId);const payout=kind==='distributions',table=payout?'distributions d JOIN settlements s ON s.id=d.settlement_id':'fines d',date=payout?'s.month':'d.week';
    const result=await env.DB.prepare(`SELECT d.*,m.name,m.status AS member_status,${date} AS period FROM ${table} JOIN members m ON m.id=d.member_id WHERE d.room_id=? ${kind==='unpaid'?'AND d.amount_cents>d.paid_cents':''} ${cursor?`AND (${date}<? OR (${date}=? AND d.id<?))`:''} ORDER BY ${date} DESC,d.id DESC LIMIT 101`).bind(roomId,...(cursor?[cursor[0],cursor[0],cursor[1]]:[])).all<Record<string,unknown>>();
    const rows=result.results.slice(0,100);return json({rows:rows.map(r=>({...r,...(payout?{available_at:payoutAvailable(String(r.period),ledgerRoom.payout_period,ledgerRoom.timezone)}: {})})),nextCursor:result.results.length>100?cursorOf({created_at:rows[99].period,id:rows[99].id}):null});
  }
  const detailMatch=path.match(/^\/api\/posts\/([^/]+)$/);
  if(detailMatch&&method==='DELETE'){
    const {post,member}=await postAccess(env,user,detailMatch[1],false,true);
    if(post.member_id!==member.id)fail(403,'내가 올린 게시물만 삭제할 수 있어요.');
    if(post.status!=='deleted'){
      const room=await roomData(env,post.room_id);
      // Freeze any overdue accounting before removing its supporting post.
      if(post.week<weekAt(now(),room.timezone)){
        await closeWeeks(env,post.room_id);
        const closed=await env.DB.prepare('SELECT close_through FROM rooms WHERE id=?').bind(post.room_id).first<{close_through:string|null}>();
        if(!closed?.close_through||closed.close_through<post.week)fail(409,'지난 주 마감을 처리 중이에요. 잠시 후 다시 시도해주세요.');
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE posts SET status='deleted',caption='' WHERE id=? AND member_id=? AND status!='deleted'").bind(post.id,member.id),
        env.DB.prepare('DELETE FROM comments WHERE post_id=?').bind(post.id),
        env.DB.prepare('DELETE FROM cheers WHERE post_id=?').bind(post.id),
        ...changed(env,post.room_id,user.id,'post-delete',post.id)
      ]);
    }
    // The tombstone and byte count are a durable retry marker if object storage fails.
    ctx.waitUntil(purgeDeletedPost(env,post.id).catch(()=>recordIncident(env,'cleanup','삭제된 게시물의 파일 정리를 재시도하고 있어요.',post.room_id)));
    scheduleSync(env,ctx,post.room_id);return json({ok:true});
  }
  if(detailMatch&&method==='GET'){
    const {post}=await postAccess(env,user,detailMatch[1]);
    const detail=await env.DB.prepare(`SELECT p.id,p.room_id,p.member_id,m.name,p.caption,p.kind,p.created_at,p.week,p.status,
      (SELECT count(*) FROM cheers c WHERE c.post_id=p.id) AS cheers,
      EXISTS(SELECT 1 FROM cheers c WHERE c.post_id=p.id AND c.user_id=?) AS cheered,
      (SELECT count(*) FROM comments c WHERE c.post_id=p.id) AS comments,
      (SELECT count(*) FROM posts p2 WHERE p2.member_id=p.member_id AND p2.week=p.week AND p2.status='valid' AND (p2.created_at<p.created_at OR (p2.created_at=p.created_at AND p2.id<=p.id))) AS nth
      FROM posts p JOIN members m ON m.id=p.member_id WHERE p.id=?`).bind(user.id,post.id).first();
    return json({...detail,media_url:`/api/media/${post.id}?room=${post.room_id}`,thumb_url:`/api/media/${post.id}/thumb?room=${post.room_id}`});
  }
  if(['/api/feed','/api/week','/api/revision','/api/admin','/api/history','/api/profile','/api/settlement-preview','/api/stories'].includes(path)){
    if(!roomId)fail(400,'운동방을 선택해주세요.');const member=await access(env,user,roomId,path==='/api/admin'||path==='/api/settlement-preview'),room=await roomData(env,roomId),current=weekAt(now(),room.timezone);
    if(path==='/api/revision'){scheduleSync(env,ctx,room.id);return json({revision:room.revision,week:current});}
    if(path==='/api/week'){const week=url.searchParams.get('week')||current;if(!isWeek(week))fail(400,'주 시작일을 확인해주세요.');return json({week,ends:weekEnds(week,room.timezone),members:await weekly(env,roomId,week)});}
    if(path==='/api/feed'||path==='/api/stories'){
      const cursor=parseCursor(url.searchParams.get('cursor')),by=url.searchParams.get('member'),story=path==='/api/stories';
      if(story&&!by){const members=await env.DB.prepare("SELECT p.member_id,m.name,COUNT(*) AS count FROM posts p JOIN members m ON m.id=p.member_id WHERE p.room_id=? AND p.status='valid' AND p.created_at>=? GROUP BY p.member_id,m.name ORDER BY MAX(p.created_at) DESC LIMIT 100").bind(roomId,new Date(Date.now()-86400000).toISOString()).all();return json({members:members.results});}
      const filters=['p.room_id=?',"p.status!='deleted'"],args:unknown[]=[user.id,roomId];
      if(cursor){filters.push(story?'(p.created_at>? OR (p.created_at=? AND p.id>?))':'(p.created_at<? OR (p.created_at=? AND p.id<?))');args.push(cursor[0],cursor[0],cursor[1]);}
      if(by){filters.push('p.member_id=?');args.push(by);}
      if(story){filters.push("p.status='valid'",'p.created_at>=?');args.push(new Date(Date.now()-86400000).toISOString());}
      const result=await env.DB.prepare(`SELECT p.id,p.room_id,p.member_id,m.name,p.kind,p.caption,p.created_at,p.week,p.status,
        (SELECT count(*) FROM cheers c WHERE c.post_id=p.id) AS cheers,
        EXISTS(SELECT 1 FROM cheers c WHERE c.post_id=p.id AND c.user_id=?) AS cheered,
        (SELECT count(*) FROM comments c WHERE c.post_id=p.id) AS comments,
        (SELECT count(*) FROM posts p2 WHERE p2.member_id=p.member_id AND p2.week=p.week AND p2.status='valid' AND (p2.created_at<p.created_at OR (p2.created_at=p.created_at AND p2.id<=p.id))) AS nth
        FROM posts p JOIN members m ON m.id=p.member_id WHERE ${filters.join(' AND ')} ORDER BY p.created_at ${story?'ASC':'DESC'},p.id ${story?'ASC':'DESC'} LIMIT ?`).bind(...args,FEED_PAGE_SIZE+1).all<Record<string,unknown>>();
      const page=result.results.slice(0,FEED_PAGE_SIZE).map(p=>({...p,media_url:`/api/media/${p.id}?room=${roomId}`,thumb_url:`/api/media/${p.id}/thumb?room=${roomId}`}));return json({posts:page,nextCursor:result.results.length>FEED_PAGE_SIZE?cursorOf(page[page.length-1]):null});
    }
    if(path==='/api/profile'){
      const id=url.searchParams.get('member')||member.id;const profile=await env.DB.prepare('SELECT id,name,joined_at,status FROM members WHERE id=? AND room_id=?').bind(id,roomId).first();if(!profile)fail(404,'회원을 찾지 못했어요.');
      const year=Number(current.slice(0,4)),yearStart=`${year}-01-01`,yearEnd=`${year+1}-01-01`;
      const [counts,rests,ranking]=await Promise.all([
        env.DB.prepare("SELECT week,count(*) AS count FROM posts WHERE member_id=? AND status='valid' AND week>=? AND week<? GROUP BY week ORDER BY week DESC").bind(id,yearStart,yearEnd).all<{week:string;count:number}>(),
        env.DB.prepare("SELECT week FROM rests WHERE member_id=? AND status='approved' AND week>=? AND week<?").bind(id,yearStart,yearEnd).all<{week:string}>(),
        env.DB.prepare(`WITH weekly_counts AS (SELECT p.member_id,p.week,COUNT(*) AS count FROM posts p WHERE p.room_id=? AND p.status='valid' AND p.week>=? AND p.week<? GROUP BY p.member_id,p.week)
          SELECT m.id,m.name,COALESCE(SUM(w.count),0) AS total,COALESCE(SUM(CASE WHEN w.count>=? AND NOT EXISTS(SELECT 1 FROM rests r WHERE r.member_id=m.id AND r.week=w.week AND r.status='approved') THEN 1 ELSE 0 END),0) AS achieved
          FROM members m LEFT JOIN weekly_counts w ON w.member_id=m.id WHERE m.room_id=? AND m.status='active' GROUP BY m.id,m.name ORDER BY achieved DESC,total DESC,m.joined_at,m.id`).bind(roomId,yearStart,yearEnd,room.goal,roomId).all()
      ]);
      let first=weekAt(String(profile.joined_at),room.timezone);while(first<yearStart)first=addDays(first,7);
      const countByWeek=new Map(counts.results.map(w=>[w.week,w.count])),restWeeks=new Set(rests.results.map(w=>w.week)),weeks=[];
      for(let w=current;w>=first;w=addDays(w,-7))weeks.push({week:w,count:countByWeek.get(w)||0,rest:restWeeks.has(w)});
      return json({profile,weeks,ranking:ranking.results,year});
    }
    if(path==='/api/history'){
      await closeWeeks(env,roomId);const before=url.searchParams.get('before')||'9999',beforePayout=url.searchParams.get('beforePayout')||'9999';
      const [fines,rests,distributions,totals]=await Promise.all([
        env.DB.prepare('SELECT * FROM fines WHERE member_id=? AND week<? ORDER BY week DESC LIMIT 61').bind(member.id,before).all<any>(),
        env.DB.prepare('SELECT * FROM rests WHERE member_id=? ORDER BY week DESC LIMIT 60').bind(member.id).all(),
        env.DB.prepare('SELECT d.id,d.amount_cents,d.paid_at,s.month FROM distributions d JOIN settlements s ON s.id=d.settlement_id WHERE d.member_id=? AND s.month<? ORDER BY s.month DESC LIMIT 37').bind(member.id,beforePayout).all<any>(),
        env.DB.prepare('SELECT (SELECT COALESCE(SUM(amount_cents-paid_cents),0) FROM fines WHERE member_id=?) AS unpaid,(SELECT COALESCE(SUM(amount_cents),0) FROM distributions WHERE member_id=? AND paid_at IS NULL) AS pending').bind(member.id,member.id).first()
      ]);return json({fines:fines.results.slice(0,60),rests:rests.results,distributions:distributions.results.slice(0,36),totals,nextBefore:fines.results.length>60?fines.results[59].week:null,nextPayout:distributions.results.length>36?distributions.results[35].month:null});
    }
    if(path==='/api/settlement-preview'){await closeWeeks(env,roomId);return json(await settlementPreview(env,roomId,url.searchParams.get('month')||''));}
    if(path==='/api/admin'){
      await closeWeeks(env,roomId);const [rests,members,settlements,sync,unpaid]=await Promise.all([
        env.DB.prepare('SELECT r.*,m.name FROM rests r JOIN members m ON m.id=r.member_id WHERE r.room_id=? ORDER BY r.week DESC LIMIT 250').bind(roomId).all(),
        env.DB.prepare("SELECT id,name,role,status,joined_at,left_at FROM members WHERE room_id=? ORDER BY status,joined_at LIMIT 150").bind(roomId).all(),
        env.DB.prepare('SELECT * FROM settlements WHERE room_id=? ORDER BY month DESC LIMIT 36').bind(roomId).all(),
        env.DB.prepare('SELECT sheet_id,sheet_url,(sheet_token IS NOT NULL) AS connected,sync_at,sync_error,sync_version,synced_version FROM rooms WHERE id=?').bind(roomId).first(),
        env.DB.prepare('SELECT COALESCE(SUM(amount_cents-paid_cents),0) AS total FROM fines WHERE room_id=?').bind(roomId).first<{total:number}>()
      ]);const nextPeriod=await nextAllocation(env,(await env.DB.prepare('SELECT * FROM rooms WHERE id=?').bind(roomId).first()) as any);return json({nextPeriod,rests:rests.results,members:members.results,settlements:settlements.results,sync,unpaid:unpaid?.total||0});
    }
  }
  if(path.startsWith('/api/media/')&&method==='GET'){
    if(!roomId)fail(400,'운동방을 선택해주세요.');await access(env,user,roomId);const [, , ,id,variant]=path.split('/');return await serveMedia(request,env,roomId,id,variant||'media');
  }
  if(path==='/api/upload'&&method==='POST'){
    if(!roomId)fail(400,'운동방을 선택해주세요.');const member=await access(env,user,roomId);await limit(env,'upload:'+user.id,15,3600000);return await upload(request,env,member);
  }
  if(path==='/api/posts'&&method==='POST'){
    const b=await body(request),rid=str(b.roomId,80,8),id=str(b.uploadId,80,8),caption=str(b.caption||'',500),member=await access(env,user,rid),room=await roomData(env,rid);
    const existing=await env.DB.prepare('SELECT id,member_id,status FROM posts WHERE id=?').bind(id).first<{id:string;member_id:string;status:string}>();if(existing){if(existing.member_id!==member.id)fail(403,'권한이 없어요.');if(existing.status==='deleted')fail(409,'삭제된 게시물이에요. 사진을 다시 선택해주세요.');return json({id});}
    const media=await env.DB.prepare('SELECT * FROM uploads WHERE id=? AND member_id=? AND room_id=? AND finalized=0').bind(id,member.id,rid).first<{kind:string;media_key:string;thumb_key:string;bytes:number;created_at:string}>();if(!media||Date.parse(media.created_at)<Date.now()-86400000)fail(400,'먼저 사진 업로드를 완료해주세요.');
    const at=now(),week=weekAt(at,room.timezone);const result=await env.DB.batch([env.DB.prepare('INSERT INTO posts(id,room_id,member_id,kind,caption,media_key,thumb_key,bytes,created_at,week,status) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM uploads WHERE id=? AND finalized=0)').bind(id,rid,member.id,media.kind,caption,media.media_key,media.thumb_key,media.bytes,at,week,'valid',id),env.DB.prepare('UPDATE uploads SET finalized=1 WHERE id=? AND finalized=0').bind(id),...changed(env,rid,user.id,'post',id)]);if(!result[0].meta.changes)fail(409,'업로드가 만료됐어요. 사진을 다시 선택해주세요.');scheduleSync(env,ctx,rid);return json({id,week},201);
  }
  const cheerMatch=path.match(/^\/api\/posts\/([^/]+)\/cheer$/);
  if(cheerMatch&&method==='PUT'){
    const {post}=await postAccess(env,user,cheerMatch[1]),b=await body(request);if(typeof b.on!=='boolean')fail(400,'응원 상태를 확인해주세요.');
    await env.DB.batch([b.on?env.DB.prepare("INSERT OR IGNORE INTO cheers(post_id,user_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM posts WHERE id=? AND status!='deleted')").bind(post.id,user.id,post.id):env.DB.prepare('DELETE FROM cheers WHERE post_id=? AND user_id=?').bind(post.id,user.id),env.DB.prepare('UPDATE rooms SET revision=revision+1 WHERE id=?').bind(post.room_id)]);return json({ok:true});
  }
  const cm=path.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if(cm){const {post}=await postAccess(env,user,cm[1]);
    if(method==='GET'){const before=parseCursor(url.searchParams.get('before'));const result=await env.DB.prepare('SELECT id,name,body,created_at,user_id FROM comments WHERE post_id=?'+(before?' AND (created_at<? OR (created_at=? AND id<?))':'')+' ORDER BY created_at DESC,id DESC LIMIT 51').bind(post.id,...(before?[before[0],before[0],before[1]]:[])).all<Record<string,unknown>>();return json({comments:result.results.slice(0,50),nextCursor:result.results.length>50?cursorOf(result.results[49]):null});}
    if(method==='POST'){const b=await body(request),id=str(b.id,80,8),text=str(b.text,500,1);if(!validId(id))fail(400,'요청을 확인해주세요.');const exists=await env.DB.prepare('SELECT user_id,post_id FROM comments WHERE id=?').bind(id).first<{user_id:string;post_id:string}>();if(exists){if(exists.user_id!==user.id||exists.post_id!==post.id)fail(409,'중복 요청이에요.');return json({id});}await env.DB.batch([env.DB.prepare("INSERT INTO comments(id,post_id,user_id,name,body,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM posts WHERE id=? AND status!='deleted')").bind(id,post.id,user.id,user.name,text,now(),post.id),env.DB.prepare('UPDATE rooms SET revision=revision+1 WHERE id=?').bind(post.room_id)]);return json({id},201);}
  }
  if(path==='/api/rests'&&method==='POST'){
    const b=await body(request),rid=str(b.roomId,80,8),member=await access(env,user,rid),room=await roomData(env,rid),reason=str(b.reason,30,1),note=str(b.note||'',300),current=weekAt(now(),room.timezone);
    if(!Array.isArray(b.weeks)||!b.weeks.length||b.weeks.length>8||b.weeks.some(w=>!isWeek(w)||w<current||w>addDays(current,56)))fail(400,'이번 주부터 8주 안의 월요일을 선택해주세요.');
    const weeks=[...new Set(b.weeks as string[])];await env.DB.batch([...weeks.map(week=>env.DB.prepare("INSERT INTO rests(id,room_id,member_id,week,reason,note,status,created_at) VALUES(?,?,?,?,?,?,'pending',?) ON CONFLICT(member_id,week) DO UPDATE SET reason=excluded.reason,note=excluded.note,status='pending',created_at=excluded.created_at WHERE rests.status IN ('rejected','cancelled')").bind(uid(),rid,member.id,week,reason,note,now())),...changed(env,rid,user.id,'rest-request',member.id)]);scheduleSync(env,ctx,rid);return json({ok:true});
  }
  if(path==='/api/admin/action'&&method==='POST'){
    const b=await body(request),rid=str(b.roomId,80,8),member=await access(env,user,rid,true),room=await roomData(env,rid),action=str(b.action,30),id=str(b.id||rid,80,1),current=weekAt(now(),room.timezone);let stmt:D1PreparedStatement;let extra:D1PreparedStatement[]=[];
    if(['rest-approve','rest-reject','rest-cancel'].includes(action)){
      const rest=await env.DB.prepare('SELECT week,status,member_id FROM rests WHERE id=? AND room_id=?').bind(id,rid).first<{week:string;status:string;member_id:string}>();if(!rest)fail(404,'신청을 찾지 못했어요.');if(rest.week<current)fail(409,'마감된 주의 휴식은 변경할 수 없어요.');
      const status=action==='rest-approve'?'approved':action==='rest-reject'?'rejected':'cancelled';stmt=env.DB.prepare('UPDATE rests SET status=?,decided_at=?,decided_by=? WHERE id=? AND room_id=?').bind(status,now(),user.id,id,rid);extra=reconcileRestFines(env,rid,rest.member_id,rest.week.slice(0,7));
    }else if(action==='fine-paid'||action==='fine-unpaid'){
      const fine=await env.DB.prepare('SELECT week,amount_cents FROM fines WHERE id=? AND room_id=?').bind(id,rid).first<{week:string;amount_cents:number}>();if(!fine)fail(404,'벌금을 찾지 못했어요.');
      if(await env.DB.prepare("SELECT id FROM settlements WHERE room_id=? AND ? LIKE month||'%'").bind(rid,fine.week).first())fail(409,'정산이 확정된 기간은 변경할 수 없어요.');
      stmt=env.DB.prepare("UPDATE fines SET paid_cents=CASE WHEN ? THEN amount_cents ELSE 0 END,amount_cents=CASE WHEN ?=0 AND exempt>0 THEN 0 ELSE amount_cents END,paid_at=? WHERE id=? AND room_id=? AND NOT EXISTS(SELECT 1 FROM settlements s WHERE s.room_id=fines.room_id AND fines.week LIKE s.month||'%')").bind(action==='fine-paid'?1:0,action==='fine-paid'?1:0,action==='fine-paid'?now():null,id,rid);
    }else if(action==='post-void'||action==='post-restore'){
      const p=await env.DB.prepare("SELECT week FROM posts WHERE id=? AND room_id=? AND status!='deleted'").bind(id,rid).first<{week:string}>();if(!p)fail(404,'인증을 찾지 못했어요.');if(p.week<current)fail(409,'마감된 주의 인증은 변경할 수 없어요.');stmt=env.DB.prepare("UPDATE posts SET status=? WHERE id=? AND room_id=? AND status!='deleted'").bind(action==='post-void'?'void':'valid',id,rid);
    }else if(action==='member-remove'){
      const target=await env.DB.prepare("SELECT role FROM members WHERE id=? AND room_id=? AND status='active'").bind(id,rid).first<{role:string}>();if(!target||target.role==='host')fail(400,'내보낼 멤버를 확인해주세요.');stmt=env.DB.prepare("UPDATE members SET status='removed',left_at=? WHERE id=? AND room_id=?").bind(now(),id,rid);
    }else if(action==='payout-paid'||action==='payout-unpaid'){
      const d=await env.DB.prepare("SELECT d.id,m.status,s.month FROM distributions d JOIN members m ON m.id=d.member_id JOIN settlements s ON s.id=d.settlement_id WHERE d.id=? AND d.room_id=?").bind(id,rid).first<{id:string;status:string;month:string}>();if(!d||d.status!=='active')fail(409,'탈퇴한 회원의 분배금은 지급 대상에서 제외돼요.');if(action==='payout-paid'&&Date.now()<Date.parse(payoutAvailable(d.month,room.payout_period,room.timezone)))fail(409,'정해진 지급 시점이 지난 뒤 실제 송금 여부를 기록해주세요.');stmt=env.DB.prepare("UPDATE distributions SET paid_at=? WHERE id=? AND room_id=? AND EXISTS(SELECT 1 FROM members m WHERE m.id=distributions.member_id AND m.status='active')").bind(action==='payout-paid'?now():null,id,rid);
    }else if(action==='rotate-code'){
      const code=Array.from(crypto.getRandomValues(new Uint8Array(6)),n=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n%32]).join('');stmt=env.DB.prepare('UPDATE rooms SET invite_code=? WHERE id=?').bind(code,rid);
    }else fail(400,'지원하지 않는 작업이에요.');
    const updated=await env.DB.batch([stmt,...extra,...changed(env,rid,user.id,action,id)]);if(!updated[0].meta.changes)fail(409,'기록이 변경됐어요. 새로고침 후 다시 시도해주세요.');scheduleSync(env,ctx,rid);return json({ok:true});
  }
  if(path==='/api/leave'&&method==='POST'){
    const b=await body(request),rid=str(b.roomId,80,8),member=await access(env,user,rid);if(member.role==='host')fail(409,'방장은 관리 권한을 넘기기 전에는 나갈 수 없어요.');await env.DB.batch([env.DB.prepare("UPDATE members SET status='left',left_at=? WHERE id=?").bind(now(),member.id),...changed(env,rid,user.id,'leave',member.id)]);scheduleSync(env,ctx,rid);return json({ok:true});
  }
  if(path==='/api/settle'&&method==='POST'){
    const b=await body(request),rid=str(b.roomId,80,8);await access(env,user,rid,true);if(!Array.isArray(b.recipients)||b.recipients.some(x=>typeof x!=='string'))fail(400,'분배 대상을 확인해주세요.');await closeWeeks(env,rid);const result=await settle(env,rid,user.id,str(b.month,10,4),b.recipients as string[]);scheduleSync(env,ctx,rid);return json(result);
  }
  if(path==='/api/sheets'&&method==='POST'){
    const b=await body(request),rid=str(b.roomId,80,8);await access(env,user,rid,true);await attachSheet(env,rid,str(b.url,400,10));await syncSheets(env,rid,true);return json({ok:true});
  }
  if(path==='/api/sheets/sync'&&method==='POST'){
    const b=await body(request),rid=str(b.roomId,80,8);await access(env,user,rid,true);await syncSheets(env,rid,true);return json({ok:true});
  }
  return json({error:'찾을 수 없는 요청이에요.'},404);
 }catch(error){if(new URL(request.url).pathname.startsWith('/auth/'))return authErrorPage(error instanceof HttpError?error.message:'Google 연결을 완료하지 못했어요. 잠시 후 다시 시도해주세요.',error instanceof HttpError?error.status:500);if(error instanceof HttpError)return json({error:error.message},error.status);console.error('request_failed',new URL(request.url).pathname,error instanceof Error?error.message:'unknown');ctx.waitUntil(recordIncident(env,'request:'+new URL(request.url).pathname,'일부 요청을 처리하지 못했어요. 재시도 후에도 계속되면 점검이 필요해요.').catch(()=>{}));return json({error:'요청을 처리하지 못했어요. 입력한 내용은 유지됩니다. 다시 시도해주세요.'},500);}
}
