import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import { RecordType } from '../../types';
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  AlertCircle,
  FileCheck,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  HelpCircle,
  Image as ImageIcon,
  FolderOpen,
} from 'lucide-react';

const isSupportedDocument = (file: File) => {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return ['pdf', 'tif', 'tiff', 'jpg', 'jpeg', 'png'].includes(extension || '') ||
    ['application/pdf', 'image/tiff', 'image/jpeg', 'image/png'].includes(file.type);
};

interface MeasuredImage {
  width: number;
  height: number;
  aspect: number;
}

const measureImageFile = (file: File): Promise<MeasuredImage | null> =>
  new Promise((resolve) => {
    if (!file.type.startsWith('image/')) {
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        aspect: img.naturalHeight > 0 ? Number((img.naturalWidth / img.naturalHeight).toFixed(2)) : 0,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });

// No scanner DPI metadata, skew or blur measurement is computed in this browser build, so an
// uploaded file is stored with zeros (rendered as "unknown / not measured") instead of numbers
// derived from the filename.
const UNMEASURED_METRICS = {
  dpi: 0,
  skewAngle: 0,
  blurScore: 0,
  lighting: 'Uniform' as const,
  stainsAndFolds: 'Clean' as const,
  contrastRatio: 0,
  overallScore: 0,
  passed: false,
};

export const DocumentUploadView: React.FC = () => {
  const { uploadDocument, setActiveView } = useApp();
  const { t, isHindi } = useTranslation();

  const [district, setDistrict] = useState<string>('Jaipur');
  const [tehsil, setTehsil] = useState<string>('Sanganer');
  const [village, setVillage] = useState<string>('Rampur');
  const [patwarCircle, setPatwarCircle] = useState<string>('PC-14 Rampur Kalan');
  const [recordType, setRecordType] = useState<RecordType>('Jamabandi (RoR - Record of Rights)');
  const [fileName, setFileName] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [measuredImage, setMeasuredImage] = useState<MeasuredImage | null>(null);
  const [selectedSample, setSelectedSample] = useState<'clean' | 'skewed' | 'mutation' | null>(null);

  const chooseFile = (file: File) => {
    setSelectedFile(file);
    setSelectedSample(null);
    setFileName(file.name);
    setMeasuredImage(null);
    measureImageFile(file).then(setMeasuredImage);
  };

  const handlePresetSelect = (presetType: 'clean' | 'skewed' | 'mutation') => {
    setSelectedFile(null);
    setMeasuredImage(null);
    setSelectedSample(presetType);
    if (presetType === 'clean') {
      setDistrict('Jaipur');
      setTehsil('Sanganer');
      setVillage('Rampur');
      setPatwarCircle('PC-14 Rampur Kalan');
      setRecordType('Jamabandi (RoR - Record of Rights)');
      setFileName('Jamabandi_Rampur_Khasra_412_2024.pdf');
    } else if (presetType === 'skewed') {
      setDistrict('Udaipur');
      setTehsil('Girwa');
      setVillage('Kothari');
      setPatwarCircle('PC-09 Kothari');
      setRecordType('Khasra Girdawari (Harvest Inspection)');
      setFileName('Khasra_Girdawari_Kothari_Village_77_1.pdf');
    } else {
      setDistrict('Jodhpur');
      setTehsil('Osian');
      setVillage('Bhed');
      setPatwarCircle('PC-07 Bhed');
      setRecordType('Dakhil Kharij (Mutation Register)');
      setFileName('Dakhil_Kharij_205.pdf');
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fileName) {
      window.alert(t.upload.selectScannedNotice);
      return;
    }
    if (selectedFile && selectedFile.size > 3 * 1024 * 1024) {
      window.alert(t.upload.limitNotice);
      return;
    }
    const isSkewed = fileName.includes('Kothari') || fileName.includes('77_1') || fileName.includes('77A');

    let imageUri: string | undefined;
    if (selectedFile) {
      try {
        imageUri = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(selectedFile);
        });
      } catch {
        window.alert(t.upload.fileReadError);
        return;
      }
    } else if (selectedSample) {
      imageUri = `sample:${selectedSample}`;
    }

    uploadDocument({
      fileName,
      imageUri,
      district,
      tehsil,
      village,
      patwarCircle,
      recordType,
      priority: isSkewed ? 'High' : 'Medium',
      qualityMetrics: selectedSample
        ? isSkewed
          ? {
              dpi: 240,
              skewAngle: 4.2,
              blurScore: 71,
              lighting: 'Moderate Shadow',
              stainsAndFolds: 'Severe Staining & Ink Bleed',
              contrastRatio: 9.8,
              overallScore: 68,
              passed: true,
            }
          : {
              dpi: 300,
              skewAngle: -1.2,
              blurScore: 91,
              lighting: 'Uniform',
              stainsAndFolds: 'Clean',
              contrastRatio: 16.8,
              overallScore: 94,
              passed: true,
            }
        : UNMEASURED_METRICS,
    });

    setTimeout(() => {
      setActiveView('quality_check');
    }, 450);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-blue-700 font-mono font-medium">
            <span>{t.nav.stepIndicator(2, 9)}</span>
            <span>•</span>
            <span>{t.upload.stepTag}</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-1">
            {t.upload.title}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t.upload.subtitle}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setActiveView('dashboard')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 text-xs font-semibold shadow-xs transition-colors cursor-pointer self-start sm:self-auto"
        >
          <ArrowLeft className="w-4 h-4 text-slate-500" />
          <span>{t.upload.backToDashboard}</span>
        </button>
      </div>

      {/* Preset Quick Selectors */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
        <div className="text-xs font-bold text-slate-700 uppercase tracking-wider font-mono mb-2.5 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-amber-500" />
          <span>{t.upload.quickPresets}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            type="button"
            onClick={() => handlePresetSelect('clean')}
            className="p-3 bg-slate-50 hover:bg-white border border-slate-200/80 hover:border-blue-400 rounded-lg text-left transition-all cursor-pointer shadow-xs"
          >
            <span className="text-[10px] font-mono text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200 font-semibold">
              {t.upload.gradeA}
            </span>
            <div className="text-xs font-bold text-slate-900 mt-1.5">{t.upload.sampleJamabandiName}</div>
            <div className="text-[11px] text-slate-500">{t.upload.gradeASub}</div>
          </button>

          <button
            type="button"
            onClick={() => handlePresetSelect('skewed')}
            className="p-3 bg-slate-50 hover:bg-white border border-slate-200/80 hover:border-amber-400 rounded-lg text-left transition-all cursor-pointer shadow-xs"
          >
            <span className="text-[10px] font-mono text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 font-semibold">
              {t.upload.gradeB}
            </span>
            <div className="text-xs font-bold text-slate-900 mt-1.5">{t.upload.sampleGirdawariName}</div>
            <div className="text-[11px] text-slate-500">{t.upload.gradeBSub}</div>
          </button>

          <button
            type="button"
            onClick={() => handlePresetSelect('mutation')}
            className="p-3 bg-slate-50 hover:bg-white border border-slate-200/80 hover:border-blue-400 rounded-lg text-left transition-all cursor-pointer shadow-xs"
          >
            <span className="text-[10px] font-mono text-blue-800 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200 font-semibold">
              {t.upload.gradeC}
            </span>
            <div className="text-xs font-bold text-slate-900 mt-1.5">{t.upload.sampleMutationName}</div>
            <div className="text-[11px] text-slate-500">{t.upload.gradeCSub}</div>
          </button>
        </div>
      </div>

      {/* Upload Form */}
      <form onSubmit={handleUploadSubmit} className="space-y-5">
        {/* Drag and Drop Zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files.length > 0) {
              const file = e.dataTransfer.files[0];
              if (!isSupportedDocument(file)) {
                window.alert(t.upload.unsupportedFormatNotice);
                return;
              }
              chooseFile(file);
            }
          }}
          className={`border-2 border-dashed rounded-xl p-8 text-center transition-all bg-white shadow-xs ${
            isDragging
              ? 'border-blue-500 bg-blue-50/50'
              : 'border-slate-300 hover:border-slate-400'
          }`}
        >
          <div className="w-12 h-12 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center mx-auto mb-3">
            <UploadCloud className="w-6 h-6" />
          </div>

          <div className="text-sm font-bold text-slate-900">
            {t.upload.dragDropTitle}
          </div>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            {t.upload.dragDropDesc}
          </p>

          <div className="mt-4 flex items-center justify-center gap-3">
            <label className="bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-semibold px-4 py-2 rounded-lg border border-slate-300 cursor-pointer transition-colors flex items-center gap-2 shadow-xs">
              <FolderOpen className="w-4 h-4 text-blue-700" />
              <span>{t.upload.browseFile}</span>
              <input
                type="file"
                className="hidden"
                accept=".pdf,.tif,.tiff,.jpg,.jpeg,.png"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    const file = e.target.files[0];
                    if (!isSupportedDocument(file)) {
                      window.alert(t.upload.unsupportedFormatNotice);
                      return;
                    }
                    chooseFile(file);
                  }
                }}
              />
            </label>
          </div>

          {fileName && (
            <div className="mt-4 inline-flex flex-col items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-800 font-mono">
              <span className="inline-flex items-center gap-2">
                <FileText className="w-4 h-4 text-emerald-600" />
                <span>{selectedSample ? `${isHindi ? 'नमूना:' : 'Sample:'} ${fileName}` : `${t.upload.selectedFile} ${fileName}`}</span>
              </span>
              {selectedFile && (
                measuredImage ? (
                  <span className="text-[10px] text-slate-500">
                    {`${measuredImage.width} × ${measuredImage.height} px • aspect ${measuredImage.aspect}:1 • `}
                    {isHindi ? 'DPI अज्ञात (रास्टर फ़ाइल में मेटाडेटा नहीं)' : 'DPI unknown (not embedded in raster files)'}
                  </span>
                ) : (
                  <span className="text-[10px] text-amber-700">
                    {isHindi ? 'इस फ़ाइल से पिक्सेल विमा/DPI नहीं मापा जा सका — Quality Check में दृश्य जाँच करें।' : 'Pixel dimensions/DPI could not be measured from this file — inspect visually in Quality Check.'}
                  </span>
                )
              )}
              {selectedSample && (
                <span className="text-[10px] text-amber-800 font-semibold">{isHindi ? 'डेमो नमूना — मापें केवल प्रदर्शन के लिए, मापी-हुई नहीं' : 'DEMO SAMPLE — the quality figures below are for display, not measured'}</span>
              )}
            </div>
          )}
        </div>

        {/* Administrative Metadata Grid */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-xs">
          <h3 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-2">
            {t.upload.jurisdictionTitle}
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
            <div>
              <label className="block text-slate-700 font-medium mb-1">{t.upload.state}</label>
              <input
                type="text"
                readOnly
                value={isHindi ? 'राजस्थान (Rajasthan)' : 'Rajasthan (राजस्थान)'}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-600"
              />
            </div>

            <div>
              <label className="block text-slate-700 font-medium mb-1">{t.upload.district}</label>
              <select
                value={district}
                onChange={(e) => setDistrict(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-slate-400"
              >
                <option value="Jaipur">{isHindi ? 'जयपुर (Jaipur)' : 'Jaipur (जयपुर)'}</option>
                <option value="Jodhpur">{isHindi ? 'जोधपुर (Jodhpur)' : 'Jodhpur (जोधपुर)'}</option>
                <option value="Udaipur">{isHindi ? 'उदयपुर (Udaipur)' : 'Udaipur (उदयपुर)'}</option>
                <option value="Kota">{isHindi ? 'कोटा (Kota)' : 'Kota (कोटा)'}</option>
                <option value="Ajmer">{isHindi ? 'अजमेर (Ajmer)' : 'Ajmer (अजमेर)'}</option>
                <option value="Bikaner">{isHindi ? 'बीकानेर (Bikaner)' : 'Bikaner (बीकानेर)'}</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-700 font-medium mb-1">{t.upload.tehsil}</label>
              <input
                type="text"
                value={tehsil}
                onChange={(e) => setTehsil(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-slate-400"
              />
            </div>

            <div>
              <label className="block text-slate-700 font-medium mb-1">{t.upload.village}</label>
              <input
                type="text"
                value={village}
                onChange={(e) => setVillage(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-slate-400"
              />
            </div>

            <div>
              <label className="block text-slate-700 font-medium mb-1">{t.upload.patwarCircle}</label>
              <input
                type="text"
                value={patwarCircle}
                onChange={(e) => setPatwarCircle(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-slate-400"
              />
            </div>

            <div>
              <label className="block text-slate-700 font-medium mb-1">{t.upload.recordType}</label>
              <select
                value={recordType}
                onChange={(e) => setRecordType(e.target.value as RecordType)}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-slate-400"
              >
                <option value="Jamabandi (RoR - Record of Rights)">
                  {isHindi ? 'जमाबंदी (अधिकार अभिलेख - RoR)' : 'Jamabandi (RoR - Record of Rights)'}
                </option>
                <option value="Khasra Girdawari (Harvest Inspection)">
                  {isHindi ? 'खसरा गिरदावरी (फसल निरीक्षण)' : 'Khasra Girdawari (Harvest Inspection)'}
                </option>
                <option value="Dakhil Kharij (Mutation Register)">
                  {isHindi ? 'दाखिल खारिज (नामांतरण रजिस्टर)' : 'Dakhil Kharij (Mutation Register)'}
                </option>
                <option value="Shajra Kishtwar (Cadastral Map)">
                  {isHindi ? 'शजरा किश्तवार (भू-नक्शा)' : 'Shajra Kishtwar (Cadastral Map)'}
                </option>
              </select>
            </div>
          </div>
        </div>

        {/* Submit Bar */}
        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <HelpCircle className="w-4 h-4 text-slate-400" />
            <span>{t.upload.helpText}</span>
          </div>

          <button
            type="submit"
            className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-5 py-2.5 rounded-lg shadow-xs transition-all cursor-pointer"
          >
            <span>{t.upload.proceedQuality}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
};
