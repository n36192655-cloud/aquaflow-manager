import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtYER } from "@/lib/pricing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Wallet, Check, X, CircleDollarSign, Smartphone, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { approvePayment, createPayment, listBills, listPayments, type DbBill, type DbPayment, listMetersAndCustomers, type DbCustomer } from "@/lib/authoritative";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/payments")({ head: () => ({ meta: [{ title: "التحصيل — ميزان" }] }), component: PaymentsPage });

function PaymentsPage() {
  const { user } = useAuth();
  const [payments, setPayments] = useState<DbPayment[]>([]);
  const [bills, setBills] = useState<DbBill[]>([]);
  const [customers, setCustomers] = useState<DbCustomer[]>([]);
  const [tab, setTab] = useState<"pending" | "approved" | "rejected">("pending");
  const [billId, setBillId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("نقدي");
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => { const [ps, bs, mc] = await Promise.all([listPayments(), listBills(), listMetersAndCustomers()]); setPayments(ps); setBills(bs); setCustomers(mc.customers); }, []);
  useEffect(() => { void load(); const channel = supabase.channel("payments-page").on("postgres_changes", { event: "*", schema: "public", table: "payments" }, () => void load()).on("postgres_changes", { event: "*", schema: "public", table: "water_bills" }, () => void load()).subscribe(); return () => { void supabase.removeChannel(channel); }; }, [load]);

  const list = useMemo(() => payments.filter(p => p.status === tab), [payments, tab]);
  const approved = payments.filter(p => p.status === "approved");
  const totals = { cash: approved.filter(p => p.method === "نقدي").reduce((a,p)=>a+Number(p.amount),0), bank: approved.filter(p => p.method !== "نقدي").reduce((a,p)=>a+Number(p.amount),0), total: approved.reduce((a,p)=>a+Number(p.amount),0), pending: payments.filter(p=>p.status === "pending").reduce((a,p)=>a+Number(p.amount),0) };
  const eligibleBills = bills.filter(b => b.status !== "cancelled");

  async function submitPayment() {
    if (!billId) return toast.error("اختر فاتورة");
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return toast.error("أدخل مبلغاً صحيحاً");
    setBusy(true);
    try { await createPayment({ billId, amount: value, method, clientId: crypto.randomUUID() }); toast.success("سُجلت الدفعة في دفتر المدفوعات وبانتظار اعتماد الإدارة"); setBillId(""); setAmount(""); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "تعذر تسجيل الدفعة"); }
    finally { setBusy(false); }
  }

  async function approve(id: string) { setBusy(true); try { await approvePayment(id); toast.success("تم اعتماد الدفعة وتحديث رصيد الفاتورة من الخادم"); await load(); } catch (e) { toast.error(e instanceof Error ? e.message : "تعذر اعتماد الدفعة"); } finally { setBusy(false); } }

  return <div className="space-y-6">
    <div className="flex items-start justify-between gap-3"><div><h1 className="text-2xl md:text-3xl font-bold">التحصيل</h1><p className="text-sm text-muted-foreground mt-1">دفتر المدفوعات الفعلي — لا تُحتسب الدفعة في مؤشرات التحصيل إلا بعد اعتمادها خادمياً.</p></div><Button variant="outline" onClick={() => void load()} disabled={busy}><RefreshCw className="w-4 h-4 ms-1"/> تحديث</Button></div>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3"><Stat label="نقدي معتمد" value={fmtYER(totals.cash)} icon={<Wallet className="w-5 h-5"/>}/><Stat label="تحويلات معتمدة" value={fmtYER(totals.bank)} icon={<Smartphone className="w-5 h-5"/>}/><Stat label="الإجمالي المعتمد" value={fmtYER(totals.total)} icon={<CircleDollarSign className="w-5 h-5"/>} highlight/><Stat label="بانتظار الاعتماد" value={fmtYER(totals.pending)} icon={<Wallet className="w-5 h-5"/>}/></div>
    <Card><CardHeader><CardTitle>تسجيل دفعة</CardTitle></CardHeader><CardContent className="grid md:grid-cols-4 gap-3 items-end"><div className="md:col-span-2"><Label>الفاتورة</Label><Select value={billId} onValueChange={setBillId}><SelectTrigger><SelectValue placeholder="اختر فاتورة"/></SelectTrigger><SelectContent>{eligibleBills.slice(0,200).map(b => { const c=customers.find(x=>x.id===b.customer_id); return <SelectItem key={b.id} value={b.id}>{c?.name ?? "مشترك"} — {fmtYER(Number(b.total))} — {b.status}</SelectItem>; })}</SelectContent></Select></div><div><Label>المبلغ</Label><Input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)}/></div><div><Label>الطريقة</Label><Select value={method} onValueChange={setMethod}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="نقدي">نقدي</SelectItem><SelectItem value="الكريمي">الكريمي</SelectItem></SelectContent></Select></div><Button className="md:col-start-4" onClick={()=>void submitPayment()} disabled={busy}>تسجيل الدفعة</Button></CardContent></Card>
    <div className="flex gap-2 flex-wrap">{(["pending","approved","rejected"] as const).map(t=><Button key={t} size="sm" variant={tab===t?"default":"outline"} onClick={()=>setTab(t)}>{t==="pending"?"بانتظار الاعتماد":t==="approved"?"معتمدة":"مرفوضة"}</Button>)}</div>
    <Card><CardHeader><CardTitle>{tab === "pending" ? "طلبات اعتماد الدفعات" : tab === "approved" ? "الدفعات المعتمدة" : "الدفعات المرفوضة"} ({list.length})</CardTitle></CardHeader><CardContent className="overflow-auto">{list.length===0?<p className="text-sm text-muted-foreground text-center py-8">لا يوجد.</p>:<Table><TableHeader><TableRow><TableHead>التاريخ</TableHead><TableHead>الفاتورة</TableHead><TableHead>المشترك</TableHead><TableHead>المبلغ</TableHead><TableHead>الطريقة</TableHead><TableHead>الحالة</TableHead>{tab==="pending"&&<TableHead/>}</TableRow></TableHeader><TableBody>{list.map(p=>{const b=bills.find(x=>x.id===p.bill_id);const c=customers.find(x=>x.id===b?.customer_id);return <TableRow key={p.id}><TableCell className="text-xs">{new Date(p.created_at).toLocaleString("ar-YE")}</TableCell><TableCell className="font-mono text-[11px]">{p.bill_id}</TableCell><TableCell>{c?.name??"—"}</TableCell><TableCell className="font-semibold">{fmtYER(Number(p.amount))}</TableCell><TableCell><Badge variant="outline">{p.method}</Badge></TableCell><TableCell><Badge variant={p.status==="approved"?"outline":p.status==="rejected"?"destructive":"secondary"}>{p.status}</Badge></TableCell>{tab==="pending"&&<TableCell>{isAdmin?<Button size="sm" onClick={()=>void approve(p.id)} disabled={busy}><Check className="w-3 h-3 ms-1"/> اعتماد</Button>:<span className="text-xs text-muted-foreground">بانتظار الإدارة</span>}</TableCell>}</TableRow>})}</TableBody></Table>}</CardContent></Card>
  </div>;
}
function Stat({label,value,icon,highlight}:{label:string;value:string;icon:React.ReactNode;highlight?:boolean}){return <Card className={highlight?"border-primary/40 bg-primary/5":""}><CardContent className="p-4 flex items-center justify-between"><div><div className="text-xs text-muted-foreground">{label}</div><div className="text-lg font-bold mt-1">{value}</div></div><div className="w-10 h-10 rounded-xl bg-muted/40 grid place-items-center">{icon}</div></CardContent></Card>;}
