# System Design: News Feed (Twitter / Instagram / Facebook)
### FAANG Senior Interview Deep-Dive

> **Frequency**: #1 most asked at Meta, very common at Google and Twitter.
> **Why they ask it**: Tests fanout architecture, feed ranking, real-time systems, and massive-scale read optimization.

---

## Step 1 — Requirements Clarification

### Functional Requirements
- Users can **post** (tweet, photo, status update)
- Users can **follow** other users
- Users see a **home feed** — posts from people they follow, ranked by relevance/recency
- Feeds update in **near real-time** (new posts appear without refresh)
- Users can **like, comment, share** (out of scope for core design)

### Non-Functional Requirements
- **Scale**: 500 million DAU, 1 billion registered users
- **Availability**: 99.99% — feeds must always load
- **Feed latency**: p99 < 200ms for feed retrieval
- **Post latency**: eventual consistency acceptable — a new post can take 1-5 seconds to appear in follower feeds
- **Celebrity problem**: some accounts have 50+ million followers (Cristiano Ronaldo, Obama)
- Feed freshness: posts older than 7 days deprioritized

### Out of Scope
- Recommendations (accounts to follow)
- Trending topics / search
- Ads ranking
- Notifications

---

## Step 2 — Capacity Estimation

```
DAU:               500 million
Posts/day:         500M × 2 posts/day avg = 1 billion posts/day ≈ 12,000 writes/sec
Feed reads/day:    500M × 10 feed loads/day = 5 billion reads/day ≈ 60,000 reads/sec
Avg following:     300 accounts per user
Fan-out per post:  12,000 posts/sec × 300 followers = 3.6 million feed writes/sec (!)

Post size:
  Text post:  ~1 KB
  With image: ~100 KB (image stored in blob, URL in post)

Storage:
  Posts:      1B posts/day × 1 KB = 1 TB/day text
  Images:     ~30% have images × 1B × 100 KB = 30 TB/day
```

