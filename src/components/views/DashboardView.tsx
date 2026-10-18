import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import { ActiveView } from '../../types';
import { ConfidenceBadge } from '../common/ConfidenceBadge';
import { StatusPill } from '../common/StatusPill';
import {
  FileText,
  ShieldCheck,
  Clock,
  UploadCloud,
  Layers,
  ArrowRight,
  Filter,
  BarChart2,
  AlertTriangle,
  ChevronRight,
  Map,
  MapPinned,
} from 'lucide-react';

export const DashboardView: React.FC = () => {
  const {
    currentUser,
    documents,
    districtMetrics,
    batches,
    setActiveView,
    selectDocument,
    parcels,
    activeParcels,
  } = useApp();

  const { t, isHindi } = useTranslation();
  const [selectedDistrict, setSelectedDistrict] = useState<string>('All');

  // Stats calculation
  const totalVerified = documents.filter((d) => d.status === 'Verified').length;
  // "2 Active" was hardcoded. This counts only batches that are actually in flight —
  // 'Validation Ready' and 'Completed' batches are not running anything.
  const runningBatches = batches.filter((b) =>
    b.status === 'Queued' || b.status === 'Scanning' || b.status === 'OCR In Progress'
  ).length;
  const totalPending = documents.filter(
    (d) => d.status === 'Pending Verification' || d.status === 'Under Review'
  ).length;
  const verifiedParcels = activeParcels.filter((p) => p.status === 'Verified').length;
  const totalMappedArea = activeParcels.reduce((sum, p) => sum + (Number.isFinite(p.mappedAreaHectares) ? p.mappedAreaHectares : 0), 0);
  const agriculturalArea = activeParcels
    .filter((p) => /agri|chahi|barani|irrigat|rainfed|cultivat|farm/i.test(p.landType || ''))
    .reduce((sum, p) => sum + (Number.isFinite(p.mappedAreaHectares) ? p.mappedAreaHectares : 0), 0);
  const residentialArea = activeParcels
    .filter((p) => /resid|abadi/i.test(p.landType || ''))
    .reduce((sum, p) => sum + (Number.isFinite(p.mappedAreaHectares) ? p.mappedAreaHectares : 0), 0);
  const fieldVerificationCount = activeParcels.filter((p) => p.status === 'Needs Field Verification').length;
  const mismatchCount = activeParcels.filter((p) => p.recordedAreaHectares != null && Number.isFinite(p.recordedAreaHectares) && Math.abs(p.mappedAreaHectares - p.recordedAreaHectares) > 0.05).length;
  const missingDocumentCount = activeParcels.filter((p) => !p.documentName && !p.documentUri && !p.documentId).length;

  // These figures come from the bundled demo dataset, not from the registry, so they are scoped the
  // same way the real data is: an officer sees their own districts unless they hold STATE_WIDE_READ.
  // Presentation only — the server re-reads assignments on every request regardless of this.
  const officerDistricts = (currentUser?.districts?.length
    ? currentUser.districts
    : currentUser?.district ? [currentUser.district] : []
  ).map((d) => String(d).trim().toLowerCase());
  const seesWholeState = (currentUser?.capabilities ?? []).includes('STATE_WIDE_READ');
  const visibleMetrics = seesWholeState
    ? districtMetrics
    : districtMetrics.filter((dm) => officerDistricts.includes(String(dm.district).trim().toLowerCase()));

  const filteredDistricts =
    selectedDistrict === 'All'
      ? visibleMetrics
      : visibleMetrics.filter((d) => d.district === selectedDistrict);

  return (
    <div className="space-y-6">
      {/* Welcome Banner */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono font-bold bg-blue-50 text-blue-800 border border-blue-200 px-2 py-0.5 rounded">
              {t.app.title} • {t.app.prototypeBadge}
            </span>
            <span className="text-xs text-slate-300">|</span>
            <span className="text-xs text-slate-600 font-medium">{currentUser.district} {t.app.jurisdiction}</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-1">
            {t.common.all === 'सभी' ? `स्वागत है, ${currentUser.name}` : `Welcome, ${currentUser.name}`}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {currentUser.designation} • {currentUser.jurisdiction}
          </p>
        </div>

        {/* Quick Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => setActiveView('upload')}
            className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-3.5 py-2 rounded-lg shadow-xs transition-all cursor-pointer"
          >
            <UploadCloud className="w-4 h-4" />
            <span>{t.dashboard.startUpload}</span>
          </button>

          <button
            onClick={() => setActiveView('verification_queue')}
            className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold px-3.5 py-2 rounded-lg shadow-xs transition-all cursor-pointer"
          >
            <Clock className="w-4 h-4 text-white" />
            <span>{t.dashboard.verificationQueue} ({totalPending})</span>
          </button>

          <button
            onClick={() => setActiveView('bulk_processing')}
            className="flex items-center gap-2 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium px-3 py-2 rounded-lg border border-slate-200 shadow-xs transition-all cursor-pointer"
          >
            <Layers className="w-4 h-4 text-slate-500" />
            <span>{t.nav.bulkProcessing}</span>
          </button>
        </div>
      </div>


      {/* Spatial registry entry point */}
      <div className="bg-slate-900 text-white rounded-xl p-5 sm:p-6 shadow-sm flex flex-col lg:flex-row lg:items-center justify-between gap-5">
        <div className="flex items-start gap-3.5">
          <div className="w-11 h-11 rounded-lg bg-white/10 flex items-center justify-center shrink-0 border border-white/10">
            <Map className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider font-mono text-blue-300 font-semibold">{t.dashboard.primaryWorkspace}</div>
            <h3 className="text-lg sm:text-xl font-bold mt-0.5">{t.spatial.title}</h3>
            <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed">
              {t.spatial.subtitle}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 sm:gap-6 self-start lg:self-center">
          <div className="text-left lg:text-right">
            <div className="text-2xl font-bold font-mono text-white">{activeParcels.length}</div>
            <div className="text-[10px] text-slate-400 uppercase font-mono tracking-wider">{t.spatial.activeParcelsCount(activeParcels.length)}</div>
          </div>
          <button onClick={() => setActiveView('spatial_registry')} className="inline-flex items-center gap-2 bg-white text-slate-900 px-4 py-2.5 rounded-lg text-xs font-bold hover:bg-slate-100 transition-colors shadow-xs cursor-pointer">
            <MapPinned className="w-4 h-4 text-slate-900" /> {t.dashboard.openRegistry} <ArrowRight className="w-3.5 h-3.5 text-slate-700" />
          </button>
        </div>
      </div>

      {/* Restored document-workflow snapshot from the previous dashboard, using live prototype data. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {(
          [
            [t.dashboard.docRecords, documents.length, t.dashboard.docRecordsCaption, FileText],
            [t.dashboard.verifiedRecords, totalVerified, t.dashboard.verifiedRecordsCaption, ShieldCheck],
            [t.dashboard.verificationQueue, totalPending, t.dashboard.verificationQueueCaption, Clock],
          ] as [string, number, string, React.ComponentType<{ className?: string }>][]
        ).map(([label, value, caption, Icon]) => (
          <div key={label} className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
              <span>{label}</span>
              <div className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center">
                <Icon className="w-4 h-4 text-slate-600" />
              </div>
            </div>
            <div className="mt-2">
              <div className="text-2xl font-extrabold text-slate-900 font-mono">{Number(value).toLocaleString('en-IN')}</div>
              <div className="text-[11px] text-slate-500 mt-1">{caption}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Core spatial registry metrics — derived from the active parcel registry */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {(
          [
            [t.dashboard.totalParcels, activeParcels.length, t.dashboard.totalParcelsCaption, MapPinned],
            [t.dashboard.totalMappedArea, `${totalMappedArea.toFixed(2)} ha`, t.dashboard.totalMappedAreaCaption, Map],
            [t.dashboard.agriArea, `${agriculturalArea.toFixed(2)} ha`, t.dashboard.agriAreaCaption, Map],
            [t.dashboard.resArea, `${residentialArea.toFixed(2)} ha`, t.dashboard.resAreaCaption, Map],
            [t.dashboard.verifiedParcels, verifiedParcels, t.dashboard.verifiedParcelsCaption, ShieldCheck],
            [t.dashboard.needsVerification, fieldVerificationCount, t.dashboard.needsVerificationCaption, Clock],
            [t.dashboard.areaMismatch, mismatchCount, t.dashboard.areaMismatchCaption, AlertTriangle],
            [t.dashboard.missingDocs, missingDocumentCount, t.dashboard.missingDocsCaption, FileText],
          ] as [string, string | number, string, React.ComponentType<{ className?: string }>][]
        ).map(([label, value, caption, Icon]) => (
          <div key={label} className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
              <span>{label}</span>
              <div className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center">
                <Icon className="w-4 h-4 text-slate-600" />
              </div>
            </div>
            <div className="mt-2">
              <div className="text-2xl font-extrabold text-slate-900 font-mono">{String(value)}</div>
              <div className="text-[11px] text-slate-500 mt-1">{caption}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Direct navigation to the main registry modules. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[
          [t.dashboard.navModuleParcels, t.dashboard.navModuleParcelsSub, 'spatial_registry', Map],
          [t.dashboard.navModuleSearch, t.dashboard.navModuleSearchSub, 'spatial_registry', Filter],
          [t.dashboard.navModuleQueue, t.dashboard.navModuleQueueSub(fieldVerificationCount), 'verification_queue', Clock],
          [t.dashboard.navModuleVerified, t.dashboard.navModuleVerifiedSub(verifiedParcels), 'verified_record', ShieldCheck],
          [t.dashboard.navModuleDocs, t.dashboard.navModuleDocsSub(documents.length), 'upload', FileText],
          [t.dashboard.navModuleReports, t.dashboard.navModuleReportsSub, 'digitization_reports', BarChart2],
        ].map(([title, caption, view, Icon]) => (
          <button
            key={String(title)}
            onClick={() => setActiveView(view as ActiveView)}
            className="text-left bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-300 hover:shadow-sm transition-all cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-slate-50 flex items-center justify-center">
                <Icon className="w-4 h-4 text-slate-700" />
              </div>
              <span className="text-xs font-bold text-slate-900">{String(title)}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">{String(caption)}</p>
            <div className="text-[10px] text-blue-700 font-semibold mt-2">{t.common.open} →</div>
          </button>
        ))}
      </div>

      {/* Parcel-first overview — the spatial registry is the primary product surface. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-wider font-mono text-slate-400">{t.dashboard.spatialRegistryOverview}</div>
              <h3 className="text-sm font-bold text-slate-900 mt-1">{t.dashboard.recentLandParcels}</h3>
              <p className="text-xs text-slate-500 mt-0.5">{t.dashboard.parcelPrimaryUnit}</p>
            </div>
            <button onClick={() => setActiveView('spatial_registry')} className="text-xs font-bold text-blue-700 hover:text-blue-800">{t.dashboard.openMapLink}</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
            {activeParcels.slice(0, 3).map((p) => (
              <div key={p.id} className="rounded-lg border border-slate-200 p-3 bg-slate-50">
                <div className="font-mono text-[10px] font-bold text-blue-700 truncate">{p.id}</div>
                <div className="text-xs font-semibold text-slate-900 mt-1 truncate">{p.village || (isHindi ? 'ग्राम दर्ज नहीं' : 'Village not recorded')}</div>
                <div className="text-[11px] text-slate-600 mt-1">{p.mappedAreaHectares.toFixed(3)} {isHindi ? 'हेक्टेयर' : 'ha'}</div>
                <div className="text-[10px] mt-1 font-semibold text-slate-500">{t.dashboard.ownersCount(p.owners?.length || 0, t.status[p.status] || p.status)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="lg:col-span-4 bg-slate-50 border border-slate-200 rounded-xl p-5">
          <div className="text-[10px] uppercase tracking-wider font-mono text-slate-400">{t.dashboard.fieldVerificationCardTitle}</div>
          <div className="text-3xl font-black font-mono text-slate-900 mt-1">{fieldVerificationCount}</div>
          <div className="text-xs text-slate-600 mt-1">{t.dashboard.parcelsAwaitingVerification}</div>
          <button onClick={() => setActiveView('spatial_registry')} className="mt-4 w-full border border-slate-300 bg-white rounded-lg py-2 text-xs font-bold text-slate-800">{t.dashboard.reviewOnMapBtn}</button>
        </div>
      </div>

      {/* Main Grid: District Progress + Recent Queue Records */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 7 cols: District-wise Progress */}
        <div className="lg:col-span-7 bg-slate-50 border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-blue-700" />
                <span>{t.dashboard.districtDigitizationTitle}</span>
                <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                  {t.dashboard.demoMetricsBadge}
                </span>
              </h3>
              <p className="text-xs text-slate-500">
                {t.dashboard.districtDigitizationSubtitle}
              </p>
            </div>

            <div className="flex items-center gap-1.5 bg-slate-50 p-1 rounded-lg border border-slate-200 text-xs">
              <Filter className="w-3 h-3 text-slate-400 ml-1" />
              <select
                value={selectedDistrict}
                onChange={(e) => setSelectedDistrict(e.target.value)}
                className="bg-transparent text-slate-700 text-xs focus:outline-none pr-2 cursor-pointer font-sans font-medium"
              >
                <option value="All">{t.dashboard.allDistricts}</option>
                {visibleMetrics.map((dm) => (
                  <option key={dm.district} value={dm.district}>
                    {dm.district}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* District Bars List */}
          <div className="space-y-3 pt-1">
            {filteredDistricts.length === 0 ? (
              <p className="text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                {t.dashboard.noDistrictAssignedMetrics}
              </p>
            ) : null}
            {filteredDistricts.map((dm) => {
              const percentage = Math.round((dm.digitizedRecords / dm.totalRecords) * 100);
              const verifiedPercentage = Math.round((dm.verifiedRecords / dm.totalRecords) * 100);

              return (
                <div
                  key={dm.district}
                  className="p-3 bg-slate-50 rounded-lg border border-slate-200/80 hover:border-slate-300 transition-colors"
                >
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900">{dm.district}</span>
                      <span className="text-slate-500 font-mono text-[11px]">
                        {t.dashboard.mauzasCount(dm.completedVillages, dm.totalVillages)}
                      </span>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-slate-500 font-mono text-[11px]">
                        {dm.digitizedRecords.toLocaleString('en-IN')} / {dm.totalRecords.toLocaleString('en-IN')}
                      </span>
                      <span className="font-mono font-bold text-slate-900 text-xs">
                        {percentage}%
                      </span>
                    </div>
                  </div>

                  {/* Dual-tone Progress Bar */}
                  <div className="w-full bg-slate-200 h-2.5 rounded-full overflow-hidden flex">
                    <div
                      style={{ width: `${verifiedPercentage}%` }}
                      className="bg-emerald-600 h-full"
                      title={`${t.dashboard.verifiedRecords}: ${verifiedPercentage}%`}
                    />
                    <div
                      style={{ width: `${percentage - verifiedPercentage}%` }}
                      className="bg-blue-600 h-full"
                      title={`${t.dashboard.inPipelineLabel}: ${percentage - verifiedPercentage}%`}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-slate-500 mt-1.5">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-emerald-600 inline-block" />
                        <span className="font-medium text-slate-700">{t.dashboard.verifiedProgress(dm.verifiedRecords.toLocaleString('en-IN'))}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-blue-600 inline-block" />
                        <span className="font-medium text-slate-700">{t.dashboard.pipelineProgress((dm.digitizedRecords - dm.verifiedRecords).toLocaleString('en-IN'))}</span>
                      </span>
                    </div>
                    <span className="font-mono text-slate-600 font-semibold">{t.dashboard.accuracyLabel}: {dm.accuracyScore}%</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-2 flex items-center justify-between text-xs text-slate-500 border-t border-slate-100">
            <span>{t.dashboard.simulatedMetricsNotice}</span>
            <button
              onClick={() => setActiveView('digitization_reports')}
              className="text-blue-700 hover:text-blue-800 font-semibold flex items-center gap-1 cursor-pointer"
            >
              <span>{t.dashboard.viewDetailedReports}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Right 5 cols: Active Processing & Verification Queue */}
        <div className="lg:col-span-5 space-y-4">
          {/* Active Documents Table */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">{t.dashboard.activeQueueTitle}</h3>
                <p className="text-xs text-slate-500">{t.dashboard.activeQueueSubtitle}</p>
              </div>
              <button
                onClick={() => setActiveView('verification_queue')}
                className="text-xs text-blue-700 hover:text-blue-800 font-semibold cursor-pointer"
              >
                {t.dashboard.viewAllLink}
              </button>
            </div>

            <div className="space-y-2.5">
              {documents.slice(0, 4).map((doc) => (
                <div
                  key={doc.id}
                  onClick={() => selectDocument(doc.id, 'extraction_results')}
                  className="p-3 bg-slate-50 hover:bg-slate-100/80 rounded-lg border border-slate-200/80 cursor-pointer transition-all flex flex-col gap-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-xs text-slate-900">
                      {doc.documentCode}
                    </span>
                    <StatusPill status={doc.status} size="sm" />
                  </div>

                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span>
                      {doc.village} ({doc.tehsil})
                    </span>
                    {doc.ocrEngines?.tesseractConfidence > 0 ? (
                      <ConfidenceBadge score={doc.ocrEngines.tesseractConfidence} size="sm" />
                    ) : (
                      <span className="text-[10px] text-slate-400 font-mono">{isHindi ? 'मापा नहीं' : 'not measured'}</span>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-500 border-t border-slate-200/60 pt-1 mt-0.5">
                    <span className="truncate max-w-[200px]">{doc.fileName}</span>
                    <span className="text-blue-700 flex items-center gap-0.5 font-semibold">
                      {t.dashboard.inspectLink} <ArrowRight className="w-3 h-3" />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Active Bulk Batches Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="font-bold text-slate-900 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-blue-700" />
                <span>{t.dashboard.liveBatchWorkers}</span>
              </span>
              <span className={`font-mono text-[11px] px-1.5 py-0.5 rounded border font-bold ${
                runningBatches > 0 ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-slate-600 bg-slate-100 border-slate-300'
              }`}>{t.dashboard.activeBatchesCount(runningBatches)}</span>
            </div>

            {runningBatches === 0 && (
              <p className="text-[10px] text-slate-500 border border-dashed border-slate-300 rounded-lg px-2.5 py-2 mt-1">
                {isHindi
                  ? 'कोई बैच प्रसंस्करण में नहीं। नीचे दिखाई गई गति अनुमान है, मापी गई नहीं।'
                  : 'No batch is processing. The throughput below is a planning estimate, not a measurement.'}
              </p>
            )}

            {batches.slice(0, 2).map((batch) => (
              <div key={batch.id} className="text-xs p-2.5 bg-slate-50 rounded-lg border border-slate-200/80 mt-2">
                <div className="flex items-center justify-between font-semibold text-slate-900">
                  <span className="truncate max-w-[180px]">{batch.batchName}</span>
                  <span className="text-[10px] font-mono text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 font-bold">{t.status[batch.status] || batch.status}</span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-slate-500 mt-1 font-medium">
                  <span>{t.dashboard.docsCount(batch.processedCount, batch.totalDocuments)}</span>
                  <span className="font-mono text-slate-700" title={isHindi ? 'योजना अनुमान; मापित नहीं' : 'Planning estimate, not measured'}>
                    ~{t.dashboard.throughputCount(batch.throughputPerPageHour)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
