import {Env,now} from './core';
export async function recordIncident(env:Env,kind:string,message:string,roomId:string|null=null){
 const id=(roomId||'system')+':'+kind,at=now();
 await env.DB.prepare(`INSERT INTO incidents(id,room_id,kind,message,first_at,last_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET message=excluded.message,last_at=excluded.last_at,first_at=CASE WHEN incidents.resolved_at IS NOT NULL THEN excluded.first_at ELSE incidents.first_at END,occurrences=incidents.occurrences+1,resolved_at=NULL,notified_at=CASE WHEN incidents.resolved_at IS NOT NULL THEN NULL ELSE incidents.notified_at END`).bind(id,roomId,kind,message.slice(0,240),at,at).run();
}
export async function resolveIncident(env:Env,kind:string,roomId:string|null=null){await env.DB.prepare('UPDATE incidents SET resolved_at=? WHERE id=? AND resolved_at IS NULL').bind(now(),(roomId||'system')+':'+kind).run();}
