import React from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import { ActiveView } from '../../types';
import {
  LayoutDashboard,
  Map,
  UploadCloud,
  FileCheck2,
  Cpu,
  FileText,
  ShieldAlert,
  ListTodo,
  UserCheck,
  Award,
  Layers,
  BarChart3,
  ChevronRight,
  Info,
} from 'lucide-react';

interface NavItem {
  id: ActiveView;
  label: string;
  hindiLabel: string;
  icon: React.ReactNode;
  badge?: string | number;
  badgeColor?: string;
  category: 'core_flow' | 'modules';
  stepNumber?: number;
}

export const Sidebar: React.FC = () => {
  const { activeView, setActiveView, documents, systemLanguage } = useApp();
  const { t } = useTranslation();

  const pendingCount = documents.filter((d) => d.status === 'Pending Verification' || d.status === 'Under Review').length;
  const verifiedCount = documents.filter((d) => d.status === 'Verified').length;

  const navItems: NavItem[] = [
    {
      id: 'dashboard',
      label: 'Dashboard Overview',
      hindiLabel: 'डैशबोर्ड अवलोकन',
      icon: <LayoutDashboard className="w-4 h-4" />,
      category: 'core_flow',
      stepNumber: 1,
    },
    {
      id: 'spatial_registry',
      label: 'Land Parcel Map',
      hindiLabel: 'भूमि पार्सल मानचित्र',
      icon: <Map className="w-4 h-4" />,
      category: 'core_flow',
      stepNumber: 2,
    },
    {
      id: 'upload',
      label: 'Document Upload',
      hindiLabel: 'दस्तावेज़ अपलोड',
      icon: <UploadCloud className="w-4 h-4" />,
      category: 'core_flow',
      stepNumber: 3,
    },
    {
      id: 'quality_check',
      label: 'Quality Check',
      hindiLabel: 'गुणवत्ता परीक्षण (DPI/झुकाव)',
      icon: <FileCheck2 className="w-4 h-4" />,
      category: 'core_flow',
      stepNumber: 4,
    },
    {
      id: 'processing',
      label: 'Processing Pipeline',
      hindiLabel: 'प्रसंस्करण (OCR/NER)',
      icon: <Cpu className="w-4 h-4" />,
      category: 'core_flow',
      stepNumber: 5,
    },
    {
      id: 'extraction_results',
      label: 'Extraction Results',
      hindiLabel: 'निष्कर्षण परिणाम',
      icon: <FileText className="w-4 h-4" />,
      category: 'core_flow',
      stepNumber: 6,
    },
    {
      id: 'record_validation',
      label: 'Record Validation',
      hindiLabel: 'अभिलेख नियम सत्यापन',
      icon: <ShieldAlert className="w-4 h-4" />,
      category: 'core_flow',
      stepNumber: 7,
    },
    {
      id: 'verification_queue',
      label: 'Verification Queue',
      hindiLabel: 'सत्यापन कतार',
      icon: <ListTodo className="w-4 h-4" />,
      badge: pendingCount > 0 ? pendingCount : undefined,
      badgeColor: 'bg-amber-500 text-slate-950',
      category: 'core_flow',
      stepNumber: 8,
    },
    {
      id: 'human_verification',
      label: 'Human Verification',
      hindiLabel: 'अधिकारी सत्यापन कार्यक्षेत्र',
      icon: <UserCheck className="w-4 h-4" />,
      category: 'core_flow',
      stepNumber: 9,
    },
    {
      id: 'verified_record',
      label: 'Verified Land Record',
      hindiLabel: 'सत्यापित भू-अभिलेख (RoR)',
      icon: <Award className="w-4 h-4" />,
      badge: verifiedCount > 0 ? (systemLanguage === 'hi' ? `${verifiedCount} जमाबंदी` : `${verifiedCount} RoR`) : undefined,
      badgeColor: 'bg-emerald-600 text-white',
      category: 'core_flow',
      stepNumber: 10,
    },
    {
      id: 'bulk_processing',
      label: 'Bulk Document Ingestion',
      hindiLabel: 'थोक दस्तावेज़ प्रसंस्करण',
      icon: <Layers className="w-4 h-4" />,
      category: 'modules',
    },
    {
      id: 'digitization_reports',
      label: 'Digitization Reports',
      hindiLabel: 'प्रगति एवं विश्लेषणात्मक रिपोर्ट',
      icon: <BarChart3 className="w-4 h-4" />,
      category: 'modules',
    },
  ];

  return (
    <aside className="w-64 bg-white border-r border-slate-200 flex flex-col justify-between shrink-0 select-none text-slate-600 shadow-xs print:hidden">
      {/* Scrollable Navigation List */}
      <div className="flex-1 overflow-y-auto py-4 px-3 space-y-5">
        {/* Section 1: Digitization Pipeline Flow */}
        <div>
          <div className="px-2 mb-2 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono">
              {t.nav.coreFlowHeader}
            </span>
            <span className="text-[10px] text-slate-400 font-mono">{t.nav.stepCount}</span>
          </div>

          <div className="space-y-1">
            {navItems
              .filter((item) => item.category === 'core_flow')
              .map((item) => {
                const isActive = activeView === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveView(item.id)}
                    className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                      isActive
                        ? 'bg-slate-900 text-white shadow-sm'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-mono font-bold shrink-0 ${
                          isActive ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {item.stepNumber}
                      </span>
                      <span className="shrink-0">{item.icon}</span>
                      <span className="truncate">
                        {systemLanguage === 'hi' ? item.hindiLabel : item.label}
                      </span>
                    </div>

                    {item.badge ? (
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded font-mono ${
                          item.badgeColor || 'bg-slate-200 text-slate-700'
                        }`}
                      >
                        {item.badge}
                      </span>
                    ) : isActive ? (
                      <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                    ) : null}
                  </button>
                );
              })}
          </div>
        </div>

        {/* Section 2: Management & Reporting Modules */}
        <div>
          <div className="px-2 mb-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono">
              {t.nav.modulesHeader}
            </span>
          </div>

          <div className="space-y-1">
            {navItems
              .filter((item) => item.category === 'modules')
              .map((item) => {
                const isActive = activeView === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveView(item.id)}
                    className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                      isActive
                        ? 'bg-slate-900 text-white shadow-sm'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="shrink-0">{item.icon}</span>
                      <span className="truncate">
                        {systemLanguage === 'hi' ? item.hindiLabel : item.label}
                      </span>
                    </div>

                    {isActive && <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                  </button>
                );
              })}
          </div>
        </div>
      </div>

      {/* Sidebar Footer Compliance Note */}
      <div className="p-3 border-t border-slate-200 bg-slate-50 text-[11px] text-slate-500">
        <div className="flex items-center gap-1.5 text-slate-700 font-semibold mb-1">
          <Info className="w-3.5 h-3.5 text-blue-600" />
          <span>{t.nav.prototypeNoteTitle}</span>
        </div>
        <p className="leading-tight text-slate-500 text-[10px]">
          {t.nav.prototypeNoteBody}
        </p>
      </div>
    </aside>
  );
};
