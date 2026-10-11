import { backup } from 'node:sqlite';
import { openDatabase } from '../server/db.mjs';
import { mkdirSync,chmodSync } from 'node:fs';
import { resolve,join } from 'node:path';
const dataDir=resolve(process.env.DATA_DIR||'data');
const backupDir=join(dataDir,'backups');mkdirSync(backupDir,{recursive:true});
const db=openDatabase(join(dataDir,'restaurant.sqlite'));
const target=join(backupDir,`restaurant-${new Date().toISOString().replaceAll(':','-')}.sqlite`);
try{await backup(db,target);chmodSync(target,0o600);console.log(`Consistent SQLite backup saved: ${target}`);}finally{db.close();}
