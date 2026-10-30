import {Env,encrypt,decrypt,hash,now,uid,fail} from './core';

// Only durable business data. Sessions and OAuth handshakes are intentionally not restored.
export const BACKUP_TABLES=['users','rooms','members','posts','rests','fines','settlements','distributions','cheers','comments','audit','story_views'] as const;
type Part={table:string;key:string;sha256:string;rows:number};
export type BackupManifest={format:1;id:string;created_at:string;parts:Part[];media:{key:string;backupKey:string;size:number;etag:string}[];rows:number};
const prefix='__backups/';
async function inventory(env:Env,prefix:string){const objects=new Map<string,R2Object>();let cursor:string|undefined;do{const page=await env.BUCKET.list({prefix,cursor,limit:1000,include:['customMetadata']} as R2ListOptions);for(const o of page.objects)objects.set(o.key,o);cursor=page.truncated?page.cursor:undefined;}while(cursor);return objects;}
async function stamp(env:Env){return JSON.stringify(await env.DB.prepare('SELECT COUNT(*) AS rooms,COALESCE(SUM(revision),0) AS revision,(SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM story_views) AS story_views FROM rooms').first());}
async function readManifest(env:Env,id:string){
 if(!env.APP_SECRET)throw Error('Backup encryption is not configured');
 const row=await env.DB.prepare("SELECT manifest_key FROM backups WHERE id=? AND status='complete'").bind(id).first<{manifest_key:string}>();
 if(!row)fail(404,'완료된 백업을 찾지 못했어요.');
 const object=await env.BUCKET.get(row.manifest_key);if(!object)throw Error('Backup manifest missing');
 const m=JSON.parse(await decrypt(await object.text(),env.APP_SECRET)) as BackupManifest;
 if(m.format!==1||m.id!==id)throw Error('Unsupported backup format');return m;
}

export async function createBackup(env:Env,instant=now()){
 if(!env.APP_SECRET)throw Error('Backup encryption is not configured');
 const id=uid(),at=instant,base=prefix+id+'/',before=await stamp(env),parts:Part[]=[],media:BackupManifest['media']=[];
 await env.DB.prepare("INSERT INTO backups(id,created_at,status) VALUES(?,?,'running')").bind(id,at).run();
 try{
  let rows=0,copied=0;const originals=new Map<string,R2Object>(),copies=await inventory(env,prefix+'media/');
  const rooms=await env.DB.prepare('SELECT id FROM rooms').all<{id:string}>();for(const r of rooms.results)for(const [k,v]of await inventory(env,r.id+'/'))originals.set(k,v);
  for(const table of BACKUP_TABLES){
   let after=0;
   for(;;){
    const page=await env.DB.prepare(`SELECT rowid AS __rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 100`).bind(after).all<Record<string,any>>();if(!page.results.length)break;
    after=page.results[page.results.length-1].__rowid;
    const records=page.results.map(({__rowid,...record})=>record);
    if(table==='posts')for(const p of records.filter(p=>p.status!=='deleted'))for(const key of [p.media_key,p.thumb_key]){
     const original=originals.get(key);if(!original)throw Error('A referenced media object is missing');
     const backupKey=prefix+'media/'+key+'/'+original.etag,copy=copies.get(backupKey);
     if(!copy||copy.customMetadata?.sourceEtag!==original.etag){
      if(copied>=64)throw Error('Media backup is catching up; the next run will continue');
      const object=await env.BUCKET.get(key);if(!object)throw Error('Media object disappeared during backup');
      await env.BUCKET.put(backupKey,await object.arrayBuffer(),{httpMetadata:object.httpMetadata,customMetadata:{sourceEtag:original.etag}});copied++;
     }
     media.push({key,backupKey,size:original.size,etag:original.etag});
    }
    const text=JSON.stringify(records),key=base+table+'-'+parts.length+'.enc';
    await env.BUCKET.put(key,await encrypt(text,env.APP_SECRET),{httpMetadata:{contentType:'application/octet-stream'}});
    parts.push({table,key,sha256:await hash(text),rows:records.length});rows+=records.length;
   }
  }
  if(before!==await stamp(env))throw Error('Records changed during backup; retrying on the next run');
  const manifest:BackupManifest={format:1,id,created_at:at,parts,media,rows},manifestKey=base+'manifest.enc';
  await env.BUCKET.put(manifestKey,await encrypt(JSON.stringify(manifest),env.APP_SECRET));
  await env.DB.prepare("UPDATE backups SET status='complete',manifest_key=?,rows=?,objects=? WHERE id=?").bind(manifestKey,rows,media.length,id).run();
  await verifyBackup(env,id);return {id,rows,objects:media.length};
 }catch(e){await env.DB.prepare("UPDATE backups SET status='failed',error=? WHERE id=?").bind(String(e).slice(0,240),id).run();for(const p of parts)await env.BUCKET.delete(p.key);throw e;}
}
export async function verifyBackup(env:Env,id:string){
 const manifest=await readManifest(env,id);let rows=0;
 for(const p of manifest.parts){
  if(!BACKUP_TABLES.includes(p.table as any)||!p.key.startsWith(prefix+id+'/'))throw Error('Invalid backup part');
  const object=await env.BUCKET.get(p.key);if(!object)throw Error('Backup part missing');
  const text=await decrypt(await object.text(),env.APP_SECRET!);if(await hash(text)!==p.sha256)throw Error('Backup checksum mismatch');
  const data=JSON.parse(text);if(!Array.isArray(data)||data.length!==p.rows)throw Error('Backup row count mismatch');rows+=data.length;
 }
 const copies=await inventory(env,prefix+'media/');for(const m of manifest.media){const obj=copies.get(m.backupKey);if(!obj||obj.size!==m.size||obj.customMetadata?.sourceEtag!==m.etag)throw Error('Backup media mismatch');}
 if(rows!==manifest.rows)throw Error('Backup total mismatch');
 const at=now();await env.DB.prepare('UPDATE backups SET verified_at=? WHERE id=?').bind(at,id).run();return {id,rows,objects:manifest.media.length,verified_at:at};
}

