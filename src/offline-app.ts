import {api} from './api';

// ORD-11 — register the offline application shell so the workspace can start
// without a network connection. Registration is best-effort and never blocks the
// interface; the queue in offline.ts still governs order drafts and payments.
export function registerOfflineShell(){
  if(typeof navigator==='undefined'||!('serviceWorker' in navigator))return;
  navigator.serviceWorker.register('/sw.js').catch(()=>{ /* offline shell is optional */ });
}

// ORD-11 — printer interruption handling. A ticket is queued server-side before
// the browser print dialog opens; the outcome is acknowledged so an interrupted
// print is retained as a failed job available for a controlled reprint.
export async function printOrderTicket(orderId:string,station:string,printerName=''){
  const job=await api(`/orders/${orderId}/print-jobs`,{station,printer:printerName,idempotencyKey:printedKey(orderId,station)});
  try{
    window.print();
    return await api(`/print-jobs/${job.id}/acknowledge`,{ok:true});
  }catch(error){
    return await api(`/print-jobs/${job.id}/acknowledge`,{ok:false,error:error instanceof Error?error.message:'Printing was interrupted.'});
  }
}
function printedKey(orderId:string,station:string){return `${orderId}:${station}:${Date.now()}`.slice(0,200);}
