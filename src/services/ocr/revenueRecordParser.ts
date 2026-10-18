/**
 * DHAROHAR - Deterministic Rajasthan Land Revenue Record Parser
 * 
 * Pure TypeScript rule & regex parser:
 * - Parses raw OCR text into structured LandRecordData
 * - Handles bilingual English and Hindi/Devanagari scripts
 * - Converts Devanagari numerals (०-९) to standard Arabic numerals (0-9)
 * - Extracts Khasra, Khatauni, Khewat, Jurisdiction, Co-sharers, Rakba math, Land Class, Lagaan
 * - Links extracted fields to spatial BoundingBox coordinates where available
 * - Does NOT invent missing fields (marks low confidence / source flags)
 * - Disclaims legal correctness for human verification workflows
 */

import type {
  BoundingBox,
  ExtractedField,
  LandOwner,
  LandRecordData,
  ValidationError,
} from '../../types';
import type { OcrEngineResult, OcrLineItem } from './localOcrEngine';

export interface ParsedRevenueRecord {
  isRecordRecognized: boolean;
  detectedRecordType: string;
  data: LandRecordData;
  validationErrors: ValidationError[];
  rawText: string;
  sourceConfidence: number;
  extractionSummary: {
    fieldsExtractedCount: number;
    highConfidenceFields: number;
    lowConfidenceFields: number;
    warnings: string[];
  };
}

/**
 * Hindi to English numeral map
 */
const HINDI_TO_ENG_DIGITS: Record<string, string> = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
};

const ENG_TO_HINDI_DIGITS: Record<string, string> = {
  '0': '०', '1': '१', '2': '२', '3': '३', '4': '४',
  '5': '५', '6': '६', '7': '७', '8': '८', '9': '९',
};

/**
 * Converts Devanagari numerals to standard digits
 */
export function normalizeHindiNumerals(text: string): string {
  if (!text) return '';
  return text.replace(/[०-९]/g, (char) => HINDI_TO_ENG_DIGITS[char] || char);
}

/**
 * Converts standard digits to Devanagari numerals
 */
export function toDevanagariNumerals(text: string): string {
  if (!text) return '';
  return text.replace(/[0-9]/g, (char) => ENG_TO_HINDI_DIGITS[char] || char);
}

/**
 * Finds bounding box for a given target substring or token in OCR lines/words
 */
function findBoundingBoxForText(
  target: string,
  ocrLines: OcrLineItem[] = [],
  fieldName: string
): BoundingBox | undefined {
  if (!target || !ocrLines.length) return undefined;

  const cleanTarget = target.trim().toLowerCase();
  const cleanTargetAscii = normalizeHindiNumerals(cleanTarget);

  for (const line of ocrLines) {
    const lineText = line.text.toLowerCase();
    const lineTextAscii = normalizeHindiNumerals(lineText);

    if (lineText.includes(cleanTarget) || lineTextAscii.includes(cleanTargetAscii)) {
      return {
        ...line.bbox,
        field: fieldName,
      };
    }

    for (const w of line.words) {
      const wText = w.text.toLowerCase();
      const wTextAscii = normalizeHindiNumerals(wText);
      if (wText === cleanTarget || wTextAscii === cleanTargetAscii || cleanTarget.includes(wText)) {
        return {
          ...w.bbox,
          field: fieldName,
        };
      }
    }
  }

  return undefined;
}

/**
 * Helper to build an ExtractedField
 */
function makeExtractedField<T>(
  value: T,
  originalOcr: string,
  confidence: number,
  fieldName: string,
  ocrLines: OcrLineItem[] = [],
  hindiValue?: string,
  isFlagged = false,
  flagReason?: string
): ExtractedField<T> {
  const bbox = findBoundingBoxForText(originalOcr || String(value), ocrLines, fieldName);
  return {
    value,
    hindiValue: hindiValue || (typeof value === 'string' ? toDevanagariNumerals(value) : undefined),
    originalOcr: originalOcr || (value !== null && value !== undefined ? String(value) : '—'),
    confidence: Number(Math.min(100, Math.max(0, confidence)).toFixed(1)),
    bbox,
    isFlagged,
    flagReason,
  };
}

