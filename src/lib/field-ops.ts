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
  const { data, error } = await supabase.rpc("reject_water_reading", { p_reading_id: readingId, p_reason: reason });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export function newClientId(prefix = "reading") {
  return `${prefix}_${crypto.randomUUID()}`;
}
