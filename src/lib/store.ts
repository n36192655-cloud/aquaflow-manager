import { create } from "zustand";
import { persist } from "zustand/middleware";
import { calcConsumption, priceFor, type MeterType } from "./pricing";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Customer {
  id: number;
  name: string;
  phone: string;
  city: string;
  directorate?: string;
  address?: string;
  pay_account: string;
  status?: "active" | "pending" | "rejected";
  submitted_by?: string;
  submitted_at?: string;
}
export interface Meter {
  id: number;
  customer_id: number;
  number: string;
  type: MeterType;
  status: "active" | "inactive" | "pending";
  photo?: string;
}
export interface Reading {
  id: number;
  serial: string;
  meter_id: number;
  previous: number;
  current: number;
  consumption: number;
  date: string;
  flag: "ok" | "suspicious" | "error";
  status: ApprovalStatus;
  photo?: string;
  ocr_serial?: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  by?: string;
}
export interface Bill {
  id: number;
  serial: string;
  customer_id: number;
  meter_id: number;
  reading_id: number;
  subtotal: number;
  arrears: number;
  total: number;
  status: "unpaid" | "paid" | "partial";
  date: string;
  photo?: string;
}
export type PaymentMethod = "نقدي" | "الكريمي";
export interface Payment {
  id: number;
  bill_id: number;
  amount: number;
  method: PaymentMethod | string;
  date: string;
  status: ApprovalStatus;
  by?: string;
}
export interface ProductionLog {
  id: number;
  type: MeterType;
  units: number;
  date: string;
  note?: string;
  photo?: string;
}

export function payAccountFor(id: number): string {
  return `KRM-YE-${String(id).padStart(6, "0")}`;
}

function dayStamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
function nextSerial(prefix: string, id: number): string {
  return `${prefix}-${dayStamp()}-${String(id).padStart(4, "0")}`;
}

const DIRECTORATES = [
  "المظفر", "القاهرة", "صالة", "المعافر", "الشمايتين", "المسراخ", "جبل حبشي", "أخرى",
];
export const TAIZ_DIRECTORATES = DIRECTORATES;

const CUSTOMERS_BASE: Omit<Customer, "pay_account">[] = [
  { id: 1,  name: "أحمد علي عبدالله",     phone: "777000001", city: "تعز", directorate: "المظفر" },
  { id: 2,  name: "محمد سالم أحمد",       phone: "777000002", city: "تعز", directorate: "القاهرة" },
  { id: 3,  name: "خالد حسن صالح",        phone: "777000003", city: "تعز", directorate: "صالة" },
  { id: 4,  name: "علي عبد الكريم",       phone: "777000004", city: "تعز", directorate: "المظفر" },
  { id: 5,  name: "سعيد محمد عبدالله",    phone: "777000005", city: "تعز", directorate: "المعافر" },
  { id: 6,  name: "حسن يحيى قاسم",        phone: "777000006", city: "تعز", directorate: "الشمايتين" },
  { id: 7,  name: "فهد أحمد منصور",       phone: "777000007", city: "تعز", directorate: "القاهرة" },
  { id: 8,  name: "ناصر علي سعيد",        phone: "777000008", city: "تعز", directorate: "المسراخ" },
  { id: 9,  name: "ياسر سالم محمد",       phone: "777000009", city: "تعز", directorate: "صالة" },
  { id: 10, name: "عبدالكريم حسن",        phone: "777000010", city: "تعز", directorate: "المظفر" },
  { id: 11, name: "صالح قاسم علي",        phone: "777000011", city: "تعز", directorate: "جبل حبشي" },
  { id: 12, name: "مروان جميل أحمد",      phone: "777000012", city: "تعز", directorate: "القاهرة" },
  { id: 13, name: "إبراهيم سعيد محمد",    phone: "777000013", city: "تعز", directorate: "صالة" },
  { id: 14, name: "أمين صالح عبدالله",    phone: "777000014", city: "تعز", directorate: "المعافر" },
  { id: 15, name: "جمال حسن علي",         phone: "777000015", city: "تعز", directorate: "المظفر" },
  { id: 16, name: "رائد محمد سالم",       phone: "777000016", city: "تعز", directorate: "الشمايتين" },
  { id: 17, name: "بدر علي أحمد",         phone: "777000017", city: "تعز", directorate: "القاهرة" },
  { id: 18, name: "أنور سالم قاسم",       phone: "777000018", city: "تعز", directorate: "المسراخ" },
  { id: 19, name: "وليد أحمد حسن",        phone: "777000019", city: "تعز", directorate: "صالة" },
  { id: 20, name: "ماجد قاسم عبدالله",    phone: "777000020", city: "تعز", directorate: "المظفر" },
];
const CUSTOMERS_SEED: Customer[] = CUSTOMERS_BASE.map((c) => ({
  ...c,
  pay_account: payAccountFor(c.id),
  status: "active",
}));

