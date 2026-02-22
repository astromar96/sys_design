# System Design: Ride-Sharing Service (Uber / Lyft)
### FAANG Senior Interview Deep-Dive

> **Frequency**: Very common at Uber (obviously), Amazon, Google, Meta, and Microsoft.
> **Why they ask it**: Tests geospatial indexing, real-time location, matching algorithms, state machines, and GPS-scale data pipelines.

---

## Step 1 — Requirements Clarification

### Key Questions to Ask
- What's the core scope — booking + matching only, or also payments, routing, driver rating?
- What geographies? Global? Single city?
- How do we handle surges (supply/demand imbalance)?
- Do riders see driver location in real-time on a map?
- How long does matching need to take? (10 seconds? 30 seconds?)
- UberPool / shared rides, or only individual rides?

### Functional Requirements
- **Rider**: Request ride, see nearby drivers, track driver in real-time
- **Driver**: Go online/offline, accept/reject rides, navigate to rider
- **Matching**: Match rider with nearest available driver
- **Trip lifecycle**: Request → Match → Pickup → In-trip → Completed
- **Fare calculation**: Based on distance + time + surge pricing
- **Real-time driver location**: visible to rider during trip

### Non-Functional Requirements
- **Scale**: 5 million rides/day, 10 million active drivers globally
- **Matching latency**: match must complete in < 30 seconds (p99)
- **Location update frequency**: drivers send GPS every 4 seconds
- **Location latency**: rider sees driver position with < 5 second lag
- **Availability**: 99.99%
- **Consistency**: matching must be consistent — one driver assigned to one ride (no double-booking)

### Out of Scope
- Payment processing
- Driver rating / review system
- Navigation / turn-by-turn routing (use Google Maps API)
- Driver earnings / payroll

---

## Step 2 — Capacity Estimation

```
Active drivers globally:   10 million
Location update interval:  every 4 seconds
Location writes/sec:       10M / 4 = 2.5 million GPS updates/sec

Rides/day:                 5 million
Rides/sec:                 5M / 86,400 ≈ 60 ride requests/sec
Peak (5×):                 300 ride requests/sec

Driver location record:    ~50 bytes (driver_id, lat, lon, timestamp, status)
Location storage/day:      2.5M × 50 bytes × 86,400 ≈ 10 TB/day (if storing history)

For real-time use: only latest location matters → keep in Redis → much smaller
```

> **Key insight**: The hardest problem is handling **2.5 million location writes per second** for geospatial queries.

---

## Step 3 — High-Level Architecture

```
                    ┌──────────────────────────────────┐
                    │         API Gateway               │
                    │   (Auth, Rate Limiting, Routing)  │
                    └────┬─────────────────────┬────────┘
                         │                     │
              ┌──────────▼─────┐    ┌──────────▼──────┐
              │  Rider Service │    │  Driver Service  │
              │  (REST + WS)   │    │  (REST + WS)     │
              └──────┬─────────┘    └────────┬─────────┘
                     │                       │
              ┌──────▼─────────┐    ┌────────▼─────────┐
              │  Trip Service  │    │ Location Service  │
              │  (state machine│    │ (GPS ingestion +  │
              │   + matching)  │    │  geospatial index)│
              └──────┬─────────┘    └────────┬─────────┘
                     │                       │
              ┌──────▼───────────────────────▼──────────┐
              │              Message Queues              │
              │           (Kafka for location events)    │
              └──────────────────┬──────────────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Databases & Cache       │
                    │  - Redis (driver locs)   │
                    │  - Cassandra (trips)     │
                    │  - PostgreSQL (users)    │
                    └──────────────────────────┘
```

---

## Step 4 — Deep Dive

### Core Problem 1: Geospatial Indexing (Find Nearest Drivers)

When a rider requests a trip, we need to find all available drivers within, say, 5 km.

**Naive approach**: Store `(driver_id, lat, lon)` in a SQL table, query:
```sql
SELECT driver_id
FROM driver_locations
WHERE lat BETWEEN (rider_lat - 0.045) AND (rider_lat + 0.045)
  AND lon BETWEEN (rider_lon - 0.045) AND (rider_lon + 0.045);
```
Problem: 10 million rows, no efficient 2D index for range queries on both lat AND lon simultaneously. Slow.

---

**Solution: Geohash** ✅

