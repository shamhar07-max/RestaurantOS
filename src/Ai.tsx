import {useState} from 'react';
import {Sparkles,BrainCircuit,FileText,MessageCircle,ShieldCheck,Check,X,AlertTriangle,Wand2,KeyRound} from 'lucide-react';
import {api,label} from './api';
import {useApp,useData,PageHeading,Panel,Loading,Empty,ErrorBox,Field,Status,type Row} from './ui';

export function AiWorkspace(){
  const {boot,run}=useApp();
  const role=boot.user.role;
  const {data:status,loading,error}=useData<Row>('/api/ai/status',{});
  const {data:activity,loading:actLoading,error:actError}=useData<Row[]>('/api/ai/activity',[]);
  const [results,setResults]=useState<Record<string,Row>>({});
  const [inputs,setInputs]=useState<Record<string,Record<string,string|number>>>({});
  const [doc,setDoc]=useState<Row|null>(null),[docText,setDocText]=useState(''),[docName,setDocName]=useState('');
  const [ask,setAsk]=useState<Row|null>(null),[question,setQuestion]=useState('');
  const [comm,setComm]=useState<Row|null>(null),[topic,setTopic]=useState(''),[audience,setAudience]=useState('All consented active customers'),[tone,setTone]=useState('Warm and concise');
  if(loading&&Object.keys(status).length===0)return <Loading/>;
  if(error)return <ErrorBox message={error}/>;
  const agents=(status.agents||[]).filter((a:Row)=>a.roles.includes(role));
  const runAgent=async(id:string)=>{
    const value=await run(()=>api(`/api/ai/agents/${id}/run`,inputs[id]||{}),'Assistant finished');
    if(value)setResults(r=>({...r,[id]:value}));
  };
  const connected=status.provider?.connected;
  return <><PageHeading title="AI & automation" description="Assistants answer from verified workspace data. Every proposal is a draft and requires a human decision.">
    <span className={`status ${connected?'status-connected':'status-held'}`}><span aria-hidden="true" className="status-dot"/>{connected?`${status.provider.provider} mounted`:'Deterministic mode'}</span>
  </PageHeading>
  <section className="dashboard-grid">
    <div>
      <Panel title="Provider status" action={status.provider?.model?<span className="small-pill">{status.provider.model}</span>:undefined}>
        <div className="settings-row"><span className="agent-icon"><KeyRound size={18}/></span><span><strong>Language model</strong><small>{connected?'Connected via the configured environment provider. Output is labelled a draft and never executes.':'Not configured. Assistants still work — they answer only from verified database queries.'}</small></span></div>
        <small className="muted">Credentials live in the environment (<code>AI_PROVIDER / AI_API_KEY / AI_MODEL</code>) and are never stored in restaurant data. Free OpenAI-compatible providers (Groq, OpenRouter) or a local Ollama server can be mounted; without a key the workspace stays fully deterministic.</small>
      </Panel>
      <Panel title="Assistants" action={<span className="small-pill">{agents.length} for your role</span>}>
        <div className="agent-grid">
          {agents.map((a:Row)=><div className="panel agent-card" key={a.id}>
            <div className="agent-head"><Icon type={a.id}/><div><strong>{a.name}</strong>{a.requiresApproval?<span className="small-pill pill-amber">needs approval</span>:<span className="small-pill">read-only</span>}</div></div>
            <p>{a.description}</p>
            <p className="control-line"><ShieldCheck size={14}/> {a.control}</p>
            {a.endpoint==='run'?(<>
              {(a.inputs||[]).map((f:Row)=>(<label className="field" key={f.key}><span>{f.label}</span>{f.type==='number'
                ?<input type="number" value={String(inputs[a.id]?.[f.key]??f.initial??'')} onChange={e=>setInputs(v=>({...v,[a.id]:{...(v[a.id]||{}),[f.key]:Number(e.target.value)}}))}/>
                :<input value={String(inputs[a.id]?.[f.key]??'')} placeholder={String(f.initial??'')} onChange={e=>setInputs(v=>({...v,[a.id]:{...(v[a.id]||{}),[f.key]:e.target.value}}))}/>}</label>))}
              <button className={results[a.id]?'secondary':'primary'} onClick={()=>runAgent(a.id)}><Sparkles size={16}/> {results[a.id]?'Run again':'Run assistant'}</button>
            </>):<span className="small-pill">dedicated form below</span>}
            {results[a.id]&&<AgentResult result={results[a.id]}/>}
          </div>)}
        </div>
      </Panel>
    </div>
    <div>
      <Panel title="Supplier document intake" action={<span className="small-pill">draft only</span>}>
        <p className="muted">Paste a supplier invoice. Extract supplier reference, date, amounts and tax into a reviewable draft. Nothing is posted.</p>
        <Field label="Invoice text"><textarea rows={5} value={docText} onChange={e=>setDocText(e.target.value)} placeholder={'INVOICE INV-2026-001 …\nTotal 1,234.56\nVAT 58.78'}/></Field>
        <Field label="Filename (optional)"><input value={docName} onChange={e=>setDocName(e.target.value)}/></Field>
        <button className="primary" disabled={docText.trim().length<10} onClick={async()=>{const r=await run(()=>api('/api/ai/documents/intake',{text:docText,filename:docName}),'Intake draft prepared');if(r)setDoc(r);}}><FileText size={16}/> Extract invoice</button>
        {doc&&<div className="record-inline"><pre>{JSON.stringify(doc.extracted,null,2)}</pre><small className="muted">Method: {doc.method} · drafts are posted only by an accountant through Finance.</small></div>}
      </Panel>
      <Panel title="Customer assistant" action={<span className="small-pill">menu & bookings</span>}>
        <p className="muted">Approved menu prices, availability and booking facts. Anything about allergens is escalated to a person.</p>
        <Field label="Customer question"><input value={question} onChange={e=>setQuestion(e.target.value)} placeholder="How much is the flat white? Does the burger contain allergens?"/></Field>
        <button className="secondary" disabled={question.trim().length<2} onClick={async()=>{const r=await run(()=>api('/api/ai/customers/ask',{question}),'Answered from approved data');if(r)setAsk(r);}}><MessageCircle size={16}/> Ask</button>
        {ask&&<div className={`answer-box ${ask.escalated?'escalated':''}`} role={ask.escalated?'alert':'status'}>{ask.escalated&&<AlertTriangle size={16}/>}<span>{ask.answer}</span><small>{ask.source}</small></div>}
      </Panel>
      <Panel title="Communication drafter" action={<span className="small-pill">never sends</span>}>
        <p className="muted">Draft a customer message from consent statistics. Sending still requires an approved campaign and manager approval.</p>
        <Field label="Campaign topic"><input value={topic} onChange={e=>setTopic(e.target.value)} placeholder="Weekend brunch reservations are open"/></Field>
        <Field label="Audience rule"><input value={audience} onChange={e=>setAudience(e.target.value)}/></Field>
        <Field label="Tone"><input value={tone} onChange={e=>setTone(e.target.value)}/></Field>
        <button className="secondary" disabled={topic.trim().length<3} onClick={async()=>{const r=await run(()=>api('/api/ai/communications/draft',{topic,audience,tone}),'Draft ready');if(r)setComm(r);}}><Wand2 size={16}/> Draft message</button>
        {comm&&<div className="record-inline"><p className="draft-message">{comm.draft.message}</p><small className="muted">{(comm.facts||[]).find((f:Row)=>f.label==='Marketing consent granted')?.value||'0'} of {(comm.facts||[]).find((f:Row)=>f.label==='Active customers')?.value||'0'} active customers have consent · {comm.draft.channel}</small></div>}
      </Panel>
      <Panel title="Assistant activity">
        {actLoading?<Loading/>:actError?<ErrorBox message={actError}/>:!activity.length?<Empty title="No assistant activity yet" description="Run an assistant to see drafts and decisions here."/>:<div className="activity-list">{activity.map((r:Row)=><div className="activity-row" key={r.id}><span className="small-pill">{label(r.kind)}</span><div><strong>{r.payload?.name||r.agent}</strong><small>{new Date(r.created_at).toLocaleString()} · {r.actor}</small></div><Status value={r.status}/>{r.status==='draft'&&['owner','manager','accountant'].includes(role)&&<span className="activity-actions"><button className="icon-button" title="Accept draft" onClick={async()=>{await run(()=>api(`/api/ai/activity/${r.id}/status`,{status:'accepted'}),'Draft accepted');}}><Check size={15}/></button><button className="icon-button" title="Dismiss draft" onClick={async()=>{await run(()=>api(`/api/ai/activity/${r.id}/status`,{status:'dismissed'}),'Draft dismissed');}}><X size={15}/></button></span>}</div>)}</div>}
      </Panel>
    </div>
  </section>
  </>;
}
function AgentResult({result}:{result:Row}){
  return <div className="agent-result">
    {(result.facts||[]).length?<div className="table-wrap"><table><tbody>{(result.facts as Row[]).map((f:Row,i:number)=><tr key={i}><th>{f.label}</th><td>{f.value}</td><td className="muted">{f.evidence}</td></tr>)}</tbody></table></div>:null}
    {result.suggestion&&<p className="suggestion"><BrainCircuit size={15}/> {result.suggestion}</p>}
    {result.provider?.providerError&&<p className="error-line">Provider note: {result.provider.providerError}</p>}
    {result.draft&&<details><summary>Draft payload <span className="small-pill pill-amber">requires approval</span></summary><pre>{JSON.stringify(result.draft,null,2)}</pre></details>}
  </div>;
}
function Icon({type}:{type:string}){
  const map:Record<string,any>={document_intake:<FileText size={18}/>,customer_assistant:<MessageCircle size={18}/>,communication_drafter:<Wand2 size={18}/>,owner_briefing:<BrainCircuit size={18}/>};
  return <span className="agent-icon">{map[type]||<BrainCircuit size={18}/>}</span>;
}