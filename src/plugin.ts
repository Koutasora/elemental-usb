import streamDeck, { action, KeyAction, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kind, KeyView, renderKey, toDataUri } from "./render";

type Settings = { holdMs?: number | string };
type GlobalSettings = { lang?: "auto" | "en" | "pl" };
type Device = { id: string; name: string; kind: Kind; letters: string; label: string; size: number };
type Status = { view: KeyView; until: number };
type Entry = {
	action: KeyAction<Settings>;
	settings: Settings;
	/** id wybranego urządzenia – zostaje wybrane, nawet gdy kolejność listy się zmieni */
	selected?: string;
	status?: Status;
	holdTimer?: NodeJS.Timeout;
	holdStart?: number;
	holdFired?: boolean;
};

const HOLD_DEFAULT = 800;
const HOLD_SHOW_AFTER = 150; // krótkie stuknięcie nie miga paskiem
const STATUS_MS = 5000;
const EJECT_TIMEOUT = 20_000;

const T = {
	en: { none: "No devices", ejecting: "Ejecting…", safe: "Safe to remove", inUse: "In use", failed: "Can't eject", gone: "Already removed", noRights: "No permission", unplug: "Unplug anytime" },
	pl: { none: "Brak urządzeń", ejecting: "Wysuwanie…", safe: "Można wyjąć", inUse: "W użyciu", failed: "Nie wysunięto", gone: "Już odłączone", noRights: "Brak uprawnień", unplug: "Wyjmuj śmiało" },
};

let lang: "en" | "pl" = "en";
let langChoice: GlobalSettings["lang"] = "auto";
let devices: Device[] = [];
let listed = false;
const visible = new Map<string, Entry>();
const tr = () => T[lang];

function applyLang(): void {
	const sd = streamDeck.info.application.language?.toLowerCase() ?? "en";
	lang = langChoice === "pl" || langChoice === "en" ? langChoice : sd.startsWith("pl") ? "pl" : "en";
}

// --- pomocnik PowerShell: lista urządzeń (przy każdej zmianie) i wysuwanie ---
let helper: ChildProcess | undefined;
let helperStartedAt = 0;
const ejectWaiters = new Map<string, (r: EjectResult) => void>();
type EjectResult = { ok: boolean; veto?: number; by?: string };

function ensureHelper(): void {
	if (helper || Date.now() - helperStartedAt < 5000) return;
	helperStartedAt = Date.now();
	const script = join(dirname(fileURLToPath(import.meta.url)), "usb-helper.ps1");
	const proc = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ParentPid", String(process.pid)], {
		windowsHide: true,
		stdio: ["pipe", "pipe", "ignore"],
	});
	helper = proc;
	createInterface({ input: proc.stdout! }).on("line", (line) => {
		let j: { type?: string; devices?: Device[]; id?: string } & EjectResult;
		try {
			j = JSON.parse(line);
		} catch {
			return;
		}
		if (j.type === "list" && Array.isArray(j.devices)) {
			devices = j.devices;
			listed = true;
			for (const e of visible.values()) void render(e);
		} else if (j.type === "eject" && j.id) {
			ejectWaiters.get(j.id)?.(j);
			ejectWaiters.delete(j.id);
		}
	});
	const done = () => {
		if (helper === proc) helper = undefined;
		for (const [id, w] of ejectWaiters) w({ ok: false, veto: -2 });
		ejectWaiters.clear();
		if (visible.size) setTimeout(ensureHelper, 5000);
	};
	proc.on("exit", done);
	proc.on("error", done);
	process.on("exit", () => proc.kill());
}

function send(cmd: string): void {
	ensureHelper();
	helper?.stdin?.write(cmd + "\n");
}

function eject(id: string): Promise<EjectResult> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			ejectWaiters.delete(id);
			resolve({ ok: false, veto: -2 });
		}, EJECT_TIMEOUT);
		ejectWaiters.set(id, (r) => {
			clearTimeout(timer);
			resolve(r);
		});
		send(`eject ${id}`);
	});
}

// --- widok klawisza ---
const holdMsOf = (s: Settings) => Number(s.holdMs) || HOLD_DEFAULT;

function formatSize(bytes: number): string {
	if (!bytes) return "";
	const gb = bytes / 1e9;
	const n = gb >= 1000 ? gb / 1000 : gb;
	const unit = gb >= 1000 ? "TB" : "GB";
	const txt = n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, "");
	return `${lang === "pl" ? txt.replace(".", ",") : txt} ${unit}`;
}

/** Dzieli dłuższą nazwę na dwie linie po słowie (np. "YubiKey" / "OTP+FIDO+CCID"). */
function splitName(name: string, max = 11): [string, string | undefined] {
	if (name.length <= max) return [name, undefined];
	const words = name.split(/\s+/);
	let first = words.shift() ?? name;
	while (words.length && first.length + 1 + words[0].length <= max) first += " " + words.shift();
	return [first, words.join(" ") || undefined];
}