Geohash encodes a latitude/longitude into a base-32 string. The key property: **nearby locations share a common prefix**.

```
Rider at: 37.7749° N, 122.4194° W (San Francisco)
Geohash:  9q8yy... (precision 5 = ~5 km cell, precision 6 = ~1 km cell)

Drivers in the same 1 km² cell have the same 6-char geohash prefix: 9q8yy
Drivers in adjacent cells share a 5-char prefix
```

**Finding nearby drivers**:
1. Compute rider's geohash at precision 6 (1 km cell)
2. Also compute 8 neighboring cells (geohash neighbors)
3. Query for all drivers in these 9 cells

**Redis implementation**:
```
GEOADD drivers:geohash {lon} {lat} {driver_id}

GEORADIUS drivers:geohash {rider_lon} {rider_lat} 5 km
  ASC LIMIT 20   → returns 20 nearest available drivers sorted by distance
```

Redis's `GEORADIUS` command internally uses geohash. O(N+log M) where M is drivers in the radius.

**Alternative: Quadtree**

A quadtree recursively subdivides space into 4 quadrants. Nodes split when > K points exist in a cell.

```
Root (whole world)
├── NW quadrant (north America)
│   ├── NW sub-quadrant ...
│   ├── NE sub-quadrant → [SF area, dense → leaf node with drivers]
...
```

- Dynamic subdivision: dense urban areas (NYC, Mumbai) get smaller cells; rural areas get large cells
- Average O(log N) for nearest neighbor search
- Used in game engines, GIS systems, Uber's older H3 system

**Uber's actual solution: H3 (Hexagonal Hierarchical Geospatial Indexing)**
- World divided into hexagons at multiple resolutions
- Better than squares for distance calculations (hexagons are equidistant to neighbors in all 6 directions)
- Open-sourced by Uber: https://h3geo.org
- Mention this for bonus points at Uber interviews

> **For the interview**: Use **Geohash + Redis GEORADIUS** as your primary answer. Mention H3 as what Uber actually uses.

---

### Core Problem 2: Driver Location Ingestion (2.5M writes/sec)

Drivers send GPS every 4 seconds. 10 million drivers × 1/4 updates/sec = 2.5 million updates/sec.

**Architecture**:
```
Driver App → WebSocket → Location Service → Kafka → Location Processor → Redis GEOADD
```

**Why WebSocket for drivers?**
- Persistent connection, lower overhead than HTTP for high-frequency updates
- Driver app sends heartbeat + GPS update every 4 seconds
- Server detects disconnection quickly → mark driver offline

**Why Kafka in the middle?**
- Location updates are bursty (rush hour)
- Kafka decouples ingestion from processing
- Multiple consumers: Redis updater, analytics, ML pipeline, trip tracking

**Redis for latest location**:
```
GEOADD drivers:active {lon} {lat} {driver_id}   -- updates position
SET driver:{driver_id}:status "available"        -- availability flag
EXPIRE driver:{driver_id}:status 10              -- auto-offline if no heartbeat
```

Only keep latest position in Redis (not history). History written async to Cassandra for analytics.

---

### Core Problem 3: Ride Matching

**Matching algorithm**:
```
Rider requests trip at (lat, lon):

1. Query geohash cell + 8 neighbors for available drivers
2. Filter: only drivers with status = "available" (not on a trip)
3. Sort by: distance + estimated wait time + driver rating + surge zone
4. Attempt to assign top driver:
   a. Send trip offer to Driver A (via WebSocket push)
   b. Driver has 15 seconds to accept
   c. If accepted → trip created, driver status = "matched"
   d. If rejected / timeout → try next driver
5. If no match after 60 seconds → notify rider (no drivers available)
```

**Matching Service is stateful**: it must track which drivers have been offered a trip to avoid duplicate offers.

**Preventing double-booking** (two riders matched to same driver):
- Use Redis atomic operation: `SET driver:{id}:matched {trip_id} NX EX 30`
  - `NX` = "set only if not exists"
  - `EX 30` = expires in 30 seconds (auto-cleanup if matching fails)
  - If returns nil → driver was already matched by another request → skip this driver

---

### Trip State Machine

Every trip goes through a well-defined state machine. This is critical to get right in an interview.

