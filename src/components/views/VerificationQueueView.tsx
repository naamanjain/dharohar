import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import { ConfidenceBadge } from '../common/ConfidenceBadge';
import { StatusPill } from '../common/StatusPill';
import {
  Search,
  Filter,
  ArrowRight,
  Clock,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';

export const VerificationQueueView: React.FC = () => {
  const { documents, selectDocument, setActiveView } = useApp();
  const { t, isHindi } = useTranslation();

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [priorityFilter, setPriorityFilter] = useState<string>('All');
  const [districtFilter, setDistrictFilter] = useState<string>('All');

  const filteredDocs = documents.filter((doc) => {
    // Search matching — API rows may omit data fields, so the haystack is assembled defensively.
    const haystack = [
      doc.fileName,
      doc.documentCode,
      doc.village,
      doc.data?.khasraNo?.value,
      ...(doc.data?.owners ?? []).map((o) => o?.name),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const matchSearch = !searchQuery || haystack.includes(searchQuery.toLowerCase());

    // Status filter
    const matchStatus = statusFilter === 'All' || doc.status === statusFilter;

    // Priority filter
    const matchPriority = priorityFilter === 'All' || doc.priority === priorityFilter;

    // District filter
    const matchDistrict = districtFilter === 'All' || doc.district === districtFilter;

    return matchSearch && matchStatus && matchPriority && matchDistrict;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-blue-700 font-mono font-medium">
            <span>{t.nav.stepIndicator(7, 9)}</span>
            <span>•</span>
            <span>{t.queue.stepTag}</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-1">
            {t.queue.title}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t.queue.subtitle}
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono text-slate-700 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200 shadow-xs">
          <Clock className="w-3.5 h-3.5 text-slate-500" />
          <span>{t.queue.avgSla}</span>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          {/* Search */}
          <div className="sm:col-span-5 relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder={t.queue.searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-slate-400"
            />
          </div>

          {/* Status Filter */}
          <div className="sm:col-span-3">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-slate-400"
            >
              <option value="All">{t.queue.allStatuses}</option>
              <option value="Pending Verification">{t.status['Pending Verification']}</option>
              <option value="Under Review">{t.status['Under Review']}</option>
              <option value="Extraction Ready">{t.status['Extraction Ready']}</option>
              <option value="Verified">{t.status.Verified}</option>
              <option value="Flagged for Patwari">{t.status['Flagged for Patwari']}</option>
              <option value="Rejected">{t.status.Rejected}</option>
            </select>
          </div>

          {/* Priority Filter */}
          <div className="sm:col-span-2">
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-slate-400"
            >
              <option value="All">{t.queue.allPriorities}</option>
              <option value="High">{isHindi ? 'उच्च प्राथमिकता (High)' : 'High Priority'}</option>
              <option value="Medium">{isHindi ? 'मध्यम प्राथमिकता (Medium)' : 'Medium Priority'}</option>
              <option value="Low">{isHindi ? 'सामान्य प्राथमिकता (Low)' : 'Low Priority'}</option>
            </select>
          </div>

          {/* District Filter */}
          <div className="sm:col-span-2">
            <select
              value={districtFilter}
              onChange={(e) => setDistrictFilter(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-slate-400"
            >
              <option value="All">{t.queue.allDistricts}</option>
              <option value="Jaipur">{isHindi ? 'जयपुर (Jaipur)' : 'Jaipur'}</option>
              <option value="Jodhpur">{isHindi ? 'जोधपुर (Jodhpur)' : 'Jodhpur'}</option>
              <option value="Udaipur">{isHindi ? 'उदयपुर (Udaipur)' : 'Udaipur'}</option>
              <option value="Kota">{isHindi ? 'कोटा (Kota)' : 'Kota'}</option>
            </select>
          </div>
        </div>
      </div>

      {/* Queue Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 text-[11px] uppercase font-mono tracking-wider">
              <tr>
                <th className="p-3.5">{t.queue.colDocCode}</th>
                <th className="p-3.5">{t.queue.colJurisdiction}</th>
                <th className="p-3.5">{t.queue.colKhasra}</th>
                <th className="p-3.5">{t.queue.colOwner}</th>
                <th className="p-3.5">{t.queue.colQuality}</th>
                <th className="p-3.5">{t.queue.colStatus}</th>
                <th className="p-3.5">{t.queue.colDiscrepancy}</th>
                <th className="p-3.5 text-right">{t.queue.colAction}</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">
              {filteredDocs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-400 text-xs">
                    {t.queue.noRecordsFound}
                  </td>
                </tr>
              ) : (
                filteredDocs.map((doc) => {
                  const hasErrors = (doc.validationErrors ?? []).some((e) => !e.resolved);
                  return (
                    <tr
                      key={doc.id}
                      className="hover:bg-slate-50/80 transition-colors group cursor-pointer"
                      onClick={() => selectDocument(doc.id, 'human_verification')}
                    >
                      {/* Document Code */}
                      <td className="p-3.5">
                        <div className="font-mono font-bold text-slate-900 text-xs">
                          {doc.documentCode}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate max-w-[150px]">
                          {doc.fileName}
                        </div>
                      </td>

                      {/* Jurisdiction */}
                      <td className="p-3.5 text-slate-700">
                        <div className="font-semibold text-slate-900">{doc.village}</div>
                        <div className="text-[10px] text-slate-400">
                          {doc.tehsil}, {doc.district}
                        </div>
                      </td>

                      {/* Khasra / Khatauni */}
                      <td className="p-3.5 font-mono">
                        <div className="font-bold text-slate-900 text-xs">
                          {isHindi ? 'खसरा' : 'Khasra'} {doc.data?.khasraNo?.value || (isHindi ? 'अभिलेखित नहीं' : 'not recorded')}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {isHindi ? 'खाता सं.' : 'Khata #'} {doc.data?.khatauniNo?.value || (isHindi ? 'अभिलेखित नहीं' : 'not recorded')}
                        </div>
                      </td>

                      {/* Primary Owner */}
                      <td className="p-3.5 text-slate-700">
                        <div className="font-semibold text-slate-900">
                          {doc.data?.owners?.[0]?.name || (isHindi ? 'अनुपलब्ध' : 'N/A')}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          +{Math.max((doc.data?.owners?.length ?? 1) - 1, 0)} {isHindi ? 'सह-खातेदार' : 'Co-sharer(s)'}
                        </div>
                      </td>

                      {/* Confidence */}
                      <td className="p-3.5">
                        {doc.ocrEngines?.tesseractConfidence
                          ? <ConfidenceBadge score={doc.ocrEngines.tesseractConfidence} size="sm" />
                          : <span className="text-[10px] text-slate-400 font-mono">{isHindi ? 'मापा नहीं' : 'not measured'}</span>}
                      </td>

                      {/* Status */}
                      <td className="p-3.5">
                        <StatusPill status={doc.status} size="sm" />
                      </td>

                      {/* Discrepancy */}
                      <td className="p-3.5">
                        {hasErrors ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                            <AlertTriangle className="w-3 h-3 text-amber-600" />
                            {doc.validationErrors?.filter((e) => !e.resolved).length ?? 0} {isHindi ? 'आपत्तियां' : 'Flag(s)'}
                          </span>
                        ) : doc.status === 'Verified' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                            {isHindi ? 'मुद्रांकित जमाबंदी' : 'Sealed RoR'}
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-400 font-mono">{isHindi ? 'त्रुटिरहित' : 'Clean'}</span>
                        )}
                      </td>

                      {/* Action */}
                      <td className="p-3.5 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            selectDocument(doc.id, 'human_verification');
                          }}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 group-hover:text-blue-800 hover:underline cursor-pointer"
                        >
                          <span>{t.queue.reviewBtn}</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
