# System Design: URL Shortener (TinyURL / Bitly)
### FAANG Senior Interview Deep-Dive

> **Frequency**: Asked at Google, Amazon, Meta, Microsoft — extremely common warm-up or standalone question.
> **Why they ask it**: Tests encoding/hashing, DB design, caching, read-heavy scaling, and redirect architecture.

---

## Step 1 — Requirements Clarification

### Functional Requirements
- User submits a long URL → system returns a short URL (e.g., `https://tiny.url/aB3k9Z`)
- User visits the short URL → system redirects to the original long URL
- Custom aliases (optional): user can choose their short code
- Expiration (optional): URLs can expire after a set time

### Non-Functional Requirements
- **Highly available**: a dead short URL = terrible UX. Target **99.99%** uptime.
- **Low latency redirects**: p99 < 10ms (reads >> writes)
- **Read-heavy**: ratio is ~100:1 reads to writes
- **No collisions**: two long URLs must never map to the same short code
- **No duplication** (optional): same long URL could return the same short code
- **Analytics** (out of scope for this design): click counts, geo data

### Out of Scope
- User authentication / link management dashboard
- Analytics pipeline
- Spam / abuse detection

---

## Step 2 — Capacity Estimation

### Assumptions
```
DAU:              100 million users
Write RPS:        100M * 1 new URL/day / 86,400 ≈ 1,200 writes/sec
Read RPS:         1,200 * 100 (read:write ratio) = 120,000 reads/sec
URL record size:  ~500 bytes (long URL + short code + metadata)
Storage/day:      1,200 writes/sec × 86,400 sec × 500 bytes ≈ 50 GB/day
5-year storage:   50 GB × 365 × 5 ≈ 90 TB
```

> **Key insight**: This is a **read-heavy** system. Optimize for fast redirects, not fast writes.

---

## Step 3 — High-Level Design

```
                         ┌─────────────┐
                         │     CDN     │  ← Cache popular short URLs at edge
                         └──────┬──────┘
                                │ miss
     ┌──────────┐    ┌──────────▼──────────┐
     │  Client  │───▶│    Load Balancer    │
     └──────────┘    └──────────┬──────────┘
                                │
                  ┌─────────────▼──────────────┐
                  │         API Servers         │
                  │  POST /shorten              │
                  │  GET  /:code → 301/302      │
                  └──────┬──────────────┬───────┘
                         │              │
               ┌─────────▼──┐    ┌──────▼─────┐
               │  Redis     │    │  Database  │
               │  (Cache)   │    │ (Cassandra │
               │            │    │  / MySQL)  │
               └────────────┘    └────────────┘
```

### API Design

**Create short URL:**
```
POST /api/v1/shorten
Body: {
  "long_url": "https://example.com/very/long/path?q=123",
  "custom_alias": "my-link",   // optional
  "expiry_days": 30            // optional
}
Response: {
  "short_url": "https://tny.io/aB3k9Z",
  "expires_at": "2026-03-21T00:00:00Z"
}
```

**Redirect:**
```
GET /:code
Response: 301 Redirect → long URL
          (or 302 for analytics tracking)
```

> **301 vs 302**: 301 is permanent — browser caches it (reduces server load). 302 is temporary — every redirect hits your server (useful for analytics). Use **302** if you need click tracking.

---

## Step 4 — Deep Dive

### The Core Problem: Generating Unique Short Codes

Short URL = base-62 encoding of a unique ID. Base-62 uses `[a-z, A-Z, 0-9]`.

```
6 characters in base-62 = 62^6 = ~56 billion combinations
→ More than enough for years of URLs
```

**Option A: Hash the long URL (MD5 / SHA-256)**
```
MD5("https://example.com/...") → "5d41402abc4b2a76b9719d911017c592"
Take first 6 chars               → "5d4140"
```

- ✅ Same URL always maps to the same code (dedup for free)
- ❌ Hash collisions: two different URLs could produce the same 6-char prefix
- ❌ Must check DB on every write (expensive at scale)
- ❌ Hard to handle custom aliases cleanly

