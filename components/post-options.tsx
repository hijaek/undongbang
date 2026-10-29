'use client';
import {useRef,useState} from 'react';
import {useQueryClient,type InfiniteData} from '@tanstack/react-query';
import type {Bootstrap,Post} from '../lib/domain';
import {api} from '../lib/client';
import {useApp} from './context';
import {ErrorBox,Icon,Sheet} from './ui';

type Page={posts:Post[];nextCursor:string|null};
export default function PostOptions({post}:{post:Post}){
 const {boot,refresh,notify,go}=useApp(),client=useQueryClient();
 const [open,setOpen]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
 const inFlight=useRef(false);
 if(post.member_id!==boot.room?.member_id)return null;
 const close=()=>{if(!inFlight.current){setOpen(false);setConfirm(false);setError(null);}};
 const remove=async()=>{
  if(inFlight.current)return;
  inFlight.current=true;setBusy(true);setError(null);
  try{await api(`/api/posts/${encodeURIComponent(post.id)}`,{method:'DELETE'});}
  catch(e){inFlight.current=false;setBusy(false);setError(e);return;}
  await client.cancelQueries({predicate:q=>['feed','grid'].includes(String(q.queryKey[0]))&&q.queryKey[1]===post.room_id||q.queryKey[0]==='post-detail'&&q.queryKey[1]===post.id});
  setOpen(false);
  if(location.hash===`#post/${post.id}`)go('me');
  for(const key of ['feed','grid'])client.setQueriesData<InfiniteData<Page>>({queryKey:[key,post.room_id]},old=>old?{...old,pages:old.pages.map(page=>({...page,posts:page.posts.filter(p=>p.id!==post.id)}))}:old);
  client.removeQueries({queryKey:['post-detail',post.id],exact:true});
  client.removeQueries({queryKey:['comments',post.id],exact:true});
  if(post.status==='valid'&&post.week===boot.week)client.setQueryData<Bootstrap>(['bootstrap'],old=>old?{...old,members:old.members?.map(m=>m.id===post.member_id?{...m,count:Math.max(0,m.count-1)}:m)}:old);
  notify('게시물을 삭제했어요.');
  void refresh();
 };
 return <><button className="icon-button post-menu-trigger" aria-label="게시물 더보기" aria-expanded={open} onClick={()=>setOpen(true)}><Icon name="more" size={22}/></button>{open&&<Sheet title={confirm?'게시물을 삭제할까요?':'게시물'} close={close}><div className="post-menu-content">{confirm?<><p>게시물과 댓글이 삭제되며 되돌릴 수 없어요.</p><p className="muted">{post.week===boot.week?'이번 주 인증 횟수에서도 제외돼요.':'마감된 정산 금액은 바뀌지 않아요.'}</p>{!!error&&<ErrorBox error={error}/>}<button className="post-delete-action" disabled={busy} onClick={()=>void remove()}>{busy?'삭제 중…':'삭제'}</button><button className="post-menu-cancel" disabled={busy} onClick={close}>취소</button></>:<><button className="post-delete-action" onClick={()=>setConfirm(true)}>삭제</button><button className="post-menu-cancel" onClick={close}>취소</button></>}</div></Sheet>}</>;
}
