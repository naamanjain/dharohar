import React from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ArrowRight,
  ArrowLeft,
  Check,
} from 'lucide-react';

export const RecordValidationView: React.FC = () => {
  const { activeDocument, resolveValidationError, setActiveView, parcels, selectParcel } = useApp();
  const { t, isHindi } = useTranslation();

  if (!activeDocument || !activeDocument.data) {
    return (
      <div className="text-center py-12 text-slate-400">
        {t.validation.noDocSelected}
      </div>
    );
  }

  const { validationErrors, data } = activeDocument;
  const unresolvedCount = (validationErrors ?? []).filter((e) => !e.resolved).length;

  // Find linked parcel
  const docKhasra = data.khasraNo?.value;
  const linkedParcel = parcels.find(
    (p) =>
      p.id === activeDocument.parcelId ||
      p.documentDisplayId === activeDocument.id ||
      (docKhasra && p.khasraNo && p.khasraNo.includes(docKhasra))
  );

  // Calculate dynamic rule results
  const ownerShareSum = (data.owners ?? []).reduce((acc, o) => acc + (Number.isFinite(o.sharePercentage) ? o.sharePercentage : 0), 0);
  const hasOwners = (data.owners ?? []).length > 0;
  const isShareMathValid = hasOwners && Math.abs(ownerShareSum - 100) < 0.05;

  const rakba = data.rakbaArea;
  const hasRakba = Boolean(rakba && Number.isFinite(rakba.bigha) && Number.isFinite(rakba.totalHectares));
  const bighaCalculatedHa = hasRakba ? (rakba.bigha * 0.2529) + (rakba.biswa * (0.2529 / 20)) : null;
  const isAreaMathValid = hasRakba && bighaCalculatedHa != null && Math.abs(bighaCalculatedHa - rakba.totalHectares) < 0.1;

  const shajraLinked = Boolean(linkedParcel);

  const lagaanNumeric = typeof data.annualLagaanRevenue?.value === 'number' ? data.annualLagaanRevenue.value : null;

  // Area mismatch check — only when a GIS polygon actually measured this parcel.
  const recordedHa = linkedParcel?.recordedAreaHectares ?? (hasRakba ? rakba.totalHectares : null);
  const mappedHa = linkedParcel && Number.isFinite(linkedParcel.mappedAreaHectares) ? linkedParcel.mappedAreaHectares : null;
  const areaDiff = recordedHa != null && mappedHa != null ? Math.abs(recordedHa - mappedHa) : null;
  const hasAreaMismatch = areaDiff != null && areaDiff > 0.04;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-blue-700 font-mono font-medium">
            <span>{t.nav.stepIndicator(6, 9)}</span>
            <span>•</span>
            <span>{t.validation.stepTag}</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-1">
            {t.validation.title}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t.common.documentLabel} <span className="font-mono text-slate-800 font-semibold">{activeDocument.fileName}</span> ({activeDocument.documentCode})
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveView('extraction_results')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold border border-slate-200 shadow-xs transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 text-slate-500" />
            <span>{t.common.back}</span>
          </button>

          <button
            onClick={() => setActiveView('human_verification')}
            className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-xs transition-all cursor-pointer"
          >
            <span>{t.validation.openWorkspaceBtn}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Summary Status Banner */}
      <div
        className={`p-4 rounded-xl border flex items-center justify-between gap-4 shadow-xs ${
          unresolvedCount === 0
            ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
            : 'bg-amber-50 border-amber-200 text-amber-900'
        }`}
      >
        <div className="flex items-center gap-3">
          {unresolvedCount === 0 ? (
            <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
          ) : (
            <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0" />
          )}
          <div>
            <div className="text-sm font-bold text-slate-900">
              {unresolvedCount === 0
                ? t.validation.passedChecks
                : t.validation.errorsFound(unresolvedCount)}
            </div>
            <div className="text-xs text-slate-600 mt-0.5">
              {unresolvedCount === 0
                ? t.validation.passedDesc
                : t.validation.errorsDesc}
            </div>
          </div>
        </div>

        <button
          onClick={() => setActiveView('verification_queue')}
          className="shrink-0 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 transition-colors shadow-xs"
        >
          {t.validation.viewQueueCount(unresolvedCount)}
        </button>
      </div>

      {/* Area Discrepancy Detected Banner */}
      {hasAreaMismatch && (
        <div className="bg-rose-50 border-2 border-rose-300 rounded-xl p-5 shadow-xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-rose-100 border border-rose-300 flex items-center justify-center text-rose-700 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs bg-rose-700 text-white font-bold px-2 py-0.5 rounded">
                    {t.validation.areaMismatchBanner}
                  </span>
                  {linkedParcel && (
                    <span className="font-mono text-xs text-slate-700 font-semibold">
                      {linkedParcel.id} ({isHindi ? 'खसरा' : 'Khasra'} {linkedParcel.khasraNo})
                    </span>
                  )}
                </div>
                <p className="text-xs text-rose-900 leading-relaxed font-medium">
                  {t.validation.areaMismatchDesc(
                    recordedHa!.toFixed(2),
                    mappedHa!.toFixed(2),
                    areaDiff!.toFixed(2),
                    ((areaDiff! / (recordedHa! || 1)) * 100).toFixed(1) + '%'
                  )}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs pt-1 max-w-lg">
                  <div className="bg-white p-2 rounded border border-rose-200">
                    <span className="text-[10px] text-slate-500 block">{isHindi ? 'अभिलेख क्षेत्रफल' : 'Recorded Area'}</span>
                    <span className="font-mono font-bold text-slate-900">{recordedHa!.toFixed(2)} ha</span>
                  </div>
                  <div className="bg-white p-2 rounded border border-rose-200">
                    <span className="text-[10px] text-slate-500 block">{isHindi ? 'जीआईएस मानचित्रित' : 'Mapped GIS'}</span>
                    <span className="font-mono font-bold text-blue-700">{mappedHa!.toFixed(2)} ha</span>
                  </div>
                  <div className="bg-white p-2 rounded border border-rose-200">
                    <span className="text-[10px] text-slate-500 block">{isHindi ? 'अंतर (विसंगति)' : 'Discrepancy'}</span>
                    <span className="font-mono font-bold text-rose-700">Δ {areaDiff!.toFixed(2)} ha</span>
                  </div>
                </div>
              </div>
            </div>

            {linkedParcel && (
              <button
                type="button"
                onClick={() => {
                  selectParcel(linkedParcel.id);
                  setActiveView('field_verification');
                }}
                className="self-start sm:self-auto shrink-0 flex items-center justify-center gap-2 bg-rose-700 hover:bg-rose-800 text-white text-xs font-bold px-4 py-2.5 rounded-lg shadow-sm transition-all cursor-pointer"
              >
                <span>{t.validation.proceedToFieldInspection}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Discrepancy Resolution Cards (If Any) */}
      {(validationErrors ?? []).length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
          <h3 className="text-sm font-bold text-slate-900 flex items-center justify-between">
            <span>{t.validation.identifiedDiscrepancies}</span>
            <span className="text-xs font-mono text-amber-700 font-semibold">
              {t.validation.pendingVsTotal(unresolvedCount, validationErrors.length)}
            </span>
          </h3>

          <div className="space-y-3">
            {validationErrors.map((err) => (
              <div
                key={err.id}
                className={`p-4 rounded-lg border text-xs transition-all ${
                  err.resolved
                    ? 'bg-slate-50 border-slate-200 text-slate-500'
                    : err.severity === 'Critical'
                    ? 'bg-rose-50 border-rose-200 text-slate-800'
                    : 'bg-amber-50/50 border-amber-200 text-slate-800'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          err.resolved
                            ? 'bg-slate-200 text-slate-600'
                            : err.severity === 'Critical'
                            ? 'bg-rose-100 text-rose-800'
                            : 'bg-amber-100 text-amber-900'
                        }`}
                      >
                        {err.ruleCode}
                      </span>
                      <span className="font-bold text-slate-900 text-xs">{err.title}</span>
                      {err.resolved && (
                        <span className="text-emerald-700 font-mono text-[10px] flex items-center gap-1 font-semibold">
                          <Check className="w-3 h-3" /> {t.validation.resolved}
                        </span>
                      )}
                    </div>
                    <p className="text-slate-600 leading-relaxed">{err.description}</p>
                    <p className="text-slate-500 text-[11px]">
                      <span className="font-semibold text-slate-700">{isHindi ? 'सुझाव / कार्रवाई: ' : 'Action: '}</span>
                      {err.suggestedAction}
                    </p>
                  </div>

                  {!err.resolved && (
                    <button
                      onClick={() => resolveValidationError(activeDocument.id, err.id)}
                      className="shrink-0 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow-xs transition-all cursor-pointer flex items-center gap-1"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{t.validation.resolveBtn}</span>
                    </button>
                  )}
                </div>

                {err.resolved && err.resolutionNote && (
                  <div className="mt-2 pt-2 border-t border-slate-200 text-[11px] text-emerald-800 font-mono">
                    {isHindi ? 'टिप्पणी: ' : 'Note: '}{err.resolutionNote}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Prototype validation checklist */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-3">
        <h3 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-2">
          {isHindi ? 'अभिलेख अनुपालन नियम ऑडिट तालिका' : 'Prototype Record Validation Checks (Rule Audit Table)'}
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {/* Check 1: Ownership Share Sum (Task 5) */}
          <div className="p-3.5 bg-slate-50 rounded-lg border border-slate-200/80 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900">{isHindi ? 'कुल मालिकाना हिस्सा योग' : 'Share Total Sum Check'}</span>
              {isShareMathValid ? (
                <span className="text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 text-[11px]">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> {t.validation.ownershipValidSummary(ownerShareSum.toFixed(1))}
                </span>
              ) : (
                <span className="text-rose-800 bg-rose-50 border border-rose-300 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 text-[11px]">
                  <XCircle className="w-3.5 h-3.5 text-rose-600" /> {t.validation.ownershipMismatchSummary(ownerShareSum.toFixed(1))}
                </span>
              )}
            </div>

            {/* Co-sharers breakdown */}
            <div className="bg-white p-2 rounded border border-slate-200 space-y-1 text-[11px]">
              {data.owners.map((owner, idx) => (
                <div key={owner.id} className="flex justify-between items-center text-slate-700">
                  <span>{idx + 1}. {owner.name} ({owner.shareFraction})</span>
                  <span className="font-mono font-bold text-emerald-700">{owner.sharePercentage}%</span>
                </div>
              ))}
              <div className="border-t border-slate-200 pt-1 mt-1 flex justify-between font-bold text-slate-900">
                <span>{isHindi ? 'कुल योग' : 'Total Sum'}:</span>
                <span className={`font-mono ${isShareMathValid ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {ownerShareSum.toFixed(2)}%
                </span>
              </div>
            </div>

            <p className="text-slate-500 text-[11px]">
              {isHindi ? 'सभी सह-खातेदारों के आनुपातिक हिस्से का योग 100% होना अनिवार्य है।' : 'Sum of fractional co-sharer ownership must add up to unity (100.00%).'}
            </p>
          </div>

          {/* Check 2: Area Conversion */}
          <div className="p-3.5 bg-slate-50 rounded-lg border border-slate-200/80 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900">{isHindi ? 'बीघा-बिस्वा से हेक्टेयर रूपांतरण' : 'Bigha-Biswa to Hectares Math'}</span>
              {!hasRakba ? (
                <span className="text-slate-600 bg-slate-100 border border-slate-300 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 text-[11px]">
                  <AlertTriangle className="w-3.5 h-3.5 text-slate-500" /> {isHindi ? 'मूल्यांकन नहीं — रकबा अनुपलब्ध' : 'Not evaluated — rakba missing'}
                </span>
              ) : isAreaMathValid ? (
                <span className="text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 text-[11px]">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> {isHindi ? `सत्यापित (${rakba.totalHectares} हे.)` : `Validated (${rakba.totalHectares} Ha)`}
                </span>
              ) : (
                <span className="text-rose-800 bg-rose-50 border border-rose-300 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 text-[11px]">
                  <XCircle className="w-3.5 h-3.5 text-rose-600" /> {isHindi ? `गणना अमेल (${bighaCalculatedHa!.toFixed(3)} हे. अपेक्षित)` : `Math mismatch (${bighaCalculatedHa!.toFixed(3)} Ha expected)`}
                </span>
              )}
            </div>
            <p className="text-slate-500 text-[11px]">
              {isHindi ? 'राजस्थान बंदोबस्त मानकों के अनुसार रूपांतरण (१ बीघा = ०.२५२९ हेक्टेयर)।' : 'Cross-checks conversion ratio (1 Bigha = 0.2529 Hectares for Rajasthan settlement).'}
            </p>
          </div>

          {/* Check 3: GIS Shajra Cadastre Link */}
          <div className="p-3.5 bg-slate-50 rounded-lg border border-slate-200/80 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900">{isHindi ? 'जीआईएस शजरा किश्तवार मिलान' : 'GIS Cadastral Polygon Existence'}</span>
              {shajraLinked ? (
                <span className="text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 text-[11px]">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> {isHindi ? 'शजरा उपलब्ध' : 'Shajra Match'}
                </span>
              ) : (
                <span className="text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 text-[11px]">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600" /> {isHindi ? 'कोई पार्सल नहीं — मूल्यांकन नहीं' : 'No linked parcel — not evaluated'}
                </span>
              )}
            </div>
            <p className="text-slate-500 text-[11px]">
              {shajraLinked
                ? (isHindi ? `खसरा नं. ${data.khasraNo?.value || 'अभिलेखित नहीं'} पार्सल ${linkedParcel!.id} से जुड़ा है; सीमाएँ मौका सत्यापन तक अनंतिम।` : `Khasra ${data.khasraNo?.value || 'not recorded'} links to parcel ${linkedParcel!.id}; boundary provisional until field verified.`)
                : (isHindi ? 'इस दस्तावेज़ से कोई डिजिटल कैडस्ट्रल पॉलीगॉन नहीं मिला; मिलान मूल्यांकित नहीं हुआ।' : 'No digital cadastral polygon is linked to this document; the match was not evaluated.')}
            </p>
          </div>

          {/* Check 4: Revenue Cess / Lagaan Tariff */}
          <div className="p-3.5 bg-slate-50 rounded-lg border border-slate-200/80 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900">{isHindi ? 'वार्षिक भू-राजस्व लगान दर' : 'Revenue Settlement Tariff'}</span>
              {lagaanNumeric != null && lagaanNumeric >= 0 ? (
                <span className="text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 text-[11px]">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> {isHindi ? `लगान दर्ज (₹${lagaanNumeric})` : `Lagaan recorded (₹${lagaanNumeric})`}
                </span>
              ) : (
                <span className="text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 text-[11px]">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600" /> {isHindi ? 'मूल्यांकन नहीं — लगान अनुपलब्ध' : 'Not evaluated — lagaan missing'}
                </span>
              )}
            </div>
            <p className="text-slate-500 text-[11px]">
              {isHindi
                ? `किस्म भूमि (${data.landClassification?.value || 'अभिलेखित नहीं'})। सरकारी दर-तालिका से मिलान इस बिल्ड में स्वतः नहीं होता।`
                : `Land class ${data.landClassification?.value || 'not recorded'}. Automated matching against the state tariff table does not run in this build.`}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
