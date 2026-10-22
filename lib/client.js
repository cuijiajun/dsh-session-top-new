/**
 * dsh-session-topnew — client bundle.
 *
 * A floating right-side session dock for the DeepSeek Harness Web GUI:
 *   1. Collapses to a round button; expands to show sessions from the last N
 *      days (default: today only, N configurable via a small popover).
 *   2. Live markers: "running" sessions show a pulsing dot; sessions with a
 *      pending interaction (unviewed result) show a badge. Clicking a session
 *      jumps straight to it.
 *   3. Plays a synthesized sound (Web Audio) when a session finishes (running
 *      -> completed / idle transition), with a mute toggle.
 *
 * Architecture (mirrors dsh-chat-pet):
 *   - Mounts into the `shell.overlay` list slot (root scope), so it floats
 *     above the whole app regardless of session/panel.
 *   - Reads the `sessions` client service via ctx.reflect.get("sessions"):
 *       sessions.list           -> observable snapshot store
 *         snapshot.ids          -> ordered session ids
 *         snapshot.byId[id]     -> { id, displayTitle, running, completed,
 *                                    blank, updatedAt, pendingInteraction, ... }
 *         snapshot.current      -> current session id
 *       sessions.open(id)       -> switch/jump to a session
 *   - The source exposes one inject-face Observable, `dock`, and the widget
 *     consumes it through a useSyncExternalStore-style selector hook.
 *
 * Hand-written in the __ModuleLoader__ factory format: the only host-provided
 * require is `react`; everything else is inline.
 */