/**
 * Extract Khasra Number
 */
function extractKhasraNo(text: string, ocrLines: OcrLineItem[]): ExtractedField<string> {
  const normalized = normalizeHindiNumerals(text);
  
  // Pattern: खसरा नं. 412/1 or Khasra No 77A or Survey 412/2-A
  const match = 
    normalized.match(/(?:खसरा\s*(?:नं[०-९\.]*|संख्या|नंबर)?|Khasra\s*(?:No\.?|Number|#)?)\s*[:=\-\s]*([0-9]+(?:\/[0-9]+)?(?:[a-zA-Z]|\-[a-zA-Z0-9]+)?)/i) ||
    normalized.match(/(?:Survey\s*(?:No\.?|Number)?)\s*[:=\-\s]*([0-9]+(?:\/[0-9]+)?(?:[a-zA-Z]|\-[a-zA-Z0-9]+)?)/i) ||
    text.match(/([०-९]+(?:\/[०-९]+)?)/);

  if (match && match[1]) {
    const val = match[1].trim();
    const hindiVal = toDevanagariNumerals(val);
    return makeExtractedField(val, match[0], 95.0, 'khasraNo', ocrLines, hindiVal);
  }

  return makeExtractedField('—', '', 20.0, 'khasraNo', ocrLines, '—', true, 'Khasra number not clearly identified in OCR text');
}

/**
 * Extract Khatauni / Khata Number
 */
function extractKhatauniNo(text: string, ocrLines: OcrLineItem[]): ExtractedField<string> {
  const normalized = normalizeHindiNumerals(text);

  const match =
    normalized.match(/(?:खाता\s*(?:संख्या|सं[\.०-९]*|नंबर)?|खतौनी\s*(?:संख्या|सं[\.०-९]*|नंबर)?|Khatauni\s*(?:No\.?|Number)?|Khata\s*(?:No\.?|Number)?)\s*[:=\-\s]*([0-9]+(?:\/[0-9]+)?)/i);

  if (match && match[1]) {
    const val = match[1].trim();
    const hindiVal = toDevanagariNumerals(val);
    return makeExtractedField(val, match[0], 93.5, 'khatauniNo', ocrLines, hindiVal);
  }

  return makeExtractedField('—', '', 20.0, 'khatauniNo', ocrLines, '—', true, 'Khatauni number not clearly identified in OCR text');
}

/**
 * Extract Khewat Number
 */
function extractKhewatNo(text: string, ocrLines: OcrLineItem[]): ExtractedField<string> {
  const normalized = normalizeHindiNumerals(text);

  const match =
    normalized.match(/(?:खेवट\s*(?:संख्या|सं[\.०-९]*|नंबर)?|Khewat\s*(?:No\.?|Number)?)\s*[:=\-\s]*([0-9]+)/i);

  if (match && match[1]) {
    const val = match[1].trim();
    const hindiVal = toDevanagariNumerals(val);
    return makeExtractedField(val, match[0], 94.0, 'khewatNo', ocrLines, hindiVal);
  }

  return makeExtractedField('—', '', 0, 'khewatNo', ocrLines, '—', true, 'Khewat number not present in OCR text');
}

/**
 * Extract Village / Mauza
 */
function extractVillage(text: string, ocrLines: OcrLineItem[]): ExtractedField<string> {
  const match =
    text.match(/(?:मौज़ा|मौजा|गांव|गाँव|ग्राम|Village|Mauza)\s*[:=\-\s]*([A-Za-z\u0900-\u097F]+(?:\s+[A-Za-z\u0900-\u097F]+)?)/i);

  if (match && match[1]) {
    const val = match[1].trim().replace(/[,\.;:]/g, '');
    return makeExtractedField(val, match[0], 96.0, 'villageMauza', ocrLines, val);
  }

  const commonVillages = ['Rampur', 'रामपुर', 'Kothari', 'कोठारी', 'Pal', 'पाल', 'Sanganer', 'सांगानेर', 'Amer', 'आमेर'];
  for (const v of commonVillages) {
    if (text.includes(v)) {
      return makeExtractedField(v, v, 88.0, 'villageMauza', ocrLines, v);
    }
  }

  return makeExtractedField('—', '', 0, 'villageMauza', ocrLines, '—', true, 'Mauza/village not present in OCR text');
}

/**
 * Extract Patwar Circle
 */
function extractPatwarCircle(text: string, ocrLines: OcrLineItem[]): ExtractedField<string> {
  const match =
    text.match(/(?:पटवार\s*(?:वृत्त|हल्का|मंडल)|Patwar\s*Circle|PC[\-–])\s*[:=\-\s]*([A-Za-z0-9\u0900-\u097F\s\-]+?)(?=[,\n\r;]|Tehsil|तहसील|$)/i);

  if (match && match[1]) {
    const val = match[1].trim();
    return makeExtractedField(val, match[0], 92.0, 'patwarCircle', ocrLines, val);
  }

  return makeExtractedField('—', '', 0, 'patwarCircle', ocrLines, '—', true, 'Patwar circle not present in OCR text');
}

/**
 * Extract Tehsil
 */
function extractTehsil(text: string, ocrLines: OcrLineItem[]): ExtractedField<string> {
  const match =
    text.match(/(?:तहसील|Tehsil|Sub-Division)\s*[:=\-\s]*([A-Za-z\u0900-\u097F]+)/i);

  if (match && match[1]) {
    const val = match[1].trim();
    return makeExtractedField(val, match[0], 97.0, 'tehsil', ocrLines, val);
  }

  const knownTehsils = ['Sanganer', 'सांगानेर', 'Girwa', 'गिर्वा', 'Mandore', 'मंडोर', 'Amer', 'Jaipur', 'जयपुर'];
  for (const t of knownTehsils) {
    if (text.includes(t)) {
      return makeExtractedField(t, t, 90.0, 'tehsil', ocrLines, t);
    }
  }

  return makeExtractedField('—', '', 0, 'tehsil', ocrLines, '—', true, 'Tehsil not present in OCR text');
}

/**
 * Extract District
 */
function extractDistrict(text: string, ocrLines: OcrLineItem[]): ExtractedField<string> {
  const match =
    text.match(/(?:ज़िला|जिला|District)\s*[:=\-\s]*([A-Za-z\u0900-\u097F]+)/i);

  if (match && match[1]) {
    const val = match[1].trim();
    return makeExtractedField(val, match[0], 98.0, 'district', ocrLines, val);
  }

  const rajasthanDistricts = ['Jaipur', 'जयपुर', 'Jodhpur', 'जोधपुर', 'Udaipur', 'उदयपुर', 'Kota', 'कोटा', 'Ajmer', 'अजमेर', 'Bikaner', 'बीकानेर', 'Alwar', 'अलवर'];
  for (const d of rajasthanDistricts) {
    if (text.includes(d)) {
      return makeExtractedField(d, d, 92.0, 'district', ocrLines, d);
    }
  }

  return makeExtractedField('—', '', 0, 'district', ocrLines, '—', true, 'District not present in OCR text');
}

/**
 * Extract Settlement Year
 */
function extractSettlementYear(text: string, ocrLines: OcrLineItem[]): ExtractedField<string> {
  const normalized = normalizeHindiNumerals(text);

  const match =
    normalized.match(/(?:संवत्|वर्ष|Samvat|Year|Settlement\s*Year)\s*[:=\-\s]*([0-9]{4}(?:-[0-9]{2,4})?)/i) ||
    normalized.match(/(20[12][0-9](?:-[0-9]{2,4})?)/);

  if (match && match[1]) {
    const val = match[1].trim();
    return makeExtractedField(val, match[0], 95.0, 'settlementYear', ocrLines, toDevanagariNumerals(val));
  }

  return makeExtractedField('—', '', 0, 'settlementYear', ocrLines, '—', true, 'Settlement year not present in OCR text');
}

/**
 * Extract Land Classification
 */
function extractLandClassification(
  text: string,
  ocrLines: OcrLineItem[]
): ExtractedField<'Chahi (Well Irrigated)' | 'Nahri (Canal Irrigated)' | 'Barani (Rainfed)' | 'Gair Mumkin (Non-arable / Built-up)' | 'Banjar Jadid / Qadeem (Fallow)' | '—'> {
  if (/चाही|Chahi|Well\s*Irrigated/i.test(text)) {
    return makeExtractedField('Chahi (Well Irrigated)', 'Chahi / चाही', 96.0, 'landClassification', ocrLines, 'चाही (कुंआ सिंचित)');
  }
  if (/नहरी|Nahri|Canal\s*Irrigated/i.test(text)) {
    return makeExtractedField('Nahri (Canal Irrigated)', 'Nahri / नहरी', 95.0, 'landClassification', ocrLines, 'नहरी (नहर सिंचित)');
  }
  if (/बारानी|Barani|Rainfed/i.test(text)) {
    return makeExtractedField('Barani (Rainfed)', 'Barani / बारानी', 94.0, 'landClassification', ocrLines, 'बारानी (असिंचित वर्षाधीन)');
  }
  if (/गैर\s*मुमकिन|Gair\s*Mumkin|Non-arable|Built-up/i.test(text)) {
    return makeExtractedField('Gair Mumkin (Non-arable / Built-up)', 'Gair Mumkin', 95.0, 'landClassification', ocrLines, 'गैर मुमकिन (आबादी/अकृषि)');
  }
  if (/बंजर|Banjar|Fallow/i.test(text)) {
    return makeExtractedField('Banjar Jadid / Qadeem (Fallow)', 'Banjar / बंजर', 93.0, 'landClassification', ocrLines, 'बंजर जदीद/कदीम');
  }

  return makeExtractedField('—', '', 0, 'landClassification', ocrLines, '—', true, 'Land class not identifiable from OCR text');
}

/**
 * Extract Rakba / Land Area
 */
function extractRakbaArea(text: string): {
  bigha: number;
  biswa: number;
  biswansi: number;
  totalHectares: number;
  standardAcre: number;
  confidence: number;
  isFlagged: boolean;
  flagReason?: string;
} {
  const normalized = normalizeHindiNumerals(text);

  let bigha = 0;
  let biswa = 0;
  let biswansi = 0;
  let explicitHectares = 0;

  const bighaMatch = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:बीघा|bigha|बी)/i);
  if (bighaMatch) {
    bigha = parseFloat(bighaMatch[1]) || 0;
  }

  const biswaMatch = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:बिस्वा|biswa|बि)/i);
  if (biswaMatch) {
    biswa = parseFloat(biswaMatch[1]) || 0;
  }

  const biswansiMatch = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:बिस्वांसी|biswansi|बिस्वांशी)/i);
  if (biswansiMatch) {
    biswansi = parseFloat(biswansiMatch[1]) || 0;
  }

  const hecMatch = normalized.match(/([0-9]+\.[0-9]+|[0-9]+)\s*(?:हेक्टेयर|हेक्टयर|हे\.?|hectares?|ha)/i);
  if (hecMatch) {
    explicitHectares = parseFloat(hecMatch[1]) || 0;
  }

  let totalHectares = explicitHectares;
  if (!totalHectares && (bigha > 0 || biswa > 0)) {
    const totalBigha = bigha + biswa / 20 + biswansi / 400;
    totalHectares = Number((totalBigha * 0.2529).toFixed(3));
  }

  const areaFound = Boolean(bighaMatch || biswaMatch || hecMatch);
  const standardAcre = Number((totalHectares * 2.47105).toFixed(2));

  return {
    bigha: Math.floor(bigha),
    biswa: Math.floor(biswa),
    biswansi: Math.floor(biswansi),
    totalHectares,
    standardAcre,
    confidence: areaFound ? 94.0 : 0,
    isFlagged: !areaFound,
    flagReason: areaFound ? undefined : 'Rakba (area) not present in OCR text',
  };
}

