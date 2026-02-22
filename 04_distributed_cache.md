# System Design: Distributed Cache (Design Redis / Memcached)
### FAANG Senior Interview Deep-Dive

> **Frequency**: Very common at Amazon, Google, Meta. Often asked as "Design a key-value store" or "How would you build a distributed cache?"
> **Why they ask it**: Tests distributed systems fundamentals — consistent hashing, replication, eviction, consistency, failure handling.

---

## Step 1 — Requirements Clarification

### Key Questions to Ask
- Key-value only, or do we need richer data structures (lists, sorted sets, hashes)?
- What's the access pattern? Read-heavy? Write-heavy?
- Strong vs. eventual consistency? (Can reads return stale data?)
- Do we need persistence (survive restarts)? Or pure in-memory?
- What's the required latency? (sub-millisecond? single-digit ms?)
- What's the eviction policy — LRU, LFU, TTL?
- Do we need pub/sub? Atomic operations (CAS, INCR)?

### Functional Requirements (for our design)
- `PUT(key, value, ttl)` — set a key with optional expiration
- `GET(key)` → value or null
- `DELETE(key)`
- LRU eviction when memory is full
- TTL-based expiration
- Support for horizontal scaling (distributed across nodes)

### Non-Functional Requirements
- **Latency**: p99 < 1ms for GET and PUT (in-memory = fast)
- **Availability**: 99.99% — cache downtime = DB overload
- **Scalability**: 10 TB total cache size, 1 million ops/second
- **Consistency**: eventual consistency acceptable (cache can return slightly stale data)
- **Durability**: not required (cache is a performance layer, not source of truth)

---

## Step 2 — Capacity Estimation

```
Target:        10 TB total cache
Avg value:     1 KB per entry
Total entries: 10 TB / 1 KB = 10 billion entries

At 64 GB RAM per node:
  Nodes needed:  10 TB / 64 GB = ~160 nodes (in practice, more for headroom)

Ops/second:    1 million ops/sec
Per node:      1M / 160 = ~6,250 ops/sec (well within a single node's capacity)
```

---

## Step 3 — Single Node Cache Design

Before scaling, understand the single-node fundamentals.

### In-Memory Hash Map

Core data structure: **Hash Map** mapping `key → (value, metadata)`

```
Metadata per entry:
  - value        (byte array)
  - ttl          (expiry timestamp)
  - last_access  (for LRU)
  - key_size     (for memory accounting)
  - value_size
```

```
Map<String, CacheEntry> store = new ConcurrentHashMap<>();

class CacheEntry {
    byte[] value;
    long   expiryMs;      // 0 = no expiry
    long   lastAccessMs;  // for LRU
}
```

### LRU Eviction

**Data structure**: Doubly linked list + hash map (classic LRU cache)

```
Most recently used ←→ ... ←→ Least recently used
       [HEAD]                        [TAIL]

Hash map: key → node in linked list

GET(key):
  1. Check hash map for node
  2. Move node to HEAD (most recently used)
  3. Return value

PUT(key, value):
  1. If memory full → evict TAIL node (LRU)
  2. Insert new node at HEAD
  3. Update hash map

DELETE(key):
  1. Remove from hash map
  2. Remove from linked list
```

**Time complexity**: O(1) for all operations (hash map lookup + pointer manipulation)

### TTL Expiration

**Lazy expiration** (used by Redis):
- Don't actively scan for expired keys
- On GET: check if `expiry < now()` → return null and delete if expired
- Simple, but expired keys linger in memory until accessed

**Active expiration** (background thread):
- Periodically sample random keys → delete those that are expired
- Redis runs this every 100ms, sampling 20 keys per cycle
- After deletion: if > 25% were expired, immediately repeat (prevents memory bloat)

**Combined approach** (best):
- Lazy expiration on every GET
- Periodic active expiration for keys that are never read

---

## Step 4 — Distributed Cache Design

### The Core Challenge: Partitioning Keys Across Nodes

**Naive approach: Simple modulo hashing**
```
node = hash(key) % num_nodes
```

Problem: if you add or remove a node, `num_nodes` changes, and **almost every key** maps to a different node → cache cold start, DB overwhelmed.

