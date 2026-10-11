import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {X,LoaderCircle,Inbox,AlertCircle,ChevronRight} from 'lucide-react';
import {api,label,money,dateTime} from './api';
export type Row=Record<string,any>;
export const AppContext=createContext<any>(null);
export const useApp=()=>useContext(AppContext);
export function useData<T=any>(path:string|null,initial:T):{data:T,loading:boolean,error:string}{
  const {version}=useApp();const [data,setData]=useState<T>(initial),[loading,setLoading]=useState(true),[error,setError]=useState('');
  useEffect(()=>{let active=true;setLoading(true);setError('');if(!path){setData(initial);setLoading(false);return;}api<T>(path).then(d=>{if(active)setData(d);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[path,version]);
  return {data,loading,error};
}
export function Status({value}:{value:string}){return <span className={`status status-${value}`}><span aria-hidden="true" className="status-dot"/>{label(value)}</span>;}
export function Empty({title='No records yet',description='Create your first record to begin this workflow.'}:{title?:string,description?:string}){return <div className="empty"><Inbox size={30}/><h3>{title}</h3><p>{description}</p></div>;}
export function Loading(){return <div className="loading" role="status"><LoaderCircle size={20} className="spin"/> Loading your workspace…</div>;}
export function ErrorBox({message}:{message:string}){return <div className="error-box" role="alert"><AlertCircle size={18}/><span>{message}</span></div>;}
export function PageHeading({title,description,children}:{title:string,description:string,children?:ReactNode}){return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{children}</div></div>;}
export function Panel({title,children,action,className=''}:{title?:string,children:ReactNode,action?:ReactNode,className?:string}){return <section className={`panel ${className}`}>{title&&<div className="panel-heading"><h2>{title}</h2>{action}</div>}{children}</section>;}
export function Tabs({items,value,onChange}:{items:{id:string,name:string,count?:number}[],value:string,onChange:(v:string)=>void}){return <div className="tabs" role="tablist">{items.map(t=><button key={t.id} role="tab" aria-selected={t.id===value} className={t.id===value?'active':''} onClick={()=>onChange(t.id)}>{t.name}{t.count!==undefined&&<span>{t.count}</span>}</button>)}</div>;}
export function Drawer({title,children,onClose,wide=false}:{title:string,children:ReactNode,onClose:()=>void,wide?:boolean}){
  const ref=useRef<HTMLDivElement>(null);const closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(()=>{const before=document.activeElement as HTMLElement;const el=ref.current;const targets=()=>Array.from(el?.querySelectorAll<HTMLElement>('button,input,select,textarea,[tabindex="0"]')||[]).filter(e=>!e.hasAttribute('disabled'));targets()[0]?.focus();const handle=(e:KeyboardEvent)=>{if(e.key==='Escape')closeRef.current();if(e.key==='Tab'){const nodes=targets();const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',handle);const prev=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',handle);document.body.style.overflow=prev;before?.focus();};},[]);
  return <div className="drawer-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={ref} className={`drawer ${wide?'drawer-wide':''}`} role="dialog" aria-modal="true" aria-labelledby="drawer-title"><header><h2 id="drawer-title">{title}</h2><button className="icon-button" aria-label="Close panel" onClick={onClose}><X size={21}/></button></header><div className="drawer-content">{children}</div></div></div>;
}
export function Field({label:caption,children,hint}:{label:string,children:ReactNode,hint?:string}){return <label className="field"><span>{caption}</span>{children}{hint&&<small>{hint}</small>}</label>;}
export function DataTable({headers,children}:{headers:string[],children:ReactNode}){return <div className="table-wrap"><table><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;}
export function RecordValue({field,value,refs}:{field:Row,value:any,refs:Row}){
  if(value===undefined||value==='')return <span className="muted">—</span>;
  if(field.type==='datetime-local'){const stamp=/([Zz]|[+-]\d\d:\d\d)$/.test(String(value))?String(value):String(value)+'+04:00';return Number.isFinite(new Date(stamp).getTime())?<>{dateTime(stamp)} · UAE time</>:<>{String(value)}</>;}
  if(field.label.includes('fils'))return <>{money(Number(value))}</>;
  const lookup=refs[field.type]?.find((r:Row)=>r.id===value);return <>{lookup?.name||lookup?.data?.name||String(value)}</>;
}
export function LinkAction({children,onClick}:{children:ReactNode,onClick:()=>void}){return <button className="text-button" onClick={onClick}>{children}<ChevronRight size={16}/></button>;}
