import { Hono } from "hono";
import { run } from "../lib/exec.ts";

const r = new Hono();

const NOISY_PREFIXES = [
  "systemd-",
  "user@",
  "getty",
  "dbus",
  "cron",
  "network",
  "snap",
  "polkit",
  "udev",
  "rsyslog",
  "fwupd",
  "unattended",
  "apport",
  "console",
  "fail2ban",
  "chrony",
  "multipathd",
  "packagekit",
  "qemu",
  "serial",
  "man-db",
  "user-runtime",
  "ufw",
  "apparmor",
  "finalrd",
  "fstrim",
  "mdcheck",
  "atd",
  "auditd",
  "blk-availability",
  "cloud-",
  "e2scrub",
  "firewalld",
  "haveged",
  "irqbalance",
  "keyboard",
  "kmod",
  "lvm",
  "modprobe",
  "nfs",
  "nss",
  "plymouth",
  "pollinate",
  "rescue",
  "rsync",
  "shellinabox",
  "smartd",
  "sshd",
  "ssh.",
  "swap",
  "sysstat",
  "thermald",
  "tpm",
  "ua-",
  "wpa",
  "x11",
  "accounts-",
  "alsa",
  "avahi",
  "bluetooth",
  "colord",
  "gdm",
  "geoclue",
  "ModemManager",
  "NetworkManager",
  "power-profiles",
  "wsdd",
  "whoopsie",
  "zfs",
  "smbd",
  "nmbd",
  "samba",
  "cups",
  "saned",
  "brltty",
  "os-prober",
  "containerd",
  "docker",
];

function isNoisy(name: string): boolean {
  return NOISY_PREFIXES.some((p) => name.startsWith(p));
}

r.get("/units", async (c) => {
  const { ok, stdout, stderr } = await run(
    "systemctl list-units --type=service --all --no-pager --no-legend",
    5000,
  );
  if (!ok) return c.json({ error: stderr || "systemctl failed" }, 502);
  const units = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const cleaned = line.replace(/^[●○]\s+/, "");
      const cols = cleaned.split(/\s+/);
      const [name, load, active, sub, ...rest] = cols;
      return { name, load, active, sub, description: rest.join(" ") };
    })
    .filter((u) => u.name && !isNoisy(u.name));
  return c.json({
    count: units.length,
    flapping: units.filter(
      (u) => u.active === "activating" && u.sub === "auto-restart",
    ).length,
    units,
  });
});

export default r;
