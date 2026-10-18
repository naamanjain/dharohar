import { TRANSLATIONS } from '../../src/i18n/translations';

function testI18n() {
  console.log('--- Testing English and Hindi Translation Dictionaries ---');
  const en = TRANSLATIONS.en;
  const hi = TRANSLATIONS.hi;

  const sections = Object.keys(en) as Array<keyof typeof en>;
  console.log('Sections present in EN dictionary:', sections.join(', '));

  let missingInHi: string[] = [];
  for (const sec of sections) {
    if (!hi[sec]) {
      missingInHi.push(`Section missing: ${sec}`);
      continue;
    }
    const enKeys = Object.keys(en[sec]);
    const hiKeys = Object.keys(hi[sec]);
    for (const k of enKeys) {
      if (!(k in (hi[sec] as any))) {
        missingInHi.push(`Key missing in hi.${sec}: ${k}`);
      }
    }
  }

  if (missingInHi.length > 0) {
    console.warn('Discrepancies found in translations:', missingInHi);
  } else {
    console.log('[PASS] Full structural parity between English and Hindi translation dictionaries!');
  }

  // Check some key terms
  console.log('\nSample Terms:');
  console.log('EN title:', en.app.title, '| HI title:', hi.app.title);
  console.log('EN subtitle:', en.app.subtitle, '| HI subtitle:', hi.app.subtitle);
  console.log('EN nav.fieldVerification:', en.nav.fieldVerification, '| HI nav.fieldVerification:', hi.nav.fieldVerification);
  console.log('EN nav.spatialRegistry:', en.nav.spatialRegistry, '| HI nav.spatialRegistry:', hi.nav.spatialRegistry);
  console.log('EN common.verify:', en.common.verify, '| HI common.verify:', hi.common.verify);

  if (missingInHi.length === 0) {
    console.log('\n[PASS] Language Validation check succeeded.');
  } else {
    throw new Error('Language validation failed.');
  }
}

testI18n();
