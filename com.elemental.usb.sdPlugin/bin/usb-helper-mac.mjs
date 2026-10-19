// Elemental USB helper for macOS. Same protocol as usb-helper.ps1:
//   stdout: {"type":"list","devices":[{id,name,kind,letters,label,size}, ...]}
//           {"type":"eject","id":...,"ok":true}  /  {"type":"eject","id":...,"ok":false,"veto":N,"by":"Finder"}
//   stdin : "list" or "eject <diskId>", one command per line.
// It only uses tools that ship with macOS: diskutil, plutil, lsof.
// Veto codes mirror the Windows ones used by plugin.ts: 6 = in use, 13 = no permission, -1 = already gone, -2 = other failure.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const POLL_MS = 2000;
const FULL_REFRESH_MS = 10_000;
const ID_RE = /^disk\d+$/;

/** Runs a command, optionally feeding stdin. Never rejects; resolves { code, out, err }. */
function run(cmd, args, { input, timeout = 15_000 } = {}) {
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let settled = false;
		const finish = (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, out, err });
		};
		let child;
		try {
			child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch {
			resolve({ code: -1, out, err });
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(-1);
		}, timeout);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", () => finish(-1));
		child.on("close", (code) => finish(code ?? -1));
		child.stdin.on("error", () => {});
		child.stdin.end(input ?? "");
	});
}

/** `diskutil ... -plist` -> JS object (plist converted to JSON by plutil). */
async function plist(args, opts) {
	const r = await run("diskutil", [...args, "-plist"], opts);
	if (r.code !== 0 || !r.out.trim()) return undefined;
	const j = await run("plutil", ["-convert", "json", "-o", "-", "-"], { input: r.out });
	if (j.code !== 0) return undefined;
	try {
		return JSON.parse(j.out);
	} catch {
		return undefined;
	}
}

const wholeDiskOf = (id) => /^(disk\d+)/.exec(String(id ?? ""))?.[1];

async function externalDiskIds() {
	const l = await plist(["list", "external", "physical"]);
	return Array.isArray(l?.WholeDisks) ? l.WholeDisks.filter((d) => ID_RE.test(d)).sort() : [];
}

const BUS_OK = /^(USB|Secure Digital)$/i;

function kindOf(info, size) {
	const model = String(info.MediaName ?? info.IORegistryEntryName ?? "");
	if (/secure digital/i.test(String(info.BusProtocol ?? "")) || /card|reader|SD\/MMC|SDXC|SDHC|MMC|multi/i.test(model)) return "card";
	if (/ssd|hdd|portable|passport|elements|my ?book|expansion|backup/i.test(model) || size >= 256e9) return "drive";
	return "stick";
}

/** Volumes (name + mount point) per whole disk, including APFS volumes that live in a synthesized container. */
async function volumesByDisk() {
	const map = new Map(); // diskN -> [{ name, mount }]
	const add = (disk, name, mount) => {
		if (!disk || (!name && !mount)) return;
		if (!map.has(disk)) map.set(disk, []);
		map.get(disk).push({ name: name ?? "", mount: mount ?? "" });
	};
	const all = await plist(["list"]);
	if (!all) return map;
	// APFS container (synthesized disk) -> physical disk it sits on
	const containerToPhysical = new Map();
	const apfs = await plist(["apfs", "list"]);
	for (const c of apfs?.Containers ?? []) {
		const store = c.DesignatedPhysicalStore ?? c.PhysicalStores?.[0]?.DeviceIdentifier;
		if (c.ContainerReference && store) containerToPhysical.set(c.ContainerReference, wholeDiskOf(store));
	}
	for (const d of all.AllDisksAndPartitions ?? []) {
		const disk = containerToPhysical.get(d.DeviceIdentifier) ?? d.DeviceIdentifier;
		for (const p of d.Partitions ?? []) add(disk, p.VolumeName, p.MountPoint);
		for (const v of d.APFSVolumes ?? []) add(disk, v.VolumeName, v.MountPoint);
	}
	return map;
}

async function listDevices() {
	const ids = await externalDiskIds();
	const volumes = ids.length ? await volumesByDisk() : new Map();
	const devices = [];
	for (const id of ids) {
		const info = await plist(["info", id]);
		if (!info || !BUS_OK.test(String(info.BusProtocol ?? ""))) continue; // USB sticks/drives and the built-in SD slot only
		if (info.WholeDisk === false) continue;
		const size = Number(info.TotalSize ?? info.Size ?? 0) || 0;
		const vols = (volumes.get(id) ?? []).filter((v) => v.name);
		const name = String(info.MediaName ?? info.IORegistryEntryName ?? id)
			.replace(/\s+(USB Device|Media)$/i, "")
			.trim() || id;
		devices.push({ id, name, kind: kindOf(info, size), letters: "", label: vols.map((v) => v.name).join(", "), size });
	}
	return devices;
}

/** Which program holds the volume? `diskutil` usually tells us ("dissented by PID n (path)"); lsof is the fallback. */
async function blockerOf(diskId, diskutilText) {
	const m = /dissented by PID \d+ \(([^)]+)\)/i.exec(diskutilText);
	if (m) return m[1].split("/").pop().replace(/\.app$/i, "");
	const vols = (await volumesByDisk()).get(diskId) ?? [];
	for (const v of vols) {
		if (!v.mount) continue;
		const r = await run("lsof", ["-F", "c", "--", v.mount], { timeout: 8000 });
		const line = r.out.split("\n").find((l) => l.startsWith("c"));
		if (line) return line.slice(1);
	}
	return "";
}

async function ejectDevice(id) {
	if (!ID_RE.test(id)) return { type: "eject", id, ok: false, veto: -2, by: "" };
	const now = await externalDiskIds();
	if (!now.includes(id)) return { type: "eject", id, ok: false, veto: -1, by: "" };
	const r = await run("diskutil", ["eject", id], { timeout: 60_000 });
	const text = `${r.out}\n${r.err}`;
	if (r.code === 0) return { type: "eject", id, ok: true };
	if (!(await externalDiskIds()).includes(id)) return { type: "eject", id, ok: true }; // gone in the meantime
	if (/not permitted|permission|privilege/i.test(text) && !/dissented/i.test(text)) return { type: "eject", id, ok: false, veto: 13, by: "" };
	const by = await blockerOf(id, text);
	const busy = !!by || /dissented|busy|in use|couldn't unmount|could not unmount/i.test(text);
	return { type: "eject", id, ok: false, veto: busy ? 6 : -2, by };
}

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// --- main loop ---
let lastSig = null;
let lastFull = 0;
let busy = false;
let forced = false;
const queue = [];

async function tick() {
	if (busy) return;
	busy = true;
	try {
		while (queue.length) {
			const cmd = queue.shift().trim();
			if (cmd === "list") forced = true;
			else if (cmd.startsWith("eject ")) {
				send(await ejectDevice(cmd.slice(6).trim()));
				forced = true;
			}
		}
		const sig = (await externalDiskIds()).join("|");
		if (forced || sig !== lastSig || Date.now() - lastFull >= FULL_REFRESH_MS) {
			send({ type: "list", devices: await listDevices() });
			lastSig = sig;
			lastFull = Date.now();
			forced = false;
		}
	} finally {
		busy = false;
	}
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => {
	queue.push(l);
	void tick();
});
rl.on("close", () => process.exit(0)); // plugin ended -> stdin closed
setInterval(() => void tick(), POLL_MS);
void tick();