```
         ┌──────────────┐
         │  REQUESTED   │  ← rider submits trip
         └──────┬───────┘
                │ driver accepts
         ┌──────▼───────┐
         │   MATCHED    │  ← driver assigned
         └──────┬───────┘
                │ driver arrives at pickup
         ┌──────▼───────┐
         │   PICKUP     │  ← waiting for rider
         └──────┬───────┘
                │ rider gets in, trip starts
         ┌──────▼───────┐
         │   IN_TRIP    │  ← en route to destination
         └──────┬───────┘
                │ driver arrives at destination
         ┌──────▼───────┐
         │  COMPLETED   │  ← fare calculated, trip ends
         └──────────────┘

Also:
  REQUESTED → CANCELLED (by rider before match)
  MATCHED → CANCELLED (driver cancels, system finds new driver)
```

**State stored in**:
- **Cassandra**: persistent trip record with current state
- **Redis**: ephemeral state for fast real-time transitions (cache of current state)

**State transitions** are handled by the Trip Service. Each transition is idempotent — if the same event fires twice, state doesn't change incorrectly.

---

### Core Problem 4: Real-Time Driver Location for Riders

Once a trip is matched, the rider needs to see the driver moving on a map.

**Architecture (during active trip)**:
```
Driver App → Location Service (WebSocket) → Kafka → Location Processor
                                                           │
                                                     Redis PubSub:
                                                     PUBLISH trip:{trip_id}:location
                                                           │
                                                     Rider Connection Server
                                                     (subscribed to channel)
                                                           │
                                                     WebSocket push to Rider App
```

**Driver location updates during trip flow**:
1. Driver sends GPS every 4 seconds → Location Service
2. Location Service publishes to `Kafka topic: trip-location`
3. Kafka consumer reads → calls `Redis PUBLISH trip:{trip_id}:location {lat,lon}`
4. Rider's connection server is subscribed to this channel
5. Connection server pushes update to rider's WebSocket → map updates

This is **fan-in fan-out** at trip level: one driver's location → one rider's map (during trip).

---

### Surge Pricing

Surge pricing adjusts fare when demand > supply in a geographic area.

```
surge_multiplier = f(demand, supply, time)

Algorithm:
  1. Count ride requests in geohash cell in last 5 minutes
  2. Count available drivers in same cell
  3. surge = max(1.0, demand / supply × base_multiplier)
  4. Cap at 3.0× to avoid PR disasters

Implementation:
  Kafka consumer aggregates location events + trip requests by geohash cell
  Every 30 seconds, recomputes surge per cell
  Surge factor stored in Redis: SET surge:{geohash_cell} {factor} EX 60

  On trip request: lookup surge factor for rider's geohash cell → apply to fare estimate
```

---

### Database Design

**PostgreSQL** (users, drivers — structured, low volume):
```sql
CREATE TABLE users (
  user_id    UUID PRIMARY KEY,
  name       TEXT,
  email      TEXT UNIQUE,
  phone      TEXT,
  rating     DECIMAL(3,2),
  created_at TIMESTAMP
);

CREATE TABLE drivers (
  driver_id  UUID PRIMARY KEY,
  user_id    UUID REFERENCES users(user_id),
  vehicle    JSONB,   -- {make, model, plate, color}
  rating     DECIMAL(3,2),
  status     TEXT     -- 'offline', 'available', 'on_trip'
);
```

**Cassandra** (trips — high write volume, time-series):
```sql
CREATE TABLE trips (
  trip_id        UUID,
  rider_id       UUID,
  driver_id      UUID,
  status         TEXT,       -- state machine status
  pickup_lat     DOUBLE,
  pickup_lon     DOUBLE,
  dropoff_lat    DOUBLE,
  dropoff_lon    DOUBLE,
  requested_at   TIMESTAMP,
  completed_at   TIMESTAMP,
  fare_amount    DECIMAL,
  surge_factor   DECIMAL,
  PRIMARY KEY (trip_id)
);

-- For querying trip history by rider or driver:
CREATE TABLE trips_by_rider (
  rider_id   UUID,
  trip_id    UUID,
  PRIMARY KEY (rider_id, trip_id)  -- lookup by rider
) WITH CLUSTERING ORDER BY (trip_id DESC);
```

---

### Driver Assignment Edge Cases

**Scenario**: Network glitch — driver accepts but server never receives it.

- Trip offer has a 15-second timeout
- If no ack received → offer expires → try next driver
- Driver's `matched` Redis key expires after 30 seconds → auto-released

**Scenario**: Driver is assigned, then immediately cancels.