**Better approach: Consistent Hashing** ✅

```
Imagine a ring (0 to 2^32):

          0
    ┌─────┴─────┐
    │   node C  │
    │           │
  node A     node B
    │           │
    └─────┬─────┘
         2^32
```

1. Hash each node's ID to a position on the ring
2. Hash each key to a position on the ring
3. Key is stored on the **first node clockwise** from the key's position

**Adding/removing a node**: only keys between the new node and its predecessor move. All other keys stay in place.

→ Adding 1 node to 10-node cluster: only ~1/11 of keys need to move (vs. all keys with modulo).

**Virtual nodes (vnodes)**:
- Problem: uneven distribution (some nodes get more keys)
- Solution: each physical node has **150 virtual nodes** (positions) on the ring
- Distributes keys evenly; also handles heterogeneous hardware (stronger nodes get more vnodes)

### Consistent Hashing with Virtual Nodes

```
Physical Node A → Virtual nodes: A_1, A_2, ..., A_150
Physical Node B → Virtual nodes: B_1, B_2, ..., B_150

Ring positions (sorted): A_3, B_17, A_51, B_62, A_88, ...

Key hashes to position 60 → next clockwise = B_62 → Physical Node B
```

Each node maintains a sorted list of ring positions for all nodes — used for routing.

---

### Client-Side vs. Server-Side Routing

**Client-Side Routing** (Memcached approach):
- Client library knows the consistent hashing ring
- Client directly connects to the correct node
- No proxy needed — low latency
- Downside: all clients must implement the ring logic consistently

**Proxy-Based Routing** (Redis Cluster approach):
- Client connects to any node
- Node redirects client with `MOVED` response to correct node
- Client updates its slot map
- Server handles routing intelligence

**Coordinator/Proxy** (used in Cassandra):
- A dedicated proxy layer routes requests to correct nodes
- Client is dumb — just sends to proxy
- Adds latency but simplifies clients

> **For interview**: recommend **client-side consistent hashing** for low latency, with a gossip protocol to propagate ring changes.

---

### Replication: Handling Node Failures

Without replication, a node failure means all its cache keys are lost → DB hit for every key.

**Replication strategy**: Each key is stored on **N nodes** (typically N=3)
- **Primary node**: handles writes
- **Replica nodes** (N-1): serve reads, take over on primary failure

```
On PUT(key, value):
  1. Compute primary node via consistent hashing
  2. Write to primary
  3. Primary replicates to 2 successor nodes on the ring (async or sync)

On GET(key):
  1. Read from primary
  2. If primary down → read from replica 1
  3. If replica 1 down → read from replica 2
```

**Consistency levels** (tunable, like Cassandra):
- `W=1, R=1`: fastest, weakest consistency (can read stale from replica)
- `W=2, R=2`: balanced (N=3 quorum — need 2 of 3)
- `W=3, R=1`: strong write consistency, fast reads

> For a cache: `W=1, R=1` is typically fine — stale reads are acceptable.

---

### Write Policies (How Cache Stays in Sync with DB)

**Cache-Aside** (Lazy Loading) — most common:
```
GET:
  1. Check cache
  2. HIT → return
  3. MISS → query DB → write to cache → return

PUT (write to cache happens on cache miss):
  Risk: stale data if DB updated without cache invalidation
  Solution: short TTL (5-60 seconds) or explicit invalidation on write
```

**Write-Through**:
```
Every write goes to cache AND DB simultaneously
Pro: cache always in sync
Con: every write hits both systems → higher write latency
Con: rarely-accessed data still cached (wasted memory)
```

**Write-Behind (Write-Back)**:
```
Write to cache → return immediately
Background worker flushes to DB asynchronously
Pro: extremely fast writes (memory speed)
Con: data loss risk on cache failure (write in cache but not DB)
Use case: analytics counters, non-critical data
```

**Read-Through**:
```
Cache sits in front of DB
On miss: cache automatically queries DB and populates itself
App only talks to cache, never DB directly
Pro: simpler application code
Con: first request is always slow (cache miss)
```

