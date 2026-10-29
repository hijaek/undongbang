import {addDays,distributeCents} from '../lib/domain';
import {weekAt,weekEnds,isWeek,localDate} from './calendar';
import {Env,changed,fail,now,uid,HttpError} from './core';

type DbRoom={id:string;created_at:string;timezone:string;goal:number;fine_cents:number;close_through:string|null;carry_cents:number;payout_period:string;revision:number};
export const monthAfter=(month:string)=>new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,7);
export const monthLast=(month:string)=>new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
export function allocationPeriod(room:Pick<DbRoom,'payout_period'>){return room.payout_period==='week'?'week':'month';}
export function payoutAvailable(month:string,period:string,zone:string){const end=period==='year'?month.slice(0,4)+'-12-31':month.length===10?addDays(month,6):monthLast(month);return weekEnds(weekAt(end+'T12:00:00Z',zone),zone);}
export const monthExcludedSql=(member='m.id',month='substr(f.week,1,7)')=>`((SELECT COUNT(*) FROM rests rx WHERE rx.member_id=${member} AND substr(rx.week,1,7)=${month} AND rx.status='approved')>=2)`;

export async function closeWeeks(env:Env,roomId:string,instant=now()){
 const room=await env.DB.prepare('SELECT * FROM rooms WHERE id=?').bind(roomId).first<DbRoom>();if(!room)return;
 const current=weekAt(instant,room.timezone);let week=room.close_through?addDays(room.close_through,7):weekAt(room.created_at,room.timezone);
 for(let i=0;week<current&&i<8;i++,week=addDays(week,7)){
  const end=weekEnds(week,room.timezone),month=week.slice(0,7);
  await env.DB.batch([
   env.DB.prepare(`INSERT OR IGNORE INTO fines(id,room_id,member_id,week,count,exempt,amount_cents,paid_cents,created_at)
    SELECT m.id||':'||?,m.room_id,m.id,?,
    (SELECT COUNT(*) FROM posts p WHERE p.member_id=m.id AND p.week=? AND p.status='valid'),
    CASE WHEN EXISTS(SELECT 1 FROM rests x WHERE x.member_id=m.id AND x.week=? AND x.status='approved') THEN 1
      WHEN ${monthExcludedSql('m.id',"'"+month+"'")} THEN 2 ELSE 0 END,
    CASE WHEN EXISTS(SELECT 1 FROM rests x WHERE x.member_id=m.id AND x.week=? AND x.status='approved') OR ${monthExcludedSql('m.id',"'"+month+"'")} THEN 0
      ELSE MAX(0,?-(SELECT COUNT(*) FROM posts p WHERE p.member_id=m.id AND p.week=? AND p.status='valid'))*? END,0,?
    FROM members m WHERE m.room_id=? AND m.joined_at<? AND (m.left_at IS NULL OR m.left_at>=?)`).bind(week,week,week,week,week,room.goal,week,room.fine_cents,instant,roomId,end,end),
   env.DB.prepare('UPDATE rooms SET close_through=? WHERE id=? AND (close_through IS NULL OR close_through<?)').bind(week,roomId,week),...changed(env,roomId,'system','week-close',week)
  ]);
 }
}