- Trip transitions back to REQUESTED state
- Re-enter matching pool with note "previous driver cancelled"
- Consider deprioritizing that driver for future matches

**Scenario**: Driver goes offline mid-trip.

- Heartbeat stops → presence service marks driver offline after 10 seconds
- Trip transitions to "INTERRUPTED" state
- Customer support notified; alternate driver search begins

---

### ETA Calculation

ETA shown to rider = time for driver to reach pickup.

```
Components:
  1. Straight-line distance (from GPS coords)
  2. Routing graph (road network, turn penalties)
  3. Real-time traffic (map provider API — Google Maps, HERE)

Uber approach:
  1. Fetch route from Routing Service (internal map + real-time traffic)
  2. Route service returns ETAs for multiple candidate drivers simultaneously
  3. Pick driver with best ETA that minimizes rider wait
```

> In interview: say "we'd call out to a routing microservice or partner API, feed in driver position and rider location, and get an ETA back. Routing is a separate complex system — happy to dig in if you want."

---

## Failure Scenarios

| Failure | Impact | Mitigation |
|---------|--------|-----------|
| Location Service down | Driver positions go stale | Multiple instances, Kafka buffers updates |
| Redis down | Can't query nearby drivers | Redis Sentinel / Cluster; fallback to Cassandra with geohash prefix query |
| Matching Service crash | Active ride offers lost | Idempotent re-offer, rider retries after timeout |
| Kafka lag | Location updates delayed | Auto-scale consumers, monitor lag |
| Driver offline mid-trip | Rider stranded | Detection via heartbeat timeout, escalate to support |

---

## Scale Summary

```
2.5M GPS writes/sec     → Kafka + Redis GEOADD (in-memory)
60 ride matches/sec     → Matching Service (horizontally scalable)
10M driver locations    → Redis Geo (fits comfortably in 1 GB)
Real-time map updates   → Redis Pub/Sub per active trip
Trip history            → Cassandra (partitioned by trip_id)
```

---

## What Interviewers Listen For

✅ **Geohash** for spatial indexing + nearest driver search
✅ **Redis GEORADIUS** for efficient geospatial query
✅ **Kafka** for absorbing 2.5M location updates/sec
✅ **WebSocket** for persistent driver/rider connections
✅ **Trip state machine** (requested → matched → pickup → in_trip → completed)
✅ **Atomic driver assignment** via Redis `SET NX` to prevent double-booking
✅ **Surge pricing** as a demand/supply ratio per geohash cell
✅ **Real-time map updates** via Redis Pub/Sub during active trip
✅ H3 hexagonal indexing (bonus, especially at Uber interviews)

---

## Sample Answer Narrative (2-minute version)

*"The two hardest problems here are geospatial indexing and high-frequency location ingestion. For location ingestion, drivers send GPS every 4 seconds — 2.5 million writes per second — which I'd absorb with a Kafka pipeline and store only the latest location in Redis using its native GEO commands. For finding nearby drivers, GEORADIUS lets me efficiently query all drivers within 5 km of the rider's position. Matching uses Redis's SET NX operation to atomically claim a driver, preventing double-booking — we offer the trip over WebSocket, wait 15 seconds for acceptance, and cascade to the next driver on timeout. The trip lifecycle is a state machine in Cassandra — requested, matched, pickup, in-trip, completed — with Redis caching the hot state for real-time reads. During an active trip, the driver's GPS updates publish to a Redis pub/sub channel, which the rider's connection server subscribes to and pushes to the map in near real-time. Surge pricing is computed every 30 seconds by aggregating demand vs. supply per geohash cell in Kafka and stored in Redis for fast lookup at booking time."*

---

## Advanced Topics & Follow-Up Questions

### ETA Accuracy & Routing Engine Deep Dive

Getting accurate ETAs is critical — it affects driver matching, rider satisfaction, and pricing.

**Road Network Representation:**
```
Directed weighted graph:
  Nodes:  road intersections
  Edges:  road segments (with distance + speed limit + current traffic speed)

Edge weight = travel time = distance / effective_speed
effective_speed = speed_limit × traffic_factor

traffic_factor:
  Free flow: 1.0  (moving at speed limit)
  Light:     0.8
  Moderate:  0.6
  Heavy:     0.4
  Gridlock:  0.2
```

**Shortest Path Algorithms:**

