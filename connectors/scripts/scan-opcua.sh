#!/usr/bin/env bash
# --------------------------------------------------------------------
# Siemens OPC UA Browser Scanner + Metrics + Overload Risk
#
# This script:
#   1. Browses OPC UA starting at ObjectsFolder
#   2. Collects browse results
#   3. Reads each node individually
#   4. Saves per-node JSON, aggregated nodes.json, and metrics.json
#
# Usage:
#   ./scan-opcua.sh opc.tcp://192.168.0.20:4840
#
# --------------------------------------------------------------------

set -euo pipefail

ENDPOINT="${1:-}"

if [[ -z "$ENDPOINT" ]]; then
  echo "Usage: ./scan-opcua.sh opc.tcp://<PLC_IP>:4840"
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SAFE_NAME=$(echo "$ENDPOINT" | sed 's/[:/\\\\]/_/g')
OUTDIR="scan-results/${TIMESTAMP}-opcua-${SAFE_NAME}"
mkdir -p "$OUTDIR"

echo "--------------------------------------------------------------"
echo " Siemens OPC UA Scanner"
echo " Endpoint : $ENDPOINT"
echo " Output   : $OUTDIR"
echo "--------------------------------------------------------------"

echo "→ Browsing OPC UA tree..."
BROWSE=$(curl -s "http://localhost:8200/browse?endpoint=$ENDPOINT&nodeId=ObjectsFolder")

printf "%s" "$BROWSE" > "$OUTDIR/opcua-browse.json"

NODES=$(echo "$BROWSE" | jq -r '.nodes[].nodeId' 2>/dev/null || true)

if [[ -z "$NODES" ]]; then
  echo "ERROR: browse returned no nodes."
  exit 1
fi

START_TIME=$(date +%s)
COUNT=0
MAX_RESPONSE_TIME_MS=0

for NODE in $NODES; do
  SAFE_NODE=$(echo "$NODE" | sed 's/[:;/\\\\]/_/g')
  printf "→ Reading %-50s ... " "$NODE"

  T0=$(date +%s%N)
  RESPONSE=$(curl -s "http://localhost:8200/read?endpoint=$ENDPOINT&nodeId=$NODE")
  T1=$(date +%s%N)

  printf "%s" "$RESPONSE" > "$OUTDIR/node_${SAFE_NODE}.json"
  echo "saved"

  COUNT=$((COUNT + 1))
  ELAPSED_MS=$(( (T1 - T0) / 1000000 ))

  if (( ELAPSED_MS > MAX_RESPONSE_TIME_MS )); then
      MAX_RESPONSE_TIME_MS=$ELAPSED_MS
  fi
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

CPU=$(ps -o %cpu= -p $$ | awk '{print $1}')
RAM_MB=$(ps -o rss= -p $$ | awk '{print $1/1024}')

REQ_PER_SEC=$(echo "$COUNT / $DURATION" | bc -l | awk '{printf "%.2f"}')

# OPC UA devices usually handle 20–50 reads/sec safely
if (( $(echo "$REQ_PER_SEC < 20" | bc -l) )); then
    RISK="LOW"
elif (( $(echo "$REQ_PER_SEC < 40" | bc -l) )); then
    RISK="MEDIUM"
else
    RISK="HIGH"
fi

cat <<EOF > "$OUTDIR/metrics.json"
{
  "endpoint": "$ENDPOINT",
  "totalNodes": $COUNT,
  "durationSeconds": $DURATION,
  "maxResponseTimeMs": $MAX_RESPONSE_TIME_MS,
  "requestsPerSecond": $REQ_PER_SEC,
  "cpuUsagePercent_localProcess": $CPU,
  "ramUsageMB_localProcess": $RAM_MB,
  "overloadRisk": "$RISK"
}
EOF

if command -v jq >/dev/null 2>&1; then
  jq -s '.' "$OUTDIR"/node_*.json > "$OUTDIR/nodes.json"
  echo "✔ Aggregated: $OUTDIR/nodes.json"
fi

echo "✔ Metrics   : $OUTDIR/metrics.json"
echo "✔ Per-node  : $OUTDIR/"
echo "✔ Done."