import React from 'react';
import { DocumentStatus } from '../../types';
import { useTranslation } from '../../i18n';
import { CheckCircle2, Clock, AlertTriangle, XCircle, FileSearch, ShieldCheck, UserCheck } from 'lucide-react';

interface StatusPillProps {
  status: DocumentStatus;
  size?: 'sm' | 'md';
}

export const StatusPill: React.FC<StatusPillProps> = ({ status, size = 'md' }) => {
  const { t } = useTranslation();
  const sizeClasses = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs font-medium';
  const label = t.status[status] || status;

  switch (status) {
    case 'Verified':
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 text-emerald-800 ${sizeClasses}`}
        >
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
          {label}
        </span>
      );

    case 'Pending Verification':
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 text-amber-900 ${sizeClasses}`}
        >
          <Clock className="w-3.5 h-3.5 text-amber-600" />
          {label}
        </span>
      );

    case 'Under Review':
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-blue-300 bg-blue-50 text-blue-900 ${sizeClasses}`}
        >
          <UserCheck className="w-3.5 h-3.5 text-blue-600" />
          {label}
        </span>
      );

    case 'Processing':
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-indigo-300 bg-indigo-50 text-indigo-900 ${sizeClasses}`}
        >
          <span className="w-2 h-2 rounded-full bg-indigo-600 animate-ping" />
          {label}
        </span>
      );

    case 'Extraction Ready':
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-cyan-300 bg-cyan-50 text-cyan-900 ${sizeClasses}`}
        >
          <FileSearch className="w-3.5 h-3.5 text-cyan-600" />
          {label}
        </span>
      );

    case 'Validation Review':
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-purple-300 bg-purple-50 text-purple-900 ${sizeClasses}`}
        >
          <AlertTriangle className="w-3.5 h-3.5 text-purple-600" />
          {label}
        </span>
      );

    case 'Quality Checked':
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 text-slate-800 ${sizeClasses}`}
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-slate-600" />
          {label}
        </span>
      );

    case 'Flagged for Patwari':
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-orange-300 bg-orange-50 text-orange-900 ${sizeClasses}`}
        >
          <AlertTriangle className="w-3.5 h-3.5 text-orange-600" />
          {label}
        </span>
      );

    case 'Rejected':
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-rose-50 text-rose-800 ${sizeClasses}`}
        >
          <XCircle className="w-3.5 h-3.5 text-rose-600" />
          {label}
        </span>
      );

    case 'Uploaded':
    default:
      return (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 text-slate-700 ${sizeClasses}`}
        >
          <Clock className="w-3.5 h-3.5 text-slate-500" />
          {label}
        </span>
      );
  }
};
