import React, { useState, useEffect } from 'react';

const OPERATORS = ['AND', 'OR', 'NOT', '>', '<', '>=', '<=', '==', '!=', '+', '-', '*', '/'];
const ADDRESS_REGEX = /DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g;

function extractAddresses(text) {
  if (!text) return [];
  return [...new Set((text.match(ADDRESS_REGEX) || []).map(addr => addr.trim()))];
}

export default function ExpressionBuilder({ signals, currentMapping, onSave, onCancel }) {
  const [type, setType] = useState(currentMapping?.mapping_type || 'direct');
  const [source, setSource] = useState(currentMapping?.source_address || '');
  const [expression, setExpression] = useState(currentMapping?.expression || '');

  // Sync state when currentMapping changes (e.g. opening editor for different target)
  useEffect(() => {
    setType(currentMapping?.mapping_type || 'direct');
    setSource(currentMapping?.source_address || '');
    setExpression(currentMapping?.expression || '');
  }, [
    currentMapping?.target_signal,
    currentMapping?.mapping_type,
    currentMapping?.source_address,
    currentMapping?.expression
  ]);

  function handleSignalClick(address) {
    if (type === 'direct') {
      setSource(address);
    } else {
      setExpression(prev => prev ? `${prev} ${address}` : address);
    }
  }

  function handleOperator(op) {
    setExpression(prev => prev ? `${prev} ${op} ` : '');
  }

  function handleSave() {
    const mapping = {
      mapping_type: type,
      source_address: type === 'direct' ? source : null,
      expression: type !== 'direct' ? expression : null,
      confidence: 1.0,
      validated_by_human: true
    };
    onSave(mapping);
  }

  // Find comments for signals referenced in the expression
  function getSignal(address) {
    return signals.find(s => s.address === address) || null;
  }

  function getSignalInfo(address) {
    const sig = getSignal(address);
    return sig ? `${sig.name}${sig.comment ? ' // ' + sig.comment : ''}` : '';
  }

  const directAddresses = extractAddresses(source);
  const expressionAddresses = extractAddresses(expression);

  return (
    <div className="mt-2 bg-gray-900 rounded p-3 space-y-2">
      {/* Type selector */}
      <div className="flex gap-2">
        {['direct', 'expression', 'calculated', 'lookup'].map(t => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`text-xs px-2 py-1 rounded ${
              type === t ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Direct mapping */}
      {type === 'direct' && (
        <div>
          <label className="text-xs text-gray-400 block mb-1">Source address:</label>
          <input
            value={source}
            onChange={e => setSource(e.target.value)}
            className="w-full bg-gray-800 text-green-400 text-xs font-mono rounded px-2 py-1.5 border border-gray-700 outline-none focus:border-blue-500"
            placeholder="DB10.DBD0 or I1000.7"
          />
          {directAddresses.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {directAddresses.map(addr => {
                const info = getSignalInfo(addr);
                return (
                  <div key={addr} className="text-[10px] text-gray-500">
                    <span className="text-blue-400/70 font-mono">{addr}</span>
                    {info ? ` ${info}` : ' signal not found in parsed list'}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap gap-1 mt-2 max-h-24 overflow-y-auto">
            {signals.slice(0, 20).map(s => (
              <button
                key={s.address}
                onClick={() => handleSignalClick(s.address)}
                className="text-[10px] bg-gray-700 hover:bg-gray-600 text-blue-300 px-1.5 py-0.5 rounded font-mono"
                title={`${s.name}${s.comment ? ' // ' + s.comment : ''}`}
              >
                {s.address}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Expression/calculated mapping */}
      {(type === 'expression' || type === 'calculated') && (
        <div>
          <label className="text-xs text-gray-400 block mb-1">Expression:</label>
          <textarea
            value={expression}
            onChange={e => setExpression(e.target.value)}
            className="w-full bg-gray-800 text-green-400 text-xs font-mono rounded px-2 py-1.5 border border-gray-700 outline-none focus:border-blue-500 resize-none"
            rows={2}
            placeholder="DB10.DBX4.0 AND DB10.DBD0 > 100"
          />
          {/* Show comments for referenced signals */}
          {expressionAddresses.length > 0 && (() => {
            return (
              <div className="mt-1 space-y-0.5">
                {expressionAddresses.map(addr => {
                  const info = getSignalInfo(addr);
                  return (
                    <div key={addr} className="text-[10px] text-gray-500">
                      <span className="text-blue-400/70 font-mono">{addr}</span>
                      {info ? ` ${info}` : ' signal not found in parsed list'}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {/* Operator buttons */}
          <div className="flex flex-wrap gap-1 mt-1">
            {OPERATORS.map(op => (
              <button
                key={op}
                onClick={() => handleOperator(op)}
                className="text-[10px] bg-gray-700 hover:bg-gray-600 text-yellow-300 px-2 py-0.5 rounded font-mono"
              >
                {op}
              </button>
            ))}
          </div>
          {/* Signal buttons */}
          <div className="flex flex-wrap gap-1 mt-1 max-h-24 overflow-y-auto">
            {signals.slice(0, 30).map(s => (
              <button
                key={s.address}
                onClick={() => handleSignalClick(s.address)}
                className="text-[10px] bg-gray-700 hover:bg-gray-600 text-blue-300 px-1.5 py-0.5 rounded font-mono"
                title={`${s.name}${s.comment ? ' // ' + s.comment : ''}`}
              >
                {s.address}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Lookup mapping */}
      {type === 'lookup' && (
        <div className="text-xs text-gray-500">
          Lookup table editor coming soon. Use expression type for now.
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={type === 'direct' ? !source : !expression}
          className="text-xs bg-green-600 hover:bg-green-500 text-white px-3 py-1 rounded disabled:opacity-50"
        >
          Save Mapping
        </button>
        <button
          onClick={onCancel}
          className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1 rounded"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