const METERS_SEED: Meter[] = Array.from({ length: 20 }, (_, i) => {
  const id = i + 1;
  const type: MeterType = id % 2 === 1 ? "water" : "electric";
  const prefix = type === "water" ? "W" : "E";
  return { id, customer_id: id, number: `${prefix}-${1000 + id}`, type, status: "active" };
});

const READ_PAIRS: Array<[number, number]> = [
  [100, 135], [200, 250], [150, 180], [300, 420], [80, 112],
  [500, 640], [220, 265], [410, 560], [90, 130], [350, 470],
  [175, 210], [280, 395], [60, 92], [430, 590], [140, 185],
  [320, 445], [110, 150], [260, 380], [95, 128], [370, 510],
];

function seedReadings(): Reading[] {
  const arr: Reading[] = [];
  let id = 1;
  const now = new Date();
  const m1 = new Date(now.getFullYear(), now.getMonth() - 1, 5).toISOString();
  const m2 = new Date(now.getFullYear(), now.getMonth(), 5).toISOString();
  METERS_SEED.forEach((m, idx) => {
    const [prev, curr] = READ_PAIRS[idx];
    const id1 = id++;
    arr.push({ id: id1, serial: nextSerial("RD", id1), meter_id: m.id, previous: 0, current: prev, consumption: prev, date: m1, flag: "ok", status: "approved" });
    const id2 = id++;
    arr.push({ id: id2, serial: nextSerial("RD", id2), meter_id: m.id, previous: prev, current: curr, consumption: curr - prev, date: m2, flag: "ok", status: "approved" });
  });
  return arr;
}

function seedBills(readings: Reading[]): Bill[] {
  const bills: Bill[] = [];
  let id = 1;
  const byMeter = new Map<number, Reading>();
  for (const r of readings) {
    const prev = byMeter.get(r.meter_id);
    if (!prev || new Date(r.date) > new Date(prev.date)) byMeter.set(r.meter_id, r);
  }
  for (const [meterId, r] of byMeter) {
    const meter = METERS_SEED.find((m) => m.id === meterId)!;
    const subtotal = priceFor(meter.type, r.consumption);
    const bid = id++;
    bills.push({
      id: bid, serial: nextSerial("INV", bid),
      customer_id: meter.customer_id, meter_id: meterId, reading_id: r.id,
      subtotal, arrears: 0, total: subtotal,
      status: bid % 3 === 0 ? "paid" : "unpaid", date: r.date,
    });
  }
  return bills;
}

interface State {
  customers: Customer[];
  meters: Meter[];
  readings: Reading[];
  bills: Bill[];
  payments: Payment[];
  productionLogs: ProductionLog[];
  seeded: boolean;
  adminCreateSubscriber: (data: {
    name: string; phone: string; directorate: string; address: string;
    meterType: MeterType; meterNumber: string; submittedBy?: string;
  }) => { customer: Customer; meter: Meter };
  updateCustomer: (id: number, c: Partial<Customer>) => void;
  deleteCustomer: (id: number) => void;
  addReadingWithBill: (input: {
    meterId: number; current: number; photo?: string; ocrSerial?: string;
    lat?: number; lng?: number; accuracy?: number; by?: string;
  }) => { reading: Reading; bill: Bill | null };
  approveReading: (id: number) => void;
  rejectReading: (id: number) => void;
  addPayment: (input: { billId: number; amount: number; method: PaymentMethod | string; by?: string }) => Payment;
  approvePayment: (id: number) => void;
  rejectPayment: (id: number) => void;
  addProductionLog: (p: Omit<ProductionLog, "id">) => void;
  deleteProductionLog: (id: number) => void;
  computeArrears: (customerId: number, excludeBillId?: number) => number;
  reset: () => void;
}

