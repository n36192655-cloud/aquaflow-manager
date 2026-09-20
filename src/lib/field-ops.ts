import { supabase } from "./supabase";

export interface FieldReadingInput {
  meterId: string;
  current: number;
  photoUrl?: string;
  captureSource: "camera" | "phone" | "manual" | "offline";
  ocrSerial?: string;
  ocrConfidence?: number;
  ocrRawText?: string;
  clientId: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
}

const MAX_METER_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_METER_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function dataUrlToBlob(dataUrl: string): Blob {
  if (!dataUrl.startsWith("data:")) throw new Error("Invalid image data");
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Invalid image data");
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = meta.match(/^data:([^;,]+)(?:;[^,]*)?$/i)?.[1]?.toLowerCase();
  if (!mime || !ALLOWED_METER_IMAGE_TYPES.has(mime))
    throw new Error("Unsupported meter image type");
  if (!body || body.length > Math.ceil((MAX_METER_IMAGE_BYTES * 4) / 3) + 1024)
    throw new Error("Meter image is too large");
  let bytes: string;
  try {
    bytes = atob(body);
  } catch {
    throw new Error("Invalid image encoding");
  }
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) arr[i] = bytes.charCodeAt(i);
  if (arr.byteLength === 0 || arr.byteLength > MAX_METER_IMAGE_BYTES)
    throw new Error("Meter image is too large");
  return new Blob([arr], { type: mime });
}

export async function uploadMeterReadingImage(
  dataUrl: string,
  tenantId: string,
  userId: string,
  clientId: string,
): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  const extension = IMAGE_EXTENSIONS[blob.type] ?? "jpg";
  const path = `${tenantId}/${userId}/${clientId}.${extension}`;
  const { error } = await supabase.storage.from("meter-readings").upload(path, blob, {
    contentType: blob.type,
    upsert: false,
    cacheControl: "3600",
  });
  if (error && !/already exists/i.test(error.message)) throw error;
  return path;
}

export async function removeMeterReadingImage(path: string): Promise<void> {
  const { error } = await supabase.storage.from("meter-readings").remove([path]);
  if (error) console.warn("[Mizan] unable to clean up reading image", error);
}

export async function createMeterReadingImageUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from("meter-readings").createSignedUrl(path, 300);
  if (error) return null;
  return data.signedUrl;
}

export async function recordFieldReading(input: FieldReadingInput) {
  const { data, error } = await supabase.rpc("record_water_reading", {
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
  return Array.isArray(data) ? data[0] : data;
}

export async function approveFieldReading(readingId: string) {
  const { data, error } = await supabase.rpc("approve_water_reading", { p_reading_id: readingId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function rejectFieldReading(readingId: string, reason: string) {
  const { data, error } = await supabase.rpc("reject_water_reading", {
    p_reading_id: readingId,
    p_reason: reason,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function recordWaterPayment(input: {
  billId: string;
  amount: number;
  method: "cash" | "bank_transfer";
  clientId: string;
}) {
  const { data, error } = await supabase.rpc("record_water_payment", {
    p_bill_id: input.billId,
    p_amount: input.amount,
    p_method: input.method,
    p_client_id: input.clientId,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function approveWaterPayment(paymentId: string) {
  const { data, error } = await supabase.rpc("approve_water_payment", { p_payment_id: paymentId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function rejectWaterPayment(paymentId: string, reason: string) {
  const { data, error } = await supabase.rpc("reject_water_payment", {
    p_payment_id: paymentId,
    p_reason: reason,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export function newClientId(prefix = "reading") {
  return `${prefix}_${crypto.randomUUID()}`;
}
