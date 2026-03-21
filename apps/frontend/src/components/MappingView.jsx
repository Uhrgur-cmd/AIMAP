import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api';
import ExpressionBuilder from './ExpressionBuilder';

/* ── Data-type badge helper ─────────────────────────── */
function TypeBadge({ type }) {
  const t = (type || '').toUpperCase();
  const styles =
    t === 'BOOL'                          ? 'bg-blue-50 text-blue-700 border-blue-200' :
    ['INT','WORD','DINT','DWORD','UINT','SINT','USINT','UDINT'].includes(t) ? 'bg-amber-50 text-amber-700 border-amber-200' :
    ['REAL','LREAL'].includes(t)          ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
    ['STRING','CHAR','WSTRING'].includes(t) ? 'bg-violet-50 text-violet-700 border-violet-200' :
    ['TIME','DATE_AND_TIME','DATE','TOD','DT'].includes(t) ? 'bg-pink-50 text-pink-700 border-pink-200' :
    'bg-gray-100 text-gray-600 border-gray-200';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium font-mono ${styles}`}>{type}</span>;
}

export default function MappingView({ machine, onRefresh, dataModelVersion = 0 }) {
  const { t } = useTranslation();
  const [signals, setSignals] = useState([]);
  const [dataModel, setDataModel] = useState({ signals: [] });
  const [mappings, setMappings] = useState([]);
  const [filter, setFilter] = useState('');
  const [editingTarget, setEditingTarget] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStep, setUploadStep] = useState(null);
  const uploadStepRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(null);
  const [scanDbStart, setScanDbStart] = useState(1);
  const [scanDbEnd, setScanDbEnd] = useState(100);
  const scanPollRef = useRef(null);
  const [suggesting, setSuggesting] = useState(false);
  const [aiProgress, setAiProgress] = useState(null);
  const [minConfidence, setMinConfidence] = useState(85);
  const [sdmFilter, setSdmFilter] = useState('');
  const fileInputRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => {
    if (machine) { loadSignals(); loadMappings(); }
  }, [machine?.id, machine?._refreshKey, machine?.project_last_parsed]);

  useEffect(() => { if (machine) loadDataModel(); }, [machine?.id, dataModelVersion]);

  async function loadSignals() {
    try { const data = await api.get(`/api/signals/machine/${machine.id}`); setSignals(data); } catch (err) { console.error(err); }
  }
  async function loadDataModel() {
    try {
      const data = await api.get(`/api/datamodel/machine/${machine.id}`);
      if (data.signals?.length) { setDataModel(data); } else { const global = await api.get('/api/datamodel'); setDataModel(global); }
    } catch (err) { console.error(err); }
  }
  async function loadMappings() {
    try { const data = await api.get(`/api/mappings/machine/${machine.id}`); setMappings(data); } catch (err) { console.error(err); }
  }

  const UPLOAD_STEPS = ['topbar.uploadStep1', 'topbar.uploadStep2', 'topbar.uploadStep3', 'topbar.uploadStep4'];
  const UPLOAD_STEP_DELAYS = [600, 1200, 3000, 2000];

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadStep(0);
    let step = 0;
    const maxStep = machine.connector === 'siemens-s7' ? UPLOAD_STEPS.length - 1 : 2;
    const advanceStep = () => { step++; if (step <= maxStep) { setUploadStep(step); uploadStepRef.current = setTimeout(advanceStep, UPLOAD_STEP_DELAYS[step]); } };
    uploadStepRef.current = setTimeout(advanceStep, UPLOAD_STEP_DELAYS[0]);
    try {
      const result = await api.upload(`/api/machines/${machine.id}/upload`, file);
      clearTimeout(uploadStepRef.current); setUploadStep(UPLOAD_STEPS.length);
      let msg = `Parsed: ${result.total_signals} signals from ${result.blocks} blocks, ${result.networks} networks`;
      if (result.live_confirmed > 0) msg += `\nLive confirmed: ${result.live_confirmed} (${result.live_confirmed_pct}%)`;
      alert(msg); await loadSignals();
    } catch (err) { clearTimeout(uploadStepRef.current); alert('Upload failed: ' + err.message); }
    finally { setUploading(false); setUploadStep(null); if (fileInputRef.current) fileInputRef.current.value = ''; }
  }

  async function handleScanLive() {
    setScanning(true); setScanProgress({ status: 'running', db: 0, total: scanDbEnd, found: 0 });
    try { await api.post(`/api/machines/${machine.id}/scan-live`, { startDb: scanDbStart, endDb: scanDbEnd }); } catch (err) { alert('Scan failed: ' + err.message); setScanning(false); setScanProgress(null); return; }
    scanPollRef.current = setInterval(async () => {
      try {
        const progress = await api.get(`/api/machines/${machine.id}/scan-progress`);
        setScanProgress(progress);
        if (progress.status === 'done') { clearInterval(scanPollRef.current); scanPollRef.current = null; setScanning(false); setScanProgress(null); await loadSignals(); onRefresh?.(); }
        else if (progress.status === 'error') { clearInterval(scanPollRef.current); scanPollRef.current = null; setScanning(false); setScanProgress(null); alert('Scan failed: ' + (progress.error || 'Unknown error')); }
      } catch (e) {}
    }, 250);
  }

  async function handleAiSuggest() {
    if (!dataModel.signals?.length) { alert('Define a standard data model first.'); return; }
    if (!signals.length) { alert('No PLC signals available. Upload a project file or run a live scan first.'); return; }
    if (mappings.length > 0) { if (!confirm(t('topbar.aiConfirmReplace', { count: mappings.length }))) return; }
    setSuggesting(true); setAiProgress({ status: 'starting', progress: 0, total: 0, mapped: 0, currentGroup: '' });
    try {
      await api.post(`/api/mappings/machine/${machine.id}/ai-suggest`);
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.get(`/api/mappings/machine/${machine.id}/ai-status`);
          setAiProgress(status); await loadMappings();
          if (status.status === 'done' || status.status === 'error') { clearInterval(pollRef.current); pollRef.current = null; setSuggesting(false); if (status.status === 'error') alert(t('topbar.aiError', { error: status.error || 'Unknown' })); setAiProgress(null); }
        } catch (e) {}
      }, 3000);
    } catch (err) { alert('AI suggestion failed: ' + err.message); setSuggesting(false); setAiProgress(null); }
  }

  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current); if (scanPollRef.current) clearInterval(scanPollRef.current); }; }, []);

  async function handleSaveMapping(targetSignal, mapping) {
    const updated = mappings.filter(m => m.target_signal !== targetSignal);
    updated.push({ ...mapping, target_signal: targetSignal });
    try { await api.put(`/api/mappings/machine/${machine.id}`, { mappings: updated }); await loadMappings(); setEditingTarget(null); } catch (err) { alert('Save failed: ' + err.message); }
  }
  async function handleRemoveMapping(targetSignal) {
    const updated = mappings.filter(m => m.target_signal !== targetSignal);
    try { await api.put(`/api/mappings/machine/${machine.id}`, { mappings: updated }); await loadMappings(); } catch (err) { alert('Remove failed: ' + err.message); }
  }

  const filteredSignals = signals.filter(s => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return s.name?.toLowerCase().includes(q) || s.address?.toLowerCase().includes(q) || s.comment?.toLowerCase().includes(q);
  });

  const mappedAddressSet = new Set(
    mappings.flatMap(m => {
      const addrs = [];
      if (m.source_address) addrs.push(m.source_address);
      if (m.expression) { const found = m.expression.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g) || []; addrs.push(...found); }
      return addrs;
    })
  );

  const mappingsByTarget = new Map(mappings.map(m => [m.target_signal, m]));
  const confirmedCount = signals.filter(s => s.live_confirmed).length;
  const isS7Classic = machine.connector === 'siemens-s7';

  return (
    <div className="flex flex-col h-full bg-white">
      {/* ── Top bar ─────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-surface">
        <div>
          <h2 className="text-base font-semibold text-gray-900">{machine.name}</h2>
          <span className="text-xs text-gray-500">
            {machine.plc_type} | <span className="font-mono">{machine.host}</span> | {signals.length} signals
            {confirmedCount > 0 && <span className="ml-2 text-emerald-600">{t('topbar.liveConfirmed', { count: confirmedCount })}</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input type="file" ref={fileInputRef} onChange={handleUpload} accept=".s7p,.zap,.zip,.l5x" className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
            className="text-xs bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 px-3 py-1.5 rounded-md disabled:opacity-50 transition-colors">
            {uploading ? t('topbar.uploading') : t('topbar.uploadProject')}
          </button>

          {isS7Classic && (
            <div className="flex items-center gap-1 text-xs text-gray-500">
              <span>{t('topbar.dbLabel')}</span>
              <input type="number" value={scanDbStart} onChange={e => setScanDbStart(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-12 bg-white text-gray-900 text-center rounded-md px-1 py-1.5 border border-gray-300 focus:border-signal-blue focus:ring-1 focus:ring-signal-blue/20 outline-none"
                min="1" max="65535" disabled={scanning} />
              <span>–</span>
              <input type="number" value={scanDbEnd} onChange={e => setScanDbEnd(Math.max(scanDbStart, parseInt(e.target.value) || 100))}
                className="w-12 bg-white text-gray-900 text-center rounded-md px-1 py-1.5 border border-gray-300 focus:border-signal-blue focus:ring-1 focus:ring-signal-blue/20 outline-none"
                min="1" max="65535" disabled={scanning} />
            </div>
          )}

          <button onClick={handleScanLive} disabled={scanning}
            className="text-xs bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 px-3 py-1.5 rounded-md disabled:opacity-50 transition-colors">
            {scanning && scanProgress?.total > 0 ? `DB ${scanProgress.db}/${scanProgress.total}` : scanning ? t('topbar.connecting') : t('topbar.liveScan')}
          </button>
          <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
            <span>{t('mapping.minConfidence', { value: minConfidence })}</span>
            <input type="range" min="50" max="100" step="5" value={minConfidence}
              onChange={e => setMinConfidence(Number(e.target.value))}
              className="w-16 accent-signal-blue" title={`Min confidence: ${minConfidence}%`} />
          </div>
          <button onClick={handleAiSuggest} disabled={suggesting}
            className="text-xs bg-signal-blue hover:bg-signal-blue-light text-white font-semibold px-3 py-1.5 rounded-md disabled:opacity-50 transition-colors">
            {suggesting ? t('topbar.aiRunning') : t('topbar.aiSuggest')}
          </button>
        </div>
      </div>

      {/* ── Upload Progress ─────────────────────────────── */}
      {uploading && uploadStep !== null && (
        <div className="px-4 py-2 bg-blue-50 border-b border-blue-100">
          <div className="flex items-center justify-between text-xs text-blue-700 mb-1.5">
            <span>{t(UPLOAD_STEPS[Math.min(uploadStep, UPLOAD_STEPS.length - 1)])}</span>
            <span className="text-blue-400">{Math.min(uploadStep + 1, UPLOAD_STEPS.length)}/{UPLOAD_STEPS.length}</span>
          </div>
          <div className="flex gap-1">
            {UPLOAD_STEPS.map((_, i) => (
              <div key={i} className={`flex-1 h-1.5 rounded-full transition-all duration-500 ${
                i < uploadStep ? 'bg-blue-500' : i === uploadStep ? 'bg-blue-400 animate-pulse' : 'bg-blue-100'
              }`} />
            ))}
          </div>
        </div>
      )}

      {/* ── Live Scan Progress ──────────────────────────── */}
      {scanning && scanProgress && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-100">
          <div className="flex items-center justify-between text-xs text-amber-700 mb-1">
            <span>{scanProgress.total > 0 ? t('scan.scanningDb', { db: scanProgress.db, total: scanProgress.total }) : scanProgress.label || t('scan.connectingToPLC')}</span>
            <span className="font-medium">{scanProgress.found > 0 && t('scan.signalsFound', { count: scanProgress.found })}</span>
          </div>
          {scanProgress.total > 0 && (
            <div className="w-full bg-amber-100 rounded-full h-1.5">
              <div className="bg-amber-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${Math.round((scanProgress.db / scanProgress.total) * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {/* ── AI Progress ─────────────────────────────────── */}
      {aiProgress && aiProgress.status === 'running' && (
        <div className="px-4 py-2 bg-indigo-50 border-b border-indigo-100">
          <div className="flex items-center justify-between text-xs text-indigo-700 mb-1">
            <span>{t('scan.aiMapping', { group: aiProgress.currentGroup || t('scan.aiStarting') })}</span>
            <span>{t('scan.aiProgress', { mapped: aiProgress.mapped, progress: aiProgress.progress, total: aiProgress.total })}</span>
          </div>
          <div className="w-full bg-indigo-100 rounded-full h-1.5">
            <div className="bg-signal-blue h-1.5 rounded-full transition-all duration-500" style={{ width: aiProgress.total > 0 ? `${(aiProgress.progress / aiProgress.total) * 100}%` : '5%' }} />
          </div>
        </div>
      )}

      {/* ── Two-panel layout ────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: PLC Signals */}
        <div className="w-1/2 border-r border-gray-200 flex flex-col bg-white">
          <div className="px-3 pt-2.5 pb-2 border-b border-gray-200 bg-surface space-y-1.5">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t('signals.plcVariables')}</span>
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('signals.filterPlaceholder')}
              className="w-full bg-white text-gray-900 text-sm rounded-md px-3 py-1.5 border border-gray-200 focus:border-signal-blue focus:ring-1 focus:ring-signal-blue/20 outline-none placeholder:text-gray-400" />
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1 bg-gray-50/50">
            {signals.length === 0 && !uploading && !scanning && (
              <div className="space-y-2 py-4">
                {[1,2,3,4,5].map(i => (
                  <div key={i} className="p-2 rounded-md border border-gray-100 animate-pulse">
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-24 bg-gray-200 rounded"></div>
                      <div className="h-3 w-12 bg-gray-100 rounded ml-auto"></div>
                    </div>
                    <div className="h-2.5 w-32 bg-gray-100 rounded mt-1.5"></div>
                  </div>
                ))}
                <p className="text-gray-400 text-xs text-center pt-2">{t('signals.noSignals')}</p>
              </div>
            )}
            {signals.length > 0 && filteredSignals.length === 0 && (
              <p className="text-gray-400 text-sm text-center py-8">No signals match filter</p>
            )}
            {filteredSignals.map(signal => {
              const isMapped = mappedAddressSet.has(signal.address);
              return (
                <div key={signal.id || signal.address}
                  className={`p-2 rounded-md text-sm border transition-colors cursor-grab active:cursor-grabbing ${
                    isMapped ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-gray-200 hover:border-gray-300'
                  }`}
                  draggable onDragStart={(e) => e.dataTransfer.setData('signal', JSON.stringify(signal))}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <code className="text-signal-blue text-xs font-mono font-medium">{signal.address}</code>
                      {signal.live_confirmed && <span className="text-[9px] bg-emerald-100 text-emerald-700 px-1 rounded">{t('signals.live')}</span>}
                    </div>
                    <TypeBadge type={signal.data_type} />
                  </div>
                  <div className="text-gray-900 text-xs mt-0.5 font-medium">{signal.name}</div>
                  {signal.comment && <div className="text-gray-500 text-xs mt-0.5 italic">"{signal.comment}"</div>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Standard Data Model */}
        <div className="w-1/2 flex flex-col bg-white">
          <div className="px-3 pt-2.5 pb-2 border-b border-gray-200 bg-surface space-y-1.5">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t('signals.opcuaOutput')}</span>
            <input value={sdmFilter} onChange={e => setSdmFilter(e.target.value)}
              placeholder={t('signals.filterSDM')}
              className="w-full bg-white text-gray-900 text-sm rounded-md px-3 py-1.5 border border-gray-200 focus:border-signal-blue focus:ring-1 focus:ring-signal-blue/20 outline-none placeholder:text-gray-400" />
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2 bg-gray-50/30">
            {(!dataModel.signals || dataModel.signals.length === 0) && (
              <p className="text-gray-400 text-sm text-center py-8">{t('signals.noDataModel')}</p>
            )}
            {dataModel.signals?.filter(target => {
              if (!sdmFilter) return true;
              const q = sdmFilter.toLowerCase();
              const mapping = mappingsByTarget.get(target.name);
              const mappingText = (mapping?.source_address || '') + ' ' + (mapping?.expression || '') + ' ' + (mapping?.reasoning || '');
              return target.name?.toLowerCase().includes(q) ||
                     target.description?.toLowerCase().includes(q) ||
                     target.data_type?.toLowerCase().includes(q) ||
                     mappingText.toLowerCase().includes(q);
            }).map(target => {
              const mapping = mappingsByTarget.get(target.name);
              const belowThreshold = mapping && (mapping.confidence || 0) * 100 < minConfidence && !mapping.validated_by_human;
              const isEditing = editingTarget === target.name;

              return (
                <div key={target.name}
                  className={`p-3 rounded-md border transition-colors ${
                    mapping && !belowThreshold ? 'bg-white border-emerald-200 shadow-sm' : 'bg-white border-gray-200'
                  }`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const signal = JSON.parse(e.dataTransfer.getData('signal'));
                    const srcType = (signal.data_type || '').toUpperCase();
                    const tgtType = (target.data_type || '').toUpperCase();
                    // Explicit allowed drag-drop pairs (source → target without conversion)
                    // Rule: only if NO data loss is possible
                    const DRAG_OK = new Set([
                      // Same type
                      ...['BOOL','BYTE','SINT','USINT','INT','UINT','WORD','DINT','UDINT','DWORD','REAL','LREAL','STRING','CHAR','TIME','DATE_AND_TIME']
                        .map(t => t+':'+t),
                      // Smaller int → larger int (lossless)
                      'BYTE:INT','BYTE:UINT','BYTE:WORD','BYTE:DINT','BYTE:UDINT','BYTE:DWORD',
                      'SINT:INT','USINT:INT','USINT:UINT','USINT:WORD',
                      'SINT:DINT','USINT:DINT','USINT:UDINT','USINT:DWORD',
                      'INT:DINT','INT:UDINT','UINT:DINT','UINT:UDINT','UINT:DWORD',
                      'WORD:DINT','WORD:UDINT','WORD:DWORD',
                      // Signed/unsigned same size
                      'INT:WORD','WORD:INT','UINT:INT','INT:UINT',
                      'DINT:DWORD','DWORD:DINT','UDINT:DINT','DINT:UDINT',
                      // Any int → float (lossless)
                      'BYTE:REAL','BYTE:LREAL',
                      'SINT:REAL','USINT:REAL',
                      'INT:REAL','INT:LREAL','UINT:REAL','UINT:LREAL','WORD:REAL','WORD:LREAL',
                      'DINT:REAL','DINT:LREAL','UDINT:REAL','UDINT:LREAL','DWORD:REAL','DWORD:LREAL',
                      // Float precision
                      'REAL:LREAL',
                      // String variants
                      'CHAR:STRING','STRING:CHAR',
                    ]);
                    if (!DRAG_OK.has(srcType+':'+tgtType)) {
                      alert(`Type mismatch: ${signal.address} is ${srcType}, target ${target.name} expects ${tgtType}.\n\nUse "build expression" with ${srcType}_TO_${tgtType}() conversion.`);
                      return;
                    }
                    handleSaveMapping(target.name, { mapping_type: 'direct', source_address: signal.address + ';', expression: signal.address + ';', confidence: 1.0, validated_by_human: true });
                  }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{target.name}</span>
                      <TypeBadge type={target.data_type} />
                    </div>
                    {mapping && (
                      <div className="flex items-center gap-1.5">
                        {mapping.confidence && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                            mapping.confidence >= 0.9 ? 'bg-emerald-100 text-emerald-700' :
                            mapping.confidence >= 0.7 ? 'bg-amber-100 text-amber-700' :
                            'bg-red-100 text-red-700'
                          }`}>{Math.round(mapping.confidence * 100)}%</span>
                        )}
                        {mapping.validated_by_human && <span className="text-[10px] text-emerald-600 font-medium">{t('mapping.validated')}</span>}
                      </div>
                    )}
                  </div>

                  {target.description && <div className="text-xs text-gray-500 mt-0.5">{target.description}</div>}

                  {/* Mapping display */}
                  {mapping && !isEditing && !belowThreshold && (
                    <div className="mt-2 bg-gray-50 rounded-md p-2.5 text-xs border border-gray-100">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-400 font-medium">{mapping.mapping_type}:</span>
                        <div className="flex gap-2">
                          <button onClick={() => setEditingTarget(target.name)} className="text-signal-blue hover:text-signal-blue-light font-medium">{t('mapping.edit')}</button>
                          <button onClick={() => handleRemoveMapping(target.name)} className="text-red-500 hover:text-red-400 font-medium">{t('mapping.remove')}</button>
                        </div>
                      </div>

                      {/* Lookup table */}
                      {mapping.mapping_type === 'lookup' && mapping.lookup_table ? (() => {
                        const table = typeof mapping.lookup_table === 'string' ? JSON.parse(mapping.lookup_table) : mapping.lookup_table;
                        const allAddrs = new Set();
                        Object.keys(table).forEach(cond => { const m = cond.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g); if (m) m.forEach(a => allAddrs.add(a)); });
                        const addrComments = {};
                        allAddrs.forEach(a => { const sig = signals.find(s => s.address === a); if (sig) addrComments[a] = sig.name + (sig.comment ? ' // ' + sig.comment : ''); });
                        return (
                          <div className="mt-1.5 space-y-1">
                            {Object.entries(table).map(([condition, value], i) => (
                              <div key={i}>
                                <div className="flex gap-1.5 text-[11px]">
                                  <span className="text-amber-600 font-mono font-medium shrink-0">{condition === 'DEFAULT' ? 'ELSE' : 'IF'}</span>
                                  <span className="text-signal-blue font-mono flex-1">{condition === 'DEFAULT' ? '' : condition}</span>
                                  <span className="text-gray-300">→</span>
                                  <span className="text-emerald-700 font-medium shrink-0">'{value}'</span>
                                </div>
                                {condition !== 'DEFAULT' && (() => {
                                  const addrs = condition.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g) || [];
                                  return [...new Set(addrs)].map(a => addrComments[a] ? (
                                    <div key={a} className="ml-8 text-[9px] text-gray-400"><span className="text-signal-blue/60 font-mono">{a}</span> {addrComments[a]}</div>
                                  ) : null);
                                })()}
                              </div>
                            ))}
                          </div>
                        );
                      })() : (
                        <code className="text-signal-blue font-mono block mt-1">{mapping.source_address || mapping.expression || '-'}</code>
                      )}

                      {/* Signal comments — always show for all mapping types */}
                      {(() => {
                        let text = mapping.source_address || mapping.expression || '';
                        // Also extract addresses from lookup table keys
                        if (mapping.lookup_table) {
                          const lt = typeof mapping.lookup_table === 'string' ? JSON.parse(mapping.lookup_table) : mapping.lookup_table;
                          text += ' ' + Object.keys(lt).join(' ');
                        }
                        const addrs = [...new Set((text.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g) || []))];
                        const comments = addrs.map(a => { const sig = signals.find(s => s.address === a); return sig ? { addr: a, name: sig.name, comment: sig.comment, confirmed: sig.live_confirmed } : null; }).filter(Boolean);
                        if (!comments.length) return null;
                        return (
                          <div className="mt-1.5 space-y-0.5">
                            {comments.map(c => (
                              <div key={c.addr} className="text-[10px] text-gray-500">
                                <span className="text-signal-blue/70 font-mono">{c.addr}</span>
                                {c.confirmed && <span className="ml-1 text-emerald-500">●</span>}
                                {' '}<span className="text-gray-400">{c.name}</span>
                                {c.comment && <span className="italic text-gray-400"> // {c.comment}</span>}
                              </div>
                            ))}
                          </div>
                        );
                      })()}

                      {mapping.reasoning && <div className="text-gray-400 mt-1.5 italic text-[10px]">{t('mapping.aiReasoning', { text: mapping.reasoning })}</div>}
                    </div>
                  )}

                  {isEditing && (
                    <ExpressionBuilder signals={signals} currentMapping={mapping} targetName={target.name} targetType={target.data_type} onSave={(m) => handleSaveMapping(target.name, m)} onCancel={() => setEditingTarget(null)} />
                  )}

                  {/* Drop zone */}
                  {(!mapping || belowThreshold) && !isEditing && (
                    <div className="mt-2 border border-dashed border-gray-300 rounded-md p-3 text-xs text-gray-400">
                      {belowThreshold && (() => {
                        const addr = mapping.source_address || mapping.expression || '';
                        const addrMatches = addr.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g) || [];
                        return (
                          <div className="mb-2">
                            <div className="text-amber-600 text-[10px] mb-1">AI ({Math.round((mapping.confidence || 0) * 100)}%): {mapping.reasoning || 'low confidence'}</div>
                            <div className="text-[10px] text-gray-400 font-mono">{addr || (mapping.mapping_type === 'lookup' ? 'lookup' : '')}</div>
                            {addrMatches.map(a => { const sig = signals.find(s => s.address === a); return sig ? (<div key={a} className="text-[9px] text-gray-400"><span className="text-signal-blue/50 font-mono">{a}</span> {sig.name}{sig.comment ? ' // ' + sig.comment : ''}</div>) : null; })}
                          </div>
                        );
                      })()}
                      <div className="text-center">
                        {t('mapping.dragHint')}{' '}
                        <button onClick={() => setEditingTarget(target.name)} className="text-signal-blue hover:underline font-medium">{t('mapping.buildExpression')}</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Status Bar ──────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-gray-200 bg-surface text-[10px] text-gray-400 flex-shrink-0">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${machine.status === 'connected' ? 'bg-emerald-400' : 'bg-gray-300'}`}></span>
            {machine.status || 'unknown'}
          </span>
          <span>{signals.length} signals</span>
          <span>{mappings.length} / {dataModel.signals?.length || 0} mapped</span>
          {confirmedCount > 0 && <span className="text-emerald-600">{confirmedCount} live confirmed</span>}
        </div>
        <div className="flex items-center gap-4">
          {machine.project_last_parsed && (
            <span>Parsed: {new Date(machine.project_last_parsed).toLocaleDateString()}</span>
          )}
          <span className="font-mono">{machine.plc_type} · {machine.host}</span>
        </div>
      </div>
    </div>
  );
}
