# AIMAP – Setup & Development Guide

## What is this?

AIMAP is a PLC Signal Mapping Platform. It extracts signals from PLC project files (Step7, TIA Portal, Rockwell) and helps map them to a standard data model (CTBase Companion Specification) using AI assistance.

## Architecture

```
Frontend (React)  →  Backend (Node.js/Express)  →  PostgreSQL
     :5173              :3000                        :5432
                           ↓
                    Project Parser (parses .s7p/.zap/.L5X files)
                           ↓
                    AI Mapper (Ollama local / OpenAI / Anthropic)
                           ↓
                    PLC Connectors (existing ct-plc-connectors)
                      :8100 Rockwell | :8200 OPC UA | :8300 S7
```

## Prerequisites

- Node.js 20+
- Docker (for PostgreSQL)
- Ollama (for local AI mapping) OR OpenAI/Anthropic API key

## Quick Start (Local Development)

### 1. Start PostgreSQL

```bash
docker run -d --name aimap-postgres \
  -e POSTGRES_USER=aimap \
  -e POSTGRES_PASSWORD=aimap \
  -e POSTGRES_DB=aimap \
  -p 5432:5432 \
  postgres:16-alpine
```

### 2. Setup Backend

```bash
cd backend
cp .env.example .env        # Edit .env if needed
npm install
npm run migrate              # Creates database tables + default data model
npm run dev                  # Starts on http://localhost:3000
```

Backend health check: `curl http://localhost:3000/healthz`

### 3. Setup Frontend

```bash
cd frontend
npm install
npm run dev                  # Starts on http://localhost:5173
```

Open http://localhost:5173 in your browser.

### 4. Setup Ollama (for local AI mapping)

```bash
# Install Ollama
brew install ollama          # macOS
# OR: curl -fsSL https://ollama.com/install.sh | sh   # Linux

# Start and pull model
ollama serve &
ollama pull llama3.1:8b      # ~4.7GB download, then fully offline
```

**Note:** Llama 3.1 8B is the minimum. For better results use a cloud API (see AI Configuration below).

## AI Configuration

Edit `backend/.env` and set `AI_PROVIDER`:

### Option 1: Local Ollama (free, offline, but lower quality)
```
AI_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
```

### Option 2: OpenAI (best results, requires API key)
```
AI_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-5.4-mini
```
Cost: ~$2-10 per machine mapping (depending on signal count).

### Option 3: Anthropic Claude (requires API key + credits)
```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```
Note: Anthropic Evaluation plan has 30K tokens/min rate limit which is too low for large projects. Need Tier 2+ or Build plan.

## How It Works

### 1. Add a Machine
- Click "+ Add" in the sidebar
- Select PLC type (S7-300/400/1200/1500/Rockwell)
- Enter IP address
- For S7-300/400: Upload the .s7p or .zip project file
- For S7-1200/1500/Rockwell: Signals are scanned live via connectors

### 2. Project File Parser
The parser extracts signals from PLC project files:

**Step7 V5 (.s7p / .zip):**
- Reads SYMLIST.DBF (symbol table with I/Q/M/T signals + comments)
- Reads SUBBLK.DBF/DBT (DB variables, FB/FC interfaces, network comments)
- Extracts from dBASE binary format – no Step7 installation needed

**TIA Portal (.zap):**
- All TIA versions store blocks in binary PEData.plf
- Direct .zap parsing not possible – user must export blocks as XML from TIA
- Error message with instructions shown when .zap is uploaded

**Rockwell (.L5X):**
- Parses Studio 5000 XML export
- Extracts controller tags, program tags, UDTs, rung comments

### 3. Standard Data Model (CTBase)
The CTBase Companion Specification is pre-loaded with ~179 target signals:
- Communication (Heartbeat, Handshake)
- Machine (State, Mode, OperationDetails)
- Production (CycleIsRunning, Counters)
- JobInformation (JobName, PartsCounter)
- Recipes, User, IdTransfer, ToolsBatches
- Energy (Electrical, Water, CompressedAir, Steam, etc.)

### 4. AI Mapping
Click "AI Suggest" to let the AI try to map PLC signals to the standard model.
- The AI sees ALL extracted signals + ALL network comments
- For each target signal, it searches for the best matching PLC signal
- Results appear live in the UI with confidence scores
- User must verify and correct the suggestions

