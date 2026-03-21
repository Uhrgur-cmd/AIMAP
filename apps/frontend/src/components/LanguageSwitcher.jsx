import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

const LANGUAGES = [
  { code: 'en',    label: 'EN', flag: '🇬🇧' },
  { code: 'de',    label: 'DE', flag: '🇩🇪' },
  { code: 'es',    label: 'ES', flag: '🇪🇸' },
  { code: 'ro',    label: 'RO', flag: '🇷🇴' },
  { code: 'hu',    label: 'HU', flag: '🇭🇺' },
  { code: 'zh',    label: 'ZH', flag: '🇨🇳' },
  { code: 'pt-BR', label: 'PT', flag: '🇧🇷' }
];

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);

  const current = LANGUAGES.find(l => l.code === i18n.language) || LANGUAGES[0];

  function changeLang(code) {
    i18n.changeLanguage(code);
    localStorage.setItem('ct-gate-lang', code);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 bg-gray-50 hover:bg-gray-100 px-2 py-1 rounded"
        title="Change language"
      >
        <span>{current.flag}</span>
        <span className="font-mono font-semibold">{current.label}</span>
        <span className="text-neutral-600">▾</span>
      </button>

      {open && (
        <>
          {/* backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-1 left-0 z-50 bg-white border border-gray-300 rounded shadow-xl min-w-[140px]">
            {LANGUAGES.map(lang => (
              <button
                key={lang.code}
                onClick={() => changeLang(lang.code)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 transition-colors ${
                  lang.code === i18n.language
                    ? 'text-signal-blue font-semibold'
                    : 'text-gray-500'
                }`}
              >
                <span>{lang.flag}</span>
                <span>{lang.label === 'PT' ? 'Português BR' :
                       lang.label === 'ZH' ? '中文' :
                       lang.label === 'HU' ? 'Magyar' :
                       lang.label === 'RO' ? 'Română' :
                       lang.label === 'ES' ? 'Español' :
                       lang.label === 'DE' ? 'Deutsch' : 'English'}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