> **Key insight**: The **fanout** (distributing a post to followers' feeds) is the hardest problem. 3.6 million feed-writes per second is not achievable naively.

---

## Step 3 — High-Level Design

### Two Core Services

```
┌─────────────┐      ┌──────────────────┐      ┌──────────────┐
│  Post       │─────▶│  Post Service    │─────▶│  Posts DB    │
│  Service   │      │  (write path)    │─────▶│  (Cassandra) │
└─────────────┘      └────────┬─────────┘      └──────────────┘
                              │ publishes event
                     ┌────────▼─────────┐
                     │  Message Queue   │  (Kafka)
                     │  "new-post"      │
                     └────────┬─────────┘
                              │
               ┌──────────────▼──────────────┐
               │     Fanout Service           │
               │  (decides how to distribute) │
               └──────────────┬──────────────┘
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
       ┌──────────┐    ┌──────────┐    ┌──────────────┐
       │ Feed     │    │ Feed     │    │ Feed Cache   │
       │ Cache    │    │ Cache    │    │ (Redis)      │
       │ User A   │    │ User B   │    │ for N users  │
       └──────────┘    └──────────┘    └──────────────┘

Feed Read Path:
Client → API Gateway → Feed Service → Redis → (Merge + Rank) → Response
```

---

## Step 4 — Deep Dive

### The Fanout Problem (Core of This Design)

When a user posts, their followers need to see it in their feed. Three strategies:

---

#### Strategy 1: Fanout on Write (Push Model)

When User A posts:
1. Persist post to Posts DB
2. Fetch all followers of User A (e.g., 500 followers)
3. For each follower, append `post_id` to their **pre-computed feed** in Redis
4. When follower opens app → feed is already ready in Redis

```
Write: Post → Kafka → Fanout workers → 500 Redis writes
Read:  Fetch pre-built feed from Redis → instant
```

**Pros:**
- Reads are O(1) — just fetch from Redis
- Feed is always ready; very low latency for readers

**Cons:**
- Celebrities are a disaster: posting to 50M followers = 50M Redis writes
- **Hotspot writes** for popular accounts
- Wasted work for inactive users (feed built but never read)
- Harder to handle unfollows (need to invalidate)

**When to use**: Regular users with < ~10,000 followers

---

#### Strategy 2: Fanout on Read (Pull Model)

When follower opens feed:
1. Fetch list of people they follow
2. Query each person's recent posts
3. Merge, sort by timestamp, return top N

```
Write: Just save the post to Posts DB (fast!)
Read:  Fetch following list → N DB queries → merge/sort → expensive
```

**Pros:**
- Writes are trivial
- No wasted computation for inactive users
- Celebrities don't cause write fanout

**Cons:**
- Reads are slow and expensive (following 1000 people = 1000 DB queries)
- Hard to cache because every user's feed is custom
- Latency spikes at read time

**When to use**: Celebrity accounts (can't fanout on write)

---

#### Strategy 3: Hybrid (What Instagram/Twitter Actually Do — Recommended)

Combine both strategies based on follower count:

```
If poster has < 10,000 followers:
  → Fanout on WRITE (push to follower feeds in Redis)

If poster has ≥ 10,000 followers (celebrities):
  → Store post in Posts DB only (no fanout)
  → At read time: merge pre-built feed with celebrity posts

User's actual feed =
  pre-built feed (from Redis) + celebrity posts (fetched on read) + ranked
```

**Trade-off discussion:**
- The 10,000 threshold is a tuning parameter
- Celebrities' posts are fetched lazily on read — acceptable since fewer celebrities
- Regular users' feeds still arrive instantly from Redis

> This is the **correct FAANG answer**. Always mention the hybrid approach.

---

### Feed Storage in Redis

**Data structure**: Redis **Sorted Set (ZSET)**

```
Key:   feed:{user_id}
Score: unix_timestamp (used for sorting)
Value: post_id

Example:
  ZADD feed:123456  1740000100  post:9001
  ZADD feed:123456  1740000200  post:9002
  ZADD feed:123456  1740000300  post:9003

  ZREVRANGE feed:123456 0 19  → returns 20 most recent post IDs (newest first)
```

**Memory calculation**:
```
500M active users × 200 posts in feed × 16 bytes (post_id) = ~1.6 TB Redis
→ Use Redis Cluster (multiple nodes)
→ Only keep feed for recently active users (evict inactive)
```

**TTL strategy**: Set 7-day TTL on feed keys. On cache miss (inactive user), regenerate feed from Posts DB.

---

### Posts Database Design (Cassandra)

Access patterns:
- Write a new post
- Read recent posts by a user (for fanout and profile page)
- Read a specific post by ID

```sql
-- Posts table (Cassandra-style)
CREATE TABLE posts (
  user_id    UUID,
  post_id    UUID,           -- TimeUUID (sortable by time)
  content    TEXT,
  media_urls LIST<TEXT>,
  created_at TIMESTAMP,
  PRIMARY KEY (user_id, post_id)
) WITH CLUSTERING ORDER BY (post_id DESC);
```

- Partition by `user_id` → all posts by a user on the same node (efficient for profile + fanout)
- Clustering by `post_id` (TimeUUID) → sorted by time automatically
- To get user's last 20 posts: `WHERE user_id = X LIMIT 20` — O(1)

---

### Social Graph Storage

**Followers / Following relationship**:

```sql
-- Who does user X follow?
CREATE TABLE following (
  user_id    UUID,
  followed_id UUID,
  followed_at TIMESTAMP,
  PRIMARY KEY (user_id, followed_id)
);

-- Who follows user X? (for fanout)
CREATE TABLE followers (
  user_id    UUID,
  follower_id UUID,
  followed_at TIMESTAMP,
  PRIMARY KEY (user_id, follower_id)
);
```

Denormalize into two tables (following + followers) — Cassandra can't do joins.

**At scale**: Use a dedicated **Graph Database** (like TAO at Meta, or Neo4j) for complex social graph queries. For simple follow/unfollow, Cassandra works.

---

### Feed Ranking

A pure chronological feed is simple but not what any major platform ships. Ranking considers:

- **Recency**: newer posts score higher
- **Engagement**: posts with many likes/comments in short time are boosted
- **Relationship strength**: close friends / frequent interactions score higher
- **Content type**: video vs. text vs. photo (user preference modeling)
- **Diversity**: avoid 10 consecutive posts from the same person

**At the API server level**:
```
1. Fetch 200 candidate posts from Redis (oversample)
2. Apply ranking model (ML inference — separate service)
3. Return top 20 to client
```

> For a design interview: mention that ranking is a separate ML service, and focus on the infrastructure. Don't get lost in the ML details unless they ask.

---

### Real-Time Feed Updates

**Problem**: How do new posts appear in the feed without the user refreshing?

**Option 1: Short Polling**
- Client polls server every 30 seconds
- Simple, but wastes bandwidth and battery

**Option 2: Long Polling**
- Client opens request, server holds it until a new post arrives
- Better, but server holds connections open (resource-heavy at scale)

**Option 3: Server-Sent Events (SSE)**
- One-way persistent connection: server pushes events to client
- Good for feeds (unidirectional: server → client)
- Less overhead than WebSocket

**Option 4: WebSocket**
- Full-duplex persistent connection
- Better for chat (bidirectional), overkill for feeds

> **Recommended for feeds**: SSE or WebSocket depending on whether you also need chat. Mention that a **notification service** (separate from feed service) handles real-time delivery.

---

### Post Ingestion Pipeline

```
Client POST /post
  → API Gateway (auth, rate limiting)
  → Post Service:
      1. Validate content (spam check, size limit)
      2. Upload media to S3 (generate pre-signed URL for direct upload)
      3. Persist post to Cassandra (synchronous — authoritative store)
      4. Publish "new_post" event to Kafka (async)
  → Return post_id to client immediately

  [Async, via Kafka consumers]:
  → Fanout Service: distribute to follower feeds in Redis
  → Notification Service: push notifications to followers
  → Search Index Service: index post for search
  → Analytics Service: track impressions, engagement
```

**Why Kafka?** Decouples the post write from all downstream processing. If fanout service is slow, Kafka buffers. Multiple consumers can process the same event independently.

---

### Handling the Celebrity Problem in Practice

**At read time, merge two feed sources:**

```
fan_feed  = ZREVRANGE feed:{user_id} 0 199     (pre-built from regular users)
celeb_ids = [list of celebrities the user follows]

for each celeb_id:
  celeb_posts = fetch_recent_posts(celeb_id, limit=20)  # from Posts DB / cache

merged = merge_by_timestamp(fan_feed + celeb_posts)
ranked = apply_ranking_model(merged)
return ranked[:20]
```

Cache celebrity recent posts aggressively — they're read by millions:
```
Key:   celeb_posts:{user_id}:latest
TTL:   60 seconds (invalidate on new post)
```

---

## Failure Scenarios

| Failure | Impact | Mitigation |
|---------|--------|-----------|
| Redis node down | Stale feeds | Redis Cluster, read-through fallback to DB |
| Kafka lag | Fanout delay (feeds stale) | Multiple consumer groups, monitor lag |
| Post Service down | Can't create posts | Multiple instances, health checks |
| Cassandra node fails | Read latency spike | Replication factor 3, consistency level QUORUM |
| Fanout too slow | Followers don't see posts | Separate queue per user tier (celebrities vs regular) |

---

## Scale Summary

```
12,000 post writes/sec    → Cassandra handles easily
3.6M fanout writes/sec    → Kafka + parallel fanout workers (scale out)
60,000 feed reads/sec     → Redis (sub-millisecond) + CDN for static assets
```

---

## What Interviewers Listen For

✅ **Fanout on write vs. read** — and when to use each
✅ **Hybrid approach for celebrity accounts** — this is the key insight
✅ **Redis Sorted Set** for pre-built feeds
✅ **Kafka** for async decoupled fanout
✅ **Cassandra schema** with user_id partition key + TimeUUID clustering
✅ **Real-time updates** via SSE or WebSocket
✅ The **ranking pipeline** (even briefly)

---

## Sample Answer Narrative (2-minute version)

*"The hardest part of a news feed is fanout — when someone posts, how do we get that post into millions of followers' feeds efficiently? I'd use a hybrid model: for regular users (< 10K followers), I fanout on write — a Kafka consumer distributes the post_id into each follower's Redis sorted set, keyed by timestamp. Feed reads then just pull from Redis in O(1). For celebrities, I skip the fanout entirely and merge their recent posts at read time — cached aggressively since millions of users will read them. Posts are stored in Cassandra, partitioned by user_id and clustered by time. The fanout workers read from Kafka so the write path stays fast — post to Cassandra, publish event, return immediately. Real-time updates go through SSE connections. The ranking model ingests these 200 candidates and re-ranks before returning 20 to the client."*

---

## Advanced Topics & Follow-Up Questions

### Feed Pagination & Infinite Scroll

When the user scrolls down, how do we fetch the next page of posts?

**Cursor-based pagination (recommended over offset):**

```
First page:  GET /feed?limit=20
Response:    { posts: [...], next_cursor: "eyJ0aW1lc3RhbXAiOiAxNzQwMDAwMTAwfQ==" }

Next page:   GET /feed?limit=20&cursor=eyJ0aW1lc3RhbXAiOiAxNzQwMDAwMTAwfQ==
             (cursor decodes to: { "timestamp": 1740000100, "post_id": "abc123" })
```

**Why not offset pagination?**
- OFFSET 200 LIMIT 20 requires scanning and discarding 200 rows — slow at scale
- New posts can shift positions, causing duplicate or missed posts between pages
- Cursor points to a stable position in the feed — consistent results

**Redis sorted set cursor:**
```
ZREVRANGEBYSCORE feed:{user_id} {cursor_timestamp} -inf LIMIT 0 20
```

Returns posts older than the cursor timestamp — perfect for "load more."

---

### Content Deduplication

Problem: User follows both Alice and Bob. Both reshare Carol's post. User sees the same post twice.

**Solutions:**
1. **Post ID deduplication at read time**: after fetching feed candidates, filter out duplicate original_post_id values
2. **Reshare tracking**: when Bob reshares Carol's post, store original_post_id on the reshare record; dedup by original_post_id in feed assembly
3. **Show the most relevant reshare**: if multiple friends reshared the same post, show only one with a note "Alice, Bob, and 3 others reshared this"

---

### Feed Ranking — ML Signals

**Feature categories:**

| Feature Type | Examples |
|-------------|---------|
| **Content features** | Post age, media type (video > image > text), text length |
| **Author features** | Author-reader relationship strength, author recent engagement rate |
| **Interaction features** | Like rate in first 5 min (early signal), comment velocity, share rate |
| **User context** | Time of day, device type, historical preferences |
| **Diversity** | Penalize consecutive posts from same author |

**Model architecture:**
- Two-tower model: user embedding + post embedding → dot product → relevance score
- Trained on implicit feedback: clicks, likes, watch time, shares
- Real-time re-ranking using XGBoost or LightGBM on 200 candidates

**Feedback loop risk**: showing only highly-ranked content creates filter bubble. Add diversity constraint: at most 3 consecutive posts from same source.

---

### Write Amplification vs Read Amplification Trade-off

This is the central trade-off of feed systems:

```
                   Fanout on Write              Fanout on Read
Write cost:    O(followers) per post         O(1) per post
Read cost:     O(1)                          O(following) per feed load
Memory:        High (pre-built feeds)        Low (no pre-built feeds)
Freshness:     Eventual (async fanout)       Always fresh
Best for:      Regular users                Celebrity accounts
```

The hybrid approach cuts the middle: pre-build feeds for 99% of accounts, pull-on-read for the 1% with massive follower counts.

---

### Handling Unfollows and Deletes

**Unfollow**: User A unfollows User B.
- Remove B from A's fanout list immediately (update following table)
- B's old posts remain in A's Redis feed sorted set (stale entries)
- Solution: at read time, re-validate authors — filter out posts from authors A no longer follows
- This is why you store post_id in the feed, not the full post — you can re-check at read time

**Post deletion**:
- Mark post as deleted in DB (is_deleted = true)
- At read time: hydrate post_ids → filter deleted posts → return remaining
- In Redis feed: eventually the post is naturally evicted by LRU or TTL
- No need to actively remove from potentially billions of Redis feed sets

---

### Common Follow-Up Questions

**Q: How do you handle a user with 100 million followers (like a global celebrity)?**
- Pure fanout on write: impossible — 100M Redis writes per post would overwhelm infrastructure
- Solution: fanout on read for mega-celebrities; cache their last 50 posts aggressively with a 60-second TTL
- On feed load: merge pre-built feed (regular followees) with celebrity posts fetched on demand

**Q: What is the difference between a home feed and a profile feed?**
- Home feed: personalized, ranked, from people you follow — complex assembly as described
- Profile feed: all posts by a specific user in reverse chronological order — simple Cassandra query by user_id partition key, no fanout involved

**Q: How do you ensure a user sees all new posts since their last visit?**
- Track last_feed_read_timestamp per user in Redis
- On next load: fetch posts newer than that timestamp and append above regular feed
- Limit to last 500 unread posts (show "200+ new posts" badge if more)

**Q: How does Twitter's For You algorithmic feed differ from Following chronological feed?**
- Two separate feed pipelines: ranked (ML model) + chronological (simple timestamp sort)
- Chronological still uses the fanout infrastructure but skips ranking
- Ranked feed uses same candidate generation with ML re-ordering on top

**Q: How do you handle the N+1 query problem when hydrating post IDs from feed?**
- Never fetch one post at a time — always batch: MGET on Redis, or IN clause on DB
- Fetch 20 post IDs from Redis feed → single DB query: SELECT * FROM posts WHERE post_id IN (...)
- Redis pipeline: batch MGET for all 20 post details simultaneously
