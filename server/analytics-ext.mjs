import { z } from 'zod';
import { businessDate } from './db.mjs';
import { assert,permit,parseRecord } from './domain.mjs';

// Analytics completion — a backtested demand forecast (so a forecast can be
// trusted only when its error is measured) and an operational variance report
// that separates labour, waste and delay from contribution.
const dayMs=86400000;
const addDays=(iso,n)=>new Date(new Date(`${iso}T00:00:00Z`).getTime()+n*dayMs).toISOString().slice(0,10);
const daysBetween=(from,to)=>{const out=[];for(let d=from;d<=to;d=addDays(d,1))out.push(d);return out;};
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const movingAverage=(series,window,horizon)=>{
  const actual=[...series].sort((a,b)=>a.date.localeCompare(b.date));
  assert(actual.length>=window+horizon,`The forecast needs at least ${window+horizon} periods of history to backtest.`,409);
  const predictions=[];
  for(let i=window;i<actual.length;i++){
    const base=actual.slice(i-window,i);
    const predicted=Math.round(mean(base.map(p=>p.quantity)));
    predictions.push({date:actual[i].date,actual:actual[i].quantity,predicted});
  }
  const errors=predictions.map(p=>p.actual-p.predicted);
  const mae=Math.round(mean(errors.map(Math.abs))*100)/100;
  const bias=Math.round(mean(errors)*100)/100;
  const mape=Math.round(mean(predictions.map(p=>Math.abs(p.actual-p.predicted)/Math.max(p.actual,1)))*10000)/100;
  return {method:'moving_average',window,horizon,predictions,mae,bias,mape,samples:predictions.length};
};
const seriesFromOrders=(db,ctx,itemId,from,to)=>{
  const rows=db.prepare(`SELECT o.business_date date, COALESCE(SUM(l.quantity),0) quantity FROM orders o JOIN order_lines l ON l.order_id=o.id WHERE o.tenant_id=? AND o.outlet_id=? AND o.status!='cancelled' AND (? IS NULL OR l.item_id=?) AND (? IS NULL OR o.business_date>=?) AND (? IS NULL OR o.business_date<=?) GROUP BY o.business_date ORDER BY o.business_date`).all(ctx.tenantId,ctx.outletId,itemId||null,itemId||null,from||null,from||null,to||null,to||null);
  if(!rows.length)return [];
  const first=from||rows[0].date,last=to||rows[rows.length-1].date;
  const byDate=new Map(rows.map(r=>[r.date,r.quantity]));
  return daysBetween(first,last).map(date=>({date,quantity:byDate.get(date)||0}));
};
export function backtestForecast(db,ctx,input){
  permit(ctx,'reports','read');
  const body=z.object({itemId:z.string().max(200).optional(),from:z.iso.date().optional(),to:z.iso.date().optional(),window:z.number().int().min(1).max(90).default(7),horizon:z.number().int().min(1).max(30).default(1),series:z.array(z.object({date:z.iso.date(),quantity:z.number().int().nonnegative().max(1_000_000)}).strict()).max(400).optional()}).strict().parse(input);
  const series=body.series&&body.series.length?body.series:seriesFromOrders(db,ctx,body.itemId,body.from,body.to);
  assert(series.length,body.itemId?'No recorded sales for this item to backtest.':'No recorded sales to backtest.',409);
  return {itemId:body.itemId||'all-items',...movingAverage(series,body.window,body.horizon)};
}
export function forecastDemand(db,ctx,input){
  permit(ctx,'reports','read');
  const body=z.object({itemId:z.string().max(200).optional(),window:z.number().int().min(1).max(90).default(7),horizon:z.number().int().min(1).max(30).default(7)}).strict().parse(input);
  const series=seriesFromOrders(db,ctx,body.itemId,null,null);
  assert(series.length>=body.window,`The forecast needs at least ${body.window} periods of history.`,409);
  const recent=series.slice(-body.window);
  const base=Math.round(mean(recent.map(p=>p.quantity)));
  const lastDate=series[series.length-1].date,upside=Math.max(...recent.map(p=>p.quantity)),downside=Math.min(...recent.map(p=>p.quantity));
  const forward=Array.from({length:body.horizon},(_,i)=>({date:addDays(lastDate,i+1),predicted:base,low:downside,high:upside}));
  return {itemId:body.itemId||'all-items',window:body.window,basis:`Mean of the last ${body.window} recorded periods`,base,low:downside,high:upside,horizon:body.horizon,predictions:forward,history:series.slice(-30),note:'Deterministic moving-average baseline. Range is the observed minimum and maximum of the window, not a statistical confidence interval.'};
}

