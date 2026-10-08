# Aklatak — Scalability Roadmap (build for 10M, pay for current usage)

The application code does not change between stages: each stage adds **resources** (CPU, instances, database size, cache, storage), not a rewrite.

## Measured baseline (v4.8, local, 1 vCPU shared with the load generator, SQLite, 1,000 subscribers in one town)
| Concurrent users | Throughput | p50 | p95 | Errors | Note |
|---|---|---|---|---|---|
| 100 | ≈ 296 req/s | 193 ms (search 606 ms) | 745 ms | 0 % | CPU 98 % of one core |
| 1,000 | ≈ 195 req/s | 410 ms | 16.8 s | 1.5 % | one core saturated → needs more instances |
| 10,000 | **not tested** | — | — | — | cannot be measured on this machine; plan below is an estimate |

Rule of thumb from the measurement: **one 1-vCPU instance ≈ 250–300 req/s**. Add instances behind the load balancer to scale linearly (stateless backend: sessions, rate limits and jobs in the database; photos in R2).

## Stages
| Stage | Registered | MAU | DAU | Peak concurrent | Peak RPS | Architecture | What changes |
|---|---|---|---|---|---|---|---|
| **1** | 0–10K | ≤ 5K | ≤ 1K | ≤ 50 | ≤ 20 | Render **Starter** (1 instance), Neon free/Launch, R2, Cloudflare free | Render Starter (never sleeps), domain + Cloudflare, R2 for photos |
| **2** | 10K–100K | ≤ 50K | ≤ 10K | ≤ 500 | ≤ 200 | Render Standard ×1–2, Neon Launch/Scale, R2 + CDN | Second instance, larger DB compute, Geoapify paid plan, separate worker (`RUN_JOBS=false` on web) |
| **3** | 100K–1M | ≤ 500K | ≤ 100K | ≤ 5K | ≤ 2K | 4–10 instances + autoscaling, Redis/Valkey (`REDIS_URL`) for rate limits & cache, DB read replica | Redis, read replica for public reads, PostGIS for nearby search, partitioned event tables |
| **4** | 1M–10M | ≤ 5M | ≤ 1M | ≤ 50K | ≤ 20K | 20–60 instances in 2+ regions, managed Postgres with replicas, queue + workers, CDN everywhere | Multi-region, queue for notifications/analytics, search engine only if name search becomes a bottleneck |

## First bottleneck expected at each stage
1. **Stage 1** — the free Render instance sleeps and has 0.1 CPU; Neon free storage if photos stay in the database (→ R2).
2. **Stage 2** — single instance CPU during peaks; Geoapify free quota when many new areas join.
3. **Stage 3** — database connections (instances × pool size) → PgBouncer/pooled URL, read replica; rate-limit writes → Redis.
4. **Stage 4** — write volume of event tables (impressions, page views) → partitioning + retention (already in place: 180-day impressions), multi-region latency.

## Already in place (no rewrite needed later)
Stateless backend · DB sessions · distributed rate limits (Postgres or Redis) · job leases (one instance runs each job) · bounded nearby search (max 300 candidates ordered in the database) · request coalescing for map lookups · Geoapify circuit breaker · photos on object storage · retention jobs · health/readiness endpoints · metrics.
