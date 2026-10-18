import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import { OfficialSeal } from '../common/OfficialSeal';
import { StatusPill } from '../common/StatusPill';
import {
  Printer,
  Download,
  QrCode,
  ArrowRight,
  Map,
} from 'lucide-react';

export const VerifiedRecordView: React.FC = () => {
  const { activeDocument, setActiveView, addNotification } = useApp();
  const { t, isHindi } = useTranslation();
  const [copiedHash, setCopiedHash] = useState<boolean>(false);

  if (!activeDocument || !activeDocument.data || !activeDocument.auditTrail) {
    return (
      <div className="text-center py-12 text-slate-400">
        {t.verifiedRecord.noRecord}
      </div>
    );
  }

  const { data, auditTrail } = activeDocument;
  const isSealed = activeDocument.status === 'Verified' && Boolean(auditTrail.certificateNumber);
  const certificateNumber = auditTrail.certificateNumber;
  const verificationFingerprint = auditTrail.digitalSignatureHash || 'demo-fingerprint-not-a-cryptographic-signature';
  const lagaanValue = typeof data.annualLagaanRevenue?.value === 'number' ? data.annualLagaanRevenue.value : null;
  const mutation = data.mutationDetails;

  const handleCopyHash = () => {
    navigator.clipboard.writeText(verificationFingerprint);
    setCopiedHash(true);
    addNotification(
      isHindi ? 'फिंगरप्रिंट कॉपी किया गया' : 'Fingerprint Copied',
      isHindi ? 'सत्यापन फिंगरप्रिंट क्लिपबोर्ड में कॉपी किया गया।' : 'Prototype verification fingerprint copied to clipboard.',
      'info'
    );
    setTimeout(() => setCopiedHash(false), 2000);
  };

  const handlePrint = () => {
    window.print();
  };

  const handleExportJSON = () => {
    const exportPayload = {
      standard: 'NLRMP-ROR-V2.4',
      sealed: isSealed,
      certificateNumber: certificateNumber || 'NOT_ISSUED',
      issuedAt: auditTrail.verifiedAt || null,
      verifier: isSealed
        ? { name: auditTrail.verifiedBy || 'not recorded', badge: auditTrail.verifierBadge || 'not recorded' }
        : null,
      prototypeVerificationFingerprint: verificationFingerprint,
      cadastralRecord: {
        state: data.state.value,
        district: data.district.value,
        tehsil: data.tehsil.value,
        village: data.villageMauza.value,
        patwarCircle: data.patwarCircle.value,
        settlementYear: data.settlementYear.value,
        khasraNo: data.khasraNo.value,
        khatauniNo: data.khatauniNo.value,
        khewatNo: data.khewatNo.value,
        owners: data.owners,
        area: data.rakbaArea,
        landClassification: data.landClassification.value,
        annualLagaan: lagaanValue ?? null,
        encumbrance: data.encumbrance,
      },
    };

    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `DHAROHAR_Prototype_Record_${(data.khasraNo?.value || 'UNMAPPED').replace('/', '_')}_${data.villageMauza?.value || 'RECORD'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    addNotification(
      isHindi ? 'निर्यात संपन्न' : 'Export Complete',
      isHindi ? 'डिजिटल JSON अभिलेख सफलतापूर्वक निर्यात किया गया।' : 'Prototype JSON record exported.',
      'success'
    );
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Action Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4 print:hidden">
        <div>
          <div className="flex items-center gap-2 text-xs text-blue-700 font-mono font-medium">
            <span>{t.verifiedRecord.stepBadge}</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-1 flex items-center gap-2">
            <span>{t.verifiedRecord.title}</span>
            <StatusPill status={activeDocument.status} size="sm" />
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t.verifiedRecord.subtitle}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => setActiveView('spatial_registry')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-800 text-xs font-semibold border border-blue-200 transition-colors cursor-pointer shadow-xs"
          >
            <Map className="w-4 h-4 text-blue-700" />
            <span>{isHindi ? 'भू-नक्शे पर देखें' : 'View on Spatial Map'}</span>
          </button>

          <button
            onClick={handleExportJSON}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium border border-slate-200 transition-colors cursor-pointer shadow-xs"
          >
            <Download className="w-4 h-4 text-slate-600" />
            <span>{t.verifiedRecord.exportJson}</span>
          </button>

          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold border border-slate-200 shadow-xs transition-all cursor-pointer"
          >
            <Printer className="w-4 h-4 text-slate-700" />
            <span>{t.verifiedRecord.print}</span>
          </button>

          <button
            onClick={() => setActiveView('verification_queue')}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-all cursor-pointer shadow-xs"
          >
            <span>{t.verifiedRecord.nextInQueue}</span>
            <ArrowRight className="w-4 h-4 text-white" />
          </button>
        </div>
      </div>

      {/* Prototype Verified Record (Printable Sheet) */}
      <div className="bg-[#fcfaf4] text-slate-900 border-2 border-slate-800 rounded-xl p-8 sm:p-10 shadow-2xl relative font-serif print:border-none print:shadow-none print:p-0">
        {/* Subtle Watermark */}
        <OfficialSeal size="watermark" />

        {/* Certificate Top Header */}
        <div className="border-b-2 border-slate-900 pb-5 mb-5 text-center relative">
          <div className="flex items-center justify-between text-xs font-sans text-slate-600 mb-2">
            <span className="font-mono uppercase font-semibold">{t.verifiedRecord.formHeader}</span>
            <span className={`font-mono font-bold px-2.5 py-0.5 rounded border ${
              isSealed
                ? 'text-slate-900 bg-amber-200/80 border-amber-400'
                : 'text-rose-900 bg-rose-50 border-rose-300'
            }`}>
              {isSealed ? certificateNumber : (isHindi ? 'प्रमाण-पत्र जारी नहीं — असीलबंद' : 'NO CERTIFICATE — UNSEALED')}
            </span>
            <span className="font-mono">{t.verifiedRecord.samvatYear} {data.settlementYear.value}</span>
          </div>

          {/* Prototype Record Header */}
          <div className="flex items-center justify-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-full border border-amber-800/40 bg-amber-50 flex items-center justify-center text-amber-900">
              <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6">
                <path d="M24 6L28 12H20L24 6Z" fill="currentColor" />
                <path d="M18 12H30V22H18V12Z" strokeWidth="1.8" />
                <circle cx="24" cy="33" r="5" strokeWidth="1.5" />
                <path d="M10 40H38V43H10V40Z" fill="currentColor" />
              </svg>
            </div>
            <div>
              <div className="text-xl font-bold uppercase tracking-wide text-slate-950">
                {t.verifiedRecord.stateGovt}
              </div>
              <div className="text-xs font-sans text-slate-700 font-semibold tracking-wider">
                {t.verifiedRecord.systemTag}
              </div>
            </div>
          </div>

          <div className="text-base font-bold uppercase text-slate-900 mt-2 tracking-wide font-sans">
            {t.verifiedRecord.docHeading}
          </div>

          {/* Administrative Jurisdiction Info Box */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 text-left font-sans text-xs bg-slate-100 p-2.5 rounded border border-slate-300">
            <div>
              <span className="text-slate-500 text-[10px] block">{t.verifiedRecord.district}</span>
              <span className="font-bold text-slate-950">{data.district.value}</span>
            </div>
            <div>
              <span className="text-slate-500 text-[10px] block">{t.verifiedRecord.tehsil}</span>
              <span className="font-bold text-slate-950">{data.tehsil.value}</span>
            </div>
            <div>
              <span className="text-slate-500 text-[10px] block">{t.verifiedRecord.patwarCircle}</span>
              <span className="font-bold text-slate-950">{data.patwarCircle.value}</span>
            </div>
            <div>
              <span className="text-slate-500 text-[10px] block">{t.verifiedRecord.villageMauza}</span>
              <span className="font-bold text-slate-950">{data.villageMauza.value}</span>
            </div>
          </div>
        </div>

        {/* Land Record Table Columns */}
        <div className="border border-slate-900 font-sans text-xs mb-6">
          {/* Table Header */}
          <div className="grid grid-cols-12 bg-slate-200 border-b border-slate-900 font-bold text-slate-900 text-center divide-x divide-slate-800 text-[11px]">
            <div className="col-span-2 p-2">
              <div>{t.verifiedRecord.colKhasra}</div>
              <div className="text-[9px] font-normal text-slate-600">Khasra No.</div>
            </div>
            <div className="col-span-2 p-2">
              <div>{t.verifiedRecord.colKhatauni}</div>
              <div className="text-[9px] font-normal text-slate-600">Khatauni No.</div>
            </div>
            <div className="col-span-4 p-2">
              <div>{t.verifiedRecord.colOwners}</div>
              <div className="text-[9px] font-normal text-slate-600">Co-Sharer & Share Fraction</div>
            </div>
            <div className="col-span-2 p-2">
              <div>{t.verifiedRecord.colArea}</div>
              <div className="text-[9px] font-normal text-slate-600">Area</div>
            </div>
            <div className="col-span-2 p-2">
              <div>{t.verifiedRecord.colLagaan}</div>
              <div className="text-[9px] font-normal text-slate-600">Lagaan & Soil</div>
            </div>
          </div>

          {/* Table Content Row */}
          <div className="grid grid-cols-12 divide-x divide-slate-800 min-h-[220px] bg-white">
            {/* Khasra Column */}
            <div className="col-span-2 p-3 text-center">
              <div className="text-base font-extrabold text-slate-950 font-mono">
                {data.khasraNo.value}
              </div>
              <div className="text-xs text-slate-700 font-serif mt-0.5">({data.khasraNo.hindiValue})</div>
              <div className="mt-3 text-[10px] text-slate-500 font-mono bg-slate-100 p-1 rounded border border-slate-200">
                {t.verifiedRecord.colKhewat}: {data.khewatNo.value}
              </div>
            </div>

            {/* Khatauni Column */}
            <div className="col-span-2 p-3 text-center">
              <div className="text-base font-extrabold text-slate-950 font-mono">
                {data.khatauniNo.value}
              </div>
              <div className="text-xs text-slate-700 font-serif mt-0.5">({data.khatauniNo.hindiValue})</div>
            </div>

            {/* Co-Sharers Column */}
            <div className="col-span-4 p-3 space-y-2.5 text-xs">
              {data.owners.map((owner, idx) => (
                <div key={owner.id} className="border-b border-slate-200 pb-2 last:border-0">
                  <div className="font-bold text-slate-950 text-xs">
                    {idx + 1}. {owner.name} ({owner.hindiName})
                  </div>
                  <div className="text-slate-700 font-serif text-[11px]">
                    {owner.relationType} {owner.relativeName}
                  </div>
                  <div className="flex items-center justify-between text-[10px] mt-1">
                    <span className="font-mono bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 font-semibold text-slate-900">
                      {t.verifiedRecord.share} {owner.shareFraction} ({owner.sharePercentage}%)
                    </span>
                    <span className="text-slate-600 font-mono">{t.verifiedRecord.aadhaar} {owner.aadhaarRef || (isHindi ? 'अभिलेखित नहीं' : 'Not recorded')}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Area Column */}
            <div className="col-span-2 p-3 text-center text-xs">
              <div className="font-bold text-slate-950 font-mono text-sm">
                {data.rakbaArea.bigha} {isHindi ? 'बीघा' : 'Bigha'} {data.rakbaArea.biswa} {isHindi ? 'बिस्वा' : 'Biswa'}
              </div>
              <div className="text-[11px] text-emerald-800 font-mono font-bold mt-1 bg-emerald-50 px-1 py-0.5 rounded border border-emerald-200">
                {data.rakbaArea.totalHectares} {t.verifiedRecord.hectares}
              </div>
              <div className="text-[10px] text-slate-600 mt-2 font-mono">
                ({data.rakbaArea.standardAcre} {t.verifiedRecord.standardAcres})
              </div>
            </div>

            {/* Lagaan & Soil Column */}
            <div className="col-span-2 p-3 text-center text-xs">
              <div className="font-bold text-slate-950 font-mono text-sm">
                {lagaanValue !== null ? `₹${lagaanValue.toFixed(2)}` : isHindi ? 'लगान अभिलेखित नहीं' : 'Lagaan not recorded'}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">{t.verifiedRecord.perAnnum}</div>
              <div className="mt-3 text-[10px] text-slate-800 bg-slate-100 p-1 rounded font-medium border border-slate-200">
                {data.landClassification.value}
              </div>
            </div>
          </div>

          {/* Remarks & Legal Encumbrance Box */}
          <div className="p-3 bg-slate-50 border-t border-slate-900 text-xs">
            <span className="font-bold text-slate-950">{t.verifiedRecord.remarksHeading} </span>
            {data.encumbrance.isMortgaged && (
              <span className="text-amber-950 font-semibold">
                {t.verifiedRecord.hypothecation} {data.encumbrance.bankName} {t.verifiedRecord.loanAmount}{data.encumbrance.mortgageAmountINR?.toLocaleString(isHindi ? 'hi-IN' : 'en-IN')}.{' '}
              </span>
            )}
            {data.encumbrance.courtInjunctionActive && (
              <span className="text-rose-950 font-bold">
                {t.verifiedRecord.courtStay} {data.encumbrance.courtCaseRef}.{' '}
              </span>
            )}
            <span className="text-slate-800">
              {mutation?.lastMutationNo && mutation?.mutationDate && mutation?.mutationType
                ? isHindi
                  ? `अंतिम नामांतरण संख्या ${mutation.lastMutationNo} दिनांक ${mutation.mutationDate} द्वारा ${mutation.mutationType} अनुमोदित।`
                  : `Last mutation record no. ${mutation.lastMutationNo} dated ${mutation.mutationDate} approved as ${mutation.mutationType}.`
                : isHindi
                ? 'नामांतरण का विवरण अभिलेख में उपलब्ध नहीं है।'
                : 'Mutation details are not available in this record.'}
            </span>
          </div>
        </div>

        {/* Certificate Bottom Signatures & QR Seal */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center pt-4 border-t border-slate-300 font-sans text-xs">
          {/* QR Code & prototype verification fingerprint */}
          <div className="sm:col-span-6 flex items-center gap-3">
            <div className="w-20 h-20 bg-white border border-slate-400 p-1.5 rounded flex items-center justify-center shrink-0 shadow-sm">
              <QrCode className="w-16 h-16 text-slate-900" />
            </div>
            <div className="text-[10px] space-y-1">
              <div className="font-bold text-slate-900">{t.verifiedRecord.qrTitle}</div>
              <div className="text-slate-600 leading-tight">
                {t.verifiedRecord.qrDesc}
              </div>
              <div className="font-mono text-[8px] text-slate-500 truncate max-w-[200px]">
                {t.verifiedRecord.fingerprintLabel} {verificationFingerprint}
              </div>
            </div>
          </div>

          {/* Prototype Verification Stamp */}
          <div className="sm:col-span-6 flex justify-end">
            <OfficialSeal
              variant="signed_stamp"
              sealed={isSealed}
              officerName={auditTrail.verifiedBy}
              badgeNumber={auditTrail.verifierBadge}
              certNumber={certificateNumber}
            />
          </div>
        </div>

        {/* Bottom Disclaimer */}
        <div className="mt-6 pt-3 border-t border-slate-300 text-[10px] text-slate-500 text-center font-sans space-y-0.5">
          <div>{t.verifiedRecord.footerDisclaimer}</div>
          <div className="text-slate-400 font-mono text-[9px]">{t.verifiedRecord.footerMode}</div>
        </div>
      </div>
    </div>
  );
};
