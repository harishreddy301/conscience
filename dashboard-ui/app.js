// conscience dashboard client. Plain JS, no dependencies, CSP-safe (no inline code, no innerHTML).

const POLL_MS = 30_000;
const NOTIFY_LEAD_MIN = 5;
const OPEN_STATUSES = "applied,assessment,interviewing,offer";
const CLOSED_STATUSES = `${OPEN_STATUSES},rejected,ghosted`;

const state = {
	summary: null,
	timer: null,
	poll: null,
	hiddenTimer: null,
	showClosed: false,
	compareReturn: null,
};

// ------------------------------------------------------------ helpers

const $ = (id) => document.getElementById(id);

function el(tag, props, ...children) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") node.className = v;
		else if (k === "text") node.textContent = v;
		else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of children.flat()) {
		if (c === null || c === undefined || c === false) continue;
		node.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return node;
}

function replace(target, nodes) {
	target.replaceChildren(...nodes);
}

function emptyItem(text) {
	return el("li", { class: "empty", text });
}

function toast(msg) {
	const t = $("toast");
	t.textContent = msg;
	t.hidden = false;
	clearTimeout(toast.h);
	toast.h = setTimeout(() => {
		t.hidden = true;
	}, 3500);
}

async function getJson(path) {
	const r = await fetch(path, { headers: { Accept: "application/json" } });
	if (!r.ok)
		throw Object.assign(new Error(`${path}: ${r.status}`), {
			status: r.status,
		});
	return r.json();
}

async function postJson(path, body) {
	const r = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-JH": "1" },
		body: JSON.stringify(body || {}),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok)
		throw Object.assign(
			new Error(data.message || data.error || `HTTP ${r.status}`),
			{ code: data.error },
		);
	return data;
}

const pad = (n) => String(n).padStart(2, "0");

function fmtDuration(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function fmtMinutes(m) {
	const h = Math.floor(m / 60);
	return h ? `${h}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`;
}

function fmtWhen(iso) {
	if (!iso) return "unscheduled";
	return new Date(iso).toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function fmtDate(iso) {
	return iso
		? new Date(iso).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			})
		: "–";
}

function fmtCountdown(min) {
	if (min === null || min === undefined) return "";
	if (min < 0) return "now";
	if (min < 60) return `in ${min}m`;
	if (min < 48 * 60) return `in ${Math.floor(min / 60)}h ${min % 60}m`;
	return `in ${Math.round(min / 1440)}d`;
}

function ago(iso) {
	if (!iso) return "never";
	const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
	return `${Math.round(min / 1440)}d ago`;
}

