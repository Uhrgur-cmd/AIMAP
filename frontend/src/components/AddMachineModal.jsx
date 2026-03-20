import React, { useState, useRef } from 'react';

const PLC_TYPES = ['S7-300', 'S7-400', 'S7-1200', 'S7-1500', 'Rockwell'];

const DEFAULT_SLOTS = {
  'S7-300': 2,
  'S7-400': 3,
  'S7-1200': 1,
  'S7-1500': 1,
  'Rockwell': 0
};

const FILE_HINTS = {
  'S7-300': { accept: '.s7p,.zip', label: '.s7p / .zip (Step7 Projekt)' },
  'S7-400': { accept: '.s7p,.zip', label: '.s7p / .zip (Step7 Projekt)' },
  'S7-1200': { accept: '.zip,.xml', label: '.zip mit XML-Export aus TIA Portal' },
  'S7-1500': { accept: '.zip,.xml', label: '.zip mit XML-Export aus TIA Portal' },
  'Rockwell': { accept: '.l5x,.zip', label: '.L5X (Studio 5000 Export)' }
};

// These PLC types can additionally scan live (file upload is always available)
const CAN_LIVE_SCAN = ['S7-1200', 'S7-1500', 'Rockwell'];

export default function AddMachineModal({ machine, onSubmit, onClose, onUpload }) {
  const isEdit = !!machine;
  const [form, setForm] = useState({
    name: machine?.name || '',
    plc_type: machine?.plc_type || 'S7-300',
    host: machine?.host || '',
    rack: machine?.rack ?? 0,
    slot: machine?.slot ?? 2,
    use_opcua: machine?.connector === 'siemens-opcua'
  });
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    const val = type === 'checkbox' ? checked : type === 'number' ? parseInt(value) || 0 : value;
    const updates = { [name]: val };

    if (name === 'plc_type') {
      updates.slot = DEFAULT_SLOTS[value] || 2;
      updates.use_opcua = value === 'S7-1500';
    }

    setForm(prev => ({ ...prev, ...updates }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name || !form.host) return;

    setUploading(true);
    try {
      const result = await onSubmit(form, !!file);

      // Upload project file if selected (S7-300/400)
      if (file && onUpload) {
        const machineId = result?.id || machine?.id;
        if (machineId) {
          await onUpload(machineId, file);
        }
      }
      onClose();
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setUploading(false);
    }
  }

  const showRackSlot = form.plc_type !== 'Rockwell';
  const showOpcua = form.plc_type === 'S7-1200';
  const showFileUpload = !!FILE_HINTS[form.plc_type]; // All types can upload
  const showLiveScanHint = CAN_LIVE_SCAN.includes(form.plc_type);
  const fileHint = FILE_HINTS[form.plc_type];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-white mb-4">
          {isEdit ? 'Edit Machine' : 'Add Machine'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm text-gray-300 mb-1">Machine Name</label>
            <input
              name="name" value={form.name} onChange={handleChange}
              className="w-full bg-gray-700 text-white rounded px-3 py-2 text-sm border border-gray-600 focus:border-blue-500 outline-none"
              placeholder="e.g. Spritzguss Linie 1"
              required
            />
          </div>

          {/* PLC Type */}
          <div>
            <label className="block text-sm text-gray-300 mb-1">PLC Type</label>
            <select
              name="plc_type" value={form.plc_type} onChange={handleChange}
              className="w-full bg-gray-700 text-white rounded px-3 py-2 text-sm border border-gray-600 focus:border-blue-500 outline-none"
              disabled={isEdit}
            >
              {PLC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          {/* IP Address */}
          <div>
            <label className="block text-sm text-gray-300 mb-1">IP Address</label>
            <input
              name="host" value={form.host} onChange={handleChange}
              className="w-full bg-gray-700 text-white rounded px-3 py-2 text-sm border border-gray-600 focus:border-blue-500 outline-none"
              placeholder="192.168.1.10"
              required
            />
          </div>

          {/* Rack / Slot */}
          {showRackSlot && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-300 mb-1">Rack</label>
                <input
                  name="rack" type="number" value={form.rack} onChange={handleChange}
                  className="w-full bg-gray-700 text-white rounded px-3 py-2 text-sm border border-gray-600 focus:border-blue-500 outline-none"
                  min="0" max="7"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Slot</label>
                <input
                  name="slot" type="number" value={form.slot} onChange={handleChange}
                  className="w-full bg-gray-700 text-white rounded px-3 py-2 text-sm border border-gray-600 focus:border-blue-500 outline-none"
                  min="0" max="31"
                />
              </div>
            </div>
          )}

          {/* OPC UA toggle for S7-1200 */}
          {showOpcua && (
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                name="use_opcua" type="checkbox" checked={form.use_opcua} onChange={handleChange}
                className="rounded bg-gray-700 border-gray-600"
              />
              Use OPC UA (requires activation in TIA Portal)
            </label>
          )}

          {/* Project file upload – only for S7-300/400 */}
          {showFileUpload && fileHint && (
            <div>
              <label className="block text-sm text-gray-300 mb-1">
                Project File <span className="text-gray-500">(optional)</span>
              </label>
              <div
                className="border border-dashed border-gray-600 rounded p-3 text-center cursor-pointer hover:border-blue-500 hover:bg-gray-700/30 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={fileHint.accept}
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  className="hidden"
                />
                {file ? (
                  <div className="text-sm text-blue-400">
                    {file.name}
                    <span className="text-gray-500 ml-2">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
                  </div>
                ) : (
                  <div>
                    <div className="text-sm text-gray-400">Click to select file</div>
                    <div className="text-xs text-gray-500 mt-1">Format: {fileHint.label}</div>
                  </div>
                )}
              </div>
              {file && (
                <button
                  type="button"
                  onClick={() => { setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                  className="text-xs text-red-400 hover:text-red-300 mt-1"
                >
                  Remove file
                </button>
              )}
            </div>
          )}

          {/* Live scan hint for S7-1200/1500/Rockwell */}
          {showLiveScanHint && (
            <div className="bg-blue-900/30 border border-blue-700/40 rounded p-3 text-xs text-blue-300">
              <div className="font-medium mb-1">Zwei Optionen:</div>
              <div>1. <strong>XML-Upload</strong>: Bausteine in TIA Portal als XML exportieren, als .zip hochladen (empfohlen - mehr Kontext für AI)</div>
              <div className="mt-1">2. <strong>Live-Scan</strong>: Ohne Datei anlegen - Signale werden per {form.plc_type === 'Rockwell' ? 'EtherNet/IP' : 'OPC UA'} gescannt
                {form.plc_type === 'S7-1500' && ' (OPC UA muss in CPU aktiviert sein)'}
              </div>
              {!file && (
                <div className="mt-1 text-blue-400/70">
                  Ohne Datei wird nach dem Anlegen ein Live-Scan gestartet.
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={uploading}
              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded text-sm font-medium disabled:opacity-50"
            >
              {uploading ? 'Saving...' : isEdit ? 'Save Changes' :
               file ? 'Add & Upload' :
               showLiveScanHint ? 'Add & Scan' : 'Add Machine'}
            </button>
            <button
              type="button" onClick={onClose}
              className="px-4 bg-gray-700 hover:bg-gray-600 text-gray-300 py-2 rounded text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
