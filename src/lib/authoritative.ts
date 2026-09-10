import { supabase } from "./supabase";

export type DbMeter = {
  id: string;
  customer_id: string;
  serial_number: string;
  status: string;
  profile_id: string | null;
};

export type DbCustomer = {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  pay_account: string | null;
  status: string;
};

export type DbReading = {
  id: string;
  customer_id: string | null;
  meter_id: string | null;
  meter_number: string;
  previous: number;
  current_reading: number;
  consumption: number;
  photo_url: string | null;
  lat: number | null;
  lng: number | null;
  capture_source: string;
  ocr_serial: string | null;
  ocr_confidence: number | null;
  identity_verified: boolean;
  reading_verified: boolean;
  flag: string;
  status: string;
  reader_id: string | null;
  created_at: string;
};

export type DbBill = {
  id: string;
  customer_id: string;
  reading_id: string | null;
  subtotal: number;
  arrears: number;
  total: number;
  status: string;
  issued_at: string;
  project_name: string | null;
  client_id: string | null;
};

export type DbPayment = {
  id: string;
  tenant_id: string;
  bill_id: string;
  amount: number;
  method: string;
  status: string;
  collector_id: string | null;
  created_at: string;
  client_id: string | null;
};

const db = supabase as any;

export async function listMetersAndCustomers() {
  const [{ data: meters, error: metersError }, { data: customers, error: customersError }] = await Promise.all([
    supabase.from("meters").select("id,customer_id,serial_number,status,profile_id").eq("status", "active").order("serial_number"),
    supabase.from("customers").select("id,name,phone,address,pay_account,status").eq("status", "active").order("name"),
  ]);
  if (metersError) throw metersError;
  if (customersError) throw customersError;
  return { meters: (meters ?? []) as DbMeter[], customers: (customers ?? []) as DbCustomer[] };
}

export async function getLatestApprovedReading(meterId: string) {
  const { data, error } = await supabase
    .from("water_readings")
    .select("id,current_reading,consumption,created_at,status")
    .eq("meter_id", meterId)
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function recordReading(input: {
  meterId: string;
  current: number;
  photoUrl?: string;
  captureSource: "camera" | "manual" | "offline";
  ocrSerial?: string;
  ocrConfidence?: number;
  ocrRawText?: string;
  clientId: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
}) {
  if (!Number.isFinite(input.current) || input.current < 0) throw new Error("القراءة الحالية غير صالحة");
  if (!input.clientId) throw new Error("معرّف العملية مطلوب");
  const { data, error } = await db.rpc("record_water_reading", {
    p_meter_id: input.meterId,
    p_current: input.current,
    p_photo_url: input.photoUrl ?? null,
    p_capture_source: input.captureSource,
    p_ocr_serial: input.ocrSerial ?? null,
    p_ocr_confidence: input.ocrConfidence ?? null,
    p_ocr_raw_text: input.ocrRawText ?? null,
    p_client_id: input.clientId,
    p_lat: input.lat ?? null,
    p_lng: input.lng ?? null,
    p_accuracy: input.accuracy ?? null,
  });
  if (error) throw error;
  return (data?.[0] ?? data) as {
    reading_id: string;
    bill_id: string;
    previous: number;
    current_reading: number;
    consumption: number;
    bill_total: number;
    arrears: number;
    project_name: string;
  };
}

export async function listReadings(limit = 200) {
  const { data, error } = await supabase
    .from("water_readings")
    .select("id,customer_id,meter_id,meter_number,previous,current_reading,consumption,photo_url,lat,lng,capture_source,ocr_serial,ocr_confidence,identity_verified,reading_verified,flag,status,reader_id,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as DbReading[];
}

export async function listBills(limit = 200) {
  const { data, error } = await supabase
    .from("water_bills")
    .select("id,customer_id,reading_id,subtotal,arrears,total,status,issued_at,project_name,client_id")
    .order("issued_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as DbBill[];
}

export async function listPayments(limit = 200) {
  const { data, error } = await supabase
    .from("payments")
    .select("id,tenant_id,bill_id,amount,method,status,collector_id,created_at,client_id")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as DbPayment[];
}

export async function createPayment(input: { billId: string; amount: number; method: string; clientId: string }) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("مبلغ الدفع غير صالح");
  if (!input.clientId) throw new Error("معرّف عملية الدفع مطلوب");
  const { data: profile, error: profileError } = await supabase.auth.getUser();
  if (profileError || !profile.user) throw new Error("جلسة المستخدم غير صالحة");

  const { data: bill, error: billError } = await supabase.from("water_bills").select("id,total,tenant_id,status").eq("id", input.billId).maybeSingle();
  if (billError) throw billError;
  if (!bill) throw new Error("الفاتورة غير موجودة أو غير متاحة للمشروع الحالي");
  if (bill.status === "paid") throw new Error("الفاتورة مسددة بالكامل");

  const { data, error } = await supabase
    .from("payments")
    .insert({ bill_id: input.billId, amount: input.amount, method: input.method, status: "pending", collector_id: profile.user.id, client_id: input.clientId })
    .select("id,tenant_id,bill_id,amount,method,status,collector_id,created_at,client_id")
    .single();
  if (error) throw error;
  return data as DbPayment;
}

export async function approvePayment(paymentId: string) {
  const { data, error } = await db.rpc("approve_water_payment", { p_payment_id: paymentId });
  if (error) throw error;
  return data;
}

export async function rejectPayment(paymentId: string) {
  const { data, error } = await supabase.from("payments").update({ status: "rejected" }).eq("id", paymentId).eq("status", "pending").select("id,status").single();
  if (error) throw error;
  return data;
}
