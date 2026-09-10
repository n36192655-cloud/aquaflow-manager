import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtYER } from "@/lib/pricing";
import { Wallet, Printer, RefreshCw, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { newClientId, recordWaterPayment } from "@/lib/field-ops";

export const Route = createFileRoute("/bills")({
  head: () => ({ meta: [{ title: "الفواتير — ميزان" }] }),
  component: BillsPage,
});

type Customer = { id: string; name: string; phone: string | null };
type Meter = { id: string; customer_id: string; serial_number: string };
type Reading = { id: string; meter_id: string | null; previous: number; current_reading: number; consumption: number; status: string };
type Bill = { id: string; customer_id: string; reading_id: string | null; subtotal: number; arrears: number; total: number; status: string; issued_at: string };
type Payment = { id: string; bill_id: string; amount: number; status: string; method: string; created_at: string };

function BillsPage() {
  const { user } = useAuth();
  const [bills, setBills] = useState<Bill[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [meters, setMeters] = useState<Meter[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [tab, setTab] = useState<"all" | "unpaid" | "paid">("all");
  const [payFor, setPayFor] = useState<Bill | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "bank_transfer">("cash");
  const [printBill, setPrintBill] = useState<Bill | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!user?.tenantId) return;
    const [b, c, m, r, p] = await Promise.all([
      supabase.from("water_bills").select("id,customer_id,reading_id,subtotal,arrears,total,status,issued_at").eq("tenant_id", user.tenantId).order("issued_at", { ascending: false }),
      supabase.from("customers").select("id,name,phone").eq("tenant_id", user.tenantId),
      supabase.from("meters").select("id,customer_id,serial_number").eq("tenant_id", user.tenantId),
      supabase.from("water_readings").select("id,meter_id,previous,current_reading,consumption,status").eq("tenant_id", user.tenantId),
      supabase.from("payments").select("id,bill_id,amount,status,method,created_at").eq("tenant_id", user.tenantId).order("created_at", { ascending: false }),
    ]);
    const error = [b, c, m, r, p].find((x) => x.error)?.error;
    if (error) throw error;
    setBills((b.data ?? []) as Bill[]); setCustomers((c.data ?? []) as Customer[]); setMeters((m.data ?? []) as Meter[]); setReadings((r.data ?? []) as Reading[]); setPayments((p.data ?? []) as Payment[]);
  }

  useEffect(() => {
    void load().catch((error) => toast.error(`تعذر تحميل الفواتير: ${error.message}`));
    const channel = supabase.channel(`mizan-bills-${user?.tenantId ?? "none"}`).on("postgres_changes", { event: "*", schema: "public", table: "water_bills", filter: `tenant_id=eq.${user?.tenantId ?? ""}` }, () => void load()).on("postgres_changes", { event: "*", schema: "public", table: "payments", filter: `tenant_id=eq.${user?.tenantId ?? ""}` }, () => void load()).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [user?.tenantId]);

  const filtered = bills.filter((bill) => tab === "all" || (tab === "paid" ? bill.status === "paid" : bill.status !== "paid"));
  const remainingFor = (bill: Bill) => Math.max(0, bill.total - payments.filter((p) => p.bill_id === bill.id && p.status === "approved").reduce((sum, p) => sum + Number(p.amount), 0) - payments.filter((p) => p.bill_id === bill.id && p.status === "pending").reduce((sum, p) => sum + Number(p.amount), 0));

  async function submitPayment() {
    if (!payFor || !user?.userId) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return toast.error("المبلغ غير صالح");
    const remaining = remainingFor(payFor);
    if (value > remaining) return toast.error("المبلغ يتجاوز الرصيد المتبقي");
    setBusy(true);
    try {
      await recordWaterPayment({ billId: payFor.id, amount: value, method, clientId: newClientId("payment") });
      toast.success("تم تسجيل الدفعة بحالة معلقة؛ لم تُحتسب كتحصيل حتى اعتماد الإدارة");
      setPayFor(null); setAmount(""); await load();
    } catch (error) { toast.error(`رفض الخادم الدفعة: ${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  return <div className="space-y-6">
    <div className="flex items-start justify-between"><div><h1 className="text-2xl md:text-3xl font-bold">الفواتير</h1><p className="text-sm text-muted-foreground mt-1">الفاتورة تُنشأ فقط عند اعتماد القراءة من الإدارة.</p></div><Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="w-4 h-4 ms-1"/> تحديث</Button></div>
    {bills.length === 0 && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 flex gap-2"><AlertCircle className="w-5 h-5"/> لا توجد فواتير في قاعدة البيانات ضمن المشروع الحالي. لن يتم إنشاء فواتير وهمية.</div>}
    <div className="flex gap-2">{(["all","unpaid","paid"] as const).map((t) => <Button key={t} size="sm" variant={tab === t ? "default" : "outline"} onClick={() => setTab(t)}>{t === "all" ? "الكل" : t === "unpaid" ? "غير مدفوعة" : "مدفوعة"}</Button>)}</div>
    <Card><CardContent className="p-4 overflow-auto"><table className="w-full text-sm"><thead><tr className="border-b text-right"><th className="p-2">المشترك</th><th className="p-2">العداد</th><th className="p-2">التاريخ</th><th className="p-2">الاستهلاك</th><th className="p-2">متأخرات</th><th className="p-2">الإجمالي</th><th className="p-2">الحالة</th><th className="p-2"></th></tr></thead><tbody>{filtered.map((bill) => { const customer = customers.find((c) => c.id === bill.customer_id); const reading = readings.find((r) => r.id === bill.reading_id); const meter = reading?.meter_id ? meters.find((m) => m.id === reading.meter_id) : undefined; const remaining = remainingFor(bill); return <tr key={bill.id} className="border-b"><td className="p-2 font-medium">{customer?.name ?? "—"}</td><td className="p-2 font-mono">{meter?.serial_number ?? "—"}</td><td className="p-2 text-xs">{new Date(bill.issued_at).toLocaleDateString("ar-YE")}</td><td className="p-2">{reading?.consumption ?? "—"} م³</td><td className="p-2">{bill.arrears ? fmtYER(bill.arrears) : "—"}</td><td className="p-2 font-bold">{fmtYER(bill.total)}</td><td className="p-2"><Badge variant={bill.status === "paid" ? "default" : bill.status === "partial" ? "secondary" : "destructive"}>{bill.status === "paid" ? "مدفوعة" : bill.status === "partial" ? `جزئية · ${fmtYER(remaining)}` : "غير مدفوعة"}</Badge></td><td className="p-2"><div className="flex gap-1">{bill.status !== "paid" && <Button size="sm" onClick={() => { setPayFor(bill); setAmount(String(remaining)); setMethod("cash"); }}><Wallet className="w-3 h-3 ms-1"/> تسجيل دفعة</Button>}<Button size="sm" variant="outline" onClick={() => setPrintBill(bill)}><Printer className="w-3 h-3"/></Button></div></td></tr>; })}</tbody></table></CardContent></Card>

    <Dialog open={payFor !== null} onOpenChange={(open) => !open && setPayFor(null)}><DialogContent><DialogHeader><DialogTitle>تسجيل دفعة — بانتظار اعتماد الإدارة</DialogTitle></DialogHeader><div className="space-y-3"><div><Label>المبلغ</Label><Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}/></div><div><Label>طريقة الدفع</Label><Select value={method} onValueChange={(value: "cash" | "bank_transfer") => setMethod(value)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="cash">نقدي</SelectItem><SelectItem value="bank_transfer">تحويل بنكي — تسجيل يدوي</SelectItem></SelectContent></Select></div><p className="text-xs text-muted-foreground">لا يوجد في هذا المسار تكامل مصرفي حي. «تحويل بنكي» يعني تسجيل عملية التحويل وإرفاق اعتمادها داخل النظام، وليس تأكيداً آلياً من بنك.</p></div><DialogFooter><Button variant="outline" onClick={() => setPayFor(null)}>إلغاء</Button><Button onClick={() => void submitPayment()} disabled={busy}>{busy ? "جاري التسجيل..." : "تسجيل الدفعة"}</Button></DialogFooter></DialogContent></Dialog>
    {printBill && <PrintDialog bill={printBill} customer={customers.find((c) => c.id === printBill.customer_id)} reading={readings.find((r) => r.id === printBill.reading_id)} meter={readings.find((r) => r.id === printBill.reading_id)?.meter_id ? meters.find((m) => m.id === readings.find((r) => r.id === printBill.reading_id)?.meter_id) : undefined} onClose={() => setPrintBill(null)}/>} 
  </div>;
}

function PrintDialog({ bill, customer, reading, meter, onClose }: { bill: Bill; customer?: Customer; reading?: Reading; meter?: Meter; onClose: () => void }) {
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>فاتورة مياه</DialogTitle></DialogHeader><div className="border rounded-lg p-5 space-y-4 bg-white text-slate-900"><div className="text-center border-b pb-3"><div className="text-2xl font-bold">ميزان</div><div className="text-xs text-slate-500">فاتورة صادرة من السجل المحاسبي للنظام</div><div className="font-mono text-xs mt-1">{bill.id}</div></div><div className="grid grid-cols-2 gap-3 text-sm"><div><div className="text-xs text-slate-500">المشترك</div>{customer?.name ?? "—"}</div><div><div className="text-xs text-slate-500">رقم العداد</div><span className="font-mono">{meter?.serial_number ?? "—"}</span></div><div><div className="text-xs text-slate-500">القراءة السابقة</div>{reading?.previous ?? "—"}</div><div><div className="text-xs text-slate-500">القراءة الحالية</div>{reading?.current_reading ?? "—"}</div><div><div className="text-xs text-slate-500">الاستهلاك</div>{reading?.consumption ?? "—"} م³</div><div><div className="text-xs text-slate-500">تاريخ الإصدار</div>{new Date(bill.issued_at).toLocaleString("ar-YE")}</div></div><div className="border-t pt-3 space-y-1"><div className="flex justify-between"><span>الاستهلاك</span><span>{fmtYER(bill.subtotal)}</span></div><div className="flex justify-between"><span>متأخرات</span><span>{fmtYER(bill.arrears)}</span></div><div className="flex justify-between font-bold text-lg border-t pt-2"><span>الإجمالي</span><span>{fmtYER(bill.total)}</span></div></div></div><DialogFooter><Button onClick={() => window.print()}>طباعة</Button><Button variant="outline" onClick={onClose}>إغلاق</Button></DialogFooter></DialogContent></Dialog>;
}
