import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import de from './locales/de.json';
import es from './locales/es.json';
import ro from './locales/ro.json';
import hu from './locales/hu.json';
import zh from './locales/zh.json';
import ptBR from './locales/pt-BR.json';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      de: { translation: de },
      es: { translation: es },
      ro: { translation: ro },
      hu: { translation: hu },
      zh: { translation: zh },
      'pt-BR': { translation: ptBR }
    },
    lng: localStorage.getItem('ct-gate-lang') || 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false }
  });

export default i18n;
