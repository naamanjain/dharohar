import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import { USER_PROFILES } from '../../data/mockData';
import {
  Shield,
  Languages,
  ChevronDown,
  LogOut,
  Bell,
  Lock,
} from 'lucide-react';

export const Header: React.FC = () => {
  const { currentUser, isAuthenticated, logout, systemLanguage, toggleLanguage, activeView, setActiveView, documents, backendHealth, backendSession } = useApp();
  const { t } = useTranslation();
  const [showUserMenu, setShowUserMenu] = useState(false);

  const pendingVerificationCount = documents.filter((d) => d.status === 'Pending Verification' || d.status === 'Under Review').length;

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-slate-200 text-slate-800 select-none shadow-xs print:hidden">
      {/* Top micro-bar for prototype identity */}
      <div className="bg-slate-50 px-4 py-1 flex items-center justify-between text-[11px] border-b border-slate-200 text-slate-500">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 font-semibold text-slate-700">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse" />
            {t.app.title} • {t.app.prototypeBadge}
          </span>
          <span className="text-slate-300">|</span>
          <span>{t.app.subtitle}</span>
        </div>

        <div className="flex items-center gap-4">
          <span
            className={`flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 rounded border ${
              backendHealth.storageMode === 'postgres-postgis'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                : 'bg-slate-100 text-slate-700 border-slate-300'
            }`}
            title={
              backendHealth.storageMode === 'postgres-postgis'
                ? t.app.storageTooltipPostgres
                : t.app.storageTooltipFallback
            }
          >
            <Lock className="w-3 h-3 text-slate-600" />
            <span>
              {backendHealth.storageMode === 'postgres-postgis'
                ? t.app.storageModePostgres
                : t.app.storageModeFallback}
            </span>
          </span>
          {isAuthenticated && backendSession !== 'connected' && (
            <span
              className={`flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 rounded border font-bold ${
                backendSession === 'demo'
                  ? 'bg-amber-50 text-amber-900 border-amber-400'
                  : 'bg-rose-50 text-rose-900 border-rose-400'
              }`}
              title={
                backendSession === 'demo'
                  ? (systemLanguage === 'hi'
                      ? 'सर्वर तक नहीं पहुँचा: यह सत्र केवल ब्राउज़र में है, कुछ भी सहेजा नहीं जाएगा।'
                      : 'No API reachable: this session lives in the browser only. Nothing is saved.')
                  : (systemLanguage === 'hi'
                      ? 'सर्वर ने क्रेडेंशियल अस्वीकार किए।'
                      : 'The server rejected these credentials.')
              }
            >
              <span>
                {backendSession === 'demo'
                  ? (systemLanguage === 'hi' ? 'डेमो सत्र' : 'DEMO SESSION')
                  : (systemLanguage === 'hi' ? 'असफल साइन-इन' : 'SIGN-IN FAILED')}
              </span>
            </span>
          )}
          <span className="text-slate-300">|</span>
          <button
            onClick={toggleLanguage}
            className="flex items-center gap-1 hover:text-slate-900 text-slate-600 font-medium transition-colors cursor-pointer"
          >
            <Languages className="w-3.5 h-3.5 text-blue-600" />
            <span className="font-semibold">{systemLanguage === 'en' ? 'हिन्दी (Hindi)' : 'English'}</span>
          </button>
        </div>
      </div>

      {/* Main Header Bar */}
      <div className="px-4 py-2.5 flex items-center justify-between">
        {/* Left: System Branding */}
        <div
          onClick={() => setActiveView('dashboard')}
          className="flex items-center gap-3 cursor-pointer group"
        >
          <div className="w-9 h-9 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-700 group-hover:border-blue-300 transition-colors">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight text-slate-900 font-sans">
                {t.app.title} <span className="text-blue-700 font-serif font-normal">{t.app.hindiTitle}</span>
              </span>
              <span className="bg-slate-100 text-slate-700 text-[10px] font-mono px-2 py-0.5 rounded border border-slate-200">
                {t.app.prototypeBadge}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 leading-tight">
              {t.app.subtitle}
            </p>
          </div>
        </div>

        {/* Center: Live Pipeline Stats Strip */}
        <div className="hidden lg:flex items-center gap-6 bg-slate-50 px-4 py-1.5 rounded-lg border border-slate-200 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-500">{t.app.jurisdiction}:</span>
            <span className="font-semibold text-slate-800">{currentUser.district}</span>
          </div>
          <div className="h-3 w-px bg-slate-200" />
          <div className="flex items-center gap-2">
            <span className="text-slate-500">{t.app.tehsil}:</span>
            <span className="font-semibold text-slate-800">{currentUser.jurisdiction.split(',')[0]}</span>
          </div>
          <div className="h-3 w-px bg-slate-200" />
          <div className="flex items-center gap-2">
            <span className="text-slate-500">{t.app.queueAlert}:</span>
            <span className="font-mono font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
              {pendingVerificationCount} {t.app.recordsUnit}
            </span>
          </div>
        </div>

        {/* Right: User Profile & Role Switcher */}
        <div className="flex items-center gap-3">
          {/* Notification Button */}
          <button
            onClick={() => setActiveView('verification_queue')}
            className="relative p-2 rounded-lg bg-white hover:bg-slate-50 text-slate-600 hover:text-slate-900 transition-colors border border-slate-200 shadow-xs cursor-pointer"
            title={t.dashboard.verificationQueue}
          >
            <Bell className="w-4 h-4" />
            {pendingVerificationCount > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
                {pendingVerificationCount}
              </span>
            )}
          </button>

          {/* User Profile Badge with Preset Switcher */}
          <div className="relative">
            <button
              onClick={() => setShowUserMenu((v) => !v)}
              className="flex items-center gap-2.5 bg-white hover:bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200 text-left transition-colors shadow-xs cursor-pointer"
            >
              <div className="w-7 h-7 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-bold font-mono">
                {currentUser.name.charAt(0)}
              </div>
              <div className="hidden sm:block">
                <div className="text-xs font-semibold text-slate-800 leading-none">
                  {currentUser.name}
                </div>
                <div className="text-[10px] text-blue-700 font-medium leading-none mt-1">
                  {currentUser.designation}
                </div>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {/* Role Switcher Dropdown */}
            {showUserMenu && (
              <div className="absolute right-0 mt-2 w-72 bg-white border border-slate-200 rounded-xl shadow-xl py-2 z-50 animate-in fade-in slide-in-from-top-2">
                <div className="px-3 py-2 border-b border-slate-100 text-xs">
                  <div className="text-slate-500 text-[11px]">{t.app.loggedInAs}:</div>
                  <div className="font-bold text-slate-900 mt-0.5">{currentUser.name}</div>
                  <div className="text-[10px] font-mono text-slate-500 mt-0.5">{currentUser.badgeNumber}</div>
                </div>

                <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {t.app.switchRole}
                </div>
                <p className="px-3 pb-1.5 text-[10px] leading-snug text-slate-500">
                  {systemLanguage === 'hi'
                    ? 'नाम बदलने के लिए पहले साइन आउट करें — सील पर लगने वाला अधिकारी प्रमाणित होना चाहिए।'
                    : 'Sign out to change officer — the name stamped on a seal must be an authenticated one.'}
                </p>

                {USER_PROFILES.map((profile) => (
                  <button
                    key={profile.id}
                    onClick={() => {
                      logout();
                      setShowUserMenu(false);
                    }}
                    title={systemLanguage === 'hi' ? 'साइन आउट होकर यह अधिकारी चुनें' : 'Sign out, then sign in as this officer'}
                    className={`w-full text-left px-3 py-2 text-xs flex flex-col hover:bg-slate-50 transition-colors cursor-pointer ${
                      profile.id === currentUser.id ? 'bg-blue-50/70 text-blue-800 font-semibold' : 'text-slate-700'
                    }`}
                  >
                    <span className="font-semibold text-slate-900">{profile.name}</span>
                    <span className="text-[11px] text-blue-700 font-medium">{profile.designation}</span>
                    <span className="text-[10px] text-slate-500">{profile.jurisdiction}</span>
                  </button>
                ))}

                <div className="border-t border-slate-100 mt-2 pt-1">
                  <button
                    onClick={() => {
                      logout();
                      setShowUserMenu(false);
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-rose-600 hover:bg-rose-50 flex items-center gap-2 cursor-pointer font-medium"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    {t.app.signOut}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