window.__ModuleLoader__.load({
	id: "dsh-session-topnew",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");

		// ------------------------------------------------------------------
		// Small utils
		// ------------------------------------------------------------------

		const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

		/** Log a diagnostic at most once per message, so a broken path cannot spam. */
		const warned = new Set();
		function warnOnce(message, error) {
			if (warned.has(message)) return;
			warned.add(message);
			try {
				console.warn("[dsh-session-topnew] " + message, error ?? "");
			} catch {}
		}

		// ------------------------------------------------------------------
		// Icons — inline SVG, never emoji
		//
		// Emoji glyphs (🗂 ✕ 🔔 …) depend on a colour-emoji font being present in
		// the Electron font stack; when it is missing the glyph falls back to a
		// blank/odd silhouette (a white blob inside the round button). SVG keeps
		// the shapes exact and lets them inherit `currentColor`.
		// ------------------------------------------------------------------

		const SVG_PROPS = {
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			focusable: "false",
			style: { display: "block", flex: "none" }
		};

		/** Wrap icon children in a sized <svg>. */
		function svgIcon(size, children) {
			return React.createElement(
				"svg",
				Object.assign({ width: size, height: size }, SVG_PROPS),
				children
			);
		}

		/** Session list: three rows with leading dots. */
		function iconList(size) {
			return svgIcon(size, [
				React.createElement("circle", { key: "d1", cx: 4.5, cy: 6, r: 1.3, fill: "currentColor", stroke: "none" }),
				React.createElement("circle", { key: "d2", cx: 4.5, cy: 12, r: 1.3, fill: "currentColor", stroke: "none" }),
				React.createElement("circle", { key: "d3", cx: 4.5, cy: 18, r: 1.3, fill: "currentColor", stroke: "none" }),
				React.createElement("line", { key: "l1", x1: 9.5, y1: 6, x2: 20, y2: 6 }),
				React.createElement("line", { key: "l2", x1: 9.5, y1: 12, x2: 20, y2: 12 }),
				React.createElement("line", { key: "l3", x1: 9.5, y1: 18, x2: 20, y2: 18 })
			]);
		}

		/** Close (X). */
		function iconClose(size) {
			return svgIcon(size, [
				React.createElement("line", { key: "a", x1: 6, y1: 6, x2: 18, y2: 18 }),
				React.createElement("line", { key: "b", x1: 18, y1: 6, x2: 6, y2: 18 })
			]);
		}

		/** Bell, with a slash when muted. */
		function iconBell(size, muted) {
			const parts = [
				React.createElement("path", { key: "b", d: "M6.5 9a5.5 5.5 0 0 1 11 0c0 4.2 1.6 5.6 2.2 6.4H4.3c.6-.8 2.2-2.2 2.2-6.4z" }),
				React.createElement("path", { key: "c", d: "M10 19.2a2.1 2.1 0 0 0 4 0" })
			];
			if (muted) parts.push(React.createElement("line", { key: "m", x1: 4.5, y1: 19.5, x2: 19.5, y2: 4.5 }));
			return svgIcon(size, parts);
		}

		/** Disclosure chevron; `down` = expanded, `right` = collapsed. */
		function iconChevron(size, dir) {
			return svgIcon(size, React.createElement("polyline", {
				points: dir === "down" ? "6 9 12 15 18 9" : "9 6 15 12 9 18"
			}));
		}

		function dayStart(ts) {
			const d = new Date(ts);
			d.setHours(0, 0, 0, 0);
			return d.getTime();
		}

		/** Relative-ish short time label for a session (HH:mm today, else M/D). */
		function timeLabel(ts) {
			if (!ts) return "";
			const d = new Date(ts);
			const now = new Date();
			const sameDay = dayStart(d.getTime()) === dayStart(now.getTime());
			if (sameDay) {
				const hh = String(d.getHours()).padStart(2, "0");
				const mm = String(d.getMinutes()).padStart(2, "0");
				return hh + ":" + mm;
			}
			return (d.getMonth() + 1) + "/" + d.getDate();
		}

		// ------------------------------------------------------------------
		// Dock source (observable snapshot of sessions.list)
		// ------------------------------------------------------------------

		/**
		 * Read one Session's status row from the `uiSession.sessionStatus` source
		 * (a Map of sessionId -> { running, pendingInteraction, completionUnread }).
		 * Returns null when that service is unavailable (older builds).
		 */
		function statusOf(uiSession, id) {
			if (!uiSession) return null;
			try {
				const snap = uiSession.sessionStatus?.getSnapshot?.();
				if (!snap) return null;
				const row = typeof snap.get === "function" ? snap.get(id) : snap[id];
				return row || null;
			} catch {
				return null;
			}
		}

		function buildSnapshot(sessions, uiSession) {
			if (!sessions) return null;
			let list;
			try {
				list = sessions.list.getSnapshot();
			} catch {
				return null;
			}
			if (!list) return null;
			const ids = Array.isArray(list.ids) ? list.ids : [];
			const byId = list.byId || {};
			// Older builds exposed the selection as `list.current`; the current
			// Session Controller projects it through `byId[id].retainedBy.mainView`.
			let current = typeof list.current === "string" ? list.current : null;
			// Extract only the leaf fields we render (do not copy live objects).
			const items = [];
			for (const id of ids) {
				const s = byId[id];
				if (!s) continue;
				const retained = s.retainedBy || {};
				const isMain = (retained.mainView ?? 0) > 0;
				if (isMain) current = id;
				const st = statusOf(uiSession, id);
				const running = st && st.running !== undefined && st.running !== null
					? Boolean(st.running)
					: Boolean(s.running);
				const pendingRaw = st && st.pendingInteraction !== undefined ? st.pendingInteraction : s.pendingInteraction;
				items.push({
					id: id,
					title: typeof s.displayTitle === "string" ? s.displayTitle : (typeof s.title === "string" ? s.title : id),
					running: running,
					completed: Boolean(s.completed),
					blank: Boolean(s.blank),
					updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
					pending: pendingRaw !== undefined && pendingRaw !== false && pendingRaw !== null,
					unread: st ? Boolean(st.completionUnread) : false,
					isMain: isMain,
					parentId: typeof s.parentId === "string" ? s.parentId : null,
					isSubagent: s.origin === "subagent" || s.parentId !== undefined
				});
			}
			items.sort((a, b) => b.updatedAt - a.updatedAt);
			// The retained main view can sit outside `ids` (e.g. a session kept
			// alive only by its retention); fall back to scanning byId.
			if (current === null) {
				for (const id of Object.keys(byId)) {
					const s = byId[id];
					if (s && (s.retainedBy?.mainView ?? 0) > 0) {
						current = id;
						break;
					}
				}
			}
			return { items, current: current };
		}

		function snapshotsEqual(a, b) {
			if (a === b) return true;
			if (!a || !b) return false;
			if (a.current !== b.current) return false;
			if (a.items.length !== b.items.length) return false;
			for (let i = 0; i < a.items.length; i++) {
				const x = a.items[i];
				const y = b.items[i];
				if (x.id !== y.id || x.running !== y.running || x.completed !== y.completed ||
					x.pending !== y.pending || x.unread !== y.unread || x.isMain !== y.isMain ||
					x.updatedAt !== y.updatedAt || x.title !== y.title ||
					x.parentId !== y.parentId || x.isSubagent !== y.isSubagent) {
					return false;
				}
			}
			return true;
		}

		function createDockSource(ctx) {
			const listeners = new Set();
			let state = null;
			let sessions = null;
			let uiSession = null;
			let retryTimer = null;
			let unsubList = null;
			let unsubStatus = null;

			const readServices = () => {
				if (!sessions) sessions = ctxRef("sessions") || undefined;
				if (!uiSession) uiSession = ctxRef("uiSession") || undefined;
			};

			const emit = () => {
				// uiSession may mount after sessions; pick it up on a later emit.
				if (!uiSession) readServices();
				const next = buildSnapshot(sessions, uiSession);
				if (!snapshotsEqual(next, state)) state = next;
				for (const fn of [...listeners]) fn();
			};

			const bindStatus = () => {
				if (unsubStatus || !uiSession) return;
				try {
					const src = uiSession.sessionStatus;
					if (src && typeof src.subscribe === "function") unsubStatus = src.subscribe(emit);
				} catch {
					unsubStatus = null;
				}
			};

			const init = () => {
				readServices();
				if (!sessions || typeof sessions.list?.subscribe !== "function") {
					retryTimer = setTimeout(init, 300);
					return;
				}
				unsubList = sessions.list.subscribe(emit);
				bindStatus();
				emit();
			};

			init();

			return {
				subscribe(fn) {
					listeners.add(fn);
					if (listeners.size === 1 && state === null && sessions) emit();
					return () => {
						listeners.delete(fn);
					};
				},
				getSnapshot() {
					if (state === null) state = buildSnapshot(sessions, uiSession);
					return state;
				}
			};
		}

		// ------------------------------------------------------------------
		// Sound (Web Audio synthesized beep)
		// ------------------------------------------------------------------

		let audioCtx = null;
		function ensureAudioCtx() {
			if (!audioCtx) {
				const AC = window.AudioContext || window.webkitAudioContext;
				if (!AC) return null;
				audioCtx = new AC();
			}
			if (audioCtx.state === "suspended") {
				try { audioCtx.resume(); } catch {}
			}
			return audioCtx;
		}

		/** A short two-tone chime: pleasant but noticeable. */
		function playChime() {
			const ctx = ensureAudioCtx();
			if (!ctx) return;
			const now = ctx.currentTime;
			const notes = [
				{ f: 880, t: 0.00, d: 0.16 },
				{ f: 1174.66, t: 0.14, d: 0.22 }
			];
			for (const n of notes) {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = "sine";
				osc.frequency.value = n.f;
				gain.gain.setValueAtTime(0.0001, now + n.t);
				gain.gain.exponentialRampToValueAtTime(0.28, now + n.t + 0.02);
				gain.gain.exponentialRampToValueAtTime(0.0001, now + n.t + n.d);
				osc.connect(gain);
				gain.connect(ctx.destination);
				osc.start(now + n.t);
				osc.stop(now + n.t + n.d + 0.05);
			}
		}

		// ------------------------------------------------------------------
		// Styles
		// ------------------------------------------------------------------

		const STYLE_ID = "dsh-session-topnew-styles";
		function ensureStyles() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = `
				.dsd-root {
					position: absolute;
					z-index: 2147482900;
					display: flex;
					flex-direction: column;
					align-items: flex-end;
					pointer-events: auto;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
				}
				.dsd-btn { cursor: grab; }
				.dsd-btn.dragging { cursor: grabbing; }
				.dsd-btn {
					width: 46px;
					height: 46px;
					border-radius: 50%;
					border: none;
					cursor: pointer;
					background: rgba(24, 24, 28, 0.92);
					color: #f4f4f5;
					font-size: 20px;
					line-height: 1;
					display: flex;
					align-items: center;
					justify-content: center;
					box-shadow: 0 8px 24px rgba(0,0,0,0.35);
					transition: transform 0.12s ease, background 0.12s ease;
					position: relative;
				}
				.dsd-btn:hover { transform: scale(1.08); }
				.dsd-btn:active { transform: scale(0.94); }
				.dsd-btn .dsd-badge {
					position: absolute;
					top: -4px;
					right: -4px;
					min-width: 18px;
					height: 18px;
					padding: 0 5px;
					border-radius: 9px;
					background: #ef4444;
					color: #fff;
					font-size: 11px;
					font-weight: 700;
					line-height: 18px;
					text-align: center;
					box-shadow: 0 2px 6px rgba(0,0,0,0.3);
				}
				.dsd-panel {
					position: absolute;
					right: 0;
					top: calc(100% + 10px);
					width: 300px;
					max-height: 70vh;
					display: flex;
					flex-direction: column;
					background: rgba(24, 24, 28, 0.96);
					color: #f4f4f5;
					border-radius: 14px;
					box-shadow: 0 12px 36px rgba(0,0,0,0.4);
					overflow: hidden;
					opacity: 0;
					transform: translateX(8px) scale(0.96);
					transform-origin: top right;
					pointer-events: none;
					transition: opacity 0.16s ease, transform 0.16s ease;
				}
				.dsd-panel.show {
					opacity: 1;
					transform: translateX(0) scale(1);
					pointer-events: auto;
				}
				/* Open upward when the dock sits too low for a downward panel. */
				.dsd-panel.up {
					top: auto;
					bottom: calc(100% + 10px);
					transform-origin: bottom right;
				}
				/* Open rightward when the dock sits too far left for a 300px panel. */
				.dsd-panel.flipx { right: auto; left: 0; transform-origin: top left; }
				.dsd-panel.up.flipx { transform-origin: bottom left; }
				.dsd-head {
					flex: none;
					padding: 12px 14px 10px;
					border-bottom: 1px solid rgba(255,255,255,0.08);
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 8px;
				}
				.dsd-title { font-size: 14px; font-weight: 600; }
				.dsd-head-actions { display: flex; align-items: center; gap: 6px; }
				.dsd-iconbtn {
					background: none;
					border: none;
					color: #a1a1aa;
					cursor: pointer;
					font-size: 14px;
					line-height: 1;
					padding: 4px;
					border-radius: 6px;
				}
				.dsd-iconbtn:hover { color: #f4f4f5; background: rgba(255,255,255,0.08); }
				.dsd-days { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #a1a1aa; }
				.dsd-days input {
					width: 40px;
					background: rgba(255,255,255,0.08);
					border: 1px solid rgba(255,255,255,0.15);
					border-radius: 6px;
					color: #f4f4f5;
					font-size: 12px;
					padding: 3px 6px;
					text-align: center;
					outline: none;
				}
				.dsd-list {
					flex: 1 1 auto;
					overflow-y: auto;
					padding: 6px;
				}
				.dsd-list::-webkit-scrollbar { width: 8px; }
				.dsd-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
				.dsd-item {
					display: flex;
					align-items: center;
					gap: 8px;
					padding: 8px 10px;
					border-radius: 10px;
					cursor: pointer;
					transition: background 0.1s ease;
				}
				.dsd-item:hover { background: rgba(255,255,255,0.07); }
				.dsd-item.active { background: rgba(99, 102, 241, 0.22); }
				.dsd-dot {
					flex: none;
					width: 8px;
					height: 8px;
					border-radius: 50%;
					background: transparent;
				}
				.dsd-dot.running { background: #22c55e; animation: dsd-pulse 1.2s ease-in-out infinite; }
				.dsd-dot.pending { background: #f59e0b; }
				.dsd-dot.done { background: transparent; }
				.dsd-chevron {
					flex: none;
					width: 12px;
					display: flex;
					align-items: center;
					justify-content: center;
					color: #71717a;
					user-select: none;
					-webkit-user-select: none;
				}
				.dsd-chevron-on { cursor: pointer; }
				.dsd-chevron-on:hover { color: #f4f4f5; }
				.dsd-item.dsd-child {
					padding-left: 30px;
					padding-top: 6px;
					padding-bottom: 6px;
					font-size: 12px;
				}
				.dsd-item.dsd-child .dsd-item-title { color: #a1a1aa; }
				.dsd-item.dsd-child::before {
					content: "";
					flex: none;
					width: 1px;
					height: 14px;
					margin-right: 6px;
					background: rgba(255,255,255,0.14);
				}
				@keyframes dsd-pulse {
					0%, 100% { opacity: 1; transform: scale(1); }
					50% { opacity: 0.45; transform: scale(0.75); }
				}
				.dsd-item-title {
					flex: 1 1 auto;
					min-width: 0;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
					font-size: 13px;
				}
				.dsd-item.pending .dsd-item-title { font-weight: 600; }
				.dsd-item-time { flex: none; font-size: 11px; color: #71717a; }
				.dsd-empty { padding: 24px 12px; text-align: center; color: #71717a; font-size: 12px; }
				.dsd-foot {
					flex: none;
					padding: 8px 12px;
					border-top: 1px solid rgba(255,255,255,0.08);
					font-size: 11px;
					color: #71717a;
					text-align: center;
				}
			`;
			document.head.append(style);
		}

		// ------------------------------------------------------------------
		// Persistence (localStorage)
		// ------------------------------------------------------------------

		const DAYS_KEY = "dsh-session-topnew.days";
		const MUTE_KEY = "dsh-session-topnew.muted";
		const POS_KEY = "dsh-session-topnew.pos";

		/** Pre-rename keys, from when this plugin shipped as `dsh-session-dock`. */
		const LEGACY_KEYS = {
			days: "dsh-session-dock.days",
			muted: "dsh-session-dock.muted",
			pos: "dsh-session-dock.pos"
		};

		/**
		 * Read a stored string, falling back to the pre-rename key and migrating it
		 * forward — an existing install keeps its settings across the rename.
		 */
		function readStored(key, legacyKey) {
			try {
				const current = localStorage.getItem(key);
				if (current !== null) return current;
				if (legacyKey) {
					const legacy = localStorage.getItem(legacyKey);
					if (legacy !== null) {
						try {
							localStorage.setItem(key, legacy);
							localStorage.removeItem(legacyKey);
						} catch {}
						return legacy;
					}
				}
			} catch {}
			return null;
		}

		/** Dock button size (px) — the drag/anchoring unit. */
		const BTN = 46;
		/** Panel width (px) — used to decide which way the panel opens. */
		const PANEL_W = 300;
		/** Inset from the right edge while the dock is still at its default spot. */
		const EDGE_INSET = 18;

		function loadDays() {
			const n = parseInt(readStored(DAYS_KEY, LEGACY_KEYS.days), 10);
			if (Number.isFinite(n) && n >= 1) return n;
			return 1; // default: today only
		}

		function loadMuted() {
			return readStored(MUTE_KEY, LEGACY_KEYS.muted) === "1";
		}

		/**
		 * Stored dock position as a fraction of the available travel box
		 * (0..1 per axis), so the dock keeps its relative spot when the window is
		 * resized. Legacy absolute-pixel records are converted once on load.
		 * `null` means "still at the default anchor" (right edge, vertically centered).
		 */
		function loadPos() {
			const raw = readStored(POS_KEY, LEGACY_KEYS.pos);
			if (raw) {
				try {
					const p = JSON.parse(raw);
					// Number.isFinite (not typeof) so a corrupt NaN/null record can
					// never poison the layout — it simply falls back to the anchor.
					if (Number.isFinite(p.xp) && Number.isFinite(p.yp)) {
						return { xp: clamp(p.xp, 0, 1), yp: clamp(p.yp, 0, 1) };
					}
					if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
						const w = Math.max(1, window.innerWidth - BTN);
						const h = Math.max(1, window.innerHeight - BTN);
						return { xp: clamp(p.x / w, 0, 1), yp: clamp(p.y / h, 0, 1) };
					}
				} catch {}
			}
			return { xp: null, yp: null };
		}

		// ------------------------------------------------------------------
		// Widget
		// ------------------------------------------------------------------

		function DockWidget({ useDock }) {
			const dock = typeof useDock === "function" ? useDock((s) => s) : null;

			const [open, setOpen] = React.useState(true); // default expanded
			const [days, setDays] = React.useState(loadDays);
			const [muted, setMuted] = React.useState(loadMuted);
			const [pos, setPos] = React.useState(loadPos);
			const [dragging, setDragging] = React.useState(false);
			const [expandedParents, setExpandedParents] = React.useState({}); // id -> bool
			// Live size of the positioning container (the shell overlay layer), so
			// the dock re-anchors whenever the window or the frame resizes.
			const [viewport, setViewport] = React.useState(() => ({
				w: window.innerWidth,
				h: window.innerHeight
			}));
			const rootRef = React.useRef(null);

			const mutedRef = React.useRef(muted);
			mutedRef.current = muted;

			// Track running -> finished transitions for the sound alert.
			const prevRunningRef = React.useRef(null); // Map<id, bool>

			React.useEffect(() => {
				ensureStyles();
			}, []);

			// Keep `viewport` in step with the real positioning box. The dock lives
			// inside the shell overlay layer, so its offsetParent is that layer —
			// measuring it (rather than the window) stays correct when the frame
			// changes size for reasons other than a window resize.
			React.useEffect(() => {
				const el = rootRef.current;
				const target = (el && el.offsetParent) || el;
				const measure = () => {
					const w = (target && target.clientWidth) || window.innerWidth;
					const h = (target && target.clientHeight) || window.innerHeight;
					setViewport((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
				};
				measure();
				window.addEventListener("resize", measure);
				let observer = null;
				if (target && typeof ResizeObserver !== "undefined") {
					observer = new ResizeObserver(measure);
					observer.observe(target);
				}
				return () => {
					window.removeEventListener("resize", measure);
					if (observer) observer.disconnect();
				};
			}, []);

			React.useEffect(() => {
				const items = dock ? dock.items : [];
				// A session "finishes" when it stops running, or when the Session
				// controller flags a completion the user has not viewed yet.
				const prev = prevRunningRef.current;
				const next = {};
				for (const it of items) next[it.id] = it.running || it.unread;
				if (prev) {
					for (const id of Object.keys(prev)) {
						const wasBusy = prev[id] === true;
						const nowUnread = next[id] === true && !(items.find((it) => it.id === id) || {}).running;
						if (wasBusy && (next[id] === false || nowUnread)) {
							if (!mutedRef.current) playChime();
						}
					}
				}
				prevRunningRef.current = next;
			}, [dock]);

			const filtered = React.useMemo(() => {
				if (!dock) return [];
				const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
				return dock.items.filter((it) => it.updatedAt >= cutoff);
			}, [dock, days]);

			// Build a parent/child tree: top-level tasks are roots; subagent
			// sessions nest under their parent (matched by parentId).
			const tree = React.useMemo(() => {
				const byId = {};
				for (const it of filtered) byId[it.id] = it;
				const roots = [];
				const childrenOf = {};
				for (const it of filtered) {
					if (it.parentId && byId[it.parentId]) {
						(childrenOf[it.parentId] = childrenOf[it.parentId] || []).push(it);
					} else {
						roots.push(it);
					}
				}
				// Keep parents (by recency) first, then lone children.
				const sortByTime = (arr) => arr.sort((a, b) => b.updatedAt - a.updatedAt);
				sortByTime(roots);
				for (const k of Object.keys(childrenOf)) sortByTime(childrenOf[k]);
				return { roots, childrenOf };
			}, [filtered]);

			const unreadCount = React.useMemo(() => {
				return filtered.filter((it) => (it.pending || it.unread) && it.id !== (dock ? dock.current : null)).length;
			}, [filtered, dock]);

			const runningCount = React.useMemo(() => {
				return filtered.filter((it) => it.running).length;
			}, [filtered]);

			const onDaysChange = (e) => {
				const v = parseInt(e.target.value, 10);
				const n = Number.isFinite(v) ? clamp(v, 1, 365) : 1;
				setDays(n);
				try { localStorage.setItem(DAYS_KEY, String(n)); } catch {}
			};

			const toggleMute = () => {
				setMuted((m) => {
					const next = !m;
					mutedRef.current = next;
					try { localStorage.setItem(MUTE_KEY, next ? "1" : "0"); } catch {}
					return next;
				});
			};

			const onClickItem = (id) => {
				// Navigation belongs to the Workspace controller in current builds
				// (`uiWorkspace.openSession`); older builds exposed `sessions.open`.
				try {
					const ws = ctxRef("uiWorkspace");
					if (ws && typeof ws.openSession === "function") {
						ws.openSession(id);
						return;
					}
				} catch (error) {
					warnOnce("openSession failed", error);
				}
				try {
					const sessions = ctxRef("sessions");
					if (sessions && typeof sessions.open === "function") {
						sessions.open(id);
						return;
					}
				} catch (error) {
					warnOnce("sessions.open failed", error);
				}
				warnOnce("no session-open capability found on this DSH build");
				// Keep the panel open after jumping to a session.
			};

			// Drag the dock button. The spot is persisted as a fraction of the travel
			// box so it follows window resizes; the drag maths itself stays in px.
			const dragRef = React.useRef(null);
			const movedRef = React.useRef(false);
			const onBtnDown = React.useCallback((e) => {
				if (e.button !== 0) return; // left button only
				e.preventDefault();
				movedRef.current = false;
				const availW = Math.max(1, viewport.w - BTN);
				const availH = Math.max(1, viewport.h - BTN);
				// Resolve the current on-screen spot once: a stored fraction wins,
				// otherwise the default anchor (right edge, vertically centred).
				dragRef.current = {
					startX: e.clientX,
					startY: e.clientY,
					baseX: pos.xp == null ? availW - EDGE_INSET : clamp(pos.xp, 0, 1) * availW,
					baseY: pos.yp == null ? availH / 2 : clamp(pos.yp, 0, 1) * availH,
					lastXp: pos.xp,
					lastYp: pos.yp
				};
				const onMove = (ev) => {
					const d = dragRef.current;
					if (!d) return;
					const w = Math.max(1, viewport.w - BTN);
					const h = Math.max(1, viewport.h - BTN);
					const x = clamp(d.baseX + (ev.clientX - d.startX), 0, w);
					const y = clamp(d.baseY + (ev.clientY - d.startY), 0, h);
					if (Math.abs(ev.clientX - d.startX) > 4 || Math.abs(ev.clientY - d.startY) > 4) {
						movedRef.current = true;
						setDragging(true);
					}
					d.lastXp = x / w;
					d.lastYp = y / h;
					setPos({ xp: d.lastXp, yp: d.lastYp });
				};
				const onUp = () => {
					const d = dragRef.current;
					dragRef.current = null;
					setDragging(false);
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
					if (d && d.lastXp != null && d.lastYp != null) {
						try {
							localStorage.setItem(POS_KEY, JSON.stringify({ xp: d.lastXp, yp: d.lastYp }));
						} catch {}
					}
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
			}, [pos, viewport]);

			const onBtnClick = React.useCallback((e) => {
				if (movedRef.current) return; // it was a drag, not a click
				setOpen((o) => !o);
			}, []);

			const toggleParent = (id) => {
				setExpandedParents((prev) => {
					const next = { ...prev };
					next[id] = !prev[id];
					return next;
				});
			};

			const renderItem = (it, isChild) => {
				const active = it.isMain || (dock && dock.current === it.id);
				const flagged = it.pending || it.unread;
				const dotCls = it.running ? "dsd-dot running" : (flagged ? "dsd-dot pending" : "dsd-dot done");
				const kids = tree.childrenOf[it.id] || [];
				const hasKids = kids.length > 0;
				const expanded = !!expandedParents[it.id];
				const chevron = hasKids ? (expanded ? iconChevron(10, "down") : iconChevron(10, "right")) : null;
				return React.createElement(
					"div",
					{
						key: it.id,
						className: "dsd-item" + (isChild ? " dsd-child" : "") + (active ? " active" : "") + (flagged ? " pending" : ""),
						onClick: () => onClickItem(it.id),
						title: it.title
					},
					React.createElement(
						"span",
						{
							className: "dsd-chevron" + (hasKids ? " dsd-chevron-on" : ""),
							onClick: hasKids ? (e) => { e.stopPropagation(); toggleParent(it.id); } : undefined
						},
						chevron
					),
					React.createElement("span", { className: dotCls }),
					React.createElement("span", { className: "dsd-item-title" }, it.title),
					React.createElement("span", { className: "dsd-item-time" }, timeLabel(it.updatedAt))
				);
			};

			const items = [];
			for (const root of tree.roots) {
				items.push(renderItem(root, false));
				if (expandedParents[root.id]) {
					for (const child of (tree.childrenOf[root.id] || [])) {
						items.push(renderItem(child, true));
					}
				}
			}

			const availW = Math.max(1, viewport.w - BTN);
			const availH = Math.max(1, viewport.h - BTN);
			// A null axis means "still at the default anchor" (right edge, vertically
			// centred), which is inherently responsive. A stored fraction is resolved
			// against the CURRENT travel box, so a dragged dock tracks window resizes
			// instead of keeping stale pixel coordinates.
			const dockX = pos.xp == null ? null : clamp(pos.xp, 0, 1) * availW;
			const dockY = pos.yp == null ? null : clamp(pos.yp, 0, 1) * availH;
			const rootStyle = {
				left: dockX === null ? undefined : dockX,
				right: dockX === null ? EDGE_INSET : undefined,
				top: dockY === null ? "50%" : dockY,
				transform: dockY === null ? "translateY(-50%)" : undefined
			};
			// Flip the panel when the dock is too close to an edge to fit it —
			// `.frame` clips overflow, so an off-screen panel would be invisible.
			const dockLeft = dockX === null ? availW - EDGE_INSET : dockX;
			const dockTop = dockY === null ? availH / 2 : dockY;
			const panelFlipX = dockLeft + BTN - PANEL_W < 8;
			const panelUp = viewport.h - (dockTop + BTN) < 260;
			const panelCls = "dsd-panel"
				+ (open ? " show" : "")
				+ (panelFlipX ? " flipx" : "")
				+ (panelUp ? " up" : "");

			return React.createElement(
				"div",
				{ className: "dsd-root", style: rootStyle, ref: rootRef },
				React.createElement(
					"button",
					{
						className: "dsd-btn" + (dragging ? " dragging" : ""),
						onPointerDown: onBtnDown,
						onClick: onBtnClick,
						title: open ? "拖拽移动 · 点击收起" : "拖拽移动 · 点击展开",
						"aria-label": "会话列表"
					},
					unreadCount > 0
						? React.createElement("span", { className: "dsd-badge" }, unreadCount > 99 ? "99+" : String(unreadCount))
						: null,
					open ? iconClose(20) : iconList(20)
				),
				React.createElement(
					"div",
					{ className: panelCls },
					React.createElement(
						"div",
						{ className: "dsd-head" },
						React.createElement("span", { className: "dsd-title" }, "会话列表"),
						React.createElement(
							"div",
							{ className: "dsd-head-actions" },
							React.createElement(
								"span",
								{ className: "dsd-days" },
								"近 ",
								React.createElement("input", {
									type: "number",
									min: 1,
									max: 365,
									value: days,
									onChange: onDaysChange,
									"aria-label": "显示近 N 天"
								}),
								" 天"
							),
							React.createElement(
								"button",
								{ className: "dsd-iconbtn", onClick: toggleMute, title: muted ? "开启声音提醒" : "静音提醒" },
								muted ? iconBell(15, true) : iconBell(15, false)
							)
						)
					),
					React.createElement(
						"div",
						{ className: "dsd-list" },
						items.length === 0
							? React.createElement("div", { className: "dsd-empty" }, "暂无会话记录")
							: items
					),
					React.createElement(
						"div",
						{ className: "dsd-foot" },
						(runningCount > 0 ? runningCount + " 个进行中 · " : "") + unreadCount + " 个未读结果"
					)
				)
			);
		}

		// ------------------------------------------------------------------
		// Plugin entry
		// ------------------------------------------------------------------

		// A ref back to the client services this widget navigates through,
		// resolved lazily so it still works when a service mounts slightly after
		// this plugin's apply.
		let ctxRef = () => null;

		function apply(ctx) {
			ctxRef = (name) => {
				// ctx.get() reads an optional service without an inject declaration;
				// fall back to the reflection face for builds that only expose it there.
				try {
					const viaGet = ctx.get(name);
					if (viaGet !== undefined && viaGet !== null) return viaGet;
				} catch {}
				try {
					return ctx.reflect.get(name) ?? null;
				} catch {
					return null;
				}
			};

			ctx.effect(() => {
				ctx.slots.inject("shell.overlay", () =>
					ctx.slots.register({
						name: "shell.overlay",
						id: "dsh-session-topnew",
						registrant: "dsh-session-topnew",
						inject: () => ({ hooks: { dock: createDockSource(ctx) } })
					}, DockWidget)
				);
			}, "dsh-session-topnew: overlay dock");
		}

		/** ctx capabilities this plugin needs (gate for ctx.slots access). */
		const inject = ["slots"];

		module.exports = { apply, inject };
		return module.exports;
	}
});
