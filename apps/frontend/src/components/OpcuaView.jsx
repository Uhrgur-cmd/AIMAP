/**
 * OPC UA Explorer
 *
 * Shows the full CT-Gate OPC UA address space as an interactive tree.
 * Values update in real-time via SSE — but ONLY for expanded machines,
 * so the connection is lightweight regardless of how many machines exist.
 *
 * Smart subscription logic:
 *  - Expand a machine  → open SSE stream for that machine only
 *  - Collapse machine  → close SSE stream
 *  - Leave page        → close all SSE streams
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── helpers ──────────────────────────────────────────────────

function formatValue(value) {
  if (value === null || value === undefined) return { text: '—', cls: 'text-gray-500' };
  if (typeof value === 'boolean') {
    return value
      ? { text: 'TRUE',  cls: 'text-emerald-600' }
      : { text: 'FALSE', cls: 'text-red-400' };
  }
  if (typeof value === 'number') {
    const s = Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.?0+$/, '');
    return { text: s, cls: 'text-signal-blue' };
  }
  return { text: String(value), cls: 'text-gray-500' };
}

function groupByCategory(signals) {
  const cats = {};
  for (const sig of signals) {
    const dot = sig.name.indexOf('.');
    const cat = dot > -1 ? sig.name.slice(0, dot) : '_ungrouped_';
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(sig);
  }
  return cats;
}

// ─── sub-components ───────────────────────────────────────────

function CopyButton({ text }) {
  const [state, setState] = useState('idle'); // idle | copied

  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setState('copied');
      setTimeout(() => setState('idle'), 2000);
    });
  }

  return (
    <button
      onClick={copy}
      title={text}
      className={`flex-shrink-0 font-mono text-[10px] px-2 py-0.5 rounded border transition-all duration-150 ${
        state === 'copied'
          ? 'text-emerald-600 border-green-700/60 bg-emerald-50'
          : 'text-gray-500 border-gray-300 bg-gray-50/60 hover:text-signal-blue hover:border-signal-blue/40 opacity-0 group-hover:opacity-100'
      }`}
    >
      {state === 'copied' ? '✓ copied' : 'copy NodeId'}
    </button>
  );
}

function SignalRow({ sig, value }) {
  const { text: valText, cls: valCls } = formatValue(value);
  const leafName = sig.name.includes('.') ? sig.name.slice(sig.name.indexOf('.') + 1) : sig.name;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded border border-gray-200/40 hover:border-gray-300/60 bg-white/60 group">
      {/* signal name */}
      <span className="flex-1 min-w-0 text-xs text-gray-900 truncate" title={sig.name}>{leafName}</span>

      {/* live value chip */}
      <span className={`flex-shrink-0 text-xs font-mono w-24 text-right tabular-nums ${valCls}`}>
        {valText}
      </span>

      {/* NodeId copy */}
      <CopyButton text={sig.nodeId} />
    </div>
  );
}

