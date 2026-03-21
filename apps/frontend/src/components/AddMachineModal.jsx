import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';

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
  'Rockwell': { accept: '.l5x', label: '.L5X (Studio 5000 Export)' }
};

const LIVE_SCAN_TYPES = ['S7-1200', 'S7-1500', 'Rockwell'];

export default function AddMachineModal({ machine, onSubmit, onClose, onUpload }) {
  const { t } = useTranslation();
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
      const result = await onSubmit(form);
      if (file && onUpload) {
        const machineId = result?.id || machine?.id;
        if (machineId) await onUpload(machineId, file);
      }
      onClose();
    } catch (err) {
      alert(t('modal.failed') + err.message);
    } finally {
      setUploading(false);
    }
  }

  const showRackSlot = form.plc_type !== 'Rockwell';
  const showOpcua = form.plc_type === 'S7-1200';
  const showFileUpload = !LIVE_SCAN_TYPES.includes(form.plc_type);
  const showLiveScanHint = LIVE_SCAN_TYPES.includes(form.plc_type);
  const fileHint = FILE_HINTS[form.plc_type];
  const protocol = form.use_opcua ? 'OPC UA' : 'S7';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 border border-gray-200" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-gray-900 mb-4">
          {isEdit ? t('modal.editTitle') : t('modal.addTitle')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-500 mb-1">{t('modal.machineName')}</label>
            <input
              name="name" value={form.name} onChange={handleChange}
              className="w-full bg-gray-50 text-gray-900 rounded px-3 py-2 text-sm border border-gray-300 focus:border-signal-blue outline-none"
              placeholder={t('modal.machineNamePlaceholder')}
              required
            />
          </div>

          <div>
            <label className="block text-sm text-gray-500 mb-1">{t('modal.plcType')}</label>
            <select
              name="plc_type" value={form.plc_type} onChange={handleChange}
              className="w-full bg-gray-50 text-gray-900 rounded px-3 py-2 text-sm border border-gray-300 focus:border-signal-blue outline-none"
              disabled={isEdit}
            >
              {PLC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm text-gray-500 mb-1">{t('modal.ipAddress')}</label>
            <input
              name="host" value={form.host} onChange={handleChange}
              className="w-full bg-gray-50 text-gray-900 rounded px-3 py-2 text-sm border border-gray-300 focus:border-signal-blue outline-none"
              placeholder="192.168.1.10"
              required
            />
          </div>

          {showRackSlot && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-500 mb-1">{t('modal.rack')}</label>
                <input
                  name="rack" type="number" value={form.rack} onChange={handleChange}
                  className="w-full bg-gray-50 text-gray-900 rounded px-3 py-2 text-sm border border-gray-300 focus:border-signal-blue outline-none"
                  min="0" max="7"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-500 mb-1">{t('modal.slot')}</label>
                <input
                  name="slot" type="number" value={form.slot} onChange={handleChange}
                  className="w-full bg-gray-50 text-gray-900 rounded px-3 py-2 text-sm border border-gray-300 focus:border-signal-blue outline-none"
                  min="0" max="31"
                />
              </div>
            </div>
          )}

          {showOpcua && (
            <label className="flex items-center gap-2 text-sm text-gray-500">
              <input
                name="use_opcua" type="checkbox" checked={form.use_opcua} onChange={handleChange}
                className="rounded bg-gray-50 border-gray-300"
              />
              {t('modal.opcuaToggle')}
            </label>
          )}

          {showFileUpload && fileHint && (
            <div>
              <label className="block text-sm text-gray-500 mb-1">
                {t('modal.projectFile')} <span className="text-neutral-600">{t('modal.optional')}</span>
              </label>
              <div
                className="border border-dashed border-gray-300 rounded p-3 text-center cursor-pointer hover:border-signal-blue hover:bg-gray-50/30 transition-colors"
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
                  <div className="text-sm text-signal-blue">
                    {file.name}
                    <span className="text-gray-500 ml-2">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
                  </div>
                ) : (
                  <div>
                    <div className="text-sm text-gray-500">{t('modal.clickToSelect')}</div>
                    <div className="text-xs text-neutral-600 mt-1">{t('modal.format')} {fileHint.label}</div>
                  </div>
                )}
              </div>
              {file && (
                <button
                  type="button"
                  onClick={() => { setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                  className="text-xs text-red-400 hover:text-red-500 mt-1"
                >
                  {t('modal.removeFile')}
                </button>
              )}
            </div>
          )}

          {showLiveScanHint && (
            <div className="bg-signal-blue/10 border border-signal-blue/30 rounded p-3 text-xs text-signal-blue">
              {form.plc_type === 'Rockwell'
                ? t('modal.liveScanHint.rockwell')
                : t('modal.liveScanHint.s7', { protocol }) +
                  (form.plc_type === 'S7-1500' ? t('modal.liveScanHint.opcuaNote') : '')
              }
              <div className="mt-1 text-signal-blue/70">{t('modal.liveScanHint.afterAdd')}</div>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={uploading}
              className="flex-1 bg-signal-blue hover:bg-signal-blue-hover text-black font-semibold py-2 rounded text-sm disabled:opacity-50"
            >
              {uploading ? t('modal.saving') :
               isEdit ? t('modal.saveChanges') :
               showLiveScanHint ? t('modal.addScan') : t('modal.addMachine')}
            </button>
            <button
              type="button" onClick={onClose}
              className="px-4 bg-gray-50 hover:bg-gray-100 text-gray-500 py-2 rounded text-sm"
            >
              {t('modal.cancel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
