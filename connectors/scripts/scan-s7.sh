#!/usr/bin/env bash
# --------------------------------------------------------------------
# Siemens S7 DB Scanner + Performance Metrics + Overload Risk Analysis
#
# This script scans a Siemens PLC using the classic S7 protocol (RFC1006)
# by looping through DBs and sending scan requests to the siemens‑s7
# connector running on http://localhost:8300.
#
# It collects:
#   - Per-DB raw scan results (db_<n>.json)
#   - Aggregated scan-results.json (if jq is installed)
#   - metrics.json containing:
#         - total DBs scanned
#         - total connections made
#         - max response time
#         - CPU % and RAM used by this script
#         - duration (seconds)
#         - overload risk classification:
#               LOW     (< 8 requests/sec)
#               MEDIUM  (8–15 requests/sec)
#               HIGH    (> 15 requests/sec)
#
# These thresholds are aligned with typical safe limits for S7 CPUs:
#   - S7‑300: 4–10 connections/sec recommended
#   - S7‑400: tolerates slightly more
#   - S7‑1200/1500 (classic mode): often slower due to PUT/GET
#
# Usage:
#   ./scan-all.sh <PLC_IP> [startDB] [endDB] [rack] [slot]
#
# Examples:
#   ./scan-all.sh 192.168.0.10
#   ./scan-all.sh 192.168.0.10 1 500
#   ./scan-all.sh 192.168.0.20 1 300 0 3   # S7‑400 example
#
# --------------------------------------------------------------------

set -euo pipefail

PLC_IP="${1:-}"
START_DB="${2:-1}"
END_DB="${3:-5}"
RACK="${4:-0}"
SLOT="${5:-2}"

if [[ -z "$PLC_IP" ]]; then
  echo "Usage: ./scan-all.sh <PLC_IP> [startDB] [endDB] [rack] [slot]"
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTDIR="scan-results/${TIMESTAMP}-${PLC_IP//./_}-r${RACK}s${SLOT}"
mkdir -p "$OUTDIR"

echo "--------------------------------------------------------------"
echo " Siemens S7 Scanner + Metrics"
echo " PLC: $PLC_IP"
echo " Rack/Slot: $RACK / $SLOT"
echo " DB Range: $START_DB .. $END_DB"
echo " Output: $OUTDIR"
echo "--------------------------------------------------------------"

START_TIME=$(date +%s)
CONNECTION_COUNT=0
MAX_RESPONSE_TIME_MS=0

for ((db=START_DB; db<=END_DB; db++)); do
    printf "→ DB%-4d ... " "$db"

    T0=$(date +%s%N)
    RESPONSE=$(curl -s -X POST http://localhost:8300/scan \
      -H "Content-Type: application/json" \
      -d "{\"host\":\"$PLC_IP\",\"rack\":$RACK,\"slot\":$SLOT,\"db\":$db,\"blockSize\":256,\"maxBytes\":4096}")
    T1=$(date +%s%N)

    printf "%s" "$RESPONSE" > "$OUTDIR/db_${db}.json"
    echo "saved"

    CONNECTION_COUNT=$((CONNECTION_COUNT+1))
    ELAPSED_MS=$(( (T1-T0) / 1000000 ))

    if (( ELAPSED_MS > MAX_RESPONSE_TIME_MS )); then
        MAX_RESPONSE_TIME_MS=$ELAPSED_MS
    fi
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Local CPU + RAM usage of this script itself
CPU=$(ps -o %cpu= -p $$ | awk '{print $1}')
RAM_MB=$(ps -o rss= -p $$ | awk '{print $1/1024}')

# Compute requests per second
if (( DURATION > 0 )); then
    REQ_PER_SEC=$(echo "$CONNECTION_COUNT / $DURATION" | bc -l | awk '{printf "%.2f", $0}')
else
    REQ_PER_SEC=$CONNECTION_COUNT
fi

# Overload classification (based on Siemens guidelines)
# < 8    req/sec → LOW (safe)
# 8–15   req/sec → MEDIUM (monitor)
# > 15   req/sec → HIGH (may overload PLC)
if (( $(echo "$REQ_PER_SEC < 8" | bc -l) )); then
    RISK="LOW"
elif (( $(echo "$REQ_PER_SEC < 15" | bc -l) )); then
    RISK="MEDIUM"
else
    RISK="HIGH"
fi

# Save metrics.json
cat <<EOF > "$OUTDIR/metrics.json"
{
  "plc": "$PLC_IP",
  "rack": $RACK,
  "slot": $SLOT,
  "dbRange": [$START_DB, $END_DB],
  "totalDBs": $((END_DB - START_DB + 1)),
  "totalConnections": $CONNECTION_COUNT,
  "durationSeconds": $DURATION,
  "maxResponseTimeMs": $MAX_RESPONSE_TIME_MS,
  "requestsPerSecond": $REQ_PER_SEC,
  "cpuUsagePercent_localProcess": $CPU,
  "ramUsageMB_localProcess": $RAM_MB,
  "overloadRisk": "$RISK"
}
EOF

# Aggregate DB files into one JSON array (optional)
if command -v jq >/dev/null 2>&1; then
    jq -s '.' "$OUTDIR"/db_*.json > "$OUTDIR/scan-results.json"
    echo "✔ Aggregated: $OUTDIR/scan-results.json"
fi

echo "✔ Metrics   : $OUTDIR/metrics.json"
echo "✔ Per-DB    : $OUTDIR/"
echo "✔ Done."
echo "--------------------------------------------------------------"