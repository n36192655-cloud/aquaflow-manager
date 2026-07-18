import { create } from "zustand";
import { persist } from "zustand/middleware";
// استيراد عميل Supabase الخاص بمشروعك للتعامل مع السيرفر مباشرة
import { supabase } from "./supabase"; 

export const VENDOR_NAME = "انديكيتورز للإستشارات";

export interface Seat {
  id: string;          
  user: string;        
  role: string;        
  device: string;      
  since: string;       
  lastSeen: string;    
}

export type LicenseStatus = "active" | "expired" | "invalid" | "seat_limit" | "suspended";

interface LicenseState {
  tenantId: string;
  licenseKey: string;
  maxSeats: number;
  expiresAt: string;       
  billingPaid: boolean;
  seats: Seat[];
  initialized: boolean;

  initIfNeeded: () => void;
  activateRemote: (tenantId: string, licenseKey: string, maxSeats: number) => Promise<boolean>;
  validateRemote: () => Promise<LicenseStatus>;
  acquireSeatRemote: (user: string, role: string) => Promise<{ ok: boolean; reason?: LicenseStatus }>;
  currentFingerprint: () => string;
}

function computeFingerprint(): string {
  if (typeof window === "undefined") return "ssr";
  const parts = [
    navigator.userAgent,
    navigator.language,
    String(screen.width) + "x" + String(screen.height),
    String(navigator.hardwareConcurrency ?? ""),
  ].join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const useLicense = create<LicenseState>()(
  persist(
    (set, get) => ({
      tenantId: "",
      licenseKey: "",
      maxSeats: 3,
      expiresAt: "",
      billingPaid: true,
      seats: [],
      initialized: false,

      currentFingerprint: () => computeFingerprint(),

      initIfNeeded: () => {
        // دالة التجهيز عند الإقلاع الأول
        const s = get();
        if (s.initialized) return;
        set({ maxSeats: 3, billingPaid: true, seats: [], initialized: false });
      },

      // تفعيل العميل لأول مرة وربطه بالسيرفر
      activateRemote: async (tenantId, licenseKey, maxSeats) => {
        try {
          const expiryDate = new Date();
          expiryDate.setFullYear(expiryDate.getFullYear() + 1); // سنة تجريبية

          // تخزين بيانات ترخيص المستأجر في جدول التراخيص المركزي بالسيرفر
          const { error } = await supabase.from("client_licenses").upsert({
            tenant_id: tenantId.trim(),
            license_key: licenseKey.trim(),
            max_seats: maxSeats,
            expires_at: expiryDate.toISOString(),
            billing_paid: true
          });

          if (error) throw error;

          set({
            tenantId: tenantId.trim(),
            licenseKey: licenseKey.trim(),
            maxSeats: maxSeats,
            expiresAt: expiryDate.toISOString(),
            billingPaid: true,
            initialized: true
          });
          return true;
        } catch (err) {
          console.error(err);
          return false;
        }
      },

      // الفحص الحي والمستمر للرخصة لمنع العبث أو للإيقاف عن بعد
      validateRemote: async () => {
        const s = get();
        if (!s.initialized || !s.tenantId) return "invalid";

        try {
          // جلب حالة العميل مباشرة من قاعدة البيانات السحابية
          const { data, error } = await supabase
            .from("client_licenses")
            .select("billing_paid, expires_at, max_seats")
            .eq("tenant_id", s.tenantId)
            .single();

          if (error || !data) return "invalid";

          set({ 
            billingPaid: data.billing_paid, 
            expiresAt: data.expires_at, 
            maxSeats: data.max_seats 
          });

          if (!data.billing_paid) return "suspended";
          if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return "expired";
          
          return "active";
        } catch {
          // حماية أمنية في حال انقطاع شبكة الإنترنت المؤقت عن جهاز العميل
          if (!s.billingPaid) return "suspended";
          if (s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()) return "expired";
          return "active";
        }
      },

      // حجز مقعد للجهاز الحالي ومزامنة الأجهزة الثلاثة معاً عن بعد
      acquireSeatRemote: async (user, role) => {
        const s = get();
        const currentFp = computeFingerprint();
        
        // 1. فحص صلاحية الرخصة أولاً
        const status = await get().validateRemote();
        if (status !== "active") return { ok: false, reason: status };

        try {
          // تنظيف المقاعد القديمة التي لم تتصل منذ 24 ساعة في السيرفر تلقائياً
          const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          await supabase.from("active_seats").delete().lt("last_seen", yesterday);

          // جلب الأجهزة النشطة حالياً لهذا المستأجر من السيرفر
          const { data: activeSeats } = await supabase
            .from("active_seats")
            .select("*")
            .eq("tenant_id", s.tenantId);

          const seatsList: Seat[] = (activeSeats || []).map(x => ({
            id: x.id, user: x.user_name, role: x.role, device: x.device_fp, since: x.created_at, lastSeen: x.last_seen
          }));

          // إذا كان هذا الجهاز مسجل بالفعل، نقوم بتحديث وقت ظهوره فقط
          const existing = seatsList.find(x => x.device === currentFp);
          if (existing) {
            await supabase.from("active_seats").update({ last_seen: new Date().toISOString() }).eq("id", existing.id);
            return { ok: true };
          }

          // إذا كان عدد الأجهزة المتصلة قد وصل للحد الأقصى (3 أجهزة) نرفض الجهاز الرابع
          if (seatsList.length >= s.maxSeats) {
            return { ok: false, reason: "seat_limit" };
          }

          // تسجيل الجهاز الحالي كمقعد رسمي نشط في السيرفر
          await supabase.from("active_seats").insert({
            tenant_id: s.tenantId,
            user_name: user,
            role: role,
            device_fp: currentFp,
            last_seen: new Date().toISOString()
          });

          return { ok: true };
        } catch {
          return { ok: true }; // تمرير في حال مشاكل الاتصال المؤقتة لضمان استمرارية العمل داخلياً
        }
      }
    }),
    { name: "mizan-cloud-license-v1" },
  ),
);

export function statusLabel(s: LicenseStatus): string {
  switch (s) {
    case "active": return "الترخيص نشط ومفعّل سحابياً";
    case "expired": return "الاشتراك النسخة التجريبية منتهي";
    case "invalid": return "ترخيص غير صالح أو غير معتمد";
    case "seat_limit": return "تم تجاوز عدد الأجهزة المسموح بها (أقصى حد 3 أجهزة)";
    case "suspended": return "الاشتراك معلق لعدم السداد";
    default: return "حالة ترخيص مجهولة";
  }
}
