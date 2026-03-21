# CT-Gate — PLC Signal Mapping Platform

CT-Gate is a hosted platform that connects to industrial PLCs (Siemens S7, Siemens OPC UA, Rockwell Allen-Bradley), discovers signals, maps them to a standardized data model using local AI assistance (Ollama), exposes live values via an integrated OPC UA server, and publishes normalized data to MQTT or stdout. It is designed to be deployed in OT (Operational Technology) environments as a Docker Compose stack or a Kubernetes cluster — with no dependency on cloud AI services.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Repository Structure](#repository-structure)
- [Setup & Installation](#setup--installation)
  - [Prerequisites](#prerequisites)
  - [Docker Compose (local / edge)](#docker-compose-local--edge)
  - [Kubernetes / Helm (cluster)](#kubernetes--helm-cluster)
  - [Database Migration](#database-migration)
- [Environment Variables Reference](#environment-variables-reference)
- [Port Reference & How to Change Them](#port-reference--how-to-change-them)
- [Application Components](#application-components)
  - [Frontend](#frontend)
  - [Backend API](#backend-api)
  - [Collector](#collector)
  - [Connector — Siemens S7 Classic](#connector--siemens-s7-classic)
  - [Connector — Siemens OPC UA](#connector--siemens-opc-ua)
  - [Connector — Rockwell EtherNet/IP](#connector--rockwell-ethernetip)
  - [OPC UA Server](#opc-ua-server)
  - [PostgreSQL](#postgresql)
- [Data Flow Diagram](#data-flow-diagram)
- [API Endpoints](#api-endpoints)
- [Supported PLC Types & Project Files](#supported-plc-types--project-files)
- [AI Mapping Providers](#ai-mapping-providers)
- [Debugging Guide](#debugging-guide)
- [Dependency License Audit](#dependency-license-audit)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Browser  (:8080)                                            │
│  React SPA (Vite + Tailwind + i18n — 7 languages)           │
└──────────────────┬───────────────────────────────────────────┘
                   │ HTTP /api/*  +  /opcua-api/*  (nginx reverse proxy)
┌──────────────────▼───────────────────────────────────────────┐
│  Backend  (:3050, internal only)                              │
│  Node.js / Express  —  REST API + AI Mapper + File Parser    │
│  cross-reference · ctbase-rules · mc7-decoder                │
│  PostgreSQL client  —  signal/mapping/datamodel persistence  │
└──────┬──────────────────────────────────────────────────────┘
       │ SQL
┌──────▼──────────┐    HTTP      ┌──────────────────────────────┐
│  PostgreSQL      │◄────────────►│  Collector (no HTTP port)    │
│  (:5432)         │             │  Polls backend, reads PLCs,  │
└─────────────────┘             │  evaluates expressions,      │
                                │  publishes to MQTT or stdout  │
                                └──────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  OPC UA Server  (:4840 OPC UA / :4841 HTTP internal)         │
│  Exposes all machine mappings as live OPC UA variables       │
│  NodeId: ns=2;s=<MachineName>.<Category>.<Signal>            │
│  Polls backend + connectors every POLL_INTERVAL_MS           │
│  REST+SSE API (/opcua-api/*) → OPC UA Explorer web page      │
└──────────────────────────────────────────────────────────────┘

PLC Communication (via connector microservices)
┌──────────────────────────┐  ┌───────────────────────────┐  ┌────────────────────────┐
│  siemens-s7  (:8300)     │  │  siemens-opc  (:8301)     │  │  rockwell  (:8302)     │
│  RFC1006 / ISO-TCP       │  │  OPC UA (TCP :4840 on PLC)│  │  EtherNet/IP / CIP     │
│  Siemens S7-300/400/1200 │  │  Siemens S7-1200/1500     │  │  Rockwell CompactLogix │
└──────────────────────────┘  └───────────────────────────┘  └────────────────────────┘
```

---

## Repository Structure

```mermaid
graph TD
    ROOT["/ct-gate/"]

    ROOT --> APPS["apps/"]
    ROOT --> DOCKER["docker/"]
    ROOT --> HELM["helm/ct-gate/"]
    ROOT --> ARGOCD["argocd/"]
    ROOT --> ENV[".env.example"]

    APPS --> BE["backend/"]
    APPS --> FE["frontend/"]
    APPS --> COL["collector/"]
    APPS --> OPC["opcua-server/"]
    APPS --> CONN["connectors/"]

    BE --> BE_SRC["src/"]
    BE_SRC --> BE_DB["db/  (migrate.js, pool.js)"]
    BE_SRC --> BE_ROUTES["routes/  (machines, signals, mappings, datamodel)"]
    BE_SRC --> BE_SVC["services/  (ai-mapper, cross-reference, ctbase-rules,\nmc7-decoder, live-scanner, project-parser,\nscan-validator, expression-engine)"]
    BE_SRC --> BE_IDX["index.js  (Express entry point)"]

    OPC --> OPC_SRC["src/index.js  (OPC UA server + polling loop)"]

    FE --> FE_SRC["src/"]
    FE_SRC --> FE_COMP["components/  (Sidebar, MappingView, AddMachineModal,\nDataModelEditor, ExpressionBuilder, LanguageSwitcher)"]
    FE_SRC --> FE_I18N["i18n/  (index.js + locales: en de es ro hu zh pt-BR)"]
    FE_SRC --> FE_UTILS["utils/api.js"]
    FE_SRC --> FE_APP["App.jsx  +  main.jsx"]

    COL --> COL_SRC["src/index.js  (polling loop + expression evaluator + MQTT)"]

    CONN --> S7["siemens-s7/src/\n  index.js (HTTP server)\n  s7-scanner.js (heuristic DB scan)\n  s7-reader.js (batch reads)\n  s7-classifier.js (CLI util)"]
    CONN --> OPC["siemens-opc/src/\n  index.js (HTTP server)\n  opcua-client.js"]
    CONN --> RW["rockwell/src/\n  index.js (HTTP server)\n  enip-client.js"]

    DOCKER --> DCOMPOSE["docker-compose.yml"]
    DOCKER --> DFBE["Dockerfile.backend"]
    DOCKER --> DFFE["Dockerfile.frontend"]
    DOCKER --> DFCO["Dockerfile.collector"]
    DOCKER --> DFOPCUA["Dockerfile.opcua"]
    DOCKER --> DFS7["Dockerfile.siemens-s7"]
    DOCKER --> DFOPC["Dockerfile.siemens-opc"]
    DOCKER --> DFRW["Dockerfile.rockwell"]
    DOCKER --> NGINX["nginx.conf"]

    HELM --> HVAL["values.yaml"]
    HELM --> HTMPL["templates/  (backend, frontend, collector,\nconnectors, postgres, ingress, secret)"]
```

---

## Setup & Installation

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Docker | ≥ 24 | Container runtime |
| Docker Compose | ≥ 2.20 | Local orchestration |
| `kubectl` + Helm | ≥ 1.28 / ≥ 3.14 | Kubernetes deployment |
| [Ollama](https://ollama.ai) | ≥ 0.3 | Local AI for signal mapping (no cloud required) |

Network access from the host machine (or cluster) to the PLCs on the OT network is required for live scanning and data collection.

---

### Docker Compose (local / edge)

```bash
# 1. Clone the repo
git clone <repo-url> ct-gate
cd ct-gate

# 2. Create your .env from the example
cp .env.example .env

# 3. Edit .env — set the Ollama URL (if not on localhost)
#    AI mapping is local-only; no cloud keys needed
nano .env

# 4. Pull the AI model (on the machine running Ollama)
ollama pull llama3.1:8b

# 5. Build and start all 8 services
cd docker
docker compose up -d --build

# 6. Run the database migration (only required on first start)
docker compose exec backend node src/db/migrate.js

# 7. Verify all containers are healthy
docker compose ps
```

The web UI is now available at **http://localhost:8080**.

> **Tip:** On subsequent starts, `docker compose up -d` (without `--build`) is enough.
> Only run `--build` after pulling new code or modifying source files.

---

### Kubernetes / Helm (cluster)

The `helm/ct-gate/` chart deploys the full stack with a Traefik IngressRoute.

```bash
# 1. Build and push images to your registry
docker build -f docker/Dockerfile.backend  -t your-registry/ct-gate-backend:0.1.0  .
docker build -f docker/Dockerfile.frontend -t your-registry/ct-gate-frontend:0.1.0 .
docker build -f docker/Dockerfile.collector   -t your-registry/ct-gate-collector:0.1.0            .
docker build -f docker/Dockerfile.opcua       -t your-registry/ct-gate-opcua-server:0.1.0         .
docker build -f docker/Dockerfile.siemens-s7  -t your-registry/ct-gate-connector-siemens-s7:0.1.0 .
docker build -f docker/Dockerfile.siemens-opc -t your-registry/ct-gate-connector-siemens-opc:0.1.0 .
docker build -f docker/Dockerfile.rockwell    -t your-registry/ct-gate-connector-rockwell:0.1.0   .
docker push your-registry/ct-gate-... # push each image

# 2. Create a namespace
kubectl create namespace ct-gate

# 3. Create the AI keys secret (optional — skip if not using AI)
kubectl create secret generic ct-gate-secrets \
  --from-literal=OPENAI_API_KEY=sk-... \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  -n ct-gate

# 4. Customize values (registry, host, TLS, storage classes)
cp helm/ct-gate/values.yaml helm/ct-gate/values.local.yaml
nano helm/ct-gate/values.local.yaml

# 5. Install
helm install ct-gate helm/ct-gate -n ct-gate -f helm/ct-gate/values.local.yaml

# 6. Run database migration (only on first install)
kubectl exec -n ct-gate deployment/ct-gate-backend -- node src/db/migrate.js
```

For **ArgoCD GitOps** deployment, see `argocd/application.yaml`.

---

### Database Migration

The migration script (`apps/backend/src/db/migrate.js`) creates all tables and inserts a default data model. It is **idempotent** (safe to run multiple times — uses `CREATE TABLE IF NOT EXISTS`).

```bash
# Docker Compose
docker compose exec backend node src/db/migrate.js

# Kubernetes
kubectl exec -n ct-gate deployment/ct-gate-backend -- node src/db/migrate.js

# Local development (with DATABASE_URL set in .env)
cd apps/backend && node src/db/migrate.js
```

---

## Environment Variables Reference

Copy `.env.example` to `.env` and populate the values before starting.

| Variable | Default | Service | Description |
|----------|---------|---------|-------------|
| `DATABASE_URL` | `postgresql://ctgate:ctgate@localhost:5432/ctgate` | backend | Full PostgreSQL connection string |
| `PORT` | `3050` | backend | Backend HTTP listen port |
| `UPLOAD_PATH` | `./uploads` | backend | Directory for uploaded project files |
| `AI_PROVIDER` | `ollama` | backend | AI provider: `ollama` (default), `openai`, `anthropic` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | backend | Ollama base URL — **required for AI mapping** |
| `OLLAMA_MODEL` | `llama3.1:8b` | backend | Ollama model to use for signal mapping |
| `OPENAI_API_KEY` | _(empty)_ | backend | OpenAI API key — only if `AI_PROVIDER=openai` |
| `ANTHROPIC_API_KEY` | _(empty)_ | backend | Anthropic API key — only if `AI_PROVIDER=anthropic` |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | backend | Anthropic model ID — only if `AI_PROVIDER=anthropic` |
| `BACKEND_URL` | `http://localhost:3050` | collector, opcua-server | URL these services use to reach the backend |
| `POLL_INTERVAL_MS` | `10000` | collector | How often the collector polls PLC data (ms) |
| `POLL_INTERVAL_MS` | `5000` | opcua-server | How often the OPC UA server refreshes PLC values (ms) |
| `OPC_PORT` | `4840` | opcua-server | OPC UA server listen port |
| `MQTT_BROKER` | _(empty)_ | collector | MQTT broker URL (e.g. `mqtt://192.168.1.100:1883`). If empty, data is printed to stdout |
| `MQTT_TOPIC_PREFIX` | `ctgate` | collector | MQTT topic prefix. Output: `ctgate/<machine-name>/<signal>` |
| `SIEMENS_S7_URL` | `http://localhost:8300` | backend, opcua-server | Internal URL for the siemens-s7 connector |
| `SIEMENS_OPCUA_URL` | `http://localhost:8200` | backend | Internal URL for the siemens-opc connector |
| `ROCKWELL_URL` | `http://localhost:8100` | backend, opcua-server | Internal URL for the rockwell connector |
| `SIEMENS_S7_PORT` | `8300` | siemens-s7 | Port the siemens-s7 connector listens on |
| `SIEMENS_OPC_PORT` | `8301` | siemens-opc | Port the siemens-opc connector listens on |
| `ROCKWELL_PORT` | `8302` | rockwell | Port the rockwell connector listens on |

> **Note:** In Docker Compose, internal service URLs use Docker service names (`http://siemens-s7:8300`), not `localhost`. This is already configured in `docker-compose.yml`.

---

## Port Reference & How to Change Them

### Port Map

| Port | Direction | Service | Protocol | Purpose |
|------|-----------|---------|----------|---------|
| **8080** | host → container | frontend (nginx) | HTTP | Web UI — only port that needs to be opened to users |
| **5432** | internal only | postgres | TCP/PostgreSQL | Database — do NOT expose externally |
| **3050** | internal only | backend | HTTP/REST | API — proxied via nginx, do NOT expose externally |
| **4840** | host ↔ container | opcua-server | OPC UA/TCP | CT-Gate OPC UA Server — expose to OT clients that need live PLC values via OPC UA |
| **8300** | host ↔ container | siemens-s7 | HTTP | S7 connector REST API |
| **8301** | host ↔ container | siemens-opc | HTTP | OPC UA connector REST API (reads PLC OPC UA servers) |
| **8302** | host ↔ container | rockwell | HTTP | EtherNet/IP connector REST API |
| **4840** | outbound (PLC) | siemens-opc → PLC | OPC UA/TCP | Standard OPC UA port on the PLC. Must be reachable from the siemens-opc container |
| **102** | outbound (PLC) | siemens-s7 → PLC | RFC1006/ISO-TCP | Standard S7 port (Siemens). Must be reachable from the siemens-s7 container |
| **44818** | outbound (PLC) | rockwell → PLC | EtherNet/IP/CIP | Standard Rockwell port. Must be reachable from the rockwell container |
| **11434** | outbound | backend → Ollama | HTTP | Ollama AI inference. Set `OLLAMA_BASE_URL` if Ollama runs on a different host |
| **1883** or custom | outbound | collector → MQTT broker | MQTT | Optional — only when `MQTT_BROKER` is set |

### How to Change Ports (Docker Compose)

All port mappings live in **`docker/docker-compose.yml`**. The connectors and frontend have a `ports:` section that maps `host_port:container_port`.

**Example: Change the Web UI from 8080 to 9090**

```yaml
# docker/docker-compose.yml
services:
  frontend:
    ports:
      - "9090:80"   # changed from 8080:80
```

**Example: Change all connector host ports**

```yaml
services:
  siemens-s7:
    ports:
      - "18300:8300"   # new host port 18300
    environment:
      PORT: 8300       # container port stays the same

  siemens-opc:
    ports:
      - "18301:8301"
    environment:
      PORT: 8301

  rockwell:
    ports:
      - "18302:8302"
    environment:
      PORT: 8302
```

After changing the connector host ports, you **must also update the backend's environment variables** so it knows where to find the connectors. In Docker Compose, the backend always talks to connectors via the internal Docker network (using service names), so changing host-side ports does **not** affect the backend. The `SIEMENS_S7_URL`, `SIEMENS_OPCUA_URL`, and `ROCKWELL_URL` variables are only needed for non-Docker (bare-metal) deployments.

**Example: Change the backend internal port**

The backend reads `PORT` from its environment. To change it:

```yaml
services:
  backend:
    environment:
      PORT: 4000          # changed from 3050
  frontend:
    # nginx.conf proxies to http://backend:3050 — update nginx.conf to match
    # docker/nginx.conf line: proxy_pass http://backend:4000;
  collector:
    environment:
      BACKEND_URL: http://backend:4000   # keep in sync
  opcua-server:
    environment:
      BACKEND_URL: http://backend:4000   # keep in sync
```

> **Warning:** Changing the backend port also requires updating `docker/nginx.conf`'s `proxy_pass` directive and the `BACKEND_URL` in both `collector` and `opcua-server`.

### How to Change Ports (Kubernetes / Helm)

Port overrides in Kubernetes are done through `helm/ct-gate/values.yaml`:

```yaml
backend:
  port: 3050        # ClusterIP service port

frontend:
  port: 80          # ClusterIP service port

connectors:
  siemensS7:
    port: 8300      # ClusterIP service port
  siemensOpc:
    port: 8301
  rockwell:
    port: 8302
```

For `NodePort` or `LoadBalancer` services, edit the relevant template in `helm/ct-gate/templates/connectors.yaml`. The ingress host is configured under `ingress.host`.

### Port Conflict Checklist for OT Clusters

Before deploying into an existing cluster, verify these ports are not already occupied:

```bash
# On Docker Compose host
ss -tlnp | grep -E '8080|4840|8300|8301|8302'

# On Kubernetes cluster (check existing services)
kubectl get svc -A | grep -E '8080|4840|8300|8301|8302'
```

If conflicts exist, change only the `ports:` mapping in `docker-compose.yml` (host side). The container-internal ports do not need to change.

---

## Application Components

### Frontend

**Path:** `apps/frontend/`
**Technology:** React 18, Vite 6, Tailwind CSS 3, react-i18next
**Container port:** 80 (nginx)
**Host port:** 8080

A single-page React application served by nginx. Nginx also reverse-proxies all `/api/*` requests to the backend, so the browser only needs one port (8080).

**Features:**
- Machine management (add / edit / delete PLCs)
- Signal browser — lists all discovered PLC signals with address, name, type, comment
- Drag-and-drop mapping from PLC signal to standard data model field
- Expression builder — write `DB10.DBX4.0 AND DB10.DBD0 > 100` style formulas
- AI Suggest — one-click local AI (Ollama) batch mapping with live progress bar
- Minimum confidence filter slider — hide AI-suggested mappings below threshold (50–100%, default 85%)
- Live Scan with configurable DB range (S7 only) and progress bar
- Project file upload (.zap, .s7p, .L5X)
- Standard Data Model editor (add/remove/export/import signals as JSON)
- **OPC UA Explorer** — full-screen tree view of the CT-Gate OPC UA address space with real-time live values via SSE; copy NodeId (`ns=2;s=...`) with one click; smart per-machine subscription (SSE stream opens on expand, closes on collapse)
- CT-Gate logo in sidebar
- **7 UI languages** — English, Deutsch, Español, Română, Magyar, 中文, Português BR
- Continental brand color theme (black / gold #ffa500 / silver #858D8D / white)

**Key files:**

| File | Purpose |
|------|---------|
| `src/App.jsx` | Root component, machine CRUD orchestration |
| `src/components/Sidebar.jsx` | Machine list, language switcher |
| `src/components/MappingView.jsx` | Main two-panel mapping workspace |
| `src/components/AddMachineModal.jsx` | Add/edit machine form |
| `src/components/DataModelEditor.jsx` | Standard data model CRUD |
| `src/components/OpcuaView.jsx` | OPC UA Explorer full-screen page (tree + SSE live values) |
| `src/components/ExpressionBuilder.jsx` | Visual expression / formula editor |
| `src/components/LanguageSwitcher.jsx` | Language dropdown (persisted to localStorage) |
| `src/i18n/index.js` | i18next configuration |
| `src/i18n/locales/*.json` | Translation strings per language |
| `src/utils/api.js` | Thin HTTP client wrapper |
| `tailwind.config.js` | CT brand colors (`ct-gold`, `ct-silver`, etc.) |
| `docker/nginx.conf` | Reverse proxy `/api/*` to backend, SPA fallback |

---

### Backend API

**Path:** `apps/backend/`
**Technology:** Node.js 20, Express 4, PostgreSQL (pg)
**Container port:** 3050
**Not exposed to host** (only accessible via nginx proxy)

The central REST API. Handles all persistence, PLC orchestration, file parsing, and AI mapping.

**Key files:**

| File | Purpose |
|------|---------|
| `src/index.js` | Express bootstrap, route registration, `/healthz` |
| `src/db/pool.js` | pg connection pool (reads `DATABASE_URL`) |
| `src/db/migrate.js` | DDL — creates all tables, inserts default data model |
| `src/routes/machines.js` | Machine CRUD, project file upload, live scan trigger & progress polling |
| `src/routes/signals.js` | Signal listing with network comment context |
| `src/routes/mappings.js` | Mapping CRUD, AI-suggest trigger & status polling |
| `src/routes/datamodel.js` | Standard data model versioned CRUD |
| `src/services/project-parser.js` | TIA Portal / Step7 / Rockwell file parser — includes MC7 bytecode decoding for S7-300/400 FC/FB/OB blocks |
| `src/services/live-scanner.js` | Orchestrates background live scan across all connector types |
| `src/services/scan-validator.js` | Validates parsed signals against live PLC |
| `src/services/ai-mapper.js` | Local AI batch mapping via Ollama (two-phase: BOOL/INT/REAL then STRING lookups) |
| `src/services/cross-reference.js` | Builds per-signal dependency trees from network comments and FB interfaces; used as AI context |
| `src/services/ctbase-rules.js` | CTBase signal type specification (100+ rules) injected into AI prompts for accurate mapping |
| `src/services/mc7-decoder.js` | MC7 bytecode decoder (port of rz-libmc7, LGPL-3.0) — extracts logic chains from compiled S7 code |
| `src/services/expression-engine.js` | Safe expression evaluator (expr-eval) |

**Database tables:**

| Table | Purpose |
|-------|---------|
| `machines` | PLC device registry (name, type, host, connector) |
| `signals` | Discovered PLC signals (address, name, type, comment, live_confirmed) |
| `network_comments` | Network/rung documentation extracted from project files |
| `datamodel` | Versioned standard output schema |
| `datamodel_signals` | Individual fields in the standard schema |
| `mappings` | PLC signal → standard field mapping rules |

---

### Collector

**Path:** `apps/collector/`
**Technology:** Node.js 20
**No HTTP port** (outbound-only service)

Runs a continuous polling loop. On each cycle it:

1. Fetches all `connected` machines from the backend
2. Gets mappings for each machine
3. Reads the required PLC addresses via the connector microservices
4. Evaluates expressions (e.g. `DB10.DBX4.0 AND DB10.DBD0 > 100`)
5. Resolves lookup tables (e.g. `{1: "RUNNING", 2: "IDLE"}`)
6. Publishes normalized output as JSON to MQTT (topic: `ctgate/<machine-name>/<signal>`) or prints to stdout if no broker is configured

**Address format handled by the collector:**

| S7 Address Format | Nodes7 Format Used |
|-------------------|--------------------|
| `DB10.DBD0` (REAL) | `DB10,REAL0` |
| `DB10.DBD0` (DINT) | `DB10,DI0` |
| `DB10.DBD0` (DWORD) | `DB10,DW0` |
| `DB10.DBW0` | `DB10,INT0` |
| `DB10.DBX4.0` | `DB10,X4.0` |

---

### Connector — Siemens S7 Classic

**Path:** `apps/connectors/siemens-s7/`
**Technology:** Node.js 20, nodes7 (RFC1006 / ISO-TCP)
**Container port:** 8300
**PLC protocol port:** 102 (ISO-TCP on the PLC — must be open in firewall)
**Supported PLCs:** S7-300, S7-400, S7-1200 (classic mode)

Exposes two HTTP endpoints consumed by the backend and collector:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /scan` | POST | Heuristic DB scan — iterates memory offsets looking for BOOL/INT/REAL patterns |
| `POST /read` | POST | Batch absolute-address read — returns current values for a list of addresses |
| `GET /healthz` | GET | Returns `{"status":"ok"}` |

The scanner (`s7-scanner.js`) reads raw bytes from a DB and applies heuristics:
- **REAL** — 4-byte aligned offset, IEEE 754 float in a plausible industrial range (−10000 to +10000)
- **INT** — 2-byte aligned offset, non-zero signed integer
- **BOOL** — every bit in the byte at each offset

---

### Connector — Siemens OPC UA

**Path:** `apps/connectors/siemens-opc/`
**Technology:** Node.js 20, node-opcua
**Container port:** 8301
**PLC protocol port:** 4840 (OPC UA on the PLC — must be open in firewall)
**Supported PLCs:** S7-1200 (OPC UA mode), S7-1500
**Requirement:** OPC UA server must be enabled in TIA Portal and the CPU's web server or OPC UA access settings

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /browse` | GET | Browse OPC UA node tree starting from a given nodeId |
| `GET /read` | GET | Read a single node value |
| `POST /write` | POST | Write a value to a node |
| `GET /healthz` | GET | Health check |

Security mode: `None` (cleartext). For encrypted OPC UA, the `opcua-client.js` would need to be updated with certificates.

---

### Connector — Rockwell EtherNet/IP

**Path:** `apps/connectors/rockwell/`
**Technology:** Node.js 20, st-ethernet-ip (EtherNet/IP / CIP)
**Container port:** 8302
**PLC protocol port:** 44818 (EtherNet/IP on the PLC — must be open in firewall)
**Supported PLCs:** CompactLogix, ControlLogix (Allen-Bradley / Rockwell Automation)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /tags` | GET | List controller tags and UDT templates |
| `GET /read` | GET | Read a single tag value |
| `POST /write` | POST | Write a value to a tag |
| `GET /healthz` | GET | Health check |

---

### OPC UA Server

**Path:** `apps/opcua-server/`
**Technology:** Node.js 20, node-opcua, Express 4
**OPC UA port:** 4840 (host-exposed — connect any OPC UA client here)
**HTTP API port:** 4841 (internal only — proxied by nginx at `/opcua-api/`)

An OPC UA server that mirrors all machine mappings as live readable variables. Any OPC UA client (UaExpert, Prosys, Ignition, your own app) can connect and read current PLC values in real-time. It also exposes an HTTP REST + SSE API consumed by the built-in OPC UA Explorer web page.

**Address space layout:**

```
Objects/
  <MachineName>/                    (FolderType — one per machine)
    <Category>/                     (FolderType — first segment of target_signal)
      <SignalName>                  (Variable — current live value from PLC)
```

**NodeId format:** `ns=2;s=<MachineName>.<Category>.<SignalName>`

**Example — machine "MACHINE-1", signal `Communication.HandshakeRealValues`:**
```
NodeId:   ns=2;s=MACHINE_1.Communication.HandshakeRealValues
Browse:   Objects → MACHINE_1 → Communication → HandshakeRealValues
Endpoint: opc.tcp://<host>:4840/UA/CTGate
```

**How it works:**

1. On startup, queries the backend for all machines and their mappings
2. Creates an OPC UA address space node for every mapped signal
3. Every `POLL_INTERVAL_MS` (default 5 s), reads current PLC values via the siemens-s7 / rockwell connectors
4. Evaluates mapping types (`direct`, `expression`, `lookup`) and updates node values
5. Automatically creates new nodes when mappings are added (without restarting)
6. **Automatically removes nodes when a machine is deleted** from the web UI (detected within one poll cycle)
7. Only polls machines with `status = 'connected'`

**Supported mapping types in OPC UA:**

| Mapping Type | Description |
|---|---|
| `direct` | Reads `source_address` from PLC and publishes the raw value |
| `expression` | Evaluates formula (e.g. `DB10.DBX4.0 AND DB10.DBD0 > 100`) and publishes result |
| `lookup` | Maps integer PLC value to string (e.g. `{1: "RUNNING", 2: "IDLE"}`) |

**HTTP REST + SSE API** (available via nginx at `/opcua-api/` or directly on port 4841 inside Docker):

| Endpoint | Description |
|----------|-------------|
| `GET /opcua-api/structure` | Full address space snapshot — all machines, signals, and current values |
| `GET /opcua-api/values?machine=<safeName>` | Current values snapshot for one machine |
| `GET /opcua-api/stream?machine=<safeName>` | SSE stream — pushes `snapshot` on connect, then `update` on every poll cycle. Used by the OPC UA Explorer page. Heartbeat every 30 s keeps the connection alive through proxies |
| `GET /opcua-api/healthz` | Returns `{"status":"ok","machines":<count>}` |

**Quick test via curl:**

```bash
# Health check
curl http://localhost:8080/opcua-api/healthz

# Full address space with current values
curl http://localhost:8080/opcua-api/structure | python3 -m json.tool

# Values for a specific machine (use the safeName — spaces replaced by _)
curl "http://localhost:8080/opcua-api/values?machine=MACHINE_1"

# Real-time SSE stream (Ctrl+C to stop)
curl -N "http://localhost:8080/opcua-api/stream?machine=MACHINE_1"
```

**Key file:**

| File | Purpose |
|------|---------|
| `src/index.js` | OPC UA server, address space builder, polling loop, PLC reader, HTTP REST+SSE API |

---

### PostgreSQL

**Image:** postgres:16-alpine
**Container port:** 5432
**Not exposed to host**
**Persistent volume:** `postgres_data`
**Credentials (default):** user=`ctgate`, password=`ctgate`, db=`ctgate`

Change the password before production deployment:

```yaml
# docker-compose.yml
services:
  postgres:
    environment:
      POSTGRES_PASSWORD: your-strong-password
  backend:
    environment:
      DATABASE_URL: postgresql://ctgate:your-strong-password@postgres:5432/ctgate
```

---

## Data Flow Diagram

```mermaid
sequenceDiagram
    actor User
    participant UI as Frontend (8080)
    participant API as Backend (3050)
    participant DB as PostgreSQL
    participant S7 as siemens-s7 (8300)
    participant OPC as siemens-opc (8301)
    participant RW as rockwell (8302)
    participant PLC as PLC (OT network)
    participant COL as Collector
    participant OPCUA as OPC UA Server (4840)
    participant MQTT as MQTT Broker

    Note over User,MQTT: Machine Registration & Signal Discovery

    User->>UI: Add machine (name, IP, type)
    UI->>API: POST /api/machines
    API->>DB: INSERT machines

    User->>UI: Click "Live Scan"
    UI->>API: POST /api/machines/:id/scan-live
    API-->>UI: {started: true}

    alt S7 Classic
        loop DB 1..100 (configurable)
            API->>S7: POST /scan {host, db, ...}
            S7->>PLC: RFC1006 read (port 102)
            PLC-->>S7: Raw bytes
            S7-->>API: {findings: [...]}
        end
    else OPC UA
        API->>OPC: GET /browse {endpoint}
        OPC->>PLC: OPC UA browse (port 4840)
        PLC-->>OPC: Node tree
        OPC-->>API: {children: [...]}
    else Rockwell
        API->>RW: GET /tags {ip, slot}
        RW->>PLC: EtherNet/IP (port 44818)
        PLC-->>RW: Tag list
        RW-->>API: {properties: {...}}
    end

    API->>DB: INSERT signals
    UI->>API: GET /api/machines/:id/scan-progress (polling 800ms)
    API-->>UI: {status, db, total, found}

    Note over User,MQTT: AI-Assisted Mapping (local Ollama)

    User->>UI: Click "AI Suggest"
    UI->>API: POST /api/mappings/:id/ai-suggest
    API-->>UI: {started: true}
    API->>API: Build cross-reference context + CTBase rules
    API->>API: Phase 1 — batch BOOL/INT/REAL → Ollama llama3.1:8b
    API->>API: Phase 2 — STRING lookup tables → Ollama
    API->>DB: INSERT mappings (with confidence score)
    UI->>API: GET /api/mappings/:id/ai-status (polling 3s)

    Note over COL,MQTT: Continuous Data Collection

    loop Every POLL_INTERVAL_MS
        COL->>API: GET /api/machines (connected)
        COL->>API: GET /api/mappings/:id
        COL->>S7: POST /read {tags: {...}}
        S7->>PLC: RFC1006 read
        PLC-->>S7: Values
        S7-->>COL: {values: {...}}
        COL->>COL: Evaluate expressions & lookups
        COL->>MQTT: Publish ctgate/<machine>/<signal>
    end

    Note over OPCUA,PLC: OPC UA Live Publishing

    loop Every POLL_INTERVAL_MS (default 5s)
        OPCUA->>API: GET /api/machines + /api/mappings/:id
        OPCUA->>S7: POST /read {tags: {...}}
        S7->>PLC: RFC1006 read
        PLC-->>S7: Values
        S7-->>OPCUA: {values: {...}}
        OPCUA->>OPCUA: Update ns=2;s=<Machine>.<Signal> nodes
    end
```

---

## API Endpoints

### Machines

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/machines` | List all machines |
| GET | `/api/machines/:id` | Get single machine |
| POST | `/api/machines` | Create machine |
| PUT | `/api/machines/:id` | Update machine |
| DELETE | `/api/machines/:id` | Delete machine (cascades) |
| POST | `/api/machines/:id/upload` | Upload project file (.zap/.s7p/.L5X) |
| POST | `/api/machines/:id/scan-live` | Trigger background live scan. Body: `{startDb?, endDb?}` |
| GET | `/api/machines/:id/scan-progress` | Poll live scan progress |

### Signals

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/signals/machine/:id` | List signals for a machine |
| GET | `/api/signals/machine/:id/networks` | List network comments for a machine |

### Mappings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mappings/machine/:id` | Get all mappings for a machine |
| PUT | `/api/mappings/machine/:id` | Batch replace mappings |
| POST | `/api/mappings/machine/:id/ai-suggest` | Trigger AI mapping job |
| GET | `/api/mappings/machine/:id/ai-status` | Poll AI job progress |

### Data Model

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/datamodel` | Get current data model + signals |
| PUT | `/api/datamodel` | Update data model signals |

### Health

| Method | Path | Service |
|--------|------|---------|
| GET | `/healthz` | backend, siemens-s7, siemens-opc, rockwell |

---

## Supported PLC Types & Project Files

| PLC Family | Connector Used | Live Scan | Project File Format |
|-----------|---------------|-----------|---------------------|
| S7-300 | siemens-s7 (RFC1006) | ✓ (heuristic DB scan) | .s7p / .zip (Step7 V5) |
| S7-400 | siemens-s7 (RFC1006) | ✓ (heuristic DB scan) | .s7p / .zip (Step7 V5) |
| S7-1200 (Classic) | siemens-s7 (RFC1006) | ✓ (heuristic DB scan) | .zap (TIA Portal V13+) |
| S7-1200 (OPC UA) | siemens-opc (OPC UA) | ✓ (symbolic browse) | .zap (TIA Portal V13+) |
| S7-1500 | siemens-opc (OPC UA) | ✓ (symbolic browse) | .zap (TIA Portal V13+) |
| Rockwell CompactLogix | rockwell (EtherNet/IP) | ✓ (tag list) | .L5X (Studio 5000) |
| Rockwell ControlLogix | rockwell (EtherNet/IP) | ✓ (tag list) | .L5X (Studio 5000) |

**TIA Portal version compatibility:**

| TIA Portal Version | File Extension | Parser Status |
|-------------------|---------------|---------------|
| V13 – V16 | .zap13 – .zap16 | ✓ Full XML support |
| V17 – V20 | .zap17 – .zap20 | ⚠ Requires XML export from TIA Portal (binary .plf not supported) |

---

## AI Mapping

CT-Gate uses **local AI only** — no internet connection, no cloud API keys, no data leaves the network. AI mapping is powered by [Ollama](https://ollama.ai) running `llama3.1:8b` by default.

### How it Works

The AI mapper runs in two phases:

| Phase | Target Signals | Batch Size | Description |
|-------|---------------|------------|-------------|
| Phase 1 | `BOOL`, `INT`, `REAL`, `DINT`, `WORD` | 5 signals/batch | Direct address or expression mapping |
| Phase 2 | `STRING` | 5 signals/batch | Builds lookup table from Phase 1 results (e.g. `{1: "RUNNING", 2: "IDLE"}`) |

Each batch prompt includes:
- **CTBase rules** — 100+ German-language CTBase signal type specifications injected as system context
- **Cross-reference context** — per-signal dependency tree showing which PLC addresses feed which outputs (built from network comments, FB interfaces, and MC7 bytecode logic chains)
- **Confidence score** — each AI suggestion includes a 0–100% confidence value; the UI lets you filter by minimum confidence (default 85%)

### Setup

```bash
# 1. Install Ollama on the host or a reachable server
# https://ollama.ai

# 2. Pull the model
ollama pull llama3.1:8b

# 3. Set the Ollama URL in .env (if not localhost)
OLLAMA_BASE_URL=http://192.168.1.50:11434
```

The backend defaults to `AI_PROVIDER=ollama`. No other configuration is needed.

### Optional Cloud AI (not recommended for production)

Cloud providers can be used for testing but are **not recommended** for OT environments (data leaves the network):

| Provider | `AI_PROVIDER` value | Env Var | Model |
|----------|---------------------|---------|-------|
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` (configurable via `ANTHROPIC_MODEL`) |

Set `AI_PROVIDER=openai` or `AI_PROVIDER=anthropic` in `.env` to activate.

> Cloud providers use a larger batch size (20 signals/batch vs 5 for Ollama) but are rate-limited between batches.

---

## Debugging Guide

### Container won't start

```bash
# Check all container states
docker compose ps

# View logs for a specific service
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f siemens-s7
```

### Web UI returns 502 Bad Gateway

The nginx container started before the backend was ready.

```bash
docker compose restart frontend
# Wait 5 seconds then retry the browser
```

### Database tables don't exist / "relation does not exist"

The migration was never run.

```bash
docker compose exec backend node src/db/migrate.js
```

### Collector shows `getaddrinfo ENOTFOUND backend`

Docker DNS resolved the backend name before it was ready. Restart the collector:

```bash
docker compose restart collector
```

### Live Scan immediately fails / returns error

1. **Verify the connector is running:**
   ```bash
   curl http://localhost:8300/healthz   # S7
   curl http://localhost:8301/healthz   # OPC UA
   curl http://localhost:8302/healthz   # Rockwell
   ```

2. **Check the PLC is reachable from the container:**
   ```bash
   docker compose exec siemens-s7 ping 192.168.1.10
   ```

3. **Firewall:** Ensure port 102 (S7), 4840 (OPC UA), or 44818 (Rockwell) is open on the PLC firewall toward the Docker host or Kubernetes node.

4. **View connector logs:**
   ```bash
   docker compose logs -f siemens-s7
   ```

### AI Suggest returns "No AI provider configured" or times out

Ollama must be running and the model must be pulled:

```bash
# Check Ollama is reachable from the backend container
docker compose exec backend curl http://<ollama-host>:11434/api/tags

# Pull the model if missing
ollama pull llama3.1:8b

# Verify OLLAMA_BASE_URL in .env matches the actual host
# Then restart the backend
docker compose up -d backend
```

### OPC UA Server shows no nodes

1. Verify the server is running:
   ```bash
   docker compose logs -f opcua-server
   ```
2. Check that machines have mappings — the OPC UA server only creates nodes for signals that have at least one active mapping.
3. Verify the backend is reachable from the opcua-server container:
   ```bash
   docker compose exec opcua-server wget -qO- http://backend:3050/api/machines
   ```

### OPC UA Explorer page shows values as `null`

This is usually caused by the siemens-s7 connector's internal request queue getting into a bad state (e.g. after a PLC connection error during scanning). Restart the connector to reset the queue:

```bash
docker compose restart siemens-s7
```

To verify the connector can read the PLC before restarting the full stack:
```bash
# Test a direct read — replace address and PLC parameters as needed
docker compose exec siemens-s7 node -e "
const http = require('http');
const body = JSON.stringify({host:'192.168.0.10',rack:0,slot:2,tags:{test:'DB2,INT10'}});
const req = http.request({hostname:'localhost',port:8300,path:'/read',method:'POST',
  headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},
  (res)=>{ let d=''; res.on('data',c=>d+=c); res.on('end',()=>console.log(res.statusCode, d)); });
req.write(body); req.end();
"
```

Expected response: `200 {"values":{"test":452}}`

### Deleted machine still visible in OPC UA address space

The OPC UA server syncs with the backend on every poll cycle (default 5 s). If a machine was just deleted from the web UI, wait up to one poll interval and it will be removed automatically. If it persists, restart the opcua-server:

```bash
docker compose restart opcua-server
```

### Backend crashes on project file upload

1. Check file size — limit is 500 MB:
   ```bash
   docker compose logs backend | tail -30
   ```

2. Check for XML parsing errors (common with TIA Portal V17+ binary format):
   ```bash
   docker compose logs backend | grep "parseProjectFile"
   ```
   If you see "binary PEData.plf", export the project as XML from TIA Portal before uploading.

### Collector not publishing to MQTT

1. Verify broker is reachable:
   ```bash
   docker compose exec collector nc -zv mqtt-broker-host 1883
   ```

2. Ensure `MQTT_BROKER` is set in `.env` (leave empty to fall back to stdout):
   ```bash
   docker compose logs collector | head -20
   ```

### Check all internal service URLs

Inside Docker Compose, services communicate by name on the default bridge network:

```
backend      → postgres:5432
backend      → siemens-s7:8300
backend      → siemens-opc:8301
backend      → rockwell:8302
collector    → backend:3050
opcua-server → backend:3050
opcua-server → siemens-s7:8300
opcua-server → rockwell:8302
frontend     → backend:3050  (via nginx proxy_pass)
```

Verify resolution:
```bash
docker compose exec backend curl http://siemens-s7:8300/healthz
docker compose exec backend curl http://siemens-opc:8301/healthz
docker compose exec backend curl http://rockwell:8302/healthz
docker compose exec opcua-server curl http://backend:3050/healthz
```

### View the PostgreSQL data directly

```bash
docker compose exec postgres psql -U ctgate -d ctgate

-- Useful queries:
SELECT id, name, plc_type, status FROM machines;
SELECT address, name, data_type, live_confirmed FROM signals WHERE machine_id = '<id>';
SELECT target_signal, mapping_type, source_address, confidence FROM mappings WHERE machine_id = '<id>';
```

### Reset everything (destructive)

```bash
docker compose down -v   # removes containers AND named volumes (including DB data)
docker compose up -d --build
docker compose exec backend node src/db/migrate.js
```

---

## Dependency License Audit

### Open Source Dependencies

All runtime and build dependencies are open-source and permissively licensed.

#### Backend (`apps/backend`)

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| express | ^4.19.2 | MIT | HTTP framework / REST API |
| pg | ^8.12.0 | MIT | PostgreSQL client |
| cors | ^2.8.5 | MIT | CORS middleware |
| morgan | ^1.10.0 | MIT | HTTP request logging |
| multer | ^1.4.5-lts.1 | MIT | Multipart file upload handling |
| adm-zip | ^0.5.10 | MIT | ZIP / .zap project file extraction |
| fast-xml-parser | ^4.3.6 | MIT | XML parsing for TIA Portal / L5X files |
| expr-eval | ^2.0.2 | MIT | Safe mathematical expression evaluator |
| uuid | ^9.0.1 | MIT | UUID generation for primary keys |
| dotenv | ^16.4.7 | BSD-2-Clause | Environment variable loading |

#### Frontend (`apps/frontend`)

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| react | ^18.3.1 | MIT | UI framework |
| react-dom | ^18.3.1 | MIT | React DOM renderer |
| react-i18next | ^15.1.3 | MIT | React internationalization bindings |
| i18next | ^23.16.8 | MIT | i18n core library |
| @fontsource/inter | ^5.1.0 | OFL-1.1 | Inter typeface (self-hosted) |
| vite | ^6.0.0 | MIT | Build tool / dev server |
| @vitejs/plugin-react | ^4.3.1 | MIT | Vite React plugin (Babel/SWC) |
| tailwindcss | ^3.4.16 | MIT | Utility-first CSS framework |
| postcss | ^8.4.47 | MIT | CSS transformation pipeline |
| autoprefixer | ^10.4.20 | MIT | CSS vendor prefix automation |

#### Collector (`apps/collector`)

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| dotenv | ^16.4.7 | BSD-2-Clause | Environment variable loading |
| expr-eval | ^2.0.2 | MIT | Expression evaluation for mappings |

#### Connector — Siemens S7 (`apps/connectors/siemens-s7`)

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| express | ^4.19.2 | MIT | HTTP server |
| nodes7 | ^0.3.18 | MIT | S7 Classic communication (RFC1006 / ISO-TCP) |

#### Connector — Siemens OPC UA (`apps/connectors/siemens-opc`)

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| express | ^4.19.2 | MIT | HTTP server |
| node-opcua | ^2.119.0 | MIT | OPC UA client/server implementation |

> **Note:** `node-opcua` requires native build tools (`python3`, `make`, `g++`) during the Docker build due to its native binding modules. This is handled automatically in `Dockerfile.siemens-opc` and `Dockerfile.opcua`.

#### OPC UA Server (`apps/opcua-server`)

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| dotenv | ^16.4.5 | BSD-2-Clause | Environment variable loading |
| express | ^4.19.2 | MIT | HTTP server for REST + SSE Explorer API |
| node-opcua | ^2.118.0 | MIT | OPC UA server + address space management |

> **Note on mc7-decoder.js:** The MC7 bytecode decoder (`apps/backend/src/services/mc7-decoder.js`) is a JavaScript port of [rz-libmc7](https://github.com/rizinorg/rizin) by deroad, licensed under **LGPL-3.0**. It is used server-side only (not distributed in the frontend bundle) and is dynamically linked as a CommonJS module — this is compatible with LGPL usage terms for non-derivative server-side use.

#### Connector — Rockwell (`apps/connectors/rockwell`)

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| express | ^4.19.2 | MIT | HTTP server |
| st-ethernet-ip | ^2.7.5 | MIT | EtherNet/IP / CIP protocol implementation |

#### Infrastructure

| Component | Version | License | Purpose |
|-----------|---------|---------|---------|
| Node.js | 20 (Alpine) | MIT | Container runtime |
| nginx | 1.27 (Alpine) | BSD-2-Clause | Static file server + reverse proxy |
| PostgreSQL | 16 (Alpine) | PostgreSQL License (similar to MIT/BSD) | Database |
| Docker | ≥ 24 | Apache 2.0 | Container runtime |
| Kubernetes | ≥ 1.28 | Apache 2.0 | Container orchestration |
| Helm | ≥ 3.14 | Apache 2.0 | Kubernetes package manager |

---

### AI — Local vs Cloud

CT-Gate defaults to **fully local AI** with no external services required.

| AI Option | Provider | License | Cost | Required? | Recommended? |
|-----------|----------|---------|------|-----------|--------------|
| Ollama + llama3.1:8b | Meta / Ollama | Apache 2.0 / MIT | Free | ❌ Optional | ✅ **Yes — default** |
| Claude API | Anthropic | Commercial | Pay-per-token | ❌ Optional | ⚠ Testing only |
| OpenAI API | OpenAI | Commercial | Pay-per-token | ❌ Optional | ⚠ Testing only |

The default `AI_PROVIDER=ollama` setting means **no data ever leaves your network** — suitable for air-gapped OT environments and industrial security policies.

```bash
# Default local setup — no keys needed
ollama pull llama3.1:8b
# .env: OLLAMA_BASE_URL=http://<ollama-host>:11434

# Optional cloud fallback (testing only — data leaves the network)
# .env: AI_PROVIDER=anthropic   ANTHROPIC_API_KEY=sk-ant-...
# .env: AI_PROVIDER=openai      OPENAI_API_KEY=sk-...
```

---

### License Summary

| License Type | Packages |
|-------------|---------|
| **MIT** | express, react, vite, tailwindcss, pg, nodes7, node-opcua, st-ethernet-ip, multer, adm-zip, fast-xml-parser, expr-eval, uuid, cors, morgan, react-i18next, i18next, node:20-alpine, Kubernetes, Helm |
| **BSD-2-Clause** | dotenv, nginx |
| **OFL-1.1** (Open Font License) | Inter typeface — allows free use, modification, redistribution including in products |
| **PostgreSQL License** | PostgreSQL — permissive, functionally equivalent to MIT |
| **Apache 2.0** | Docker, Kubernetes, Helm, ArgoCD, Ollama, llama3.1 (Meta) |
| **LGPL-3.0** | mc7-decoder.js — server-side use only; no LGPL obligations imposed on CT-Gate's proprietary code |

**All dependencies are free to use in commercial and proprietary products.** The sole LGPL-3.0 component (`mc7-decoder.js`) is used server-side as a dynamically-loaded module, which satisfies LGPL requirements without imposing copyleft on the surrounding codebase.
