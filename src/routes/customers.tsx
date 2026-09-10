import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, RefreshCw, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/customers")({ head: () => ({ meta: [{ title: "المشتركون — ميزان" }] }), component: CustomersPage });
type Customer = { id: string; name: string; phone: string | null; address: string | null; pay_account: string | null; status: string; created_at: string };
function CustomersPage() {
  const { user } = useAuth(); const [customers,setCustomers]=useState<Customer[]>([]); const [q,setQ]=useState(""); const [open,setOpen]=useState(false); const [name,setName]=useState(""); const [phone,setPhone]=useState(""); const [address,setAddress]=useState(""); const [payAccount,setPayAccount]=useState(""); const [busy,setBusy]=useState(false);
  async function load(){ if(!user?.tenantId)return; const {data,error}=await supabase.from("customers").select("id,name,phone,address,pay_account,status,created_at").eq("tenant_id",user.tenantId).order("created_at",{ascending:false}); if(error)throw error; setCustomers((data??[]) as Customer[]); }
  useEffect(()=>{void load().catch(e=>toast.error(`تعذر تحميل المشتركين: ${e.message}`));},[user?.tenantId]);
  const filtered=customers.filter(c=>`${c.name} ${c.phone??""} ${c.address??""} ${c.pay_account??""}`.toLowerCase().includes(q.toLowerCase()));
  async function create(){if(!name.trim())return toast.error("اسم المشترك مطلوب");setBusy(true);try{const {error}=await supabase.rpc("create_customer",{p_name:name.trim(),p_phone:phone.trim()||null,p_address:address.trim()||null,p_pay_account:payAccount.trim()||null});if(error)throw error;toast.success("تم تسجيل المشترك في قاعدة البيانات");setName("");setPhone("");setAddress("");setPayAccount("");setOpen(false);await load();}catch(e){toast.error(`فشل إنشاء المشترك: ${(e as Error).message}`)}finally{setBusy(false)}}
  async function deactivate(id:string){if(!window.confirm("إيقاف المشترك؟ لن تُحذف الفواتير والقراءات السابقة."))return;setBusy(true);try{const {error}=await supabase.rpc("deactivate_customer",{p_customer_id:id});if(error)throw error;toast.success("تم إيقاف المشترك");await load()}catch(e){toast.error(`فشل الإيقاف: ${(e as Error).message}`)}finally{setBusy(false)}}
  return <div className="space-y-6" dir="rtl"><div className="flex items-start justify-between gap-3"><div><h1 className="text-2xl md:text-3xl font-bold">المشتركون</h1><p className="text-sm text-muted-foreground mt-1">السجل الحقيقي للمشتركين في قاعدة البيانات الحالية.</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={()=>void load()}><RefreshCw className="w-4 h-4 ms-1"/> تحديث</Button><Button onClick={()=>setOpen(true)}><Plus className="w-4 h-4 ms-1"/> إضافة مشترك</Button></div></div>
    <div className="flex items-center gap-2"><Search className="w-4 h-4 text-muted-foreground"/><Input value={q} onChange={e=>setQ(e.target.value)} placeholder="بحث بالاسم أو الهاتف أو العنوان"/></div>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Users className="h-5 w-5"/> السجل ({filtered.length})</CardTitle></CardHeader><CardContent className="overflow-auto">{filtered.length===0?<p className="py-8 text-center text-sm text-muted-foreground">لا توجد نتائج.</p>:<table className="w-full text-sm"><thead><tr className="border-b text-right"><th className="p-2">الاسم</th><th className="p-2">الهاتف</th><th className="p-2">العنوان</th><th className="p-2">حساب السداد</th><th className="p-2">الحالة</th><th className="p-2"></th></tr></thead><tbody>{filtered.map(c=><tr key={c.id} className="border-b"><td className="p-2 font-medium">{c.name}</td><td className="p-2">{c.phone??"—"}</td><td className="p-2">{c.address??"—"}</td><td className="p-2 font-mono">{c.pay_account??"—"}</td><td className="p-2"><Badge variant={c.status==="active"?"default":"secondary"}>{c.status==="active"?"فعّال":"موقوف"}</Badge></td><td className="p-2">{c.status==="active"&&<Button size="sm" variant="outline" onClick={()=>void deactivate(c.id)} disabled={busy}>إيقاف</Button>}</td></tr>)}</tbody></table>}</CardContent></Card>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>إضافة مشترك حقيقي</DialogTitle></DialogHeader><div className="space-y-3"><div><Label>الاسم</Label><Input value={name} onChange={e=>setName(e.target.value)}/></div><div><Label>الهاتف</Label><Input value={phone} onChange={e=>setPhone(e.target.value)}/></div><div><Label>العنوان</Label><Input value={address} onChange={e=>setAddress(e.target.value)}/></div><div><Label>حساب السداد (اختياري)</Label><Input value={payAccount} onChange={e=>setPayAccount(e.target.value)}/></div></div><DialogFooter><Button variant="outline" onClick={()=>setOpen(false)}>إلغاء</Button><Button onClick={()=>void create()} disabled={busy}>{busy?"جاري الحفظ...":"حفظ"}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