| Algorithm | Use case | Time complexity |
|-----------|---------|----------------|
| Dijkstra | Single-source shortest path | O((V + E) log V) |
| A* | Faster than Dijkstra with heuristic (straight-line distance) | O(E log V) in practice |
| Contraction Hierarchies | Road networks — precompute shortcuts | O(E log V) precompute, O(1) query |
| OSRM / Valhalla | Open-source routing engines used in production | Sub-millisecond |

**Uber's approach:**
- Precompute contraction hierarchies on road network nightly
- Apply real-time traffic updates on top of precomputed shortcuts
- A* with precomputed heuristics: < 1ms ETA computation
- Batch ETA for matching: compute ETAs for top 50 driver candidates simultaneously using parallelism

**Real-time traffic data sources:**
- GPS traces from all active drivers → anonymized probe data → infer road speeds
- 10 million active drivers = best real-time traffic dataset in existence
- Historical patterns: "Tuesday 5pm on this road = always slow" → Bayesian prior

---

### Driver Supply Forecasting

Uber and Lyft predict driver supply and demand to:
1. Incentivize drivers to go to high-demand areas (boost pricing)
2. Predict surge pricing before it happens
3. Ensure balanced supply/demand globally

**ML Pipeline:**

```
Training data (historical):
  - Ride requests per geohash per time bucket
  - Driver supply per geohash per time bucket
  - External signals: weather, events, holidays, time of day, day of week

Model: Gradient Boosted Trees or LSTM for time-series forecasting
Output: predicted demand/supply ratio per geohash per 15-min window, 2 hours ahead

Real-time features:
  - Live Kafka stream: current requests per geohash (last 5 min)
  - Current active driver positions
  - Known events (stadium concert in 3 hours)

Inference: runs every 5 minutes, generates surge map for next 2 hours
```

**Incentive system:**
- Areas predicted to be undersupplied → notify nearby offline drivers: "Earn 2× in Downtown SF in 30 min"
- Goal: smooth driver supply curve before surge hits, not react to it

---

### Handling Trip Cancellations Fairly

**Rider cancellation:**
```
State: REQUESTED or MATCHED
Action: trip cancelled, driver released (status → available)
Fee: no fee if cancelled before driver starts moving
     flat cancellation fee if driver already en route
```

**Driver cancellation:**
```
State: MATCHED
Action: driver status → available
        trip goes back to REQUESTED → re-match with next best driver
Policy: drivers with high cancellation rate get penalized (lower boost earnings, fewer ride offers)
```

**Algorithm fairness:**
- Re-match with different driver, not same one who already declined
- Track `declined_driver_ids` on trip record; exclude from candidate pool
- If 3+ drivers decline: expand search radius or show rider "high demand, extending search..."

---

### Safety Features Architecture

**Share My Trip:**
```
Rider shares trip link → URL with trip_id + token
Recipient visits link → real-time map showing driver position
Implementation:
  - Short-lived token (JWT, 24h expiry) in URL
  - Read-only access to trip location via WebSocket
  - Same Redis pub/sub channel as rider uses
  - No auth required — designed for public sharing
```

**Emergency SOS:**
```
Rider presses SOS button in app:
  → POST /emergency { trip_id, location, type: "SOS" }
  → Immediately alerts Uber safety team (24/7 response center)
  → Optionally calls local emergency services (911)
  → Trip audio recording begins (with rider consent)
  → Driver behavior flags reviewed in real time
```

**Trusted Contacts:**
```
Pre-configured emergency contacts receive:
  - Real-time trip tracking link automatically on trip start
  - SMS alert with driver info + ETA
  - Push alert if trip deviates significantly from expected route
```

**Route deviation detection:**
```
Expected route: A → B (stored on trip start)
Every 30s: compare driver GPS to expected route
If driver is >500m off expected route for >60 seconds:
  → Alert rider: "Your trip is off route"
  → Alert safety team if rider doesn't respond
```

---

### Payment Processing Architecture

Even if "out of scope," mentioning it shows breadth.

**Fare calculation:**
```
fare = base_fare
     + (per_minute_rate × trip_duration_minutes)
     + (per_mile_rate × trip_distance_miles)
     × surge_multiplier
     - promo_discount
     + tolls (detected from route)
     + booking_fee

Stored in: trips table (fare_components as JSONB)
Displayed: itemized receipt in app
```