**Option B: Counter + Base-62 Encoding (Recommended)**
```
Auto-increment counter (globally unique ID): 12345678
Base-62 encode: 12345678 → "5l8B3M"
```

- ✅ Guaranteed uniqueness — no collision checks
- ✅ Fast — no DB read required during generation
- ❌ Counter is a single point of failure (solve with distributed ID generation)
- ❌ Sequential IDs are predictable (enumerable by attackers)

**Option C: Pre-generated Key Table (Used by TinyURL)**

A background service pre-generates millions of random 6-char codes and stores them in a `keys_unused` table. On each write request:
1. Fetch one key from `keys_unused` (mark as used — atomic operation)
2. Store the mapping (key → long URL) in main DB

- ✅ No collision possible
- ✅ No computation at request time
- ✅ Very fast writes
- ❌ Extra infrastructure (Key Generation Service)
- ❌ Key DB is a single point of failure (replicate it)

> **FAANG answer**: Discuss all three, then recommend **Option C** for production scale or **Option B with Snowflake-style IDs** for simpler setups.

---

### Distributed ID Generation (Snowflake Pattern)

When using counter-based IDs, you need a distributed counter that avoids collisions across multiple API servers.

**Twitter Snowflake ID (64-bit)**:
```
| 1 bit  | 41 bits      | 10 bits   | 12 bits        |
| unused | timestamp ms | machine ID| sequence number|
```

- Timestamp: milliseconds since epoch → ~69 years
- Machine ID: unique per server (assigned at startup from Zookeeper)
- Sequence: 4096 IDs per ms per machine
- → **4 million IDs/second per machine**, globally unique, sortable by time

---

### Database Schema

**MySQL or PostgreSQL (for relational correctness)**:

```sql
CREATE TABLE urls (
  id          BIGINT PRIMARY KEY,       -- Snowflake ID
  short_code  VARCHAR(10) UNIQUE NOT NULL,
  long_url    TEXT NOT NULL,
  user_id     BIGINT,                   -- nullable (anonymous)
  created_at  TIMESTAMP DEFAULT NOW(),
  expires_at  TIMESTAMP,
  is_deleted  BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_short_code ON urls(short_code);  -- fast lookups
CREATE INDEX idx_long_url_hash ON urls(MD5(long_url));  -- dedup lookups
```

**Why not NoSQL here?** This data is structured, and the access patterns are simple (lookup by short_code). MySQL/Postgres with read replicas handles 120K reads/sec easily with caching in front.

**For even larger scale**: Use Cassandra with `short_code` as partition key:
```
Primary Key: short_code (partition key)
- Perfect for key-value lookup
- No joins needed
- Scales horizontally
```

---

### Caching Layer (Redis)

**Pattern**: Cache-aside (lazy loading)

```
1. Request arrives for /aB3k9Z
2. Check Redis: cache["aB3k9Z"] → HIT? Return long_url instantly
3. MISS? Query DB → get long_url → store in Redis with TTL → return
```

**Redis key structure**:
```
Key:   "url:aB3k9Z"
Value: "https://example.com/very/long/path?q=123"
TTL:   86400 seconds (24 hours, or match URL expiry)
```

**Cache sizing**:
```
20% of daily URLs are 80% of traffic (Pareto principle)
Hot URLs: 0.2 × 1,200 × 86,400 = ~20 million entries
Each entry: ~500 bytes → ~10 GB of RAM for hot URLs
→ A single Redis instance handles this easily
```

**Eviction policy**: Use `allkeys-lru` — evict least-recently-used keys when memory fills up.

---

### Redirect Flow (Critical Path — optimize this)

```
Client → CDN → Load Balancer → API Server → Redis → (DB if miss) → 302 Redirect
```

**With CDN caching popular URLs**:
- Top 0.1% of URLs (viral links) served entirely from CDN edge
- Latency: ~5ms (CDN PoP near user)
- Avoids your servers entirely for most traffic

**Without CDN, with Redis**:
- Latency: ~10-20ms (Redis lookup + network)
- 95%+ cache hit rate for popular URLs

---

### URL Expiration

- Store `expires_at` timestamp in DB
- On redirect: check if `now() > expires_at` → return 410 Gone
- Background cleanup job: runs daily, deletes expired rows, reclaims short codes

