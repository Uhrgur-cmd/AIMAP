import React from 'react';

const PLC_TYPE_COLORS = {
  'S7-300': 'bg-orange-500',
  'S7-400': 'bg-orange-600',
  'S7-1200': 'bg-blue-500',
  'S7-1500': 'bg-blue-600',
  'Rockwell': 'bg-green-500'
};

const STATUS_ICONS = {
  connected: { color: 'text-green-400', label: 'Connected' },
  disconnected: { color: 'text-gray-500', label: 'Disconnected' },
  error: { color: 'text-red-400', label: 'Error' }
};

export default function Sidebar({ machines, selected, onSelect, onAdd, onEdit, onDelete, onDataModel }) {
  return (
    <aside className="w-64 bg-gray-800 border-r border-gray-700 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-gray-700">
        <img src="/ct-gate-logo.svg" alt="CT Gate" className="h-12 mb-1" />
        <p className="text-xs text-gray-400">PLC Signal Mapping</p>
      </div>

      {/* Machine list */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="flex items-center justify-between px-2 py-1 mb-2">
          <span className="text-xs font-semibold text-gray-400 uppercase">Machines</span>
          <button
            onClick={onAdd}
            className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded"
          >
            + Add
          </button>
        </div>

        {machines.map(machine => {
          const status = STATUS_ICONS[machine.status] || STATUS_ICONS.disconnected;
          const isSelected = selected?.id === machine.id;

          return (
            <div
              key={machine.id}
              onClick={() => onSelect(machine)}
              className={`flex items-center gap-2 p-2 rounded cursor-pointer mb-1 group ${
                isSelected ? 'bg-gray-700' : 'hover:bg-gray-700/50'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${
                machine.status === 'connected' ? 'bg-green-400' :
                machine.status === 'error' ? 'bg-red-400' : 'bg-gray-500'
              }`}></span>

              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{machine.name}</div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className={`text-xs px-1 rounded ${PLC_TYPE_COLORS[machine.plc_type] || 'bg-gray-600'} text-white`}>
                    {machine.plc_type}
                  </span>
                  <span className="text-xs text-gray-500">{machine.host}</span>
                </div>
              </div>

              {/* Edit + Delete buttons on hover */}
              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit(machine); }}
                  className="text-gray-500 hover:text-blue-400 text-xs p-1"
                  title="Edit"
                >
                  &#9998;
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(machine.id); }}
                  className="text-gray-500 hover:text-red-400 text-xs p-1"
                  title="Delete"
                >
                  &times;
                </button>
              </div>
            </div>
          );
        })}

        {machines.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-8">
            No machines added yet.
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-gray-700">
        <button
          onClick={onDataModel}
          className="w-full text-xs text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded p-2"
        >
          Standard Data Model
        </button>
      </div>
    </aside>
  );
}
