export type MeterType = "water" | "electric";

export function calcConsumption(previous: number, current: number): number {
  return current - previous;
}

export function priceWater(units: number): number {
  if (units <= 0) return 0;
  let total = 0;
  const t1 = Math.min(units, 10);
  total += t1 * 100;
  if (units > 10) {
    const t2 = Math.min(units - 10, 20);
    total += t2 * 200;
  }
  if (units > 30) {
    const t3 = Math.min(units - 30, 70);
    total += t3 * 350;
  }
  if (units > 100) {
    total += (units - 100) * 350;
  }
  return total;
}

export function priceElectric(units: number): number {
  if (units <= 0) return 0;
  let total = 0;
  const t1 = Math.min(units, 100);
  total += t1 * 15;
  if (units > 100) {
    const t2 = Math.min(units - 100, 200);
    total += t2 * 25;
  }
  if (units > 300) {
    const t3 = Math.min(units - 300, 200);
    total += t3 * 40;
  }
  if (units > 500) {
    total += (units - 500) * 40;
  }
  return total;
}

export function priceFor(type: MeterType, units: number): number {
  return type === "water" ? priceWater(units) : priceElectric(units);
}

export function classifyConsumption(current: number, previous: number, avg: number) {
  if (current < previous) return "error" as const;
  const c = current - previous;
  if (avg > 0 && c > avg * 3) return "suspicious" as const;
  return "ok" as const;
}

export function fmtYER(n: number): string {
  return new Intl.NumberFormat("ar-YE").format(Math.round(n)) + " ريال";
}

export function fmtNum(n: number): string {
  return new Intl.NumberFormat("ar-YE").format(n);
}
