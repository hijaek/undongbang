'use client';
import {createContext,useContext} from 'react';
import type {Bootstrap,Post} from '../lib/domain';
export const AppContext=createContext<{boot:Bootstrap;refresh:()=>Promise<void>;notify:(message:string)=>void;go:(screen:string)=>void;upload:()=>void;profile:(id:string)=>void;openPost:(post:Post)=>void}>({} as any);
export const useApp=()=>useContext(AppContext);
