#!/usr/bin/env bash
# --------------------------------------------------------------------
# Rockwell EtherNet/IP Tag Scanner + Performance Metrics + Overload Risk
#
# This script:
#   1. Calls /rockwell/tags to discover all visible tags
#   2. Reads each tag individually via /rockwell/read
#   3. Saves one file per tag + an aggregated tags.json (if jq exists)
#   4. Saves metrics.json (CPU, RAM, req/sec, overload risk)
#
# Usage:
#   ./scan-rockwell.sh <PLC_IP> [slot]
#
# Example:
#   ./scan-rockwell.sh 192.168.0.50 0
#
# --------------------------------------------------------------------

set -euo pipefail

PLC_IP="${1:-}"
SLOT="${2:-0}"

if [[ -z "$PLC_IP" ]]; then
  echo "Usage: ./scan-rockwell.sh <PLC_IP> [slot]"
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTDIR="scan-results/${TIMESTAMP}-rockwell-${PLC_IP//./_}-slot${SLOT}"
mkdir -p "$OUTDIR"

echo "--------------------------------------------------------------"
echo " Rockwell Tag Scanner"
echo " PLC IP   : $PLC_IP"
echo " Slot     : $SLOT"
echo " Output   : $OUTDIR"
echo "--------------------------------------------------------------"

echo "→ Discovering tags..."
TAGLIST=$(curl -s "http://localhost:8100/tags?ip=$PLC_IP&slot=$SLOT")

if [[ "$TAGLIST" == "" ]]; then
  echo "ERROR: no tags returned. Check connectivity."
  exit 1
fi

printf "%s" "$TAGLIST" > "$OUTDIR/tags-discovered.json"

TAGS=$(echo "$TAGLIST" | jq -r '.tags[]' 2>/dev/null || true)

if [[ -z "$TAGS" ]]; then
  echo "ERROR: no tags parsed. Check tag structure."
  exit 1
fi

START_TIME=$(date +%s)
CONNECTION_COUNT=0
MAX_RESPONSE_TIME_MS=0

for TAG in $TAGS; do
  SAFE_TAG=$(echo "$TAG" | tr '/' '_')
  printf "→ Reading tag %-40s ... " "$TAG"

  T0=$(date +%s%N)
  RESPONSE=$(curl -s "http://localhost:8100/read?ip=$PLC_IP&slot=$SLOT&tag=$TAG")
  T1=$(date +%s%N)

  printf "%s" "$RESPONSE" > "$OUTDIR/tag_${SAFE_TAG}.json"
  echo "saved"

  CONNECTION_COUNT=$((CONNECTION_COUNT+1))
  ELAPSED_MS=$(( (T1-T0) / 1000000 ))

  if (( ELAPSED_MS > MAX_RESPONSE_TIME_MS )); then
      MAX_RESPONSE_TIME_MS=$ELAPSED_MS
  fi
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

CPU=$(ps -o %cpu= -p $$ | awk '{print $1}')
RAM_MB=$(ps -o rss= -p $$ | awk '{print $1/1024}')

REQ_PER_SEC=$(echo "$CONNECTION_COUNT / $DURATION" | bc -l | awk '{printf "%.2f"}')

# Overload rules for Rockwell (safe up to ~20 reads/sec per CIP device)
if (( $(echo "$REQ_PER_SEC < 15" | bc -l) )); then
    RISK="LOW"
elif (( $(echo "$REQ_PER_SEC < 25" | bc -l) )); then
    RISK="MEDIUM"
else
    RISK="HIGH"
fi

cat <<EOF > "$OUTDIR/metrics.json"
{
  "plc": "$PLC_IP",
  "slot": $SLOT,
  "totalTags": $CONNECTION_COUNT,
  "durationSeconds": $DURATION,
  "maxResponseTimeMs": $MAX_RESPONSE_TIME_MS,
  "requestsPerSecond": $REQ_PER_SEC,
  "cpuUsagePercent_localProcess": $CPU,
  "ramUsageMB_localProcess": $RAM_MB,
  "overloadRisk": "$RISK"
}
EOF

if command -v jq >/dev/null 2>&1; then
  jq -s '.' "$OUTDIR"/tag_*.json > "$OUTDIR/tags.json"
  echo "✔ Aggregated file written to: $OUTDIR/tags.json"
fi

echo "✔ Metrics   : $OUTDIR/metrics.json"
echo "✔ Per-tag   : $OUTDIR/"
echo "✔ Done."