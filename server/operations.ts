import {Env,now,uid,json,body,fail,HttpError,hash} from './core';
import {closeWeeks,closeAllocations} from './accounting';
import {cleanup} from './media';
import {syncSheets} from './sheets';
import {recordIncident,resolveIncident} from './incidents';
import {createBackup,retainBackups,verifyBackup} from './backups';

export async function operationsStatus(env:Env,roomId?:string){
 const [job,backup,incidents]=await Promise.all([
  env.DB.prepare("SELECT last_started,last_success,last_error FROM jobs WHERE id='maintenance'").first(),
  env.DB.prepare("SELECT id,created_at,rows,objects,verified_at FROM backups WHERE status='complete' ORDER BY created_at DESC LIMIT 1").first(),
  env.DB.prepare('SELECT id,kind,message,first_at,last_at,occurrences,notified_at FROM incidents WHERE resolved_at IS NULL'+(roomId?' AND (room_id=? OR room_id IS NULL)':'')+' ORDER BY first_at LIMIT 50').bind(...(roomId?[roomId]:[])).all()
 ]);
 return {job,backup,incidents:incidents.results,checked_at:now()};
}
export async function runMaintenance(env:Env,instant=now()){
 const lease=uid(),time=Date.now();await env.DB.prepare("INSERT OR IGNORE INTO jobs(id) VALUES('maintenance')").run();
 const claim=await env.DB.prepare("UPDATE jobs SET lease=?,lease_until=?,last_started=? WHERE id='maintenance' AND lease_until<?").bind(lease,time+300000,instant,time).run();
 if(!claim.meta.changes)return {ok:true,busy:true,...await operationsStatus(env)};
 const failures:string[]=[];
 try{
  const rooms=await env.DB.prepare('SELECT id FROM rooms ORDER BY id LIMIT 101').all<{id:string}>();
  if(rooms.results.length>100)throw Error('Room maintenance capacity exceeded');
  for(const room of rooms.results){
   try{
    await closeWeeks(env,room.id,instant);await closeAllocations(env,room.id,instant);await syncSheets(env,room.id);
    const state=await env.DB.prepare('SELECT sync_error FROM rooms WHERE id=?').bind(room.id).first<{sync_error:string|null}>();
    if(state?.sync_error){await recordIncident(env,'sheets',state.sync_error,room.id);failures.push('sheets');}else await resolveIncident(env,'sheets',room.id);
    await resolveIncident(env,'closing',room.id);
   }catch{failures.push('closing');await recordIncident(env,'closing','주간 마감 또는 월별 분배 처리가 지연되고 있어요. 다음 자동 작업에서 재시도합니다.',room.id);}
  }
  try{await cleanup(env);await resolveIncident(env,'cleanup');}catch{failures.push('cleanup');await recordIncident(env,'cleanup','미완료 업로드 정리에 실패했어요. 저장된 인증은 유지됩니다.');}
  const latest=await env.DB.prepare("SELECT created_at FROM backups WHERE status='complete' ORDER BY created_at DESC LIMIT 1").first<{created_at:string}>();
  if(!latest||Date.parse(instant)-Date.parse(latest.created_at)>=23*3600000){
   try{await createBackup(env,instant);await retainBackups(env,instant);await resolveIncident(env,'backup');}
   catch(e){failures.push('backup');console.error('backup_failed',String(e));await recordIncident(env,'backup','일일 백업을 완료하지 못했어요. 이전 백업은 유지하며 다음 실행에서 이어서 재시도합니다.');}
  }
  await env.DB.prepare("UPDATE jobs SET last_success=CASE WHEN ?=0 THEN ? ELSE last_success END,last_error=? WHERE id='maintenance' AND lease=?").bind(failures.length,instant,failures.length?failures.join(', '):null,lease).run();
 }catch(e){failures.push('maintenance');await recordIncident(env,'maintenance','자동 운영 작업에 실패했어요. 오류 확인이 필요합니다.');await env.DB.prepare("UPDATE jobs SET last_error='maintenance' WHERE id='maintenance' AND lease=?").bind(lease).run();}
 finally{await env.DB.prepare("UPDATE jobs SET lease=NULL,lease_until=0 WHERE id='maintenance' AND lease=?").bind(lease).run();}
 return {ok:failures.length===0,busy:false,...await operationsStatus(env)};
}