**Cache Invalidation strategies**:
- **TTL-based**: simplest, accepts eventual consistency
- **Event-driven invalidation**: DB change publishes event → cache deletes key
- **Write-through**: always consistent, higher write cost
- **Versioned keys**: `user_v2_12345` — change key on update, old key expires naturally

---

### Cache Coherency Problem (Double Write)

**Problem with cache-aside + TTL**:
```
Thread 1: Read DB → cache MISS
Thread 2: Write DB (updated value), delete cache key
Thread 1: Write OLD value to cache (race condition!)
→ Cache has stale value until TTL expiry
```

**Solution: Lease / Compare-and-Swap**

```
On cache MISS:
  1. Cache grants "lease" (token) to requester
  2. Requester reads from DB
  3. Requester writes to cache WITH lease token
  4. Cache only accepts write if token matches current lease
  5. If another write happened meanwhile: token invalid → requester discards, re-reads
```

This eliminates the thundering herd and stale write problems.

---

### Thundering Herd Problem

**Scenario**: Popular key expires at 12:00:00. At that moment, 10,000 requests arrive simultaneously, all miss the cache, all go to DB → DB overload.

**Solutions**:

1. **Mutex / Lock on cache miss**:
   - First request to miss gets a "lock" token
   - Other requests wait
   - First request fetches from DB, populates cache, releases lock
   - Subsequent requests read from cache
   - Risk: lock contention at scale

2. **Probabilistic early expiration**:
   - Before TTL expires, randomly start re-fetching (with probability proportional to remaining TTL)
   - Spreads the re-computation over time
   - No lock needed

3. **Background refresh**:
   - Cache pre-fetches key before it expires (when TTL is 80% consumed)
   - Stale-while-revalidate pattern: return old value while fetching new one in background

4. **Jitter on TTL**:
   - Instead of TTL=3600, use TTL=3600 ± rand(300)
   - Spreads expiration of related keys over time
   - Prevents synchronized expiration spikes

---

### Hot Keys (Cache Shard Imbalance)

