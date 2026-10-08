# Pomocnik pluginu Elemental USB: szuka urządzeń USB do bezpiecznego usuwania (tak jak ikona w zasobniku) i je wysuwa.
# Wypisuje linie JSON na stdout:
#   {"type":"list","devices":[{id,name,kind,letters,label,size}, ...]}
#   {"type":"eject","id":...,"ok":true}  /  {"type":"eject","id":...,"ok":false,"veto":N,"by":"explorer.exe"}
# Polecenia ze stdin (po jednym w linii): "list", "eject <instanceId>".
# Zasada wyboru (jak zasobnik): urządzenie wymienne (CM_DEVCAP_REMOVABLE), w którego poddrzewie jest coś,
# czego nie wolno wyrwać bez ostrzeżenia (brak CM_DEVCAP_SURPRISEREMOVALOK). Myszki, klawiatury, audio, Stream Deck tu nie trafiają.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ElementalUsb {
	[DllImport("cfgmgr32.dll")] static extern int CM_Locate_DevNodeW(out uint dn, IntPtr id, uint flags);
	[DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Locate_DevNodeW(out uint dn, string id, uint flags);
	[DllImport("cfgmgr32.dll")] static extern int CM_Get_Child(out uint child, uint dn, uint flags);
	[DllImport("cfgmgr32.dll")] static extern int CM_Get_Sibling(out uint sib, uint dn, uint flags);
	[DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_Device_IDW(uint dn, StringBuilder buf, int len, uint flags);
	[DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_DevNode_Registry_PropertyW(uint dn, uint prop, out uint type, byte[] buf, ref uint len, uint flags);
	[DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_DevNode_PropertyW(uint dn, ref DEVPROPKEY key, out uint type, byte[] buf, ref uint len, uint flags);
	[StructLayout(LayoutKind.Sequential)] struct DEVPROPKEY { public Guid fmtid; public uint pid; }
	[DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Request_Device_EjectW(uint dn, out int veto, StringBuilder name, int len, uint flags);

	const uint CM_DRP_DEVICEDESC = 0x1, CM_DRP_CLASS = 0x8, CM_DRP_CAPABILITIES = 0x10, CM_DRP_FRIENDLYNAME = 0xD;
	const uint CAP_REMOVABLE = 0x4, CAP_DOCK = 0x8, CAP_SURPRISE_OK = 0x80;

	public class Node { public uint Dn; public string Id; public string Name; public string BusName; public string Cls; public uint Caps; public Node Parent; public List<Node> Kids = new List<Node>(); }

	static string Id(uint dn) { var sb = new StringBuilder(512); return CM_Get_Device_IDW(dn, sb, sb.Capacity, 0) == 0 ? sb.ToString() : ""; }
	static byte[] Prop(uint dn, uint p) {
		uint t, len = 0; CM_Get_DevNode_Registry_PropertyW(dn, p, out t, null, ref len, 0);
		if (len == 0) return null; var b = new byte[len];
		return CM_Get_DevNode_Registry_PropertyW(dn, p, out t, b, ref len, 0) == 0 ? b : null;
	}
	static string Str(uint dn, uint p) { var b = Prop(dn, p); return b == null ? "" : Encoding.Unicode.GetString(b).TrimEnd('\0'); }
	static uint Caps(uint dn) { var b = Prop(dn, CM_DRP_CAPABILITIES); return b != null && b.Length >= 4 ? BitConverter.ToUInt32(b, 0) : 0; }

	/// Nazwa podana przez samo urządzenie (DEVPKEY_Device_BusReportedDeviceDesc) – tę pokazuje zasobnik.
	static string BusName(uint dn) {
		var key = new DEVPROPKEY { fmtid = new Guid("540b947e-8b40-45bc-a8a2-6a0b894cbda2"), pid = 4 };
		uint t, len = 0; CM_Get_DevNode_PropertyW(dn, ref key, out t, null, ref len, 0);
		if (len == 0) return ""; var b = new byte[len];
		return CM_Get_DevNode_PropertyW(dn, ref key, out t, b, ref len, 0) == 0 ? Encoding.Unicode.GetString(b).TrimEnd((char)0).Trim() : "";
	}

	static void Build(uint dn, Node parent, List<Node> all) {
		var n = new Node { Dn = dn, Id = Id(dn), Cls = Str(dn, CM_DRP_CLASS), Caps = Caps(dn), Parent = parent };
		var fn = Str(dn, CM_DRP_FRIENDLYNAME); n.Name = fn != "" ? fn : Str(dn, CM_DRP_DEVICEDESC);
		n.BusName = BusName(dn);
		if (parent != null) parent.Kids.Add(n);
		all.Add(n);
		uint c;
		if (CM_Get_Child(out c, dn, 0) != 0) return;
		do { Build(c, n, all); } while (CM_Get_Sibling(out c, c, 0) == 0);
	}

	static bool UnderUsb(Node n) { for (var p = n; p != null; p = p.Parent) if (p.Id.StartsWith("USB\\", StringComparison.OrdinalIgnoreCase)) return true; return false; }

	/// Urządzenia jak w "Bezpieczne usuwanie sprzętu", ograniczone do USB (najbliższy wymienny przodek).
	public static List<Node> Removable() {
		uint root; var all = new List<Node>(); var res = new List<Node>();
		if (CM_Locate_DevNodeW(out root, IntPtr.Zero, 0) != 0) return res;
		Build(root, null, all);
		foreach (var n in all) {
			if ((n.Caps & CAP_SURPRISE_OK) != 0 || n.Id.StartsWith("SWD\\", StringComparison.OrdinalIgnoreCase)) continue;
			Node top = null;
			for (var p = n; p != null; p = p.Parent) if ((p.Caps & CAP_REMOVABLE) != 0 && (p.Caps & CAP_DOCK) == 0) { top = p; break; }
			if (top == null || !UnderUsb(top) || res.Contains(top)) continue;
			res.Add(top);
		}
		return res;
	}

	// Console.In.ReadLineAsync w PowerShellu blokuje – polecenia czyta osobny wątek do kolejki.
	static readonly System.Collections.Concurrent.ConcurrentQueue<string> cmds = new System.Collections.Concurrent.ConcurrentQueue<string>();
	public static volatile bool StdinClosed;
	public static void StartReader() {
		var t = new System.Threading.Thread(() => { string l; while ((l = Console.In.ReadLine()) != null) cmds.Enqueue(l); StdinClosed = true; });
		t.IsBackground = true; t.Start();
	}
	public static string NextCommand() { string l; return cmds.TryDequeue(out l) ? l : null; }

	public static List<Node> Descendants(Node n) { var r = new List<Node>(); foreach (var k in n.Kids) { r.Add(k); r.AddRange(Descendants(k)); } return r; }

	/// Sygnatura listy – tania, do wykrywania zmian.
	public static string Signature() { var sb = new StringBuilder(); foreach (var n in Removable()) sb.Append(n.Id).Append('|'); return sb.ToString(); }

	/// 0 = sukces, inaczej kod weta PNP_VETO_TYPE (-1 = brak urządzenia, -2 = błąd CM bez weta)
	public static int Eject(string id, out string vetoName) {
		vetoName = ""; uint dn;
		if (CM_Locate_DevNodeW(out dn, id, 0) != 0) return -1;
		int veto; var sb = new StringBuilder(1024);
		int cr = CM_Request_Device_EjectW(dn, out veto, sb, sb.Capacity, 0);
		vetoName = sb.ToString();
		if (cr != 0 && veto == 0) return -2;
		return veto;
	}
}
'@

function J($s) { if ($null -eq $s) { return 'null' }; ConvertTo-Json -Compress -InputObject $s }

function KindOf($node, $disks) {
	$all = @($node) + @([ElementalUsb]::Descendants($node))
	$classes = @($all | ForEach-Object { $_.Cls })
	$hasDisk = $classes -contains 'DiskDrive'
	if (-not $hasDisk -and ($node.Id -match 'VID_1050&' -or $classes -contains 'SmartCardReader')) { return 'key' }
	if (-not $hasDisk -and $classes -contains 'WPD') { return 'phone' }
	if ($disks.Count -gt 0) {
		$d = $disks[0]
		if ($d.Model -match 'card|reader|SD/MMC|SDXC|SDHC|MMC|multi') { return 'card' }
		if ($d.MediaType -match 'External') { return 'drive' }
		return 'stick'
	}
	if ($hasDisk) { return 'stick' }
	return 'usb'
}

function List-Devices {
	$out = @()
	$diskInfo = @(Get-CimInstance Win32_DiskDrive)
	foreach ($n in [ElementalUsb]::Removable()) {
		$ids = @(@($n) + @([ElementalUsb]::Descendants($n)) | ForEach-Object { $_.Id.ToUpper() })
		$disks = @($diskInfo | Where-Object { $ids -contains ([string]$_.PNPDeviceID).ToUpper() })
		$letters = @(); $label = ''; $size = [int64]0
		foreach ($d in $disks) {
			$size += [int64]$d.Size
			foreach ($p in @(Get-Partition -DiskNumber $d.Index)) {
				if ($p.DriveLetter -and [char]::IsLetter($p.DriveLetter)) {
					$letters += "$($p.DriveLetter):"
					if (-not $label) { $label = (Get-Volume -DriveLetter $p.DriveLetter).FileSystemLabel }
				}
			}
		}
		# nazwa: od urządzenia (jak w zasobniku), potem model dysku, na końcu nazwa sterownika
		$name = $n.BusName
		if (-not $name -and $disks.Count -gt 0) { $name = ([string]$disks[0].Model) -replace '\s+USB Device$', '' }
		if (-not $name) { $name = $n.Name }
		$out += '{"id":' + (J $n.Id) + ',"name":' + (J ([string]$name)) + ',"kind":"' + (KindOf $n $disks) + '","letters":' + (J ([string]($letters -join ' '))) + ',"label":' + (J ([string]$label)) + ',"size":' + $size + '}'
	}
	'{"type":"list","devices":[' + ($out -join ',') + ']}'
}

function Eject-Device($id) {
	$since = Get-Date
	$vn = ''
	$v = [ElementalUsb]::Eject($id, [ref]$vn)
	if ($v -eq 0) { return '{"type":"eject","id":' + (J $id) + ',"ok":true}' }
	# Kto blokuje? Kernel-PnP zapisuje to w dzienniku System (zdarzenie 225) razem ze ścieżką programu.
	$by = ''
	Start-Sleep -Milliseconds 300
	$ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-PnP'; Id = 225; StartTime = $since.AddSeconds(-2) } -MaxEvents 1
	# pola zdarzenia: PID, ścieżka \Device\...\program.exe, linia poleceń, urządzenie – bierzemy pierwszą ścieżkę do .exe
	if ($ev) { $exe = $ev.Properties | ForEach-Object { [string]$_.Value } | Where-Object { $_ -match '\.exe"?\s*$' } | Select-Object -First 1
		if ($exe) { $by = [IO.Path]::GetFileName($exe.Trim().Trim('"')) } }
	'{"type":"eject","id":' + (J $id) + ',"ok":false,"veto":' + $v + ',"by":' + (J $by) + '}'
}

function Send($line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }

[ElementalUsb]::StartReader()
$lastSig = $null
$lastFull = [DateTime]::MinValue
while ($true) {
	if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid)) { exit }
	$force = $false
	while ($null -ne ($cmd = [ElementalUsb]::NextCommand())) {
		$cmd = $cmd.Trim()
		if ($cmd -eq 'list') { $force = $true }
		elseif ($cmd.StartsWith('eject ')) { Send (Eject-Device $cmd.Substring(6).Trim()); $force = $true }
	}
	if ([ElementalUsb]::StdinClosed) { exit }   # stdin zamknięte = plugin się zakończył
	$sig = [ElementalUsb]::Signature()
	# pełna lista przy zmianie urządzeń, na żądanie i co 10 s (litery i etykiety dochodzą chwilę po podłączeniu)
	if ($force -or $sig -ne $lastSig -or ((Get-Date) - $lastFull).TotalSeconds -ge 10) {
		Send (List-Devices)
		$lastSig = $sig; $lastFull = Get-Date
	}
	Start-Sleep -Milliseconds 700
}
