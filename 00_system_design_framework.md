# System Design Interview Framework
### Senior Engineer | FAANG Preparation Guide

---

## The 4-Step Interview Framework

Every FAANG system design interview follows the same arc. Master this structure and you'll never lose points on process.

```
Step 1: Clarify Requirements     (~5 min)
Step 2: Capacity Estimation      (~5 min)
Step 3: High-Level Design        (~10 min)
Step 4: Deep Dive & Trade-offs   (~30 min)
```

---

## Step 1 — Clarify Requirements

Never jump into designing. Ask questions first. Interviewers **want** to see you gather requirements — it signals seniority.

### Functional Requirements (what the system does)
- What are the core use cases? (Read? Write? Both?)
- What does the API look like from the client's perspective?
- Any special features? (e.g., real-time, search, notifications)

### Non-Functional Requirements (how the system behaves)
Always address these explicitly:

| Property | Questions to ask |
|----------|-----------------|
| **Scale** | How many users? DAU/MAU? QPS at peak? |
| **Latency** | What's the acceptable p99 latency? Real-time? |
| **Availability** | 99.9%? 99.99%? Can we afford downtime? |
| **Consistency** | Strong vs. eventual? What happens on conflict? |
| **Durability** | Can we lose data? For how long? |
| **Geography** | Global or single-region? |

### What NOT to build
- Explicitly state what's **out of scope** (e.g., "I'll skip billing, auth, analytics")

---

## Step 2 — Capacity Estimation

Shows you can reason about scale. Keep numbers round and justify your assumptions.

### Key Numbers to Memorize

```
1 million seconds/day         ≈ 10^6
1 billion requests/day        ≈ 12,000 RPS
Read/Write ratio for most apps ≈ 10:1 to 100:1

Latency targets:
  Memory access   ~100 ns
  SSD read        ~100 µs
  Network (same AZ) ~0.5 ms
  HDD read        ~10 ms
  Network (cross-region) ~100 ms

Storage:
  1 char = 1 byte
  1 int  = 4 bytes
  1 UUID = 16 bytes
  1 image thumbnail = ~100 KB
  1 HD video = ~1 GB/hour
```

### Estimation Template
```
Users:    X DAU
Writes:   X DAU × writes/day / 86,400 = X RPS
Reads:    Writes × read:write ratio = X RPS
Storage:  Writes/day × record_size × retention_days
Bandwidth: RPS × avg_payload_size
```

---

## Step 3 — High-Level Design

Draw a simple block diagram. Start with the **data flow**:

```
Client → Load Balancer → API Servers → [Cache] → Database
                                      → [Message Queue] → Workers
```

### Core Building Blocks (know each one cold)

| Component | When to use | Examples |
|-----------|-------------|---------|
| **CDN** | Static assets, global low-latency | CloudFront, Akamai |
| **Load Balancer** | Distribute traffic, HA | Nginx, AWS ALB |
| **API Gateway** | Auth, rate limiting, routing | Kong, AWS API GW |
| **Cache** | Reduce DB load, low-latency reads | Redis, Memcached |
| **Message Queue** | Async processing, decoupling | Kafka, SQS, RabbitMQ |
| **SQL DB** | ACID, relational, complex queries | PostgreSQL, MySQL |
| **NoSQL DB** | Flexible schema, high write throughput | Cassandra, DynamoDB |
| **Blob Store** | Binary data (images, video) | S3, GCS |
| **Search Engine** | Full-text search, complex queries | Elasticsearch |
| **CDN + Edge** | Video streaming, global distribution | Cloudflare |

---

## Step 4 — Deep Dive & Trade-offs

This is where you **prove seniority**. Pick 2-3 components and go deep. Always discuss trade-offs.

### The CAP Theorem (Know it cold)
> You can only guarantee 2 of: **Consistency**, **Availability**, **Partition Tolerance**

- **CP systems** (Consistent + Partition tolerant): HBase, Zookeeper, MongoDB (configured)
- **AP systems** (Available + Partition tolerant): Cassandra, CouchDB, DynamoDB
- **CA systems**: Not practical in distributed systems (no partition tolerance = no distributed system)

### Consistency Models (ordered weakest → strongest)
```
Eventual Consistency  →  Monotonic Reads  →  Read-your-writes  →  Strong Consistency
(DNS, social feeds)       (user sessions)     (user profile)      (banking, inventory)
```

### Common Deep-Dive Topics

**Database Scaling:**
- **Vertical scaling**: Bigger machine. Simple but has ceiling.
- **Read replicas**: Scale reads. Eventual consistency on replicas.
- **Sharding (horizontal partitioning)**: Shard by user_id, geography, or hash. Discuss hotspot problem.
- **CQRS**: Separate read and write models.

