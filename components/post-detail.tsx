'use client';
import {useEffect,useRef} from 'react';
import type {Post} from '../lib/domain';
import {PostCard,Comments} from './feed';
import {Header,Loading,ErrorBox} from './ui';
export default function PostDetail({post,error,pending,back,retry}:{post?:Post;error:unknown;pending:boolean;back:()=>void;retry:()=>void}){
 const comments=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const viewport=window.visualViewport;
  let frame=0;
  const update=()=>{
   const root=comments.current,screen=root?.closest<HTMLElement>('.post-screen');
   if(!root||!screen||viewport&&viewport.scale!==1)return;
   const focused=root.contains(document.activeElement)&&document.activeElement instanceof HTMLInputElement;
   // iOS keeps the layout viewport tall while the keyboard reduces the visible area.
   screen.style.paddingBottom=focused?`${Math.max(0,window.innerHeight-(viewport?.height||window.innerHeight))}px`:'';
   if(!focused)return;
   const form=root.querySelector('form')?.getBoundingClientRect();
   if(!form)return;
   const bounds=screen.getBoundingClientRect();
   const top=Math.max(bounds.top,viewport?.offsetTop||0)+54,bottom=Math.min(bounds.bottom,(viewport?.offsetTop||0)+(viewport?.height||window.innerHeight))-12;
   if(form.bottom>bottom)screen.scrollTop+=form.bottom-bottom;
   else if(form.top<top)screen.scrollTop+=form.top-top;
  };
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);};
  window.addEventListener('resize',schedule);viewport?.addEventListener('resize',schedule);
  document.addEventListener('focusin',schedule);document.addEventListener('focusout',schedule);
  return()=>{cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);viewport?.removeEventListener('resize',schedule);document.removeEventListener('focusin',schedule);document.removeEventListener('focusout',schedule);};
 },[]);
 const openComments=()=>{const root=comments.current,screen=root?.closest<HTMLElement>('.post-screen');if(root&&screen)screen.scrollTop+=root.getBoundingClientRect().top-screen.getBoundingClientRect().top-54;root?.querySelector('input')?.focus({preventScroll:true});};
 return <><Header title="게시물" back={back}/>{pending?<Loading/>:error?<ErrorBox error={error} retry={retry}/>:post&&<><PostCard post={post} openComments={openComments}/><div className="post-inline-comments" ref={comments}><h2>댓글</h2><Comments post={post} close={()=>{}} inline/></div></>}</>;
}
