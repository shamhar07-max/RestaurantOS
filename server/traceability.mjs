const parseRecord=r=>r?{...r,data:JSON.parse(r.data)}:null;
// Callers must authorise inventory access and bind the root lot to the current outlet.
export function traceDescendants(db,ctx,lot){
  const outlets=Array.isArray(ctx.user.outlet_ids)?ctx.user.outlet_ids:[ctx.outletId],seen=new Set(),pending=[lot],lots=[],movements=[],records=new Map(),orders=new Map(),links=[];let restrictedLinks=false,truncated=false;
  while(pending.length){if(seen.size>=1000){truncated=true;break;}const current=pending.shift();if(seen.has(current.id))continue;seen.add(current.id);lots.push(current);
    const entries=db.prepare('SELECT * FROM movements WHERE lot_id=? AND tenant_id=? AND outlet_id=? ORDER BY created_at').all(current.id,ctx.tenantId,current.outlet_id);movements.push(...entries);
    const refs=new Set(entries.map(m=>m.origin));for(const r of db.prepare("SELECT DISTINCT o.id FROM reservations r JOIN orders o ON o.id=r.order_id WHERE r.lot_id=? AND o.tenant_id=? AND o.outlet_id=? AND r.status IN ('reserved','consumed')").all(current.id,ctx.tenantId,current.outlet_id))refs.add(r.id);
    for(const ref of refs){const order=db.prepare('SELECT id,number,service,channel,status,created_at,outlet_id FROM orders WHERE id=? AND tenant_id=? AND outlet_id=?').get(ref,ctx.tenantId,current.outlet_id);if(order){const exposures=db.prepare("SELECT status FROM reservations WHERE lot_id=? AND order_id=? AND status IN ('reserved','consumed')").all(current.id,order.id).map(r=>r.status);const previous=orders.get(order.id);orders.set(order.id,{...order,exposure:[...new Set([...(previous?.exposure||[]),...exposures])]});}
      const record=parseRecord(db.prepare('SELECT * FROM records WHERE id=? AND tenant_id=? AND outlet_id=?').get(ref,ctx.tenantId,current.outlet_id));if(!record)continue;records.set(record.id,record);
      if(!['batches','transfers'].includes(record.module))continue;
      for(const child of db.prepare('SELECT * FROM lots WHERE origin=? AND tenant_id=?').all(record.id,ctx.tenantId)){if(!outlets.includes(child.outlet_id)){restrictedLinks=true;continue;}if(child.id===current.id)continue;links.push({fromLot:current.id,toLot:child.id,recordId:record.id,type:record.module});if(!seen.has(child.id))pending.push(child);}
    }
  }
  const source=parseRecord(db.prepare('SELECT * FROM records WHERE id=? AND tenant_id=? AND outlet_id=?').get(lot.origin,ctx.tenantId,lot.outlet_id));
  return {lot,lots,movements,orders:[...orders.values()],records:[...records.values()],links,source,restrictedLinks,truncated,evidenceGap:'Recorded descendant lots, production and transfers are traversed within your assigned outlets. Reserved orders are exposure candidates; consumed orders are recorded preparation. Bulk service does not establish individual consumer identity.'};
}
