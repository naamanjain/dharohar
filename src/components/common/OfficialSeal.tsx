import React from 'react';
import { useTranslation } from '../../i18n';

interface OfficialSealProps {
  size?: 'sm' | 'md' | 'lg' | 'watermark';
  variant?: 'emblem' | 'seal' | 'signed_stamp';
  officerName?: string;
  badgeNumber?: string;
  certNumber?: string;
  /** A signed stamp may only render when the server actually issued a certificate for a Verified record. */
  sealed?: boolean;
}

export const OfficialSeal: React.FC<OfficialSealProps> = ({
  size = 'md',
  variant = 'seal',
  officerName,
  badgeNumber,
  certNumber,
  sealed = false,
}) => {
  const { isHindi } = useTranslation();

  if (variant === 'signed_stamp') {
    if (!sealed || !certNumber) {
      return (
        <div className="relative inline-flex flex-col items-center justify-center p-3.5 border-2 border-dashed border-slate-400/80 rounded-lg bg-slate-50/60 text-slate-600 font-serif rotate-[-1.5deg] shadow-sm select-none">
          <div className="flex items-center gap-1.5 text-[10px] font-sans font-bold uppercase tracking-wider text-slate-500">
            <span>{isHindi ? 'यह मुहर प्रमाणित नहीं है' : 'This stamp certifies nothing'}</span>
          </div>
          <div className="text-xs font-bold text-slate-700 mt-1 uppercase tracking-tight">
            {isHindi ? 'असीलबंद अभिलेख — सत्यापित नहीं' : 'NOT SEALED — NOT VERIFIED'}
          </div>
          <div className="text-[10px] font-sans font-semibold text-slate-500 mt-0.5 max-w-[220px] text-center">
            {isHindi
              ? 'जब तक तहसीलदार सील और प्रमाण-पत्र संख्या जारी नहीं करते, यह अभिलेख प्रमाणित नहीं है।'
              : 'No Tehsildar seal or certificate number has been issued for this record. It carries no certifying value.'}
          </div>
        </div>
      );
    }

    return (
      <div className="relative inline-flex flex-col items-center justify-center p-3.5 border-2 border-dashed border-emerald-700/80 rounded-lg bg-emerald-50/50 text-emerald-950 font-serif rotate-[-1.5deg] shadow-sm select-none">
        <div className="flex items-center gap-1.5 text-[10px] font-sans font-bold uppercase tracking-wider text-emerald-800">
          <span>★</span>
          <span>{isHindi ? 'धरोहर प्रोटोटाइप • राजस्व कार्यप्रणाली डेमो' : 'DHAROHAR PROTOTYPE • REVENUE WORKFLOW DEMO'}</span>
          <span>★</span>
        </div>
        <div className="text-xs font-bold text-emerald-900 mt-1 uppercase tracking-tight">
          {isHindi ? 'प्रोटोटाइप सत्यापित भू-अभिलेख' : 'PROTOTYPE VERIFIED RECORD'}
        </div>
        <div className="text-[11px] font-sans font-semibold text-emerald-950 mt-0.5">
          {officerName || (isHindi ? 'राजस्व अधिकारी / तहसीलदार' : 'Revenue Officer / Tehsildar')}
        </div>
        <div className="text-[9px] font-mono text-emerald-700 mt-0.5">
          ID: {badgeNumber || 'RJ-REV-8841'} • {new Date().toLocaleDateString(isHindi ? 'hi-IN' : 'en-IN')}
        </div>
        <div className="text-[9px] font-mono text-emerald-800 bg-emerald-100/70 px-1.5 py-0.5 rounded mt-1 border border-emerald-300">
          {certNumber}
        </div>
      </div>
    );
  }

  if (size === 'watermark') {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-[0.04] select-none">
        <div className="w-96 h-96 rounded-full border-8 border-slate-900 flex flex-col items-center justify-center text-center p-8">
          <div className="text-4xl font-bold uppercase tracking-widest">{isHindi ? 'धरोहर' : 'DHAROHAR'}</div>
          <div className="text-2xl font-serif mt-2">सत्यमेव जयते</div>
          <div className="text-lg uppercase mt-2 font-mono">{isHindi ? 'धरोहर प्रोटोटाइप' : 'DHAROHAR PROTOTYPE'}</div>
          <div className="text-sm font-serif">{isHindi ? 'भू-अभिलेख • प्रदर्शन प्रणाली' : 'LAND RECORDS • DEMONSTRATION'}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2">
      {/* Emblem SVG Symbol */}
      <div
        className={`relative flex items-center justify-center rounded-full bg-amber-500/10 text-amber-900 border border-amber-600/30 ${
          size === 'sm' ? 'w-7 h-7' : size === 'lg' ? 'w-12 h-12' : 'w-9 h-9'
        }`}
      >
        <svg
          viewBox="0 0 48 48"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={size === 'sm' ? 'w-4 h-4' : size === 'lg' ? 'w-7 h-7' : 'w-5 h-5'}
        >
          {/* Ashoka Pillar Lion Capital Stylized Geometry */}
          <path d="M24 6L28 12H20L24 6Z" fill="currentColor" stroke="none" />
          <path d="M18 12H30V22H18V12Z" strokeWidth="1.8" />
          <circle cx="24" cy="17" r="3" strokeWidth="1.5" />
          <path d="M14 22H34V28H14V22Z" />
          {/* Base and Ashoka Chakra Motif */}
          <circle cx="24" cy="33" r="5" strokeWidth="1.5" />
          <path d="M24 28V38" strokeWidth="1.2" />
          <path d="M19 33H29" strokeWidth="1.2" />
          <path d="M20.5 29.5L27.5 36.5" strokeWidth="1" />
          <path d="M27.5 29.5L20.5 36.5" strokeWidth="1" />
          <path d="M10 40H38V43H10V40Z" fill="currentColor" />
        </svg>
      </div>

      <div>
        <div className="text-xs font-bold leading-tight uppercase tracking-wider text-slate-800 font-sans">
          DHAROHAR <span className="text-amber-700 font-serif normal-case">(धरोहर)</span>
        </div>
        <div className="text-[10px] text-slate-500 font-medium leading-none mt-0.5">
          {isHindi ? 'भू-अभिलेख डिजिटलीकरण पोर्टल • प्रोटोटाइप' : 'Land Record Digitization Portal • Prototype'}
        </div>
      </div>
    </div>
  );
};
