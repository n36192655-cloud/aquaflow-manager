import { useEffect, useState } from "react";
import { recordReading, createPayment } from "./authoritative";

export interface PendingReading {
  clientId: string; meterId: string; current: number; imageData?: string; createdAt: string; by?: string;
  latitude: number; longitude: number; accuracy?: number; ocrSerial?: string; ocrConfidence?: number;
  ocrRawText?: string; captureSource: "camera" | "manual" | "offline"; attempts: number; lastError?: string; lastAttemptAt?: string;
}
export interface PendingPayment {
  clientId: string; billId: string; amount: number; method: string; createdAt: string; attempts: number; lastError?: string; lastAttemptAt?: string;
}

const DB_NAME = "mizan-offline-v3";
const DB_VERSION = 2;
const READINGS = "readings";
const PAYMENTS = "payments";
const EVENT = "mizan-pending-updated";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(READINGS)) db.createObjectStore(READINGS, { keyPath: "clientId" });
      if (!db.objectStoreNames.contains(PAYMENTS)) db.createObjectStore(PAYMENTS, { keyPath: "clientId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مخزن الأوفلاين"));
  });
}
async function all<T>(store: string): Promise<T[]> { const db = await openDb(); return new Promise((resolve,reject)=>{ const req=db.transaction(store,"readonly").objectStore(store).getAll(); req.onsuccess=()=>resolve((req.result??[]) as T[]); req.onerror=()=>reject(req.error); }); }
async function put(store: string, value: unknown) { const db=await openDb(); return new Promise<void>((resolve,reject)=>{ const tx=db.transaction(store,"readwrite"); tx.objectStore(store).put(value); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); }); }
async function remove(store: string, key: string) { const db=await openDb(); return new Promise<void>((resolve,reject)=>{ const tx=db.transaction(store,"readwrite"); tx.objectStore(store).delete(key); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); }); }
function notify(){ if(typeof window!=="undefined") window.dispatchEvent(new Event(EVENT)); }

export async function addPending(p: Omit<PendingReading,"clientId"|"createdAt"|"attempts"> & {clientId?:string}) {
  const item: PendingReading={...p,clientId:p.clientId??crypto.randomUUID(),createdAt:new Date().toISOString(),attempts:0}; await put(READINGS,item); notify(); return item;
}
export async function addPendingPayment(p: Omit<PendingPayment,"clientId"|"createdAt"|"attempts"> & {clientId?:string}) {
  const item: PendingPayment={...p,clientId:p.clientId??crypto.randomUUID(),createdAt:new Date().toISOString(),attempts:0}; await put(PAYMENTS,item); notify(); return item;
}
export async function getPending(){ return all<PendingReading>(READINGS); }
export async function getPendingPayments(){ return all<PendingPayment>(PAYMENTS); }

export async function syncPending(): Promise<{synced:number;failed:number}> {
  if(typeof navigator!=="undefined"&&!navigator.onLine)return{synced:0,failed:0};
  let synced=0,failed=0;
  for(const item of await all<PendingReading>(READINGS)) try { await recordReading({meterId:item.meterId,current:item.current,photoUrl:item.imageData,captureSource:"offline",ocrSerial:item.ocrSerial,ocrConfidence:item.ocrConfidence,ocrRawText:item.ocrRawText,clientId:item.clientId,lat:item.latitude,lng:item.longitude,accuracy:item.accuracy}); await remove(READINGS,item.clientId); synced++; } catch(error){ failed++; await put(READINGS,{...item,attempts:item.attempts+1,lastError:error instanceof Error?error.message:String(error),lastAttemptAt:new Date().toISOString()}); }
  for(const item of await all<PendingPayment>(PAYMENTS)) try { await createPayment({billId:item.billId,amount:item.amount,method:item.method,clientId:item.clientId}); await remove(PAYMENTS,item.clientId); synced++; } catch(error){ failed++; await put(PAYMENTS,{...item,attempts:item.attempts+1,lastError:error instanceof Error?error.message:String(error),lastAttemptAt:new Date().toISOString()}); }
  notify(); return {synced,failed};
}

export function useOnlineStatus(){ const [online,setOnline]=useState(typeof navigator!=="undefined"?navigator.onLine:true); useEffect(()=>{const on=()=>{setOnline(true);void syncPending();};const off=()=>setOnline(false);window.addEventListener("online",on);window.addEventListener("offline",off);void syncPending();return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};},[]);return online; }
export function usePendingCount(){ const [count,setCount]=useState(0);useEffect(()=>{let alive=true;const refresh=async()=>{const [a,b]=await Promise.all([all(READINGS),all(PAYMENTS)]);if(alive)setCount(a.length+b.length);};void refresh();window.addEventListener(EVENT,refresh);return()=>{alive=false;window.removeEventListener(EVENT,refresh);};},[]);return count; }
