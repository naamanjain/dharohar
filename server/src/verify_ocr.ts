// Imported from the concrete modules rather than the `services/ocr` barrel: the barrel also
// re-exports the browser OCR engine and image preprocessor, which read `import.meta.env` and DOM
// APIs that do not exist under plain Node. This checks the parser, not the browser runtime.
import { parseRevenueRecord } from '../../src/services/ocr/revenueRecordParser';
import {
  SAMPLE_JAMABANDI_OCR_TEXT,
  SAMPLE_KHASRA_GIRDAWARI_OCR_TEXT,
  SAMPLE_MUTATION_OCR_TEXT,
} from '../../src/services/ocr/sampleOcrTexts';

async function testLocalOcr() {
  console.log('--- TEST 1: Jamabandi Devanagari/English Parsing ---');
  const jamabandi = parseRevenueRecord(SAMPLE_JAMABANDI_OCR_TEXT);
  console.log('Khasra No:', jamabandi.data.khasraNo.value, '| Confidence:', jamabandi.data.khasraNo.confidence);
  console.log('Khatauni No:', jamabandi.data.khatauniNo.value);
  console.log('Village:', jamabandi.data.villageMauza.value);
  console.log('Tehsil:', jamabandi.data.tehsil.value);
  console.log('District:', jamabandi.data.district.value);
  console.log('Owners Count:', jamabandi.data.owners.length);
  console.log('Primary Owner:', jamabandi.data.owners[0]?.name, '(', jamabandi.data.owners[0]?.hindiName, ')');
  console.log('Rakba:', jamabandi.data.rakbaArea.bigha, 'Bigha', jamabandi.data.rakbaArea.biswa, 'Biswa | Hectares:', jamabandi.data.rakbaArea.totalHectares);
  console.log('Land Class:', jamabandi.data.landClassification.value);
  console.log('Validation Errors Flagged:', jamabandi.validationErrors.length);

  console.log('\n--- TEST 2: Khasra Girdawari Harvest Inspection ---');
  const girdawari = parseRevenueRecord(SAMPLE_KHASRA_GIRDAWARI_OCR_TEXT);
  console.log('Khasra No:', girdawari.data.khasraNo.value);
  console.log('Village:', girdawari.data.villageMauza.value);
  console.log('Owners:', girdawari.data.owners.map(o => o.name).join(', '));

  console.log('\n--- TEST 3: Mutation (Dakhil Kharij) Record ---');
  const mutation = parseRevenueRecord(SAMPLE_MUTATION_OCR_TEXT);
  console.log('Khasra No:', mutation.data.khasraNo.value);
  console.log('Mutation Date:', mutation.data.mutationDetails.mutationDate);
  console.log('Mutation Type:', mutation.data.mutationDetails.mutationType);

  console.log('\n--- TEST 4: Poor Quality / Unreadable Fallback ---');
  const unreadable = parseRevenueRecord('?? ?? ///// ... unreadable smudge ... ###');
  console.log('Fallback Khasra:', unreadable.data.khasraNo.value);
  console.log('Fallback Owner:', unreadable.data.owners[0]?.name);
  console.log('Fallback Status: Successfully recovered without exception.');

  if (
    jamabandi.data.khasraNo.value &&
    jamabandi.data.owners.length > 0 &&
    jamabandi.data.rakbaArea.totalHectares > 0 &&
    unreadable.data.khasraNo.value
  ) {
    console.log('\n[PASS] All Local OCR and Revenue Parsing tests completed successfully with 0 cloud dependencies.');
  } else {
    throw new Error('OCR validation failed assertions.');
  }
}

testLocalOcr();
