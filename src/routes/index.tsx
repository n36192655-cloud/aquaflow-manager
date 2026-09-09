import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Droplets, Users, AlertTriangle, Receipt, TrendingUp, Camera, ShieldCheck, Wallet, CalendarDays } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { fmtYER, fmtNum } from "@/lib/pricing";

export const Route = createFileRoute("/")({ head: () => ({ meta: [{ title: "لوحة التحكم — منصة ميزان لإستدامة خدمات المياه" }] }), component: Dashboard });

type Metrics = { projectName:string; customers:number; activeMeters:number; captured:number; identityVerified:number; readingVerified:number; approved:number; rejected:number; bills:number; collections:number; outstanding:number; arrears:number; pending:number };
const empty: Metrics = { projectName:"مشروع مياه المسراخ", customers:0, activeMeters:0, captured:0, identityVerified:0, readingVerified:0, approved:0, rejected:0, bills:0, collections:0, outstanding:0, arrears:0, pending:0 };

async function loadMetrics(): Promise<Metrics> {
  const [{ data: tenants }, { data: customers }, { data: meters }, { data: readings }, { data: bills }, { data: payments }] = await Promise.all([
    supabase.from("tenants").select("id,name,project_name"),
    supabase.from("customers").select("id"),
    supabase.from("meters").select("id,status"),
    supabase.from("water_readings").select("id,status,identity_verified,reading_verified,capture_source"),
    supabase.from("water_bills").select("id,total,arrears,status"),
    supabase.from("payments").select("bill_id,amount,status"),
  ]);
  const tenant = tenants?.find((t) => t.project_name === "مشروع مياه المسراخ") ?? tenants?.[0];
  const approvedPayments = (payments ?? []).filter((p) => p.status === "approved");
  const paidByBill = new Map<string, number>();
  for (const p of approvedPayments) paidByBill.set(p.bill_id, (paidByBill.get(p.bill_id) ?? 0) + Number(p.amount));
  const outstanding = (bills ?? []).reduce((sum,b) => sum + Math.max(0, Number(b.total)-Number(paidByBill.get(b.id) ?? 0)),0);
  return {
    projectName: tenant?.project_name ?? tenant?.name ?? "مشروع مياه المسراخ",
    customers: customers?.length ?? 0,
    activeMeters: (meters ?? []).filter((m) => m.status === "active").length,
    captured: readings?.length ?? 0,
    identityVerified: (readings ?? []).filter((r) => r.identity_verified).length,
    readingVerified: (readings ?? []).filter((r) => r.reading_verified).length,
    approved: (readings ?? []).filter((r) => r.status === "approved").length,
    rejected: (readings ?? []).filter((r) => r.status === "rejected").length,
    pending: (readings ?? []).filter((r) => r.status === "pending").length,
    bills: bills?.length ?? 0,
    collections: approvedPayments.reduce((s,p)=>s+Number(p.amount),0),
    outstanding,
    arrears: (bills ?? []).reduce((s,b)=>s+Number(b.arrears ?? 0),0),
  };
}