// No public restore endpoint. Recovery targets a freshly migrated, empty database.
export async function restoreBackup(source:Env,target:Env,id:string){
 await verifyBackup(source,id);const manifest=await readManifest(source,id);
 for(const table of BACKUP_TABLES)if((await target.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{n:number}>())!.n)throw Error('Restore target must be empty');
 for(const part of manifest.parts){
  const object=(await source.BUCKET.get(part.key))!;
  const records=JSON.parse(await decrypt(await object.text(),source.APP_SECRET!)) as Record<string,any>[];
  const statements=records.map(record=>{const keys=Object.keys(record);if(keys.some(k=>!/^[a-z_]+$/.test(k)))throw Error('Invalid column');return target.DB.prepare(`INSERT INTO ${part.table}(${keys.map(k=>'"'+k+'"').join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).bind(...keys.map(k=>record[k]));});
  if(statements.length)await target.DB.batch(statements);
 }
 for(const m of manifest.media){const obj=(await source.BUCKET.get(m.backupKey))!;await target.BUCKET.put(m.key,await obj.arrayBuffer(),{httpMetadata:obj.httpMetadata});}
 const foreign=await target.DB.prepare('PRAGMA foreign_key_check').all();if(foreign.results.length)throw Error('Restored relationships failed verification');
 await target.DB.prepare('UPDATE rooms SET sync_lease=NULL,sync_lease_until=0,synced_version=-1,sync_at=NULL').run();
 for(const entity of ['members','posts','rests','fines','distributions'])await target.DB.prepare(`INSERT INTO sync_outbox(room_id,entity,entity_id,version) SELECT room_id,?,id,1 FROM ${entity}`).bind(entity).run();
 return {id,rows:manifest.rows,objects:manifest.media.length};
}

export async function retainBackups(env:Env,instant=now()){
 const all=await env.DB.prepare("SELECT id,created_at FROM backups WHERE status='complete' ORDER BY created_at DESC").all<{id:string;created_at:string}>(),monthly=new Set<string>();
 for(const row of all.results){const month=row.created_at.slice(0,7),age=Date.parse(instant)-Date.parse(row.created_at),keepMonth=!monthly.has(month)&&monthly.size<14;monthly.add(month);if(age<35*86400000||keepMonth)continue;
  const m=await readManifest(env,row.id);await env.BUCKET.delete([...m.parts.map(p=>p.key),prefix+row.id+'/manifest.enc']);await env.DB.prepare('DELETE FROM backups WHERE id=?').bind(row.id).run();
 }
 await env.DB.prepare("DELETE FROM backups WHERE status='failed' AND created_at<?").bind(new Date(Date.parse(instant)-35*86400000).toISOString()).run();
}
