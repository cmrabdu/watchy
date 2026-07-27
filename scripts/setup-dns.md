# DNS setup (example)

Point your subdomain A record at your VPS IP, then wait for propagation.

| Type | Host | Target | TTL |
|------|------|--------|-----|
| A | `watchy` | `<VPS_IP>` | 300 |

```bash
dig +short watchy.example.com A
```

## Firewall

Allow inbound TCP 22, 80, 443 (+ ICMP if you want).
