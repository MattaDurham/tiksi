"""Who may call the Mac's services: this Mac, or a device on its Tailscale network.

A caller on this Mac (loopback) is always trusted. Any other caller must have a Tailscale
address, and the Mac's own Tailscale daemon is asked whether that address is one of this
tailnet's devices: the address range alone is not enough, because some internet providers,
hotels and mobile networks hand out addresses from the same range. The daemon's answer is
kept for a while, so it is asked at most once every few seconds, never once per request.
When Tailscale cannot be asked (not installed, not running, no answer, an answer of the
wrong shape), the last good answer is kept; if there has never been one, only this Mac is
trusted until Tailscale answers, and the server log says so.
"""
import ipaddress
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

log = logging.getLogger('tiksi.peers')
TAILSCALE_NETWORKS = (ipaddress.ip_network('100.64.0.0/10'), ipaddress.ip_network('fd7a:115c:a1e0::/48'))
# Where the Tailscale command is when it is not on PATH. A launch agent starts the server
# with a short PATH, and the Mac app keeps the command inside its bundle.
CLI_PATHS = ('/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale')
REFUSED = 'Tiksi services answer only this Mac or a device on its Tailscale network'
UNASKED = 'Tailscale on this Mac could not be asked which devices are on its network, so only this Mac is trusted until it answers'


def address(value):
    """An address as the services compare it (IPv4 for an IPv4-mapped IPv6 address); None if unreadable."""
    try:
        ip = ipaddress.ip_address(value)
        if getattr(ip, 'ipv4_mapped', None): ip = ip.ipv4_mapped
        return ip
    except ValueError: return None


def find_cli(which=shutil.which, candidates=CLI_PATHS):
    """The Tailscale command: on PATH, or in one of the places it is installed; None if absent."""
    found = which('tailscale')
    if found: return found
    return next((p for p in candidates if Path(p).is_file() and os.access(p, os.X_OK)), None)


_cli_logged = []


def cli_path():
    cli = find_cli()
    if not _cli_logged:
        _cli_logged.append(cli)
        if cli: log.info('Asking Tailscale through %s.', cli)
        else: log.warning('The Tailscale command was not found on PATH or in %s.', ', '.join(CLI_PATHS))
    return cli


def tailscale_status(timeout=3, cli=None):
    """The local Tailscale daemon's status, or None when it cannot be asked."""
    cli = cli or cli_path()
    if not cli: return None
    # The command inside the Mac app answers as a command only when TERM is set; without it, as
    # under a launch agent, it tries to start the app's window instead and prints no status.
    environment = {**os.environ, 'TERM': os.environ.get('TERM') or 'dumb'}
    try: result = subprocess.run([cli, 'status', '--json'], capture_output=True, text=True, timeout=timeout, env=environment)
    except (OSError, subprocess.SubprocessError): return None
    if result.returncode: return None
    try: status = json.loads(result.stdout)
    except ValueError: return None
    return status if isinstance(status, dict) else None


def tailnet_addresses(status):
    """Every Tailscale address of this Mac (its Self entry) and of the devices on its tailnet.
    An answer of an unexpected shape raises ValueError: it is not taken as an empty tailnet."""
    if not isinstance(status, dict): raise ValueError('Tailscale status is not an object')
    me, others = status.get('Self'), status.get('Peer')
    me, others = {} if me is None else me, {} if others is None else others
    if not isinstance(me, dict) or not isinstance(others, dict): raise ValueError('Tailscale status has an unexpected shape')
    found = set()
    for node in (me, *others.values()):
        if not isinstance(node, dict): raise ValueError('Tailscale status has an unexpected device entry')
        values = node.get('TailscaleIPs')
        values = [] if values is None else values
        if not isinstance(values, list): raise ValueError('Tailscale status has unexpected addresses')
        for value in values:
            ip = address(value) if isinstance(value, str) else None
            if ip is not None: found.add(ip)
    return frozenset(found)


def ask_tailscale():
    status = tailscale_status()
    return None if status is None else tailnet_addresses(status)


def this_mac_tailscale_address(status=None):
    """This Mac's own Tailscale IPv4 address (IPv6 if it has no IPv4), or None."""
    status = tailscale_status() if status is None else status
    me = status.get('Self') if isinstance(status, dict) else None
    values = me.get('TailscaleIPs') if isinstance(me, dict) else None
    found = [address(v) for v in values if isinstance(v, str)] if isinstance(values, list) else []
    found = [ip for ip in found if ip is not None and any(ip in network for network in TAILSCALE_NETWORKS)]
    found.sort(key=lambda ip: ip.version)
    return str(found[0]) if found else None


class Tailnet:
    """This tailnet's device addresses, as the local Tailscale daemon last gave them."""
    FRESH = 60    # seconds an answer is used before the daemon is asked again
    RETRY = 5     # an address not in the answer asks again, but no more often than this
    QUIET = 60    # seconds between log lines about refusing callers while Tailscale cannot be asked

    def __init__(self, ask=ask_tailscale, clock=time.monotonic):
        self.ask, self.clock = ask, clock
        self.lock = threading.Lock()
        self.known = None      # addresses from the last good answer; None if there has never been one
        self.asked = None      # when it was last asked
        self.failing = False   # the last ask failed
        self.refusal_logged = None

    def refresh(self, now):
        try: known = self.ask()
        except Exception: known = None
        self.asked = now
        if known is None:
            if not self.failing:
                if self.known is None: log.warning('Tailscale could not be asked who a caller is; only this Mac is trusted until it answers.')
                else: log.warning('Tailscale could not be asked who a caller is; its last answer is used until it answers again.')
            self.failing = True
            return
        if self.failing: log.info('Tailscale answers again; trusting the devices on this tailnet.')
        self.failing, self.known = False, known

    def __contains__(self, ip):
        with self.lock:
            now = self.clock()
            age = None if self.asked is None else now - self.asked
            if age is None or age >= self.FRESH or (ip not in (self.known or ()) and age >= self.RETRY):
                self.refresh(now)
            if self.known is None:
                if self.refusal_logged is None or now - self.refusal_logged >= self.QUIET:
                    log.warning('Refused %s: %s.', ip, UNASKED)
                    self.refusal_logged = now
                return False
            return ip in self.known

    def unasked(self):
        """True while there has never been a good answer, so only this Mac is trusted."""
        with self.lock: return self.known is None


TAILNET = Tailnet()


def trusted_peer(value):
    """True for a caller on this Mac or a device on this Mac's tailnet; anything unreadable is refused."""
    ip = address(value) if isinstance(value, str) else None
    if ip is None: return False
    if ip.is_loopback: return True
    if not any(ip in network for network in TAILSCALE_NETWORKS): return False
    return ip in TAILNET


def refusal(value):
    """Why a caller was refused, in words the page can show."""
    ip = address(value) if isinstance(value, str) else None
    if ip is not None and any(ip in network for network in TAILSCALE_NETWORKS) and TAILNET.unasked(): return UNASKED
    return REFUSED
