import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { recordFieldReading } from "./field-ops";

export type SyncState = "pending" | "syncing" | "failed";

export interface PendingReading {
  clientId: string;
  tenantId: string;
  userId: string;
  meterId: string;
  current: number;
  imageData?: string;
  createdAt: string;
  by?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  captureSource: "camera" | "phone" | "manual" | "offline";
  ocrSerial?: string;
  ocrConfidence?: number;
  ocrRawText?: string;
  state: SyncState;
  retryCount: number;
  lastError?: string;
}

const DB_NAME = "mizan-field-ops-v2";
const STORE = "pending-readings";
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is unavailable"));
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "clientId" });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("state", "state", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

async function all(): Promise<PendingReading[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => { db.close(); resolve((req.result as PendingReading[]).sort((a,b) => a.createdAt.localeCompare(b.createdAt))); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function put(item: PendingReading): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(item);
    req.onsuccess = () => { db.close(); resolve(); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function remove(clientId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).delete(clientId);
    req.onsuccess = () => { db.close(); resolve(); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function getPending(): Promise<PendingReading[]> { return all(); }

export async function addPending(input: Omit<PendingReading, "clientId" | "createdAt" | "state" | "retryCount"> & { clientId?: string }): Promise<PendingReading> {
  const item: PendingReading = {
    ...input,
    clientId: input.clientId ?? `reading_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    state: "pending",
    retryCount: 0,
  };
  await put(item);
  window.dispatchEvent(new Event("mizan-pending-updated"));
  return item;
}

export async function removePending(clientId: string) {
  await remove(clientId);
  window.dispatchEvent(new Event("mizan-pending-updated"));
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const [meta, body] = dataUrl.split(",");
    if (!meta || !body) return null;
    const bytes = atob(body);
    const arr = new Uint8Array(bytes.length);
    for (let i=0;i<bytes.length;i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: meta.match(/data:([^;]+)/)?.[1] ?? "image/jpeg" });
  } catch { return null; }
}

async function uploadOfflineImage(item: PendingReading): Promise<string | undefined> {
  if (!item.imageData) return undefined;
  const blob = dataUrlToBlob(item.imageData);
  if (!blob) throw new Error("Invalid offline image");
  const path = `${item.tenantId}/${item.userId}/${item.clientId}.jpg`;
  const { error } = await supabase.storage.from("meter-readings").upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });
  if (error && !/already exists/i.test(error.message)) throw error;
  const { data } = supabase.storage.from("meter-readings").getPublicUrl(path);
  return data.publicUrl;
}

let syncRunning = false;
export async function syncPending(): Promise<{ synced: number; failed: number }> {
  if (syncRunning || typeof navigator === "undefined" || !navigator.onLine) return { synced: 0, failed: 0 };
  syncRunning = true;
  let synced = 0, failed = 0;
  try {
    const { data: session } = await supabase.auth.getSession();
    const uid = session.session?.user.id;
    if (!uid) return { synced: 0, failed: 0 };
    for (const item of await all()) {
      if (item.userId !== uid || item.state === "syncing") continue;
      await put({ ...item, state: "syncing", lastError: undefined });
      try {
        const photoUrl = await uploadOfflineImage(item);
        await recordFieldReading({
          meterId: item.meterId,
          current: item.current,
          photoUrl,
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
      } catch (e) {
        const retryCount = item.retryCount + 1;
        await put({ ...item, state: "failed", retryCount, lastError: e instanceof Error ? e.message : "Sync failed" });
        failed++;
      }
    }
  } finally {
    syncRunning = false;
    window.dispatchEvent(new Event("mizan-pending-updated"));
  }
  return { synced, failed };
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const on = () => { setOnline(true); void syncPending(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const timer = window.setInterval(() => { if (navigator.onLine) void syncPending(); }, 30000);
    void syncPending();
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); window.clearInterval(timer); };
  }, []);
  return online;
}

export function usePendingCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refresh = () => void getPending().then((x) => setCount(x.length));
    refresh();
    window.addEventListener("mizan-pending-updated", refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener("mizan-pending-updated", refresh); window.removeEventListener("storage", refresh); };
  }, []);
  return count;
}
