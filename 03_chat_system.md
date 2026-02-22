# System Design: Chat System (WhatsApp / Messenger / Slack)
### FAANG Senior Interview Deep-Dive

> **Frequency**: Extremely common at Meta (Messenger/WhatsApp), Google, Amazon.
> **Why they ask it**: Tests WebSocket/real-time protocols, message ordering, delivery guarantees, and distributed persistence.

---

## Step 1 — Requirements Clarification

### Key Questions to Ask First
- 1-on-1 chat only, or group chat too?
- What's the max group size? (100 users? 500?)
- Online indicators / typing indicators?
- Message delivery status (sent ✓, delivered ✓✓, read ✓✓ blue)?
- Media support (images, video, voice)?
- End-to-end encryption?
- Message history / search?
- Push notifications for offline users?

### Functional Requirements (our design)
- 1-on-1 and group chat (up to 500 members)
- Real-time message delivery
- Message delivery receipts (sent → delivered → read)
- Online presence indicators
- Message history (persistent)
- Push notifications for offline users
- Media sharing (images — stored in blob, URL in message)

### Non-Functional Requirements
- **Scale**: 500 million DAU, 50 billion messages/day
- **Low latency**: p99 < 100ms message delivery (same region)
- **Message ordering**: messages within a conversation must arrive in order
- **Exactly-once delivery**: no duplicates, no losses
- **Availability**: 99.99%
- **Durability**: messages stored for 5 years minimum