```sql
DELETE FROM urls WHERE expires_at < NOW() AND is_deleted = FALSE;
```

---

### Handling Hotspots / Celebrity URLs

Problem: A viral URL gets 10 million hits in 1 minute.

Solutions:
1. **CDN**: Cache the redirect at the CDN edge — zero load on your servers
2. **Local in-memory cache**: Each API server caches its 1000 most popular URLs in memory — no Redis roundtrip
3. **Rate limiting per short code**: 429 Too Many Requests beyond a threshold (protects origin)

---

### Custom Aliases

```
POST /api/v1/shorten
{ "long_url": "...", "custom_alias": "launch2026" }
```

- Check if `launch2026` is already taken → 409 Conflict
- If free → insert with `short_code = "launch2026"`
- Namespace separate from auto-generated codes to avoid collisions
- Rate-limit custom aliases per user to prevent abuse

---

## Failure Scenarios & Mitigation

| Failure | Impact | Mitigation |
|---------|--------|-----------|
| Redis down | All reads hit DB — still works, slower | Redis Cluster with replicas, circuit breaker |
| DB primary fails | Writes fail | Read replica promoted, async replication |
| API server crash | Some requests fail | Multiple instances behind LB, health checks |
| ID generator fails | Can't create new URLs | Multiple ID generators, fallback to timestamp+random |
| CDN unavailable | Latency spikes | TTL on CDN records, origin fallback |

---

## Scalability Summary

```
120,000 reads/sec  → Redis caching + CDN handles with ease
1,200 writes/sec   → Single MySQL primary can handle ~10,000 writes/sec
90 TB / 5 years    → Cheap on cloud object storage or sharded DB
```

**When you'd add sharding**: If write QPS exceeds ~50,000/sec, shard by `short_code` prefix or use Cassandra natively.

---

## What Interviewers Listen For

✅ Explain **why base-62** (not base-64 — no `+` and `/` in URLs)
✅ **301 vs 302** trade-off discussion
✅ Why a **pre-generated key table** beats hashing at scale
✅ **Redis cache-aside** with LRU eviction
✅ **Snowflake IDs** for distributed uniqueness
✅ CDN for **popular URL caching** (the "celebrity URL" problem)
✅ **URL expiration** + cleanup job

---

## Sample Answer Narrative (2-minute version)

*"This is a read-heavy system — 100:1 read-write ratio — so I'll optimize for redirect latency. I'd use a CDN at the edge to cache the most popular redirects, eliminating most server load. Behind the CDN, API servers handle new URL creation and cache misses. For generating short codes, I'd use a distributed ID generator based on Snowflake — 64-bit IDs base-62 encoded into 7-character codes, guaranteed unique without collision checks. Mappings are stored in MySQL — simple key-value access by short_code — fronted by Redis. Cache-aside with LRU eviction and a 24-hour TTL gives us 95%+ hit rates. Redirects use 302 if we need analytics, 301 if we want browser caching. For URL expiration, a background job cleans up expired rows nightly. This design handles 120K reads/sec and 1,200 writes/sec well within a single-region setup."*

---

## Advanced Topics & Follow-Up Questions

### Rate Limiting

Prevent abuse (bots creating millions of URLs):

**Token bucket per IP / user:**

```
Redis key: ratelimit:{user_id}
Algorithm:
  tokens = GET ratelimit:{user_id}  → default to max_tokens if missing
  if tokens > 0:
    DECR ratelimit:{user_id}
    proceed with request
  else:
    return 429 Too Many Requests

Background: refill tokens at fixed rate (e.g., 10 tokens/hour)
```

**Sliding window log (more accurate):**
- Store timestamps of recent requests in a Redis sorted set
- On each request: remove entries older than window, count remaining, reject if over limit
- More memory than token bucket, but no burst exploitation

**Typical limits:**
- Anonymous users: 10 URLs/day
- Authenticated free tier: 1,000 URLs/day
- API paid tier: 1,000,000 URLs/day

---

### Analytics Pipeline (Bonus Design)

If asked "how would you track clicks?":

