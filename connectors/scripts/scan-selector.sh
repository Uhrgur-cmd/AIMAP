#!/usr/bin/env bash
# --------------------------------------------------------------------
# PLC Scanner Selector + Automatic kubectl port-forward
#
# Supports:
#   - Siemens S7 (port 8300)
#   - Rockwell EIP (port 8100)
#   - Siemens OPC UA Browser (port 8200)
#
# Steps:
#   1. User chooses scanner
#   2. Selector runs kubectl port-forward for correct deployment
#   3. Waits for port to respond
#   4. Asks scanner-specific questions
#   5. Calls underlying scan script
#
# Future UI-friendly design for dashboards / TUI / Web UI
# --------------------------------------------------------------------

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------
# Gracefully kill port-forwards on exit
# ---------------------------------------------
cleanup() {
  if [[ -n "${PF_PID:-}" ]]; then
    echo "Stopping port-forward (PID: $PF_PID)..."
    kill $PF_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------
# Start port-forward helper
# ---------------------------------------------
start_port_forward() {
  local deploy="$1"
  local port="$2"

  echo "→ Starting port-forward for $deploy (:$port)..."

  kubectl port-forward deploy/"$deploy" "$port":"$port" >/dev/null 2>&1 &

  PF_PID=$!
  sleep 1

  # Wait until port is open
  for i in {1..15}; do
    if curl -s "http://localhost:$port/healthz" >/dev/null; then
      echo "✓ Port-forward is active (localhost:$port)"
      return
    fi
    echo "Waiting for port-forward... ($i/15)"
    sleep 1
  done

  echo "ERROR: Port-forward to $deploy:$port failed."
  exit 1
}

# ---------------------------------------------
# Menu
# ---------------------------------------------
echo "============================================================"
echo "   PLC CONNECTOR SCANNER SELECTOR (with port-forward)"
echo "============================================================"
echo "Choose a scanner:"
echo "  1) Siemens S7 (Classic RFC1006)"
echo "  2) Rockwell EtherNet/IP"
echo "  3) Siemens OPC UA Browser"
echo "------------------------------------------------------------"
read -rp "Enter choice (1/2/3): " CHOICE

case "$CHOICE" in

  # ------------------------------------------------------------------
  # 1) Siemens S7
  # ------------------------------------------------------------------
  1)
    echo ""
    echo "Selected: Siemens S7 Scanner"

    # Auto port-forward
    start_port_forward "siemens-s7" 8300

    # Scanner parameters
    read -rp "PLC IP                : " PLC_IP
    read -rp "Start DB (default 1)  : " START_DB
    read -rp "End DB (default 300)  : " END_DB
    read -rp "Rack (default 0)      : " RACK
    read -rp "Slot (default 2)      : " SLOT

    START_DB=${START_DB:-1}
    END_DB=${END_DB:-300}
    RACK=${RACK:-0}
    SLOT=${SLOT:-2}

    "$SCRIPT_DIR/scan-s7.sh" "$PLC_IP" "$START_DB" "$END_DB" "$RACK" "$SLOT"
    ;;

  # ------------------------------------------------------------------
  # 2) Rockwell
  # ------------------------------------------------------------------
  2)
    echo ""
    echo "Selected: Rockwell EtherNet/IP Scanner"

    # Auto port-forward
    start_port_forward "rockwell-connector" 8100

    read -rp "PLC IP                : " PLC_IP
    read -rp "Slot number (default 0): " SLOT

    SLOT=${SLOT:-0}

    "$SCRIPT_DIR/scan-rockwell.sh" "$PLC_IP" "$SLOT"
    ;;

  # ------------------------------------------------------------------
  # 3) OPC UA
  # ------------------------------------------------------------------
  3)
    echo ""
    echo "Selected: Siemens OPC UA Browser"

    # Auto port-forward
    start_port_forward "siemens-browser" 8200

    read -rp "Endpoint (opc.tcp://IP:4840): " ENDPOINT

    "$SCRIPT_DIR/scan-opcua.sh" "$ENDPOINT"
    ;;

  *)
    echo "Invalid choice. Exiting."
    exit 1
    ;;
esac

echo ""
echo "============================================================"
echo "Scan completed."
echo "Results stored under scan-results/"
echo "============================================================"