/**
 * Extract Owners / Co-sharers Ledger
 */
function extractOwners(text: string): LandOwner[] {
  const owners: LandOwner[] = [];
  const normalized = normalizeHindiNumerals(text);

  const lines = normalized.split(/\r?\n/);
  let idCounter = 1;

  for (const line of lines) {
    const ownerMatch =
      line.match(/([A-Za-z\u0900-\u097F\s\.]+?)\s*(?:s\/o|w\/o|d\/o|c\/o|पुत्र|सुपुत्र|वल्द|पत्नी|सुपुत्री)\s*([A-Za-z\u0900-\u097F\s\.]+)/i);

    if (ownerMatch && ownerMatch[1] && ownerMatch[2]) {
      const name = ownerMatch[1].trim().replace(/^[0-9\.\-\s]+/, '');
      const relativeName = ownerMatch[2].trim().replace(/[,\.;:]/g, '');

      if (name.length > 2 && relativeName.length > 2) {
        let shareFraction = '1/2';
        let sharePercentage = 50.0;

        const shareMatch = line.match(/([0-9]+)\s*\/\s*([0-9]+)/);
        if (shareMatch) {
          const num = parseInt(shareMatch[1], 10);
          const den = parseInt(shareMatch[2], 10);
          if (den > 0) {
            shareFraction = `${num}/${den}`;
            sharePercentage = Number(((num / den) * 100).toFixed(2));
          }
        }

        const isDeceased = /मृतक|स्वर्गीय|deceased|मृ\./i.test(line);

        owners.push({
          id: `own-parsed-${idCounter++}`,
          name,
          hindiName: name,
          relationType: /पत्नी|w\/o/i.test(line) ? 'w/o' : /सुपुत्री|d\/o/i.test(line) ? 'd/o' : 's/o',
          relativeName,
          relativeHindiName: relativeName,
          shareFraction,
          sharePercentage,
          status: isDeceased ? 'Deceased (Mutation Pending)' : 'Active Co-sharer',
        });
      }
    }
  }

  // Nothing was recognised: return an empty ledger rather than inventing co-sharers. A
  // fabricated name on a record of rights is worse than a visibly missing one.
  return owners;
}

