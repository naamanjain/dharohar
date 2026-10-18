import React from 'react';
import { useTranslation } from '../../i18n';

interface ConfidenceBadgeProps {
  score: number; // 0 - 100
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const ConfidenceBadge: React.FC<ConfidenceBadgeProps> = ({
  score,
  showLabel = true,
  size = 'md',
  className = '',
}) => {
  const { t } = useTranslation();

  if (score === undefined || score === null || isNaN(score) || score <= 0) {
    return (
      <span
        className={`inline-flex items-center rounded-md border font-mono bg-slate-100 text-slate-600 border-slate-300 text-xs px-2 py-0.5 gap-1 ${className}`}
        title={t.viewer.confidenceUnavailable}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        <span className="font-sans text-[11px]">{t.viewer.confidenceUnavailable}</span>
      </span>
    );
  }

  let colorClass = 'bg-emerald-50 text-emerald-800 border-emerald-300';
  let dotClass = 'bg-emerald-600';
  let rating = t.confidence.high;

  if (score < 70) {
    colorClass = 'bg-rose-50 text-rose-800 border-rose-300';
    dotClass = 'bg-rose-600';
    rating = t.confidence.review;
  } else if (score < 90) {
    colorClass = 'bg-amber-50 text-amber-900 border-amber-300';
    dotClass = 'bg-amber-600';
    rating = t.confidence.recommended;
  }

  const sizeClasses = {
    sm: 'text-xs px-1.5 py-0.5 gap-1',
    md: 'text-xs px-2.5 py-1 gap-1.5 font-medium',
    lg: 'text-sm px-3 py-1.5 gap-2 font-semibold',
  };

  return (
    <span
      className={`inline-flex items-center rounded-md border font-mono ${sizeClasses[size]} ${colorClass} ${className}`}
      title={`${score.toFixed(1)}% (${rating})`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      <span>{score.toFixed(1)}%</span>
      {showLabel && size !== 'sm' && (
        <span className="text-[10px] uppercase font-sans tracking-wide text-slate-600 font-medium">
          {rating}
        </span>
      )}
    </span>
  );
};
