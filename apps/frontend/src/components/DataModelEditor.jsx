import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api';

const DATA_TYPES = ['BOOL', 'INT', 'UINT', 'DINT', 'REAL', 'LREAL', 'STRING', 'WORD', 'DWORD', 'BYTE', 'TIME'];

const DEFAULT_SIGNALS = [
  { name: 'machine_producing', data_type: 'BOOL', unit: null, description: 'True when actively producing' },
  { name: 'machine_fault', data_type: 'BOOL', unit: null, description: 'True when fault active' },
  { name: 'machine_idle', data_type: 'BOOL', unit: null, description: 'True when idle, no fault' },
  { name: 'inlet_temperature', data_type: 'REAL', unit: '°C', description: 'Inlet temperature' },
  { name: 'cycle_time_ms', data_type: 'INT', unit: 'ms', description: 'Last cycle time' },
  { name: 'parts_produced', data_type: 'INT', unit: 'pcs', description: 'Parts counter current shift' },
  { name: 'oee_availability', data_type: 'REAL', unit: '%', description: 'Calculated OEE availability' }
];

export default function DataModelEditor({ onClose, onSaved, machines = [] }) {
  const { t } = useTranslation();
  const [signals, setSignals] = useState([]);
  const [saving, setSaving] = useState(false);
  // Machine selection: Set of machine IDs to apply to
  const [selectedMachineIds, setSelectedMachineIds] = useState(() => new Set(machines.map(m => m.id)));

  useEffect(() => { loadModel(); }, []);

  async function loadModel() {
    try {
      const data = await api.get('/api/datamodel');
      setSignals(data.signals?.length ? data.signals : DEFAULT_SIGNALS);
    } catch {
      setSignals(DEFAULT_SIGNALS);
    }
  }

  function updateSignal(index, field, value) {
    setSignals(prev => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));
  }

  function addSignal() {
    setSignals(prev => [...prev, { name: '', data_type: 'BOOL', unit: null, description: '' }]);
  }

  function removeSignal(index) {
    setSignals(prev => prev.filter((_, i) => i !== index));
  }

  function toggleMachine(id) {
    setSelectedMachineIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedMachineIds.size === machines.length) {
      setSelectedMachineIds(new Set());
    } else {
      setSelectedMachineIds(new Set(machines.map(m => m.id)));
    }
  }

  async function handleSave() {
    const valid = signals.filter(s => s.name.trim());
    if (!valid.length) return;
    if (!selectedMachineIds.size) {
      alert('Select at least one machine to apply the data model to.');
      return;
    }
    setSaving(true);
    try {
      await Promise.all(
        [...selectedMachineIds].map(id =>
          api.put(`/api/datamodel/machine/${id}`, { signals: valid })
        )
      );
      onSaved?.();
      onClose();
    } catch (err) {
      alert(t('dataModel.saveFailed') + err.message);
    } finally {
      setSaving(false);
    }
  }

  function handleExport() {
    const data = JSON.stringify({ version: '1.0', signals }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'datamodel.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.signals) setSignals(data.signals);
      } catch {
        alert(t('dataModel.invalidJson'));
      }
    };
    reader.readAsText(file);
    // Reset file input so the same file can be re-imported
    e.target.value = '';
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col border border-gray-200" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">{t('dataModel.title')}</h2>
          <div className="flex items-center gap-2">
            <label className="text-xs bg-gray-50 hover:bg-gray-100 text-gray-500 px-3 py-1.5 rounded cursor-pointer">
              {t('dataModel.importJson')}
              <input type="file" accept=".json" onChange={handleImport} className="hidden" />
            </label>
            <button onClick={handleExport} className="text-xs bg-gray-50 hover:bg-gray-100 text-gray-500 px-3 py-1.5 rounded">
              {t('dataModel.exportJson')}
            </button>
          </div>
        </div>

        {/* Signal list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 font-semibold px-1">
            <span className="col-span-3">{t('dataModel.nameCol')}</span>
            <span className="col-span-2">{t('dataModel.typeCol')}</span>
            <span className="col-span-1">{t('dataModel.unitCol')}</span>
            <span className="col-span-5">{t('dataModel.descriptionCol')}</span>
            <span className="col-span-1"></span>
          </div>

          {signals.map((signal, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-center">
              <input
                value={signal.name}
                onChange={e => updateSignal(i, 'name', e.target.value)}
                className="col-span-3 bg-gray-50 text-gray-900 text-xs rounded px-2 py-1.5 border border-gray-300 outline-none focus:border-signal-blue font-mono"
                placeholder="signal_name"
              />
              <select
                value={signal.data_type}
                onChange={e => updateSignal(i, 'data_type', e.target.value)}
                className="col-span-2 bg-gray-50 text-gray-900 text-xs rounded px-2 py-1.5 border border-gray-300 outline-none focus:border-signal-blue"
              >
                {DATA_TYPES.map(dt => <option key={dt} value={dt}>{dt}</option>)}
              </select>
              <input
                value={signal.unit || ''}
                onChange={e => updateSignal(i, 'unit', e.target.value || null)}
                className="col-span-1 bg-gray-50 text-gray-900 text-xs rounded px-2 py-1.5 border border-gray-300 outline-none focus:border-signal-blue"
                placeholder="unit"
              />
              <input
                value={signal.description || ''}
                onChange={e => updateSignal(i, 'description', e.target.value)}
                className="col-span-5 bg-gray-50 text-gray-900 text-xs rounded px-2 py-1.5 border border-gray-300 outline-none focus:border-signal-blue"
                placeholder={t('dataModel.descriptionCol')}
              />
              <button onClick={() => removeSignal(i)} className="col-span-1 text-gray-500 hover:text-red-400 text-xs text-center">x</button>
            </div>
          ))}

          <button onClick={addSignal} className="text-xs text-signal-blue hover:text-signal-blue-light mt-2">
            {t('dataModel.addSignal')}
          </button>
        </div>

        {/* Machine selector */}
        {machines.length > 0 && (
          <div className="px-4 py-3 border-t border-gray-200 bg-white/60">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500 uppercase">Apply to machines</span>
              <button onClick={toggleAll} className="text-[10px] text-signal-blue hover:underline">
                {selectedMachineIds.size === machines.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {machines.map(m => (
                <label
                  key={m.id}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded border cursor-pointer text-xs transition-colors ${
                    selectedMachineIds.has(m.id)
                      ? 'border-ct-gold/60 bg-signal-blue/10 text-gray-900'
                      : 'border-gray-300 bg-gray-50 text-neutral-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedMachineIds.has(m.id)}
                    onChange={() => toggleMachine(m.id)}
                    className="accent-signal-blue"
                  />
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      m.status === 'connected'  ? 'bg-green-400' :
                      m.status === 'connecting' ? 'bg-yellow-400' : 'bg-red-400'
                    }`}
                  />
                  {m.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex gap-2 p-4 border-t border-gray-200">
          <button
            onClick={handleSave}
            disabled={saving || selectedMachineIds.size === 0}
            className="flex-1 bg-signal-blue hover:bg-signal-blue-hover text-black font-semibold py-2 rounded text-sm disabled:opacity-50"
          >
            {saving
              ? t('dataModel.saving')
              : `Save to ${selectedMachineIds.size} machine${selectedMachineIds.size !== 1 ? 's' : ''}`}
          </button>
          <button onClick={onClose} className="px-4 bg-gray-50 hover:bg-gray-100 text-gray-500 py-2 rounded text-sm">
            {t('dataModel.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