### Out of Scope
- Voice/video calling
- Full-text search across message history
- End-to-end encryption details (mention it, don't design it)

---

## Step 2 — Capacity Estimation

```
DAU:                500 million
Messages/day:       50 billion (100 messages per DAU)
Messages/second:    50B / 86,400 ≈ 580,000 msg/sec
Peak:               3× avg ≈ 1.7 million msg/sec

Message size:
  Text message:     ~100 bytes (user_id, conversation_id, content, timestamp)
  With metadata:    ~1 KB

Storage:
  580,000 msg/sec × 1 KB × 86,400 sec = ~50 TB/day
  5-year retention: 50 TB × 365 × 5 = ~90 PB total

Concurrent connections: 500M DAU × 0.1 online at any time = 50M connections
```

> **Key insight**: 50 million **persistent WebSocket connections** is the hardest infrastructure challenge in this design.

---

## Step 3 — High-Level Design

```
                         ┌─────────────┐
                         │  Client App │
                         └──────┬──────┘
                                │ WebSocket (persistent)
                    ┌───────────▼────────────┐
                    │    Chat Service        │  (stateful — holds WS connections)
                    │   (WebSocket Server)   │
                    └───┬───────────┬────────┘
                        │           │
            ┌───────────▼──┐  ┌─────▼──────────┐
            │   Message    │  │   Presence     │
            │   Service    │  │   Service      │
            └───────┬──────┘  └────────────────┘
                    │
       ┌────────────┼─────────────┐
       ▼            ▼             ▼
  ┌─────────┐ ┌──────────┐ ┌──────────────┐
  │Messages │ │ Kafka    │ │Push Notif.   │
  │   DB    │ │ (async)  │ │Service (APNS │
  │(Cassandra│ └──────────┘ │ / FCM)       │
  └─────────┘               └──────────────┘
```

### Core Services
1. **Chat Service** (WebSocket): maintains persistent connections, routes messages
2. **Message Service**: persists messages, handles delivery status
3. **Presence Service**: tracks online/offline status
4. **Notification Service**: push notifications for offline users
5. **Media Service**: handles uploads to S3, returns URLs

---

## Step 4 — Deep Dive

### Real-Time Communication: WebSocket vs. Alternatives

**HTTP Short Polling** (❌ for chat):
- Client polls every N seconds: "any new messages?"
- High latency (up to N seconds), wasteful, doesn't scale

**HTTP Long Polling** (acceptable but not ideal):
- Client sends request, server holds it until a message arrives or timeout
- Better latency, but one request per message, half-duplex

**Server-Sent Events / SSE** (❌ for chat):
- Server can push to client, but client can't push to server over same connection
- Good for feeds, not chat (we need bidirectional)

**WebSocket** (✅ correct answer):
- Full-duplex persistent TCP connection
- Client and server both push messages at any time
- Low overhead after handshake (no HTTP headers per message)
- Industry standard for chat (WhatsApp, Messenger, Slack all use this)

```
WebSocket handshake (one time):
GET /chat HTTP/1.1
Upgrade: websocket
Connection: Upgrade

After upgrade: raw TCP frames, no HTTP overhead
```

---

### Connection Management at Scale

**Problem**: 50 million concurrent WebSocket connections.

- A single server can handle ~10,000-50,000 WebSocket connections (depends on CPU/memory, mostly I/O bound)
- At 50M connections: need **1,000-5,000 Chat Service instances**

**Architecture**:
```
Load Balancer → Chat Servers (sticky sessions by user_id)

User A connects → consistently routed to Chat Server #42
User B connects → consistently routed to Chat Server #17
```

**Sticky sessions via consistent hashing**:
- `hash(user_id) mod num_servers` — always routes same user to same server
- On server restart: user reconnects and gets re-routed
- Chat servers are stateful (they hold WebSocket connections)

**Service Discovery**:
- Use **Zookeeper** or **etcd** to register active chat server instances
- Load balancer queries Zookeeper to find which server holds a given user's connection

---

### Message Flow: 1-on-1 Chat

**Sender (User A, on Server #42) → Receiver (User B, on Server #17)**:

```
1. User A types message, WebSocket sends to Server #42
2. Server #42:
   a. Persist message to Cassandra (with status: "sent")
   b. Publish to Kafka topic: "messages"
   c. Send ack to User A: "message received by server" → status: ✓ (sent)

3. Kafka consumer (Message Router):
   a. Determine which server User B is connected to (lookup in Redis)
   b. Forward message to Server #17

4. Server #17:
   a. Deliver message to User B via WebSocket
   b. Update message status: "delivered" → ✓✓
   c. Notify Server #42 → push delivery receipt to User A

5. User B opens/reads message:
   a. Client sends "read" event to Server #17
   b. Server #17 updates message status: "read" → ✓✓ (blue)
   c. Notify User A: read receipt delivered
```

**How does Server #42 know User B is on Server #17?**
- Use Redis hash: `presence:{user_id}` → `server_id`
- Updated on connect/disconnect by each Chat Server
- Short TTL (30 seconds) with heartbeat renewal

---

### Message Persistence: Cassandra Schema

**Why Cassandra?**
- Write-heavy (50B messages/day)
- Simple access patterns (load chat history for a conversation)
- Linear horizontal scaling
- Tunable consistency

```sql
CREATE TABLE messages (
  conversation_id  UUID,
  message_id       UUID,        -- TimeUUID (time-sortable)
  sender_id        UUID,
  content          TEXT,
  media_url        TEXT,        -- null if text only
  message_type     TEXT,        -- 'text', 'image', 'video'
  status           TEXT,        -- 'sent', 'delivered', 'read'
  created_at       TIMESTAMP,
  PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
```

- **Partition key**: `conversation_id` — all messages in a chat are co-located
- **Clustering key**: `message_id` (TimeUUID) — sorted by time
- Load last 50 messages: `WHERE conversation_id = X LIMIT 50` — O(1)
- **Read consistency**: QUORUM (majority of replicas agree) — balances speed and consistency

**Partition size concern**: Long-running chats could have millions of messages in one partition.
- Solve with **time-bucketed partition keys**: `(conversation_id, year_month)` → e.g., `(abc123, 2026-02)`
- Query requires knowing which month to look in, or scatter across months for pagination

---

### Message Ordering & IDs

**Problem**: Two users send messages at nearly the same time — which appears first?

**Naive approach**: Use server timestamps. Problem: clock skew between servers can reorder messages.

**Better approach**: Use **sequence numbers per conversation**

```sql
-- Sequence counter in Redis
INCR seq:{conversation_id}   → returns atomically-incremented integer
```

Every message in a conversation gets a unique, monotonically increasing sequence number. Cassandra stores and sorts by sequence number (use as clustering key instead of raw TimeUUID).

**Best approach (used by WhatsApp)**: **Hybrid Logical Clocks (HLC)**
- Combines physical time + logical counter
- Causally consistent ordering
- Handles concurrent messages correctly

> In interview: mention sequence numbers per conversation as your primary answer, note HLC for bonus points.

---

### Group Chat (up to 500 members)

**Challenge**: 1 message → deliver to up to 500 members

**Option A: Fanout on write at chat server**
- Chat server publishes 500 individual delivery tasks to Kafka
- Works for small groups (< 100 members)

**Option B: Group message stored once, queried by members**

```sql
CREATE TABLE group_messages (
  group_id    UUID,
  message_id  UUID,  -- TimeUUID
  sender_id   UUID,
  content     TEXT,
  PRIMARY KEY (group_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- Each member's last-read pointer
CREATE TABLE member_read_status (
  group_id    UUID,
  user_id     UUID,
  last_read_message_id UUID,
  PRIMARY KEY (group_id, user_id)
);
```

When a group member opens the chat: fetch messages after `last_read_message_id`. Delivery receipts tracked per member via `member_read_status`.

**For large groups (> 100 members)**: use fanout-on-read — members pull from shared message log rather than individual fan-out.

---

### Presence System (Online Indicators)

**Problem**: Track which of your contacts are online.

**Architecture**:
```
User connects   → Chat Server writes to Redis: SET presence:{user_id} {server_id} EX 30
User heartbeat  → every 10 seconds, refresh TTL: EXPIRE presence:{user_id} 30
User disconnects → Chat Server deletes Redis key immediately
Key expires     → user considered offline (TTL-based fallback)
```

**Querying presence of 500 contacts**:
```
MGET presence:user1 presence:user2 ... presence:user500
```
- Redis pipeline: extremely fast (< 1ms for 500 keys)
- At scale: Redis Cluster shards keys across nodes

**Trade-off**: Exact real-time presence is expensive at scale. Many apps (WhatsApp, WeChat) show "Last seen X minutes ago" instead of exact online status — much cheaper (just track last_active timestamp).

---

### Push Notifications for Offline Users

When a message is sent to an offline user:

```
Kafka consumer → Notification Service:
  1. Check presence: is user online?
  2. If offline:
     a. Fetch user's device token (APNs for iOS, FCM for Android)
     b. Send push notification with message preview
  3. If online:
     a. WebSocket delivery (already handled)
```

**Privacy consideration**: Push notification shows message preview → potential data leak. Allow users to disable previews (show "New message from X" instead).

---

### Message Delivery Guarantees

**At-least-once delivery**:
- Kafka has at-least-once semantics → duplicate messages possible
- Solve with **idempotency key** (client-generated message UUID)
- Cassandra INSERT is idempotent if message_id is the same → duplicates safely rejected

**Exactly-once delivery** (in practice):
- Cassandra write with idempotency key ✓
- Kafka consumer commits offset AFTER successful delivery ✓
- Client deduplicates by message_id ✓

**Delivery receipt flow**:
```
Server persists message → ack to sender (sent ✓)
Server delivers to recipient → delivery receipt (delivered ✓✓)
Recipient opens message → read receipt (read ✓✓ blue)
```

---

### Media Sharing Architecture

Large files (images, video) never pass through chat servers.

```
1. Client requests pre-signed S3 URL from Media Service
2. Client uploads directly to S3 (bypasses your servers)
3. S3 triggers Lambda → generate thumbnail → store in S3
4. Client sends message with media_url pointing to S3
5. Recipient downloads from S3 directly (served via CDN for speed)
```

**Why pre-signed URLs?** Keeps chat servers stateless — they never touch binary data. S3 handles the upload.

---

## Failure Scenarios

| Failure | Impact | Mitigation |
|---------|--------|-----------|
| Chat server crashes | Active WS connections drop | Clients reconnect, sticky sessions re-route |
| Redis (presence) down | Online status unavailable | Graceful degradation (show no presence), Redis Sentinel |
| Kafka lag | Message delay | Scale consumer instances, increase partitions |
| Cassandra node down | Read latency spike | RF=3, consistency QUORUM still works with 2 of 3 |
| User sends duplicate (retry) | Duplicate message appears | Idempotency key on message_id |

---

## Data Flow Summary

```
SEND:     Client → WS → Chat Server → Cassandra + Kafka → Kafka Consumer
DELIVER:  Kafka Consumer → Redis lookup → Target Chat Server → WS → Recipient
OFFLINE:  Kafka Consumer → Presence check → Notification Service → APNs/FCM
HISTORY:  Client → API → Cassandra (paginated, last 50 messages) → Client
```

---

## What Interviewers Listen For

✅ **WebSocket** (not polling) for bidirectional real-time
✅ **How two users on different servers** exchange messages (service mesh + Redis routing)
✅ **Cassandra schema** with conversation_id partition + TimeUUID clustering
✅ **Message ordering** with sequence numbers per conversation
✅ **Delivery receipts** (sent/delivered/read) — how status propagates back
✅ **Group chat** — fanout on write vs read trade-off
✅ **Presence system** with TTL-based heartbeat in Redis
✅ **Push notifications** for offline users
✅ **Media upload** via pre-signed S3 URLs (never through chat server)

---

## Sample Answer Narrative (2-minute version)

*"The core of a chat system is real-time bidirectional communication — I'd use WebSocket. Each Chat Server holds WebSocket connections for a subset of users; at 50M concurrent connections, we'd need ~1,000-5,000 stateful chat server instances with consistent hashing to route users to their server. When User A sends a message, their Chat Server persists it to Cassandra — partitioned by conversation_id, clustered by TimeUUID — and publishes to Kafka. A message router consumer looks up which server User B is connected to (via a Redis presence map), and forwards the message there for WebSocket delivery. If B is offline, a notification service sends an APNs/FCM push. Delivery receipts flow back in reverse — server acks on persist, delivery ack on WS delivery, read ack when the client opens it. For group chat up to 500 members, I'd store messages once in a shared group log and have members pull using their last-read pointer, rather than fanning out 500 writes per message."*

---

## Advanced Topics & Follow-Up Questions

### End-to-End Encryption (E2EE)

WhatsApp and Signal use E2EE — the server never sees message content.

**How it works (Signal Protocol):**

```
Key exchange (one-time, on first message):
  Alice has: identity key pair, signed prekey, one-time prekeys
  Bob publishes his public prekeys to the server

Alice wants to message Bob:
  1. Fetches Bob's public prekeys from server
  2. Performs X3DH (Extended Triple Diffie-Hellman) key agreement
  3. Derives shared session key — server never sees this key
  4. Encrypts message with session key
  5. Sends ciphertext to server

Server:
  - Stores and forwards ciphertext only (never plaintext)
  - Cannot read any messages
  - Cannot decrypt even under legal compulsion (no keys)
```

**Trade-offs of E2EE:**
- Cannot do server-side spam filtering (can't read content)
- Cannot support server-side message search
- Key management complexity (key rotation, multi-device sync)
- Backup challenge: if user loses device, messages may be lost unless backup key is managed

**Multi-device support:**
- Each device generates its own key pair
- Message encrypted separately for each of Bob's devices
- WhatsApp: up to 5 linked devices

---

### Message Search

**Challenge:** With E2EE, server-side search is impossible — content is encrypted.

**Client-side search (WhatsApp approach):**
- Messages decrypted locally on device
- Sqlite FTS (Full Text Search) index maintained locally
- Search queries run entirely on device
- Pro: privacy preserving. Con: can only search on the device where messages exist

**Server-side search (Slack, non-E2EE):**
- Messages stored in plaintext → indexed in Elasticsearch
- Query: `GET /search?q=project+launch&channel=C123`
- Elasticsearch: inverted index, TF-IDF ranking, fuzzy matching

**Hybrid approach (iMessage):**
- Encrypted search index: user-side encrypted tokens stored on server
- Server returns matching ciphertext blobs; client decrypts locally
- Server learns nothing about query terms

---

### Message Sync Across Devices

User opens WhatsApp on phone and laptop — both should show same messages.

**Options:**

**Option A: Server as source of truth (non-E2EE)**
- All messages stored on server
- Any device fetches from server → always in sync
- Simple, but server has all messages

**Option B: Device-to-device sync (E2EE)**
- Primary device stores all messages
- New device: primary re-encrypts and pushes message history
- Challenge: primary must be online

**Option C: Encrypted cloud backup**
- Messages backed up to S3 with user-controlled encryption key
- New device downloads and decrypts backup
- WhatsApp uses Google Drive / iCloud for this

**Sequence numbers for sync:**
```
Each message has a global sequence number per device
New device syncs from seq=0 to seq=current
Incremental sync: only fetch messages since last_seen_seq
```

---

### Voice and Video Calling Architecture (Bonus)

Even if out of scope for main design, knowing this impresses interviewers.

**WebRTC** is the standard protocol for real-time audio/video in browsers and mobile apps.

```
Signaling Server (your infrastructure):
  - Coordinates call setup: SDP offer/answer exchange
  - Uses WebSocket to pass signaling messages
  - Does NOT carry media (too much data)

STUN Server (Session Traversal Utilities for NAT):
  - Helps peers discover their public IP + port (behind NAT)
  - Usually Google's public STUN: stun.l.google.com:19302

TURN Server (Traversal Using Relays around NAT):
  - When direct P2P fails (strict NAT, firewalls)
  - Relays media through server
  - Higher cost: video traffic passes through your servers

ICE (Interactive Connectivity Establishment):
  - Tries all possible connection routes (P2P → STUN → TURN) and picks the best
```

**Call flow:**
```
Alice calls Bob:
1. Alice → Signaling Server: "I want to call Bob" (WebSocket)
2. Signaling Server → Bob: "Alice is calling you" (WebSocket push)
3. Bob answers → both exchange SDP offers via Signaling Server
4. Both query STUN server for public IPs
5. ICE tries direct P2P connection
6. If P2P fails → media relayed via TURN server
7. Audio/video flows directly peer-to-peer (P2P) or via TURN
```

**Scaling video calls:**
- 1:1 calls: P2P or TURN relay
- Group calls (3-8 people): Selective Forwarding Unit (SFU) — server receives each participant's stream and selectively forwards to others
- Large meetings (100+): MCU (Multipoint Control Unit) — server mixes all streams into one

---

### Storing Message Attachments (Large Media)

Never pass large files through the chat server:

```
Upload flow:
  1. Client requests pre-signed upload URL from Media Service
     POST /media/upload → { upload_url, media_id }
  2. Client uploads file directly to S3 using pre-signed URL
     PUT https://s3.amazonaws.com/bucket/media/{media_id}
  3. S3 triggers Lambda:
     - Generate thumbnail
     - Scan for malware
     - Extract metadata (duration, dimensions)
     - Mark media as "ready" in Media Service DB
  4. Client sends chat message with media_id reference
     { type: "image", media_id: "abc123", caption: "Look at this!" }

Download flow:
  1. Recipient's client receives message with media_id
  2. Requests download URL: GET /media/{media_id} → pre-signed URL (valid 1 hour)
  3. Downloads directly from S3 (served via CloudFront CDN)
```

**CDN for media delivery:**
- Profile photos, commonly viewed images cached at CDN edge
- Private media (direct messages) use short-lived pre-signed URLs
- Never cache private content without auth

---

### Handling Concurrent Messages and Ordering

**Problem:** Alice sends 3 messages in quick succession — can they arrive out of order?

```
Message 1: "Hey"       seq=1  ─────────────────► arrives first
Message 2: "Are you"   seq=2  ──────────────────────► arrives third
Message 3: "there?"    seq=3  ─────────────────────► arrives second
```

Without ordering guarantees: messages appear scrambled.

**Solutions:**

**Client-side sequence numbers:**
- Client assigns monotonically increasing sequence number per conversation
- Server validates: if seq=3 arrives before seq=2, buffer seq=3 and wait for seq=2
- 5-second wait window, then release buffered messages regardless

**Server-assigned sequence numbers:**
```
Client sends message → server assigns authoritative sequence number
Server returns: { message_id, conversation_seq: 47 }
Client re-renders messages sorted by conversation_seq
```

**Logical clocks (Lamport timestamps):**
- Each message carries the sender's logical clock value
- Recipients use logical clock to determine causal ordering
- More complex but handles concurrent messages across multiple senders correctly

---

### Read Receipts at Scale

**Challenge:** In a group of 500 people, each message has 499 read receipts.

**Storage:**
```sql
-- Per-user read receipt per message (too expensive at scale)
CREATE TABLE receipts (
  message_id  UUID,
  user_id     UUID,
  read_at     TIMESTAMP,
  PRIMARY KEY (message_id, user_id)
);
-- 500 members × 1000 messages/day × 500 group = 250M rows/day just for receipts
```

**Optimization — pointer-based read tracking:**
```sql
-- Only track last-read message per user per conversation
CREATE TABLE read_pointers (
  conversation_id  UUID,
  user_id          UUID,
  last_read_seq    BIGINT,
  PRIMARY KEY (conversation_id, user_id)
);
```

Instead of marking each message read individually, advance the pointer to the latest read message. A single write covers all previous messages. Much more efficient.

**Trade-off:** You can no longer tell which specific messages were read. Show "seen by 12 of 500 members" (count how many pointers are past this message's seq number) rather than individual per-message receipts.

---

### Common Follow-Up Questions

**Q: How do you handle a user sending a message while offline?**
- Client stores message locally in SQLite with status "pending"
- On reconnect: replay pending messages to server in order
- Server deduplicates using client-assigned idempotency key (UUID per message)
- Server returns authoritative sequence numbers; client updates local DB

**Q: How would you implement message reactions (emoji reactions)?**
- Reactions are separate events from messages: `{ message_id, user_id, emoji, action: "add"|"remove" }`
- Store in a separate reactions table: `(message_id, user_id)` → emoji
- Fan out to group members the same way messages are fanned out
- Aggregate at read time: count per emoji, check if current user reacted

**Q: How does "typing indicator" work?**
- When user starts typing: client sends event to server → `{ type: "typing_start", conversation_id }`
- Server routes to recipient's WebSocket connection (same as message routing)
- Recipient sees "Alice is typing..."
- Client sends `typing_stop` event when done, or server auto-expires after 5 seconds
- Rate limit: don't send typing events more than once per 2 seconds (debounce)

**Q: What happens when a user is blocked?**
- Block stored in DB: `(blocker_id, blocked_id)`
- Checked on: message send (prevent delivery), presence queries (hide online status), search results
- Blocked user can still send messages to their server — just silently dropped before delivery
- Do not reveal to blocked user that they are blocked (privacy)

**Q: How do you scale to 1 billion concurrent WebSocket connections?**
- At ~50,000 connections per server: need 20,000 servers
- Use connection pooling at L4 load balancer (not L7 — too much overhead for WebSocket)
- Autoscale connection servers based on active connection count
- Consider connection multiplexing: multiple logical sessions over one TCP connection
- Geo-distribute: users connect to nearest region's servers; inter-region message routing via Kafka
