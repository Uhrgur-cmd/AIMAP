import { useTranslation } from 'react-i18next';
import LanguageSwitcher from './LanguageSwitcher';

const PLC_TYPE_COLORS = {
  'S7-300': 'bg-amber-100 text-amber-800 border border-amber-200',
  'S7-400': 'bg-amber-100 text-amber-800 border border-amber-200',
  'S7-1200': 'bg-blue-100 text-blue-800 border border-blue-200',
  'S7-1500': 'bg-blue-100 text-blue-800 border border-blue-200',
  'Rockwell': 'bg-emerald-100 text-emerald-800 border border-emerald-200'
};

export default function Sidebar({ machines, selected, onSelect, onAdd, onEdit, onDelete, onDataModel, onOpcua }) {
  const { t } = useTranslation();

  return (
    <aside className="w-64 bg-brand-navy border-r border-gray-200 flex flex-col">
      {/* Logo — dark brand header */}
      <div className="px-4 py-3 bg-[#2A2A36]">
        <img src="/ct-gate-logo.svg" alt="CT Gate" className="h-10 mb-1" />
        <p className="text-[11px] text-white/50 mt-1">{t('sidebar.subtitle')}</p>
      </div>

      {/* Machine list */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="flex items-center justify-between px-2 py-1 mb-2">
          <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-[0.12em]">{t('sidebar.machines')}</span>
          <button
            onClick={onAdd}
            className="text-[10px] bg-white hover:bg-gray-50 text-gray-600 hover:text-gray-900 border border-gray-300 hover:border-gray-400 font-medium px-2.5 py-1 rounded-md transition-colors shadow-sm"
          >
            {t('sidebar.addButton')}
          </button>
        </div>

        {machines.map(machine => {
          const isSelected = selected?.id === machine.id;
          return (
            <div
              key={machine.id}
              onClick={() => onSelect(machine)}
              className={`flex items-center gap-2.5 p-2 rounded-md cursor-pointer mb-0.5 group transition-all ${
                isSelected
                  ? 'bg-white border-l-2 border-signal-blue shadow-sm'
                  : 'hover:bg-white/60 border-l-2 border-transparent'
              }`}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                machine.status === 'connected'    ? 'bg-emerald-500' :
                machine.status === 'connecting'   ? 'bg-amber-400 animate-pulse' :
                machine.status === 'disconnected' ? 'bg-red-400' :
                machine.status === 'error'        ? 'bg-red-400' : 'bg-gray-300'
              }`}></span>

              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium truncate ${isSelected ? 'text-gray-900' : 'text-gray-700'}`}>
                  {machine.name}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded ${PLC_TYPE_COLORS[machine.plc_type] || 'bg-gray-100 text-gray-600'}`}>
                    {machine.plc_type}
                  </span>
                  <span className="text-[9px] text-gray-400 font-mono truncate">{machine.host}</span>
                </div>
              </div>

              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 flex-shrink-0 transition-opacity">
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit(machine); }}
                  className="text-gray-400 hover:text-signal-blue text-xs p-1 rounded hover:bg-gray-100"
                  title="Edit"
                >&#9998;</button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(machine.id); }}
                  className="text-gray-400 hover:text-red-500 text-xs p-1 rounded hover:bg-gray-100"
                  title="Delete"
                >&times;</button>
              </div>
            </div>
          );
        })}

        {machines.length === 0 && (
          <p className="text-gray-400 text-sm text-center py-8">
            {t('sidebar.noMachines')}
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-gray-200 space-y-1.5">
        <button
          onClick={onOpcua}
          className="w-full text-[11px] text-gray-600 hover:text-gray-900 font-medium bg-white hover:bg-gray-50 border border-gray-200 hover:border-gray-300 rounded-md p-2 transition-colors shadow-sm"
        >
          {t('sidebar.opcuaValues')}
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={onDataModel}
            className="flex-1 text-[11px] text-gray-500 hover:text-gray-700 hover:bg-white/60 rounded-md p-2 transition-colors"
          >
            {t('sidebar.dataModel')}
          </button>
          <LanguageSwitcher />
        </div>
      </div>
    </aside>
  );
}