const pct = (x) =>
	x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`;

// ------------------------------------------------------------ header

function renderSync(sync) {
	const chips = ["gmail", "calendar"].map((k) => {
		const f = sync[k];
		const cls = f.error ? "bad" : f.stale ? "stale" : "ok";
		const label = f.error ? `${k}: ${f.error}` : `${k} ${ago(f.lastOkAt)}`;
		return el("span", {
			class: `chip ${cls}`,
			title: f.lastOkAt ? `last ok ${f.lastOkAt}` : "never synced",
			text: label,
		});
	});
	replace($("sync-chips"), chips);
}

// ------------------------------------------------------------ study

function currentBlock(study) {
	return (
		study.blocks.find((b) => b.clocked_in) ||
		study.blocks.find((b) => b.state === "in_progress") ||
		study.blocks.find((b) => b.state === "upcoming") ||
		study.blocks[study.blocks.length - 1]
	);
}

function renderTimer() {
	const study = state.summary?.study;
	const t = $("timer");
	if (study?.open) {
		t.textContent = fmtDuration(Date.now() - Date.parse(study.open.started_at));
		t.classList.add("live");
	} else {
		t.textContent = "00:00:00";
		t.classList.remove("live");
	}
}

function renderStudy(study) {
	const open = Boolean(study.open);
	$("clock-in-form").hidden = open;
	$("clock-out-form").hidden = !open;
	const b = currentBlock(study);
	const stateEl = $("block-state");
	stateEl.textContent = b ? b.state.replace("_", " ") : "no block today";
	stateEl.className = `pill ${b?.state === "missed" ? "bad" : b?.state === "done" ? "ok" : ""}`;
	$("block-line").textContent = b
		? `${b.label} ${b.start_local}–${b.end_local} · ${fmtMinutes(b.minutes)} in block${open && study.open.topic ? ` · ${study.open.topic}` : ""}`
		: open
			? "Studying outside any block"
			: "No study block scheduled today";
	$("streak").textContent = String(study.streak);
	$("today-min").textContent = fmtMinutes(study.todayMinutes);
	const onTime = b?.on_time;
	$("on-time").textContent =
		onTime === null || onTime === undefined ? "–" : onTime ? "yes" : "late";
	const w = study.week;
	$("week-fill").style.width = `${w.pct}%`;
	$("week-bar").setAttribute("aria-valuenow", String(w.pct));
	$("week-line").textContent =
		`This week ${fmtMinutes(w.minutes)} of ${fmtMinutes(w.goalMinutes)} (${w.pct}%)`;
	renderBlocks(study.allBlocks.filter((x) => x.active));
	renderTasks(study.tasks);
	renderTimer();
}

function renderBlocks(blocks) {
	const items = blocks.map((b) => {
		const start = el("input", {
			type: "time",
			value: b.start_local,
			"aria-label": `${b.label} start`,
		});
		const end = el("input", {
			type: "time",
			value: b.end_local,
			"aria-label": `${b.label} end`,
		});
		const save = el("button", {
			type: "button",
			class: "small",
			text: "Save",
			onclick: async () => {
				try {
					await postJson(`/api/study/blocks/${b.id}`, {
						start: start.value,
						end: end.value,
					});
					toast(`${b.label} set to ${start.value}–${end.value}`);
					refresh();
				} catch (e) {
					toast(e.message);
				}
			},
		});
		return el("li", {}, el("span", { text: b.label }), start, "–", end, save);
	});
	replace(
		$("block-list"),
		items.length ? items : [emptyItem("No active blocks")],
	);
}

function renderTasks(tasks) {
	const items = tasks.map((t) => {
		const box = el("input", {
			type: "checkbox",
			checked: Boolean(t.done_at),
			disabled: Boolean(t.done_at),
			"aria-label": `done: ${t.title}`,
		});
		box.addEventListener("change", async () => {
			try {
				await postJson(`/api/study/tasks/${t.id}/done`);
				refresh();
			} catch (e) {
				toast(e.message);
				box.checked = false;
			}
		});
		return el(
			"li",
			{ class: t.done_at ? "done" : "" },
			box,
			el("span", { text: t.title }),
			t.planned_for
				? el("span", { class: "muted", text: t.planned_for })
				: null,
		);
	});
	replace(
		$("task-list"),
		items.length ? items : [emptyItem("Nothing planned")],
	);
}

// ------------------------------------------------------------ cards

function renderInterviews(list) {
	const items = list.map((i) => {
		const prep =
			i.prep_status === "ready" || i.prep_status === "done"
				? el("a", {
						href: `/api/interviews/${i.id}/prep`,
						target: "_blank",
						rel: "noopener",
						class: "pill ok",
						text: `prep ${i.prep_status}`,
					})
				: el("span", {
						class: `pill ${i.prep_status === "queued" ? "warn" : ""}`,
						text: `prep ${i.prep_status}`,
					});
		const join =
			i.meeting_link && /^https?:\/\//i.test(i.meeting_link)
				? el("a", {
						href: i.meeting_link,
						target: "_blank",
						rel: "noopener noreferrer",
						text: "Join",
					})
				: null;
		return el(
			"li",
			{},
			el(
				"div",
				{ class: "main" },
				el("div", {
					class: "title",
					text: `${i.company_name}${i.role ? ` · ${i.role}` : ""}`,
				}),
				el("div", {
					class: "muted",
					text: `${fmtWhen(i.start_at)} · ${i.round.replace("_", " ")}${i.status === "tentative" ? " · tentative" : ""}`,
				}),
			),
			el("span", { class: "pill", text: fmtCountdown(i.startsInMinutes) }),
			prep,
			join,
		);
	});
	replace(
		$("interviews"),
		items.length ? items : [emptyItem("No interviews in the next 14 days")],
	);
}

function renderReady(list) {
	const items = list.map((r) => {
		// Tailored but not yet applied: the moment the Resume vs JD panel matters most.
		const app = { id: r.applicationId, company: r.company, title: r.title };
		return el(
			"li",
			{
				class: "clickable",
				tabindex: "0",
				title: "Compare resume with JD",
				onclick: (ev) => {
					if (ev.target.closest("a")) return;
					openCompare(app, ev.currentTarget);
				},
				onkeydown: (ev) => {
					if (ev.target !== ev.currentTarget) return;
					if (ev.key === "Enter" || ev.key === " ") {
						ev.preventDefault();
						openCompare(app, ev.currentTarget);
					}
				},
			},
			el(
				"div",
				{ class: "main" },
				el("div", { class: "title", text: r.company }),
				el("div", { class: "muted", text: r.title }),
			),
			el("span", {
				class: `pill ${r.atsScore >= 80 ? "ok" : "warn"}`,
				text: `ATS ${r.atsScore ?? "–"}`,
			}),
			r.quality === "below_bar"
				? el("span", { class: "pill warn", text: "below bar" })
				: null,
			el("a", {
				href: `/artifacts/${r.applicationId}/resume.pdf`,
				target: "_blank",
				rel: "noopener",
				text: "PDF",
			}),
		);
	});
	replace(
		$("ready"),
		items.length ? items : [emptyItem("Nothing tailored and waiting")],
	);
}

function renderPipeline(p) {
	const order = [
		"shortlisted",
		"tailored",
		"applied",
		"assessment",
		"interviewing",
		"offer",
		"accepted",
		"rejected",
		"ghosted",
	];
	replace(
		$("pipeline"),
		order.map((k) =>
			el(
				"div",
				{},
				el("b", { text: String(p[k] ?? 0) }),
				el("span", { class: "muted", text: k }),
			),
		),
	);
}

function renderEmails(emails) {
	const n = emails.needsLinking;
	const badge = $("needs-linking");
	badge.hidden = !n;
	badge.textContent = `${n} need linking`;
	badge.title =
		"Run: jh email list --unlinked, then jh email link <emailId> <appId>";
	const items = emails.recent.map((e) =>
		el(
			"li",
			{},
			el(
				"div",
				{ class: "main" },
				el("div", { class: "title", text: e.subject || "(no subject)" }),
				el("div", {
					class: "muted",
					text: `${e.company || e.from_domain} · ${fmtDate(e.received_at)}`,
				}),
			),
			el("span", {
				class: `pill ${e.kind === "rejection" ? "bad" : e.kind === "interview_invite" ? "ok" : ""}`,
				text: e.kind.replace("_", " "),
			}),
			e.application_id
				? null
				: el("span", { class: "pill warn", text: "unlinked" }),
		),
	);
	replace(
		$("emails"),
		items.length ? items : [emptyItem("No email synced yet")],
	);
}

function renderAssessments(list) {
	const items = list.map((a) =>
		el(
			"li",
			{},
			el(
				"div",
				{ class: "main" },
				el("div", { class: "title", text: a.company || "Unknown company" }),
				el("div", { class: "muted", text: a.subject }),
			),
			el("span", {
				class: `pill ${a.dueAt && Date.parse(a.dueAt) - Date.now() < 86_400_000 ? "bad" : "warn"}`,
				text: a.dueAt ? `due ${fmtWhen(a.dueAt)}` : "no due date",
			}),
			a.link && /^https?:\/\//i.test(a.link)
				? el("a", {
						href: a.link,
						target: "_blank",
						rel: "noopener noreferrer",
						text: "Open",
					})
				: null,
		),
	);
	replace(
		$("assessments"),
		items.length ? items : [emptyItem("No open assessments")],
	);
}

function renderMetrics(pm) {
	$("metrics-count").textContent = String(pm.count);
	const items = pm.items.map((m) => {
		const decide = (action) => async () => {
			const body = { action };
			if (action === "edit") {
				const value = window.prompt(
					`Corrected value for: ${m.phrase}`,
					m.value,
				);
				if (value === null || !value.trim()) return;
				body.value = value.trim();
				const phrase = window.prompt(
					"Phrase as it should read on the resume",
					m.phrase,
				);
				if (phrase !== null && phrase.trim() && phrase.trim() !== m.phrase)
					body.phrase = phrase.trim();
			}
			try {
				await postJson(`/api/metrics/${encodeURIComponent(m.id)}`, body);
				toast(`${m.id} ${action === "edit" ? "edited" : `${action}ed`}`);
				refresh();
			} catch (e) {
				toast(e.message);
			}
		};
		return el(
			"li",
			{},
			el(
				"div",
				{ class: "main" },
				el("div", { class: "title", text: `${m.value} — ${m.phrase}` }),
				el("div", {
					class: "muted",
					text: m.derivation ? `${m.bullet_id}: ${m.derivation}` : m.bullet_id,
				}),
			),
			el("button", {
				type: "button",
				class: "small",
				text: "Accept",
				onclick: decide("accept"),
			}),
			el("button", {
				type: "button",
				class: "small",
				text: "Edit",
				onclick: decide("edit"),
			}),
			el("button", {
				type: "button",
				class: "small",
				text: "Reject",
				onclick: decide("reject"),
			}),
		);
	});
	replace(
		$("metrics"),
		items.length ? items : [emptyItem("No estimates waiting for you")],
	);
}

function bars(title, stats) {
	if (!stats || !stats.length) return [];
	const max = Math.max(...stats.map((s) => s.rate), 0.01);
	return [
		el("h3", { text: title }),
		...stats.slice(0, 5).map((s) => {
			const fill = el("span");
			fill.style.width = `${Math.round((s.rate / max) * 100)}%`;
			return el(
				"div",
				{ class: "bar" },
				el("span", { class: "label", title: s.value, text: s.value }),
				el("span", { class: "track" }, fill),
				el("span", { class: "muted", text: `${pct(s.rate)} n=${s.n}` }),
			);
		}),
	];
}

function renderLearn(l) {
	const card = $("learn-card");
	if (!l) {
		card.hidden = true;
		return;
	}
	card.hidden = false;
	const t = l.totals || {};
	const head = el(
		"div",
		{ class: "stats" },
		el(
			"div",
			{},
			el("span", { class: "big", text: pct(l.callback_rate) }),
			el("span", { class: "muted", text: "callback rate" }),
		),
		el(
			"div",
			{},
			el("span", { class: "big", text: String(t.submitted ?? 0) }),
			el("span", { class: "muted", text: "submitted" }),
		),
		el(
			"div",
			{},
			el("span", { class: "big", text: String(t.positive ?? 0) }),
			el("span", { class: "muted", text: "callbacks" }),
		),
	);
	const patterns = (l.top_patterns || []).map((p) =>
		el(
			"li",
			{},
			el(
				"div",
				{ class: "main" },
				el("div", { text: p.claim }),
				el("div", { class: "muted", text: `n=${p.n} · ${p.strength}` }),
			),
		),
	);
	replace($("learn"), [
		head,
		...bars("By framing", l.by_framing),
		...bars("By angle", l.by_angle),
		...bars("By title choice", l.by_title_choice),
		el("h3", { text: "Top patterns" }),
		el(
			"ul",
			{ class: "plain list" },
			patterns.length
				? patterns
				: [emptyItem("Not enough outcomes yet (patterns need n ≥ 3)")],
		),
	]);
}

// ------------------------------------------------------------ resume vs JD

function mark(ok) {
	return el("span", {
		class: `mark ${ok ? "ok" : "bad"}`,
		"aria-label": ok ? "covered" : "missing",
		text: ok ? "✓" : "✗",
	});
}

function compareJdColumn(c) {
	const s = c.snapshot;
	const meta = [s.seniority, s.location, s.remote, s.salary]
		.filter(Boolean)
		.join(" · ");
	return el(
		"section",
		{ class: "col" },
		el("h3", { text: "Job description" }),
		el("div", { class: "title", text: s.title_posted }),
		meta ? el("div", { class: "muted", text: meta }) : null,
		el("p", { class: "jd-summary", text: s.summary }),
		el("h3", { text: "Must-haves" }),
		el(
			"ul",
			{ class: "plain" },
			s.must_haves.map((t) => el("li", { text: t.term })),
		),
		c.nice_to_haves.length ? el("h3", { text: "Nice to have" }) : null,
		c.nice_to_haves.length
			? el(
					"ul",
					{ class: "plain" },
					c.nice_to_haves.map((n) =>
						el("li", {}, mark(n.covered), " ", n.term),
					),
				)
			: null,
		s.source_url && /^https?:\/\//i.test(s.source_url)
			? el("a", {
					href: s.source_url,
					target: "_blank",
					rel: "noopener noreferrer",
					text: "Original posting",
				})
			: null,
		el("div", {
			class: "muted",
			text: `captured ${fmtDate(s.captured_at)}`,
		}),
	);
}

function mustHaveItem(m) {
	const lines = m.evidence.filter((e) => e.kind === "bullet").slice(0, 2);
	const summary = m.evidence.find((e) => e.kind === "summary");
	return el(
		"li",
		{ class: m.covered ? "" : "missing" },
		el("div", {}, mark(m.covered), " ", el("b", { text: m.term })),
		...lines.map((e) =>
			el("div", { class: "evidence", title: e.id || "", text: e.text }),
		),
		!lines.length && summary
			? el("div", { class: "evidence", text: `summary: ${summary.text}` })
			: null,
		!m.covered && m.also_in.length
			? el("div", {
					class: "muted",
					text: `only in ${m.also_in.join(", ")} (not evidence)`,
				})
			: null,
	);
}

function compareResumeColumn(c) {
	const t = c.titles;
	const k = c.keywords;
	return el(
		"section",
		{ class: "col" },
		el("h3", { text: "Titles" }),
		el(
			"div",
			{},
			el("span", { class: "muted", text: "Headline: " }),
			t.headline,
			" ",
			el("span", {
				class: `pill ${t.headline_matches_posted ? "ok" : "warn"}`,
				text: t.headline_matches_posted ? "matches posted" : "differs",
			}),
			t.headline_in_targets === false
				? el("span", { class: "pill warn", text: "outside targets" })
				: null,
		),
		el(
			"ul",
			{ class: "plain" },
			t.display_titles.map((d) =>
				el(
					"li",
					{},
					el("span", { class: "muted", text: `${d.employer}: ` }),
					d.shown,
					d.uses_variant
						? el("span", {
								class: "muted",
								text: ` (approved variant of ${d.official})`,
							})
						: null,
				),
			),
		),
		el("h3", {
			text: `Must-haves ${c.must_haves.filter((m) => m.covered).length}/${c.must_haves.length}`,
		}),
		el("ul", { class: "plain must" }, c.must_haves.map(mustHaveItem)),
		el("h3", {
			text: `Keywords ${k.covered.length}/${k.total}${k.coverage_pct === null ? "" : ` (${k.coverage_pct}%)`}`,
		}),
		k.missing.length
			? el(
					"div",
					{ class: "chips" },
					k.missing.map((w) => el("span", { class: "chip bad", text: w })),
				)
			: el("div", { class: "muted", text: "No missing keywords" }),
	);
}

function renderCompare(c) {
	replace($("compare-body"), [compareJdColumn(c), compareResumeColumn(c)]);
}

async function openCompare(a, row) {
	const panel = $("compare-panel");
	state.compareReturn = row || null;
	$("compare-sub").textContent = `${a.company} · ${a.title}`;
	replace($("compare-body"), [el("div", { class: "muted", text: "Loading…" })]);
	panel.hidden = false;
	$("compare-close").focus();
	try {
		const r = await fetch(`/api/applications/${a.id}/compare`, {
			headers: { Accept: "application/json" },
		});
		const data = await r.json().catch(() => ({}));
		if (!r.ok) {
			replace($("compare-body"), [
				el("div", {
					class: "muted",
					text: data.message || `No comparison available (HTTP ${r.status})`,
				}),
			]);
			return;
		}
		renderCompare(data);
	} catch (e) {
		replace($("compare-body"), [
			el("div", { class: "muted", text: e.message }),
		]);
	}
}

function closeCompare() {
	const panel = $("compare-panel");
	if (panel.hidden) return;
	panel.hidden = true;
	if (state.compareReturn) state.compareReturn.focus();
	state.compareReturn = null;
}

async function loadApplications() {
	try {
		const rows = await getJson(
			`/api/applications?status=${state.showClosed ? CLOSED_STATUSES : OPEN_STATUSES}&limit=200`,
		);
		const tr = rows.map((a) =>
			el(
				"tr",
				{
					class: "clickable",
					tabindex: "0",
					title: "Compare resume with JD",
					onclick: (ev) => openCompare(a, ev.currentTarget),
					onkeydown: (ev) => {
						if (ev.key === "Enter" || ev.key === " ") {
							ev.preventDefault();
							openCompare(a, ev.currentTarget);
						}
					},
				},
				el("td", { text: a.company }),
				el("td", { text: a.title }),
				el(
					"td",
					{},
					el("span", {
						class: `pill ${a.status === "rejected" ? "bad" : a.status === "ghosted" ? "warn" : a.status === "interviewing" || a.status === "offer" ? "ok" : ""}`,
						text: a.status,
					}),
				),
				el("td", { text: fmtDate(a.applied_at) }),
				el("td", { class: "subject", text: a.lastEmailSubject || "–" }),
				el("td", { text: String(a.daysSinceLastEvent) }),
			),
		);
		replace(
			$("apps"),
			tr.length
				? tr
				: [
						el(
							"tr",
							{},
							el("td", {
								colspan: "6",
								class: "empty",
								text: "No applications in these statuses",
							}),
						),
					],
		);
	} catch (e) {
		toast(`applications: ${e.message}`);
	}
}

async function loadLearn() {
	try {
		renderLearn(await getJson("/api/learn"));
	} catch {
		renderLearn(null);
	}
}

// ------------------------------------------------------------ notifications

function notifyKey(b) {
	return `jh-notified-${b.block_id}-${b.start_at}`;
}

function checkStudyReminder() {
	const study = state.summary?.study;
	if (
		!study ||
		study.open ||
		!("Notification" in window) ||
		Notification.permission !== "granted"
	)
		return;
	for (const b of study.blocks) {
		if (b.state !== "upcoming") continue;
		const minsToStart = (Date.parse(b.start_at) - Date.now()) / 60000;
		if (minsToStart <= 0 || minsToStart > NOTIFY_LEAD_MIN) continue;
		let seen = false;
		try {
			seen = localStorage.getItem(notifyKey(b)) === "1";
			localStorage.setItem(notifyKey(b), "1");
		} catch {}
		if (seen) continue;
		new Notification(`${b.label} starts at ${b.start_local}`, {
			body: "You are not clocked in yet.",
			tag: notifyKey(b),
		});
	}
}

function setupNotifyButton() {
	const btn = $("notify-btn");
	if (!("Notification" in window) || Notification.permission !== "default")
		return;
	btn.hidden = false;
	btn.addEventListener("click", async () => {
		const p = await Notification.requestPermission();
		btn.hidden = p !== "default";
		if (p === "granted") toast("Study reminders on");
	});
}

// ------------------------------------------------------------ main loop

async function refresh() {
	try {
		const s = await getJson("/api/summary");
		state.summary = s;
		renderSync(s.sync);
		renderStudy(s.study);
		renderInterviews(s.interviews);
		renderReady(s.readyToApply);
		renderPipeline(s.pipeline);
		renderEmails(s.emails);
		renderAssessments(s.assessments);
		renderMetrics(s.pendingMetrics);
		$("refreshed").textContent = `updated ${new Date().toLocaleTimeString()}`;
		checkStudyReminder();
	} catch (e) {
		$("refreshed").textContent = `offline (${e.message})`;
	}
	loadApplications();
	loadLearn();
}

function startPolling() {
	stopPolling();
	state.poll = setInterval(refresh, POLL_MS);
	state.timer = setInterval(renderTimer, 1000);
}

function stopPolling() {
	clearInterval(state.poll);
	clearInterval(state.timer);
}

function wireForms() {
	$("clock-in-form").addEventListener("submit", async (ev) => {
		ev.preventDefault();
		const topic = $("topic").value.trim();
		try {
			await postJson("/api/study/clock-in", topic ? { topic } : {});
			$("topic").value = "";
			toast("Clocked in");
		} catch (e) {
			toast(e.code === "already_clocked_in" ? "Already clocked in" : e.message);
		}
		refresh();
	});
	$("clock-out-form").addEventListener("submit", async (ev) => {
		ev.preventDefault();
		const notes = $("notes").value.trim();
		try {
			const s = await postJson("/api/study/clock-out", notes ? { notes } : {});
			$("notes").value = "";
			toast(
				s.auto_closed
					? "Clocked out (capped at the session maximum)"
					: "Clocked out",
			);
		} catch (e) {
			toast(e.code === "not_clocked_in" ? "Not clocked in" : e.message);
		}
		refresh();
	});
	$("task-form").addEventListener("submit", async (ev) => {
		ev.preventDefault();
		const title = $("task-title").value.trim();
		if (!title) return;
		try {
			await postJson("/api/study/tasks", { title });
			$("task-title").value = "";
			refresh();
		} catch (e) {
			toast(e.message);
		}
	});
	$("compare-close").addEventListener("click", closeCompare);
	document.addEventListener("keydown", (ev) => {
		if (ev.key === "Escape") closeCompare();
	});
	$("show-closed").addEventListener("change", (ev) => {
		state.showClosed = ev.target.checked;
		loadApplications();
	});
}

/** While hidden, only re-check the study clock when a block is about to start. */
async function remindWhileHidden() {
	const study = state.summary?.study;
	if (!study) return;
	const soon = study.blocks.some((b) => {
		const m = (Date.parse(b.start_at) - Date.now()) / 60000;
		return b.state === "upcoming" && m > 0 && m <= NOTIFY_LEAD_MIN;
	});
	if (!soon) return;
	try {
		state.summary.study = await getJson("/api/study");
	} catch {}
	checkStudyReminder();
}

document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		stopPolling();
		state.hiddenTimer = setInterval(remindWhileHidden, 60_000);
	} else {
		clearInterval(state.hiddenTimer);
		refresh();
		startPolling();
	}
});

document.addEventListener("DOMContentLoaded", () => {
	wireForms();
	setupNotifyButton();
	refresh();
	startPolling();
});