**Problem**: One key gets 99% of traffic (e.g., Taylor Swift's profile). Its shard becomes a bottleneck.

**Solutions**:

1. **Local in-memory cache on each app server** (L1 cache):
   - App servers cache the top 1000 hot keys in local memory
   - Eliminates network round-trip to Redis entirely
   - Invalidation: use pub/sub to broadcast invalidation to all app servers

2. **Key replication across multiple shards**:
   - `hot_key` is stored in `hot_key_0`, `hot_key_1`, ..., `hot_key_N`
   - Client randomly picks `hot_key_{random 0..N}` → spreads load across N shards
   - Works for read-heavy keys (all copies get same value)

3. **CDN for hot objects**:
   - If the "hot key" is profile data, cache at CDN edge
   - Requests never reach your cache cluster

---

### Redis-Specific Features Worth Mentioning

| Feature | Use case |
|---------|---------|
| **Sorted Set (ZSET)** | Leaderboards, feed ordering, rate limiting with sliding window |
| **HyperLogLog** | Count unique visitors with O(1) memory, ~0.81% error |
| **Pub/Sub** | Real-time notifications, cache invalidation broadcast |
| **Lua scripting** | Atomic multi-step operations (like CAS) |
| **Redis Streams** | Persistent event log (like lightweight Kafka) |
| **SCAN** | Cursor-based iteration (safe alternative to KEYS) |
| **Pipeline** | Batch multiple commands, reduce round-trips |

### Redis Cluster (Horizontal Scaling in Redis)

- 16,384 hash slots total
- Each node owns a range of slots: e.g., Node A owns 0-5461
- `slot = CRC16(key) % 16384`
- Client gets `MOVED` response when connecting to wrong node → updates slot map
- Replication: each master has 1+ replicas
- Automatic failover: replicas promote on master failure (via gossip + Raft-like election)

---

### Monitoring & Observability

Key metrics to track:
```
cache_hit_rate     = hits / (hits + misses)    → target > 95%
eviction_rate      = keys evicted per second   → high = memory pressure
memory_usage       = used / total              → alert at 80%
latency_p99        = GET/SET latency           → alert if > 1ms
connection_count   = active connections        → alert near limit
replication_lag    = replica offset vs master  → alert if > 1MB lag
```

---

## Failure Scenarios

| Failure | Impact | Mitigation |
|---------|--------|-----------|
| Node crashes | Keys on that node go cold | Replica promoted, consistent hash re-routes |
| Network partition | Split-brain, stale reads | Choose AP over CP for cache (stale ok, availability critical) |
| Memory full | Evictions, thrashing | Monitor memory, auto-scale nodes |
| Thundering herd | DB overload on cache miss | Mutex, jitter TTL, background refresh |
| Hot key | Shard becomes bottleneck | Local L1 cache, key replication |

---

## What Interviewers Listen For

✅ **Consistent hashing** with virtual nodes — core answer
✅ **Cache eviction**: LRU via doubly-linked list + hash map, O(1)
✅ **Write policies**: cache-aside, write-through, write-behind trade-offs
✅ **Replication** for availability + read scaling
✅ **Thundering herd** — multiple mitigation strategies
✅ **Hot key problem** — local L1 cache solution
✅ **TTL expiration**: lazy + active background sweep (Redis approach)
✅ **Lease mechanism** for coherency on concurrent cache miss

---

## Sample Answer Narrative (2-minute version)

*"I'd start with the single-node design: an in-memory hash map with LRU eviction using a doubly-linked list for O(1) get/put/delete. TTL expiration is handled lazily on read plus a background sweep that samples random keys and deletes expired ones. To scale horizontally to 10 TB, I'd distribute keys using consistent hashing with 150 virtual nodes per physical server — this limits key migration to 1/N when nodes are added. Each key is stored on 3 nodes for redundancy (primary + 2 replicas), with async replication to keep write latency low. For write policy, cache-aside is the default — apps read from cache, fall back to DB on miss, and write-through or TTL invalidation keeps data fresh. The two trickiest failure modes are thundering herd — solved with jitter TTL and background refresh — and hot key imbalance — solved with a local L1 cache on each app server for the top 1000 keys, invalidated via pub/sub."*

---

## Advanced Topics & Follow-Up Questions

### Cache Stampede Prevention — Deep Dive

The thundering herd / cache stampede problem deserves a thorough treatment since interviewers often follow up on it.

**Scenario:** 10,000 concurrent users request the same key at the moment it expires.

**Solution 1: Mutex Lock (Redis SETNX)**

```
def get_with_lock(key, ttl, fetch_fn):
    value = redis.get(key)
    if value:
        return value

    lock_key = "lock:" + key
    acquired = redis.set(lock_key, "1", nx=True, ex=5)  # NX = only if not exists

    if acquired:
        # Winner: fetch from DB and populate cache
        value = fetch_fn()
        redis.setex(key, ttl, value)
        redis.delete(lock_key)
        return value
    else:
        # Loser: wait and retry
        time.sleep(0.05)  # 50ms backoff
        return get_with_lock(key, ttl, fetch_fn)  # retry
```

**Risk:** Lock holder crashes → lock key expires after 5s → stampede resumes.
**Mitigation:** Heartbeat renewal on lock key while DB query runs.

**Solution 2: Stale-While-Revalidate**

```
On every cache read, check two timestamps:
  - expiry: when data is "expired" (return stale, start async refresh)
  - hard_expiry: when data must not be served (block until fresh)

Cache entry structure:
  { value, soft_ttl: 60s, hard_ttl: 120s }

  At 0-60s:   Return cached value directly
  At 60-120s: Return STALE value, trigger async background refresh
  At 120s+:   Cache miss — must fetch synchronously

Only ONE background refresh runs at a time (atomic flag).
All other requests get stale value while refresh is in progress.
```

This is what Cloudflare uses for their CDN (Cache-Control: stale-while-revalidate header).

**Solution 3: XFetch Algorithm (Probabilistic Early Expiration)**

```python
def get_xfetch(key, ttl, beta=1.0):
    entry = redis.hgetall(key)  # { value, expiry, delta }
    if not entry:
        return cache_miss()

    now = time.time()
    # delta = time it took to compute this value (in seconds)
    # Randomly decide to refresh before expiry
    if now - entry.delta * beta * math.log(random.random()) >= entry.expiry:
        # Probabilistic early refresh — runs before stampede can form
        refresh_cache(key, ttl)

    return entry.value
```

Higher `beta` = more aggressive early refresh = less stampede risk but higher DB load.

---

### Redis Persistence Options

When asked "how do you make Redis durable?":

**RDB (Redis Database Backup) — Snapshot:**
```
Save a point-in-time snapshot to disk:
  save 900 1      → save if at least 1 key changed in 900 seconds
  save 300 10     → save if at least 10 keys changed in 300 seconds
  save 60 10000   → save if at least 10,000 keys changed in 60 seconds
```
- Compact file, fast restarts, minimal I/O overhead
- Can lose up to minutes of data (since last snapshot)
- Good for: cache snapshots, periodic backups

**AOF (Append-Only File) — Write Log:**
```
Every write command is appended to a log file:
  SET foo bar
  SET baz qux
  INCR counter
  ...

Sync policies:
  appendfsync always     → fsync after every write (safest, slowest)
  appendfsync everysec   → fsync once per second (default, good balance)
  appendfsync no         → OS decides (fastest, most data loss risk)
```
- Maximum 1 second of data loss with `everysec`
- AOF file grows large → periodically rewritten (BGREWRITEAOF)
- Good for: when durability matters

**Hybrid (RDB + AOF):** Use both — RDB for fast restarts, AOF for replay since last snapshot.

**For a cache (not a DB):** Usually RDB only, or no persistence (cache is ephemeral by design). The source of truth is always the DB behind the cache.

---

### Redis Cluster Deep Dive

**How Redis Cluster routes requests:**

```
16,384 hash slots partitioned across nodes:
  Node A: slots 0-5460
  Node B: slots 5461-10922
  Node C: slots 10923-16383

Key-to-slot mapping:
  slot = CRC16(key) % 16384

Example:
  CRC16("user:1234") % 16384 = 7823 → Node B
  CRC16("session:abc") % 16384 = 1203 → Node A
```

**MOVED redirect:**
```
Client → Node A: GET user:1234
Node A: CRC16("user:1234") = 7823 → not my slot!
Node A → Client: MOVED 7823 192.168.1.2:6379
Client → Node B (192.168.1.2): GET user:1234
Client: updates slot map internally
```

**Hash tags for multi-key operations:**
- Redis Cluster cannot execute multi-key commands (MGET, MSET) if keys are on different slots
- Solution: use hash tags to force keys to same slot
- `{user:1234}:profile` and `{user:1234}:settings` both hash on `user:1234` → same slot → MGET works

**Rebalancing slots:**
```
Add new Node D:
  Migrate slots from A, B, C to D
  During migration: key exists on both source and destination
  MOVED responses guide clients to correct node
  No downtime required
```

---

### Memcached vs Redis — When to Choose Which

| | Memcached | Redis |
|-|-----------|-------|
| **Data types** | Strings only | Strings, Lists, Sets, Sorted Sets, Hashes, Streams |
| **Persistence** | None | RDB + AOF |
| **Replication** | No built-in | Master-replica |
| **Cluster** | Client-side only | Native Redis Cluster |
| **Lua scripting** | No | Yes |
| **Pub/Sub** | No | Yes |
| **Memory efficiency** | Slightly better | Slightly more overhead |
| **Multi-threading** | Yes (native) | Redis 6+ (I/O threads) |

**Choose Memcached when:**
- Pure caching, no persistence needed
- Multi-threaded performance is critical
- Simple string key-value only
- Already using it (migration cost outweighs benefits)

**Choose Redis when:**
- Need rich data structures (sorted sets for leaderboards, etc.)
- Need pub/sub for real-time features
- Need persistence or replication
- Using it for more than caching (queues, rate limiting, sessions)

**At FAANG:** Redis is almost always the answer. Memcached is legacy.

---

### Cache Hierarchy (L1 / L2 / L3)

Production systems use multiple cache layers:

```
Request path:

Client
  │
  ▼
L1: Browser / App Cache (client-side)
  - HTTP Cache-Control headers
  - In-app memory cache (mobile app)
  - ~0ms latency
  │ miss
  ▼
L2: CDN Cache (Cloudflare, CloudFront)
  - Static assets, API responses with public cache headers
  - ~5-20ms latency (nearest PoP)
  │ miss
  ▼
L3: Local In-Process Cache (per app server)
  - Java: Caffeine / Guava Cache
  - Python: functools.lru_cache
  - Top 1,000 hot keys per server, in-memory
  - ~0.1ms (same process)
  │ miss
  ▼
L4: Distributed Cache (Redis Cluster)
  - Shared across all app servers
  - ~0.5-1ms (network round trip)
  │ miss
  ▼
L5: Database
  - Source of truth
  - ~5-50ms (SSD), ~100ms (HDD)
```

**Key insight for interview:** A cache hit at L3 (in-process) is 5-10x faster than a Redis hit and avoids network entirely. Always mention the local cache layer for hot keys.

---

### Cache Sizing and Monitoring

**How to size a cache:**

```
Step 1: Measure working set size
  - What % of DB data is hot (frequently accessed)?
  - Typical: top 20% of data = 80% of requests (Pareto)

Step 2: Estimate memory needed
  - 500M users × 1 KB session data × 20% active = 100 GB session cache
  - Round up 2x for Redis overhead (metadata, pointer, etc.)

Step 3: Choose cache-to-DB ratio
  - Target hit rate: > 95% for most workloads
  - Run simulation: given your key access distribution (Zipfian), what cache size achieves 95%?

Step 4: Node sizing
  - Redis single-threaded for commands (I/O threads in Redis 6+)
  - Typically max 64-128 GB per node before diminishing returns
  - Use Redis Cluster when total size > 64 GB
```

**Key metrics to monitor:**

```
cache_hit_rate       target > 95% (alert if drops below 90%)
eviction_rate        alert if non-zero (means cache is under-sized)
memory_fragmentation alert if > 1.5 (means memory wasted on fragmentation)
connected_clients    alert if near maxclients limit (default 10,000)
replication_lag      alert if > 1MB (replica falling behind)
slow_log_count       alert if GET/SET taking > 1ms (should be sub-ms)
```

---

### Common Follow-Up Questions

**Q: How do you handle a cache miss storm when you deploy a new service (cold cache)?**
- Warm the cache before traffic hits: run a script that pre-fetches most popular keys from DB → loads into Redis
- Implement cache warming as part of deployment pipeline
- Use feature flags: slowly ramp traffic from 0% to 100% while cache warms up organically
- Implement request coalescing: if 100 requests miss the same key simultaneously, only 1 goes to DB (others wait)

**Q: What is the difference between a write-through and a read-through cache?**
- Write-through: app writes to cache AND DB simultaneously on every write
- Read-through: cache handles DB reads automatically on miss; app only talks to cache
- In practice: write-through + read-through together make the cache fully transparent
- Cache-aside (most common): app explicitly manages both cache and DB — more control, more code

**Q: How would you implement a distributed rate limiter using Redis?**

```
Fixed window counter:
  key = "rate:{user_id}:{minute}"    ← changes every minute
  INCR key
  EXPIRE key 60
  if value > limit: reject

Sliding window (more accurate):
  key = "rate:{user_id}"
  ZREMRANGEBYSCORE key 0 (now-60)   ← remove old entries
  ZADD key now now                   ← add current timestamp
  count = ZCARD key
  if count > limit: reject
  EXPIRE key 60
```

**Q: Can Redis guarantee atomicity for multi-key operations?**
- MULTI/EXEC block: queue commands, execute atomically (but not in Cluster if keys on different nodes)
- Lua scripts: execute on the server atomically — no other command runs in between
- WATCH + MULTI/EXEC: optimistic locking — EXEC fails if watched key changed since WATCH

**Q: What happens to your cache when the DB has a major migration or schema change?**
- Cache stores serialized objects (JSON, protobuf) — old schema objects may be in cache
- Solution: versioned cache keys — change key from `user:1234` to `user_v2:1234` on schema change
- Old keys expire naturally via TTL — no need to mass-invalidate
- Dual-read period: support both v1 and v2 deserialization until old TTLs expire