**Payment flow:**
```
1. Trip completes → Trip Service computes fare
2. Fare sent to Payment Service
3. Payment Service:
   a. Charges stored payment method (Stripe, Braintree)
   b. Handles splits (Uber Cash + credit card)
   c. Sends receipt via email/SMS
4. Driver earnings credited asynchronously
5. Retry logic: if charge fails → retry 3× → mark for manual review
```

**Idempotency in payments:**
- Every charge has a unique idempotency key: `trip_id + attempt_number`
- If network failure causes duplicate request → Stripe deduplicates by idempotency key
- Critical: never charge a rider twice for the same trip

---

### Geo-Fencing

Used for airport pickup zones, restricted areas, surge zones.

**Implementation:**

```
GeoFence = polygon defined by list of (lat, lon) coordinates

Example: SFO airport pickup zone
  [(37.615, -122.392), (37.618, -122.388), (37.613, -122.386), ...]

Point-in-polygon test (Ray Casting Algorithm):
  Cast a ray from point P in any direction
  Count how many times it crosses the polygon boundary
  Odd crossings → inside | Even crossings → outside
  O(n) where n = number of polygon vertices

Stored in:
  PostgreSQL with PostGIS extension (geom column with GIST index)
  or Redis with geofence polygons as serialized JSON

Check at:
  - Driver pickup: is driver inside airport zone? → show airport-specific instructions
  - Surge calculation: is rider inside surge polygon?
  - Restricted zones: block ride requests from certain areas
```

**PostGIS query:**
```sql
SELECT zone_name, zone_type
FROM geo_zones
WHERE ST_Contains(geom, ST_SetSRID(ST_Point($lon, $lat), 4326));

-- GIST index makes this sub-millisecond even with millions of polygons
```

---

### Common Follow-Up Questions

**Q: How do you handle driver location spoofing (GPS fraud)?**
- Drivers fake GPS to appear in high-surge areas without actually being there
- Detection signals:
  - Impossible speed: location jumps 50km in 5 seconds
  - Teleportation: location appears in two cities simultaneously
  - Sensor correlation: accelerometer/gyroscope data should match GPS movement
  - Device fingerprinting: emulator signatures (GPS spoofing apps typically run on rooted Android)
- Action: flag driver for review, reduce boost earnings, eventual deactivation

**Q: How do you implement UberPool (ride sharing between strangers)?**
- Pool matching: find riders going in similar directions within 2 minutes of each other
- Route optimization: find detour-minimizing route that serves both pickups/dropoffs
- Constraint: max 5-minute added time for any rider in pool
- Algorithm: combinatorial optimization (NP-hard in general) — use heuristics (greedy matching + local search)
- Implementation: separate matching pool for Pool rides vs. regular rides

**Q: What happens if a driver's app crashes mid-trip?**
- Trip Service detects: driver WebSocket disconnects
- 30-second grace period: wait for reconnect (network blip)
- After 30 seconds: mark driver as "connection lost"
- Rider gets in-app notification: "Connecting to driver..."
- If driver reconnects: resume trip normally (trip state in Cassandra survives)
- If driver does not reconnect after 5 minutes: trigger safety protocol, offer rider a new trip at no charge

**Q: How do you scale the matching service to millions of simultaneous requests?**
- Matching is stateless per request — horizontally scalable
- Shard matching by geographic region: matching service for NYC, matching service for SF, etc.
- Each region handles its own candidate pool — no cross-region queries
- At region boundaries: requests that straddle regions handled by the closer region
- State (which drivers have been offered a ride) stored in Redis, not matching service memory

**Q: How does Uber handle payments in countries with limited banking infrastructure?**
- Cash payments: driver collects cash, Uber charges their earnings/surety
- Mobile money (M-Pesa in Kenya, GCash in Philippines): integrate regional payment providers
- Pre-paid Uber Cash: users top up account before trips
- Architecture: Payment Service has pluggable payment provider interface — each country plugs in local providers

**Q: How do you design the driver onboarding and background check system?**
- Document upload: driver uploads license, insurance, vehicle registration to S3 via pre-signed URL
- Third-party background check API (Checkr, HireRight): async callback when check complete
- State machine: PENDING → UNDER_REVIEW → APPROVED | REJECTED
- Compliance: different requirements per jurisdiction (stored in configuration DB by country/state)
- Human review queue: flagged applications go to trust & safety team for manual review
