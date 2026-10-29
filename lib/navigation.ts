export function parseScreen(value:string){
 const route=value.replace(/^#/,'');
 const match=route.match(/^(post|profile)\/([a-zA-Z0-9:_-]{1,100})$/);
 if(match)return {screen:match[1],id:match[2]};
 return {screen:['feed','week','me','admin'].includes(route)?route:'feed',id:''};
}
