import { useEffect, useState } from "react";
import { useStore } from "./store";

// تم تحديث الواجهة لتشمل إحداثيات الـ GPS بشكل إجباري حتى في وضع الأوفلاين
export interface PendingReading {
  clientId: string;
  meterId: number;
  current: number;
  imageData?: string;
  createdAt: string;
  by?: string;
  // إحداثيات الموقع الجغرافي الإلزامية للأمان المزدوج
  latitude: number;
  longitude: number;
}

const KEY = "mizan-pending-readings-v1";

function load(): PendingReading[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PendingReading[]) : [];
  } catch {
    return [];
  }
}

function save(arr: PendingReading[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(arr));
  window.dispatchEvent(new Event("mizan-pending-updated"));
}

export function getPending(): PendingReading[] {
  return load();
}

// تعديل دالة الإضافة لتستقبل الـ latitude و longitude إجبارياً من الحساس الميداني
export function addPending(
  p: Omit<PendingReading, "clientId" | "createdAt"> & { clientId?: string }
): PendingReading {
  const list = load();
  const item: PendingReading = {
    ...p,
    clientId: p.clientId ?? `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  save([...list, item]);
  return item;
}

export function removePending(clientId: string) {
  save(load().filter((p) => p.clientId !== clientId));
}

// تحديث دالة المزامنة لتمرير الإحداثيات الجغرافية إلى الـ store عند الرفع
export function syncPending(): { synced: number } {
  const list = load();
  if (!list.length) return { synced: 0 };
  
  const store = useStore.getState();
  let n = 0;
  const remaining: PendingReading[] = [];
  
  for (const p of list) {
    try {
      // تمرير الـ latitude والـ longitude المخزنة ميدانياً لضمان دقة الأمان المزدوج حتى بعد ساعات من القراءة
      store.addReadingWithBill({ 
        meterId: p.meterId, 
        current: p.current, 
        photo: p.imageData, 
        by: p.by,
        latitude: p.latitude,
        longitude: p.longitude
      });
      n++;
    } catch (error) {
      console.error("خطأ أثناء مزامنة القراءة المعلقة:", error);
      remaining.push(p);
    }
  }
  
  save(remaining);
  return { synced: n };
}

// هوك مراقبة حالة الشبكة مع تفعيل المزامنة التلقائية اللحظية (Auto-Sync on Online)
export function useOnlineStatus() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  
  useEffect(() => {
    const on = () => {
      setOnline(true);
      // هندسياً: فور عودة الإنترنت، أطلق المزامنة التلقائية فوراً خلف الكواليس
      setTimeout(() => {
        const result = syncPending();
        if (result.synced > 0) {
          console.log(`[ميزان الذكي] تم ترحيل ومزامنة ${result.synced} قراءات معلقة تلقائياً.`);
        }
      }, 1000);
    };
    
    const off = () => setOnline(false);
    
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  
  return online;
}

export function usePendingCount() {
  const [count, setCount] = useState<number>(0);
  
  useEffect(() => {
    const refresh = () => setCount(load().length);
    refresh();
    window.addEventListener("mizan-pending-updated", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("mizan-pending-updated", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  
  return count;
}
