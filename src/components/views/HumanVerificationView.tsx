import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import { DocumentViewer } from '../common/DocumentViewer';
import { ConfidenceBadge } from '../common/ConfidenceBadge';
import { LandOwner } from '../../types';
import {
  UserCheck,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Plus,
  Trash2,
  Lock,
  ArrowRight,
  ArrowLeft,
  Stamp,
  FileCheck,
  Send,
  RotateCcw,
  Camera,
} from 'lucide-react';

export const HumanVerificationView: React.FC = () => {
  const {
    activeDocument,
    currentUser,
    updateExtractedFieldValue,
    updateOwner,
    addOwner,
    removeOwner,
    verifyAndSealRecord,
    rejectRecord,
    flagForPatwariInspection,
    setActiveView,
  } = useApp();
  const { t, isHindi } = useTranslation();

  const [selectedField, setSelectedField] = useState<string | undefined>(undefined);
  const [officerNotes, setOfficerNotes] = useState<string>(
    isHindi
      ? 'मास्टर शजरा किश्तवार के अनुसार सत्यापित। सभी खातेदारों के हिस्से और कृषि वर्गीकरण की पुष्टि की गई।'
      : 'Verified against Master Shajra Cadastre. All ownership shares and agricultural land classifications confirmed.'
  );
  const [showSignModal, setShowSignModal] = useState<boolean>(false);
  const [showPatwariModal, setShowPatwariModal] = useState<boolean>(false);
  const [showRejectModal, setShowRejectModal] = useState<boolean>(false);
  const [patwariInstructions, setPatwariInstructions] = useState<string>(
    isHindi
      ? 'खसरा भूखंड पर वास्तविक भौतिक कब्जे की पुष्टि करें और मृतक सह-खातेदार के प्रपत्र ११ विरासत नामांतरण दावे की जांच करें।'
      : 'Verify physical possession on Khasra plot and check Form 11 Virasat mutation claim for deceased co-sharer.'
  );
  const [rejectReason, setRejectReason] = useState<string>(
    isHindi
      ? 'गंभीर स्याही के धब्बों के कारण खसरा उप-विभाजन संख्या अस्पष्ट है। स्कैन की गई प्रति अपठनीय है।'
      : 'Severe ink smudge obscures Khasra sub-division number. Scanned sheet unreadable.'
  );

  if (!activeDocument || !activeDocument.data) {
    return (
      <div className="text-center py-12 text-slate-400">
        {t.verification.noRecordSelected}
      </div>
    );
  }

  const { data } = activeDocument;

  const ownerStatusOptions: Array<{ value: LandOwner['status']; hi: string; en: string }> = [
    { value: 'Active Co-sharer', hi: 'सक्रिय सह-खातेदार', en: 'Active Co-sharer' },
    { value: 'Deceased (Mutation Pending)', hi: 'मृतक (नामांतरण लंबित)', en: 'Deceased (Mutation Pending)' },
    { value: 'Minor (Guardian)', hi: 'नाबालिग (संरक्षक अधीन)', en: 'Minor (Guardian)' },
    { value: 'Disputed Share', hi: 'विवादित हिस्सा', en: 'Disputed Share' },
  ];

  const handleAddNewOwner = () => {
    const newOwner: LandOwner = {
      id: `own-${Date.now()}`,
      name: isHindi ? 'नवीन खातेदार' : 'New Co-Sharer',
      hindiName: 'नवीन खातेदार',
      relationType: 's/o',
      relativeName: isHindi ? 'पिता का नाम' : 'Father Name',
      relativeHindiName: 'पिता का नाम',
      shareFraction: '1/4',
      sharePercentage: 25.0,
      status: 'Active Co-sharer',
    };
    addOwner(activeDocument.id, newOwner);
  };

  const handleFinalSign = () => {
    if (!ownershipValid) {
      return;
    }
    verifyAndSealRecord(activeDocument.id, officerNotes);
    setShowSignModal(false);
    setActiveView('verified_record');
  };

  const handlePatwariDispatch = () => {
    flagForPatwariInspection(activeDocument.id, patwariInstructions);
    setShowPatwariModal(false);
    setActiveView('verification_queue');
  };

  const handleRejectSubmit = () => {
    rejectRecord(activeDocument.id, rejectReason);
    setShowRejectModal(false);
    setActiveView('verification_queue');
  };

  // Percentage is the canonical ownership value. Fractions are checked as a representation.
  const totalSharePercentage = (data.owners ?? []).reduce((sum, o) => sum + (Number.isFinite(o.sharePercentage) ? o.sharePercentage : 0), 0);
  const fractionToPercentage = (fraction: string) => {
    const match = String(fraction || '').trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (!match || Number(match[2]) === 0) return null;
    return Number((Number(match[1]) / Number(match[2]) * 100).toFixed(2));
  };
  const invalidFractions = (data.owners ?? []).filter((owner) => owner.shareFraction && fractionToPercentage(owner.shareFraction) == null);
  const fractionMismatches = (data.owners ?? []).filter((owner) => {
    const fractionPct = fractionToPercentage(owner.shareFraction);
    return fractionPct != null && Math.abs(fractionPct - owner.sharePercentage) > 0.05;
  });
  const ownershipValid = (data.owners?.length ?? 0) > 0 && Math.abs(totalSharePercentage - 100) <= 0.005 && fractionMismatches.length === 0 && invalidFractions.length === 0;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-blue-700 font-mono font-medium">
            <span>{t.nav.stepIndicator(8, 9)}</span>
            <span>•</span>
            <span>{t.verification.stepTag}</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-1 flex items-center gap-2">
            <span>{t.verification.workstationTitle}</span>
            <span className="text-xs font-mono font-normal bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded">
              {activeDocument.documentCode}
            </span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t.verification.reviewingOfficer} <span className="text-slate-800 font-semibold">{currentUser.name}</span> ({currentUser.designation})
          </p>
        </div>

        {/* Top Action Bar */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveView('verification_queue')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold border border-slate-200 shadow-xs transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 text-slate-500" />
            <span>{t.verification.backToQueue}</span>
          </button>

          <button
            onClick={() => setShowRejectModal(true)}
            className="px-3 py-2 rounded-lg bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 text-xs font-semibold transition-colors cursor-pointer shadow-xs"
          >
            {t.verification.rejectDoc}
          </button>

          <button
            onClick={() => setShowPatwariModal(true)}
            className="px-3 py-2 rounded-lg bg-white hover:bg-amber-50 text-amber-800 border border-amber-200 text-xs font-semibold transition-colors cursor-pointer shadow-xs"
          >
            {t.verification.forwardPatwari}
          </button>

          <button
            onClick={() => setActiveView('field_verification')}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-semibold transition-colors cursor-pointer shadow-xs"
          >
            <Camera className="w-4 h-4 text-blue-600" />
            <span>{t.verification.fieldCameraBtn}</span>
          </button>

          <button
            onClick={() => setShowSignModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-xs transition-all cursor-pointer"
          >
            <Stamp className="w-4 h-4" />
            <span>{t.verification.sealRecord}</span>
          </button>
        </div>
      </div>

      {/* Dual Pane Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left Pane (5 cols): Original Scanned Deed with Zoom/Filters */}
        <div className="lg:col-span-5 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold text-slate-800">{isHindi ? 'मूल स्कैन दस्तावेज़ (उच्च-रिज़ॉल्यूशन)' : 'Original Scanned Deed (High-Res View)'}</span>
            <span className="font-mono text-[11px] text-slate-400">DPI: {activeDocument.qualityMetrics?.dpi > 0 ? activeDocument.qualityMetrics.dpi : (isHindi ? 'अज्ञात' : 'unknown')}</span>
          </div>

          <DocumentViewer
            document={activeDocument}
            selectedBoxId={selectedField}
            onSelectBox={(boxId, field) => setSelectedField(field)}
            showBoundingBoxes={true}
            allowEnhancementControls={true}
            heightClass="h-[720px]"
          />
        </div>

        {/* Right Pane (7 cols): Editable Verification & Normalization Form */}
        <div className="lg:col-span-7 space-y-4 max-h-[760px] overflow-y-auto pr-1">
          {/* Card 1: Core Identifiers */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">
                {isHindi ? '१. भूखंड पहचान (खसरा व खतौनी)' : '1. Parcel Identifiers (Khasra & Khatauni)'}
              </h3>
              <span className="text-[11px] text-slate-400">{isHindi ? 'स्कैन पर हाइलाइट करने के लिए फ़ील्ड पर क्लिक करें' : 'Click field to highlight on scan'}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              {/* Khasra */}
              <div
                onClick={() => setSelectedField('khasraNo')}
                className={`p-2.5 rounded-lg border transition-all ${
                  selectedField === 'khasraNo'
                    ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500'
                    : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex justify-between text-slate-500 text-[11px] mb-1">
                  <span>{t.extraction.khasraLabel}</span>
                  <ConfidenceBadge score={data.khasraNo.confidence} size="sm" showLabel={false} />
                </div>
                <input
                  type="text"
                  value={data.khasraNo.value}
                  onChange={(e) => updateExtractedFieldValue(activeDocument.id, 'khasraNo', e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono font-bold text-sm"
                />
                <div className="text-[10px] text-slate-400 mt-1">{isHindi ? 'हिंदी:' : 'Hindi:'} {data.khasraNo.hindiValue}</div>
              </div>

              {/* Khatauni */}
              <div
                onClick={() => setSelectedField('khatauniNo')}
                className={`p-2.5 rounded-lg border transition-all ${
                  selectedField === 'khatauniNo'
                    ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500'
                    : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex justify-between text-slate-500 text-[11px] mb-1">
                  <span>{t.extraction.khatauniLabel}</span>
                  <ConfidenceBadge score={data.khatauniNo.confidence} size="sm" showLabel={false} />
                </div>
                <input
                  type="text"
                  value={data.khatauniNo.value}
                  onChange={(e) => updateExtractedFieldValue(activeDocument.id, 'khatauniNo', e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono font-bold text-sm"
                />
                <div className="text-[10px] text-slate-400 mt-1">{isHindi ? 'हिंदी:' : 'Hindi:'} {data.khatauniNo.hindiValue}</div>
              </div>

              {/* Khewat */}
              <div
                onClick={() => setSelectedField('khewatNo')}
                className={`p-2.5 rounded-lg border transition-all ${
                  selectedField === 'khewatNo'
                    ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500'
                    : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex justify-between text-slate-500 text-[11px] mb-1">
                  <span>{t.extraction.khewatLabel}</span>
                  <ConfidenceBadge score={data.khewatNo.confidence} size="sm" showLabel={false} />
                </div>
                <input
                  type="text"
                  value={data.khewatNo.value}
                  onChange={(e) => updateExtractedFieldValue(activeDocument.id, 'khewatNo', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono font-bold text-sm bg-white"
                />
                <div className="text-[10px] text-slate-400 mt-1">{isHindi ? 'हिंदी:' : 'Hindi:'} {data.khewatNo.hindiValue}</div>
              </div>
            </div>
          </div>

          {/* Card 2: Co-Sharers & Ownership Division */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">
                  {isHindi ? '२. खातेदार का नाम व हिस्सा' : '2. Co-Sharer Ownership Ledger (खातेदार विवरण)'}
                </h3>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {isHindi ? 'कुल हिस्सा योग: ' : 'Total Share Sum: '}<span className={Math.abs(totalSharePercentage - 100) < 0.1 ? 'text-emerald-700 font-bold font-mono' : 'text-rose-700 font-bold font-mono'}>{totalSharePercentage.toFixed(2)}%</span>
                </div>
                {invalidFractions.length > 0 && (
                  <div className="mt-1 text-[10px] text-rose-700">
                    {isHindi ? 'अमान्य अंश प्रारूप। उदाहरण के लिए 1/2 या 1/4 का उपयोग करें।' : 'Invalid fraction format detected. Use a form such as 1/2 or 1/3.'}
                  </div>
                )}
                {fractionMismatches.length > 0 && (
                  <div className="mt-1 text-[10px] text-amber-700">
                    {isHindi ? 'अंश और प्रतिशत में अंतर है। प्रतिशत प्रामाणिक है; अंश या प्रतिशत को अद्यतित करें।' : 'Fraction/share mismatch detected. Percentage is canonical; update the fraction or share value.'}
                  </div>
                )}
                {totalSharePercentage < 99.995 && (
                  <div className="mt-1 text-[10px] text-amber-700">{isHindi ? 'स्वामित्व अपूर्ण है: सत्यापन से पहले हिस्से का योग 100% होना चाहिए।' : 'Ownership is incomplete: shares must total exactly 100% before verification.'}</div>
                )}
                {totalSharePercentage > 100.005 && (
                  <div className="mt-1 text-[10px] text-rose-700 font-semibold">{isHindi ? 'स्वामित्व 100% से अधिक है: सत्यापन अवरुद्ध है।' : 'Ownership exceeds 100%: verification is blocked.'}</div>
                )}
              </div>

              <button
                onClick={handleAddNewOwner}
                className="flex items-center gap-1 text-xs bg-white hover:bg-slate-50 text-slate-700 px-2.5 py-1 rounded border border-slate-200 transition-colors shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t.verification.addCoSharer}</span>
              </button>
            </div>

            <div className="space-y-2.5">
              {(data.owners ?? []).map((owner, idx) => (
                <div
                  key={owner.id}
                  className="p-3 bg-slate-50 rounded-lg border border-slate-200/80 space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900 font-mono text-[11px]">
                      {isHindi ? 'सह-खातेदार #' : 'Co-Sharer #'}{idx + 1}
                    </span>

                    <div className="flex items-center gap-2">
                      <select
                        value={owner.status}
                        onChange={(e) => updateOwner(activeDocument.id, owner.id, { status: e.target.value as LandOwner['status'] })}
                        className={`text-[10px] rounded px-2 py-0.5 font-medium border ${
                          owner.status?.includes('Deceased')
                            ? 'bg-rose-50 text-rose-800 border-rose-200'
                            : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                        }`}
                      >
                        {ownerStatusOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{isHindi ? opt.hi : opt.en}</option>
                        ))}
                      </select>

                      {(data.owners?.length ?? 0) > 1 && (
                        <button
                          onClick={() => {
                            if (window.confirm(isHindi ? `क्या सह-खातेदार "${owner.name}" को इस अभिलेख से हटाना सुनिश्चित है?` : `Remove co-sharer "${owner.name}" from this record?`)) {
                              removeOwner(activeDocument.id, owner.id);
                            }
                          }}
                          className="text-slate-400 hover:text-rose-600 p-0.5"
                          title={t.verification.removeOwner}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-500 block mb-0.5">{t.verification.ownerNameCol}</label>
                      <input
                        type="text"
                        value={owner.name}
                        onChange={(e) => updateOwner(activeDocument.id, owner.id, { name: e.target.value })}
                        className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-medium"
                      />
                    </div>

                    <div>
                      <label className="text-[10px] text-slate-500 block mb-0.5">{t.verification.relativeNameCol}</label>
                      <input
                        type="text"
                        value={owner.relativeName || ''}
                        onChange={(e) => updateOwner(activeDocument.id, owner.id, { relativeName: e.target.value })}
                        className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-medium"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      <div>
                        <label className="text-[10px] text-slate-500 block mb-0.5">{t.verification.fractionCol}</label>
                        <input
                          type="text"
                          value={owner.shareFraction}
                          onChange={(e) => {
                            const fraction = e.target.value;
                            const fractionPct = fractionToPercentage(fraction);
                            updateOwner(activeDocument.id, owner.id, fractionPct == null
                              ? { shareFraction: fraction }
                              : { shareFraction: fraction, sharePercentage: fractionPct });
                          }}
                          className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-500 block mb-0.5">{t.verification.shareCol}</label>
                        <input
                          type="number"
                          step="0.01"
                          value={owner.sharePercentage}
                          onChange={(e) => updateOwner(activeDocument.id, owner.id, { sharePercentage: Number(e.target.value) })}
                          className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-emerald-700 font-mono font-bold"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Card 3: Rakba (Area) & Land Classification */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono border-b border-slate-100 pb-2">
              {isHindi ? '३. रकबा (क्षेत्रफल व किस्म भूमि)' : '3. Rakba (Land Area & Agricultural Class)'}
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs">
              <div>
                <label className="text-[10px] text-slate-500 block mb-0.5">{isHindi ? 'बीघा' : 'Bigha (बीघा)'}</label>
                <input
                  type="number"
                  value={data.rakbaArea.bigha}
                  onChange={(e) => {
                    const newB = Number(e.target.value);
                    const calcHa = Number((newB * 0.2529 + data.rakbaArea.biswa * (0.2529 / 20)).toFixed(3));
                    updateExtractedFieldValue(activeDocument.id, 'rakbaArea', {
                      ...data.rakbaArea,
                      bigha: newB,
                      totalHectares: calcHa,
                    });
                  }}
                  className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono font-bold"
                />
              </div>

              <div>
                <label className="text-[10px] text-slate-500 block mb-0.5">{isHindi ? 'बिस्वा' : 'Biswa (बिस्वा)'}</label>
                <input
                  type="number"
                  value={data.rakbaArea.biswa}
                  onChange={(e) => {
                    const newBis = Number(e.target.value);
                    const calcHa = Number((data.rakbaArea.bigha * 0.2529 + newBis * (0.2529 / 20)).toFixed(3));
                    updateExtractedFieldValue(activeDocument.id, 'rakbaArea', {
                      ...data.rakbaArea,
                      biswa: newBis,
                      totalHectares: calcHa,
                    });
                  }}
                  className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono font-bold"
                />
              </div>

              <div>
                <label className="text-[10px] text-slate-500 block mb-0.5">{isHindi ? 'कुल हेक्टेयर' : 'Total Hectares (हेक्टेयर)'}</label>
                <input
                  type="number"
                  step="0.001"
                  value={data.rakbaArea.totalHectares}
                  onChange={(e) => {
                    updateExtractedFieldValue(activeDocument.id, 'rakbaArea', {
                      ...data.rakbaArea,
                      totalHectares: Number(e.target.value),
                    });
                  }}
                  className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-emerald-700 font-mono font-bold"
                />
              </div>

              <div>
                <label className="text-[10px] text-slate-500 block mb-0.5">{t.verification.landClassificationLabel}</label>
                <select
                  value={data.landClassification.value}
                  onChange={(e) => updateExtractedFieldValue(activeDocument.id, 'landClassification', e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-800 text-xs"
                >
                  <option value="Chahi (Well Irrigated)">{isHindi ? 'चाही (कूप सिंचित)' : 'Chahi (Well Irrigated)'}</option>
                  <option value="Nahri (Canal Irrigated)">{isHindi ? 'नहरी (नहर सिंचित)' : 'Nahri (Canal Irrigated)'}</option>
                  <option value="Barani (Rainfed)">{isHindi ? 'बारानी (वर्षा आधारित)' : 'Barani (Rainfed)'}</option>
                  <option value="Gair Mumkin (Non-arable / Built-up)">{isHindi ? 'गैर मुमकिन (अकृषि/आबादी)' : 'Gair Mumkin (Non-arable)'}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Card 4: Encumbrance & Mutation Remarks */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">
              {isHindi ? '४. कैफियत व विशेष विवरण' : '4. Remarks & Encumbrance Notes'}
            </h3>
            <textarea
              rows={2}
              value={data.encumbrance.remarks || ''}
              onChange={(e) => {
                const enc = { ...data.encumbrance, remarks: e.target.value };
                updateExtractedFieldValue(activeDocument.id, 'encumbrance', enc);
              }}
              placeholder={isHindi ? 'बैंक बंधक विवरण, पटवारी नामांतरण या न्यायालय स्थगन टिप्पणी दर्ज करें...' : 'Enter specific hypothecation notes, patwari mutation details, or court case reference...'}
              className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-slate-400 leading-relaxed"
            />
          </div>
        </div>
      </div>

      {/* Digital Sign Modal */}
      {showSignModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700">
                <Stamp className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">{t.verification.signModalTitle}</h3>
                <p className="text-xs text-slate-500">
                  {isHindi ? 'सत्यापन प्राधिकारी:' : 'Authority:'} {currentUser.name} • {currentUser.badgeNumber}
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              {t.verification.signModalDesc} {isHindi ? 'खसरा नं.' : 'Khasra'}{' '}
              <strong className="text-slate-900">{data.khasraNo.value}</strong> ({data.villageMauza.value})।
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t.verification.officerNotesTitle}
              </label>
              <textarea
                rows={3}
                value={officerNotes}
                onChange={(e) => setOfficerNotes(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:outline-none focus:border-emerald-600 font-sans"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                onClick={() => setShowSignModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold cursor-pointer"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={handleFinalSign}
                disabled={!ownershipValid}
                title={!ownershipValid ? t.verification.ownershipValidError : t.verification.sealRecord}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-xs cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Stamp className="w-4 h-4" />
                <span>{t.verification.confirmSealBtn}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Patwari Inspection Modal */}
      {showPatwariModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-700">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">{t.verification.patwariModalTitle}</h3>
                <p className="text-xs text-slate-500">{isHindi ? 'पटवार वृत्त को प्रेषित:' : 'Dispatch inquiry to'} {data.patwarCircle.value}</p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t.verification.patwariInstructionsLabel}
              </label>
              <textarea
                rows={3}
                value={patwariInstructions}
                onChange={(e) => setPatwariInstructions(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:outline-none focus:border-amber-600 font-sans"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                onClick={() => setShowPatwariModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold cursor-pointer"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={handlePatwariDispatch}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs font-bold shadow-xs cursor-pointer"
              >
                <Send className="w-4 h-4" />
                <span>{t.verification.dispatchOrderBtn}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {showRejectModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-700">
                <XCircle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">{t.verification.rejectModalTitle}</h3>
                <p className="text-xs text-slate-500">{t.verification.rejectModalDesc}</p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t.verification.rejectReasonLabel}
              </label>
              <textarea
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:outline-none focus:border-rose-600 font-sans"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                onClick={() => setShowRejectModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold cursor-pointer"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={handleRejectSubmit}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-700 hover:bg-rose-600 text-white text-xs font-bold shadow-xs cursor-pointer"
              >
                <XCircle className="w-4 h-4" />
                <span>{t.verification.confirmRejectBtn}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
