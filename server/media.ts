import { Env, Access, fail, json, now, uid } from './core';
export async function upload(request:Request,env:Env,member:Access) {
  const length=Number(request.headers.get('content-length')||0);if(length>17*1024*1024)fail(413,'파일이 너무 커요. 사진 2MB, 영상 15MB 이하로 올려주세요.');
  const reader=request.body?.getReader();if(!reader)fail(400,'파일을 선택해주세요.');const chunks:Uint8Array[]=[];let size=0;
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>17*1024*1024){await reader.cancel();fail(413,'업로드 용량 제한을 넘었어요.');}chunks.push(part.value);}
  const form=await new Response(new Blob(chunks as BlobPart[]),{headers:{'content-type':request.headers.get('content-type')||''}}).formData(),media=form.get('media'),thumb=form.get('thumb'),id=form.get('id');
  if(!(media instanceof File)||!(thumb instanceof File)||typeof id!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(id))fail(400,'사진이나 영상을 선택해주세요.');
  const existing=await env.DB.prepare('SELECT id,member_id,finalized FROM uploads WHERE id=?').bind(id).first<{id:string;member_id:string;finalized:number}>();if(existing){if(existing.member_id!==member.id)fail(403,'권한이 없어요.');if(existing.finalized<0)fail(409,'업로드를 처리 중이에요. 잠시 후 다시 시도해주세요.');return json({id});}
  if(await env.DB.prepare('SELECT id FROM posts WHERE id=?').bind(id).first())fail(409,'이미 사용된 업로드예요. 사진을 다시 선택해주세요.');
  const kind=media.type.startsWith('video/')?'video':'image',allowed=kind==='image'?['image/webp','image/jpeg']:['video/mp4','video/webm','video/quicktime'];
  if(!allowed.includes(media.type)||!['image/webp','image/jpeg'].includes(thumb.type)||!media.size||!thumb.size||media.size>(kind==='image'?2:15)*1024*1024||thumb.size>150000)fail(400,'지원하지 않는 파일이거나 용량 제한을 넘었어요.');
  const head=new Uint8Array(await media.slice(0,32).arrayBuffer());const ascii=new TextDecoder().decode(head);
  const imageOK=(media.type==='image/webp'&&ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WEBP')||(media.type==='image/jpeg'&&head[0]===255&&head[1]===216);
  const videoOK=(media.type==='video/webm'&&head[0]===26&&head[1]===69)||(media.type!=='video/webm'&&ascii.slice(4,8)==='ftyp');
  if(!(kind==='image'?imageOK:videoOK))fail(400,'파일 형식을 확인하지 못했어요.');
  const th=new Uint8Array(await thumb.slice(0,16).arrayBuffer()),ta=new TextDecoder().decode(th);if(!((thumb.type==='image/webp'&&ta.startsWith('RIFF')&&ta.slice(8,12)==='WEBP')||(thumb.type==='image/jpeg'&&th[0]===255&&th[1]===216)))fail(400,'미리보기 사진 형식을 확인해주세요.');
  const key=`${member.room_id}/${id}/media`,thumbKey=`${member.room_id}/${id}/thumb`;
  const reserved=await env.DB.prepare('INSERT OR IGNORE INTO uploads(id,room_id,member_id,media_key,thumb_key,kind,bytes,created_at,finalized) VALUES(?,?,?,?,?,?,?,?,-1)').bind(id,member.room_id,member.id,key,thumbKey,kind,media.size+thumb.size,now()).run();
  if(!reserved.meta.changes)fail(409,'같은 업로드를 처리 중이에요. 잠시 후 다시 시도해주세요.');
  try {
    await env.BUCKET.put(key,await media.arrayBuffer(),{httpMetadata:{contentType:media.type,cacheControl:'private, max-age=3600'},customMetadata:{roomId:member.room_id}});
    await env.BUCKET.put(thumbKey,await thumb.arrayBuffer(),{httpMetadata:{contentType:thumb.type,cacheControl:'private, max-age=3600'},customMetadata:{roomId:member.room_id}});
    await env.DB.prepare('UPDATE uploads SET finalized=0 WHERE id=? AND member_id=?').bind(id,member.id).run();
  }catch(error){await env.BUCKET.delete([key,thumbKey]);await env.DB.prepare('DELETE FROM uploads WHERE id=? AND finalized=-1').bind(id).run();throw error;}
  return json({id,kind,bytes:media.size+thumb.size});
}
export async function serveMedia(request:Request,env:Env,roomId:string,postId:string,variant:string) {
  const post=await env.DB.prepare('SELECT media_key,thumb_key,status FROM posts WHERE id=? AND room_id=?').bind(postId,roomId).first<{media_key:string;thumb_key:string;status:string}>();
  if(!post||post.status==='deleted')fail(404,'미디어를 찾지 못했어요.');
  const range=request.headers.get('range'),key=variant==='thumb'?post.thumb_key:post.media_key;let selection:R2Range|undefined;
  if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2]))fail(416,'유효하지 않은 미디어 범위예요.');const head=await env.BUCKET.head(key);if(!head)fail(404,'미디어를 찾지 못했어요.');const offset=match[1]?Number(match[1]):Math.max(0,head.size-Number(match[2])),end=match[1]&&match[2]?Math.min(head.size-1,Number(match[2])):head.size-1;if(offset>end||offset>=head.size)fail(416,'미디어 범위를 벗어났어요.');selection={offset,length:end-offset+1};}
  const obj=await env.BUCKET.get(key,selection?{range:selection}:undefined);if(!obj)fail(404,'미디어를 찾지 못했어요.');
  const h=new Headers({'cache-control':'private, max-age=3600','x-content-type-options':'nosniff','accept-ranges':'bytes','etag':obj.httpEtag});h.set('content-type',obj.httpMetadata?.contentType||'application/octet-stream');
  if(request.headers.get('if-none-match')===obj.httpEtag)return new Response(null,{status:304,headers:h});
  if(obj.range&&'offset' in obj.range){const offset=obj.range.offset||0,len=obj.range.length||obj.size;h.set('content-range',`bytes ${offset}-${offset+len-1}/${obj.size}`);h.set('content-length',String(len));}else h.set('content-length',String(obj.size));
  return new Response(obj.body,{status:obj.range?206:200,headers:h});
}
export async function purgeDeletedPost(env:Env,id:string){
  const post=await env.DB.prepare("SELECT media_key,thumb_key FROM posts WHERE id=? AND status='deleted' AND bytes>0").bind(id).first<{media_key:string;thumb_key:string}>();
  if(!post)return;
  await env.BUCKET.delete([post.media_key,post.thumb_key]);
  await env.DB.batch([env.DB.prepare("UPDATE posts SET bytes=0 WHERE id=? AND status='deleted'").bind(id),env.DB.prepare('DELETE FROM uploads WHERE id=?').bind(id)]);
}
export async function cleanup(env:Env) {
  const deleted=await env.DB.prepare("SELECT id FROM posts WHERE status='deleted' AND bytes>0 LIMIT 50").all<{id:string}>();
  for(const post of deleted.results)await purgeDeletedPost(env,post.id);
  const stale=await env.DB.prepare('SELECT id,media_key,thumb_key FROM uploads WHERE finalized IN (-2,-1,0) AND created_at<? LIMIT 50').bind(new Date(Date.now()-86400000).toISOString()).all<{id:string;media_key:string;thumb_key:string}>();
  for(const x of stale.results){const claim=await env.DB.prepare('UPDATE uploads SET finalized=-2 WHERE id=? AND finalized IN (-2,-1,0) AND NOT EXISTS(SELECT 1 FROM posts WHERE posts.id=uploads.id)').bind(x.id).run();if(!claim.meta.changes)continue;await env.BUCKET.delete([x.media_key,x.thumb_key]);await env.DB.prepare('DELETE FROM uploads WHERE id=? AND finalized=-2').bind(x.id).run();}
  await env.DB.batch([env.DB.prepare('DELETE FROM oauth WHERE expires_at<?').bind(Date.now()),env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()),env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now())]);
}
