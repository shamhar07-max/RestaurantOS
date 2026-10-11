import { spawn } from 'node:child_process';
const processes=[spawn(process.execPath,['--watch','server/index.mjs'],{stdio:'inherit'}),spawn('npm',['exec','vite'],{stdio:'inherit'})];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const p of processes)p.kill('SIGTERM');setTimeout(()=>process.exit(code),300);}
for(const p of processes)p.on('exit',code=>stop(code||0));
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
