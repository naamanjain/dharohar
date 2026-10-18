import { useApp } from '../context/AppContext';
import { TRANSLATIONS, LanguageCode } from './translations';

export function useTranslation() {
  const { systemLanguage, toggleLanguage, setLanguage } = useApp();
  const lang = (systemLanguage === 'hi' ? 'hi' : 'en') as LanguageCode;
  const t = TRANSLATIONS[lang];

  return {
    t,
    lang,
    isHindi: lang === 'hi',
    toggleLanguage,
    setLanguage,
  };
}