### 5. Manual Mapping
- Drag & drop signals from left panel to right panel
- Or click "build expression" for complex mappings (AND/OR/comparisons)
- Edit existing mappings by clicking "edit"

## Project Structure

```
AIMAP/
├── backend/
│   ├── src/
│   │   ├── index.js              # Express server entry point
│   │   ├── db/
│   │   │   ├── pool.js           # PostgreSQL connection pool
│   │   │   └── migrate.js        # Database schema + default data
│   │   ├── routes/
│   │   │   ├── machines.js       # Machine CRUD + file upload
│   │   │   ├── signals.js        # Signal queries
│   │   │   ├── datamodel.js      # Standard data model CRUD
│   │   │   └── mappings.js       # Mapping CRUD + AI suggest endpoint
│   │   └── services/
│   │       ├── project-parser.js # Step7/TIA/Rockwell file parser
│   │       ├── ai-mapper.js      # AI mapping (Ollama/OpenAI/Anthropic)
│   │       ├── live-scanner.js   # Live PLC scanning via connectors
│   │       └── expression-engine.js # Safe expression evaluator
│   ├── uploads/                  # Uploaded project files
│   ├── .env                      # Environment configuration
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx               # Main application
│   │   ├── components/
│   │   │   ├── Sidebar.jsx       # Machine list sidebar
│   │   │   ├── MappingView.jsx   # Main mapping UI (split panel)
│   │   │   ├── AddMachineModal.jsx # Add/Edit machine dialog
│   │   │   ├── DataModelEditor.jsx # Standard data model editor
│   │   │   └── ExpressionBuilder.jsx # Expression builder for mappings
│   │   └── utils/
│   │       └── api.js            # API client
│   └── package.json
├── collector/                    # Continuous PLC reader service
│   └── src/index.js
├── connectors/                   # Existing ct-plc-connectors (unchanged)
│   └── apps/
│       ├── rockwell-connector/   # EtherNet/IP :8100
│       ├── siemens-browser/      # OPC UA :8200
│       └── siemens-connector/    # S7 RFC1006 :8300
├── docker/
│   ├── docker-compose.yml        # Full stack with Docker
│   ├── Dockerfile.backend
│   ├── Dockerfile.frontend
│   ├── Dockerfile.collector
│   └── nginx.conf
└── helm/
    └── aimap/                    # Kubernetes Helm chart
        ├── Chart.yaml
        ├── values.yaml
        └── templates/
```

## Docker Compose (Full Stack)

To run everything at once:

```bash
cd docker
docker compose up --build
```

This starts: PostgreSQL, Backend, Frontend, Collector, Ollama, and all PLC connectors.

- Frontend: http://localhost:8080
- Backend API: http://localhost:3000
- Ollama: http://localhost:11434

After first start, pull the AI model:
```bash
docker compose exec ollama ollama pull llama3.1:8b
```

## Kubernetes (Edge Deployment)

```bash
cd helm/aimap
helm install aimap . -n maen-ct-gate
```

See `helm/aimap/values.yaml` for configuration.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Health check |
| GET | `/api/machines` | List all machines |
| POST | `/api/machines` | Add machine |
| PUT | `/api/machines/:id` | Update machine |
| DELETE | `/api/machines/:id` | Delete machine |
| POST | `/api/machines/:id/upload` | Upload project file |
| POST | `/api/machines/:id/scan-live` | Trigger live PLC scan |
| GET | `/api/signals/machine/:id` | Get signals for machine |
| GET | `/api/datamodel` | Get standard data model |
| PUT | `/api/datamodel` | Update standard data model |
| GET | `/api/mappings/machine/:id` | Get mappings for machine |
| PUT | `/api/mappings/machine/:id` | Save mappings |
| POST | `/api/mappings/machine/:id/ai-suggest` | Start AI mapping |
| GET | `/api/mappings/machine/:id/ai-status` | Poll AI mapping progress |

## Known Limitations

- **TIA Portal .zap files**: Cannot be parsed directly (binary PEData.plf format). User must export blocks as XML from TIA Portal.
- **Step7 network comments**: Only partially available from binary SUBBLK.DBT. Not all FBs/FCs have parseable source text.
- **AI Mapping quality**: Depends heavily on the model used. Local Ollama 8B produces poor results. OpenAI GPT-5.4-mini or larger is recommended for production use.
- **AI Mapping for complex expressions**: The AI can suggest simple direct mappings well, but complex expressions (AND/OR combinations) require human verification.