// Part of the approval transaction: collected money stays, unpaid obligations are waived.
export function reconcileRestFines(env:Env,roomId:string,memberId:string,month:string){
 const excluded=monthExcludedSql('fines.member_id','substr(fines.week,1,7)');
 const approved="EXISTS(SELECT 1 FROM rests r WHERE r.member_id=fines.member_id AND r.week=fines.week AND r.status='approved')";
 return [env.DB.prepare(`UPDATE fines SET exempt=CASE WHEN ${approved} THEN 1 WHEN ${excluded} THEN 2 ELSE 0 END,
  amount_cents=CASE WHEN ${approved} OR ${excluded} THEN paid_cents ELSE MAX(paid_cents,MAX(0,(SELECT goal FROM rooms WHERE id=fines.room_id)-count)*(SELECT fine_cents FROM rooms WHERE id=fines.room_id)) END
  WHERE room_id=? AND member_id=? AND substr(week,1,7)=? AND NOT EXISTS(SELECT 1 FROM settlements s WHERE s.room_id=fines.room_id AND fines.week LIKE s.month||'%')`).bind(roomId,memberId,month),
  env.DB.prepare(`INSERT INTO sync_outbox(room_id,entity,entity_id,version) SELECT room_id,'fines',id,1 FROM fines WHERE room_id=? AND member_id=? AND substr(week,1,7)=? ON CONFLICT(room_id,entity,entity_id) DO UPDATE SET version=sync_outbox.version+1`).bind(roomId,memberId,month)];
}
export async function nextAllocation(env:Env,room:DbRoom){
 const last=await env.DB.prepare('SELECT MAX(month) AS period FROM settlements WHERE room_id=?').bind(room.id).first<{period:string|null}>();
 const first=weekAt(room.created_at,room.timezone);
 return last?.period?(allocationPeriod(room)==='week'?addDays(last.period,7):monthAfter(last.period)):(allocationPeriod(room)==='week'?first:first.slice(0,7));
}
export async function settlementPreview(env:Env,roomId:string,month:string,instant=now()){
 const room=await env.DB.prepare('SELECT * FROM rooms WHERE id=?').bind(roomId).first<DbRoom>();if(!room)fail(404,'운동방을 찾지 못했어요.');
 const weekly=allocationPeriod(room)==='week';if(!(weekly?isWeek(month):/^\d{4}-(0[1-9]|1[0-2])$/.test(month)))fail(400,weekly?'월요일을 선택해주세요.':'분배할 월을 선택해주세요. 매달 분배액을 쌓고 지정된 지급 시점에 지급해요.');
 const last=weekly?month:weekAt(monthLast(month)+'T12:00:00Z',room.timezone),ends=weekEnds(last,room.timezone);
 if(Date.parse(instant)<Date.parse(ends))fail(409,'이 기간에 시작한 마지막 주가 마감된 뒤 분배액을 확정해요.');
 if(!room.close_through||room.close_through<last)fail(409,'지난 주 마감을 처리 중이에요. 잠시 후 다시 시도해주세요.');
 if(await env.DB.prepare('SELECT id FROM settlements WHERE room_id=? AND month=?').bind(roomId,month).first())fail(409,'이미 확정한 정산이에요.');
 const next=await nextAllocation(env,room);if(next!==month)fail(409,`${next}부터 순서대로 정산해야 이월 금액이 정확해요.`);
 const total=await env.DB.prepare('SELECT COALESCE(SUM(paid_cents),0) AS paid,COALESCE(SUM(amount_cents-paid_cents),0) AS unpaid FROM fines WHERE room_id=? AND substr(week,1,?)=?').bind(roomId,month.length,month).first<{paid:number;unpaid:number}>();
 const candidates=await env.DB.prepare(`SELECT m.id,m.name,m.status,m.left_at,
  (SELECT COUNT(*) FROM rests r WHERE r.member_id=m.id AND substr(r.week,1,7)=? AND r.status='approved') AS rest_weeks
  FROM members m WHERE m.room_id=? AND m.joined_at<? ORDER BY m.id`).bind(month.slice(0,7),roomId,ends).all<{id:string;name:string;status:string;left_at:string|null;rest_weeks:number}>();
 const excluded=candidates.results.filter(m=>m.rest_weeks>=2||(m.left_at&&localDate(m.left_at,room.timezone).slice(0,7)<=month.slice(0,7))).map(m=>({...m,reason:m.rest_weeks>=2?'같은 달 승인 휴식 2주 이상':'탈퇴한 달부터 제외'}));
 const members=candidates.results.filter(m=>!excluded.some(x=>x.id===m.id));
 return {month,paid:total?.paid||0,unpaid:total?.unpaid||0,carry:room.carry_cents,members,excluded,revision:room.revision,payoutAvailableAt:payoutAvailable(month,room.payout_period,room.timezone)};
}
export async function settle(env:Env,roomId:string,userId:string,month:string,recipientIds?:string[],instant=now()){
 const preview=await settlementPreview(env,roomId,month,instant);if(preview.unpaid)fail(409,'미납금 입금을 확인하면 분배액이 자동으로 확정돼요.');
 const recipients=preview.members.map(m=>m.id);
 if(recipientIds&&([...new Set(recipientIds)].length!==recipients.length||recipientIds.some(id=>!recipients.includes(id))))fail(400,'분배 대상은 휴식·탈퇴 규칙으로 자동 결정돼요. 미리보기를 다시 열어주세요.');
 const total=preview.paid+preview.carry,{perPerson,carry}=recipients.length?distributeCents(total,recipients.length):{perPerson:0,carry:total},id=uid();
 try{await env.DB.batch([
  // NOT NULL guards revision even when no distributions are inserted.
  env.DB.prepare(`INSERT INTO settlements(id,room_id,month,total_cents,recipients,per_person_cents,carry_cents,created_at) VALUES(?,?,?,CASE WHEN EXISTS(SELECT 1 FROM rooms WHERE id=? AND revision=?) THEN ? ELSE NULL END,?,?,?,?)`).bind(id,roomId,month,roomId,preview.revision,total,recipients.length,perPerson,carry,instant),
  ...recipients.map(m=>env.DB.prepare('INSERT INTO distributions(id,settlement_id,room_id,member_id,amount_cents) VALUES(?,?,?,?,?)').bind(uid(),id,roomId,m,perPerson)),
  env.DB.prepare('UPDATE rooms SET carry_cents=? WHERE id=?').bind(carry,roomId),...changed(env,roomId,userId,'settlement',id)
 ]);}catch(e){if(/FOREIGN KEY|UNIQUE|NOT NULL/.test(String(e)))fail(409,'기록이 변경됐거나 이미 정산됐어요. 새로고침해주세요.');throw e;}
 return {id,perPerson,carry,recipients:recipients.length};
}
export async function closeAllocations(env:Env,roomId:string,instant=now()){
 let completed=0;
 for(let i=0;i<12;i++){
  const room=await env.DB.prepare('SELECT * FROM rooms WHERE id=?').bind(roomId).first<DbRoom>();if(!room)break;
  const period=await nextAllocation(env,room);
  try{await settle(env,roomId,'system',period,undefined,instant);completed++;}
  catch(e){if(e instanceof HttpError&&e.status===409)return {completed,waiting:e.message,period};throw e;}
 }
 return {completed};
}

