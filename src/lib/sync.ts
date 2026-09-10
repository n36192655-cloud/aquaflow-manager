import { useEffect, useState } from "react";
import { recordReading } from "./authoritative";

export interface PendingReading {
  clientId: string;
  meterId: string;
  current: number;
  imageData?: string;
  createdAt: string;
  by?: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  ocrSerial?: string;
  ocrConfidence?: number;
  ocrRawText?: string;
  captureSource: "camera" | "manual" | "offline";
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
}

const DB_NAME = "mizan-offline-v2";
const STORE_NAME = "readings";
const EVENT = "mizan-pending-updated";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "clientId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مخزن الأوفلاين"));
  });
}

async function readAll(): Promise<PendingReading[]> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as PendingReading[]);
    req.onerror = () => reject(req.error);
  });
}

async function put(item: PendingReading) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function remove(clientId: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(clientId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function notify() {
  window.dispatchEvent(new Event(EVENT));
}

export function getPending(): PendingReading[] {
  // Synchronous compatibility helper; UI count is maintained by usePendingCount.
  return [];
}

export async function addPending(
  p: Omit<PendingReading, "clientId" | "createdAt" | "attempts"> & { clientId?: string },
): Promise<PendingReading> {
  const item: PendingReading = {
    ...p,
    clientId: p.clientId ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  await put(item);
  notify();
  return item;
}

export async function syncPending(): Promise<{ synced: number; failed: number }> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return { synced: 0, failed: 0 };
  const list = await readAll();
  let synced = 0;
  let failed = 0;
  for (const item of list) {
    try {
      await recordReading({
        meterId: item.meterId,
        current: item.current,
        photoUrl: item.imageData,
        captureSource: "offline",
        ocrSerial: item.ocrSerial,
        ocrConfidence: item.ocrConfidence,
        ocrRawText: item.ocrRawText,
        clientId: item.clientId,
        lat: item.latitude,
        lng: item.longitude,
        accuracy: item.accuracy,
      });
      await remove(item.clientId);
      synced++;
    } catch (error) {
      failed++;
      await put({ ...item, attempts: item.attempts + 1, lastError: error instanceof Error ? error.message : String(error), lastAttemptAt: new Date().toISOString() });
    }
  }
  notify();
  return { synced, failed };
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const on = () => { setOnline(true); void syncPending(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    void syncPending();
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

export function usePendingCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const refresh = async () => { const rows = await readAll(); if (alive) setCount(rows.length); };
    void refresh();
    window.addEventListener(EVENT, refresh);
    return () => { alive = false; window.removeEventListener(EVENT, refresh); };
  }, []);
  return count;
}