function initial() {
  const readings = seedReadings();
  const bills = seedBills(readings);
  return {
    customers: CUSTOMERS_SEED,
    meters: METERS_SEED,
    readings,
    bills,
    payments: [] as Payment[],
    productionLogs: [] as ProductionLog[],
    seeded: true,
  };
}

function billBalance(bill: Bill, payments: Payment[]): number {
  const paid = payments
    .filter((p) => p.bill_id === bill.id && p.status === "approved")
    .reduce((a, p) => a + p.amount, 0);
  return Math.max(0, bill.total - paid);
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      ...initial(),

      adminCreateSubscriber: (data) => {
        const s = get();
        const cid = Math.max(0, ...s.customers.map((x) => x.id)) + 1;
        const customer: Customer = {
          id: cid,
          name: data.name,
          phone: data.phone,
          city: "تعز",
          directorate: data.directorate,
          address: data.address,
          pay_account: payAccountFor(cid),
          status: "active",
          submitted_by: data.submittedBy,
          submitted_at: new Date().toISOString(),
        };
        const mid = Math.max(0, ...s.meters.map((x) => x.id)) + 1;
        const meter: Meter = {
          id: mid, customer_id: cid,
          number: data.meterNumber, type: data.meterType, status: "active",
        };
        set({ customers: [...s.customers, customer], meters: [...s.meters, meter] });
        return { customer, meter };
      },

      updateCustomer: (id, c) => set((s) => ({
        customers: s.customers.map((x) => (x.id === id ? { ...x, ...c } : x)),
      })),
      deleteCustomer: (id) => set((s) => ({
        customers: s.customers.filter((x) => x.id !== id),
        meters: s.meters.filter((m) => m.customer_id !== id),
      })),

      computeArrears: (customerId, excludeBillId) => {
        const s = get();
        return s.bills
          .filter((b) => b.customer_id === customerId && b.id !== excludeBillId && b.status !== "paid")
          .reduce((a, b) => a + billBalance(b, s.payments), 0);
      },

      addReadingWithBill: ({ meterId, current, photo, ocrSerial, lat, lng, accuracy, by }) => {
        const s = get();
        const meter = s.meters.find((m) => m.id === meterId);
        if (!meter) return { reading: null as unknown as Reading, bill: null };
        const meterReadings = s.readings
          .filter((r) => r.meter_id === meterId)
          .sort((a, b) => +new Date(b.date) - +new Date(a.date));
        const prev = meterReadings[0]?.current ?? 0;
        const consumption = current - prev;
        const avg = meterReadings.length
          ? meterReadings.reduce((sum, r) => sum + r.consumption, 0) / meterReadings.length
          : 0;
        let flag: Reading["flag"] = "ok";
        if (current < prev) flag = "error";
        else if (avg > 0 && consumption > avg * 3) flag = "suspicious";

        const rid = Math.max(0, ...s.readings.map((r) => r.id)) + 1;
        const reading: Reading = {
          id: rid, serial: nextSerial("RD", rid),
          meter_id: meterId, previous: prev, current, consumption,
          date: new Date().toISOString(), flag, status: "pending",
          photo, ocr_serial: ocrSerial, lat, lng, accuracy, by,
        };

        let bill: Bill | null = null;
        if (flag !== "error") {
          const subtotal = priceFor(meter.type, consumption);
          const arrears = s.bills
            .filter((b) => b.customer_id === meter.customer_id && b.status !== "paid")
            .reduce((a, b) => a + billBalance(b, s.payments), 0);
          const bid = Math.max(0, ...s.bills.map((b) => b.id)) + 1;
          bill = {
            id: bid, serial: nextSerial("INV", bid),
            customer_id: meter.customer_id, meter_id: meter.id, reading_id: rid,
            subtotal, arrears, total: subtotal + arrears,
            status: "unpaid", date: reading.date, photo,
          };
        }

        set({
          readings: [...s.readings, reading],
          bills: bill ? [...s.bills, bill] : s.bills,
        });
        return { reading, bill };
      },

      approveReading: (id) => set((s) => ({
        readings: s.readings.map((r) => r.id === id ? { ...r, status: "approved" } : r),
      })),
      rejectReading: (id) => set((s) => {
        // Also void the derived bill
        const bill = s.bills.find((b) => b.reading_id === id);
        return {
          readings: s.readings.map((r) => r.id === id ? { ...r, status: "rejected" } : r),
          bills: bill ? s.bills.filter((b) => b.id !== bill.id) : s.bills,
        };
      }),

      addPayment: ({ billId, amount, method, by }) => {
        const s = get();
        const p: Payment = {
          id: Math.max(0, ...s.payments.map((x) => x.id)) + 1,
          bill_id: billId, amount, method, date: new Date().toISOString(),
          status: "pending", by,
        };
        set({ payments: [...s.payments, p] });
        return p;
      },

      approvePayment: (id) => set((s) => {
        const target = s.payments.find((p) => p.id === id);
        if (!target) return {};
        const payments = s.payments.map((p) => p.id === id ? { ...p, status: "approved" as ApprovalStatus } : p);
        const bill = s.bills.find((b) => b.id === target.bill_id);
        if (!bill) return { payments };
        const paidTotal = payments
          .filter((p) => p.bill_id === bill.id && p.status === "approved")
          .reduce((a, b) => a + b.amount, 0);
        const status: Bill["status"] = paidTotal >= bill.total ? "paid" : paidTotal > 0 ? "partial" : "unpaid";
        return {
          payments,
          bills: s.bills.map((b) => b.id === bill.id ? { ...b, status } : b),
        };
      }),
      rejectPayment: (id) => set((s) => ({
        payments: s.payments.map((p) => p.id === id ? { ...p, status: "rejected" } : p),
      })),

      addProductionLog: (p) => set((s) => ({
        productionLogs: [...s.productionLogs, { ...p, id: Math.max(0, ...s.productionLogs.map((x) => x.id)) + 1 }],
      })),
      deleteProductionLog: (id) => set((s) => ({
        productionLogs: s.productionLogs.filter((p) => p.id !== id),
      })),
      reset: () => set(initial()),
    }),
    {
      name: "mizan-utility-v2",
      version: 4,
      migrate: (state: unknown, version: number) => {
        const s = state as Partial<State> | undefined;
        if (!s) return initial() as unknown as State;
        if (Array.isArray(s.customers)) {
          s.customers = s.customers.map((c) => ({
            status: "active" as const,
            ...c,
            pay_account: c.pay_account ?? payAccountFor(c.id),
          }));
        }
        if (!Array.isArray((s as State).productionLogs)) {
          (s as State).productionLogs = [];
        }
        if (version < 4) {
          if (Array.isArray(s.readings)) {
            s.readings = s.readings.map((r, i) => ({
              ...r,
              status: (r as Reading).status ?? ("approved" as ApprovalStatus),
              serial: (r as Reading).serial ?? nextSerial("RD", (r as Reading).id ?? i + 1),
            }));
          }
          if (Array.isArray(s.bills)) {
            s.bills = s.bills.map((b) => {
              const anyB = b as unknown as { total?: number; subtotal?: number; arrears?: number };
              const subtotal = anyB.subtotal ?? anyB.total ?? 0;
              const arrears = anyB.arrears ?? 0;
              return {
                ...b,
                serial: (b as Bill).serial ?? nextSerial("INV", (b as Bill).id),
                subtotal,
                arrears,
                total: (anyB.total ?? subtotal) + (anyB.arrears ? 0 : 0),
              } as Bill;
            });
          }
          if (Array.isArray(s.payments)) {
            s.payments = s.payments.map((p) => ({ ...p, status: (p as Payment).status ?? ("approved" as ApprovalStatus) })) as Payment[];
          }
        }
        return s as State;
      },
    },
  ),
);

export function useCustomer(id: number) { return useStore((s) => s.customers.find((c) => c.id === id)); }
export function useMeter(id: number) { return useStore((s) => s.meters.find((m) => m.id === id)); }
export { calcConsumption };
export { billBalance };
