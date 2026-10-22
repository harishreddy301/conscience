/**
 * Time-zone aware date maths without external libraries.
 * All instants are JS Dates (UTC). "Date keys" are local calendar dates "YYYY-MM-DD".
 */

export interface LocalParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(tz, f);
	}
	return f;
}

export function isValidTimeZone(tz: string): boolean {
	try {
		formatter(tz);
		return true;
	} catch {
		return false;
	}
}

export function localParts(d: Date, tz: string): LocalParts {
	const out: Record<string, number> = {};
	for (const p of formatter(tz).formatToParts(d)) {
		if (p.type !== "literal") out[p.type] = Number(p.value);
	}
	return {
		year: out.year ?? 0,
		month: out.month ?? 1,
		day: out.day ?? 1,
		hour: (out.hour ?? 0) % 24,
		minute: out.minute ?? 0,
		second: out.second ?? 0,
	};
}

/** Offset of `tz` from UTC at instant `d`, in minutes (local - UTC). */
export function tzOffsetMinutes(d: Date, tz: string): number {
	const p = localParts(d, tz);
	const asUtc = Date.UTC(
		p.year,
		p.month - 1,
		p.day,
		p.hour,
		p.minute,
		p.second,
	);
	const whole = Math.floor(d.getTime() / 1000) * 1000;
	return Math.round((asUtc - whole) / MINUTE_MS);
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function localDateKey(d: Date, tz: string): string {
	const p = localParts(d, tz);
	return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localTimeHhmm(d: Date, tz: string): string {
	const p = localParts(d, tz);
	return `${pad(p.hour)}:${pad(p.minute)}`;
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isDateKey(s: string): boolean {
	return DATE_KEY.test(s);
}

export function isHhmm(s: string): boolean {
	return HHMM.test(s);
}

function splitKey(key: string): [number, number, number] {
	const m = DATE_KEY.exec(key);
	if (!m) throw new RangeError(`invalid date key: ${key}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function parseHhmm(s: string): { h: number; m: number } {
	const m = HHMM.exec(s);
	if (!m) throw new RangeError(`invalid HH:MM: ${s}`);
	return { h: Number(m[1]), m: Number(m[2]) };
}

export function addDaysKey(key: string, n: number): string {
	const [y, mo, d] = splitKey(key);
	const t = new Date(Date.UTC(y, mo - 1, d) + n * DAY_MS);
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** ISO day of week: 1 = Monday ... 7 = Sunday. */
export function isoDow(key: string): number {
	const [y, mo, d] = splitKey(key);
	const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
	return ((js + 6) % 7) + 1;
}

/** Monday of the ISO week containing `key`. */
export function isoWeekStartKey(key: string): string {
	return addDaysKey(key, 1 - isoDow(key));
}

/**
 * The UTC instant of local wall time `hhmm` on local date `key` in `tz`.
 * Times inside a DST gap resolve forward by the gap length.
 */
export function zonedToUtc(key: string, hhmm: string, tz: string): Date {
	const [y, mo, d] = splitKey(key);
	const { h, m } = parseHhmm(hhmm);
	const guess = Date.UTC(y, mo - 1, d, h, m);
	const off1 = tzOffsetMinutes(new Date(guess), tz);
	const first = guess - off1 * MINUTE_MS;
	const off2 = tzOffsetMinutes(new Date(first), tz);
	if (off2 === off1) return new Date(first);
	const second = new Date(guess - off2 * MINUTE_MS);
	const p = localParts(second, tz);
	// If the second guess round-trips, use it; otherwise the time is in a DST gap
	// and `first` is the same wall time shifted forward by the gap.
	return p.hour === h && p.minute === m ? second : new Date(first);
}

/** Start of local day `key` as a UTC instant. */
export function startOfLocalDay(key: string, tz: string): Date {
	return zonedToUtc(key, "00:00", tz);
}

export function minutesBetween(a: Date, b: Date): number {
	return (b.getTime() - a.getTime()) / MINUTE_MS;
}

export function addMinutes(d: Date, minutes: number): Date {
	return new Date(d.getTime() + minutes * MINUTE_MS);
}

/** Minutes of overlap between [aStart,aEnd) and [bStart,bEnd). */
export function overlapMinutes(
	aStart: Date,
	aEnd: Date,
	bStart: Date,
	bEnd: Date,
): number {
	const s = Math.max(aStart.getTime(), bStart.getTime());
	const e = Math.min(aEnd.getTime(), bEnd.getTime());
	return e > s ? (e - s) / MINUTE_MS : 0;
}

/** Split [start,end) into per-local-day minute totals. */
export function minutesPerLocalDay(
	start: Date,
	end: Date,
	tz: string,
): Map<string, number> {
	const out = new Map<string, number>();
	let cursor = start;
	while (cursor.getTime() < end.getTime()) {
		const key = localDateKey(cursor, tz);
		const nextMidnight = startOfLocalDay(addDaysKey(key, 1), tz);
		const segEnd = nextMidnight.getTime() < end.getTime() ? nextMidnight : end;
		out.set(key, (out.get(key) ?? 0) + minutesBetween(cursor, segEnd));
		cursor = segEnd;
	}
	return out;
}

/** The system time zone, falling back to UTC. */
export function systemTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