export function operationalVariance(db,ctx,input={}){
  permit(ctx,'reports','read');
  const to=input.to||businessDate(),from=input.from||addDays(to,-6);
  assert(from<=to,'Variance range start must be on or before the end.');
  const sum=(account)=>{const row=db.prepare("SELECT COALESCE(SUM(l.debit-l.credit),0) n FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.tenant_id=? AND j.outlet_id=? AND l.account=? AND j.business_date>=? AND j.business_date<=?").get(ctx.tenantId,ctx.outletId,account,from,to);return row.n;};
  const sales=db.prepare("SELECT COALESCE(SUM(net),0) n FROM orders WHERE tenant_id=? AND outlet_id=? AND status!='cancelled' AND business_date>=? AND business_date<=?").get(ctx.tenantId,ctx.outletId,from,to).n;
  const refunded=db.prepare("SELECT COALESCE(SUM(r.amount),0) n FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.tenant_id=? AND r.outlet_id=? AND o.business_date>=? AND o.business_date<=?").get(ctx.tenantId,ctx.outletId,from,to).n;
  const foodCost=sum('Food cost'),wasteCost=sum('Wastage'),labourCost=sum('Wages');
  const netSales=sales;
  const shifts=db.prepare("SELECT * FROM records WHERE tenant_id=? AND outlet_id=? AND module='shifts'").all(ctx.tenantId,ctx.outletId).map(parseRecord);
  const fromStart=`${from}T00:00:00.000Z`,toEnd=`${to}T23:59:59.999Z`;
  let labourHours=0;
  for(const s of shifts){const start=s.data.startsAt,end=s.data.endsAt;if(end<fromStart||start>toEnd)continue;const a=new Date(Math.max(new Date(start).getTime(),new Date(fromStart).getTime())),b=new Date(Math.min(new Date(end).getTime(),new Date(toEnd).getTime()));labourHours+=(b-a)/3600000;}
  labourHours=Math.round(labourHours*10)/10;
  const delays=db.prepare("SELECT delay_reason reason,COUNT(*) count FROM tasks WHERE tenant_id=? AND outlet_id=? AND delay_reason!='' GROUP BY delay_reason ORDER BY count DESC LIMIT 20").all(ctx.tenantId,ctx.outletId);
  const delayCount=delays.reduce((s,d)=>s+d.count,0);
  const contribution=netSales-foodCost;
  return {from,to,netSales,refunded,foodCost,wasteCost,labourCost,labourHours,delayCount,delays,contribution,contributionMargin:netSales?Math.round(contribution/netSales*10000)/100:null,wasteRate:netSales?Math.round(wasteCost/netSales*10000)/100:null,definition:'Labour cost is posted wages; labour hours are scheduled shift overlap with the range. Waste and food cost are posted journals. Delays are kitchen tasks with a recorded delay reason.'};
}

export function mountAnalyticsExt(app,db){
  app.get('/api/analytics/forecast',(req,res)=>res.json(forecastDemand(db,req.ctx,req.query)));
  app.post('/api/analytics/forecast/backtest',(req,res)=>res.json(backtestForecast(db,req.ctx,req.body)));
  app.get('/api/analytics/variance',(req,res)=>res.json(operationalVariance(db,req.ctx,req.query)));
}
