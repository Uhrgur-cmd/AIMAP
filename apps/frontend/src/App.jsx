import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from './components/Sidebar';
import MappingView from './components/MappingView';
import OpcuaView from './components/OpcuaView';
import AddMachineModal from './components/AddMachineModal';
import DataModelEditor from './components/DataModelEditor';
import { api } from './utils/api';

export default function App() {
  const { t } = useTranslation();
  const [machines, setMachines] = useState([]);
  const [selectedMachine, setSelectedMachine] = useState(null);
  const [showAddMachine, setShowAddMachine] = useState(false);
  const [editingMachine, setEditingMachine] = useState(null);
  const [showDataModel, setShowDataModel] = useState(false);
  const [dataModelVersion, setDataModelVersion] = useState(0);
  const [showOpcua, setShowOpcua]         = useState(false);

  useEffect(() => { loadMachines(); }, []);

  async function loadMachines() {
    try {
      const data = await api.get('/api/machines');
      setMachines(data);
      if (data.length && !selectedMachine) setSelectedMachine(data[0]);
    } catch (err) {
      console.error('Failed to load machines:', err);
    }
  }

  async function handleAddMachine(formData) {
    const created = await api.post('/api/machines', formData);
    setMachines(prev => [created, ...prev]);
    setSelectedMachine(created);

    const liveScanTypes = ['S7-1200', 'S7-1500', 'Rockwell'];
    if (liveScanTypes.includes(formData.plc_type)) {
      try {
        const result = await api.post(`/api/machines/${created.id}/scan-live`);
        alert(`Live-Scan: ${result.signals} signals found`);
        await loadMachines();
      } catch (err) {
        alert('Live-Scan failed: ' + err.message + '\n\nMachine was added. You can retry the scan later.');
      }
    }

    return created;
  }

  async function handleEditMachine(formData) {
    if (!editingMachine) return;
    const updated = await api.put(`/api/machines/${editingMachine.id}`, formData);
    setMachines(prev => prev.map(m => m.id === updated.id ? updated : m));
    if (selectedMachine?.id === updated.id) setSelectedMachine(updated);
    return updated;
  }

  async function handleUploadProjectFile(machineId, file) {
    const result = await api.upload(`/api/machines/${machineId}/upload`, file);
    let msg = `Parsed: ${result.total_signals} signals from ${result.blocks} blocks, ${result.networks} networks`;
    if (result.live_confirmed > 0) {
      msg += `\nLive confirmed: ${result.live_confirmed} (${result.live_confirmed_pct}%)`;
    }
    alert(msg);
    const data = await api.get('/api/machines');
    setMachines(data);
    const updated = data.find(m => m.id === machineId);
    if (updated) setSelectedMachine({ ...updated, _refreshKey: Date.now() });
  }

  async function handleDeleteMachine(id) {
    if (!confirm('Delete this machine and all its mappings?')) return;
    try {
      await api.delete(`/api/machines/${id}`);
      setMachines(prev => prev.filter(m => m.id !== id));
      if (selectedMachine?.id === id) setSelectedMachine(null);
    } catch (err) {
      alert('Failed to delete: ' + err.message);
    }
  }

  function openAddModal() {
    setEditingMachine(null);
    setShowAddMachine(true);
  }

  function openEditModal(machine) {
    setEditingMachine(machine);
    setShowAddMachine(true);
  }

  function closeModal() {
    setShowAddMachine(false);
    setEditingMachine(null);
  }

  // OPC UA Explorer takes over the full screen
  if (showOpcua) {
    return <OpcuaView onBack={() => setShowOpcua(false)} />;
  }

  return (
    <div className="flex h-screen bg-white">
      <Sidebar
        machines={machines}
        selected={selectedMachine}
        onSelect={setSelectedMachine}
        onAdd={openAddModal}
        onEdit={openEditModal}
        onDelete={handleDeleteMachine}
        onDataModel={() => setShowDataModel(true)}
        onOpcua={() => setShowOpcua(true)}
      />

      <main className="flex-1 overflow-hidden">
        {selectedMachine ? (
          <MappingView key={selectedMachine?.id} machine={selectedMachine} onRefresh={loadMachines} dataModelVersion={dataModelVersion} />
        ) : (
          <div className="flex items-center justify-center h-full text-ct-silver">
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-2 text-gray-900">CT-Gate</h2>
              <p className="text-ct-silver">{t('app.welcome.subtitle')}</p>
              <p className="mt-4 text-sm">{t('app.welcome.instructions')}</p>
            </div>
          </div>
        )}
      </main>

      {showAddMachine && (
        <AddMachineModal
          machine={editingMachine}
          onSubmit={editingMachine ? handleEditMachine : handleAddMachine}
          onUpload={handleUploadProjectFile}
          onClose={closeModal}
        />
      )}
      {showDataModel && (
        <DataModelEditor
          onClose={() => setShowDataModel(false)}
          onSaved={() => setDataModelVersion(v => v + 1)}
          machines={machines}
        />
      )}
    </div>
  );
}
