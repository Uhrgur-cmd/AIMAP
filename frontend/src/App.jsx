import React, { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import MappingView from './components/MappingView';
import AddMachineModal from './components/AddMachineModal';
import DataModelEditor from './components/DataModelEditor';
import { api } from './utils/api';

export default function App() {
  const [machines, setMachines] = useState([]);
  const [selectedMachine, setSelectedMachine] = useState(null);
  const [showAddMachine, setShowAddMachine] = useState(false);
  const [editingMachine, setEditingMachine] = useState(null); // null = add mode, object = edit mode
  const [showDataModel, setShowDataModel] = useState(false);
  const [dataModelVersion, setDataModelVersion] = useState(0);

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

  async function handleAddMachine(formData, hasFile) {
    const created = await api.post('/api/machines', formData);
    setMachines(prev => [created, ...prev]);
    setSelectedMachine(created);

    // Auto-trigger live scan ONLY if no file was uploaded
    // (if file was uploaded, signals come from the parser instead)
    const liveScanTypes = ['S7-1200', 'S7-1500', 'Rockwell'];
    if (!hasFile && liveScanTypes.includes(formData.plc_type)) {
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
    alert(`Parsed: ${result.total_signals} signals from ${result.blocks} blocks, ${result.networks} networks`);
    // Refresh machines and force MappingView to reload signals
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

  return (
    <div className="flex h-screen bg-gray-900">
      <Sidebar
        machines={machines}
        selected={selectedMachine}
        onSelect={setSelectedMachine}
        onAdd={openAddModal}
        onEdit={openEditModal}
        onDelete={handleDeleteMachine}
        onDataModel={() => setShowDataModel(true)}
      />

      <main className="flex-1 overflow-hidden">
        {selectedMachine ? (
          <MappingView machine={selectedMachine} onRefresh={loadMachines} dataModelVersion={dataModelVersion} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-2">AIMAP</h2>
              <p>PLC Signal Mapping Platform</p>
              <p className="mt-4 text-sm">Select a machine or add a new one to get started.</p>
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
        <DataModelEditor onClose={() => setShowDataModel(false)} onSave={() => setDataModelVersion(v => v + 1)} />
      )}
    </div>
  );
}
