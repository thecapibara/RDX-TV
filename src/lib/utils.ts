export type ClassValue = string | number | boolean | null | undefined | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const item of inputs) {
    if (!item) continue;
    if (typeof item === "string" || typeof item === "number") {
      out.push(String(item));
    } else if (Array.isArray(item)) {
      const nested = cn(...item);
      if (nested) out.push(nested);
    }
  }
  return out.join(" ");
}
