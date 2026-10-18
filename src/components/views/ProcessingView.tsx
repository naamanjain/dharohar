import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import {
  Cpu,
  CheckCircle2,
  Clock,
  Layers,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  Terminal,
  Activity,
  Sparkles,
  Zap,
  XCircle,
} from 'lucide-react';

export const ProcessingView: React.FC = () => {
  const { activeDocument, runProcessingSimulation, setActiveView } = useApp();
  const { t, isHindi } = useTranslation();

  const [progress, setProgress] = useState<number>(0);
  const [currentStageText, setCurrentStageText] = useState<string>(t.processing.initialStage);
  const [isDone, setIsDone] = useState<boolean>(false);
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const [logs, setLogs] = useState<Array<{ time: string; text: string; type: 'info' | 'success' | 'warn' | 'error' }>>([]);

  // Latest language/dictionary without letting a toggle re-trigger the pipeline run.
  const langRef = useRef(isHindi);
  langRef.current = isHindi;
  const dictRef = useRef(t);
  dictRef.current = t;
  const runGuard = useRef<string>('');

  useEffect(() => {
    let mounted = true;
    const docId = activeDocument?.id;
    if (!docId || runGuard.current === docId) return;
    runGuard.current = docId;

    const executePipeline = async () => {
      if (!activeDocument) return;

      const addLog = (text: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
        if (!mounted) return;
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setLogs((prev) => [...prev, { time, text, type }]);
      };

      addLog(
        langRef.current
          ? `${activeDocument.fileName} (${activeDocument.documentCode}) के लिए स्थानीय ओसीआर निष्कर्षण प्रारंभ किया जा रहा है`
          : `Initiating local OCR extraction for ${activeDocument.fileName} (${activeDocument.documentCode})`,
        'info'
      );
      setProgress(10);
      setCurrentStageText(dictRef.current.processing.stage1);

      try {
        await runProcessingSimulation(
          activeDocument.id,
          (stageName, progVal, logMessage, logCategory) => {
            if (!mounted) return;
            setCurrentStageText(stageName);
            setProgress(progVal);
            if (logMessage) {
              addLog(logMessage, logCategory || 'info');
            }
          }
        );

        if (mounted) {
          setProgress(100);
          setCurrentStageText(dictRef.current.processing.completedMsg);
          setIsDone(true);
        }
      } catch (err: any) {
        if (mounted) {
          const reason = err?.message ? String(err.message) : String(err);
          setFailureReason(reason);
          addLog(
            langRef.current
              ? `पाइपलाइन विफल: ${reason} — कोई परिणाम सत्यापित नहीं माना जाए।`
              : `Pipeline failed: ${reason} — no output should be treated as verified.`,
            'error'
          );
          setProgress((p) => Math.min(p, 97));
          setCurrentStageText(langRef.current ? 'पाइपलाइन विफल' : 'Pipeline Failed');
        }
      }
    };

    executePipeline();

    return () => {
      mounted = false;
    };
  }, [activeDocument?.id]);

  if (!activeDocument) {
    return (
      <div className="text-center py-12 text-slate-400">
        {t.processing.noDocSelected}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-blue-700 font-mono font-medium">
            <span>{t.nav.stepIndicator(4, 9)}</span>
            <span>•</span>
            <span>{t.processing.stepTag}</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-1">
            {t.processing.title}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t.common.documentLabel} <span className="font-mono text-slate-800 font-semibold">{activeDocument.fileName}</span> ({activeDocument.documentCode})
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setActiveView('quality_check')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold border border-slate-200 shadow-xs transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 text-slate-500" />
            <span>{t.common.back}</span>
          </button>

          {isDone && (
            <button
              onClick={() => setActiveView('extraction_results')}
              className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-xs transition-all cursor-pointer animate-in fade-in"
            >
              <span>{t.processing.viewResults}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Progress Bar Container */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-bold text-slate-900 flex items-center gap-2">
            {failureReason ? (
              <XCircle className="w-4 h-4 text-rose-600" />
            ) : isDone ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            ) : (
              <Activity className="w-4 h-4 text-blue-600 animate-spin" />
            )}
            <span className={failureReason ? 'text-rose-700' : undefined}>{currentStageText}</span>
          </span>
          <span className="font-mono font-bold text-slate-900 text-sm">{progress}%</span>
        </div>

        {failureReason && (
          <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-300 text-[11px] text-rose-900 font-medium">
            {isHindi ? 'पाइपलाइन विफल — निकाला गया कोई भी फ़ील्ड सत्यापित नहीं है। कारण: ' : 'Pipeline failed — no extracted field is verified. Reason: '}
            <span className="font-mono">{failureReason}</span>
          </div>
        )}

        {/* Bar */}
        <div className="w-full bg-slate-100 h-3 rounded-full overflow-hidden border border-slate-200 p-0.5">
          <div
            style={{ width: `${progress}%` }}
            className={`h-full rounded-full transition-all duration-300 shadow-xs ${
              failureReason ? 'bg-rose-600' : isDone ? 'bg-emerald-600' : 'bg-slate-900'
            }`}
          />
        </div>

        {/* 4 Stage Pills */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 text-xs">
          <div
            className={`p-2.5 rounded-lg border text-center transition-all ${
              progress >= 25
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-slate-50 border-slate-200 text-slate-400'
            }`}
          >
            <div className="font-mono text-[10px] font-bold">{isHindi ? 'चरण १' : 'STAGE 1'}</div>
            <div className="text-[11px] font-semibold mt-0.5">{isHindi ? 'पूर्व-प्रसंस्करण व संरेखन' : 'Preprocessing & Deskew'}</div>
          </div>

          <div
            className={`p-2.5 rounded-lg border text-center transition-all ${
              progress >= 65
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-slate-50 border-slate-200 text-slate-400'
            }`}
          >
            <div className="font-mono text-[10px] font-bold">{isHindi ? 'चरण २' : 'STAGE 2'}</div>
            <div className="text-[11px] font-semibold mt-0.5">{isHindi ? 'स्थानीय टेसरैक्ट ओसीआर' : 'Local Tesseract OCR'}</div>
          </div>

          <div
            className={`p-2.5 rounded-lg border text-center transition-all ${
              progress >= 85
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-slate-50 border-slate-200 text-slate-400'
            }`}
          >
            <div className="font-mono text-[10px] font-bold">{isHindi ? 'चरण ३' : 'STAGE 3'}</div>
            <div className="text-[11px] font-semibold mt-0.5">{isHindi ? 'राजस्व डोमेन एनईआर' : 'Revenue Domain NER'}</div>
          </div>

          <div
            className={`p-2.5 rounded-lg border text-center transition-all ${
              progress >= 100
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-slate-50 border-slate-200 text-slate-400'
            }`}
          >
            <div className="font-mono text-[10px] font-bold">{isHindi ? 'चरण ४' : 'STAGE 4'}</div>
            <div className="text-[11px] font-semibold mt-0.5">{isHindi ? 'भू-अभिलेख सत्यापन' : 'Cadastral Cross-Check'}</div>
          </div>
        </div>
      </div>

      {/* Real-time Telemetry & Terminal Logs */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
        {/* Terminal Output */}
        <div className="md:col-span-8 bg-slate-900 border border-slate-800 rounded-xl p-4 font-mono text-xs shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3 text-slate-400">
            <span className="flex items-center gap-1.5 text-[11px] text-slate-300">
              <Terminal className="w-3.5 h-3.5 text-blue-400" />
              <span>{t.processing.terminalTitle}</span>
            </span>
            <span className={`text-[10px] font-semibold ${failureReason ? 'text-rose-400' : isDone ? 'text-emerald-400' : 'text-blue-400'}`}>
              {failureReason ? (isHindi ? 'पाइपलाइन विफल' : 'PIPELINE FAILED') : isDone ? t.processing.pipelineComplete : t.processing.workerActive}
            </span>
          </div>

          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {logs.map((log, idx) => (
              <div key={idx} className="flex items-start gap-2 leading-relaxed">
                <span className="text-slate-500 text-[10px] shrink-0">[{log.time}]</span>
                <span
                  className={
                    log.type === 'success'
                      ? 'text-emerald-400'
                      : log.type === 'warn'
                      ? 'text-amber-400'
                      : log.type === 'error'
                      ? 'text-rose-400'
                      : 'text-slate-300'
                  }
                >
                  {log.text}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Engine Performance Telemetry */}
        <div className="md:col-span-4 bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-xs">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-800 font-mono">
            {t.processing.telemetryTitle}
          </h4>

          <div className="space-y-2 text-xs">
            <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80">
              <div className="flex justify-between text-slate-600 text-[11px]">
                <span>{t.processing.tesseractScore}</span>
                <span className="font-mono text-emerald-700 font-bold">
                  {activeDocument.ocrEngines.tesseractConfidence}%
                </span>
              </div>
            </div>

            <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80">
              <div className="flex justify-between text-slate-600 text-[11px]">
                <span>{t.processing.indicScore}</span>
                <span className="font-mono text-slate-400 font-bold">
                  {isHindi ? 'इस बिल्ड में उपलब्ध नहीं' : 'Not available in this build'}
                </span>
              </div>
            </div>

            <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80">
              <div className="flex justify-between text-slate-600 text-[11px]">
                <span>{t.processing.ensembleScore}</span>
                <span className="font-mono text-slate-400 font-bold">
                  {isHindi ? 'इस बिल्ड में उपलब्ध नहीं' : 'Not available in this build'}
                </span>
              </div>
            </div>

            <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80">
              <div className="flex justify-between text-slate-600 text-[11px]">
                <span>{t.processing.cerScore}</span>
                <span className="font-mono text-emerald-700 font-bold">
                  {activeDocument.ocrEngines.characterErrorRate}%
                </span>
              </div>
            </div>

            <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200/80">
              <div className="flex justify-between text-slate-600 text-[11px]">
                <span>{t.processing.latency}</span>
                <span className="font-mono text-slate-700 font-bold">
                  {activeDocument.ocrEngines.processingTimeMs} ms
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