// Native Sites service access is not a visitor login. This separate narrow key
// authorizes only deterministic maintenance; no arbitrary query or restore API.
export async function handleOpsService(request:Request,env:Env){
 const key=request.headers.get('x-workout-operations-key');
 if(!env.OPS_SERVICE_HASH||!key||await hash(key)!==env.OPS_SERVICE_HASH)return json({error:'Unauthorized'},401);
 if(request.method!=='POST')return json({error:'POST required'},405);
 const b=await body(request);
 if(b.action==='status')return json(await operationsStatus(env));
 if(b.action==='run')return json(await runMaintenance(env));
 if(b.action==='verify'){const latest=await env.DB.prepare("SELECT id FROM backups WHERE status='complete' ORDER BY created_at DESC LIMIT 1").first<{id:string}>();if(!latest)fail(404,'No completed backup');return json(await verifyBackup(env,latest.id));}
 if(b.action==='notified'&&Array.isArray(b.ids)&&b.ids.length<=50&&b.ids.every(id=>typeof id==='string'&&id.length<=200)){
  if(b.ids.length)await env.DB.batch((b.ids as string[]).map(id=>env.DB.prepare('UPDATE incidents SET notified_at=? WHERE id=? AND resolved_at IS NULL').bind(now(),id)));return json({ok:true});
 }
 return json({error:'Unsupported operation'},400);
}

const toolList=[
 {name:'workout_maintenance_run',description:'Close due workout weeks, allocate eligible monthly balances, retry Sheets sync, clean abandoned uploads, and create/verify an encrypted daily backup. Idempotent. No bank transfers.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'workout_maintenance_status',description:'Read maintenance, verified backup, and unresolved incident status. Only the Site owner can use this.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'workout_backup_verify',description:'Verify the most recent completed encrypted backup, checksums and media inventory without changing live member records.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'workout_alerts_notified',description:'Mark the listed incidents notified after reporting them to the owner. Does not resolve the incidents.',inputSchema:{type:'object',properties:{ids:{type:'array',items:{type:'string'},maxItems:50}},required:['ids'],additionalProperties:false}}
];
export async function handleOpsMcp(request:Request,env:Env){
 let rpc:Record<string,any>={};
 try{
  if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST'}});
  rpc=await body(request);const result=(value:unknown)=>json({jsonrpc:'2.0',id:rpc.id??null,result:value});
  if(rpc.method==='server/discover')return result({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
  if(rpc.method==='initialize')return result({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'workout-operations',version:'1.0.0'}});
  if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
  if(rpc.method==='tools/list')return result({tools:toolList});
  if(rpc.method!=='tools/call')return json({jsonrpc:'2.0',id:rpc.id??null,error:{code:-32601,message:'Unknown method'}});
  // These verified headers are supplied by the Sites MCP gateway, not Google login.
  const email=request.headers.get('oai-authenticated-user-email')?.toLowerCase();
  if(!env.OPS_OWNER_EMAIL||email!==env.OPS_OWNER_EMAIL.toLowerCase()||!request.headers.get('oai-authenticated-user-id'))fail(403,'Site owner access is required');
  let data:unknown;const name=rpc.params?.name,args=rpc.params?.arguments||{};
  if(name==='workout_maintenance_run')data=await runMaintenance(env);
  else if(name==='workout_maintenance_status')data=await operationsStatus(env);
  else if(name==='workout_backup_verify'){const last=await env.DB.prepare("SELECT id FROM backups WHERE status='complete' ORDER BY created_at DESC LIMIT 1").first<{id:string}>();if(!last)fail(404,'No completed backup');data=await verifyBackup(env,last.id);}
  else if(name==='workout_alerts_notified'){
   if(!Array.isArray(args.ids)||args.ids.length>50||args.ids.some((id:unknown)=>typeof id!=='string'||id.length>200))fail(400,'Invalid incident IDs');
   if(args.ids.length)await env.DB.batch(args.ids.map((id:string)=>env.DB.prepare('UPDATE incidents SET notified_at=? WHERE id=? AND resolved_at IS NULL').bind(now(),id)));data={ok:true};
  }else fail(404,'Unknown tool');
  return result({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:false});
 }catch(e){return json({jsonrpc:'2.0',id:rpc.id??null,result:{content:[{type:'text',text:e instanceof HttpError?e.message:'Operation failed; retry and inspect maintenance status.'}],isError:true}},e instanceof HttpError&&e.status===403?403:200);}
}
