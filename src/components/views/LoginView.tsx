import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { USER_PROFILES } from '../../data/mockData';
import { UserProfile } from '../../types';
import { useTranslation } from '../../i18n';
import { Shield, User, KeyRound, CheckCircle, ArrowRight, AlertTriangle, ShieldCheck } from 'lucide-react';

export const LoginView: React.FC = () => {
  const { login, systemLanguage, toggleLanguage } = useApp();
  const { t, isHindi } = useTranslation();
  const [selectedProfile, setSelectedProfile] = useState<UserProfile>(USER_PROFILES[0]);
  const [password, setPassword] = useState<string>('');
  const [captchaInput, setCaptchaInput] = useState<string>('');
  const [captchaCode, setCaptchaCode] = useState<string>('RJ89K');

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (captchaInput.trim().toUpperCase() !== captchaCode.toUpperCase()) {
      setCaptchaCode(Math.random().toString(36).slice(2, 7).toUpperCase());
      return;
    }
    login(selectedProfile, password);
  };

  return (
    <div className="min-h-screen bg-slate-100/70 flex flex-col justify-between text-slate-800 p-4 sm:p-6 select-none font-sans">
      {/* Top Banner */}
      <div className="flex items-center justify-between border-b border-slate-200/90 pb-3.5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center text-white shadow-xs">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-slate-900 flex items-center gap-2">
              DHAROHAR <span className="text-blue-700 font-serif font-normal">{t.app.hindiTitle}</span>
            </h1>
            <p className="text-xs text-slate-500">
              {t.login.portalSubtitle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={toggleLanguage}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:text-slate-900 hover:bg-slate-50 text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
          >
            <span className="text-blue-600 font-bold">अ/A</span>
            <span>{systemLanguage === 'en' ? 'हिन्दी (Hindi)' : 'English'}</span>
          </button>
          <div className="hidden sm:flex items-center gap-2 text-xs text-emerald-800 bg-emerald-50 px-3 py-1.5 rounded-full border border-emerald-200/80 font-mono shadow-2xs">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>{t.login.prototypeMode}</span>
          </div>
        </div>
      </div>

      {/* Main Login Center Card */}
      <div className="max-w-4xl mx-auto w-full my-8 grid grid-cols-1 md:grid-cols-12 bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden">
        {/* Left Side: System Information */}
        <div className="md:col-span-5 bg-slate-900 p-6 sm:p-8 flex flex-col justify-between border-b md:border-b-0 md:border-r border-slate-800 text-white">
          <div>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold bg-blue-500/20 text-blue-300 border border-blue-400/30">
              {t.login.prototypeBadge}
            </span>

            <h2 className="text-xl font-bold text-white mt-4 leading-snug">
              {t.login.mainTitle}
            </h2>

            <p className="text-xs text-slate-300 mt-2 leading-relaxed">
              {t.login.mainDesc}
            </p>

            <div className="mt-6 space-y-3">
              <div className="flex items-start gap-2.5 text-xs text-slate-300">
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{t.login.feature1}</span>
              </div>
              <div className="flex items-start gap-2.5 text-xs text-slate-300">
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{t.login.feature2}</span>
              </div>
              <div className="flex items-start gap-2.5 text-xs text-slate-300">
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{t.login.feature3}</span>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-slate-800 text-[11px] text-slate-400">
            <span className="font-semibold text-amber-400 block mb-1">{t.login.disclaimerTitle}</span>
            {t.login.disclaimerText}
          </div>
        </div>

        {/* Right Side: Login Form with Quick Presets */}
        <div className="md:col-span-7 p-6 sm:p-8 bg-white flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">{t.login.officerLoginTitle}</h3>
              <span className="text-xs font-mono text-slate-500">Demo Login #01</span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {t.login.officerLoginSubtitle}
            </p>

            {/* Quick Demo Presets */}
            <div className="mt-4">
              <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase font-mono tracking-wider">
                {t.login.selectRoleLabel}
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {USER_PROFILES.map((p) => {
                  const isSelected = selectedProfile.id === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedProfile(p)}
                      className={`p-2.5 rounded-lg border text-left text-xs transition-all cursor-pointer ${
                        isSelected
                          ? 'border-blue-600 bg-blue-50/70 text-slate-900 ring-1 ring-blue-600'
                          : 'border-slate-200 bg-slate-50/70 text-slate-700 hover:border-slate-300'
                      }`}
                    >
                      <div className="font-bold text-slate-900">{p.name}</div>
                      <div className="text-[10px] text-blue-700 font-medium truncate">{p.designation}</div>
                      <div className="text-[10px] text-slate-500 font-mono mt-0.5">{p.district}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Login Form */}
            <form onSubmit={handleLoginSubmit} className="mt-5 space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t.login.officerIdLabel}
                </label>
                <div className="relative">
                  <User className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="text"
                    readOnly
                    value={`${selectedProfile.name.toLowerCase().replace(/[^a-z]/g, '')}@dharohar.local`}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-slate-400 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t.login.passcodeLabel}
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={isHindi ? 'अधिकारी पासवर्ड' : 'Officer password'}
                    autoComplete="current-password"
                    required
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-slate-400 font-mono"
                  />
                </div>
                <p className="mt-1 text-[10px] leading-snug text-slate-500">
                  {isHindi
                    ? 'डेमो खातों का पासवर्ड README में है। सर्वर बंद हो तो यह केवल डेमो सत्र रहेगा।'
                    : 'Demo account passwords are listed in the README. If the API server is down this stays a demo session only.'}
                </p>
              </div>

              {/* Captcha Verification */}
              <div className="grid grid-cols-2 gap-3 items-center">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t.login.securityCodeLabel}
                  </label>
                  <input
                    type="text"
                    value={captchaInput}
                    onChange={(e) => setCaptchaInput(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-slate-400 font-mono uppercase"
                  />
                </div>

                <div className="mt-5 flex items-center justify-center bg-slate-100 border border-slate-200 rounded-lg py-2 px-3">
                  <span className="font-mono text-sm tracking-widest font-extrabold text-slate-700 select-none line-through">
                    {captchaCode}
                  </span>
                </div>
              </div>

              <button
                type="submit"
                className="w-full mt-4 bg-slate-900 hover:bg-slate-800 text-white font-semibold py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 text-xs shadow-xs transition-all cursor-pointer"
              >
                <span>{t.login.accessBtn}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 text-[10px] text-slate-500 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
            <span>{t.login.accessNotice}</span>
          </div>
        </div>
      </div>

      {/* Footer Disclaimer */}
      <div className="text-center text-[11px] text-slate-500 border-t border-slate-200 pt-3">
        {t.login.footerText}
      </div>
    </div>
  );
};
