import { ValidationError } from "../core/errors.js";
import type { PolicyOp } from "./schema.js";

/** Plain-object path helpers for policy ops (dot paths; no array indexes). */

export function splitPath(path: string): string[] {
	const parts = path.split(".").map((p) => p.trim());
	if (!parts.length || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
		throw new ValidationError(`invalid policy path: ${path}`, { path });
	return parts;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function getIn(root: unknown, parts: readonly string[]): unknown {
	let cur: unknown = root;
	for (const p of parts) {
		if (!isObj(cur)) return undefined;
		cur = cur[p];
	}
	return cur;
}

function parentOf(root: Obj, parts: readonly string[]): Obj {
	let cur: Obj = root;
	for (const p of parts.slice(0, -1)) {
		const next = cur[p];
		if (!isObj(next)) cur[p] = {};
		cur = cur[p] as Obj;
	}
	return cur;
}

/** Deep equality for JSON-like values. */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
	if (isObj(a) && isObj(b)) {
		const ka = Object.keys(a);
		const kb = Object.keys(b);
		return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
	}
	return false;
}

/** For `remove`: an object value matches items that have all of its keys equal. */
export function matchesItem(item: unknown, value: unknown): boolean {
	if (isObj(value) && isObj(item))
		return Object.entries(value).every(([k, v]) => deepEqual(item[k], v));
	return deepEqual(item, value);
}

/** Apply ops to a plain object in place. `add` is set-like (no duplicates). */
export function applyOps(root: Obj, ops: readonly PolicyOp[]): Obj {
	for (const o of ops) {
		const parts = splitPath(o.path);
		const key = parts[parts.length - 1] as string;
		const parent = parentOf(root, parts);
		if (o.op === "set") {
			parent[key] = structuredClone(o.value);
			continue;
		}
		const cur = parent[key];
		const list = Array.isArray(cur) ? [...cur] : cur === undefined ? [] : null;
		if (list === null)
			throw new ValidationError(`${o.path} is not a list`, { path: o.path });
		if (o.op === "add") {
			if (!list.some((x) => deepEqual(x, o.value)))
				list.push(structuredClone(o.value));
		} else {
			for (let i = list.length - 1; i >= 0; i--)
				if (matchesItem(list[i], o.value)) list.splice(i, 1);
		}
		parent[key] = list;
	}
	return root;
}
