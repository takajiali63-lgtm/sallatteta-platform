# Aklatak — Production Readiness (v4.8)

1. **Current architecture** — Node 22 (no framework) serving the website, the admin panel and a JSON API; Postgres (Neon); photos on Cloudflare R2 when configured (database fallback); Android app = Trusted Web Activity of the same site.
2. **Deployment** — GitHub (private) → Render, manual deploys, build fingerprint shown in the admin panel. Rollback: Render → Deploys → Rollback.
3. **Database** — versioned migrations at start-up; constraints on coordinates; indexes on search paths; pool max 10 per instance (`DB_POOL_MAX`); 20 s query timeout (`DB_QUERY_TIMEOUT_MS`); TLS certificate verified.
4. **Security** — server-side authorization on every admin/subscriber endpoint (IDOR tests); scrypt passwords; passkeys + backup codes + login history for the admin; CSP with only the storage origin added; secrets only in Render; no secrets in logs or Git.
5. **Authentication** — HTTP-only session cookies stored in the database (any instance can serve any request); login rate limits; emergency admin reset via `ADMIN_RESET_PASSWORD`.
6. **API** — validation on every input, bounded results (search ≤ 30, "everything near me" ≤ 150, name search ≤ 10), body size limits, structured errors.
7. **Location** — GPS accuracy and age checked on the server; customers' positions stored at ~1 km; exact metres computed in memory; friendly permission explanation before the phone's first prompt.
8. **Geoapify** — server-side key; 6 s timeout, one retry, 429 back-off, circuit breaker (5 failures → 60 s pause), per-cell cache, request coalescing, customer never waits more than 400 ms (`GEO_SEARCH_WAIT_MS`), OpenStreetMap fallback.
9. **Cloudflare** — ready: DNS + HTTPS + CDN + DDoS protection on the free plan; R2 for photos. No feature depends on a paid Cloudflare plan.
10. **Caching** — public data only (config, categories, home feed, banners, map cells). Never: sessions, passwords, private messages, exact locations.
11. **Storage** — R2/S3 via `S3_*`; automatic background move of existing photos (`photo-storage` job), verified file by file.
12. **Monitoring** — `/healthz` (liveness), `/readyz` (database + jobs), metrics endpoint with latency percentiles (`METRICS_TOKEN`); UptimeRobot on `/readyz`.
13. **Backups** — Neon point-in-time restore (plan-dependent) + one-tap full export from the admin panel (code, data, docs) with a tested restore into an empty site.
14. **Disaster recovery** — see the emergency sheet in `INVENTORY.md` (backend down, database lost, Geoapify down, storage down, traffic spike, lost phone/password).
15. **Scaling** — see `SCALABILITY_ROADMAP.md`.
16. **Cost control** — pay now: Render Starter (~$7) + domain; at ~50–100 subscribers: Neon paid, R2 (mostly free), Geoapify paid; later: instances, Redis, replicas.
17. **Environment variables** — documented in `.env.example` (no real values).
18. **Known limitations** — distances are straight-line (no road time yet); 10,000 concurrent users not load-tested; fake-GPS cannot be detected reliably in a browser; nearby search uses PostGIS (spatial GiST index, KNN) when available, with the indexed candidate filter as automatic fallback; admin approval is manual until a payment gateway is connected.
19. **Next steps** — Render Starter + domain + Cloudflare → R2 → payment gateway → add REDIS_URL when running 2+ instances → staging load tests on real infrastructure before each stage.
