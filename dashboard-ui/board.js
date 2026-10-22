// conscience job board (kanban). Plain JS, CSP-safe: no inline code, no innerHTML;
// every string from the server is set with textContent or a validated href.
(() => {
	const POLL_MS = 30_000;
	const MAIN = [
		"backlog",
		"creating",
		"needs_you",
		"ready",
		"applying",
		"applied",
		"interviewing",
	];
	const LANES = ["skipped", "closed"];
	const ACTION_COLUMNS = new Set(["applied", "interviewing"]);
	const ACTIONS = [
		["recruiter_screen", "Recruiter screen"],
		["technical", "Technical"],
		["onsite", "Onsite/Final"],
		["offer", "Offer"],
		["rejected", "Rejected"],
		["ghosted", "Ghosted"],
		["withdrawn", "Withdrawn"],
	];
	const RANGES = [
		["today", "Today"],
		["yesterday", "Yesterday"],
		["7d", "Last 7 days"],
		["30d", "Last 30 days"],
		["all", "All"],
		["custom", "Custom range"],
	];
	const KEY_VIEW = "jh.view";
	const KEY_RANGE = "jh.board.range";
	const KEY_COL = "jh.board.col";

	const st = {
		board: null,
		csrf: null,
		readOnly: false,
		poll: null,
		openForm: null,
		col: load(KEY_COL, "backlog"),
		range: loadRange(),
		lanesOpen: new Set(),
	};

	// ---------------------------------------------------------- helpers

	function load(key, fallback) {
		try {
			const v = localStorage.getItem(key);
			return v === null ? fallback : JSON.parse(v);
		} catch {
			return fallback;
		}
	}
	function loadRange() {
		const r = load(KEY_RANGE, null);
		const ok =
			r && typeof r === "object" && RANGES.some(([v]) => v === r.preset);
		const day = (v) =>
			typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
		return ok
			? { preset: r.preset, from: day(r.from), to: day(r.to) }
			: { preset: "today", from: "", to: "" };
	}
	function save(key, value) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {}
	}

	const byId = (id) => document.getElementById(id);

	function h(tag, props, ...kids) {
		const n = document.createElement(tag);
		for (const [k, v] of Object.entries(props || {})) {
			if (v === undefined || v === null || v === false) continue;
			if (k === "class") n.className = v;
			else if (k === "text") n.textContent = v;
			else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
			else n.setAttribute(k, v === true ? "" : String(v));
		}
		for (const c of kids.flat()) {
			if (c === null || c === undefined || c === false) continue;
			n.append(c instanceof Node ? c : document.createTextNode(String(c)));
		}
		return n;
	}

	function say(msg) {
		const t = byId("toast");
		if (!t) return;
		t.textContent = msg;
		t.hidden = false;
		clearTimeout(say.h);
		say.h = setTimeout(() => {
			t.hidden = true;
		}, 4000);
	}

	/** Only http(s) URLs and same-origin paths become links. */
	function safeHref(u) {
		if (typeof u !== "string") return null;
		if (u.startsWith("/api/board/")) return u;
		try {
			const p = new URL(u);
			return p.protocol === "https:" || p.protocol === "http:" ? p.href : null;
		} catch {
			return null;
		}
	}

	function fmtDay(iso) {
		if (!iso) return null;
		const d = new Date(iso);
		return Number.isNaN(d.getTime())
			? null
			: d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}

	function ago(iso) {
		const t = Date.parse(iso);
		if (!Number.isFinite(t)) return "";
		const min = Math.round((Date.now() - t) / 60000);
		if (min < 1) return "just now";
		if (min < 60) return `${min}m ago`;
		if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
		return `${Math.round(min / 1440)}d ago`;
	}

	function localTz() {
		try {
			return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
		} catch {
			return "";
		}
	}

	// ---------------------------------------------------------- network

	async function fetchBoard() {
		const q = new URLSearchParams({ range: st.range.preset });
		if (st.range.preset === "custom") {
			if (st.range.from) q.set("from", st.range.from);
			if (st.range.to) q.set("to", st.range.to);
		}
		const tz = localTz();
		if (tz) q.set("tz", tz);
		const r = await fetch(`/api/board?${q}`, {
			headers: { Accept: "application/json" },
			credentials: "same-origin",
		});
		if (!r.ok) throw new Error(`board: HTTP ${r.status}`);
		return r.json();
	}

	async function post(path, body, retried) {
		const r = await fetch(path, {
			method: "POST",
			credentials: "same-origin",
			headers: {
				"Content-Type": "application/json",
				"X-JH": "1",
				"X-CSRF-Token": st.csrf || "",
			},
			body: JSON.stringify(body || {}),
		});
		const data = await r.json().catch(() => ({}));
		if (r.status === 403 && data.error === "csrf" && !retried) {
			await refresh(true);
			return post(path, body, true);
		}
		if (!r.ok)
			throw Object.assign(
				new Error(data.message || data.error || `HTTP ${r.status}`),
				{ code: data.error, status: r.status },
			);
		return data;
	}

	// ---------------------------------------------------------- rendering

	function badge(text, cls) {
		return text ? h("span", { class: `badge ${cls || ""}`, text }) : null;
	}

	function scoreClass(n) {
		if (n === null || n === undefined) return "";
		return n >= 80 ? "ok" : n >= 60 ? "warn" : "bad";
	}

	function cardActions(c) {
		if (st.readOnly) return null;
		const allowed =
			ACTION_COLUMNS.has(c.column) ||
			(c.column === "closed" && c.status === "ghosted");
		if (!allowed) return null;
		const wrap = h("div", { class: "actions" });
		for (const [action, label] of ACTIONS) {
			wrap.append(
				h("button", {
					type: "button",
					text: label,
					onclick: () => {
						st.openForm = { id: c.id, action, label };
						render();
					},
				}),
			);
		}
		const f = st.openForm;
		if (!f || f.id !== c.id) return wrap;
		const note = h("input", {
			maxlength: "500",
			placeholder: "Note (optional)",
			"aria-label": "Note",
		});
		const date = h("input", { type: "date", "aria-label": "Date" });
		const saveBtn = h("button", {
			type: "submit",
			class: "primary small",
			text: `Save: ${f.label}`,
		});
		const form = h(
			"form",
			{
				class: "act-form",
				onsubmit: async (ev) => {
					ev.preventDefault();
					saveBtn.disabled = true;
					const body = { action: f.action };
					if (note.value.trim()) body.note = note.value.trim();
					if (date.value) body.date = date.value;
					try {
						const r = await post(`/api/board/${c.id}/outcome`, body);
						say(
							r.changed
								? `${c.company}: ${r.from} → ${r.to}`
								: `${c.company}: ${f.label} recorded`,
						);
						st.openForm = null;
						await refresh(true);
					} catch (e) {
						say(
							e.code === "illegal_transition"
								? `Not allowed: ${e.message}`
								: `Error: ${e.message}`,
						);
						saveBtn.disabled = false;
					}
				},
			},
			h("div", { class: "row2" }, note, date),
			h(
				"div",
				{ class: "row2" },
				saveBtn,
				h("button", {
					type: "button",
					class: "ghost small",
					text: "Cancel",
					onclick: () => {
						st.openForm = null;
						render();
					},
				}),
			),
		);
		return [wrap, form];
	}

	function card(c) {
		const posting = safeHref(c.postingUrl);
		const resume = safeHref(c.resumeUrl);
		const posted = fmtDay(c.postedAt);
		const applied = fmtDay(c.appliedAt);
		return h(
			"article",
			{ class: `bcard${c.youAsked ? " asked" : ""}`, "data-id": c.id },
			h(
				"div",
				{ class: "badges" },
				c.youAsked
					? h("span", {
							class: "badge asked",
							text: "You asked",
							title: c.requestNote || "Added by you",
						})
					: null,
				badge(c.stage, c.stage === "Offer" ? "ok" : ""),
				c.atsScore !== null && c.atsScore !== undefined
					? badge(`ATS ${c.atsScore}`, scoreClass(c.atsScore))
					: null,
				badge(c.hmVerdict ? `HM ${c.hmVerdict}` : null),
				c.quality === "below_bar" ? badge("below bar", "warn") : null,
				c.answers ? badge(`form: ${c.answers}`) : null,
			),
			h("div", { class: "co", text: c.company }),
			h("div", { class: "ti", text: c.title }),
			h(
				"div",
				{ class: "meta" },
				c.location ? h("span", { text: c.location }) : null,
				posted ? h("span", { text: `posted ${posted}` }) : null,
				applied ? h("span", { text: `applied ${applied}` }) : null,
				h("span", { text: ago(c.lastEventAt), title: c.lastEventAt }),
			),
			c.reason ? h("div", { class: "reason", text: c.reason }) : null,
			posting || resume
				? h(
						"div",
						{ class: "links" },
						posting
							? h("a", {
									href: posting,
									target: "_blank",
									rel: "noopener noreferrer",
									text: "Posting",
								})
							: null,
						resume
							? h("a", {
									href: resume,
									target: "_blank",
									rel: "noopener",
									text: "Resume PDF",
								})
							: null,
					)
				: null,
			cardActions(c),
		);
	}

	function rangeControls(col) {
		const sel = h(
			"select",
			{
				"aria-label": "Applied date range",
				onchange: (ev) => {
					st.range = { ...st.range, preset: ev.target.value };
					save(KEY_RANGE, st.range);
					refresh(true);
				},
			},
			RANGES.map(([v, label]) =>
				h("option", { value: v, selected: st.range.preset === v, text: label }),
			),
		);
		const wrap = h("div", { class: "range" }, sel);
		if (st.range.preset === "custom") {
			const mk = (key, label) =>
				h("input", {
					type: "date",
					"aria-label": label,
					value: st.range[key] || "",
					onchange: (ev) => {
						st.range = { ...st.range, [key]: ev.target.value };
						save(KEY_RANGE, st.range);
						refresh(true);
					},
				});
			wrap.append(mk("from", "From"), mk("to", "To"));
		}
		wrap.title = `${col.count} of ${col.total} applied`;
		return wrap;
	}

	function column(col) {
		const head = h(
			"div",
			{ class: "col-head" },
			h("h2", { text: col.label }),
			h("span", {
				class: "col-count",
				text: String(col.count),
				title:
					col.id === "applied"
						? `${col.count} in range, ${col.total} total`
						: `${col.total} total`,
			}),
			col.id === "applied" ? rangeControls(col) : null,
		);
		const body = h(
			"div",
			{ class: "col-body" },
			col.cards.length
				? col.cards.map(card)
				: h("div", { class: "col-empty", text: "Nothing here" }),
		);
		return h(
			"section",
			{
				class: `col${st.col === col.id ? " active" : ""}`,
				"aria-label": col.label,
				id: `col-${col.id}`,
			},
			head,
			body,
		);
	}

	function lane(col) {
		const d = h(
			"details",
			{ class: "lane", open: st.lanesOpen.has(col.id) },
			h("summary", { text: `${col.label} (${col.count})` }),
			h(
				"div",
				{ class: "lane-body" },
				col.cards.length
					? col.cards.map(card)
					: h("div", { class: "col-empty", text: "Nothing here" }),
			),
		);
		d.addEventListener("toggle", () => {
			if (d.open) st.lanesOpen.add(col.id);
			else st.lanesOpen.delete(col.id);
		});
		return d;
	}

	function tabs(cols) {
		return cols.map((c) =>
			h("button", {
				type: "button",
				role: "tab",
				"aria-selected": st.col === c.id ? "true" : "false",
				text: `${c.label} ${c.count}`,
				onclick: () => {
					st.col = c.id;
					save(KEY_COL, c.id);
					render();
				},
			}),
		);
	}

	function render() {
		const b = st.board;
		if (!b) return;
		const cols = b.columns || [];
		const main = MAIN.map((id) => cols.find((c) => c.id === id)).filter(
			Boolean,
		);
		const lanes = LANES.map((id) => cols.find((c) => c.id === id)).filter(
			Boolean,
		);
		if (!main.some((c) => c.id === st.col)) st.col = "backlog";
		byId("board").replaceChildren(...main.map(column));
		byId("lanes").replaceChildren(...lanes.map(lane));
		byId("col-tabs").replaceChildren(...tabs(main));
		byId("link-form").hidden = st.readOnly;
		byId("board-status").textContent = st.readOnly
			? "Read-only view"
			: `Updated ${new Date(b.generatedAt).toLocaleTimeString()}`;
	}

	/** Re-render unless the user is typing inside the board (keeps their input). */
	async function refresh(force) {
		const active = document.activeElement;
		const typing =
			active &&
			byId("board-view").contains(active) &&
			(active.tagName === "INPUT" || active.tagName === "SELECT");
		try {
			const b = await fetchBoard();
			st.csrf = b.csrf;
			st.readOnly = Boolean(b.readOnly);
			st.board = b;
			if (force || (!typing && !st.openForm)) render();
		} catch (e) {
			byId("board-status").textContent =
				`Could not load the board (${e.message})`;
		}
	}

	// ---------------------------------------------------------- views

	function setView(view) {
		const board = view !== "overview";
		byId("board-view").hidden = !board;
		byId("overview-view").hidden = board;
		byId("tab-board").setAttribute("aria-pressed", String(board));
		byId("tab-overview").setAttribute("aria-pressed", String(!board));
		save(KEY_VIEW, board ? "board" : "overview");
		clearInterval(st.poll);
		if (board) {
			refresh(true);
			st.poll = setInterval(() => {
				if (!document.hidden) refresh(false);
			}, POLL_MS);
		}
	}

	function wire() {
		byId("tab-board").addEventListener("click", () => setView("board"));
		byId("tab-overview").addEventListener("click", () => setView("overview"));
		byId("link-form").addEventListener("submit", async (ev) => {
			ev.preventDefault();
			const url = byId("link-url").value.trim();
			const note = byId("link-note").value.trim();
			if (!url) return;
			const btn = byId("link-add");
			btn.disabled = true;
			try {
				const r = await post(
					"/api/board/links",
					note ? { url, note } : { url },
				);
				say(
					r.created
						? `Added: ${r.company} — ${r.title}`
						: `Already tracked: ${r.company} — ${r.title} (marked "You asked")`,
				);
				byId("link-url").value = "";
				byId("link-note").value = "";
				await refresh(true);
			} catch (e) {
				say(`Could not add: ${e.message}`);
			} finally {
				btn.disabled = false;
			}
		});
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden && !byId("board-view").hidden) refresh(false);
		});
	}

	document.addEventListener("DOMContentLoaded", () => {
		wire();
		setView(load(KEY_VIEW, "board"));
	});
})();
