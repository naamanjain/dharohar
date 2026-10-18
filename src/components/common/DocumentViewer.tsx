import React, { useState } from 'react';
import { DocumentRecord, BoundingBox } from '../../types';
import { useTranslation } from '../../i18n';
import {
  ZoomIn,
  ZoomOut,
  RotateCw,
  Sun,
  Layers,
  Sparkles,
  RefreshCw,
  Maximize2,
} from 'lucide-react';

interface DocumentViewerProps {
  document: DocumentRecord;
  selectedBoxId?: string;
  onSelectBox?: (boxId: string, fieldName: string) => void;
  showBoundingBoxes?: boolean;
  allowEnhancementControls?: boolean;
  heightClass?: string;
}

export const DocumentViewer: React.FC<DocumentViewerProps> = ({
  document,
  selectedBoxId,
  onSelectBox,
  showBoundingBoxes = true,
  allowEnhancementControls = true,
  heightClass = 'h-[580px]',
}) => {
  const { t, isHindi } = useTranslation();
  const [zoom, setZoom] = useState<number>(100);
  const [rotation, setRotation] = useState<number>(0);
  const [contrast, setContrast] = useState<number>(document.qualityEnhancements.contrast || 100);
  const [brightness, setBrightness] = useState<number>(document.qualityEnhancements.brightness || 0);
  const [invert, setInvert] = useState<boolean>(document.qualityEnhancements.invertColors || false);
  const [showBoxes, setShowBoxes] = useState<boolean>(showBoundingBoxes);
  const [isDeskewActive, setIsDeskewActive] = useState<boolean>(document.qualityEnhancements.deskew);
  const [isBinarized, setIsBinarized] = useState<boolean>(document.qualityEnhancements.binarize);

  // A reused mount must not keep the previous document's viewer state.
  const [stateDocId, setStateDocId] = useState<string>(document.id);
  if (stateDocId !== document.id) {
    setStateDocId(document.id);
    setZoom(100);
    setRotation(0);
    setContrast(document.qualityEnhancements?.contrast || 100);
    setBrightness(document.qualityEnhancements?.brightness || 0);
    setInvert(document.qualityEnhancements?.invertColors || false);
    setShowBoxes(showBoundingBoxes);
    setIsDeskewActive(document.qualityEnhancements?.deskew ?? false);
    setIsBinarized(document.qualityEnhancements?.binarize ?? false);
  }

  const lagaanValue =
    typeof document.data?.annualLagaanRevenue?.value === 'number' ? document.data.annualLagaanRevenue.value : null;

  // Extract all available bounding boxes from document
  const boundingBoxes: BoundingBox[] = [];
  if (document.data.khasraNo?.bbox) boundingBoxes.push(document.data.khasraNo.bbox);
  if (document.data.khatauniNo?.bbox) boundingBoxes.push(document.data.khatauniNo.bbox);
  if (document.data.khewatNo?.bbox) boundingBoxes.push(document.data.khewatNo.bbox);
  if (document.data.villageMauza?.bbox) boundingBoxes.push(document.data.villageMauza.bbox);
  if (document.data.patwarCircle?.bbox) boundingBoxes.push(document.data.patwarCircle.bbox);
  if (document.data.tehsil?.bbox) boundingBoxes.push(document.data.tehsil.bbox);
  if (Array.isArray(document.ocrWords)) {
    document.ocrWords.forEach((w) => {
      if (w.bbox && !boundingBoxes.some((b) => b.id === w.bbox?.id)) {
        boundingBoxes.push(w.bbox);
      }
    });
  }

  const isRealImage = Boolean(
    document.imageUri &&
      (document.imageUri.startsWith('data:image/') ||
        document.imageUri.startsWith('blob:') ||
        document.imageUri.startsWith('http'))
  );

  const resetView = () => {
    setZoom(100);
    setRotation(0);
    setContrast(100);
    setBrightness(0);
    setInvert(false);
    setIsDeskewActive(true);
    setIsBinarized(false);
  };

  const handleFitToWidth = () => {
    setZoom(100);
    setRotation(0);
  };

  const effectiveRotation = rotation + (isDeskewActive ? 0 : document.qualityMetrics?.skewAngle || 0);

  return (
    <div className="flex flex-col bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xs">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between px-3.5 py-2 bg-slate-50 border-b border-slate-200 text-slate-700 text-xs gap-2">
        <div className="flex items-center gap-2 font-mono">
          <span className="font-semibold text-slate-900 truncate max-w-[180px] sm:max-w-[280px]">
            {document.fileName}
          </span>
          <span className="text-slate-500 font-sans text-[11px]">
            {document.qualityMetrics?.dpi > 0
              ? `(${document.qualityMetrics.dpi} DPI • 24-bit)`
              : (isHindi ? '(DPI अज्ञात — फ़ाइल से नहीं मापा गया)' : '(DPI unknown — not measured from file)')}
          </span>
          <span className="text-[10px] bg-slate-200/80 text-slate-700 font-mono px-1.5 py-0.5 rounded">
            {t.viewer.pageIndicator(1, 1)}
          </span>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(50, z - 20))}
            className="p-1 rounded hover:bg-slate-200/70 text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
            title={t.viewer.zoomOut}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="font-mono text-slate-700 px-1 min-w-[38px] text-center text-[11px] font-semibold">
            {zoom}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(250, z + 20))}
            className="p-1 rounded hover:bg-slate-200/70 text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
            title={t.viewer.zoomIn}
          >
            <ZoomIn className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleFitToWidth}
            className="p-1 rounded hover:bg-slate-200/70 text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
            title={t.viewer.fitToWidth}
          >
            <Maximize2 className="w-4 h-4" />
          </button>

          <div className="h-4 w-px bg-slate-300 mx-1" />

          <button
            type="button"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            className="p-1 rounded hover:bg-slate-200/70 text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
            title={t.viewer.rotate}
          >
            <RotateCw className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setInvert((v) => !v)}
            className={`p-1 rounded cursor-pointer transition-colors ${
              invert
                ? 'bg-amber-100 text-amber-900 border border-amber-300'
                : 'hover:bg-slate-200/70 text-slate-600'
            }`}
            title={t.viewer.invert}
          >
            <Sun className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setIsBinarized((v) => !v)}
            className={`p-1 rounded cursor-pointer transition-colors ${
              isBinarized
                ? 'bg-blue-100 text-blue-900 border border-blue-300'
                : 'hover:bg-slate-200/70 text-slate-600'
            }`}
            title={t.viewer.binarize}
          >
            <Sparkles className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setShowBoxes((v) => !v)}
            className={`p-1 rounded cursor-pointer transition-colors ${
              showBoxes
                ? 'bg-slate-900 text-white'
                : 'hover:bg-slate-200/70 text-slate-600'
            }`}
            title={t.viewer.showBoxes}
          >
            <Layers className="w-4 h-4" />
          </button>

          <div className="h-4 w-px bg-slate-300 mx-1" />

          <button
            type="button"
            onClick={resetView}
            className="p-1 rounded hover:bg-slate-200/70 text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
            title={t.viewer.reset}
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Document Canvas Viewport */}
      <div
        className={`relative w-full ${heightClass} overflow-auto bg-slate-200/70 flex items-center justify-center p-4 sm:p-6 select-none`}
      >
        {/* Real Uploaded Document Mode */}
        {isRealImage ? (
          <div
            style={{
              transform: `scale(${zoom / 100}) rotate(${effectiveRotation}deg)`,
              filter: `contrast(${contrast}%) brightness(${100 + brightness}%) ${
                invert ? 'invert(1)' : ''
              } ${isBinarized ? 'grayscale(100%) contrast(250%)' : ''}`,
              transition: 'transform 0.15s ease-out',
            }}
            className="relative inline-block bg-white shadow-2xl rounded border border-slate-300 overflow-hidden max-w-full"
          >
            {/* Live Scan Badge */}
            <div className="absolute top-3 left-3 z-30 bg-slate-950/85 backdrop-blur-xs text-white text-[10px] font-mono px-2.5 py-1 rounded-md border border-slate-700 flex items-center gap-1.5 shadow-md">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-semibold">{t.viewer.actualDocumentBadge}</span>
            </div>

            <img
              src={document.imageUri}
              alt={document.fileName}
              className="max-w-[650px] w-full h-auto object-contain block select-none"
            />

            {/* Bounding Box Highlights Over Real Image */}
            {showBoxes &&
              boundingBoxes.map((box) => {
                const isSelected = selectedBoxId === box.id || selectedBoxId === box.field;
                return (
                  <div
                    key={box.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectBox?.(box.id, box.field);
                    }}
                    style={{
                      left: `${box.x}%`,
                      top: `${box.y}%`,
                      width: `${box.width}%`,
                      height: `${box.height}%`,
                    }}
                    className={`absolute cursor-pointer border-2 transition-all duration-150 ${
                      isSelected
                        ? 'border-blue-600 bg-blue-500/30 ring-4 ring-blue-500/35 z-30'
                        : box.confidence < 75
                        ? 'border-rose-500 bg-rose-500/20 hover:bg-rose-500/30 z-20'
                        : 'border-emerald-500/90 bg-emerald-500/15 hover:bg-emerald-500/25 z-10'
                    }`}
                    title={`${box.field} (${box.confidence}% ${isHindi ? 'सटीकता' : 'confidence'})`}
                  >
                    <span
                      className={`absolute -top-4 left-0 px-1 py-0.2 text-[8px] font-mono font-bold rounded shadow-xs ${
                        isSelected
                          ? 'bg-blue-700 text-white'
                          : box.confidence < 75
                          ? 'bg-rose-700 text-white'
                          : 'bg-emerald-700 text-white'
                      }`}
                    >
                      {box.field} • {box.confidence.toFixed(0)}%
                    </span>
                  </div>
                );
              })}
          </div>
        ) : (
          /* Preset Sample Document Mode (Clearly Labeled as Demo Sample) */
          <div
            style={{
              transform: `scale(${zoom / 100}) rotate(${effectiveRotation}deg)`,
              filter: `contrast(${contrast}%) brightness(${100 + brightness}%) ${
                invert ? 'invert(1)' : ''
              } ${isBinarized ? 'grayscale(100%) contrast(250%)' : ''}`,
              transition: 'transform 0.15s ease-out',
            }}
            className="relative w-[650px] min-h-[850px] bg-[#fbf9f4] text-slate-900 shadow-2xl p-8 border border-slate-300 rounded font-serif"
          >
            {/* Subtle paper texture simulation */}
            <div className="absolute inset-0 bg-[radial-gradient(#d4af37_0.75px,transparent_0.75px)] [background-size:16px_16px] opacity-15 pointer-events-none" />

            {/* Clear Demo Sample Banner */}
            <div className="relative flex items-center justify-between mb-3 border-b border-amber-300/80 pb-2">
              <div className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold text-amber-950 bg-amber-100/90 border border-amber-300 px-2.5 py-0.5 rounded-full shadow-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-600 animate-pulse" />
                <span>{t.viewer.demoSampleBadge}</span>
              </div>
              <span className="text-[10px] font-mono font-bold text-slate-800 bg-slate-100 px-2 py-0.5 rounded border border-slate-300">
                {document.documentCode}
              </span>
            </div>

            {/* Document Header */}
            <div className="relative border-b-2 border-slate-900 pb-3 mb-4 text-center">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-sans text-slate-600 uppercase font-mono">
                  {isHindi ? 'प्रारूप सं. 18 (नियम 153 देखें)' : 'Form No. 18 (See Rule 153)'}
                </span>
                <span className="text-[10px] font-sans text-slate-600 uppercase font-mono">
                  {isHindi ? 'संवत / वर्ष: ' : 'Year: '}
                  {document.data.settlementYear.value}
                </span>
              </div>

              <div className="text-lg font-bold tracking-wide uppercase text-slate-950">
                {isHindi ? 'प्रारूप जमाबंदी (खतौनी) • अधिकार अभिलेख' : 'प्रारूप जमाबंदी (खतौनी) • RECORD OF RIGHTS'}
              </div>
              <div className="text-xs font-sans text-slate-700 mt-0.5">
                {isHindi
                  ? 'राजस्थान सरकार • राजस्व मण्डल राजस्थान (प्रोटोटाइप अभिलेख)'
                  : 'Government of Rajasthan • Board of Revenue (Prototype Record)'}
              </div>

              <div className="grid grid-cols-4 gap-2 mt-3 text-left font-sans text-xs bg-slate-100/80 p-2 rounded border border-slate-300">
                <div>
                  <span className="text-slate-500 text-[10px] block">
                    {isHindi ? 'ग्राम / मौज़ा:' : 'Village / Mauza:'}
                  </span>
                  <span className="font-semibold text-slate-900">{document.data.villageMauza.value}</span>
                </div>
                <div>
                  <span className="text-slate-500 text-[10px] block">
                    {isHindi ? 'पटवार वृत्त:' : 'Patwar Circle:'}
                  </span>
                  <span className="font-semibold text-slate-900">{document.data.patwarCircle.value}</span>
                </div>
                <div>
                  <span className="text-slate-500 text-[10px] block">
                    {isHindi ? 'तहसील:' : 'Tehsil:'}
                  </span>
                  <span className="font-semibold text-slate-900">{document.data.tehsil.value}</span>
                </div>
                <div>
                  <span className="text-slate-500 text-[10px] block">
                    {isHindi ? 'ज़िला:' : 'District:'}
                  </span>
                  <span className="font-semibold text-slate-900">{document.data.district.value}</span>
                </div>
              </div>
            </div>

            {/* Revenue Columns Grid */}
            <div className="relative border border-slate-900 font-sans text-xs">
              {/* Table Header */}
              <div className="grid grid-cols-12 bg-slate-200/90 border-b border-slate-900 text-[11px] font-bold text-slate-900 text-center divide-x divide-slate-800">
                <div className="col-span-2 p-1.5">
                  <div>{isHindi ? 'खसरा नं.' : 'खसरा नं.'}</div>
                  <div className="text-[9px] font-normal text-slate-600">Khasra No.</div>
                </div>
                <div className="col-span-2 p-1.5">
                  <div>{isHindi ? 'खाता सं.' : 'खाता सं.'}</div>
                  <div className="text-[9px] font-normal text-slate-600">Khatauni No.</div>
                </div>
                <div className="col-span-4 p-1.5">
                  <div>{isHindi ? 'खातेदार का नाम व हिस्सा' : 'खातेदार का नाम व हिस्सा'}</div>
                  <div className="text-[9px] font-normal text-slate-600">
                    {isHindi ? 'कृषक/स्वामी' : 'Owner & Co-sharer Name'}
                  </div>
                </div>
                <div className="col-span-2 p-1.5">
                  <div>{isHindi ? 'रकबा (क्षेत्रफल)' : 'रकबा (बीघा-बिस्वा)'}</div>
                  <div className="text-[9px] font-normal text-slate-600">
                    {isHindi ? 'बीघा-बिस्वा' : 'Area (Bigha/Biswa)'}
                  </div>
                </div>
                <div className="col-span-2 p-1.5">
                  <div>{isHindi ? 'लगान (₹)' : 'लगान (₹)'}</div>
                  <div className="text-[9px] font-normal text-slate-600">
                    {isHindi ? 'वार्षिक भू-राजस्व' : 'Lagaan / Cess'}
                  </div>
                </div>
              </div>

              {/* Table Body Row */}
              <div className="grid grid-cols-12 divide-x divide-slate-800 min-h-[220px] bg-amber-50/20">
                {/* Khasra Column */}
                <div className="col-span-2 p-2 text-center font-bold text-sm text-slate-950">
                  <div className="font-mono">{document.data.khasraNo.value}</div>
                  <div className="text-xs text-slate-600 mt-1 font-serif">
                    ({document.data.khasraNo.hindiValue})
                  </div>
                  <div className="mt-3 text-[10px] text-slate-500 font-mono">
                    {isHindi ? 'खेवट:' : 'Khewat:'} {document.data.khewatNo.value}
                  </div>
                </div>

                {/* Khatauni Column */}
                <div className="col-span-2 p-2 text-center font-bold text-sm text-slate-950">
                  <div className="font-mono">{document.data.khatauniNo.value}</div>
                  <div className="text-xs text-slate-600 mt-1 font-serif">
                    ({document.data.khatauniNo.hindiValue})
                  </div>
                </div>

                {/* Owners Column */}
                <div className="col-span-4 p-2 text-xs space-y-2">
                  {document.data.owners.map((owner, idx) => (
                    <div key={owner.id} className="border-b border-slate-200 pb-1.5 last:border-0">
                      <div className="font-semibold text-slate-900">
                        {idx + 1}. {owner.name}
                      </div>
                      <div className="text-slate-600 font-serif text-[11px]">
                        {owner.relationType} {owner.relativeName}
                      </div>
                      <div className="flex items-center justify-between text-[10px] mt-0.5 text-slate-600">
                        <span className="font-mono bg-slate-100 px-1 rounded">
                          {isHindi ? 'हिस्सा:' : 'Share:'} {owner.shareFraction} ({owner.sharePercentage}%)
                        </span>
                        {owner.status?.includes('Deceased') && (
                          <span className="text-rose-700 font-bold bg-rose-50 px-1 rounded">
                            {isHindi ? '★ मृतक' : '★ DECEASED'}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Area Column */}
                <div className="col-span-2 p-2 text-center text-xs">
                  <div className="font-bold text-slate-950">
                    {document.data.rakbaArea.bigha} {isHindi ? 'बीघा' : 'Bigha'} -{' '}
                    {document.data.rakbaArea.biswa} {isHindi ? 'बिस्वा' : 'Biswa'}
                  </div>
                  <div className="text-[10px] text-slate-600 mt-1 font-mono">
                    {document.data.rakbaArea.totalHectares} {isHindi ? 'हेक्टेयर' : 'Hectare'}
                  </div>
                  <div className="text-[9px] text-slate-500 mt-2 bg-slate-100 p-1 rounded font-sans">
                    {document.data.landClassification.value}
                  </div>
                </div>

                {/* Lagaan Column */}
                <div className="col-span-2 p-2 text-center text-xs">
                  <div className="font-bold text-slate-950 font-mono">
                    {lagaanValue !== null
                      ? `₹${lagaanValue.toFixed(2)}`
                      : isHindi
                      ? 'अभिलेखित नहीं'
                      : 'Not recorded'}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">{isHindi ? 'प्रति वर्ष' : 'Per Annum'}</div>
                </div>
              </div>

              {/* Remarks / Encumbrance Section */}
              <div className="p-2.5 bg-slate-50 border-t border-slate-800 text-[11px]">
                <span className="font-bold text-slate-900">
                  {isHindi
                    ? 'कैफियत व विशेष विवरण: '
                    : 'कैफियत व विशेष विवरण (Remarks & Encumbrance): '}
                </span>
                {document.data.encumbrance.isMortgaged && (
                  <span className="text-amber-900 font-medium">
                    {document.data.encumbrance.bankName}{' '}
                    {isHindi
                      ? `(बंधक ग्रहणाधिकार ₹${document.data.encumbrance.mortgageAmountINR?.toLocaleString('en-IN')})`
                      : `(Mortgage Lien ₹${document.data.encumbrance.mortgageAmountINR?.toLocaleString('en-IN')})`}
                    .{' '}
                  </span>
                )}
                {document.data.encumbrance.courtInjunctionActive && (
                  <span className="text-rose-900 font-bold">
                    {isHindi
                      ? `★ न्यायालय स्थगन सक्रिय: ${document.data.encumbrance.courtCaseRef}. `
                      : `★ COURT STAY ACTIVE: ${document.data.encumbrance.courtCaseRef}. `}
                  </span>
                )}
                <span className="text-slate-700">{document.data.encumbrance.remarks}</span>
              </div>
            </div>

            {/* Stamp & Patwari Signatures Bottom */}
            <div className="mt-8 flex items-end justify-between text-xs pt-4 border-t border-slate-300">
              <div className="text-center font-serif text-[11px] text-slate-700">
                <div className="w-20 h-20 rounded-full border-2 border-dashed border-indigo-900/50 flex flex-col items-center justify-center p-1 text-[8px] mx-auto text-indigo-950 rotate-[-8deg] bg-indigo-50/20">
                  <span className="font-bold">पटवार मंडल</span>
                  <span>राजस्थान सरकार</span>
                  <span className="font-mono text-[7px]">PC-{document.district.toUpperCase()}</span>
                </div>
                <div className="mt-1 font-sans">{isHindi ? 'हस्ताक्षर पटवारी' : 'हस्ताक्षर पटवारी (Patwari Seal)'}</div>
              </div>

              <div className="text-right text-[11px] text-slate-700 font-sans">
                <div className="font-mono font-bold text-slate-900">तहसीलदार / नायब तहसीलदार</div>
                <div className="text-[10px] text-slate-500">
                  {isHindi ? 'उप-खंडीय राजस्व न्यायालय' : 'Sub-Divisional Revenue Court'}
                </div>
                <div className="text-[9px] font-mono text-slate-400 mt-1">Ref: {document.id}</div>
              </div>
            </div>

            {/* Bounding Box Highlights Over Sample */}
            {showBoxes &&
              boundingBoxes.map((box) => {
                const isSelected = selectedBoxId === box.id || selectedBoxId === box.field;
                return (
                  <div
                    key={box.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectBox?.(box.id, box.field);
                    }}
                    style={{
                      left: `${box.x}%`,
                      top: `${box.y}%`,
                      width: `${box.width}%`,
                      height: `${box.height}%`,
                    }}
                    className={`absolute cursor-pointer border-2 transition-all duration-150 ${
                      isSelected
                        ? 'border-blue-600 bg-blue-500/25 ring-4 ring-blue-500/30 z-30'
                        : box.confidence < 75
                        ? 'border-rose-500 bg-rose-500/15 hover:bg-rose-500/25 z-20'
                        : 'border-emerald-500/80 bg-emerald-500/10 hover:bg-emerald-500/20 z-10'
                    }`}
                    title={`${box.field} (${box.confidence}% ${isHindi ? 'सटीकता' : 'confidence'})`}
                  >
                    <span
                      className={`absolute -top-4 left-0 px-1 py-0.2 text-[8px] font-mono font-bold rounded ${
                        isSelected
                          ? 'bg-blue-700 text-white'
                          : box.confidence < 75
                          ? 'bg-rose-700 text-white'
                          : 'bg-emerald-700 text-white'
                      }`}
                    >
                      {box.field} • {box.confidence.toFixed(0)}%
                    </span>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* Bottom Information Footer */}
      {allowEnhancementControls && (
        <div className="px-3.5 py-2 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between text-xs text-slate-600 gap-2">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="text-slate-700 font-medium">{t.viewer.deskew}:</span>
              <button
                type="button"
                onClick={() => setIsDeskewActive((v) => !v)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer ${
                  isDeskewActive
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {isDeskewActive
                  ? isHindi
                    ? 'सक्रिय (-1.8°)'
                    : 'ON (-1.8°)'
                  : isHindi
                  ? 'बंद (मूल)'
                  : 'OFF (Raw)'}
              </button>
            </span>

            <span className="flex items-center gap-1.5">
              <span className="text-slate-700 font-medium">{t.viewer.contrast}:</span>
              <input
                type="range"
                min="70"
                max="180"
                value={contrast}
                onChange={(e) => setContrast(Number(e.target.value))}
                className="w-20 h-1.5 bg-slate-300 rounded-lg accent-slate-900 cursor-pointer"
              />
              <span className="font-mono text-[10px] text-slate-700">{contrast}%</span>
            </span>

            <span className="flex items-center gap-1.5">
              <span className="text-slate-700 font-medium">{t.viewer.brightness}:</span>
              <input
                type="range"
                min="-30"
                max="30"
                value={brightness}
                onChange={(e) => setBrightness(Number(e.target.value))}
                className="w-20 h-1.5 bg-slate-300 rounded-lg accent-slate-900 cursor-pointer"
              />
              <span className="font-mono text-[10px] text-slate-700">
                {brightness > 0 ? `+${brightness}` : brightness}
              </span>
            </span>
          </div>

          <div className="text-[11px] text-slate-600 font-sans flex items-center gap-2">
            <span>{isHindi ? 'टेसरैक्ट ओसीआर:' : 'Tesseract OCR:'}</span>
            <span className="font-mono text-emerald-700 font-bold">
              {document.ocrEngines?.tesseractConfidence > 0
                ? `${document.ocrEngines.tesseractConfidence}%`
                : t.viewer.confidenceUnavailable}
            </span>
            <span className="text-slate-300">|</span>
            <span>{t.viewer.cerLabel}:</span>
            <span className="font-mono text-slate-700 font-semibold">
              {document.ocrEngines?.characterErrorRate != null ? `${document.ocrEngines.characterErrorRate}%` : '—'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