function CategoryBlock({ category, signals, liveValues, machineId }) {
  const [open, setOpen] = useState(true); // categories open by default

  return (
    <div className="mb-0.5">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 rounded bg-gray-50/40 hover:bg-gray-50/70 border border-gray-200/60 text-left select-none"
      >
        <span className="text-gray-500 font-mono text-[10px] w-3 flex-shrink-0">
          {open ? '▼' : '▶'}
        </span>
        <span className="text-signal-blue text-xs font-semibold">
          {category === '_ungrouped_' ? '(ungrouped)' : category}
        </span>
        <span className="ml-auto text-[10px] text-gray-500">{signals.length}</span>
      </button>

      {open && (
        <div className="ml-4 mt-0.5 space-y-0.5">
          {signals.map(sig => (
            <SignalRow
              key={sig.nodeId}
              sig={sig}
              value={liveValues[sig.nodeId]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── main component ───────────────────────────────────────────

export default function OpcuaView({ onBack }) {
  const [structure, setStructure]         = useState([]);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [expandedMachines, setExpanded]   = useState(new Set());
  const [liveValues, setLiveValues]       = useState({});  // nodeId → value
  const [streamStatus, setStreamStatus]   = useState({}); // machineId → 'connecting'|'live'|'error'
  const eventSources                      = useRef({});    // machineId → EventSource

  // ── load structure on mount (and refresh every 5s for status/signal changes) ──
  useEffect(() => {
    function fetchStructure() {
      fetch('/opcua-api/structure')
        .then(r => r.json())
        .then(data => {
          setStructure(data);
          setLoading(false);
          // Pre-populate liveValues from whatever the server already has in cache
          setLiveValues(prev => {
            const next = { ...prev };
            for (const machine of data) {
              for (const sig of machine.signals) {
                if (sig.value !== null && sig.value !== undefined) next[sig.nodeId] = sig.value;
              }
            }
            return next;
          });
        })
        .catch(err => { setError(err.message); setLoading(false); });
    }

    fetchStructure();
    const timer = setInterval(fetchStructure, 5000);

    // close all streams on unmount
    return () => {
      clearInterval(timer);
      Object.values(eventSources.current).forEach(es => es.close());
    };
  }, []);

  // ── open SSE stream for a machine ──
  const openStream = useCallback((machine) => {
    if (eventSources.current[machine.id]) return;
    // Don't open a stream for machines that are not online — avoids zombie connections
    if (machine.status !== 'connected') return;

    // Fetch current values immediately via REST (don't wait for first SSE message)
    fetch(`/opcua-api/values?machine=${encodeURIComponent(machine.safeName)}`)
      .then(r => r.json())
      .then(data => {
        if (data.signals) {
          setLiveValues(prev => {
            const next = { ...prev };
            for (const sig of data.signals) {
              if (sig.value !== null && sig.value !== undefined) next[sig.nodeId] = sig.value;
            }
            return next;
          });
        }
      })
      .catch(() => {});

    setStreamStatus(s => ({ ...s, [machine.id]: 'connecting' }));

    const es = new EventSource(`/opcua-api/stream?machine=${encodeURIComponent(machine.safeName)}`);

    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot' || data.type === 'update') {
        setLiveValues(prev => {
          const next = { ...prev };
          for (const sig of data.signals) {
            if (sig.value !== null && sig.value !== undefined) next[sig.nodeId] = sig.value;
          }
          return next;
        });
        setStreamStatus(s => ({ ...s, [machine.id]: 'live' }));
      }
    };

    es.onerror = () => {
      setStreamStatus(s => ({ ...s, [machine.id]: 'error' }));
    };

    eventSources.current[machine.id] = es;
  }, []);

  // ── close SSE stream for a machine ──
  const closeStream = useCallback((machineId) => {
    eventSources.current[machineId]?.close();
    delete eventSources.current[machineId];
    setStreamStatus(s => { const n = { ...s }; delete n[machineId]; return n; });
  }, []);

  // ── toggle machine expand ──
  function toggleMachine(machine) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(machine.id)) {
        next.delete(machine.id);
        closeStream(machine.id);
      } else {
        next.add(machine.id);
        openStream(machine);
      }
      return next;
    });
  }

  const liveCount = Object.keys(eventSources.current).length;

  // ─── render ───────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-white text-gray-900">

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-5 py-3 bg-[#2A2A36] border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-4">
          <img src="/ct-gate-logo.svg" alt="CT Gate" className="h-9" onError={e => { e.target.style.display='none'; }} />
          <div>
            <h1 className="text-sm font-bold text-white tracking-wide">OPC UA Explorer</h1>
            <p className="text-[10px] text-white/40 font-mono mt-0.5">
              opc.tcp://&lt;host&gt;:4840/UA/CTGate &nbsp;·&nbsp; NodeId: ns=2;s=&lt;Machine&gt;.&lt;Category&gt;.&lt;Signal&gt;
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {liveCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
              {liveCount} live stream{liveCount > 1 ? 's' : ''}
            </span>
          )}
          <span className="text-xs text-white/50">
            {structure.length} machine{structure.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={onBack}
            className="text-xs bg-white/10 hover:bg-white/20 text-white/80 px-3 py-1.5 rounded border border-white/20 hover:border-white/30 transition-colors"
          >
            ← Back
          </button>
        </div>
      </div>

      {/* ── Tree body ── */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">

        {loading && (
          <div className="text-center py-16 text-gray-500 text-sm">Loading address space...</div>
        )}

        {error && (
          <div className="text-center py-16 text-red-400 text-sm">
            <p>Could not load OPC UA structure.</p>
            <p className="text-xs mt-2 text-gray-500">{error}</p>
            <p className="text-xs mt-1 text-gray-500">Make sure the opcua-server container is running.</p>
          </div>
        )}

        {!loading && !error && structure.length === 0 && (
          <div className="text-center py-16 text-gray-500 text-sm">
            <p>No OPC UA nodes available.</p>
            <p className="text-xs mt-2 text-gray-500">Add machines and configure mappings to populate the address space.</p>
          </div>
        )}

        {structure.map(machine => {
          const isExpanded  = expandedMachines.has(machine.id);
          const status      = streamStatus[machine.id];
          const categories  = groupByCategory(machine.signals);

          return (
            <div key={machine.id} className="rounded-lg overflow-hidden border border-gray-200">

              {/* ── Machine header ── */}
              <button
                onClick={() => toggleMachine(machine)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left select-none transition-colors ${
                  isExpanded
                    ? 'bg-gray-50 hover:bg-gray-100/80'
                    : 'bg-white hover:bg-gray-50/70'
                }`}
              >
                {/* expand arrow */}
                <span className="text-signal-blue text-xs w-3 flex-shrink-0">
                  {isExpanded ? '▼' : '▶'}
                </span>

                {/* connection status dot */}
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  machine.status === 'connected'    ? 'bg-green-400' :
                  machine.status === 'connecting'   ? 'bg-yellow-400 animate-pulse' :
                  machine.status === 'disconnected' ? 'bg-red-400' :
                  machine.status === 'error'        ? 'bg-red-400' : 'bg-gray-400'
                }`} />

                {/* machine name */}
                <span className="font-semibold text-sm text-gray-900">{machine.name}</span>

                {/* safe name (NodeId hint) */}
                <span className="text-[10px] text-gray-500 font-mono">{machine.nodeId}</span>

                {/* right side */}
                <div className="ml-auto flex items-center gap-3">
                  {status === 'connecting' && (
                    <span className="text-[10px] text-gray-500 animate-pulse">connecting…</span>
                  )}
                  {status === 'live' && (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-600">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      live
                    </span>
                  )}
                  {status === 'error' && (
                    <span className="text-[10px] text-red-400">stream error</span>
                  )}
                  <span className="text-[10px] text-gray-500">
                    {machine.signals.length} signal{machine.signals.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </button>

              {/* ── Expanded: categories + signals ── */}
              {isExpanded && (
                <div className="p-3 bg-white/50 border-t border-gray-200/60 space-y-1">
                  {machine.signals.length === 0 ? (
                    <p className="text-xs text-gray-500 text-center py-4">
                      No mappings configured for this machine.
                    </p>
                  ) : (
                    Object.entries(categories).map(([cat, sigs]) => (
                      <CategoryBlock
                        key={cat}
                        category={cat}
                        signals={sigs}
                        liveValues={liveValues}
                        machineId={machine.id}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Footer info bar ── */}
      <div className="flex-shrink-0 px-5 py-2 bg-white border-t border-gray-200 flex items-center justify-between">
        <span className="text-[10px] text-gray-500">
          Expand a machine to start live streaming · Collapse or leave page to stop
        </span>
        <span className="text-[10px] text-gray-500 font-mono">
          Refresh interval: {(parseInt(5000) / 1000).toFixed(0)}s
        </span>
      </div>
    </div>
  );
}
