/**
 * DHAROHAR - Sample OCR Raw Text Fixtures & Parser Self-Test
 * 
 * Provides offline bilingual test cases representing realistic Rajasthan revenue records:
 * 1. Sample Jamabandi (RoR - Record of Rights)
 * 2. Sample Khasra Girdawari (Harvest Inspection)
 * 3. Sample Dakhil Kharij (Mutation Register)
 */

import { parseRevenueRecord } from './revenueRecordParser';

export const SAMPLE_JAMABANDI_OCR_TEXT = `
प्रारूप जमाबंदी (खतौनी) • RECORD OF RIGHTS
राजस्थान सरकार • राजस्व मण्डल
Form No. 18 (See Rule 153)
वर्ष / संवत्: 2081 (2024-2025)

ज़िला: Jaipur (जयपुर)
तहसील: Sanganer (सांगानेर)
पटवार वृत्त: PC-14 Rampur Kalan
मौज़ा / गाँव: Rampur (रामपुर)

खसरा संख्या: 412/1
खाता संख्या: 78
खेवट संख्या: 19

खातेदार का नाम व हिस्सा:
1. Harish Chandra Verma पुत्र Ganga Ram Verma हिस्सा 1/2 (50%)
2. Prakash Chandra Verma पुत्र Ganga Ram Verma हिस्सा 1/2 (50%)

रकबा (क्षेत्रफल): 5 बीघा 4 बिस्वा (1.315 Hectares / 3.25 Acres)
भूमि वर्गीकरण: चाही (Well Irrigated)
मृदा वर्ग: दोमट द्वितीय (Domat II)
लगान / वार्षिक राजस्व: ₹290.00

कैफियत व विशेष विवरण:
State Bank of India (Mortgage Lien ₹4,50,000). No active court stay order.
`;

export const SAMPLE_KHASRA_GIRDAWARI_OCR_TEXT = `
खसरा गिरदावरी • HARVEST INSPECTION REGISTER
राजस्थान भू-राजस्व अधिनियम १९५६

ज़िला: Udaipur (उदयपुर)
तहसील: Girwa (गिर्वा)
पटवार वृत्त: PC-09 Kothari
मौज़ा / गाँव: Kothari (कोठारी)

खसरा नं.: 77/1
खाता संख्या: 104
खेवट नं.: 12

खातेदार का विवरण:
1. Savitri Devi पत्नी Late Mohan Lal Sharma हिस्सा 1/1 (100%)

रकबा: 3 बीघा 16 बिस्वा (0.96 Hectares)
भूमि किस्म: बारानी (Rainfed)
लगान: ₹185.50

विशेष कैफियत:
★ COURT STAY ACTIVE: Case No. 89/2023 SDM Court Girwa. Stay on alienation.
`;

export const SAMPLE_MUTATION_OCR_TEXT = `
दाखिल खारिज पंजीयन • DAKHIL KHARIJ (MUTATION REGISTER)
तहसीलदार कार्यालय Mandore

ज़िला: Jodhpur (जोधपुर)
तहसील: Mandore (मंडोर)
मौज़ा / गाँव: Pal (पाल)
पटवार वृत्त: PC-03 Pal Gaon

दाखिल खारिज संख्या: Mut-2023/1092
खसरा नं.: 508/3
खाता सं.: 112
खेवट सं.: 14

खातेदार:
1. Bhawani Singh पुत्र Rajendra Singh हिस्सा 1/1 (100%)

रकबा: 8 बीघा 0 बिस्वा (2.023 Hectares)
भूमि प्रकार: नहरी (Canal Irrigated)
लगान: ₹450.00
नामांतरण प्रकार: बैनामा (Sale Deed)
स्वीकृति अधिकारी: तहसीलदार मंडोर
`;

/**
 * Runs a deterministic parser self-test on test fixtures
 */
export function runParserSelfTest() {
  const jamabandiResult = parseRevenueRecord(SAMPLE_JAMABANDI_OCR_TEXT);
  const girdawariResult = parseRevenueRecord(SAMPLE_KHASRA_GIRDAWARI_OCR_TEXT);
  const mutationResult = parseRevenueRecord(SAMPLE_MUTATION_OCR_TEXT);

  return {
    jamabandi: {
      khasraNo: jamabandiResult.data.khasraNo.value,
      khatauniNo: jamabandiResult.data.khatauniNo.value,
      khewatNo: jamabandiResult.data.khewatNo.value,
      village: jamabandiResult.data.villageMauza.value,
      tehsil: jamabandiResult.data.tehsil.value,
      district: jamabandiResult.data.district.value,
      ownersCount: jamabandiResult.data.owners.length,
      bigha: jamabandiResult.data.rakbaArea.bigha,
      totalHectares: jamabandiResult.data.rakbaArea.totalHectares,
      landClass: jamabandiResult.data.landClassification.value,
      lagaan: jamabandiResult.data.annualLagaanRevenue.value,
      isMortgaged: jamabandiResult.data.encumbrance.isMortgaged,
      hasErrors: jamabandiResult.validationErrors.length > 0,
    },
    girdawari: {
      khasraNo: girdawariResult.data.khasraNo.value,
      khatauniNo: girdawariResult.data.khatauniNo.value,
      village: girdawariResult.data.villageMauza.value,
      courtStay: girdawariResult.data.encumbrance.courtInjunctionActive,
      ownersCount: girdawariResult.data.owners.length,
      landClass: girdawariResult.data.landClassification.value,
    },
    mutation: {
      khasraNo: mutationResult.data.khasraNo.value,
      khatauniNo: mutationResult.data.khatauniNo.value,
      village: mutationResult.data.villageMauza.value,
      ownersCount: mutationResult.data.owners.length,
      landClass: mutationResult.data.landClassification.value,
    },
  };
}
