"""Who may call the Mac's services: this Mac, or a device on its Tailscale network."""
import ipaddress

TAILSCALE_NETWORKS = (ipaddress.ip_network('100.64.0.0/10'), ipaddress.ip_network('fd7a:115c:a1e0::/48'))


def trusted_peer(address):
    """True for a caller on this Mac or at a Tailscale address; anything unreadable is refused."""
    try:
        ip = ipaddress.ip_address(address)
        if getattr(ip, 'ipv4_mapped', None): ip = ip.ipv4_mapped
        return ip.is_loopback or any(ip in network for network in TAILSCALE_NETWORKS)
    except ValueError: return False
