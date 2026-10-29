// Supply a fresh get_site result's service token through structured stdin only.
// No browser login, secrets in argv/files, or local credentials are required.
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('base64url');
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdout.write('Ready for private operations input.\n');
process.stdin.setEncoding('utf8');let input='';
for await(const chunk of process.stdin){input+=chunk;if((input.includes('\n')||input.includes('\r')))break;}
const b=JSON.parse(input),key=sha(b.token+':workout-maintenance-v1');
if(b.action==='configuration'){process.stdout.write(JSON.stringify({hash:sha(key)})+'\n');}
else{
 const endpoint=new URL('/api/operations',b.origin);if(endpoint.protocol!=='https:')throw Error('An HTTPS site origin is required');
 const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','OAI-Sites-Authorization':'Bearer '+b.token,'x-workout-operations-key':key},body:JSON.stringify({action:b.action,ids:b.ids}),signal:AbortSignal.timeout(180000)});
 const text=await response.text();process.stdout.write(JSON.stringify({status:response.status,result:text})+'\n');if(!response.ok)process.exitCode=1;
}

