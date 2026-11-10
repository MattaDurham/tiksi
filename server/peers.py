"""Who may call the Mac's services: this Mac, or a device on its Tailscale network.

A caller on this Mac (loopback) is always trusted. Any other caller must have a Tailscale
address, and the Mac's own Tailscale daemon is asked whether that address is one of this
tailnet's devices: the address range alone is not enough, because some internet providers,
hotels and mobile networks hand out addresses from the same range. The daemon's answer is
kept for a while, so it is asked at most once every few seconds, never once per request.
When Tailscale cannot be asked at all (not installed, not running, no answer), the range
alone decides, as before, and the server log says so once.
"""
import ipaddress
import json
import logging
from pathlib import Path
import shutil
import subprocess
import threading
import time

log = logging.getLogger('tiksi.peers')
TAILSCALE_NETWORKS = (ipaddress.ip_network('100.64.0.0/10'), ipaddress.ip_network('fd7a:115c:a1e0::/48'))
# Where the Tailscale command is when it is not on PATH (the Mac app keeps it in its bundle).
CLI_PATHS = ('/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale')


def address(value):
    """An address as the services compare it (IPv4 for an IPv4-mapped IPv6 address); None if unreadable."""
    try:
        ip = ipaddress.ip_address(value)
        if getattr(ip, 'ipv4_mapped', None): ip = ip.ipv4_mapped
        return ip
    except ValueError: return None


def tailscale_status(timeout=3):
    """The local Tailscale daemon's status, or None when it cannot be asked."""
    cli = shutil.which('tailscale') or next((p for p in CLI_PATHS if Path(p).is_file()), None)
    if not cli: return None
    try: result = subprocess.run([cli, 'status', '--json'], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError): return None
    if result.returncode: return None
    try: status = json.loads(result.stdout)
    except ValueError: return None
    return status if isinstance(status, dict) else None


def tailnet_addresses(status):
    """Every Tailscale address of this Mac and of the devices on its tailnet."""
    nodes = [status.get('Self') or {}, *((status.get('Peer') or {}).values())]
    found = set()
    for node in nodes:
        for value in (node.get('TailscaleIPs') or []) if isinstance(node, dict) else []:
            ip = address(value)
            if ip is not None: found.add(ip)
    return frozenset(found)


def ask_tailscale():
    status = tailscale_status()
    return None if status is None else tailnet_addresses(status)


def this_mac_tailscale_address(status=None):
    """This Mac's own Tailscale IPv4 address (IPv6 if it has no IPv4), or None."""
    status = tailscale_status() if status is None else status
    if not status: return None
    found = [address(v) for v in ((status.get('Self') or {}).get('TailscaleIPs') or [])]
    found = [ip for ip in found if ip is not None and any(ip in network for network in TAILSCALE_NETWORKS)]
    found.sort(key=lambda ip: ip.version)
    return str(found[0]) if found else None


class Tailnet:
    """This tailnet's device addresses, as the local Tailscale daemon last gave them."""
    FRESH = 60    # seconds an answer is used before the daemon is asked again
    RETRY = 5     # an address not in the answer asks again, but no more often than this

    def __init__(self, ask=ask_tailscale, clock=time.monotonic):
        self.ask, self.clock = ask, clock
        self.lock = threading.Lock()
        self.known = None      # addresses from the last answer; None when Tailscale could not be asked
        self.asked = None      # when it was last asked
        self.fallback_logged = False

    def refresh(self, now):
        try: known = self.ask()
        except Exception: known = None
        self.asked = now
        if known is None:
            if not self.fallback_logged:
                log.warning('Tailscale could not be asked who a caller is; trusting every address in its range (100.64.0.0/10) until it can be.')
                self.fallback_logged = True
        elif self.known is None and self.fallback_logged:
            log.info('Tailscale answers again; trusting only the devices on this tailnet.')
            self.fallback_logged = False
        self.known = known

    def __contains__(self, ip):
        with self.lock:
            now = self.clock()
            age = None if self.asked is None else now - self.asked
            if age is None or age >= self.FRESH or (self.known is not None and ip not in self.known and age >= self.RETRY):
                self.refresh(now)
            return True if self.known is None else ip in self.known


TAILNET = Tailnet()


def trusted_peer(value):
    """True for a caller on this Mac or a device on this Mac's tailnet; anything unreadable is refused."""
    ip = address(value) if isinstance(value, str) else None
    if ip is None: return False
    if ip.is_loopback: return True
    if not any(ip in network for network in TAILSCALE_NETWORKS): return False
    return ip in TAILNET
