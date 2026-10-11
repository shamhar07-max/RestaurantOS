import {useState,useEffect} from 'react';
import {api,label} from './api';
import {useApp,useData,Panel,Loading,ErrorBox,DataTable,type Row} from './ui';

// Serving evidence reconciliation: produced and served meals against an accepted contract.
export function ServingReconciliation(){
  const {boot,version}=useApp();
  const contracts=useData<Row[]>('/records/contracts',[]);
  const [contractId,setContractId]=useState('');
  const [result,setResult]=useState<Row|null>(null),[error,setError]=useState('');
  const list=(contracts.data||[]).filter((c:Row)=>c.status!=='draft');
  useEffect(()=>{if(!contractId&&list.length)setContractId(list[0].id);},[contracts.data]);
  useEffect(()=>{if(!contractId){setResult(null);return;}let live=true;api(`/catering/servings/reconciliation?contractId=${encodeURIComponent(contractId)}`).then(r=>{if(live)setResult(r);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[contractId,version]);
  if(boot.user.role==='chef')return null;
  return <Panel title="Serving reconciliation" action={<span className="small-pill">Evidence-backed meal counts</span>}>
    <p className="panel-note">Verified serving evidence advances the contract's served count and reconciles individual scans with group counts. Recorded but unverified evidence blocks reconciliation.</p>
    {contracts.error?<ErrorBox message={contracts.error}/>:!list.length?<p className="muted">No approved contracts to reconcile.</p>:<>
      <label className="field"><span>Meal contract</span><select value={contractId} onChange={e=>{setError('');setContractId(e.target.value);}}>{list.map((c:Row)=><option key={c.id} value={c.id}>{c.data.name} · {c.data.site}</option>)}</select></label>
      {error&&<ErrorBox message={error}/>}
      {!result?<Loading/>:<><div className={`result-box ${result.reconciled?'':'result-warning'}`}><strong>{result.reconciled?'Reconciled':'Evidence awaiting verification'}</strong><span>{result.served} served of {result.accepted} accepted · {result.remaining} remaining{result.overServed?` · ${result.overServed} over accepted`:''}</span></div>
        <DataTable headers={['Measure','Value']}>
          <tr><td>Accepted meals</td><td className="numeric">{result.accepted.toLocaleString()}</td></tr>
          <tr><td>Served (verified evidence)</td><td className="numeric">{result.verifiedEvidence.toLocaleString()}</td></tr>
          <tr><td>Recorded, not yet verified</td><td className="numeric">{result.unverifiedEvidence.toLocaleString()}</td></tr>
          <tr><td>Individual scans</td><td className="numeric">{result.individualScans.toLocaleString()}</td></tr>
          <tr><td>Group counts</td><td className="numeric">{result.groupCounts.toLocaleString()}</td></tr>
          <tr><td>Remaining entitlement</td><td className="numeric">{result.remaining.toLocaleString()}</td></tr>
        </DataTable>
        <p className="panel-note">{result.evidenceCount} serving record{result.evidenceCount===1?'':'s'} for {label(result.contract.mealType)} at {result.contract.site}. Billing closes the period separately and preserves the rate version.</p></>}
    </>}
  </Panel>;
}
