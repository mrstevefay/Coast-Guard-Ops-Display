import type { Run } from '../../src/device/wifi.js';

/**
 * A small fake NetworkManager: one Wi-Fi device, optional Ethernet, saved profiles,
 * nearby networks, and per-SSID passwords that decide whether `connection up` works.
 */
export function fakeNm(init: { eth?: boolean; active?: string; saved?: { name: string; ssid: string; prio?: number }[] } = {}) {
  let n = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  const profiles = (init.saved ?? []).map((s) => ({ uuid: uuid(), name: s.name, ssid: s.ssid, prio: s.prio ?? 0, psk: 'right-password', hidden: false }));
  let active = profiles.find((p) => p.ssid === init.active)?.uuid;
  const nearby = [
    { ssid: 'Station', signal: 70, security: 'WPA2' },
    { ssid: 'Station', signal: 40, security: 'WPA2' },
    { ssid: 'Harbour:Guest', signal: 55, security: 'WPA1 WPA2' },
    { ssid: 'NewOnly', signal: 30, security: 'WPA3' },
    { ssid: 'Cafe', signal: 20, security: '' },
    { ssid: '', signal: 60, security: 'WPA2' },
  ];
  const passwords: Record<string, string> = { Station: 'right-password', 'Harbour:Guest': 'right-password', NewOnly: 'right-password', Home: 'right-password' };
  const calls: string[][] = [];
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  const activeSsid = () => profiles.find((p) => p.uuid === active)?.ssid;

  const run: Run = async (args) => {
    calls.push(args);
    const a = args.join(' ');
    if (a === '-t -f DEVICE,TYPE,STATE,CONNECTION device status') {
      return [`wlan0:wifi:${active ? 'connected' : 'disconnected'}:${active ? esc(profiles.find((p) => p.uuid === active)!.name) : ''}`, init.eth ? 'eth0:ethernet:connected:Wired connection 1' : 'eth0:ethernet:unavailable:', 'lo:loopback:connected (externally):lo'].join('\n');
    }
    if (a.startsWith('-t -f IP4.ADDRESS device show')) return args[5] === 'wlan0' ? 'IP4.ADDRESS[1]:192.168.10.23/24\n' : 'IP4.ADDRESS[1]:192.168.10.5/24\n';
    if (a === '-t radio wifi') return 'enabled\n';
    if (a.startsWith('-t -f IN-USE,SSID,SIGNAL') && a.includes('device wifi list')) {
      return nearby.map((w) => `${w.ssid === activeSsid() ? '*' : ' '}:${esc(w.ssid)}:${w.signal}${a.includes('SECURITY') ? `:${w.security || '--'}` : ''}`).join('\n');
    }
    if (a === '-t -f NAME,UUID,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY,ACTIVE connection show') {
      return [...profiles.map((p) => `${esc(p.name)}:${p.uuid}:802-11-wireless:yes:${p.prio}:${p.uuid === active ? 'yes' : 'no'}`), 'Wired connection 1:aaaa:802-3-ethernet:yes:0:no'].join('\n');
    }
    if (args[1] === '-g' && args[2] === '802-11-wireless.ssid') return esc(profiles.find((p) => p.uuid === args[6])!.ssid) + '\n';
    if (args[0] === 'connection' && args[1] === 'add') {
      const p = { uuid: uuid(), name: args[args.indexOf('con-name') + 1], ssid: args[args.indexOf('ssid') + 1], prio: 0, psk: args.includes('wifi-sec.psk') ? args[args.indexOf('wifi-sec.psk') + 1] : '', hidden: args.includes('802-11-wireless.hidden') };
      profiles.push(p);
      return `Connection '${p.name}' (${p.uuid}) successfully added.\n`;
    }
    if (args[0] === 'connection' && args[1] === 'modify') {
      const p = profiles.find((x) => x.uuid === args[3])!;
      if (args.includes('wifi-sec.psk')) p.psk = args[args.indexOf('wifi-sec.psk') + 1];
      if (args.includes('connection.autoconnect-priority')) p.prio = Number(args[args.indexOf('connection.autoconnect-priority') + 1]);
      return '';
    }
    if (args[0] === 'connection' && args[1] === 'delete') {
      const i = profiles.findIndex((x) => x.uuid === args[3]);
      if (i >= 0) profiles.splice(i, 1);
      if (active === args[3]) active = undefined;
      return '';
    }
    if (args[0] === '--wait' && args[2] === 'connection' && args[3] === 'up') {
      const p = profiles.find((x) => x.uuid === args[5]);
      if (!p) throw new Error('unknown connection');
      active = undefined;
      const want = passwords[p.ssid];
      if (want === undefined && !p.hidden) throw new Error(`Error: Connection activation failed: No network with SSID '${p.ssid}' found.`);
      if (want !== undefined && p.psk !== want) throw new Error('Error: Connection activation failed: Secrets were required, but not provided.');
      active = p.uuid;
      return 'Connection successfully activated\n';
    }
    throw new Error(`fake nmcli: unhandled ${a}`);
  };
  return { run, calls, profiles, active: () => activeSsid() };
}
