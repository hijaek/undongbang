import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
mkdirSync('.sites-runtime/tests',{recursive:true});
for(const suite of ['media','routing','integration','operations']){
 await build({entryPoints:[`tests/${suite}.ts`],outfile:`.sites-runtime/tests/${suite}.mjs`,bundle:true,platform:'node',format:'esm',packages:'external'});
 const result=spawnSync(process.execPath,[`.sites-runtime/tests/${suite}.mjs`],{stdio:'inherit',env:{...process.env,CLOUDFLARE_CF_FETCH_ENABLED:'false',WRANGLER_SEND_METRICS:'false'}});if(result.status!==0){process.exitCode=result.status??1;break;}
}
