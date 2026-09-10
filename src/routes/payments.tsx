import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Check, X, RefreshCw, Wallet, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { approveWaterPayment, rejectWaterPayment } from "@/lib/field-ops";
import { fmtYER } from "@/lib/pricing";

export const Route = createFileRoute("/payments")({
  head: () => ({ meta: [{ title: "التحصيل — ميزان" }] }),
  component: PaymentsPage,
});

type Payment = { id: string; bill_id: string; amount: number; status: string; method: string; collector_id: string | null; created_at: string; review_reason: string | null };
type Bill = { id: string; customer_id: string; total: number; status: string };
type Customer = { id: string; name: string };

function PaymentsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [payments, setPayments] = useState<Payment[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [tab, setTab] = useState<"pending" | "approved" | "rejected">("pending");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!user?.tenantId) return;
    const [p, b, c] = await Promise.all([
      supabase.from("payments").select("id,bill_id,amount,status,method,collector_id,created_at,review_reason").eq("tenant_id", user.tenantId).order("created_at", { ascending: false }),
      supabase.from("water_bills").select("id,customer_id,total,status").eq("tenant_id", user.tenantId),
      supabase.from("customers").select("id,name").eq("tenant_id", user.tenantId),
    ]);
    const error = [p, b, c].find((x) => x.error)?.error;
    if (error) throw error;
    setPayments((p.data ?? []) as Payment[]); setBills((b.data ?? []) as Bill[]); setCustomers((c.data ?? []) as Customer[]);
  }

  useEffect(() => {
    void load().catch((error) => toast.error(`تعذر تحميل التحصيل: ${error.message}`));
    const channel = supabase.channel(`mizan-payments-${user?.tenantId ?? "none"}`).on("postgres_changes", { event: "*", schema: "public", table: "payments", filter: `tenant_id=eq.${user?.tenantId ?? ""}` }, () => void load()).on("postgres_changes", { event: "*", schema: "public", table: "water_bills", filter: `tenant_id=eq.${user?.tenantId ?? ""}` }, () => void load()).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [user?.tenantId]);

  const list = useMemo(() => payments.filter((p) => p.status === tab), [payments, tab]);
  const approvedTotal = payments.filter((p) => p.status === "approved").reduce((sum, p) => sum + Number(p.amount), 0);
  const pendingTotal = payments.filter((p) => p.status === "pending").reduce((sum, p) => sum + Number(p.amount), 0);

  async function approve(id: string) {
    setBusy(true);
    try { await approveWaterPayment(id); toast.success("تم اعتماد الدفعة وإعادة احتساب رصيد الفاتورة من سجل الدفعات"); await load(); }
    catch (error) { toast.error(`فشل اعتماد الدفعة: ${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function reject(id: string) {
    const reason = window.prompt("سبب رفض الدفعة (مطلوب)")?.trim();
    if (!reason) return;
    setBusy(true);
    try { await rejectWaterPayment(id, reason); toast.info("تم رفض الدفعة وتسجيل السبب"); await load(); }
    catch (error) { toast.error(`فشل رفض الدفعة: ${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  return <div className="space-y-6">
    <div className="flex items-start justify-between"><div><h1 className="text-2xl md:text-3xl font-bold">التحصيل</h1><p className="text-sm text-muted-foreground mt-1">الدفعة لا تصبح تحصيلاً فعلياً إلا بعد اعتمادها من الإدارة.</p></div><Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="w-4 h-4 ms-1"/> تحديث</Button></div>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3"><Stat label="تحصيل معتمد" value={fmtYER(approvedTotal)}/><Stat label="معلّق" value={fmtYER(pendingTotal)}/><Stat label="عدد الدفعات" value={String(payments.length)}/></div>
    {payments.length === 0 && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 flex gap-2"><AlertCircle className="w-5 h-5"/> لا توجد دفعات حقيقية مسجلة حالياً.</div>}
    <div className="flex gap-2">{(["pending","approved","rejected"] as const).map((t) => <Button key={t} size="sm" variant={tab === t ? "default" : "outline"} onClick={() => setTab(t)}>{t === "pending" ? "بانتظار الاعتماد" : t === "approved" ? "معتمدة" : "مرفوضة"}</Button>)}</div>
    <Card><CardHeader><CardTitle>{tab === "pending" ? "طلبات اعتماد الدفعات" : tab === "approved" ? "الدفعات المعتمدة" : "الدفعات المرفوضة"} ({list.length})</CardTitle></CardHeader><CardContent className="overflow-auto"><Table><TableHeader><TableRow><TableHead className="text-right">التاريخ</TableHead><TableHead className="text-right">المشترك</TableHead><TableHead className="text-right">الفاتورة</TableHead><TableHead className="text-right">المبلغ</TableHead><TableHead className="text-right">الطريقة</TableHead><TableHead className="text-right">الحالة</TableHead>{tab === "pending" && isAdmin && <TableHead className="text-right">إجراء</TableHead>}</TableRow></TableHeader><TableBody>{list.map((payment) => { const bill = bills.find((b) => b.id === payment.bill_id); const customer = customers.find((c) => c.id === bill?.customer_id); return <TableRow key={payment.id}><TableCell className="text-xs">{new Date(payment.created_at).toLocaleString("ar-YE")}</TableCell><TableCell>{customer?.name ?? "—"}</TableCell><TableCell className="font-mono text-xs">{payment.bill_id}</TableCell><TableCell className="font-semibold">{fmtYER(payment.amount)}</TableCell><TableCell><Badge variant="outline">{payment.method === "cash" ? "نقدي" : "تحويل بنكي مسجل"}</Badge></TableCell><TableCell><Badge variant={payment.status === "approved" ? "default" : payment.status === "rejected" ? "destructive" : "secondary"}>{payment.status === "approved" ? "معتمدة" : payment.status === "rejected" ? "مرفوضة" : "معلقة"}</Badge>{payment.review_reason && <div className="text-xs text-destructive mt-1">{payment.review_reason}</div>}</TableCell>{tab === "pending" && isAdmin && <TableCell><div className="flex gap-1"><Button size="sm" onClick={() => void approve(payment.id)} disabled={busy}><Check className="w-3 h-3 ms-1"/> اعتماد</Button><Button size="sm" variant="destructive" onClick={() => void reject(payment.id)} disabled={busy}><X className="w-3 h-3 ms-1"/> رفض</Button></div></TableCell>}</TableRow>; })}</TableBody></Table></CardContent></Card>
  </div>;
}

function Stat({ label, value }: { label: string; value: string }) { return <Card><CardContent className="p-4 flex items-center justify-between"><div><div className="text-xs text-muted-foreground">{label}</div><div className="text-lg font-bold mt-1">{value}</div></div><Wallet className="w-5 h-5 text-muted-foreground"/></CardContent></Card>; }
