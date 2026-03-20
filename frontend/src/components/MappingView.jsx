import React, { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';
import ExpressionBuilder from './ExpressionBuilder';

export default function MappingView({ machine, onRefresh, dataModelVersion }) {
  const [signals, setSignals] = useState([]);
  const [dataModel, setDataModel] = useState({ signals: [] });
  const [mappings, setMappings] = useState([]);
  const [filter, setFilter] = useState('');
  const [editingTarget, setEditingTarget] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [aiProgress, setAiProgress] = useState(null); // { status, progress, total, mapped, currentGroup }
  const [minConfidence, setMinConfidence] = useState(85); // Minimum confidence % to show
  const fileInputRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => {
    if (machine) {
      loadSignals();
      loadMappings();
    }
  }, [machine?.id, machine?._refreshKey, machine?.project_last_parsed]);

  useEffect(() => { loadDataModel(); }, [dataModelVersion]);

  async function loadSignals() {
    try {
      const data = await api.get(`/api/signals/machine/${machine.id}`);
      setSignals(data);
    } catch (err) { console.error(err); }
  }

  async function loadDataModel() {
    try {
      const data = await api.get('/api/datamodel');
      setDataModel(data);
    } catch (err) { console.error(err); }
  }

  async function loadMappings() {
    try {
      const data = await api.get(`/api/mappings/machine/${machine.id}`);
      setMappings(data);
    } catch (err) { console.error(err); }
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await api.upload(`/api/machines/${machine.id}/upload`, file);
      alert(`Parsed: ${result.total_signals} signals from ${result.blocks} blocks, ${result.networks} networks`);
      await loadSignals();
    } catch (err) {
      alert('Upload failed: ' + err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleScanLive() {
    setScanning(true);
    try {
      const result = await api.post(`/api/machines/${machine.id}/scan-live`);
      alert(`Live scan found ${result.signals} signals`);
      await loadSignals();
      onRefresh?.();
    } catch (err) {
      alert('Scan failed: ' + err.message);
    } finally {
      setScanning(false);
    }
  }

  async function handleAiSuggest() {
    if (!dataModel.signals?.length) {
      alert('Define a standard data model first.');
      return;
    }
    if (!signals.length) {
      alert('No PLC signals available. Upload a project file or run a live scan first.');
      return;
    }

    const hasExisting = mappings.length > 0;
    if (hasExisting) {
      if (!confirm(
        `Achtung: Es gibt ${mappings.length} bestehende Mappings.\n\n` +
        `AI Suggest ersetzt ALLE bestehenden Mappings durch neue Vorschläge.\n` +
        `Ergebnisse erscheinen live Batch für Batch.\n\n` +
        `Fortfahren?`
      )) return;
    }

    setSuggesting(true);
    setAiProgress({ status: 'starting', progress: 0, total: 0, mapped: 0, currentGroup: '' });

    try {
      // Fire-and-forget: starts the job, returns immediately
      await api.post(`/api/mappings/machine/${machine.id}/ai-suggest`);

      // Poll for progress and reload mappings live
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.get(`/api/mappings/machine/${machine.id}/ai-status`);
          setAiProgress(status);

          // Reload mappings to show new results
          await loadMappings();

          if (status.status === 'done' || status.status === 'error') {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setSuggesting(false);
            if (status.status === 'done') {
              setAiProgress(null);
            } else {
              alert('AI Fehler: ' + (status.error || 'Unknown'));
              setAiProgress(null);
            }
          }
        } catch (e) { /* ignore poll errors */ }
      }, 3000); // Poll every 3 seconds

    } catch (err) {
      alert('AI suggestion failed: ' + err.message);
      setSuggesting(false);
      setAiProgress(null);
    }
  }

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function handleSaveMapping(targetSignal, mapping) {
    const updated = mappings.filter(m => m.target_signal !== targetSignal);
    updated.push({ ...mapping, target_signal: targetSignal });
    try {
      await api.put(`/api/mappings/machine/${machine.id}`, { mappings: updated });
      await loadMappings();
      setEditingTarget(null);
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  }

  async function handleRemoveMapping(targetSignal) {
    const updated = mappings.filter(m => m.target_signal !== targetSignal);
    try {
      await api.put(`/api/mappings/machine/${machine.id}`, { mappings: updated });
      await loadMappings();
    } catch (err) {
      alert('Remove failed: ' + err.message);
    }
  }

  // Filter signals
  const filteredSignals = signals.filter(s => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return s.name?.toLowerCase().includes(q) ||
           s.address?.toLowerCase().includes(q) ||
           s.comment?.toLowerCase().includes(q);
  });

  const mappingsByTarget = new Map(mappings.map(m => [m.target_signal, m]));

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between p-3 border-b border-gray-700 bg-gray-800">
        <div>
          <h2 className="text-base font-bold text-white">{machine.name}</h2>
          <span className="text-xs text-gray-400">
            {machine.plc_type} | {machine.host} | {signals.length} signals
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleUpload}
            accept=".s7p,.zap,.zip,.l5x"
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : 'Upload Project'}
          </button>
          <button
            onClick={handleScanLive}
            disabled={scanning}
            className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded disabled:opacity-50"
          >
            {scanning ? 'Scanning...' : 'Live Scan'}
          </button>
          <button
            onClick={handleAiSuggest}
            disabled={suggesting}
            className="text-xs bg-purple-600 hover:bg-purple-500 text-white px-3 py-1.5 rounded disabled:opacity-50"
          >
            {suggesting ? 'AI läuft...' : 'AI Suggest'}
          </button>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span>Min:</span>
            <input
              type="range" min="50" max="100" value={minConfidence}
              onChange={e => setMinConfidence(parseInt(e.target.value))}
              className="w-20 h-1 accent-purple-500"
            />
            <span className="text-purple-400 font-mono w-8">{minConfidence}%</span>
          </div>
        </div>
      </div>

      {/* AI Progress Bar */}
      {aiProgress && aiProgress.status === 'running' && (
        <div className="px-3 py-2 bg-purple-900/30 border-b border-purple-700/40">
          <div className="flex items-center justify-between text-xs text-purple-300 mb-1">
            <span>AI Mapping: {aiProgress.currentGroup || 'Starting...'}</span>
            <span>{aiProgress.mapped} mapped | Batch {aiProgress.progress}/{aiProgress.total}</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-1.5">
            <div
              className="bg-purple-500 h-1.5 rounded-full transition-all duration-500"
              style={{ width: aiProgress.total > 0 ? `${(aiProgress.progress / aiProgress.total) * 100}%` : '5%' }}
            />
          </div>
        </div>
      )}

      {/* Main content: two panels */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: PLC Signals */}
        <div className="w-1/2 border-r border-gray-700 flex flex-col">
          <div className="p-2 border-b border-gray-700">
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter signals..."
              className="w-full bg-gray-700 text-white text-sm rounded px-3 py-1.5 border border-gray-600 focus:border-blue-500 outline-none"
            />
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredSignals.length === 0 && (
              <p className="text-gray-500 text-sm text-center py-8">
                No signals found. Upload a project file or run a live scan.
              </p>
            )}
            {filteredSignals.map(signal => {
              const isMapped = mappings.some(m =>
                m.source_address === signal.address ||
                m.expression?.includes(signal.address)
              );
              return (
                <div
                  key={signal.id || signal.address}
                  className={`p-2 rounded text-sm ${
                    isMapped ? 'bg-green-900/20 border border-green-800/30' : 'bg-gray-800 border border-gray-700'
                  }`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('signal', JSON.stringify(signal))}
                >
                  <div className="flex items-center justify-between">
                    <code className="text-blue-400 text-xs font-mono">{signal.address}</code>
                    <span className="text-[10px] text-gray-500 bg-gray-700 px-1 rounded">{signal.data_type}</span>
                  </div>
                  <div className="text-white text-xs mt-0.5">{signal.name}</div>
                  {signal.comment && (
                    <div className="text-gray-400 text-xs mt-0.5 italic">"{signal.comment}"</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right panel: Standard Data Model targets */}
        <div className="w-1/2 flex flex-col">
          <div className="p-2 border-b border-gray-700">
            <span className="text-xs font-semibold text-gray-400 uppercase">Standard Data Model</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {(!dataModel.signals || dataModel.signals.length === 0) && (
              <p className="text-gray-500 text-sm text-center py-8">
                No data model defined. Click "Standard Data Model" in the sidebar.
              </p>
            )}
            {dataModel.signals?.map(target => {
              const mapping = mappingsByTarget.get(target.name);
              const belowThreshold = mapping && (mapping.confidence || 0) * 100 < minConfidence;
              const isEditing = editingTarget === target.name;

              return (
                <div
                  key={target.name}
                  className={`p-2 rounded border ${
                    mapping ? 'bg-gray-800 border-green-700/50' : 'bg-gray-800 border-gray-700'
                  }`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const signal = JSON.parse(e.dataTransfer.getData('signal'));
                    handleSaveMapping(target.name, {
                      mapping_type: 'direct',
                      source_address: signal.address,
                      confidence: 1.0,
                      validated_by_human: true
                    });
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium text-white">{target.name}</span>
                      <span className="text-[10px] text-gray-500 ml-2">[{target.data_type}]</span>
                    </div>
                    {mapping && (
                      <div className="flex items-center gap-1">
                        {mapping.confidence && (
                          <span className={`text-[10px] px-1 rounded ${
                            mapping.confidence >= 0.9 ? 'bg-green-700 text-green-200' :
                            mapping.confidence >= 0.7 ? 'bg-yellow-700 text-yellow-200' :
                            'bg-red-700 text-red-200'
                          }`}>
                            {Math.round(mapping.confidence * 100)}%
                          </span>
                        )}
                        {mapping.validated_by_human && (
                          <span className="text-[10px] text-green-400">validated</span>
                        )}
                      </div>
                    )}
                  </div>

                  {target.description && (
                    <div className="text-xs text-gray-500 mt-0.5">{target.description}</div>
                  )}

                  {/* Current mapping display */}
                  {mapping && !isEditing && !belowThreshold && (
                    <div className="mt-2 bg-gray-900 rounded p-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-400">{mapping.mapping_type}:</span>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setEditingTarget(target.name)}
                            className="text-blue-400 hover:text-blue-300"
                          >
                            edit
                          </button>
                          <button
                            onClick={() => handleRemoveMapping(target.name)}
                            className="text-red-400 hover:text-red-300"
                          >
                            remove
                          </button>
                        </div>
                      </div>
                      {mapping.mapping_type === 'lookup' && mapping.lookup_table ? (() => {
                        const table = typeof mapping.lookup_table === 'string' ? JSON.parse(mapping.lookup_table) : mapping.lookup_table;
                        // Collect all PLC addresses from all conditions for comment lookup
                        const allAddrs = new Set();
                        Object.keys(table).forEach(cond => {
                          const matches = cond.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g);
                          if (matches) matches.forEach(a => allAddrs.add(a));
                        });
                        const addrComments = {};
                        allAddrs.forEach(a => {
                          const sig = signals.find(s => s.address === a);
                          if (sig) addrComments[a] = sig.name + (sig.comment ? ' // ' + sig.comment : '');
                        });

                        return (
                          <div className="mt-1 space-y-1">
                            {Object.entries(table).map(([condition, value], i) => (
                              <div key={i}>
                                <div className="flex gap-1 text-[11px]">
                                  <span className="text-yellow-400 font-mono shrink-0">{condition === 'DEFAULT' ? 'ELSE' : 'IF'}</span>
                                  <span className="text-green-400 font-mono flex-1">{condition === 'DEFAULT' ? '' : condition}</span>
                                  <span className="text-gray-500">→</span>
                                  <span className="text-cyan-300 font-medium shrink-0">'{value}'</span>
                                </div>
                                {/* Show comments for addresses in this condition */}
                                {condition !== 'DEFAULT' && (() => {
                                  const addrs = condition.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g) || [];
                                  const unique = [...new Set(addrs)];
                                  if (unique.length === 0) return null;
                                  return (
                                    <div className="ml-6 space-y-0">
                                      {unique.map(a => addrComments[a] ? (
                                        <div key={a} className="text-[9px] text-gray-500">
                                          <span className="text-blue-400/50 font-mono">{a}</span> {addrComments[a]}
                                        </div>
                                      ) : null)}
                                    </div>
                                  );
                                })()}
                              </div>
                            ))}
                          </div>
                        );
                      })(
                      ) : (
                        <code className="text-green-400 block mt-1">
                          {mapping.source_address || mapping.expression || '-'}
                        </code>
                      )}
                      {/* Show PLC signal comments for referenced addresses */}
                      {(() => {
                        const text = mapping.source_address || mapping.expression || '';
                        const addrRegex = /DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g;
                        const addrs = [...new Set(text.match(addrRegex) || [])];
                        const comments = addrs.map(a => {
                          const sig = signals.find(s => s.address === a);
                          return sig ? { addr: a, name: sig.name, comment: sig.comment } : null;
                        }).filter(Boolean);
                        if (comments.length === 0) return null;
                        return (
                          <div className="mt-1 space-y-0.5">
                            {comments.map(c => (
                              <div key={c.addr} className="text-[10px] text-gray-400">
                                <span className="text-blue-400/70 font-mono">{c.addr}</span>
                                {' '}<span className="text-gray-500">{c.name}</span>
                                {c.comment && <span className="italic"> // {c.comment}</span>}
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                      {mapping.reasoning && (
                        <div className="text-gray-500 mt-1 italic">AI: {mapping.reasoning}</div>
                      )}
                    </div>
                  )}

                  {/* Expression builder */}
                  {isEditing && (
                    <ExpressionBuilder
                      signals={signals}
                      currentMapping={mapping}
                      onSave={(m) => handleSaveMapping(target.name, m)}
                      onCancel={() => setEditingTarget(null)}
                    />
                  )}

                  {/* Drop zone for unmapped or below-threshold */}
                  {(!mapping || belowThreshold) && !isEditing && (
                    <div className="mt-2 border border-dashed border-gray-600 rounded p-3 text-center text-xs text-gray-500">
                      {belowThreshold ? (() => {
                        const addr = mapping.source_address || mapping.expression || '';
                        const addrMatches = addr.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g) || [];
                        return (
                          <div className="text-left">
                            <div className="text-yellow-500/70 text-[10px] mb-1">
                              AI ({Math.round((mapping.confidence || 0) * 100)}%): {mapping.reasoning || 'low confidence'}
                            </div>
                            <div className="text-[10px] text-gray-600 font-mono">
                              {addr || (mapping.mapping_type === 'lookup' ? 'lookup' : '')}
                            </div>
                            {addrMatches.map(a => {
                              const sig = signals.find(s => s.address === a);
                              return sig ? (
                                <div key={a} className="text-[9px] text-gray-500">
                                  <span className="text-blue-400/50 font-mono">{a}</span> {sig.name}{sig.comment ? ' // ' + sig.comment : ''}
                                </div>
                              ) : null;
                            })}
                          </div>
                        );
                      })() : null}
                      <div className={belowThreshold ? '' : ''}>
                        Drag a signal here or{' '}
                        <button
                          onClick={() => setEditingTarget(target.name)}
                          className="text-blue-400 hover:underline"
                        >
                          build expression
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