/**
 * Extract Annual Lagaan / Revenue
 */
function extractLagaan(text: string, ocrLines: OcrLineItem[]): ExtractedField<number> {
  const normalized = normalizeHindiNumerals(text);

  const match = normalized.match(/(?:लगान|Lagaan|Revenue|भू-राजस्व)\s*[:=\-\s]*(?:₹|Rs\.?|INR)?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (match && match[1]) {
    const val = parseFloat(match[1]);
    return makeExtractedField(val, match[0], 95.0, 'annualLagaanRevenue', ocrLines);
  }

  return makeExtractedField(0, '', 0, 'annualLagaanRevenue', ocrLines, undefined, true, 'Annual lagaan/revenue not present in OCR text');
}

/**
 * Extract Encumbrance & Mortgage
 *
 * Term matching runs per clause with an explicit negation check. A single regex over the whole
 * document read "No active court stay order" as an ACTIVE injunction, flagging a clear title as
 * disputed — and then invented a case number to go with it.
 */
const NEGATION = /\b(no|not|none|nil|n\/a|free|without|absent)\b|नहीं|शून्य/i;
const INJUNCTION_TERM = /स्थगन|स्टे|court\s*stay|stay\s*order|\bstay\b|injunction|litigation|dispute|वाद|विवाद/i;
const MORTGAGE_TERM = /बंधक|रहना|mortgage|lien|bank\s*loan|ऋण/i;

/** True only when a clause asserts the condition; clauses that deny it are ignored. */
function clauseAsserts(text: string, term: RegExp): boolean {
  return text
    .split(/[;.\n|]+/)
    .some((clause) => term.test(clause) && !NEGATION.test(clause));
}

function extractEncumbrance(text: string): {
  isMortgaged: boolean;
  bankName?: string;
  loanAccountNo?: string;
  mortgageAmountINR?: number;
  courtInjunctionActive: boolean;
  courtCaseRef?: string;
  remarks?: string;
} {
  const isMortgaged = clauseAsserts(text, MORTGAGE_TERM);
  const courtInjunctionActive = clauseAsserts(text, INJUNCTION_TERM);

  let bankName: string | undefined;
  if (isMortgaged) {
    if (/SBI|State Bank/i.test(text)) bankName = 'State Bank of India';
    else if (/PNB|Punjab National/i.test(text)) bankName = 'Punjab National Bank';
    else if (/Gramin|मरुधरा/i.test(text)) bankName = 'Rajasthan Marudhara Gramin Bank';
  }

  const accountMatch = text.match(/(?:A\/?C|Account|खाता)\s*(?:No\.?|नं\.?|सं\.?)?\s*[:\-]?\s*([A-Z0-9\-\/]{6,})/i);
  const caseMatch = text.match(/(?:Case|वाद|प्रकरण)\s*(?:No\.?|सं\.?)?\s*[:\-]?\s*([A-Za-z0-9\/\-]+)/i);

  return {
    isMortgaged,
    bankName,
    loanAccountNo: isMortgaged ? accountMatch?.[1] : undefined,
    courtInjunctionActive,
    // Only ever a case reference that was actually printed on the document.
    courtCaseRef: courtInjunctionActive ? caseMatch?.[1] : undefined,
    remarks: isMortgaged || courtInjunctionActive
      ? [
          isMortgaged ? `Mortgage/lien clause detected${bankName ? ` in favour of ${bankName}` : ''}.` : '',
          courtInjunctionActive ? 'Court stay/injunction clause detected.' : '',
        ].filter(Boolean).join(' ')
      : 'No lien, mortgage or court injunction clause detected in the OCR text.',
  };
}

/**
 * Main parser entry point: parses raw OCR output or OCR engine result into structured LandRecordData
 */
export function parseRevenueRecord(
  ocrInput: string | OcrEngineResult
): ParsedRevenueRecord {
  const rawText = typeof ocrInput === 'string' ? ocrInput : ocrInput.fullText || '';
  const ocrLines = typeof ocrInput === 'object' && ocrInput.lines ? ocrInput.lines : [];
  // A genuine 0% OCR confidence is not "absent"; `?:` used to rewrite it as 90%.
  const sourceConfidence =
    typeof ocrInput === 'object' && typeof ocrInput.confidence === 'number' ? ocrInput.confidence : 0;

  const khasraNo = extractKhasraNo(rawText, ocrLines);
  const khatauniNo = extractKhatauniNo(rawText, ocrLines);
  const khewatNo = extractKhewatNo(rawText, ocrLines);
  const villageMauza = extractVillage(rawText, ocrLines);
  const patwarCircle = extractPatwarCircle(rawText, ocrLines);
  const tehsil = extractTehsil(rawText, ocrLines);
  const district = extractDistrict(rawText, ocrLines);
  const settlementYear = extractSettlementYear(rawText, ocrLines);
  const landClassification = extractLandClassification(rawText, ocrLines);
  const rakbaArea = extractRakbaArea(rawText);
  const owners = extractOwners(rawText);
  const annualLagaanRevenue = extractLagaan(rawText, ocrLines);
  const encumbrance = extractEncumbrance(rawText);

  const stateField = makeExtractedField(
    'Rajasthan', '—', 0, 'state', ocrLines, 'राजस्थान',
    true, 'State assumed from the deployment region, not read from this document'
  );

  const soilMatch = normalizeHindiNumerals(rawText).match(/([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F ]{2,20})\s*(?:土壤|soil)/i)
    || rawText.match(/(?:土壤|soil\s*class)\s*[:\-]?\s*([A-Za-z\u0900-\u097F ]{2,24})/i);
  const soilClass = soilMatch
    ? makeExtractedField(soilMatch[1].trim(), soilMatch[0], 88.0, 'soilClass', ocrLines)
    : makeExtractedField('—', '', 0, 'soilClass', ocrLines, '—', true, 'Soil class not present in OCR text');

  // Detect record type
  let detectedRecordType = 'Jamabandi (RoR - Record of Rights)';
  if (/गिरदावरी|Girdawari|Harvest/i.test(rawText)) {
    detectedRecordType = 'Khasra Girdawari (Harvest Inspection)';
  } else if (/दाखिल\s*खारिज|नामांतरण|Mutation/i.test(rawText)) {
    detectedRecordType = 'Dakhil Kharij (Mutation Register)';
  }

  // Cross-rule validation checks
  const validationErrors: ValidationError[] = [];
  const warnings: string[] = [];

  // 1. Share sum validation
  const totalPercentage = owners.reduce((sum, o) => sum + (o.sharePercentage || 0), 0);
  if (Math.abs(totalPercentage - 100) > 1.0) {
    const err: ValidationError = {
      id: 'val-share-mismatch',
      ruleCode: 'RULE-RJ-OWN-04',
      category: 'Ownership Share',
      severity: 'Critical',
      title: 'Co-Sharer Ownership Total Mismatch',
      description: `Sum of co-sharer fractional allocations equals ${totalPercentage.toFixed(2)}% (expected 100%).`,
      suggestedAction: 'Verify inheritance distribution register and adjust co-owner shares in Human Verification View.',
      resolved: false,
    };
    validationErrors.push(err);
    warnings.push(`Ownership shares total ${totalPercentage.toFixed(2)}% instead of 100%.`);
  }

  // 2. Khasra check
  if (khasraNo.value === '—' || khasraNo.isFlagged) {
    validationErrors.push({
      id: 'val-khasra-missing',
      ruleCode: 'RULE-RJ-CAD-01',
      category: 'Cadastral Survey',
      severity: 'Critical',
      title: 'Missing or Unclear Khasra Sub-Division Number',
      description: 'OCR could not deterministically extract the Khasra parcel identifier.',
      suggestedAction: 'Manually transcribe the Khasra number from the high-resolution scanned sheet.',
      resolved: false,
    });
    warnings.push('Khasra parcel number required manual transcription.');
  }

  const mutationNoMatch = rawText.match(/(?:mutation|नामांतरण|दakhिल\s*खारिज)\s*(?:no\.?|सं\.?|:\s*)?\s*([A-Za-z0-9\/\-]{3,})/i);
  const mutationDateMatch = rawText.match(/(\d{1,2}[\s\-\/][A-Za-z\u0900-\u097F]{3,9}[\s\-\/]\d{4})/);

  const structuredData: LandRecordData = {
    khasraNo,
    khatauniNo,
    khewatNo,
    villageMauza,
    patwarCircle,
    tehsil,
    district,
    state: stateField,
    settlementYear,
    owners,
    rakbaArea,
    landClassification,
    soilClass,
    annualLagaanRevenue,
    encumbrance,
    mutationDetails: {
      lastMutationNo: mutationNoMatch?.[1] || '—',
      mutationDate: mutationDateMatch?.[1] || '—',
      mutationType: /बainama|sale\s*deed|क्रय/i.test(rawText)
        ? 'Sale Deed (Bainama)'
        : /दान|gift|हस्तान्तरण/i.test(rawText)
        ? 'Gift (Hiba)'
        : '—',
      approvingAuthority: tehsil.value === '—' ? '—' : `Tehsildar ${tehsil.value}`,
    },
  };

  const fields = [khasraNo, khatauniNo, khewatNo, villageMauza, patwarCircle, tehsil, district, settlementYear, landClassification, annualLagaanRevenue];
  const highConfidenceFields = fields.filter((f) => f.confidence >= 85).length;
  const lowConfidenceFields = fields.filter((f) => f.confidence < 85).length;

  return {
    isRecordRecognized: khasraNo.value !== '—' || khatauniNo.value !== '—' || owners.length > 0,
    detectedRecordType,
    data: structuredData,
    validationErrors,
    rawText,
    sourceConfidence,
    extractionSummary: {
      fieldsExtractedCount: fields.length + owners.length,
      highConfidenceFields,
      lowConfidenceFields,
      warnings,
    },
  };
}
