'use client';
import {Component,type ReactNode} from 'react';
export default class AppErrorBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<div className="app-shell"><main className="app-column"><div className="pad" role="alert"><h2>화면을 다시 불러와주세요.</h2><p>연결이 끊겼거나 새 버전이 배포됐을 수 있어요. 저장된 기록은 유지됩니다.</p><button className="primary full-width" onClick={()=>location.reload()}>새로 불러오기</button></div></main></div>:this.props.children;}
}
