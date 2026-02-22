# Core Building Blocks of System Design
### The Complete Reference — FAANG Senior Interview

> Use this as your encyclopedia. Every component below appears repeatedly across system design questions.
> Know each one: what it is, when to use it, how it works internally, and its trade-offs.

---

## Table of Contents

1. [Load Balancer](#1-load-balancer)
2. [API Gateway](#2-api-gateway)
3. [CDN — Content Delivery Network](#3-cdn--content-delivery-network)
4. [Databases — SQL (Relational)](#4-databases--sql-relational)
5. [Databases — NoSQL](#5-databases--nosql)
6. [Caching Layer (Redis / Memcached)](#6-caching-layer-redis--memcached)
7. [Message Queue & Event Streaming](#7-message-queue--event-streaming)
8. [Blob / Object Storage](#8-blob--object-storage)
9. [Search Engine (Elasticsearch)](#9-search-engine-elasticsearch)
10. [Rate Limiter](#10-rate-limiter)
11. [Distributed ID Generator](#11-distributed-id-generator)
12. [Service Discovery & Configuration](#12-service-discovery--configuration)
13. [Proxies — Forward & Reverse](#13-proxies--forward--reverse)
14. [WebSocket & Real-Time Protocols](#14-websocket--real-time-protocols)
15. [Consistent Hashing](#15-consistent-hashing)
16. [Data Replication & Consensus](#16-data-replication--consensus)

---

## 1. Load Balancer

### What it does
Distributes incoming traffic across multiple server instances. Prevents any single server from becoming a bottleneck. The entry point for every large-scale system.

### Architecture Placement
```
Internet → DNS → Load Balancer → Application Servers → Database
```

### Types

**Layer 4 (Transport Layer) — L4 Load Balancer**
- Routes based on IP address + TCP/UDP port
- Does NOT inspect HTTP content
- Very fast (minimal processing per packet)
- Use for: WebSocket connections, raw TCP traffic, when you need extreme throughput

**Layer 7 (Application Layer) — L7 Load Balancer**
- Routes based on HTTP headers, URL path, cookies, body content
- Can do: content-based routing, SSL termination, request rewriting, caching
- Slightly more overhead, but vastly more flexible
- Use for: REST APIs, microservices routing, A/B testing

### Load Balancing Algorithms

| Algorithm | How it works | Best for |
|-----------|-------------|---------|
| **Round Robin** | Each server in turn: 1→2→3→1→2→3 | Stateless servers with similar capacity |
| **Weighted Round Robin** | Server A gets 60%, Server B gets 40% | Heterogeneous hardware |
| **Least Connections** | Send to server with fewest active connections | Long-lived connections (WebSocket) |
| **IP Hash** | `hash(client_IP) % servers` → same client always to same server | Session affinity (sticky sessions) |
| **Least Response Time** | Send to fastest-responding server | Latency-sensitive workloads |
| **Random** | Randomly pick a server | Simple, good enough for most cases |

### Health Checks
```
Load Balancer → every 10 seconds → GET /health → each server
  200 OK     → server is healthy → send traffic
  Timeout    → server is down → remove from pool

Active health check:  LB actively probes servers
Passive health check: LB monitors real traffic; too many errors = remove server
```

### High Availability of the LB Itself
- Run two LB instances (active-passive)
- Use **Virtual IP (VIP)**: DNS points to a floating IP that moves to the active LB
- If primary fails: **keepalived** / heartbeat detects failure → VIP floats to secondary
- Or use a cloud-managed LB (AWS ALB, GCP LB) — HA built-in, managed by provider

### Key Trade-offs
- **Sticky sessions** (IP hash) help stateful servers but cause uneven load if one client is heavy
- **SSL termination** at LB: decrypts once at LB, sends plain HTTP to backend (less CPU on servers, but traffic inside cluster is unencrypted — use internal TLS if needed)
- **L4 vs L7**: L4 is faster; L7 is smarter

---

## 2. API Gateway

### What it does
A single entry point for all client-to-microservice communication. Acts as a smart reverse proxy that handles cross-cutting concerns so individual services don't have to.

### Responsibilities
```
Client Request → API Gateway handles:
  ├── Authentication / Authorization (JWT validation, OAuth)
  ├── Rate Limiting (per user, per IP, per API key)
  ├── Request Routing (route /users/* to User Service, /orders/* to Order Service)
  ├── SSL Termination
  ├── Request/Response Transformation (protocol conversion, format translation)
  ├── Logging & Tracing (attach request ID, log to central system)
  ├── Circuit Breaking (stop cascading failures)
  ├── Caching (cache GET responses)
  └── API Versioning (route /v1/* vs /v2/*)
```

### Architecture
```
Mobile App ──┐
Web Client ──┼──► API Gateway ──► User Service
Partner API ─┘             ├──► Order Service
                           ├──► Payment Service
                           └──► Notification Service
```

### API Gateway vs Load Balancer

| | Load Balancer | API Gateway |
|-|--------------|------------|
| **Level** | L4 or L7 | L7 only |
| **Routing** | By server capacity | By URL path, method, headers |
| **Auth** | No | Yes |
| **Rate limiting** | Basic | Advanced (per user, per plan) |
| **Protocol support** | Any TCP | HTTP/REST/GraphQL/gRPC/WebSocket |
| **Transformations** | No | Yes |

### Popular Implementations
- **Kong**: open-source, plugin ecosystem, Nginx under the hood
- **AWS API Gateway**: managed, scales automatically, tight AWS integration
- **Nginx**: can act as API gateway with custom config
- **Envoy**: high-performance, used in service meshes (Istio)

### BFF — Backend for Frontend Pattern
Instead of one API gateway for all clients, create a separate gateway per client type:

```
Mobile App → Mobile BFF (optimized API for mobile: small payloads, batched calls)
Web App    → Web BFF    (optimized for web: richer data, different auth flow)
Partners   → Partner BFF (rate limited, metered, API key auth)
```

---

## 3. CDN — Content Delivery Network

### What it does
A globally distributed network of servers (Points of Presence / PoPs) that cache content close to users. Reduces latency by serving from the nearest edge location instead of the origin server.

### How CDN Caching Works
```
User in London requests /images/hero.jpg:

1. DNS resolves CDN domain → nearest CDN PoP (Frankfurt)
2. Frankfurt PoP: Is /images/hero.jpg cached?
   HIT  → Serve from Frankfurt cache (~5ms to London)
   MISS → Fetch from origin server (US-East, ~100ms)
         → Cache at Frankfurt for next requests
         → Serve to user
```

### What to Put on CDN

**Good for CDN (static, cacheable):**
- Images, videos, fonts, CSS, JavaScript bundles
- Pre-rendered HTML pages
- Large file downloads
- API responses with appropriate `Cache-Control` headers

**Bad for CDN (dynamic, personalized):**
- Authenticated user data
- Real-time prices / inventory
- Anything that changes per-request (without cache key differentiation)

### Cache Control Headers
```http
Cache-Control: public, max-age=31536000, immutable
  public      → CDN may cache this
  max-age     → how long to cache (seconds)
  immutable   → content never changes (safe for versioned assets)

Cache-Control: no-cache
  → Must revalidate with origin on every request (CDN still caches, but checks freshness)

Cache-Control: no-store
  → Never cache (sensitive data)
```

### Cache Invalidation Strategies
```
Problem: You cached /styles.css for 1 year, but just deployed new CSS.

Strategy 1: URL fingerprinting (recommended)
  /styles.abc123.css → change filename on deploy → old URL still cached, new URL fetched
  No invalidation needed — old file still valid, users get new URL

Strategy 2: Cache purge API
  curl -X DELETE https://cdn.example.com/purge?path=/styles.css
  Propagates to all PoPs in ~30 seconds
  Use for: emergency fixes on static URLs

Strategy 3: Short TTL
  max-age=60 → cached for only 1 minute
  Eventual consistency: stale content for up to 60 seconds
  High origin load (every user after 60 seconds triggers a cache miss)
```

### CDN for Dynamic Content
Modern CDNs (Cloudflare Workers, AWS Lambda@Edge) can run code at the edge:

```
Edge Worker at Frankfurt CDN PoP:
  - Authenticate JWT tokens at edge (no round trip to origin)
  - Personalize content (inject user name) without going to origin
  - A/B testing at edge
  - Redirect logic
  - Security rules (block bad IPs, rate limit)
```

### Key CDN Metrics
- **Hit rate**: % of requests served from cache (target > 90%)
- **TTFB (Time to First Byte)**: CDN hit should be < 20ms
- **Cache-Control compliance**: are you setting correct headers?

---

## 4. Databases — SQL (Relational)

### When to Use SQL
- Data with clear relationships and need for JOIN queries
- ACID transactions required (bank transfers, order processing)
- Complex queries, aggregations, reporting
- Schema is well-defined and unlikely to change drastically

### ACID Properties
```
Atomicity:   Transaction succeeds fully or fails fully (no partial writes)
Consistency: DB always moves from one valid state to another
Isolation:   Concurrent transactions don't see each other's partial state
Durability:  Once committed, data survives crashes (written to disk)
```

### Isolation Levels (Ordered Weakest → Strongest)

| Level | Dirty Read | Non-repeatable Read | Phantom Read |
|-------|-----------|---------------------|-------------|
| **Read Uncommitted** | ✅ possible | ✅ possible | ✅ possible |
| **Read Committed** | ❌ prevented | ✅ possible | ✅ possible |
| **Repeatable Read** | ❌ prevented | ❌ prevented | ✅ possible |
| **Serializable** | ❌ prevented | ❌ prevented | ❌ prevented |

> Default in PostgreSQL: **Read Committed**. Default in MySQL InnoDB: **Repeatable Read**.

### Indexing Deep Dive

**B-tree Index** (default):
```
Structure: balanced tree
Supports:  =, <, >, BETWEEN, ORDER BY, GROUP BY
O(log N) lookup, O(log N) insert/delete
Used for:  almost everything

CREATE INDEX idx_user_email ON users(email);
-- Query: WHERE email = 'x@y.com' → uses index → O(log N)
```

**Hash Index**:
```
Structure: hash map
Supports:  = only (no range queries)
O(1) lookup (ideal for exact matches)
Used for:  equality-only lookups, in-memory tables
```

**Composite Index**:
```
CREATE INDEX idx_user_created ON users(status, created_at);

Useful for: WHERE status = 'active' AND created_at > '2026-01-01'
Leftmost prefix rule: also usable for WHERE status = 'active' alone
NOT usable for: WHERE created_at > '2026-01-01' alone (no leftmost column)
```

**Covering Index**:
```
Index contains ALL columns needed by the query → no table lookup needed

CREATE INDEX idx_covering ON orders(user_id, status, created_at, total);
SELECT total FROM orders WHERE user_id = 1 AND status = 'paid'
  → All columns in index → no row fetch → "Index Only Scan" → fastest
```

**Partial Index**:
```
Index only for rows matching a condition → smaller, faster

CREATE INDEX idx_active_users ON users(email) WHERE status = 'active';
-- Only indexes active users — less storage, faster than indexing all users
```

### SQL Scaling Strategies

**Read Replicas**:
```
Primary (writes) → async replication → Replica 1 (reads)
                                    → Replica 2 (reads)
                                    → Replica 3 (reads)

App reads from replicas → offloads primary
Lag: typically < 1 second (monitor replication_lag!)
Consistency: replica may return slightly stale data
```

**Connection Pooling (PgBouncer, ProxySQL)**:
```
Problem: DB connections are expensive (memory per connection, TCP overhead)
         10,000 app instances × 10 connections each = 100,000 DB connections → DB crashes

Solution: Connection pool sits between app and DB
  App → PgBouncer pool (1000 connections) → DB (100 connections)
  Pool multiplexes: 1000 app connections reuse 100 actual DB connections
```

**Vertical Scaling**: Bigger machine → more RAM, faster disk. Simple. Has a ceiling (~128 cores, ~6TB RAM for largest cloud instances).

**Horizontal Sharding**:
```
Shard by user_id:
  users with id 1-10M     → Shard 1
  users with id 10M-20M   → Shard 2
  users with id 20M-30M   → Shard 3

Shard by geography:
  US users     → US shard
  EU users     → EU shard
  APAC users   → APAC shard

Problems introduced:
  - JOINs across shards are impossible (or very expensive)
  - Re-sharding is painful (data migration)
  - Hotspot: if one shard gets more traffic (e.g., all celebrities in one shard)
```

---

## 5. Databases — NoSQL

### The 4 NoSQL Families

#### 5a. Key-Value Store (Redis, DynamoDB, Riak)
```
Interface: GET(key) → value, PUT(key, value), DELETE(key)
Data:      Any blob (string, JSON, binary)

Use cases:
  - Session storage
  - Cache
  - Real-time leaderboards (Redis sorted sets)
  - Shopping cart (DynamoDB)

Performance: O(1) operations, sub-millisecond latency
Limitation:  No queries (can't query by value, only by key)
```

#### 5b. Document Store (MongoDB, Firestore, CouchDB)
```
Interface: Store and query JSON-like documents
Data:      Nested JSON documents with any schema

{
  "_id": "user123",
  "name": "Omar",
  "address": { "city": "Dubai", "country": "UAE" },
  "tags": ["admin", "premium"]
}

Use cases:
  - Content management (blog posts, product catalogs)
  - User profiles with variable schema
  - Event logs

Performance: Rich queries, but no JOINs (denormalize instead)
Limitation:  No ACID across documents (MongoDB has limited multi-doc transactions)
```

#### 5c. Wide-Column Store (Cassandra, HBase, Google Bigtable)
```
Data model: Rows with dynamic columns, organized by partition key

Table: messages
  Partition Key: conversation_id → determines which node stores the data
  Clustering Key: message_id (TimeUUID) → sort order within partition

  conversation_id  | message_id        | sender_id | content
  ─────────────────┼───────────────────┼───────────┼─────────
  abc123           | 2026-01-01 10:00  | user1     | "Hey"
  abc123           | 2026-01-01 10:01  | user2     | "Hi!"

Rules:
  - Design tables around query patterns (not entities)
  - No JOINs — denormalize everything
  - Partition key = how data is distributed across cluster
  - Clustering key = how data is sorted within a partition

Use cases:
  - Time-series data (metrics, logs, IoT sensor data)
  - Message/event history
  - User activity feeds
  - Anything with high write throughput

Performance:
  - Writes: extremely fast (append-only LSM tree)
  - Reads: fast if partition key known; slow for full scans
  - Linear horizontal scaling
```

#### 5d. Graph Database (Neo4j, Amazon Neptune, TAO at Meta)
```
Data model: Nodes + Edges with properties
  Node:  entity (User, Post, Product)
  Edge:  relationship (FOLLOWS, LIKES, PURCHASED)

Cypher query (Neo4j):
  MATCH (u:User)-[:FOLLOWS]->(friend)-[:LIKES]->(post)
  WHERE u.name = "Omar"
  RETURN post.title

Use cases:
  - Social networks (friend-of-friend queries)
  - Recommendation engines
  - Fraud detection (money flow networks)
  - Knowledge graphs

Performance:
  - Traversal queries (hop along edges) are extremely fast
  - Not good for: bulk scans, aggregations
```

### Cassandra Deep Dive (Most Common at FAANG)

**Replication and Consistency:**
```
Replication Factor (RF): how many copies of each partition exist
  RF=3 → 3 nodes hold the data (1 primary + 2 replicas)

Consistency Level controls how many replicas must agree:
  ONE:    fastest, least consistent (1 of 3 replicas respond)
  QUORUM: (RF/2)+1 = 2 of 3 replicas must agree → balanced
  ALL:    all 3 replicas must agree → slowest, strongest consistency

Formula for strong consistency: W + R > RF
  Write QUORUM (W=2) + Read QUORUM (R=2) > RF=3 → 2+2=4 > 3 ✓
```

**LSM Tree (Log-Structured Merge Tree):**
```
Why Cassandra writes are fast:

Write comes in → goes to MemTable (in-memory) → acknowledge immediately
Background: MemTable flushed to SSTable (on disk) when full
Periodically: SSTables compacted (merged, deduplicates, removes tombstones)

vs B-tree (SQL):
  B-tree: in-place update → random disk writes → slower on spinning disks
  LSM:    append-only → sequential disk writes → much faster

Trade-off: LSM reads are slower (may need to check multiple SSTables)
Solution:  Bloom filters (probabilistic check: "is this key in this SSTable?")
```

---

## 6. Caching Layer (Redis / Memcached)

*(See `04_distributed_cache.md` for the full deep-dive)*

### Quick Reference

**Redis Data Structures:**
```
String:       SET key value / GET key
              Use: caching serialized objects, counters (INCR)

List:         LPUSH key val / LRANGE key 0 -1
              Use: recent activity feed, job queue

Set:          SADD key member / SMEMBERS key
              Use: unique visitor tracking, tags, friends list

Sorted Set:   ZADD key score member / ZREVRANGE key 0 9
              Use: leaderboards, feed ordering, rate limiting
              Key property: O(log N) insert, O(log N) rank query

Hash:         HSET key field value / HGETALL key
              Use: user profile (field-level get/set)

HyperLogLog:  PFADD key element / PFCOUNT key
              Use: approximate unique count (~0.81% error, O(1) space)

Pub/Sub:      PUBLISH channel message / SUBSCRIBE channel
              Use: real-time notifications, cache invalidation broadcast

Stream:       XADD key * field val / XREAD COUNT 10 STREAMS key id
              Use: persistent event log, consumer groups
```

**When to Choose Redis vs Memcached:**
- Redis: rich data types, persistence, replication, pub/sub → almost always
- Memcached: pure string cache, slightly more memory efficient, multi-threaded → legacy systems

**Cache Patterns Summary:**
```
Cache-aside (most common): App manages cache explicitly
Write-through:             Write to cache and DB simultaneously
Write-behind:              Write to cache, async flush to DB (risk: data loss)
Read-through:              Cache auto-fetches from DB on miss
```

---

## 7. Message Queue & Event Streaming

### Why Message Queues?

```
Without queue:
  Service A calls Service B synchronously → B is slow/down → A fails too
  Tight coupling → cascading failures

With queue:
  Service A publishes to queue → returns immediately
  Service B consumes from queue when ready
  Decoupled → A doesn't care if B is slow or down
```

### The Two Paradigms

**Message Queue (Point-to-Point):** One consumer gets each message. Message deleted after consumption.
```
Producer → [Queue] → Consumer 1 gets message 1
                   → Consumer 2 gets message 2
                   → Consumer 3 gets message 3

Examples: SQS, RabbitMQ
Use cases: task queues, job distribution, email sending
```

**Pub/Sub (Fan-out):** All subscribers get every message.
```
Producer → [Topic] → Subscriber 1 gets message
                   → Subscriber 2 gets message
                   → Subscriber 3 gets message

Examples: Kafka topics, Google Pub/Sub, Redis Pub/Sub
Use cases: event broadcasting, audit logs, data pipeline
```

### Apache Kafka — Deep Dive

Kafka is the FAANG standard for high-throughput event streaming. Know it cold.

**Core Concepts:**
```
Topic:     Named stream of events (e.g., "user-logins", "order-placed")
Partition: Topic split into N ordered partitions for parallelism
Offset:    Position of a message within a partition (monotonically increasing)
Consumer Group: Group of consumers sharing the work of consuming a topic
  - Each partition assigned to exactly ONE consumer in the group
  - N partitions → can have up to N consumers in parallel
Broker:    A Kafka server node
Cluster:   Multiple brokers

Architecture:
  Producer → Broker 1 [Partition 0: msg0, msg1, msg2...]
             Broker 2 [Partition 1: msg0, msg1, msg2...]
             Broker 3 [Partition 2: msg0, msg1, msg2...]

Consumer Group A: Consumer0 → Partition0, Consumer1 → Partition1, Consumer2 → Partition2
Consumer Group B: Also consuming all partitions independently (separate offset)
```

**Why Kafka is fast:**
```
Sequential disk writes: append-only log → SSD sequential write is ~500 MB/s
Zero-copy: data goes disk → network without user-space copy (sendfile syscall)
Batching: messages batched and compressed before sending
Replication: replicated across brokers for durability
```

**Message Retention:**
```
Kafka retains messages for a configurable period (default 7 days), regardless of consumption.
→ Consumers can replay events from any offset in the past
→ New consumers can backfill historical data
→ Unlike SQS: message not deleted after consumption

Use this when: you need replay capability, audit log, or multiple independent consumers
```

**Partitioning Strategy:**
```
Default: round-robin across partitions
By key: hash(key) % partitions → all messages with same key go to same partition
  Example: hash(user_id) → all events for a user arrive in order to same consumer

Problem: key-based partitioning can create hotspots
  If 90% of traffic is from user_id=123 → one partition overwhelmed
  Solution: add salt to key → hash(user_id + random_suffix) → spread load
```

**Delivery Guarantees:**
```
At-most-once:  Messages may be lost. Fast. (log and forget)
At-least-once: Messages may be duplicated. Consumer must be idempotent.
Exactly-once:  No loss, no duplicate. Kafka supports this with transactions + idempotent producers.
               More complex to implement end-to-end.
```

### SQS vs Kafka vs RabbitMQ Comparison

| | SQS | Kafka | RabbitMQ |
|-|-----|-------|---------|
| **Model** | Queue (P2P) | Log (pub/sub) | Queue + routing |
| **Retention** | Up to 14 days, deleted on consume | Up to forever, offset-based | Until consumed |
| **Replay** | ❌ No | ✅ Yes | ❌ No |
| **Throughput** | High | Very High (millions/sec) | Medium |
| **Ordering** | Per-FIFO queue | Per-partition | Per-queue |
| **Management** | AWS managed | Self-managed (or Confluent) | Self-managed |
| **Best for** | AWS ecosystem, simple tasks | High-throughput streaming | Complex routing, enterprise |

---

## 8. Blob / Object Storage

### What it does
Stores arbitrary binary data (files) at massive scale. Not a filesystem — a flat namespace of `bucket/key → file`.

### Key Properties
```
Flat namespace:   No real directories (just key prefixes)
Durability:       AWS S3 = 99.999999999% (11 nines) — triple redundant across AZs
Capacity:         Unlimited (pay per GB)
Access:           HTTP(S) — GET and PUT via REST
Not for:          Low-latency (< 5ms) random access (use databases for that)
```

### Common Use Cases
```
User content:        profile photos, uploaded images, documents
Media:               video files, audio files, podcast episodes
Backups:             database snapshots, logs
Static assets:       website CSS, JS, fonts (served via CDN)
Data lake:           raw event data for analytics pipelines
Build artifacts:     Docker images, compiled binaries
```

### Pre-Signed URLs (The Key Pattern)
```
Problem: You don't want uploads/downloads going through your servers
         (bandwidth cost, latency, scaling)

Solution: Generate a time-limited signed URL that lets the client
          talk directly to S3

Upload flow:
  1. Client → App Server: "I want to upload a 10MB image"
  2. App Server → S3: GeneratePresignedPutUrl(key, expires=60s, max_size=10MB)
  3. App Server → Client: { upload_url, object_key }
  4. Client → S3 directly: PUT upload_url [file bytes]
  5. Client → App Server: "Upload done, key = {object_key}"
  6. App Server → DB: INSERT INTO posts(image_url = ...)

Download flow:
  For private files: App Server generates signed GET URL (expires in 1 hour)
  For public files:  Store S3 URL in DB, serve via CDN
```

### Storage Classes (AWS S3)
```
S3 Standard:           Frequently accessed. High cost, sub-millisecond access.
S3 Standard-IA:        Infrequent Access. ~45% cheaper. 30-day minimum.
S3 One Zone-IA:        Single AZ. Cheaper, lower durability.
S3 Glacier:            Archive. Minutes to hours retrieval. Very cheap.
S3 Glacier Deep Archive: Coldest tier. 12-48 hours retrieval. Cheapest.

Use in design:
  Hot data (recent files) → S3 Standard
  Warm data (< 6 months) → S3 Standard-IA
  Cold data (archives)   → S3 Glacier
  Lifecycle policy: auto-transition between tiers based on age
```

### Multipart Upload (for large files)
```
Files > 100 MB: split into parts, upload in parallel, reassemble on S3
  1. InitiateMultipartUpload → uploadId
  2. UploadPart (part 1: bytes 0-50MB)    → etag1
     UploadPart (part 2: bytes 50-100MB)  → etag2   (parallel)
     UploadPart (part 3: bytes 100-150MB) → etag3   (parallel)
  3. CompleteMultipartUpload(uploadId, [etag1, etag2, etag3])

Benefits: resume on failure (retry individual parts), faster via parallelism
```

---

## 9. Search Engine (Elasticsearch)

### What it does
Full-text search over large datasets. Supports fuzzy matching, typo tolerance, ranked relevance, aggregations, and complex filtering.

### When to Use
- Full-text search (find posts containing "distributed systems")
- Autocomplete / typeahead
- Log analytics (ELK stack: Elasticsearch, Logstash, Kibana)
- Faceted search (e-commerce filters: brand, price range, rating)
- Geospatial search (`geo_distance` queries)

### How it Works — Inverted Index

```
Documents:
  Doc1: "Distributed systems are complex"
  Doc2: "System design interviews are fun"
  Doc3: "Design patterns for distributed systems"

Inverted index:
  "distributed"  → [Doc1, Doc3]
  "systems"      → [Doc1, Doc3]
  "design"       → [Doc2, Doc3]
  "complex"      → [Doc1]
  "interviews"   → [Doc2]

Query: "distributed design"
  → Fetch posting lists for "distributed" and "design"
  → Intersect/union → [Doc3 appears in both] → Doc3 ranked highest
```

**TF-IDF Relevance Scoring:**
```
TF (Term Frequency):  how often does "distributed" appear in Doc1?
                      More occurrences = more relevant
IDF (Inverse Doc Frequency): how rare is "distributed" across all docs?
                              Rare terms are more discriminating
Score = TF × IDF
```

### Elasticsearch Architecture
```
Index:     Collection of documents (like a table)
Shard:     Index split into N shards (Lucene instances)
           Each shard is an independent search engine
           Distributed across nodes for parallelism
Replica:   Copy of a shard for redundancy and read scaling

Query path:
  Client → Any node (Coordinator) → broadcasts to all shards → collect results
                                  → merge, rank, return top K
```

### Key Features for Interviews
```
Fuzzy matching:   "elasticsearch" matches "elasticserach" (typo) — edit distance
Analyzers:        Text processing pipeline:
  Character filter → Tokenizer → Token filter
  "Hello, World!" → ["hello", "world"] (lowercase, remove punctuation)

Autocomplete:     edge_ngram tokenizer → "sys" → ["sys", "syst", "syste", "system"]
Aggregations:     GROUP BY equivalent — count by category, avg price by brand
Highlight:        Return matched snippet with search terms highlighted

GET /posts/_search
{
  "query": { "match": { "content": "distributed systems" } },
  "highlight": { "fields": { "content": {} } },
  "agg": { "by_tag": { "terms": { "field": "tags" } } }
}
```

### Sync Pattern: DB → Elasticsearch
```
Problem: Elasticsearch is a search index, not a source of truth.
         Must stay in sync with your primary DB.

Option A: Dual write (anti-pattern)
  App writes to DB AND Elasticsearch simultaneously
  Risk: partial failure — DB write succeeds, ES write fails → out of sync

Option B: Change Data Capture (CDC) — recommended
  DB binlog (MySQL) or WAL (PostgreSQL) → Kafka → ES consumer
  Debezium captures every DB change → publishes to Kafka → Elasticsearch indexer
  Eventually consistent, but guaranteed to sync

Option C: Batch sync
  Nightly job: export changed rows from DB → re-index in Elasticsearch
  Simple, but up to 24-hour lag
```

---

## 10. Rate Limiter

### Why Rate Limiting?
- Prevent abuse (DoS attacks, bots, scrapers)
- Ensure fair use (API quotas)
- Protect downstream services from overload
- Enforce pricing tiers (free: 100 req/day, paid: 10,000 req/day)

### Where to Place the Rate Limiter
```
Option A: Client-side     → unreliable (clients can bypass)
Option B: API Gateway     → centralized, before any service logic (recommended)
Option C: Per-service     → for internal rate limiting (service to service)
```

### Rate Limiting Algorithms

**Fixed Window Counter:**
```
Divide time into fixed windows (e.g., 1-minute buckets)
Count requests per user per window
Reset counter at window boundary

Key: "rate:{user_id}:{minute}"
On request: INCR key → if count > limit → reject → EXPIRE key 60

Problem: Burst at boundary — user sends 100 req at 0:59 and 100 req at 1:01
         = 200 requests in 2 seconds, both windows say "okay"
```

**Sliding Window Log:**
```
Store timestamp of each request in a sorted set

On request:
  ZREMRANGEBYSCORE "rate:{user_id}" 0 (now - 60)  → remove old
  ZADD "rate:{user_id}" now now                    → add current
  count = ZCARD "rate:{user_id}"
  if count > limit → reject
  EXPIRE "rate:{user_id}" 60

Accurate but memory-heavy (stores every timestamp)
```

**Sliding Window Counter (Hybrid — Recommended):**
```
Approximate sliding window using two fixed windows:

count = curr_window_count × (elapsed in current window / window_size)
      + prev_window_count × (1 - elapsed / window_size)

if count > limit → reject

Memory-efficient (just 2 counters), accurate to ~0.003% error
```

**Token Bucket:**
```
Bucket starts full (capacity = burst_limit)
Tokens refill at constant rate (refill_rate = sustained_limit)
Each request consumes 1 token
No token available → reject

Allows bursts up to bucket capacity
Sustained rate enforced by refill rate
Implementation: store (tokens, last_refill_time) per user in Redis
```

**Leaky Bucket:**
```
Requests enter bucket regardless of rate (up to capacity)
Requests exit at constant rate (like a leaky bucket)
Bucket overflows → excess requests rejected

Smooths out bursts (output is always at constant rate)
Good for: enforcing constant downstream processing rate
```

### Distributed Rate Limiting

```
Challenge: 10 API servers each maintain separate counters → user can send
           100 req to server1 and 100 req to server2 → bypass rate limit

Solution A: Centralized Redis counter
  All servers increment the same Redis key
  Atomic: INCR is atomic in Redis — no race conditions
  Drawback: Redis becomes a bottleneck; adds ~0.5ms per request

Solution B: Local + global (sync periodically)
  Each server has local counter; sync to Redis every 100ms
  Accept slight over-limit (user may exceed by 10% during sync window)
  Much lower Redis load

Solution C: Rate limit at API gateway (single point)
  Gateway is the only entry point → single counter per user
  Eliminates distributed counter problem entirely
```

---

## 11. Distributed ID Generator

### The Problem
Multiple services/servers need to generate globally unique IDs without coordination overhead.

### Option A: UUID v4 (Random)
```
Format: 550e8400-e29b-41d4-a716-446655440000
Size:   128 bits / 16 bytes
Unique: 2^122 ≈ 5 × 10^36 combinations → effectively no collisions

Pros:  Decentralized (no server needed), simple to generate
Cons:  Not sortable (random), large (128-bit vs 64-bit), not sequential
       → Bad for DB primary keys (causes B-tree fragmentation on insert)
```

### Option B: Database Auto-Increment
```
Single DB generates sequential IDs

Pros:  Simple, perfectly sequential, compact (64-bit integer)
Cons:  Single point of failure, limited throughput (~10K/sec per DB)
       Reveals business volume (ID=1234 on day 1, ID=5M on day 2)
```

### Option C: Snowflake ID (Twitter, Recommended)
```
64-bit ID:
  1 bit   | 41 bits         | 10 bits    | 12 bits
  unused  | timestamp (ms)  | machine ID | sequence

Timestamp:  milliseconds since custom epoch (Jan 1, 2020)
            41 bits → covers 69 years
Machine ID: assigned to each server (from Zookeeper on startup)
            10 bits → up to 1,024 machines
Sequence:   auto-increments within same millisecond, resets per ms
            12 bits → 4,096 IDs per millisecond per machine

Total capacity: 4,096 IDs/ms × 1,024 machines = 4 million IDs/ms = 4 billion/sec

Properties:
  ✅ Globally unique (no coordination between machines)
  ✅ Sortable by time (older ID < newer ID)
  ✅ 64-bit (fits in a BIGINT column)
  ✅ No central bottleneck
  ❌ Requires NTP (clock skew → IDs out of order)
  ❌ Machine ID management (Zookeeper dependency)

Clock skew problem: if server clock goes backward → duplicate IDs possible
Solution: wait until clock catches up, or reject if skew > N milliseconds
```

### Option D: Sonyflake (Distributed Snowflake Variant)
```
39 bits timestamp (10ms resolution) | 8 bits sequence | 16 bits machine ID
→ Supports more machines (65,536 vs 1,024) at cost of lower sequence rate
Used by: Sony's Go implementation of distributed IDs
```

### Option E: Pre-Generated Key Pool
```
Background service generates random IDs in advance
Stores in "available_keys" table (or Redis SET)
On request: pop one key from the pool (atomic)

Used by: TinyURL, systems needing guaranteed unique random-looking IDs
Pros: Custom format (e.g., base-62 alphanumeric), no timestamp leakage
Cons: Extra infrastructure, key generation service is bottleneck
```

---

## 12. Service Discovery & Configuration

### Why Service Discovery?
```
Problem: Microservice A needs to call Microservice B.
         B runs on 50 dynamic instances (IPs change on deploy, scaling events).
         How does A know where to send requests?

Solution: Service Registry — a central directory of service → IP:Port mappings
```

### Service Registry Options

**Zookeeper:**
```
Distributed coordination service
Services register themselves: /services/userService/instance1 → "10.0.1.5:8080"
Other services query registry to find available instances
Also used for: leader election, distributed locks, configuration management

Guarantee: CP (consistent + partition tolerant) — prefers consistency over availability
```

**etcd (Kubernetes uses this):**
```
Key-value store built for distributed configuration
Strong consistency (Raft consensus)
Watch mechanism: clients notified immediately when a key changes
Used for: Kubernetes cluster state, distributed locking, service discovery
```

**Consul (HashiCorp):**
```
Built specifically for service discovery
Features: health checks, DNS interface, key-value store, service mesh
Services register with Consul; Consul runs health checks
DNS interface: curl http://userservice.service.consul:8080 → resolves to healthy instance
```

### Client-Side vs Server-Side Discovery

**Client-Side Discovery:**
```
Service A → Registry: "Give me instances of Service B"
Registry → A: [10.0.1.5:8080, 10.0.1.6:8080, 10.0.1.7:8080]
A picks one using client-side load balancing (round-robin, etc.)

Pros: No extra hop, client has full control
Cons: Client must implement discovery logic; each language/framework needs it
```

**Server-Side Discovery:**
```
Service A → Load Balancer: "I need Service B"
Load Balancer queries registry → picks healthy instance → forwards request

Pros: Client is dumb — just hits an endpoint
Cons: LB is an extra hop, another component to manage
```

### Distributed Configuration Management
```
Problem: You have 1,000 service instances. Need to change a config value.
         Can't restart all 1,000 instances.

Solution: External configuration store (etcd, AWS Parameter Store, Consul KV)

  Service reads config from etcd on startup and watches for changes:
  etcd.watch("/config/userService/maxConnections") → callback on change

  Operator updates etcd: put /config/userService/maxConnections 500
  All 1,000 instances notified within seconds → update in-memory config
  No restart required

Feature flags: same pattern — toggle features without deploy
  put /flags/newCheckoutFlow "true" → instances see the change, enable feature
```

---

## 13. Proxies — Forward & Reverse

### Forward Proxy
```
Client → [Forward Proxy] → Internet

Client's IP is hidden from the server — server sees proxy's IP
Use cases:
  - Corporate proxy: filter/monitor employee internet access
  - VPN: route all traffic through proxy in another country
  - Anonymization: Tor network is a chain of forward proxies
```

### Reverse Proxy
```
Internet → [Reverse Proxy] → Server

Server's identity hidden from client — client talks to proxy
Use cases:
  - Load balancing (Nginx in front of app servers)
  - SSL termination
  - Caching (cache responses from backend)
  - DDoS protection (absorb traffic, filter malicious requests)
  - Compression (gzip responses before sending to client)
  - API Gateway is a reverse proxy with extra features

Examples: Nginx, HAProxy, Cloudflare, Envoy
```

### Nginx as Reverse Proxy (Configuration Sketch)
```nginx
upstream app_servers {
    server 10.0.1.1:8080;
    server 10.0.1.2:8080;
    server 10.0.1.3:8080;
    least_conn;  # load balancing algorithm
}

server {
    listen 443 ssl;
    ssl_certificate /path/to/cert.pem;

    location / {
        proxy_pass http://app_servers;
        proxy_cache my_cache;                     # cache responses
        proxy_cache_valid 200 10m;                # cache 200s for 10 min
        add_header X-Request-ID $request_id;      # request tracing
        gzip on;                                   # compress responses
    }
}
```

---

## 14. WebSocket & Real-Time Protocols

### Protocol Comparison

| Protocol | Direction | Use case | Overhead |
|----------|-----------|---------|---------|
| **HTTP Short Poll** | Client→Server (repeated) | Simple notifications | High (repeated headers) |
| **HTTP Long Poll** | Server→Client (held) | Chat, low-frequency updates | Medium |
| **SSE** | Server→Client (stream) | Live feeds, dashboards, notifications | Low (one persistent connection) |
| **WebSocket** | Bidirectional | Chat, gaming, collaboration, trading | Very low (after handshake) |
| **WebRTC** | Peer-to-Peer | Video/voice calls, data channels | Low (no server for media) |
| **gRPC streaming** | Bidirectional | Service-to-service streaming | Low (HTTP/2 multiplexing) |

### WebSocket Handshake
```
Client → Server:
GET /chat HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==

Server → Client:
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=

After this: raw TCP frames, no HTTP headers
WebSocket frame: 2-byte header + payload (vs 200+ bytes HTTP headers)
```

### Server-Sent Events (SSE)
```
One-way: server pushes to client over persistent HTTP connection
Client:
  const es = new EventSource('/events');
  es.onmessage = (e) => { console.log(e.data); };

Server response:
  Content-Type: text/event-stream
  Cache-Control: no-cache

  data: {"type":"newPost","id":"123"}\n\n
  data: {"type":"like","postId":"456"}\n\n

Pros:  Simple, HTTP (works with existing load balancers), auto-reconnect built-in
Cons:  One-way only (client can't send data on same connection)
       Max 6 connections per browser per domain (HTTP/1.1 limit)
       Use HTTP/2 to multiplex unlimited SSE streams
```

---

## 15. Consistent Hashing

*(See `04_distributed_cache.md` for deep-dive)*

### Quick Reference
```
Ring of positions (0 → 2^32):
  - Each server mapped to K virtual positions (vnodes)
  - Each key mapped to position via hash
  - Key assigned to first server clockwise from key position

Benefits:
  - Add server: only 1/N keys move (not all)
  - Remove server: only that server's keys move to next clockwise
  - Virtual nodes: even distribution even with few servers

Used in: Redis Cluster, Cassandra, DynamoDB, Riak, Chord DHT
```

---

## 16. Data Replication & Consensus

### Replication Topologies

**Single-Leader (Master-Replica):**
```
All writes → Primary (leader)
Reads → Replicas (followers)
Primary replicates changes to replicas (async or sync)

Failover: if primary fails → one replica promoted to primary
Problem:  promotion is not instant (10-30 seconds gap → some writes lost)

Async replication: fast, but replica may lag → eventual consistency
Sync replication:  slower (wait for replica ack), but no data loss
```

**Multi-Leader (Multi-Master):**
```
Multiple nodes accept writes
Leaders replicate to each other
Allows writes in multiple data centers (low latency locally)

Problem: Write conflicts — same record updated in two data centers simultaneously
Resolution strategies:
  - Last Write Wins (LWW): timestamp-based → risk of clock skew
  - Application-level merge: app resolves conflicts (shopping cart: merge items)
  - CRDT: Conflict-free Replicated Data Type (math-based automatic merge)
```

**Leaderless (Cassandra, DynamoDB, Riak):**
```
Any node accepts writes
Uses quorum: W + R > N for consistency
  W=2, R=2, N=3: write to 2 → read from 2 → at least 1 overlaps → fresh data

No leader election needed
No failover complexity
Excellent for geo-distributed writes (any region accepts writes)
```

### Raft Consensus Algorithm
```
Used by: etcd, CockroachDB, Consul, TiKV

Purpose: Ensure all nodes agree on the same sequence of operations
         even when some nodes fail or are slow

Key roles:
  Leader:    Accepts all client writes, replicates to followers
  Follower:  Replicates log from leader, serves reads
  Candidate: Seeking to become leader (during election)

Leader election:
  If followers don't hear from leader in election_timeout (150-300ms):
    → Start election: increment term, vote for self, request votes
    → Majority votes → become leader → send heartbeat to all followers

Log replication:
  Leader receives write → appends to log → sends AppendEntries to followers
  When majority (quorum) of followers ack → mark as committed → apply to state machine
  Leader tells followers: "entry at index N is committed" → followers apply

Guarantee: committed entries are never lost (survived on quorum of nodes)
```

---

## Quick Decision Guide

```
When to use what:

Traffic distribution                 → Load Balancer (L4 or L7)
Cross-cutting concerns (auth, limits)→ API Gateway
Static content, global low latency   → CDN
Structured relational data           → PostgreSQL / MySQL
High-write time-series               → Cassandra
Flexible document storage            → MongoDB
Full-text search                     → Elasticsearch
Social graph traversal               → Neo4j / Amazon Neptune
Low-latency cache                    → Redis
Pure string cache (simpler)          → Memcached
Async decoupling, task queue         → SQS or RabbitMQ
High-throughput event streaming      → Apache Kafka
Binary file storage                  → S3 / GCS
Real-time bidirectional comms        → WebSocket
Server-to-client streaming           → SSE
Peer-to-peer audio/video             → WebRTC
Service location                     → Consul / etcd
Distributed configuration            → etcd / AWS Parameter Store
Globally unique sortable IDs         → Snowflake IDs
Distributed consensus/locking        → Zookeeper / etcd (Raft)
```

---

*This file is your reference encyclopedia. In an interview, you cite these components by name, explain why you chose them over alternatives, and discuss trade-offs. That's what separates a senior answer from a junior one.*
