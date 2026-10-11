import {useState,type FormEvent} from 'react';
import {Plus,Trash2,RefreshCw,Link2} from 'lucide-react';
import {api,apiDelete,label,dateTime} from './api';
import {useApp,useData,PageHeading,Panel,Status,Loading,Empty,ErrorBox,Drawer,Field,DataTable,type Row} from './ui';

const CHANNELS=['Talabat','Deliveroo','Careem','Direct'];

export function Channels(){
  const {boot,run,busy,notify}=useApp();
  const mappings=useData<Row[]>('/channels/mappings',[]);
  const exceptions=useData<Row[]>('/channels/exceptions',[]);
  const items=useData<Row[]>('/menu',[]);
  const [adding,setAdding]=useState(false),[importing,setImporting]=useState(false);
  const canManage=boot.user.role==='owner'||boot.user.role==='manager';
  const canImport=boot.permissions?.includes('orders:create')||boot.permissions?.includes('orders')||boot.user.role==='owner';
  const open=(exceptions.data||[]).filter(e=>e.status==='open');
  const menuItems=(items.data||[]).filter((i:Row)=>!i.variantParentId);
  const retry=async(e:Row)=>run(()=>api(`/channels/exceptions/${e.id}/retry`,{version:e.version}),'Channel order imported from the queue');
  const remove=async(m:Row)=>{if(!confirm(`Remove the mapping for ${m.external_id}?`))return;await run(()=>apiDelete(`/channels/mappings/${m.id}`),'Channel mapping removed');};
  return <><PageHeading title="Channels & imports" description="Map external menu references to your menu. An unknown reference never partially applies: it is rejected and queued for a person to fix.">{canManage&&<button className="primary" onClick={()=>setAdding(true)}><Plus size={17}/> Map a reference</button>}</PageHeading>
    {open.length>0&&<ErrorBox message={`${open.length} channel import${open.length===1?'':'s'} need a menu mapping before they can be accepted.`}/>}
    <Panel title="Mapping exception queue" action={<span className="small-pill">{open.length} open · {(exceptions.data||[]).length} total</span>}>
      {exceptions.error?<ErrorBox message={exceptions.error}/>:exceptions.loading&&!(exceptions.data||[]).length?<Loading/>:(exceptions.data||[]).length?<DataTable headers={['External order','Channel','Unmapped reference','Attempts','Status','']}>
        {(exceptions.data||[]).map(e=><tr key={e.id}><td><strong>{e.data.externalOrderId}</strong><small>{dateTime(e.created_at)}</small></td><td>{e.data.channel}</td><td><code>{e.data.unresolved?.join(', ')||e.data.externalId}</code></td><td>{e.data.attempts||1}</td><td><Status value={e.status}/></td><td>{e.status==='open'&&canManage&&<button className="secondary small" disabled={busy} onClick={()=>retry(e)}><RefreshCw size={14}/> Retry import</button>}</td></tr>)}
      </DataTable>:<Empty title="No import exceptions" description="Channel orders whose external menu references are all mapped import without creating an exception."/>}
      <p className="panel-note">Retry only succeeds once every reference in the order is mapped. Imports are idempotent by channel order reference, so a retry never duplicates an accepted order.</p>
    </Panel>
    <Panel title="Channel menu mappings" action={canManage&&<button className="secondary small" onClick={()=>setAdding(true)}><Link2 size={15}/> Add mapping</button>}>
      {mappings.error?<ErrorBox message={mappings.error}/>:mappings.loading&&!(mappings.data||[]).length?<Loading/>:(mappings.data||[]).length?<DataTable headers={['Channel','External reference','External name','Mapped menu item','']}>
        {(mappings.data||[]).map(m=><tr key={m.id}><td>{m.channel}</td><td><code>{m.external_id}</code></td><td>{m.external_name||'—'}</td><td><strong>{m.item_name||m.item_id}</strong></td><td>{canManage&&<button className="icon-button" aria-label={`Remove mapping ${m.external_id}`} disabled={busy} onClick={()=>remove(m)}><Trash2 size={15}/></button>}</td></tr>)}
      </DataTable>:<Empty title="No channel mappings yet" description="Add a mapping so an external reference resolves to this outlet's menu."/>}
    </Panel>
    {canImport&&<Panel title="Test an import"><p className="panel-note">Send a synthetic channel order to verify mappings. Unknown references are queued; nothing partial is applied.</p><button className="secondary" onClick={()=>setImporting(true)} disabled={!menuItems.length}><Plus size={16}/> Test channel import</button></Panel>}
    {adding&&<MappingForm channels={CHANNELS} items={menuItems} onClose={()=>setAdding(false)}/>}
    {importing&&<ImportForm items={menuItems} onClose={()=>setImporting(false)} onResult={(msg,error)=>notify(msg,error)} run={run}/>}
  </>;
}

