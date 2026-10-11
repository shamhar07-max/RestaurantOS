let csrf = '';
let outlet = localStorage.getItem('restaurant-outlet') || '';
export const setCsrf=(value:string)=>{csrf=value;};
export const setOutlet=(value:string)=>{outlet=value;localStorage.setItem('restaurant-outlet',value);};
export async function api<T=any>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(`/api${path}`,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',...(csrf?{'x-csrf-token':csrf}:{}),...(outlet?{'x-outlet-id':outlet}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok){const error=new Error(data.error||'The request could not be completed.') as Error&{status:number};error.status=response.status;throw error;}
  return data;
}
export async function apiDelete<T=any>(path:string):Promise<T>{
  const response=await fetch(`/api${path}`,{method:'DELETE',credentials:'same-origin',headers:{...(csrf?{'x-csrf-token':csrf}:{}),...(outlet?{'x-outlet-id':outlet}:{})}});
  const data=await response.json();if(!response.ok){const error=new Error(data.error||'The request could not be completed.') as Error&{status:number};error.status=response.status;throw error;}
  return data;
}
export async function download(type:string){
  const r=await fetch(`/api/export/${type}`,{headers:{'x-outlet-id':outlet},credentials:'same-origin'});
  if(!r.ok){const data=await r.json();throw new Error(data.error);}
  const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download=`digitalburj-${type}.csv`;a.click();URL.revokeObjectURL(url);
}
export async function downloadAttachment(id:string,filename:string){const r=await fetch(`/api/attachments/${id}`,{headers:{'x-outlet-id':outlet},credentials:'same-origin'});if(!r.ok)throw new Error((await r.json()).error);const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);}
export const money=(fils:number|null|undefined)=>fils==null?'Restricted':new Intl.NumberFormat('en-AE',{style:'currency',currency:'AED',minimumFractionDigits:2}).format(fils/100);
export const label=(s:string)=>s.replaceAll('_',' ').replace(/^./,c=>c.toUpperCase());
export const time=(s:string)=>new Intl.DateTimeFormat('en-AE',{timeZone:'Asia/Dubai',hour:'2-digit',minute:'2-digit'}).format(new Date(s));
export const dateTime=(s:string)=>new Intl.DateTimeFormat('en-AE',{timeZone:'Asia/Dubai',dateStyle:'medium',timeStyle:'short'}).format(new Date(s));
export const key=()=>crypto.randomUUID();