function Dashboard() {
  const { user } = useAuth(); const [m,setM]=useState<Metrics>(empty); const [loading,setLoading]=useState(true); const [error,setError]=useState<string|null>(null);
  const refresh = useCallback(async()=>{ try{ setError(null); setM(await loadMetrics()); }catch(e){ console.error(e); setError("تعذر تحديث مؤشرات قاعدة البيانات"); }finally{setLoading(false);} },[]);
  useEffect(()=>{void refresh(); const channel=supabase.channel("mizan-dashboard").on("postgres_changes",{event:"*",schema:"public",table:"water_readings"},()=>void refresh()).on("postgres_changes",{event:"*",schema:"public",table:"water_bills"},()=>void refresh()).on("postgres_changes",{event:"*",schema:"public",table:"payments"},()=>void refresh()).on("postgres_changes",{event:"*",schema:"public",table:"customers"},()=>void refresh()).on("postgres_changes",{event:"*",schema:"public",table:"meters"},()=>void refresh()).subscribe(); return()=>{void supabase.removeChannel(channel);};},[refresh]);
  const captureRate=m.captured?Math.round((m.identityVerified/m.captured)*100):0;
  const verifyRate=m.captured?Math.round((m.readingVerified/m.captured)*100):0;
  const cycle=new Intl.DateTimeFormat("ar-YE",{month:"long",year:"numeric"}).format(new Date());
  const nextCycle=new Intl.DateTimeFormat("ar-YE",{month:"long",year:"numeric"}).format(new Date(new Date().getFullYear(),new Date().getMonth()+1,1));
  return <div className="space-y-6">
    <div><h1 className="text-2xl md:text-3xl font-bold">لوحة التشغيل</h1><p className="text-sm text-muted-foreground mt-1">{m.projectName} — مؤشرات مرتبطة مباشرة بقاعدة البيانات</p></div>
    {error&&<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Stat title="المشتركون" value={m.customers} icon={<Users/>}/><Stat title="عدادات نشطة" value={m.activeMeters} icon={<Droplets/>}/><Stat title="القراءات الملتقطة" value={m.captured} icon={<Camera/>}/><Stat title="الفواتير" value={m.bills} icon={<Receipt/>}/>
    </div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Stat title="مطابقة هوية العداد" value={`${captureRate}%`} icon={<ShieldCheck/>}/><Stat title="تحقق القراءة" value={`${verifyRate}%`} icon={<ShieldCheck/>}/><Stat title="قراءات معلقة" value={m.pending} icon={<AlertTriangle/>}/><Stat title="قراءات مرفوضة" value={m.rejected} icon={<AlertTriangle/>}/>
    </div>
    <div className="grid md:grid-cols-4 gap-4">
      <Money title="التحصيل المعتمد" value={m.collections}/><Money title="الرصيد غير المحصل" value={m.outstanding}/><Money title="المتأخرات" value={m.arrears}/><div className="p-4 rounded-xl border bg-card"><div className="flex items-center gap-2 text-xs text-muted-foreground"><CalendarDays className="w-4 h-4"/>الدورة الحالية</div><div className="mt-2 font-bold">{cycle}</div><div className="text-xs text-muted-foreground mt-1">القادمة: {nextCycle}</div></div>
    </div>
    <Card><CardHeader><CardTitle>سلسلة التشغيل</CardTitle></CardHeader><CardContent><div className="grid md:grid-cols-6 gap-2 text-xs">
      {[['التقاط',m.captured],['هوية العداد',m.identityVerified],['تحقق القراءة',m.readingVerified],['اعتماد',m.approved],['إصدار فاتورة',m.bills],['التحصيل',fmtYER(m.collections)]].map(([label,value])=><div key={String(label)} className="rounded-lg border p-3"><div className="text-muted-foreground">{label}</div><div className="font-bold mt-1">{value}</div></div>)}
    </div><p className="text-xs text-muted-foreground mt-4">المؤشرات لا تعتمد على بيانات تجريبية محلية. بعد أي قراءة أو فاتورة أو تحصيل، يتم تحديثها تلقائياً عبر Realtime.</p></CardContent></Card>
    {loading&&<p className="text-xs text-muted-foreground">جارٍ تحميل المؤشرات من قاعدة البيانات…</p>}
  </div>;
}
function Stat({title,value,icon}:{title:string;value:number|string;icon:React.ReactNode}){return <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}<span>{title}</span></div><div className="mt-2 text-2xl font-bold">{value}</div></CardContent></Card>}
function Money({title,value}:{title:string;value:number}){return <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Wallet className="w-4 h-4"/><span>{title}</span></div><div className="mt-2 text-xl font-bold">{fmtYER(value)}</div></CardContent></Card>}
