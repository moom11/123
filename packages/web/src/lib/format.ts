/** Display helpers. Money arrives from the API as integer halalas. */

export function money(minor: number | null | undefined): string {
  const value = Number(minor ?? 0);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function riyal(minor: number | null | undefined): string {
  return `${money(minor)} ر.س`;
}

export function time(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ar-SA', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

export function dateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('ar-SA')} ${time(d)}`;
}

/** "منذ 3 د" — used on the floor board where elapsed time is what matters. */
export function since(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'الآن';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `منذ ${minutes} د`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `منذ ${hours} س`;
  return `منذ ${Math.floor(hours / 24)} ي`;
}

export function quantity(value: number, unit: string): string {
  const units: Record<string, string> = {
    g: 'جم', ml: 'مل', piece: 'حبة', kg: 'كجم', l: 'لتر',
    box: 'صندوق', carton: 'كرتون', pack: 'باكيت',
  };
  // Show grams and millilitres in their larger unit once they get big enough
  // to be awkward to read.
  if (unit === 'g' && Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} كجم`;
  if (unit === 'ml' && Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} لتر`;
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(2));
  return `${rounded.toLocaleString('en-US')} ${units[unit] ?? unit}`;
}