```
Redirect (302) hits API server
  → API server publishes click event to Kafka:
     { short_code, timestamp, user_agent, ip, referer, country }

Kafka consumers:
  → ClickHouse / BigQuery (analytics DB — columnar, fast aggregation)
  → Real-time dashboard (Flink / Spark Streaming for live counters)

Queries supported:
  - Total clicks per URL
  - Clicks over time (hourly/daily)
  - Top referrers
  - Geographic distribution
  - Device breakdown (mobile vs. desktop)
```

**Why ClickHouse?** Columnar storage — `SELECT COUNT(*) WHERE short_code = X` scans only one column, extremely fast for billions of rows.

---

### Multi-Region / Global Architecture

For global availability and low-latency access worldwide:

```
Global Setup:
  Route 53 (GeoDNS) → nearest region

  US-East (Primary)     EU-West (Read replica)     AP-Southeast (Read replica)

Write path: US-East primary DB
Read path:  local region replica (eventual consistency OK for reads)
Replication lag: ~100ms cross-region
```

**Write forwarding**: If a European user creates a URL, the EU region forwards the write to US-East primary, then responds once write is confirmed.

**Conflict resolution**: Since short codes are globally unique (generated by ID service), conflicts are impossible — no two regions generate the same ID.

---

### Security Considerations

**Malicious URL detection:**
- Check long URL against Google Safe Browsing API before shortening
- Block known phishing/malware domains
- Allow users to report malicious links → human review queue

**Click fraud prevention:**
- Same IP clicking 1000 times in 1 minute → bot detection → filter from analytics
- Rate limit redirects per IP per URL

**URL scanning for private content:**
- Scan for URLs that might expose private S3 buckets, internal dashboards
- Warn user if the destination looks like an internal endpoint

**HTTPS enforcement:**
- Only shorten HTTPS URLs (or warn for HTTP)
- Short URL domain always HTTPS

---

### Database Sharding Strategy

When writes exceed ~10,000/sec, shard the database:

**Shard by short_code prefix:**
```
short_code starts with [a-h] → Shard 1
short_code starts with [i-p] → Shard 2
short_code starts with [q-z, A-H] → Shard 3
short_code starts with [I-Z, 0-9] → Shard 4
```
Simple routing, but fixed shard boundaries can cause imbalance.

**Shard by hash of short_code:**
```
shard_id = hash(short_code) % num_shards
```
Even distribution, but resharding is complex.

**Recommended: Range-based with consistent hashing** — easy rebalancing, even distribution.

---

### Common Follow-Up Questions

**Q: What if two users submit the same long URL — should they get the same short URL?**

Options:
- **Yes (dedup)**: Store a long_url_hash to short_code mapping. Check on each write. Benefits: deduplication, space savings. Cost: extra DB read per write.
- **No (unique per request)**: Simpler, no extra lookup. Two different short codes for the same long URL. Most systems do this.

**Q: How do you handle the case where someone tries to enumerate short URLs?**
- Rate limit GET requests per IP
- Log enumeration patterns and ban IPs
- Optionally, add a CAPTCHA after N consecutive 404s from same IP
- For sensitive URLs, offer private/password-protected links

**Q: How would you implement custom expiry cleanup efficiently?**
- Use a time-based secondary index: `CREATE INDEX idx_expires ON urls(expires_at) WHERE expires_at IS NOT NULL`
- Background job runs every hour: `DELETE FROM urls WHERE expires_at < NOW() LIMIT 10000`
- Batch deletes to avoid locking the table

**Q: What is your approach to hot vs cold storage?**
- Recent URLs (< 90 days) → SSD-backed DB (hot)
- Older URLs (> 90 days) → HDD or S3 archival storage (cold)
- On redirect: check hot tier first, then cold tier on miss
- 80% of traffic goes to URLs created in last 30 days (Pareto principle)

**Q: How would you design a URL preview feature (showing title + thumbnail before redirect)?**
- On URL creation: background job fetches OG metadata (og:title, og:image, og:description)
- Store metadata in DB alongside the URL record
- API endpoint: `GET /api/preview/:code` returns metadata for preview
- Cache preview metadata in Redis (rarely changes)
