import React from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from '../../i18n';

interface AppLayoutProps {
  children: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen flex flex-col bg-slate-100/70 text-slate-800 font-sans antialiased">
      <Header />
      <div className="bg-amber-50 border-b border-amber-200/90 px-4 py-1.5 text-xs text-amber-950 flex items-center justify-between shrink-0 shadow-2xs print:hidden">
        <div className="flex items-center gap-2">
          <span className="font-bold px-1.5 py-0.5 rounded bg-amber-200/90 text-amber-900 text-[10px] font-mono tracking-wider">
            {t.login.prototypeMode || 'PROTOTYPE MODE'}
          </span>
          <span className="text-[11px] font-medium text-amber-900">
            {t.app.prototypeNotice}
          </span>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-emerald-800 font-medium">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
          <span>{t.app.offlineBadge}</span>
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto bg-slate-100/70 p-4 sm:p-6 lg:p-7">
          <div className="max-w-7xl mx-auto">{children}</div>
        </main>
      </div>
      {/* NotificationToast moved to App.tsx so it also renders on the login screen. */}
    </div>
  );
};

