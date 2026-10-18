import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import {
  Layers,
  Play,
  UploadCloud,
  Plus,
  ArrowRight,
} from 'lucide-react';

export const BulkProcessingView: React.FC = () => {
  const { batches, startBatchProcessing, createBatch, addNotification, setActiveView } = useApp();
  const { t, isHindi } = useTranslation();

  const [selectedBatchId, setSelectedBatchId] = useState<string>(batches[0]?.id || '');
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newBatchName, setNewBatchName] = useState<string>('Sanganer South - Mauza Bilwa Jamabandi 2024-25');
  const [newDistrict, setNewDistrict] = useState<string>('Jaipur');
  const [newTehsil, setNewTehsil] = useState<string>('Sanganer');
  const [newVillage, setNewVillage] = useState<string>('Bilwa');
  const [newTotalDocs, setNewTotalDocs] = useState<number>(450);

  const selectedBatch = batches.find((b) => b.id === selectedBatchId) || batches[0];

  const handleCreateBatch = (e: React.FormEvent) => {
    e.preventDefault();
    const created = createBatch({
      batchName: newBatchName,
      district: newDistrict,
      tehsil: newTehsil,
      village: newVillage,
      recordType: 'Jamabandi (RoR - Record of Rights)',
      totalDocuments: newTotalDocs,
      processedCount: 0,
      verifiedCount: 0,
      flaggedCount: 0,
      failedCount: 0,
      status: 'Queued',
      startedAt: isHindi ? 'अभी-अभी' : 'Just now',
      estimatedCompletion: isHindi ? '४५ मिनट शेष' : '45 mins remaining',
      throughputPerPageHour: 1350,
      documents: [],
    });
    setShowCreateModal(false);
    setSelectedBatchId(created.id);
    addNotification(
      isHindi ? 'बैच प्रविष्ट हुआ' : 'Batch Ingested',
      isHindi ? `बैच '${newBatchName}' ${newTotalDocs} पृष्ठों के साथ पंक्तिबद्ध हुआ।` : `Batch '${newBatchName}' queued with ${newTotalDocs} sheets.`,
      'success'
    );
  };

  const totalSheets = batches.reduce((sum, b) => sum + (b.totalDocuments || 0), 0);
  const totalProcessed = batches.reduce((sum, b) => sum + (b.processedCount || 0), 0);
  const totalVerified = batches.reduce((sum, b) => sum + (b.verifiedCount || 0), 0);
  const plannedThroughputPerHour = batches.length
    ? Math.round(batches.reduce((sum, b) => sum + (b.throughputPerPageHour || 0), 0) / batches.length)
    : 0;
  const measuredPassRate = totalProcessed > 0 ? ((totalVerified / totalProcessed) * 100).toFixed(1) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-blue-700 font-mono font-medium">
            <span>{t.bulk.stepBadge}</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-1 flex items-center gap-2">
            <span>{t.bulk.title}</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t.bulk.subtitle}
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shadow-xs transition-all cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>{t.bulk.createBatch}</span>
          </button>
        </div>
      </div>

      {/* High-Level Throughput Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <span className="text-slate-500 text-xs block">{t.bulk.activeBatches}</span>
          <div className="text-2xl font-bold text-slate-900 font-mono mt-1">{batches.length} {isHindi ? 'बैच' : 'Batches'}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">{t.bulk.districtsCount}</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <span className="text-slate-500 text-xs block">{t.bulk.pipelineThroughput}</span>
          <div className="text-2xl font-bold text-emerald-700 font-mono mt-1">{plannedThroughputPerHour.toLocaleString()} {isHindi ? 'पृष्ठ/घंटे' : 'pages/hr'}</div>
          <div className="text-[11px] text-amber-600 mt-0.5">{isHindi ? 'नियोजन अनुमान — मापा नहीं गया' : 'Planning estimate — not measured'}</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <span className="text-slate-500 text-xs block">{t.bulk.totalBatchRecords}</span>
          <div className="text-2xl font-bold text-blue-700 font-mono mt-1">{totalSheets.toLocaleString()} {isHindi ? 'दस्तावेज़' : 'Docs'}</div>
          <div className="text-[11px] text-blue-600 mt-0.5">{isHindi ? `${totalProcessed} प्रसंस्कृत` : `${totalProcessed} processed`}</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <span className="text-slate-500 text-xs block">{t.bulk.autoPassRate}</span>
          <div className="text-2xl font-bold text-slate-800 font-mono mt-1">{measuredPassRate !== null ? `${measuredPassRate}%` : '—'}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">{measuredPassRate !== null ? (isHindi ? 'सील-प्राप्त / प्रसंस्कृत' : 'Sealed / processed') : (isHindi ? 'अभी मापा नहीं गया' : 'Not measured yet')}</div>
        </div>
      </div>

      {/* Main Grid: Batches List & Selected Batch Deep-Dive */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 5 cols: Batches List */}
        <div className="lg:col-span-5 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 font-mono">
            {t.bulk.activeTehsilBatches}
          </h3>

          <div className="space-y-2.5">
            {batches.map((batch) => {
              const isSelected = selectedBatch?.id === batch.id;
              const progressPct = Math.round((batch.processedCount / batch.totalDocuments) * 100);

              return (
                <div
                  key={batch.id}
                  onClick={() => setSelectedBatchId(batch.id)}
                  className={`p-4 rounded-xl border cursor-pointer transition-all shadow-xs ${
                    isSelected
                      ? 'border-blue-600 bg-blue-50/50 ring-1 ring-blue-600'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-mono font-bold text-slate-500">{batch.id}</span>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
                        batch.status === 'Completed'
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          : batch.status === 'OCR In Progress'
                          ? 'bg-amber-50 text-amber-800 border border-amber-200 animate-pulse'
                          : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {isHindi
                        ? batch.status === 'Completed'
                          ? 'पूर्ण'
                          : batch.status === 'OCR In Progress'
                          ? 'ओसीआर जारी'
                          : batch.status === 'Queued'
                          ? 'पंक्तिबद्ध'
                          : batch.status
                        : batch.status}
                    </span>
                  </div>

                  <div className="text-sm font-bold text-slate-900 leading-tight mt-1">
                    {batch.batchName}
                  </div>

                  <div className="text-xs text-slate-500 mt-1">
                    {batch.village} • {batch.tehsil}, {batch.district}
                  </div>

                  {/* Progress Bar */}
                  <div className="mt-3 space-y-1">
                    <div className="flex justify-between text-[11px] text-slate-500">
                      <span>{batch.processedCount} / {batch.totalDocuments} {t.bulk.sheets}</span>
                      <span className="font-mono font-bold text-slate-800">{progressPct}%</span>
                    </div>
                    <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden flex">
                      <div
                        style={{ width: `${progressPct}%` }}
                        className={`h-full ${
                          batch.status === 'Completed' ? 'bg-emerald-600' : 'bg-blue-600'
                        }`}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right 7 cols: Selected Batch Telemetry & Worker Status */}
        {selectedBatch && (
          <div className="lg:col-span-7 space-y-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <div className="text-xs text-slate-500 font-mono">{selectedBatch.id}</div>
                  <h3 className="text-base font-bold text-slate-900 mt-0.5">{selectedBatch.batchName}</h3>
                </div>

                {selectedBatch.status !== 'Completed' && (
                  <button
                    onClick={() => startBatchProcessing(selectedBatch.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shadow-xs transition-all cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>{t.bulk.resumeWorkers}</span>
                  </button>
                )}
              </div>

              {/* Worker Cluster Grid */}
              <div>
                <h4 className="text-xs font-bold text-slate-700 font-mono uppercase tracking-wider mb-2">
                  {t.bulk.clusterStatus}
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <div className="flex items-center justify-between text-slate-500 text-[11px]">
                      <span>{t.bulk.worker1}</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    </div>
                    <div className="font-bold text-slate-900 mt-1">{t.bulk.worker1Desc}</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">{t.bulk.worker1Count}</div>
                  </div>

                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <div className="flex items-center justify-between text-slate-500 text-[11px]">
                      <span>{t.bulk.worker2}</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    </div>
                    <div className="font-bold text-slate-900 mt-1">{t.bulk.worker2Desc}</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">{t.bulk.worker2Conf}</div>
                  </div>

                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <div className="flex items-center justify-between text-slate-500 text-[11px]">
                      <span>{t.bulk.worker3}</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    </div>
                    <div className="font-bold text-slate-900 mt-1">{t.bulk.worker3Desc}</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">{t.bulk.worker3Flags}</div>
                  </div>
                </div>
              </div>

              {/* Batch Processing Breakdown */}
              <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 text-xs space-y-2">
                <div className="flex justify-between text-slate-600">
                  <span>{t.bulk.recordType}</span>
                  <span className="font-semibold text-slate-900">{selectedBatch.recordType}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>{t.bulk.timeRemaining}</span>
                  <span className="font-mono text-amber-700 font-bold">{selectedBatch.estimatedCompletion}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>{t.bulk.throughputRate}</span>
                  <span className="font-mono text-emerald-700 font-bold">{selectedBatch.throughputPerPageHour} {isHindi ? 'दस्तावेज़/घंटे (अनुमान)' : 'documents/hour (estimate)'}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>{t.bulk.flaggedDiscrepancies}</span>
                  <span className="font-mono text-amber-700 font-bold">{selectedBatch.flaggedCount} {isHindi ? 'दस्तावेज़' : 'documents'}</span>
                </div>
              </div>

              {/* Batch Action Buttons */}
              <div className="flex items-center justify-end gap-2.5 pt-1">
                <button
                  onClick={() => setActiveView('verification_queue')}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold transition-colors cursor-pointer"
                >
                  <span>{t.bulk.reviewFlagged}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create Batch Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateBatch}
            className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-700">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">{t.bulk.modalTitle}</h3>
                <p className="text-xs text-slate-500">{t.bulk.modalSubtitle}</p>
              </div>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-700 font-medium mb-1">{t.bulk.batchNameLabel}</label>
                <input
                  type="text"
                  required
                  value={newBatchName}
                  onChange={(e) => setNewBatchName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-slate-900 focus:outline-none focus:border-slate-400"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-medium mb-1">{t.bulk.districtLabel}</label>
                  <input
                    type="text"
                    value={newDistrict}
                    onChange={(e) => setNewDistrict(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-900 focus:outline-none focus:border-slate-400"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-medium mb-1">{t.bulk.tehsilLabel}</label>
                  <input
                    type="text"
                    value={newTehsil}
                    onChange={(e) => setNewTehsil(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-900 focus:outline-none focus:border-slate-400"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-medium mb-1">{t.bulk.villageLabel}</label>
                  <input
                    type="text"
                    value={newVillage}
                    onChange={(e) => setNewVillage(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-900 focus:outline-none focus:border-slate-400"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-medium mb-1">{t.bulk.totalSheetsLabel}</label>
                  <input
                    type="number"
                    value={newTotalDocs}
                    onChange={(e) => setNewTotalDocs(Number(e.target.value))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-900 font-mono focus:outline-none focus:border-slate-400"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold cursor-pointer"
              >
                {t.common.cancel}
              </button>
              <button
                type="submit"
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-xs cursor-pointer"
              >
                <UploadCloud className="w-4 h-4" />
                <span>{t.bulk.initBatch}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
