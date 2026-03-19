import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';

const DATA_TYPES = ['BOOL', 'INT', 'UINT', 'DINT', 'REAL', 'LREAL', 'STRING', 'WORD', 'DWORD', 'BYTE', 'TIME'];

const DEFAULT_SIGNALS = [
  { name: 'machine_producing', data_type: 'BOOL', unit: null, description: 'True when actively producing' },
  { name: 'machine_fault', data_type: 'BOOL', unit: null, description: 'True when fault active' },
  { name: 'machine_idle', data_type: 'BOOL', unit: null, description: 'True when idle, no fault' },
  { name: 'inlet_temperature', data_type: 'REAL', unit: '\u00b0C', description: 'Inlet temperature' },
  { name: 'cycle_time_ms', data_type: 'INT', unit: 'ms', description: 'Last cycle time' },
  { name: 'parts_produced', data_type: 'INT', unit: 'pcs', description: 'Parts counter current shift' },
  { name: 'oee_availability', data_type: 'REAL', unit: '%', description: 'Calculated OEE availability' }
];

export default function DataModelEditor({ onClose }) {
  const [signals, setSignals] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { loadModel(); }, []);

  async function loadModel() {
    try {
      const data = await api.get('/api/datamodel');
      if (data.signals?.length) {
        setSignals(data.signals);
      } else {
        setSignals(DEFAULT_SIGNALS);
      }
    } catch (err) {
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

  async function handleSave() {
    const valid = signals.filter(s => s.name.trim());
    if (!valid.length) return;
    setSaving(true);
    try {
      await api.put('/api/datamodel', { signals: valid });
      onClose();
    } catch (err) {
      alert('Save failed: ' + err.message);
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
      } catch (err) {
        alert('Invalid JSON file');
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-bold text-white">Standard Data Model</h2>
          <div className="flex items-center gap-2">
            <label className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1.5 rounded cursor-pointer">
              Import JSON
              <input type="file" accept=".json" onChange={handleImport} className="hidden" />
            </label>
            <button onClick={handleExport} className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1.5 rounded">
              Export JSON
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {/* Header row */}
          <div className="grid grid-cols-12 gap-2 text-xs text-gray-400 font-semibold px-1">
            <span className="col-span-3">Name</span>
            <span className="col-span-2">Type</span>
            <span className="col-span-1">Unit</span>
            <span className="col-span-5">Description</span>
            <span className="col-span-1"></span>
          </div>

          {signals.map((signal, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-center">
              <input
                value={signal.name}
                onChange={e => updateSignal(i, 'name', e.target.value)}
                className="col-span-3 bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600 outline-none focus:border-blue-500 font-mono"
                placeholder="signal_name"
              />
              <select
                value={signal.data_type}
                onChange={e => updateSignal(i, 'data_type', e.target.value)}
                className="col-span-2 bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600 outline-none"
              >
                {DATA_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <input
                value={signal.unit || ''}
                onChange={e => updateSignal(i, 'unit', e.target.value || null)}
                className="col-span-1 bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600 outline-none"
                placeholder="unit"
              />
              <input
                value={signal.description || ''}
                onChange={e => updateSignal(i, 'description', e.target.value)}
                className="col-span-5 bg-gray-700 text-white text-xs rounded px-2 py-1.5 border border-gray-600 outline-none"
                placeholder="Description"
              />
              <button
                onClick={() => removeSignal(i)}
                className="col-span-1 text-gray-500 hover:text-red-400 text-xs text-center"
              >
                x
              </button>
            </div>
          ))}

          <button
            onClick={addSignal}
            className="text-xs text-blue-400 hover:text-blue-300 mt-2"
          >
            + Add Signal
          </button>
        </div>

        <div className="flex gap-2 p-4 border-t border-gray-700">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Data Model'}
          </button>
          <button onClick={onClose} className="px-4 bg-gray-700 hover:bg-gray-600 text-gray-300 py-2 rounded text-sm">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
