// Prometheus-style metrics for this instance (scrape each instance, or read the /metrics JSON summary).
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Metrics {
  constructor() {
    this.requests = new Map();   // "method|route|status" → count
    this.durations = new Map();  // route → { buckets[], sum, count }
    this.slow = 0;
    this.errors = 0;
    this.startedAt = Date.now();
  }
  observe({ method, route, status, seconds }) {
    const k = `${method}|${route}|${status}`;
    this.requests.set(k, (this.requests.get(k) || 0) + 1);
    let d = this.durations.get(route);
    if (!d) { d = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; this.durations.set(route, d); }
    BUCKETS.forEach((b, i) => { if (seconds <= b) d.buckets[i]++; });
    d.sum += seconds; d.count++;
    if (status >= 500) this.errors++;
  }
  /** Approximate percentile (seconds) from the histogram, across all routes. */
  percentile(p) {
    const total = BUCKETS.map((_, i) => [...this.durations.values()].reduce((s, d) => s + d.buckets[i], 0));
    const count = [...this.durations.values()].reduce((s, d) => s + d.count, 0);
    if (!count) return 0;
    const target = count * p;
    for (let i = 0; i < BUCKETS.length; i++) if (total[i] >= target) return BUCKETS[i];
    return Infinity;
  }
  prometheus(extra = {}) {
    const lines = ['# TYPE http_requests_total counter'];
    for (const [k, v] of this.requests) {
      const [method, route, status] = k.split('|');
      lines.push(`http_requests_total{method="${method}",route="${route}",status="${status}"} ${v}`);
    }
    lines.push('# TYPE http_request_duration_seconds histogram');
    for (const [route, d] of this.durations) {
      BUCKETS.forEach((b, i) => lines.push(`http_request_duration_seconds_bucket{route="${route}",le="${b}"} ${d.buckets[i]}`));
      lines.push(`http_request_duration_seconds_bucket{route="${route}",le="+Inf"} ${d.count}`);
      lines.push(`http_request_duration_seconds_sum{route="${route}"} ${d.sum.toFixed(4)}`);
      lines.push(`http_request_duration_seconds_count{route="${route}"} ${d.count}`);
    }
    const mem = process.memoryUsage();
    lines.push(`process_resident_memory_bytes ${mem.rss}`, `process_heap_used_bytes ${mem.heapUsed}`,
      `process_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`, `http_slow_requests_total ${this.slow}`);
    for (const [k, v] of Object.entries(extra)) lines.push(`${k} ${Number(v) || 0}`);
    return lines.join('\n') + '\n';
  }
}