**Caching Strategies:**
- **Cache-aside** (lazy loading): App checks cache → miss → read DB → populate cache. Risk: cold start, stale data.
- **Write-through**: Write to cache and DB simultaneously. Always consistent. Higher write latency.
- **Write-behind**: Write to cache, async flush to DB. Fast writes, risk of data loss.
- **Read-through**: Cache sits in front of DB; auto-populates on miss.

**Cache Eviction Policies:**
- LRU (Least Recently Used) — most common
- LFU (Least Frequently Used) — good for popularity-based workloads
- TTL-based — simple, effective for time-sensitive data

**Database Indexing:**
- B-tree index: range queries, sorted order (default in most SQL DBs)
- Hash index: exact lookups only, O(1)
- Composite index: `(user_id, created_at)` — order matters!
- Covering index: index contains all columns needed by a query — avoids table lookup

**Message Queues:**
- Kafka: persistent, high-throughput, consumer groups, replayed messages
- SQS: managed, at-least-once delivery, simple
- Use when: fan-out, rate limiting, decoupling services, reliable async processing

---

## Common Senior-Level Trade-off Discussions

### SQL vs NoSQL
| | SQL | NoSQL |
|-|-----|-------|
| Schema | Fixed, enforced | Flexible |
| Joins | Yes | No (denormalize) |
| ACID | Full | Partial (BASE) |
| Scale | Vertical + limited horizontal | Horizontal (native) |
| Best for | Relational data, complex queries | Huge scale, simple access patterns |

### Synchronous vs Asynchronous
- **Sync**: Simple, immediate feedback, but tight coupling and cascading failures
- **Async (queues)**: Decoupled, resilient, but harder to debug, eventual consistency

### Push vs Pull (for notifications/feeds)
- **Push (fanout on write)**: Write to every follower at write time. Fast reads, expensive writes, bad for celebrities.
- **Pull (fanout on read)**: Compute feed at read time. Cheap writes, slow reads.
- **Hybrid**: Push for regular users, pull for celebrities (>10K followers).

---

## Data Modeling Tips

### Relational (SQL)
- Normalize first, denormalize later for performance
- Use foreign keys + indexes on join columns
- Partition large tables by date range or user range

### Cassandra / Wide-column
- **Design tables around queries, not entities**
- Partition key = how data is distributed
- Clustering key = sort order within a partition
- No joins → denormalize aggressively

### Redis Data Structures (pick the right one)
| Use case | Data structure |
|----------|---------------|
| Caching objects | String (with JSON serialization) |
| Leaderboard / ranking | Sorted Set (ZSET) |
| Rate limiting | String with INCR + EXPIRE |
| Session store | Hash |
| Pub/sub messaging | Pub/Sub |
| Unique visitor count | HyperLogLog |
| Timeline / feed | List or Sorted Set |

---

## Numbers Every Senior Engineer Knows

### Latency Cheat Sheet
```
L1 cache reference           0.5 ns
Branch mispredict            5 ns
L2 cache reference           7 ns
Mutex lock/unlock            25 ns
Main memory reference        100 ns
Compress 1KB with Zippy      10,000 ns = 10 µs
Send 2KB over 1 Gbps         20,000 ns = 20 µs
SSD random read              150,000 ns = 150 µs
Read 1MB sequentially (mem)  250,000 ns = 250 µs
Round trip within datacenter 500,000 ns = 0.5 ms
Read 1MB sequentially (SSD)  1,000,000 ns = 1 ms
HDD disk seek                10,000,000 ns = 10 ms
Read 1MB sequentially (HDD)  20,000,000 ns = 20 ms
Send packet CA→Netherlands→CA 150,000,000 ns = 150 ms
```

### Availability Cheat Sheet
```
99%     = 3.65 days/year downtime
99.9%   = 8.76 hours/year downtime
99.99%  = 52.6 minutes/year downtime
99.999% = 5.26 minutes/year downtime (5 nines)
```

---

## Interview Anti-Patterns (What NOT to do)

❌ **Jumping to solutions** without clarifying requirements
❌ **Over-engineering** from the start (microservices for 1K users)
❌ **Under-engineering** without acknowledging scale concerns
❌ **Ignoring failure modes** — always ask "what happens when X fails?"
❌ **Not discussing trade-offs** — every choice has a cost
❌ **Silence** — narrate your thinking out loud
❌ **Bikeshedding** on trivial details (exact API field names)
❌ **Not pushing back on hints** — show independent thought

## Interview Pro Tips

✅ **Start with 1-3 sentences describing the system** before any diagram
✅ **Say "I'll start simple and iterate"** — shows maturity
✅ **Estimate before designing** — shows you think about scale
✅ **Name drop technologies confidently** but be ready to justify
✅ **Drive the conversation** — don't wait for questions
✅ **Explicitly state bottlenecks** — "the DB is the bottleneck here, so..."
✅ **End with what you'd improve** given more time

---

*Next: Study each of the 5 deep-dive question files →*
*`01_url_shortener.md` | `02_news_feed.md` | `03_chat_system.md` | `04_distributed_cache.md` | `05_ride_sharing.md`*
