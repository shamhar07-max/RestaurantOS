import {useState,type FormEvent} from 'react';
import {Plus,Trash2,FlaskConical} from 'lucide-react';
import {api,money} from './api';
import {allowed} from '../shared/modules.mjs';
import {useApp,useData,Panel,Status,Loading,Empty,ErrorBox,Drawer,Field,DataTable,type Row} from './ui';

type Line={ingredientId:string,subRecipeId:string,quantity:string};

export function RecipeBom(){
  const {boot,run,busy}=useApp();
  const recipes=useData<Row[]>('/recipes',[]);
  const [editing,setEditing]=useState<Row|'new'|null>(null),[explode,setExplode]=useState<Row|null>(null),[plan,setPlan]=useState<Row|null>(null);
  const canWrite=allowed(boot.user.role,'menu');
  const active=(recipes.data||[]).filter((r:Row)=>r.status==='active');
  const suspend=async(r:Row)=>{if(!confirm(`Suspend the active version of ${r.name}?`))return;await run(()=>api(`/recipes/${r.id}/suspend`,{version:r.version,reason:'Operator suspended this recipe version'}),'Recipe version suspended');};
  return <Panel title="Sub-recipes & bill of materials" action={<span className="small-pill">{active.length} active · {(recipes.data||[]).length} versions</span>}>
    <p className="panel-note">A sub-recipe is a versioned bill of materials for a prepared ingredient. Lines can nest another recipe, so an explosion resolves the full base-ingredient tree, cost and allergens. Revising creates a new version and supersedes the old one.</p>
    {recipes.error?<ErrorBox message={recipes.error}/>:recipes.loading&&!(recipes.data||[]).length?<Loading/>:(recipes.data||[]).length?<DataTable headers={['Recipe','Produces','Version','Status','Lines','']}>
      {(recipes.data||[]).map(r=><tr key={r.id}><td><strong>{r.name}</strong><small>{r.lines.length} line{r.lines.length===1?'':'s'}</small></td><td>{r.outputName}<small>{r.outputQuantity} {r.outputUnit}</small></td><td>v{r.version}</td><td><Status value={r.status}/></td><td className="reference-cell">{r.lines.map((l:Row)=>l.subRecipe?`→ ${l.subRecipe.name}`:l.ingredient?.name||l.ingredientId).join(', ')}</td><td><div className="lot-actions"><button className="text-button" onClick={()=>run(()=>api(`/recipes/${r.id}/explode`),'Explosion loaded').then((x:Row|null)=>x&&setExplode(x))}>Explode</button>{canWrite&&r.status==='active'&&<><button className="text-button" onClick={()=>setEditing(r)}>Revise</button><button className="text-button" onClick={()=>setPlan(r)}>Plan production</button><button className="text-button danger-text" onClick={()=>suspend(r)} disabled={busy}>Suspend</button></>}</div></td></tr>)}
    </DataTable>:<Empty title="No sub-recipes defined" description="Add a bill of materials for a prepared ingredient to enable nested explosions and production planning."/>}
    {canWrite&&<button className="secondary" onClick={()=>setEditing('new')}><Plus size={16}/> Add sub-recipe</button>}
    {editing&&<RecipeForm recipe={editing==='new'?null:editing} recipes={active} ingredients={boot.ingredients} onClose={()=>setEditing(null)}/>}
    {explode&&<ExplosionDrawer result={explode} recipe={explode.recipe} onClose={()=>setExplode(null)}/>}
    {plan&&<PlanForm recipe={plan} onClose={()=>setPlan(null)}/>}
  </Panel>;
}

function lineSelectors(ingredients:Row[],recipes:Row[],exclude:string){
  return {ingredients,recipes:recipes.filter(r=>r.id!==exclude)};
}

