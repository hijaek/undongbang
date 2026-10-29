export async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
 const timeout=AbortSignal.timeout(60000);let response:Response;
 try{response=await fetch(path,{credentials:'same-origin',...options,signal:options.signal?AbortSignal.any([options.signal,timeout]):timeout,headers:{...(options.body&&!(options.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...options.headers}});}
 catch(e){if(options.signal?.aborted)throw e;throw new Error(navigator.onLine?'응답이 늦어지고 있어요. 입력을 유지한 채 다시 시도해주세요.':'인터넷 연결을 확인해주세요. 입력한 내용은 유지돼요.');}
 let data:any;try{data=await response.json();}catch{throw new Error('서버와 연결하지 못했어요. 다시 시도해주세요.');}
 if(!response.ok){if(response.status===401&&typeof window!=='undefined')window.dispatchEvent(new Event('workout-session-expired'));throw new Error(data.error||'요청을 처리하지 못했어요.');}return data;
}
export const send=(path:string,data:unknown,method='POST')=>api(path,{method,body:JSON.stringify(data)});
export function uploadMedia(roomId:string,data:FormData,onProgress:(progress:number)=>void,signal:AbortSignal):Promise<any>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(new DOMException('업로드를 취소했어요.','AbortError'));return;}
  const xhr=new XMLHttpRequest(),abort=()=>xhr.abort(),done=()=>signal.removeEventListener('abort',abort);
  xhr.open('POST',`/api/upload?room=${roomId}`);xhr.withCredentials=true;xhr.responseType='json';xhr.timeout=120000;
  xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.round(e.loaded/e.total*100));};
  xhr.onload=()=>{done();if(xhr.status>=200&&xhr.status<300)resolve(xhr.response);else reject(new Error(xhr.response?.error||'업로드에 실패했어요. 다시 시도해주세요.'));};
  xhr.onerror=()=>{done();reject(new Error('인터넷 연결을 확인해주세요. 선택한 사진은 유지돼요.'));};
  xhr.ontimeout=()=>{done();reject(new Error('업로드 시간이 초과됐어요. 선택한 사진은 유지돼요. 다시 올려주세요.'));};
  xhr.onabort=()=>{done();reject(new DOMException('업로드를 취소했어요.','AbortError'));};
  signal.addEventListener('abort',abort,{once:true});xhr.send(data);
 });
}
export function displayTime(value:string){return new Intl.DateTimeFormat('ko-KR',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).format(new Date(value));}

