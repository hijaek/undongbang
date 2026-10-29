export type PreparedMedia={media:Blob;thumb:Blob;kind:'image'|'video';url:string;originalBytes:number};
export async function encode(source:CanvasImageSource,width:number,height:number,edge:number,target:number){
 if(!width||!height)throw new Error('사진을 열지 못했어요. 다시 선택해주세요.');
 const canvas=document.createElement('canvas');let format='image/webp';
 try{for(let attempt=0;attempt<7;attempt++){
  const ratio=Math.min(1,edge/Math.max(width,height));canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('사진을 처리하지 못했어요.');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,0,0,canvas.width,canvas.height);
  for(const quality of [.82,.7,.58,.46]){
   let result=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,format,quality));
   // Unsupported encoders can silently return PNG, where quality has no effect.
   if(format==='image/webp'&&(!result||result.type!==format)){format='image/jpeg';result=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,format,quality));}
   if(!result||result.type!==format||!result.size)throw new Error('사진을 변환하지 못했어요. 다시 선택해주세요.');
   if(result.size<=target)return result;
  }
  edge=Math.max(32,Math.floor(edge*.75));
 }
 throw new Error('사진을 변환하지 못했어요. 다시 선택해주세요.');
 }finally{canvas.width=canvas.height=1;}
}
export async function prepareMedia(file:File):Promise<PreparedMedia>{
 if(file.type.startsWith('video/')){
  if(file.size>15*1024*1024)throw new Error('영상은 15MB 이하로 골라주세요.');
  const url=URL.createObjectURL(file),video=document.createElement('video');video.preload='metadata';video.muted=true;video.playsInline=true;video.src=url;
  try{await new Promise<void>((resolve,reject)=>{video.onloadedmetadata=()=>resolve();video.onerror=()=>reject(new Error('이 영상 형식을 재생할 수 없어요. MP4로 다시 골라주세요.'));});if(!Number.isFinite(video.duration)||video.duration>60)throw new Error('영상은 60초 이하로 골라주세요.');video.currentTime=Math.min(.1,video.duration/2);await new Promise<void>((resolve,reject)=>{video.onseeked=()=>resolve();video.onerror=()=>reject(new Error('영상 미리보기를 만들지 못했어요.'));});const thumb=await encode(video,video.videoWidth,video.videoHeight,320,45000);return {media:file,thumb,kind:'video',url,originalBytes:file.size};}catch(e){URL.revokeObjectURL(url);throw e;}finally{video.removeAttribute('src');video.load();}
 }
 if(!file.type.startsWith('image/'))throw new Error('사진 또는 영상을 선택해주세요.');if(file.size>30*1024*1024)throw new Error('사진은 30MB 이하로 선택해주세요.');
 let source:CanvasImageSource,width:number,height:number,release:()=>void;
 try{const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});source=bitmap;width=bitmap.width;height=bitmap.height;release=()=>bitmap.close();}
 catch{const url=URL.createObjectURL(file),img=new Image();try{await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('사진을 열지 못했어요. JPG 또는 PNG로 다시 선택해주세요.'));img.src=url;});}catch(e){URL.revokeObjectURL(url);throw e;}source=img;width=img.naturalWidth;height=img.naturalHeight;release=()=>{img.removeAttribute('src');URL.revokeObjectURL(url);};}
 try{const media=await encode(source,width,height,1440,300000),thumb=await encode(source,width,height,320,45000);return {media,thumb,kind:'image',url:URL.createObjectURL(media),originalBytes:file.size};}finally{release();}
}
