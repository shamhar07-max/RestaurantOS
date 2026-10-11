import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
export const id = (prefix='rec') => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export const businessDate = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function passwordHash(password,salt=randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
export function verifyPassword(password,hash) { const [salt,digest]=hash.split(':'); const actual=scryptSync(password,salt,64);const expected=Buffer.from(digest,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected); }
export function openDatabase(file=resolve(process.env.DATA_DIR||'data','restaurant.sqlite')) {
  if(file!==':memory:')mkdirSync(dirname(file),{recursive:true});
  const db=new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,name TEXT NOT NULL,tax_number TEXT DEFAULT '',FOREIGN KEY(tenant_id) REFERENCES tenants(id));
  CREATE TABLE IF NOT EXISTS outlets(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,entity_id TEXT NOT NULL,name TEXT NOT NULL,brand TEXT NOT NULL,format TEXT NOT NULL,timezone TEXT DEFAULT 'Asia/Dubai',FOREIGN KEY(entity_id) REFERENCES entities(id));
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,outlet_ids TEXT NOT NULL,active INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS approval_delegations(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,user_id TEXT NOT NULL,action TEXT NOT NULL,amount INTEGER NOT NULL,percent INTEGER NOT NULL,starts_at TEXT NOT NULL,expires_at TEXT NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,revoked_at TEXT);
  CREATE TABLE IF NOT EXISTS ingredients(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,name TEXT NOT NULL,unit TEXT NOT NULL,unit_cost INTEGER NOT NULL CHECK(unit_cost>=0),reorder_level INTEGER NOT NULL DEFAULT 0,allergens TEXT DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS lots(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,ingredient_id TEXT NOT NULL,code TEXT NOT NULL,expiry TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'available',unit_cost INTEGER NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>=0),origin TEXT NOT NULL,FOREIGN KEY(ingredient_id) REFERENCES ingredients(id));
  CREATE TABLE IF NOT EXISTS menu(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,name TEXT NOT NULL,arabic_name TEXT DEFAULT '',category TEXT NOT NULL,price INTEGER NOT NULL CHECK(price>=0),station TEXT NOT NULL,prep_minutes INTEGER NOT NULL,available INTEGER DEFAULT 1,version INTEGER DEFAULT 1,recipe TEXT NOT NULL,modifiers TEXT NOT NULL,allergens TEXT NOT NULL,description TEXT DEFAULT '');
  CREATE TABLE IF NOT EXISTS menu_variants(variant_id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,label TEXT NOT NULL,FOREIGN KEY(variant_id) REFERENCES menu(id),FOREIGN KEY(parent_id) REFERENCES menu(id));
  CREATE TABLE IF NOT EXISTS menu_combos(item_id TEXT PRIMARY KEY,components TEXT NOT NULL,FOREIGN KEY(item_id) REFERENCES menu(id));
  CREATE TABLE IF NOT EXISTS bundle_lines(line_id TEXT PRIMARY KEY,bundle_key TEXT NOT NULL,item_id TEXT NOT NULL,name TEXT NOT NULL,version INTEGER NOT NULL,FOREIGN KEY(line_id) REFERENCES order_lines(id));
  CREATE TABLE IF NOT EXISTS split_payments(payment_id TEXT PRIMARY KEY,split_id TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0));
  CREATE TABLE IF NOT EXISTS order_amendments(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,order_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,previous_total INTEGER NOT NULL,total INTEGER NOT NULL,details TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tenant_id,outlet_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS voided_lines(line_id TEXT PRIMARY KEY,amendment_id TEXT NOT NULL,reason TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS order_controls(order_id TEXT PRIMARY KEY,assigned_user_id TEXT,held_tasks TEXT DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS line_service(line_id TEXT PRIMARY KEY,task_id TEXT,seat INTEGER NOT NULL DEFAULT 0,course INTEGER NOT NULL DEFAULT 1,packed INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(line_id) REFERENCES order_lines(id));
  CREATE TABLE IF NOT EXISTS table_groups(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,root_id TEXT NOT NULL,table_ids TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,released_at TEXT);
  CREATE TABLE IF NOT EXISTS waitlist(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,party_size INTEGER NOT NULL,status TEXT NOT NULL,table_id TEXT,ends_at TEXT,notes TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,idempotency_key TEXT NOT NULL,UNIQUE(tenant_id,outlet_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS booking_deposits(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,booking_id TEXT NOT NULL,amount INTEGER NOT NULL,method TEXT NOT NULL,till_id TEXT,reference TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tenant_id,outlet_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS deposit_movements(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,deposit_id TEXT NOT NULL,action TEXT NOT NULL,amount INTEGER NOT NULL,order_id TEXT,payment_id TEXT,reason TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tenant_id,outlet_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS dining_tables(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,name TEXT NOT NULL,seats INTEGER NOT NULL,zone TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,entity_id TEXT NOT NULL,outlet_id TEXT NOT NULL,business_date TEXT NOT NULL,number INTEGER NOT NULL,service TEXT NOT NULL,channel TEXT NOT NULL,table_id TEXT,customer TEXT DEFAULT '',notes TEXT DEFAULT '',status TEXT NOT NULL,total INTEGER NOT NULL,net INTEGER NOT NULL,tax INTEGER NOT NULL,discount INTEGER NOT NULL DEFAULT 0,idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER DEFAULT 1,UNIQUE(tenant_id,outlet_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS order_lines(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,item_id TEXT NOT NULL,name TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price INTEGER NOT NULL,station TEXT NOT NULL,recipe_version INTEGER NOT NULL,recipe TEXT NOT NULL,modifiers TEXT NOT NULL,allergens TEXT NOT NULL,notes TEXT DEFAULT '',consumed INTEGER DEFAULT 0,FOREIGN KEY(order_id) REFERENCES orders(id));
  CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,order_id TEXT NOT NULL,station TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',started_at TEXT,ready_at TEXT,delay_reason TEXT DEFAULT '',FOREIGN KEY(order_id) REFERENCES orders(id));
  CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,order_id TEXT NOT NULL,line_id TEXT NOT NULL,lot_id TEXT NOT NULL,ingredient_id TEXT NOT NULL,quantity INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'reserved',FOREIGN KEY(lot_id) REFERENCES lots(id));
  CREATE TABLE IF NOT EXISTS movements(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,ingredient_id TEXT NOT NULL,lot_id TEXT,quantity INTEGER NOT NULL,type TEXT NOT NULL,origin TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,order_id TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),method TEXT NOT NULL,reference TEXT DEFAULT '',status TEXT NOT NULL,till_id TEXT,idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tenant_id,outlet_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,order_id TEXT NOT NULL,payment_id TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),reason TEXT NOT NULL,actor_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tenant_id,outlet_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS journals(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,origin TEXT NOT NULL,type TEXT NOT NULL,business_date TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tenant_id,origin,type));
  CREATE TABLE IF NOT EXISTS journal_lines(id TEXT PRIMARY KEY,journal_id TEXT NOT NULL,account TEXT NOT NULL,debit INTEGER NOT NULL DEFAULT 0,credit INTEGER NOT NULL DEFAULT 0,CHECK(debit>=0 AND credit>=0),FOREIGN KEY(journal_id) REFERENCES journals(id));
  CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,entity_id TEXT NOT NULL,outlet_id TEXT NOT NULL,module TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,version INTEGER DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS loyalty(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,customer_id TEXT NOT NULL,points INTEGER NOT NULL,reason TEXT NOT NULL,origin TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tenant_id,origin));
  CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,record_id TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings(tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(tenant_id,outlet_id,key));
  CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,record_id TEXT NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,sha256 TEXT NOT NULL,content BLOB NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS periods(tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,business_date TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,closed_at TEXT NOT NULL,PRIMARY KEY(tenant_id,outlet_id,business_date));
  CREATE TABLE IF NOT EXISTS guest_orders(token_hash TEXT PRIMARY KEY,order_id TEXT NOT NULL,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bill_splits(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,outlet_id TEXT NOT NULL,order_id TEXT NOT NULL,name TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),lines TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS order_scope ON orders(tenant_id,outlet_id,created_at);
  CREATE INDEX IF NOT EXISTS record_scope ON records(tenant_id,outlet_id,module);
  CREATE INDEX IF NOT EXISTS lot_scope ON lots(tenant_id,outlet_id,ingredient_id,expiry);
  CREATE INDEX IF NOT EXISTS audit_scope ON audit(tenant_id,outlet_id,created_at);
  PRAGMA user_version=1;`);
  return db;
}
export function transaction(db,fn) {
  const nested=db.isTransaction;
  const savepoint=`sp_${randomBytes(8).toString('hex')}`;
  db.exec(nested?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');
  try{const result=fn();db.exec(nested?`RELEASE SAVEPOINT ${savepoint}`:'COMMIT');return result;}
  catch(e){db.exec(nested?`ROLLBACK TO SAVEPOINT ${savepoint}`:'ROLLBACK');if(nested)db.exec(`RELEASE SAVEPOINT ${savepoint}`);throw e;}
}
export function audit(db,ctx,action,recordId,details={}) {
  db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id('audit'),ctx.tenantId,ctx.outletId,ctx.user.id,action,recordId,JSON.stringify(details),now());
}
export function journal(db,ctx,origin,type,lines) {
  if(db.prepare("SELECT 1 FROM periods WHERE tenant_id=? AND outlet_id=? AND business_date=? AND status='closed'").get(ctx.tenantId,ctx.outletId,businessDate())){const error=new Error('This business date is financially closed. Posting is blocked.');error.status=409;throw error;}
  const debit=lines.reduce((s,l)=>s+(l.debit||0),0), credit=lines.reduce((s,l)=>s+(l.credit||0),0);
  if(debit!==credit||!Number.isSafeInteger(debit)||debit<0)throw new Error('Unbalanced journal');
  const jid=id('journal');
  db.prepare('INSERT INTO journals VALUES(?,?,?,?,?,?,?)').run(jid,ctx.tenantId,ctx.outletId,origin,type,businessDate(),now());
  for(const line of lines)db.prepare('INSERT INTO journal_lines VALUES(?,?,?,?,?)').run(id('jl'),jid,line.account,line.debit||0,line.credit||0);
  return jid;
}
