export type Kind = "stick" | "drive" | "card" | "key" | "phone" | "usb";

export type KeyView =
	| { mode: "device"; kind: Kind; title: string; line2?: string; line3?: string; index: number; count: number; hold: number }
	| { mode: "empty"; text: string }
	| { mode: "status"; kind: Kind; tone: "ok" | "busy" | "error"; title: string; line2?: string };

const FONT = `font-family="Segoe UI, Arial, sans-serif"`;
const FG = "#ffffff";
const SUB = "#b4bfd1";
const DIM = "#5b6478";

/** kolor ikony dla rodzaju urządzenia */
export const KIND_COLOR: Record<Kind, string> = {
	stick: "#4ea1ff",
	drive: "#ffa94d",
	card: "#5fd38d",
	key: "#ffd43b",
	phone: "#c792ea",
	usb: "#9aa5b8",
};
const TONE: Record<"ok" | "busy" | "error", string> = { ok: "#40c463", busy: "#ffb454", error: "#ff5c5c" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Przycina tekst do szerokości klawisza (przybliżona szerokość znaku Segoe UI). */
function fit(s: string, size: number, width = 130, bold = false): string {
	const max = Math.floor(width / (size * (bold ? 0.58 : 0.52)));
	return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

function text(y: number, s: string | undefined, size: number, color: string, bold = false): string {
	if (!s) return "";
	return `<text x="72" y="${y}" ${FONT} font-size="${size}" ${bold ? 'font-weight="600"' : ""} fill="${color}" text-anchor="middle">${esc(fit(s, size, 130, bold))}</text>`;
}

/** Ikony rysowane w polu 64x64, przesuwane na środek górnej części klawisza. */
function icon(kind: Kind, color: string, cx = 72, cy = 44, scale = 1): string {
	const s = `fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"`;
	let g = "";
	switch (kind) {
		case "stick": // pendrive: korpus + wtyk
			g = `<rect x="18" y="22" width="28" height="38" rx="6" ${s}/><rect x="23" y="4" width="18" height="18" rx="2" ${s}/>
				<rect x="27" y="9" width="4" height="5" fill="${color}"/><rect x="33" y="9" width="4" height="5" fill="${color}"/>
				<circle cx="32" cy="46" r="4" fill="${color}"/>`;
			break;
		case "drive": // dysk zewnętrzny
			g = `<rect x="6" y="12" width="52" height="40" rx="7" ${s}/><line x1="14" y1="40" x2="38" y2="40" ${s}/>
				<circle cx="48" cy="40" r="3.5" fill="${color}"/><line x1="14" y1="24" x2="50" y2="24" ${s} opacity=".45"/>`;
			break;
		case "card": // karta SD
			g = `<path d="M16 6 H44 L52 14 V58 H16 Z" ${s}/>
				<line x1="24" y1="12" x2="24" y2="22" ${s}/><line x1="31" y1="12" x2="31" y2="22" ${s}/><line x1="38" y1="12" x2="38" y2="22" ${s}/>
				<line x1="24" y1="44" x2="44" y2="44" ${s} opacity=".45"/>`;
			break;
		case "key": // klucz bezpieczeństwa (YubiKey)
			g = `<rect x="18" y="4" width="28" height="52" rx="8" ${s}/><circle cx="32" cy="46" r="4" ${s}/>
				<circle cx="32" cy="22" r="8" fill="${color}"/><rect x="25" y="56" width="14" height="6" rx="1" fill="${color}"/>`;
			break;
		case "phone":
			g = `<rect x="16" y="4" width="32" height="56" rx="6" ${s}/><line x1="28" y1="52" x2="36" y2="52" ${s}/>`;
			break;
		default: // symbol USB
			g = `<line x1="32" y1="8" x2="32" y2="54" ${s}/><path d="M26 14 L32 6 L38 14" ${s}/>
				<path d="M32 40 L18 30 V22" ${s}/><circle cx="18" cy="20" r="4" fill="${color}"/>
				<path d="M32 34 L46 26 V20" ${s}/><rect x="42" y="13" width="8" height="8" fill="${color}"/>
				<circle cx="32" cy="56" r="5" fill="${color}"/>`;
	}
	return `<g transform="translate(${cx - 32 * scale} ${cy - 32 * scale}) scale(${scale})">${g}</g>`;
}

function frame(inner: string, border = "#454e66"): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a3041"/><stop offset="1" stop-color="#141821"/></linearGradient></defs>
<rect x="1" y="1" width="142" height="142" rx="18" fill="url(#bg)" stroke="${border}" stroke-width="2"/>
${inner}</svg>`;
}

export function renderKey(v: KeyView): string {
	if (v.mode === "empty") {
		return frame(`${icon("usb", DIM, 72, 52, 0.95)}${text(118, v.text, 17, DIM, true)}`);
	}
	if (v.mode === "status") {
		const c = TONE[v.tone];
		const mark =
			v.tone === "ok"
				? `<circle cx="104" cy="58" r="15" fill="${c}"/><path d="M96 58 L102 64 L112 52" fill="none" stroke="#10241a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
				: v.tone === "error"
					? `<circle cx="104" cy="58" r="15" fill="${c}"/><path d="M98 52 L110 64 M110 52 L98 64" stroke="#2a0c0c" stroke-width="4" stroke-linecap="round"/>`
					: "";
		// dłuższe komunikaty ("Safe to remove") dostają mniejszą czcionkę zamiast ucięcia
		const size = Math.max(13, Math.min(18, Math.floor(130 / (v.title.length * 0.58))));
		return frame(`${icon(v.kind, KIND_COLOR[v.kind], 66, 42, 0.85)}${mark}${text(100, v.title, size, c, true)}${text(124, v.line2, 15, SUB)}`, c);
	}
	// urządzenie
	const color = KIND_COLOR[v.kind];
	const counter = v.count > 1 ? `<text x="130" y="24" ${FONT} font-size="15" font-weight="600" fill="${SUB}" text-anchor="end">${v.index + 1}/${v.count}</text>` : "";
	// pasek przytrzymania wzdłuż dołu klawisza
	const hold =
		v.hold > 0
			? `<rect x="10" y="132" width="124" height="6" rx="3" fill="#3f485e"/><rect x="10" y="132" width="${Math.round(124 * Math.min(1, v.hold))}" height="6" rx="3" fill="${TONE.busy}"/>`
			: "";
	const lines = v.line3
		? text(92, v.title, 20, FG, true) + text(111, v.line2, 15, SUB) + text(128, v.line3, 15, SUB)
		: text(98, v.title, 20, FG, true) + text(120, v.line2, 15, SUB);
	return frame(`${icon(v.kind, color, 72, 40, v.line3 ? 0.78 : 0.85)}${counter}${lines}${hold}`);
}

export const toDataUri = (svg: string) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
