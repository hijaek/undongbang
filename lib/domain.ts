export const DEFAULT_TIMEZONE='America/New_York';
export const FEED_PAGE_SIZE=12;
export function addDays(day:string,days:number){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
export function fineCents(goal: number, count: number, unit: number, exempt: boolean) { return exempt ? 0 : Math.max(0, goal - count) * unit; }
export function distributeCents(total: number, count: number) {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid amount');
  return count ? { perPerson: Math.floor(total / count), carry: total % count } : { perPerson: 0, carry: total };
}
export function money(cents: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100); }
export function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value); }
export type Member = { id: string; user_id: string; name: string; role: string; status: string; joined_at: string; count: number; exempt: number; month_excluded?: number };
export type Room = { id: string; name: string; goal: number; fine_cents: number; timezone: string; payout_period: string; invite_code?: string; sheet_id?: string; sheet_url?: string; role: string; member_id: string; created_at: string };
export type Post = { id: string; room_id: string; member_id: string; name: string; kind: 'image'|'video'; caption: string; created_at: string; week: string; status: string; cheers: number; cheered: number; comments: number; nth: number; media_url: string; thumb_url: string };
export type Bootstrap = { user: { id: string; name: string; email: string }|null; room: Room|null; week?: string; weekEnds?: string; members?: Member[]; revision?: number; authReady: boolean };
