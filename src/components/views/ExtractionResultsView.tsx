import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import { DocumentViewer } from '../common/DocumentViewer';
import { ConfidenceBadge } from '../common/ConfidenceBadge';
import {
  FileText,
  Users,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  MapPin,
  Coins,
  Edit3,
  Layers,
  Link2,
  Copy,
  Check,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Cpu,
} from 'lucide-react';

export const ExtractionResultsView: React.FC = () => {
  const {
    activeDocument,
    updateExtractedFieldValue,
    setActiveView,
    acceptExtractedRecord,
    parcels,
    linkDocumentToParcel,
    selectParcel,
  } = useApp();
  const { t, isHindi } = useTranslation();

  const [selectedBoxId, setSelectedBoxId] = useState<string | undefined>(undefined);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [copiedOcr, setCopiedOcr] = useState<boolean>(false);
  const [showOcrPanel, setShowOcrPanel] = useState<boolean>(true);
  const [selectedParcelId, setSelectedParcelId] = useState<string>('');

  if (!activeDocument || !activeDocument.data) {
    return (
      <div className="text-center py-12 text-slate-400">
        {t.extraction.noDocSelected}
      </div>
    );
  }

  const { data, ocrEngines } = activeDocument;
  const owners = data.owners ?? [];

  // Find linked parcel or candidate matched parcel
  const docKhasra = data.khasraNo?.value;
  const linkedParcel = parcels.find(
    (p) =>
      p.id === activeDocument.parcelId ||
      p.documentDisplayId === activeDocument.id ||
      (docKhasra && p.khasraNo && p.khasraNo.includes(docKhasra))
  );

  const lagaanNumeric = typeof data.annualLagaanRevenue?.value === 'number' ? data.annualLagaanRevenue.value : null;

  // Only text the OCR engine actually produced is shown as evidence; a record with no OCR
  // output must not be handed a reconstructed template dressed up as a Tesseract reading.
  const rawOcrText = activeDocument.rawOcrText?.trim() || '';

  const handleCopyOcrText = () => {
    if (!rawOcrText) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(rawOcrText);
      setCopiedOcr(true);
      setTimeout(() => setCopiedOcr(false), 2000);
    }
  };

  const handleLinkToParcel = (parcelId: string) => {
    if (parcelId) {
      linkDocumentToParcel(activeDocument.id, parcelId);
      setSelectedParcelId('');
    }
  };

  const tokenCount = rawOcrText.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-6">
      {/* Header & Step Pipeline State */}
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-blue-700 font-mono font-medium">
              <span>{t.nav.stepIndicator(5, 9)}</span>
              <span>•</span>
              <span className="bg-blue-50 text-blue-800 px-2 py-0.5 rounded font-mono text-[10px] font-bold border border-blue-200">
                {t.extraction.pipelinePipelineTag}
              </span>
            </div>
            <h2 className="text-xl font-bold text-slate-900 mt-1">
              {t.extraction.ocrHonestTitle}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {isHindi ? 'सत्यापित विश्वसनीयता: ' : 'Verified with '}
              <span className="font-mono text-emerald-700 font-semibold">
                {ocrEngines.tesseractConfidence > 0
                  ? `${ocrEngines.tesseractConfidence}%`
                  : t.extraction.confidenceUnavailable}
              </span>{' '}
              {isHindi ? 'स्थानीय टेसरैक्ट ओसीआर स्कोर (Tesseract LSTM)।' : 'local Tesseract OCR confidence (Tesseract LSTM).'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setActiveView('processing')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold border border-slate-200 shadow-xs transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4 text-slate-500" />
              <span>{t.common.back}</span>
            </button>

            <button
              type="button"
              onClick={() => setIsEditing(!isEditing)}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg border transition-all cursor-pointer shadow-xs ${
                isEditing
                  ? 'bg-slate-900 border-slate-900 text-white'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>{isEditing ? t.extraction.doneEditingBtn : t.extraction.editFieldsBtn}</span>
            </button>

            {/* Accept Extracted Record Button */}
            <button
              type="button"
              onClick={() => acceptExtractedRecord(activeDocument.id)}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg border transition-all cursor-pointer shadow-xs ${
                activeDocument.isAccepted
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                  : 'bg-emerald-700 hover:bg-emerald-800 border-emerald-700 text-white'
              }`}
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>
                {activeDocument.isAccepted
                  ? t.extraction.recordAcceptedBadge
                  : t.extraction.acceptRecordBtn}
              </span>
            </button>

            {/* Proceed to Validation */}
            <button
              type="button"
              onClick={() => setActiveView('record_validation')}
              className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-xs transition-all cursor-pointer"
            >
              <span>{t.extraction.proceedValidation}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 6-Stage Document to Land Record Lifecycle Pipeline Progression Indicator */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 pt-1 text-xs">
          {/* Step 1: Uploaded */}
          <div className="p-2 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            <span className="font-semibold text-[11px] truncate">{t.extraction.step1Doc}</span>
          </div>

          {/* Step 2: OCR Processed */}
          <div className="p-2 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            <span className="font-semibold text-[11px] truncate">{t.extraction.step2Ocr}</span>
          </div>

          {/* Step 3: Fields Extracted */}
          <div className="p-2 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            <span className="font-semibold text-[11px] truncate">{t.extraction.step3Extract}</span>
          </div>

          {/* Step 4: Linked to Parcel */}
          <div
            className={`p-2 border rounded-lg flex items-center gap-1.5 transition-all ${
              linkedParcel
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-amber-50 border-amber-200 text-amber-900'
            }`}
          >
            {linkedParcel ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
            )}
            <span className="font-semibold text-[11px] truncate">{t.extraction.step4Link}</span>
          </div>

          {/* Step 5: Human Review */}
          <div
            className={`p-2 border rounded-lg flex items-center gap-1.5 transition-all ${
              activeDocument.isAccepted
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-blue-50 border-blue-200 text-blue-900'
            }`}
          >
            {activeDocument.isAccepted ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-blue-600 shrink-0" />
            )}
            <span className="font-semibold text-[11px] truncate">{t.extraction.step5Accept}</span>
          </div>

          {/* Step 6: Sent to Validation */}
          <div className="p-2 bg-slate-50 border border-slate-200 text-slate-700 rounded-lg flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span className="font-semibold text-[11px] truncate">{t.extraction.step6Validate}</span>
          </div>
        </div>
      </div>

      {/* Dual Column Layout: Left (Document Viewer) / Right (Structured Fields & Parcel Link) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 5 cols: Interactive Document Viewer */}
        <div className="lg:col-span-5 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold text-slate-800">{t.extraction.interactiveBoxes}</span>
            <span className="text-[11px] text-slate-400">{t.extraction.clickBoxHint}</span>
          </div>

          <DocumentViewer
            document={activeDocument}
            selectedBoxId={selectedBoxId}
            onSelectBox={(_boxId, field) => setSelectedBoxId(field)}
            showBoundingBoxes={true}
            allowEnhancementControls={false}
            heightClass="h-[640px]"
          />
        </div>

        {/* Right 7 cols: Structured Fields & Linkage */}
        <div className="lg:col-span-7 space-y-4">
          {/* Section 1: Parcel-Document Linkage Banner */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider font-mono flex items-center gap-2">
                <Link2 className="w-4 h-4 text-blue-700" />
                <span>{t.extraction.linkParcelTitle}</span>
              </h3>

              {linkedParcel ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 font-semibold">
                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                  <span>{t.extraction.parcelMatched}</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 font-semibold">
                  <AlertTriangle className="w-3 h-3 text-amber-600" />
                  <span>{t.extraction.notLinked}</span>
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80">
                <span className="text-slate-500 block text-[10px] mb-0.5">
                  {t.extraction.linkedParcelId}
                </span>
                <div className="font-mono font-bold text-slate-900 text-sm">
                  {linkedParcel ? linkedParcel.id : activeDocument.parcelId || '—'}
                </div>
                {linkedParcel && (
                  <div className="text-[11px] text-slate-600 mt-1">
                    {linkedParcel.village} • Khasra {linkedParcel.khasraNo}
                  </div>
                )}
              </div>

              <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 space-y-1.5">
                <span className="text-slate-500 block text-[10px]">
                  {isHindi ? 'स्थानिक पंजिका से जोड़ें' : 'Bind to Spatial Registry'}
                </span>
                <div className="flex items-center gap-2">
                  <select
                    value={selectedParcelId || (linkedParcel ? linkedParcel.id : '')}
                    onChange={(e) => {
                      setSelectedParcelId(e.target.value);
                      handleLinkToParcel(e.target.value);
                    }}
                    className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-800 font-mono text-xs"
                  >
                    <option value="">{t.extraction.selectParcelPlaceholder}</option>
                    {parcels.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id} (Kh. {p.khasraNo} - {p.village})
                      </option>
                    ))}
                  </select>
                  {linkedParcel && (
                    <button
                      type="button"
                      onClick={() => {
                        selectParcel(linkedParcel.id);
                        setActiveView('spatial_registry');
                      }}
                      className="p-1.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 transition-colors cursor-pointer shrink-0"
                      title={t.extraction.viewCadastreMap}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Core Cadastral Identifiers */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <MapPin className="w-4 h-4 text-blue-700" />
                <span>{t.extraction.parcelIdTitle}</span>
              </h3>
              <ConfidenceBadge score={data.khasraNo.confidence} size="sm" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 text-xs">
              {/* Khasra Field */}
              <div
                onMouseEnter={() => setSelectedBoxId('khasraNo')}
                className={`p-3 rounded-lg border transition-all ${
                  selectedBoxId === 'khasraNo'
                    ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500'
                    : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between text-slate-500 mb-1">
                  <span>{t.extraction.khasraLabel}</span>
                  <ConfidenceBadge score={data.khasraNo.confidence} size="sm" showLabel={false} />
                </div>
                {isEditing ? (
                  <input
                    type="text"
                    value={data.khasraNo.value}
                    onChange={(e) =>
                      updateExtractedFieldValue(activeDocument.id, 'khasraNo', e.target.value)
                    }
                    className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono text-sm"
                  />
                ) : (
                  <div className="text-base font-extrabold text-slate-900 font-mono flex items-center gap-2">
                    <span>{data.khasraNo.value}</span>
                    <span className="text-xs text-slate-500 font-serif font-normal">
                      ({data.khasraNo.hindiValue})
                    </span>
                  </div>
                )}
                <div className="text-[10px] text-slate-400 font-mono mt-1 truncate">
                  OCR: {data.khasraNo.originalOcr}
                </div>
              </div>

              {/* Khatauni Field */}
              <div
                onMouseEnter={() => setSelectedBoxId('khatauniNo')}
                className={`p-3 rounded-lg border transition-all ${
                  selectedBoxId === 'khatauniNo'
                    ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500'
                    : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between text-slate-500 mb-1">
                  <span>{t.extraction.khatauniLabel}</span>
                  <ConfidenceBadge score={data.khatauniNo.confidence} size="sm" showLabel={false} />
                </div>
                {isEditing ? (
                  <input
                    type="text"
                    value={data.khatauniNo.value}
                    onChange={(e) =>
                      updateExtractedFieldValue(activeDocument.id, 'khatauniNo', e.target.value)
                    }
                    className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono text-sm"
                  />
                ) : (
                  <div className="text-base font-extrabold text-slate-900 font-mono flex items-center gap-2">
                    <span>{data.khatauniNo.value}</span>
                    <span className="text-xs text-slate-500 font-serif font-normal">
                      ({data.khatauniNo.hindiValue})
                    </span>
                  </div>
                )}
                <div className="text-[10px] text-slate-400 font-mono mt-1 truncate">
                  OCR: {data.khatauniNo.originalOcr}
                </div>
              </div>

              {/* Khewat Field */}
              <div
                onMouseEnter={() => setSelectedBoxId('khewatNo')}
                className={`p-3 rounded-lg border transition-all ${
                  selectedBoxId === 'khewatNo'
                    ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500'
                    : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between text-slate-500 mb-1">
                  <span>{t.extraction.khewatLabel}</span>
                  <ConfidenceBadge score={data.khewatNo.confidence} size="sm" showLabel={false} />
                </div>
                {isEditing ? (
                  <input
                    type="text"
                    value={data.khewatNo.value}
                    onChange={(e) =>
                      updateExtractedFieldValue(activeDocument.id, 'khewatNo', e.target.value)
                    }
                    className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono text-sm"
                  />
                ) : (
                  <div className="text-base font-extrabold text-slate-900 font-mono flex items-center gap-2">
                    <span>{data.khewatNo.value}</span>
                    <span className="text-xs text-slate-500 font-serif font-normal">
                      ({data.khewatNo.hindiValue})
                    </span>
                  </div>
                )}
                <div className="text-[10px] text-slate-400 font-mono mt-1 truncate">
                  OCR: {data.khewatNo.originalOcr}
                </div>
              </div>
            </div>

            {/* Jurisdiction Details */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs pt-1">
              <div>
                <span className="text-slate-500 block text-[10px]">{t.extraction.villageLabel}:</span>
                <span className="font-semibold text-slate-800">{data.villageMauza.value}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px]">{t.extraction.patwarLabel}:</span>
                <span className="font-semibold text-slate-800">{data.patwarCircle.value}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px]">{t.extraction.tehsilLabel}:</span>
                <span className="font-semibold text-slate-800">{data.tehsil.value}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px]">{t.extraction.yearLabel}:</span>
                <span className="font-semibold text-slate-800">{data.settlementYear.value}</span>
              </div>
            </div>
          </div>

          {/* Section 3: Ownership Ledger & Co-Sharers */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Users className="w-4 h-4 text-emerald-700" />
                <span>{t.extraction.ownersTitle}</span>
              </h3>
              <span className="text-xs text-emerald-800 font-mono font-semibold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                {t.extraction.coSharerCount(owners.length)}
              </span>
            </div>

            {/* Owners Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border border-slate-200 rounded-lg">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 text-[11px]">
                  <tr>
                    <th className="p-2.5">#</th>
                    <th className="p-2.5">{t.extraction.coSharerCol}</th>
                    <th className="p-2.5">{t.extraction.fractionCol}</th>
                    <th className="p-2.5">{t.extraction.shareCol}</th>
                    <th className="p-2.5">{t.extraction.statusCol}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {owners.map((owner, idx) => (
                    <tr key={owner.id} className="hover:bg-slate-50/80">
                      <td className="p-2.5 font-mono text-slate-400">{idx + 1}</td>
                      <td className="p-2.5">
                        <div className="font-semibold text-slate-900">{owner.name}</div>
                        <div className="text-slate-500 text-[11px] font-serif">
                          {owner.relationType} {owner.relativeName} ({owner.relativeHindiName})
                        </div>
                      </td>
                      <td className="p-2.5 font-mono text-slate-700 font-bold">
                        {owner.shareFraction}
                      </td>
                      <td className="p-2.5 font-mono text-emerald-700 font-bold">
                        {owner.sharePercentage}%
                      </td>
                      <td className="p-2.5">
                        <span
                          className={`text-[10px] font-medium px-2 py-0.5 rounded ${
                            owner.status?.includes('Deceased')
                              ? 'bg-rose-50 text-rose-800 border border-rose-200'
                              : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          }`}
                        >
                          {owner.status?.includes('Deceased')
                            ? isHindi
                              ? 'मृतक (Deceased)'
                              : 'Deceased'
                            : isHindi
                            ? 'जीवित (Active)'
                            : 'Active'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 4: Rakba (Area Math) & Lagaan */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Area */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2">
              <h4 className="text-xs font-bold text-slate-900 flex items-center justify-between">
                <span>{t.extraction.rakbaTitle}</span>
                <ConfidenceBadge score={data.rakbaArea.confidence} size="sm" />
              </h4>
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200/80 text-xs space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-500">{t.extraction.bighaBiswa}</span>
                  <span className="font-mono font-bold text-slate-900">
                    {data.rakbaArea.bigha} {isHindi ? 'बीघा' : 'Bigha'} -{' '}
                    {data.rakbaArea.biswa} {isHindi ? 'बिस्वा' : 'Biswa'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{t.extraction.metricHectares}</span>
                  <span className="font-mono text-emerald-700 font-bold">
                    {data.rakbaArea.totalHectares} Ha
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{t.extraction.landClass}</span>
                  <span className="text-slate-800 font-medium">{data.landClassification.value}</span>
                </div>
              </div>
            </div>

            {/* Lagaan & Encumbrance */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2">
              <h4 className="text-xs font-bold text-slate-900 flex items-center justify-between">
                <span>{t.extraction.lagaanTitle}</span>
                <ConfidenceBadge score={data.annualLagaanRevenue.confidence} size="sm" />
              </h4>
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200/80 text-xs space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-500">{t.extraction.lagaanLabel}</span>
                  <span className="font-mono font-bold text-slate-900">
                    {lagaanNumeric !== null ? `₹${lagaanNumeric.toFixed(2)}` : (isHindi ? 'अभिलेखित नहीं' : 'Not recorded')}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{t.extraction.mortgageLabel}</span>
                  <span
                    className={
                      data.encumbrance.isMortgaged
                        ? 'text-amber-800 font-semibold'
                        : 'text-emerald-700 font-medium'
                    }
                  >
                    {data.encumbrance.isMortgaged
                      ? `${isHindi ? 'सक्रिय बंधक' : 'Active'} (₹${data.encumbrance.mortgageAmountINR?.toLocaleString(
                          'en-IN'
                        )})`
                      : isHindi
                      ? 'कोई बंधक नहीं (मुक्त)'
                      : 'None (Clear)'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{t.extraction.stayLabel}</span>
                  <span
                    className={
                      data.encumbrance.courtInjunctionActive
                        ? 'text-rose-700 font-bold'
                        : 'text-emerald-700 font-medium'
                    }
                  >
                    {data.encumbrance.courtInjunctionActive
                      ? isHindi
                        ? 'न्यायालय स्थगन सक्रिय'
                        : 'Active Stay Order'
                      : isHindi
                      ? 'कोई स्थगन नहीं'
                      : 'No Injunction'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Lower Panel: Real OCR Evidence & Detected Tokens */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
        <div
          onClick={() => setShowOcrPanel(!showOcrPanel)}
          className="flex items-center justify-between px-5 py-3.5 bg-slate-900 text-white cursor-pointer hover:bg-slate-850 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <Cpu className="w-4 h-4 text-blue-400" />
            <div>
              <span className="text-xs font-bold">{t.extraction.rawOcrTitle}</span>
              <span className="text-[10px] text-slate-400 ml-2">
                ({tokenCount} {t.extraction.detectedTokens})
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono text-emerald-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
              Tesseract LSTM: {ocrEngines.tesseractConfidence > 0 ? `${ocrEngines.tesseractConfidence}%` : t.extraction.confidenceUnavailable}
            </span>
            {showOcrPanel ? (
              <ChevronUp className="w-4 h-4 text-slate-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-400" />
            )}
          </div>
        </div>

        {showOcrPanel && (
          <div className="p-5 space-y-4 bg-slate-50/50">
            {/* Metadata Badges */}
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs border-b border-slate-200 pb-3">
              <div className="flex flex-wrap items-center gap-4 text-slate-600">
                <span>
                  <strong className="text-slate-800">{t.extraction.ocrLanguage}</strong>{' '}
                  <span className="font-mono text-slate-700">{t.extraction.ocrLangValue}</span>
                </span>
                <span>
                  <strong className="text-slate-800">{t.extraction.ocrEngineLabel}</strong>{' '}
                  <span className="font-mono text-slate-700">{t.extraction.ocrEngineValue}</span>
                </span>
              </div>

              <button
                type="button"
                onClick={handleCopyOcrText}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
              >
                {copiedOcr ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-emerald-700">{t.extraction.copied}</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-600" />
                    <span>{t.extraction.copyOcrText}</span>
                  </>
                )}
              </button>
            </div>

            {/* OCR Raw Text Stream Container */}
            <div className="relative bg-slate-900 text-slate-100 rounded-lg p-4 font-mono text-xs max-h-56 overflow-y-auto leading-relaxed border border-slate-800 shadow-inner">
              <pre className="whitespace-pre-wrap font-sans text-xs text-slate-200 font-mono">
                {rawOcrText || (isHindi ? 'इस दस्तावेज़ के लिए कोई कच्चा OCR पाठ मौजूद नहीं है — प्रसंस्करण चलाएँ या पुनः स्कैन करें। यह विवरण OCR साक्ष्य नहीं है।' : 'No raw OCR text exists for this document — run processing or re-scan it. This panel shows OCR evidence, never a reconstruction.')}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
