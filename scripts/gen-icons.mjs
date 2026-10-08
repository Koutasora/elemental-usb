// Generuje ikony PNG pluginu (manifest) z SVG – rysuje je Edge w trybie headless.
// Uruchom: npm run icons
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const out = resolve("com.elemental.usb.sdPlugin/imgs");
const tmp = mkdtempSync(join(tmpdir(), "elemental-usb-icons-"));

await build({ entryPoints: ["src/render.ts"], bundle: true, format: "esm", platform: "node", outfile: join(tmp, "render.mjs") });
const { renderKey } = await import(pathToFileURL(join(tmp, "render.mjs")).href);

// symbol USB w polu 64x64 (kolor podawany), wspólny dla ikon jednokolorowych
const usb = (c, w = 5) => `<g fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">
<line x1="32" y1="8" x2="32" y2="52"/><path d="M25 15 L32 6 L39 15"/><path d="M32 40 L17 30 V23"/><path d="M32 33 L47 25 V19"/></g>
<circle cx="17" cy="21" r="4.5" fill="${c}"/><rect x="42.5" y="12.5" width="9" height="9" fill="${c}"/><circle cx="32" cy="55" r="5.5" fill="${c}"/>`;
// symbol wysuwania (trójkąt + kreska)
const ejectSym = (c) => `<path d="M32 10 L54 38 H10 Z" fill="${c}" stroke="${c}" stroke-width="4" stroke-linejoin="round"/><rect x="10" y="46" width="44" height="8" rx="2" fill="${c}"/>`;
const svg64 = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${body}</svg>`;

const plugin = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a3041"/><stop offset="1" stop-color="#141821"/></linearGradient></defs>
<rect x="4" y="4" width="136" height="136" rx="28" fill="url(#bg)" stroke="#454e66" stroke-width="3"/>
<g transform="translate(22 22) scale(1.25)">${usb("#4ea1ff", 5)}</g>
<g transform="translate(86 84) scale(0.75)"><circle cx="32" cy="32" r="30" fill="#141821"/><g transform="translate(9 9) scale(0.72)">${ejectSym("#ffb454")}</g></g></svg>`;

const keyDefault = renderKey({ mode: "device", kind: "stick", title: "E: USB", line2: "Elemental USB", line3: "", index: 0, count: 1, hold: 0 });

const icons = [
	["plugin-icon", plugin, 256],
	["category-icon", svg64(usb("#ffffff", 5)), 28],
	["action-icon", svg64(ejectSym("#ffffff")), 20],
	["key-default", keyDefault, 72],
];

for (const [name, svg, size] of icons) {
	for (const [suffix, px] of [["", size], ["@2x", size * 2]]) {
		const html = join(tmp, `${name}${suffix}.html`);
		const scaled = svg.replace(/width="\d+" height="\d+"/, `width="${px}" height="${px}"`);
		writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${scaled}</body></html>`);
		const png = join(out, `${name}${suffix}.png`);
		if (existsSync(png)) unlinkSync(png);
		// Edge czasem nic nie zapisuje (gdy poprzednia instancja jeszcze się zamyka) – kilka prób, każda z osobnym profilem
		for (let i = 0; i < 5 && !existsSync(png); i++) {
			try {
				execFileSync(EDGE, ["--headless", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${join(tmp, `p${name}${suffix}${i}`)}`, "--default-background-color=00000000", `--window-size=${px},${px}`, `--screenshot=${png}`, pathToFileURL(html).href], { stdio: "ignore", timeout: 30000 });
			} catch {}
			// plik bywa zapisywany chwilę po wyjściu procesu startowego Edge
			for (let w = 0; w < 40 && !existsSync(png); w++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		}
		if (!existsSync(png)) throw new Error(`nie powstał ${png}`);
	}
}
rmSync(tmp, { recursive: true, force: true });
console.log("icons ->", out);