function current(e: Entry): { dev: Device; index: number } | undefined {
	if (!devices.length) return undefined;
	let index = devices.findIndex((d) => d.id === e.selected);
	if (index < 0) index = 0;
	e.selected = devices[index].id;
	return { dev: devices[index], index };
}

function deviceView(dev: Device, index: number, hold: number): KeyView {
	const base = { mode: "device" as const, kind: dev.kind, index, count: devices.length, hold };
	const size = formatSize(dev.size);
	if (dev.letters) {
		const title = dev.label ? `${dev.letters.split(" ")[0]} ${dev.label}` : dev.letters;
		return { ...base, title, line2: dev.name, line3: size || undefined };
	}
	const [title, rest] = splitName(dev.name);
	if (dev.kind === "key") return { ...base, title, line2: rest, line3: tr().unplug };
	return { ...base, title, line2: rest ?? (size || undefined), line3: rest ? size || undefined : undefined };
}

async function render(e: Entry): Promise<void> {
	let view: KeyView;
	if (e.status && e.status.until > Date.now()) view = e.status.view;
	else {
		e.status = undefined;
		const cur = current(e);
		if (!cur) view = { mode: "empty", text: listed ? tr().none : "…" };
		else {
			const held = e.holdStart && !e.holdFired ? Date.now() - e.holdStart : 0;
			const hold = held > HOLD_SHOW_AFTER ? held / holdMsOf(e.settings) : 0;
			view = deviceView(cur.dev, cur.index, hold);
		}
	}
	await e.action.setImage(toDataUri(renderKey(view)));
}

function setStatus(e: Entry, view: KeyView, ms = STATUS_MS): void {
	e.status = { view, until: Date.now() + ms };
	void render(e);
	setTimeout(() => void render(e), ms + 50);
}

function vetoText(r: EjectResult): string | undefined {
	if (r.by) return r.by;
	if (r.veto === 13) return tr().noRights;
	return undefined;
}

async function doEject(e: Entry, dev: Device): Promise<void> {
	setStatus(e, { mode: "status", kind: dev.kind, tone: "busy", title: tr().ejecting, line2: dev.letters || splitName(dev.name)[0] }, EJECT_TIMEOUT);
	const r = await eject(dev.id);
	const name = dev.letters || splitName(dev.name)[0];
	if (r.ok || r.veto === 14 || r.veto === -1) {
		setStatus(e, { mode: "status", kind: dev.kind, tone: "ok", title: r.ok ? tr().safe : tr().gone, line2: name });
	} else {
		const inUse = r.veto === 6 || r.veto === 3 || r.veto === 4 || r.veto === 5 || !!r.by;
		setStatus(e, { mode: "status", kind: dev.kind, tone: "error", title: inUse ? tr().inUse : tr().failed, line2: vetoText(r) ?? name });
	}
	send("list");
}

function stopHold(e: Entry): void {
	if (e.holdTimer) clearInterval(e.holdTimer);
	e.holdTimer = undefined;
	e.holdStart = undefined;
}

@action({ UUID: "com.elemental.usb.eject" })
class EjectAction extends SingletonAction<Settings> {
	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const e: Entry = visible.get(ev.action.id) ?? { action: ev.action, settings: ev.payload.settings };
		e.action = ev.action;
		e.settings = ev.payload.settings;
		visible.set(ev.action.id, e);
		ensureHelper();
		await render(e);
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		const e = visible.get(ev.action.id);
		if (e) stopHold(e);
		visible.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
		const e = visible.get(ev.action.id);
		if (!e) return;
		e.settings = ev.payload.settings;
		await render(e);
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const e = visible.get(ev.action.id);
		if (!e) return;
		stopHold(e);
		e.holdFired = false;
		if (e.status && e.status.until > Date.now() && e.status.view.mode === "status" && e.status.view.tone === "busy") return; // trwa wysuwanie
		e.status = undefined;
		const cur = current(e);
		if (!cur) {
			send("list");
			await render(e);
			return;
		}
		e.holdStart = Date.now();
		e.holdTimer = setInterval(() => {
			if (!e.holdStart) return;
			if (Date.now() - e.holdStart >= holdMsOf(e.settings)) {
				e.holdFired = true;
				stopHold(e);
				const now = current(e);
				if (now) void doEject(e, now.dev);
				return;
			}
			void render(e);
		}, 60);
	}

	override async onKeyUp(ev: KeyUpEvent<Settings>): Promise<void> {
		const e = visible.get(ev.action.id);
		if (!e) return;
		const wasHolding = !!e.holdStart;
		stopHold(e);
		if (e.holdFired || !wasHolding) return;
		// krótkie naciśnięcie: następne urządzenie
		const cur = current(e);
		if (cur && devices.length > 1) e.selected = devices[(cur.index + 1) % devices.length].id;
		await render(e);
	}
}

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
	langChoice = ev.settings.lang ?? "auto";
	applyLang();
	for (const e of visible.values()) void render(e);
});

streamDeck.actions.registerAction(new EjectAction());
await streamDeck.connect();
applyLang();
const g = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
langChoice = g.lang ?? "auto";
applyLang();
for (const e of visible.values()) void render(e);