function RecipeForm({recipe,recipes,ingredients,onClose}:{recipe:Row|null,recipes:Row[],ingredients:Row[],onClose:()=>void}){
  const {run,busy}=useApp();
  const {ingredients:ingOptions,recipes:recipeOptions}=lineSelectors(ingredients,recipes,recipe?.id||'');
  const [name,setName]=useState(recipe?.name||'');
  const [outputId,setOutputId]=useState(recipe?.output_id||ingOptions[0]?.id||'');
  const [outputQuantity,setOutputQuantity]=useState(String(recipe?.outputQuantity||100));
  const [lines,setLines]=useState<Line[]>(recipe?recipe.lines.map((l:Row)=>({ingredientId:l.ingredientId||'',subRecipeId:l.subRecipeId||'',quantity:String(l.quantity)})):[{ingredientId:ingOptions[0]?.id||'',subRecipeId:'',quantity:'100'}]);
  const setLine=(i:number,patch:Partial<Line>)=>setLines(prev=>prev.map((x,index)=>index===i?{...x,...patch}:x));
  const payload=()=>({name,outputId,outputQuantity:Number(outputQuantity),lines:lines.map(l=>l.subRecipeId?{subRecipeId:l.subRecipeId,quantity:Number(l.quantity)}:{ingredientId:l.ingredientId,quantity:Number(l.quantity)})});
  const submit=async(e:FormEvent)=>{e.preventDefault();const result=recipe?await run(()=>api(`/recipes/${recipe.id}/revision`,{version:recipe.version,...payload()}),'New recipe version created'):await run(()=>api('/recipes',payload()),'Sub-recipe created');if(result)onClose();};
  return <Drawer title={recipe?`Revise ${recipe.name}`:'Add sub-recipe'} onClose={onClose}><form onSubmit={submit} className="record-form">
    <Field label="Recipe name *"><input required value={name} onChange={e=>setName(e.target.value)}/></Field>
    <div className="form-grid">
      <Field label="Produces ingredient *" hint={recipe?'The output ingredient cannot change between versions.':undefined}><select required disabled={!!recipe} value={outputId} onChange={e=>setOutputId(e.target.value)}>{ingOptions.map((i:Row)=><option key={i.id} value={i.id}>{i.name} · {i.unit}</option>)}</select></Field>
      <Field label="Output quantity · base units *"><input required type="number" min="1" step="1" value={outputQuantity} onChange={e=>setOutputQuantity(e.target.value)}/></Field>
    </div>
    <h3>Bill of materials</h3>
    {lines.map((l,i)=>{const isNested=!!l.subRecipeId;return <div className="recipe-row" key={i}>
      <select aria-label={`Line ${i+1} type`} value={isNested?'subRecipe':'ingredient'} onChange={e=>setLine(i,e.target.value==='subRecipe'?{subRecipeId:recipeOptions[0]?.id||'',ingredientId:''}:{ingredientId:ingOptions[0]?.id||'',subRecipeId:''})}><option value="ingredient">Ingredient</option>{recipeOptions.length>0&&<option value="subRecipe">Nested sub-recipe</option>}</select>
      <select aria-label={`Line ${i+1} reference`} value={isNested?l.subRecipeId:l.ingredientId} onChange={e=>setLine(i,isNested?{subRecipeId:e.target.value}:{ingredientId:e.target.value})}>{(isNested?recipeOptions:ingOptions).map((o:Row)=><option key={o.id} value={o.id}>{o.name}{o.unit?` · ${o.unit}`:''}{o.status?` (v${o.version})`:''}</option>)}</select>
      <input aria-label={`Line ${i+1} quantity`} type="number" min="1" step="1" required value={l.quantity} onChange={e=>setLine(i,{quantity:e.target.value})}/>
      <button type="button" className="icon-button" disabled={lines.length===1} onClick={()=>setLines(p=>p.filter((_,index)=>index!==i))} aria-label="Remove line"><Trash2 size={15}/></button>
    </div>;})}
    <button type="button" className="secondary small" onClick={()=>setLines(p=>[...p,{ingredientId:ingOptions[0]?.id||'',subRecipeId:'',quantity:'1'}])}><Plus size={14}/> Add line</button>
    <div className="form-footer"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!name||!outputId}>{recipe?'Create new version':'Create sub-recipe'}</button></div>
  </form></Drawer>;
}

function ExplosionDrawer({result,recipe,onClose}:{result:Row,recipe:Row,onClose:()=>void}){
  return <Drawer title={`Explosion · ${recipe.name||''} v${recipe.version}`} onClose={onClose}>
    <div className="result-box"><strong>{money(result.totalCost)} at base cost</strong><span>{result.quantity} {recipe.outputUnit||''} planned output · {result.lines.length} base ingredients</span>{result.short&&<p className="result-warning">Some base ingredients are short of the required quantity.</p>}</div>
    <DataTable headers={['Base ingredient','Required','On hand','Cost']}>{result.lines.map((l:Row)=><tr key={l.ingredientId}><td><strong>{l.name}</strong><small>{l.unit}</small></td><td className="numeric">{l.quantity.toLocaleString()} {l.unit}</td><td className={`numeric ${l.short?'negative':''}`}>{l.available.toLocaleString()}</td><td className="numeric">{money(l.cost)}</td></tr>)}</DataTable>
    <h3>Inherited allergens</h3><p>{result.allergens.join(', ')||'No ingredient allergens recorded; this is not an allergen-free declaration.'}</p>
  </Drawer>;
}

function PlanForm({recipe,onClose}:{recipe:Row,onClose:()=>void}){
  const {run,busy,notify}=useApp();
  const [name,setName]=useState(`${recipe.name} run`),[quantity,setQuantity]=useState(String(recipe.outputQuantity)),[expiry,setExpiry]=useState('');
  const submit=async(e:FormEvent)=>{e.preventDefault();const result=await run(()=>api(`/recipes/${recipe.id}/produce`,{name,quantity:Number(quantity),expiry}),'Planned production batch created');if(result){notify(`${result.inputs.length} consolidated inputs · ${result.batch.status} batch`);onClose();}};
  return <Drawer title={`Plan production · ${recipe.name}`} onClose={onClose}><form onSubmit={submit} className="record-form">
    <Field label="Batch reference *"><input required value={name} onChange={e=>setName(e.target.value)}/></Field>
    <Field label={`Planned output · ${recipe.outputUnit||'base units'} *`} hint={`Recipe v${recipe.version} yields ${recipe.outputQuantity} ${recipe.outputUnit||''}.`}><input required type="number" min="1" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)}/></Field>
    <Field label="Output expiry *"><input required type="date" value={expiry} onChange={e=>setExpiry(e.target.value)}/></Field>
    <div className="form-footer"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!name||!expiry}><FlaskConical size={16}/> Create planned batch</button></div>
  </form></Drawer>;
}