function MappingForm({channels,items,onClose}:{channels:string[],items:Row[],onClose:()=>void}){
  const {run,busy}=useApp();const [values,setValues]=useState<Row>({channel:channels[0],externalItemId:'',externalName:'',itemId:items[0]?.id||''});
  const submit=async(e:FormEvent)=>{e.preventDefault();const result=await run(()=>api('/channels/mappings',{...values}),'Channel mapping saved');if(result)onClose();};
  return <Drawer title="Map a channel reference" onClose={onClose}><form onSubmit={submit} className="record-form">
    <Field label="Channel"><select value={values.channel} onChange={e=>setValues(v=>({...v,channel:e.target.value}))}>{channels.map(c=><option key={c}>{c}</option>)}</select></Field>
    <Field label="External menu reference *"><input required value={values.externalItemId} onChange={e=>setValues(v=>({...v,externalItemId:e.target.value}))}/></Field>
    <Field label="External item name"><input value={values.externalName} onChange={e=>setValues(v=>({...v,externalName:e.target.value}))}/></Field>
    <Field label="Menu item in this outlet *"><select required value={values.itemId} onChange={e=>setValues(v=>({...v,itemId:e.target.value}))}>{items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
    <div className="form-footer"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!values.externalItemId||!values.itemId}>Save mapping</button></div>
  </form></Drawer>;
}

function ImportForm({items,onClose,onResult,run}:{items:Row[],onClose:()=>void,onResult:(msg:string,error?:boolean)=>void,run:(job:()=>Promise<any>,message?:string)=>Promise<any>}){
  const [channel,setChannel]=useState(CHANNELS[0]),[externalOrderId,setExternalOrderId]=useState(''),[service,setService]=useState('takeaway'),[externalItemId,setExternalItemId]=useState(''),[quantity,setQuantity]=useState('1'),[busy,setBusy]=useState(false);
  const submit=async(e:FormEvent)=>{e.preventDefault();setBusy(true);try{const result=await run(()=>api('/channels/import',{channel,externalOrderId,service,lines:[{externalItemId,externalName:items.find(i=>i.id===externalItemId)?.name||'',quantity:Number(quantity)}]}),'Channel order imported');if(result)onClose();}catch{onResult('Import rejected and queued. Add the missing mapping, then retry from the queue.',true);}finally{setBusy(false);}};
  return <Drawer title="Test channel import" onClose={onClose}><form onSubmit={submit} className="record-form">
    <Field label="Channel"><select value={channel} onChange={e=>setChannel(e.target.value)}>{CHANNELS.map(c=><option key={c}>{c}</option>)}</select></Field>
    <Field label="Channel order reference *"><input required value={externalOrderId} onChange={e=>setExternalOrderId(e.target.value)}/></Field>
    <Field label="Service"><select value={service} onChange={e=>setService(e.target.value)}>{['takeaway','delivery','pickup','dine_in'].map(s=><option key={s} value={s}>{label(s)}</option>)}</select></Field>
    <Field label="External menu reference *" hint="Use the reference an operator mapped, or an unknown value to see the exception queue."><input required value={externalItemId} onChange={e=>setExternalItemId(e.target.value)}/></Field>
    <Field label="Quantity"><input type="number" min={1} max={100} value={quantity} onChange={e=>setQuantity(e.target.value)}/></Field>
    <div className="form-footer"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!externalOrderId||!externalItemId}>Import order</button></div>
  </form></Drawer>;
}
