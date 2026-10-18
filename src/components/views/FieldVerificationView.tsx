import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import {
  Camera,
  CameraOff,
  Crosshair,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Compass,
  MapPin,
  CheckCircle2,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  Sparkles,
  Layers,
  Image as ImageIcon,
  Save,
  Stamp,
  Database,
  Info,
  RefreshCw,
} from 'lucide-react';
import type { FieldCheckpoint, FieldInspectionRecord, LandParcel } from '../../types';
import { submitFieldInspectionToBackend } from '../../services/api/client';

const OBSERVED_LAND_USE_OPTIONS: Array<{ value: string; label: string; hindiLabel: string }> = [
  { value: 'Chahi (Well Irrigated)', label: 'Chahi (Well Irrigated)', hindiLabel: 'चाही (कूप सिंचित)' },
  { value: 'Nahri (Canal Irrigated)', label: 'Nahri (Canal Irrigated)', hindiLabel: 'नहरी (नहर सिंचित)' },
  { value: 'Barani (Rainfed)', label: 'Barani (Rainfed)', hindiLabel: 'बारानी (वर्षा आधारित)' },
  { value: 'Gair Mumkin (Built-up)', label: 'Gair Mumkin (Built-up)', hindiLabel: 'गैर मुमकिन (आबादी/भवन)' },
  { value: 'Commercial / Non-Agri', label: 'Commercial / Industrial', hindiLabel: 'व्यावसायिक / औद्योगिक' },
];

export const FieldVerificationView: React.FC = () => {
  const {
    activeParcel,
    parcels,
    selectParcel,
    updateParcel,
    currentUser,
    setActiveView,
    addNotification,
  } = useApp();

  const { t, isHindi } = useTranslation();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const componentMountedRef = useRef<boolean>(true);

  // Camera state
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [simulatedMode, setSimulatedMode] = useState<boolean>(false);

  // Geolocation and device orientation
  const [gpsCoords, setGpsCoords] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null);
  const [heading, setHeading] = useState<number>(45);

  // Field inspection state
  const [checkpoints, setCheckpoints] = useState<FieldCheckpoint[]>([
    {
      id: 'chk-1',
      label: 'Boundary Stones / Merh Identified',
      hindiLabel: 'मेढ़ एवं सीमा चिन्ह (पत्थर/मुनारे) मौके पर मौजूद हैं',
      status: 'pending',
    },
    {
      id: 'chk-2',
      label: 'Physical Possession Matches Recorded Co-Sharers',
      hindiLabel: 'भौतिक कब्जा दर्ज खातेदारों/सह-खातेदारों के अनुरूप है',
      status: 'pending',
    },
    {
      id: 'chk-3',
      label: 'Agricultural Land Use Matches Girdawari',
      hindiLabel: 'कृषि उपयोग एवं सिंचाई साधन गिरदावरी के अनुसार है',
      status: 'pending',
    },
    {
      id: 'chk-4',
      label: 'No Physical Encroachment on Government/Adjacent Land',
      hindiLabel: 'राजकीय अथवा पड़ोसी खसरे पर कोई अतिक्रमण नहीं है',
      status: 'pending',
    },
  ]);

  const [discrepancyObserved, setDiscrepancyObserved] = useState<boolean>(false);
  const [discrepancyNotes, setDiscrepancyNotes] = useState<string>('');
  const [observedLandUse, setObservedLandUse] = useState<string>(
    OBSERVED_LAND_USE_OPTIONS.find((option) => option.value === activeParcel?.landType)?.value ??
      OBSERVED_LAND_USE_OPTIONS[0].value
  );
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [capturedTimestamp, setCapturedTimestamp] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [boundaryOverlayMode, setBoundaryOverlayMode] = useState<'provisional' | 'verified' | 'both'>('both');

  const parcel = activeParcel || parcels[0];

  // Geolocation listener
  useEffect(() => {
    if ('geolocation' in navigator) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setGpsCoords({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
          });
        },
        () => {
          // Fallback to sample Rajasthan coordinates if denied
          setGpsCoords({
            latitude: 26.8421,
            longitude: 75.7892,
            accuracy: 4.5,
          });
        },
        { enableHighAccuracy: true, timeout: 5000 }
      );
      return () => navigator.geolocation.clearWatch(watchId);
    }
  }, []);

  // Device orientation listener
  useEffect(() => {
    const handleOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha !== null) {
        setHeading(Math.round(e.alpha));
      }
    };

    window.addEventListener('deviceorientation', handleOrientation, true);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, []);

  // Start Camera
  const startCamera = async () => {
    setCameraError(null);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API not supported on this browser or device.');
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      // The permission prompt can resolve after the officer has navigated away; the cleanup already ran.
      if (!componentMountedRef.current) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = mediaStream;

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        await videoRef.current.play();
      }

      setCameraActive(true);
      setSimulatedMode(false);
      addNotification(
        isHindi ? 'कैमरा सक्रिय' : 'Camera Active',
        isHindi ? 'फील्ड सत्यापन हेतु कैमरा प्रारंभ हुआ।' : 'Device camera initialized for field verification.',
        'info'
      );
    } catch (err: any) {
      console.warn('[DHAROHAR AR] Camera access error:', err.message);
      setCameraError(err.message || (isHindi ? 'कैमरा अनुमति अस्वीकृत या उपकरण उपलब्ध नहीं है।' : 'Camera permission denied or device not found.'));
      setCameraActive(false);
      setSimulatedMode(true);
    }
  };

  // Stop Camera
  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  };

  useEffect(() => {
    componentMountedRef.current = true;
    return () => {
      componentMountedRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  // Capture Field Snapshot with Watermark
  const captureSnapshot = () => {
    const canvas = canvasRef.current || document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (cameraActive && videoRef.current) {
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    } else {
      // Draw simulated landscape background
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, '#0f172a');
      grad.addColorStop(0.5, '#334155');
      grad.addColorStop(1, '#064e3b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Grid simulation
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (let x = 0; x < canvas.width; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
    }

    // Watermark overlay
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.fillRect(16, canvas.height - 110, canvas.width - 32, 94);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`DHAROHAR FIELD VERIFICATION SNAPSHOT • ${parcel?.id || 'PARCEL'}`, 32, canvas.height - 76);

    ctx.font = '14px monospace';
    ctx.fillStyle = '#38bdf8';
    const now = new Date().toLocaleString(isHindi ? 'hi-IN' : 'en-IN');
    ctx.fillText(
      `KHASRA: ${parcel?.khasraNo || '—'} | VILLAGE: ${parcel?.village || 'Rampur'} | COORDS: ${gpsCoords ? `${gpsCoords.latitude.toFixed(5)}°N, ${gpsCoords.longitude.toFixed(5)}°E` : '26.8421°N, 75.7892°E'}`,
      32,
      canvas.height - 52
    );

    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.fillText(`OFFICER: ${currentUser.name} (${currentUser.badgeNumber}) | TIME: ${now}`, 32, canvas.height - 28);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    setCapturedPhoto(dataUrl);
    setCapturedTimestamp(now);
    addNotification(
      isHindi ? 'फोटो कैप्चर की गई' : 'Snapshot Captured',
      isHindi ? 'फील्ड सत्यापन फोटो वाटरमार्क सहित संलग्न की गई।' : 'Field verification photo watermarked and attached.',
      'success'
    );
  };

  // Toggle Checkpoint
  const toggleCheckpoint = (id: string) => {
    setCheckpoints((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const nextStatus = c.status === 'passed' ? 'flagged' : c.status === 'flagged' ? 'failed' : 'passed';
        return { ...c, status: nextStatus };
      })
    );
  };

  const pendingCheckpoints = checkpoints.filter((c) => c.status === 'pending').length;
  const allCheckpointsSet = pendingCheckpoints === 0;

  // Save Inspection
  const handleSaveInspection = async () => {
    if (!parcel) return;
    if (!allCheckpointsSet) {
      addNotification(
        isHindi ? 'सभी धरातल चेकपॉइंट अनिवार्य' : 'Ground Checkpoints Incomplete',
        isHindi
          ? `सहेजने से पूर्व शेष ${pendingCheckpoints} चेकपॉइंट की मौजूदा धरातल स्थिति दर्ज करें।`
          : `Record the ground status for the ${pendingCheckpoints} remaining checkpoint(s) before saving.`,
        'warning'
      );
      return;
    }
    setSaving(true);

    const hasFlags = checkpoints.some((c) => c.status === 'flagged' || c.status === 'failed') || discrepancyObserved;

    const inspectionRecord: FieldInspectionRecord = {
      id: `insp-${Date.now()}`,
      parcelId: parcel.id,
      inspectedAt: new Date().toISOString(),
      inspectedBy: currentUser.name,
      inspectorRole: currentUser.designation,
      gpsCoords: gpsCoords
        ? {
            latitude: gpsCoords.latitude,
            longitude: gpsCoords.longitude,
            accuracyMeters: gpsCoords.accuracy,
          }
        : undefined,
      deviceHeadingDeg: heading,
      checkpoints,
      discrepancyObserved,
      discrepancyNotes,
      observedLandUse,
      photoUri: capturedPhoto || undefined,
      photoTimestamp: capturedTimestamp || undefined,
      isProvisional: true,
      recommendedAction: hasFlags ? 'Re-survey Required' : 'Proceed to Officer Seal',
    };

    // Update local parcel
    const currentInspections = parcel.inspectionHistory || [];
    const nextStatus = hasFlags ? 'Needs Review' : 'Needs Field Verification';

    updateParcel(parcel.id, {
      status: nextStatus,
      inspectionHistory: [inspectionRecord, ...currentInspections],
    });

    // Synchronize with PostgreSQL backend using authenticated client
    let backendDelivered = false;
    try {
      const result = await submitFieldInspectionToBackend(inspectionRecord);
      backendDelivered = Boolean(result.success);
      if (!result.success && result.error) {
        addNotification(
          isHindi ? 'सत्यापन प्राधिकरण सूचना' : 'Authorization Notice',
          result.error,
          'warning'
        );
      }
    } catch (err: any) {
      addNotification(
        isHindi ? 'बैकएण्ड सिंक विफल' : 'Backend Sync Failed',
        isHindi
          ? `निरीक्षण केवल इस ब्राउज़र सत्र में सहेजा गया; बैकएण्ड पर भेजा नहीं जा सका (${err?.message || 'अज्ञात त्रुटि'})।`
          : `Inspection was kept in this browser session only; it could not be delivered to the backend (${err?.message || 'unknown error'}).`,
        'error'
      );
    }

    setSaving(false);
    addNotification(
      isHindi ? 'फील्ड निरीक्षण सहेजा गया' : 'Field Inspection Saved',
      backendDelivered
        ? isHindi
          ? `पार्सल ${parcel.id} का निरीक्षण दर्ज तथा बैकएण्ड पर सिंक हुआ। अगला चरण: राजस्व अधिकारी सत्यापन।`
          : `Inspection for ${parcel.id} recorded and synced to the backend. Next step: Officer adjudication.`
        : isHindi
        ? `पार्सल ${parcel.id} का निरीक्षण केवल इस ब्राउज़र सत्र में दर्ज हुआ (बैकएण्ड सिंक असफल)। अगला चरण: राजस्व अधिकारी सत्यापन।`
        : `Inspection for ${parcel.id} recorded in this browser session only (backend sync not confirmed). Next step: Officer adjudication.`,
      backendDelivered ? 'success' : 'warning'
    );
  };

  const recordedArea = parcel?.recordedAreaHectares || 0;
  const mappedArea = parcel?.mappedAreaHectares || 0;
  const deltaArea = Math.abs(recordedArea - mappedArea);
  const areaDiscrepant = recordedArea > 0 && deltaArea > 0.05;

  return (
    <div className="space-y-6">
      {/* Top Header & Navigation */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-blue-700 font-mono font-semibold">
            <span>{t.field.stepBadge}</span>
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mt-1">
            {t.field.title}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t.field.subtitle}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Parcel Selector */}
          <select
            value={parcel?.id}
            onChange={(e) => selectParcel(e.target.value)}
            className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-800 shadow-xs cursor-pointer focus:outline-none focus:border-slate-500"
          >
            {parcels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} — {isHindi ? 'खसरा' : 'Khasra'} {p.khasraNo} ({p.village})
              </option>
            ))}
          </select>

          <button
            onClick={() => setActiveView('spatial_registry')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold border border-slate-200 shadow-xs transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 text-slate-500" />
            <span>{t.common.back}</span>
          </button>
        </div>
      </div>

      {/* Mandatory Non-Survey-Grade Disclaimer */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex items-start gap-3 shadow-xs">
        <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
        <div className="text-xs text-amber-900">
          <p className="font-bold">
            {t.field.advisoryTitle}
          </p>
          <p className="mt-0.5 text-amber-800 leading-relaxed">
            {t.field.advisoryText}
          </p>
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left / Viewfinder Column (7 Cols) */}
        <div className="lg:col-span-7 space-y-4">
          {/* Viewfinder Card */}
          <div className="relative bg-slate-950 rounded-2xl overflow-hidden border border-slate-800 shadow-xl min-h-[460px] flex items-center justify-center">
            {/* Live Video Element */}
            <video
              ref={videoRef}
              playsInline
              muted
              className={`absolute inset-0 w-full h-full object-cover ${cameraActive ? 'block' : 'hidden'}`}
            />

            {/* Hidden Canvas for Snapshots */}
            <canvas ref={canvasRef} className="hidden" />

            {/* Simulated Background if Camera Inactive */}
            {!cameraActive && (
              <div className="absolute inset-0 bg-radial from-slate-900 via-slate-950 to-black flex flex-col items-center justify-center p-6 text-center">
                {cameraError ? (
                  <div className="max-w-md space-y-3">
                    <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mx-auto">
                      <CameraOff className="w-6 h-6" />
                    </div>
                    <h4 className="text-sm font-bold text-white">{t.field.cameraInactive}</h4>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      {cameraError}
                    </p>
                    <div className="pt-2 flex items-center justify-center gap-2">
                      <button
                        onClick={startCamera}
                        className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                      >
                        {t.field.retryCamera}
                      </button>
                      <button
                        onClick={() => {
                          setSimulatedMode(true);
                          setCameraError(null);
                        }}
                        className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition-colors cursor-pointer"
                      >
                        {t.field.useSimulated}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="max-w-md space-y-3">
                    <div className="w-14 h-14 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 mx-auto animate-pulse">
                      <Camera className="w-7 h-7" />
                    </div>
                    <h4 className="text-sm font-bold text-white">
                      {t.field.initTitle}
                    </h4>
                    <p className="text-xs text-slate-400">
                      {t.field.initSubtitle}
                    </p>
                    <div className="pt-2 flex items-center justify-center gap-2">
                      <button
                        onClick={startCamera}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-lg transition-all cursor-pointer"
                      >
                        <Camera className="w-4 h-4" />
                        <span>{t.field.openCamera}</span>
                      </button>
                      <button
                        onClick={() => setSimulatedMode(true)}
                        className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 cursor-pointer"
                      >
                        {t.field.simulatedMode}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* AR CADASTRE HUD OVERLAY (Always active over camera or simulated view) */}
            {(cameraActive || simulatedMode) && (
              <div className="absolute inset-0 pointer-events-none p-4 flex flex-col justify-between select-none">
                {/* HUD Top Bar */}
                <div className="flex items-start justify-between gap-3 pointer-events-auto">
                  {/* Left: Parcel Identification Badge */}
                  <div className="bg-slate-900/85 backdrop-blur-md border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-white shadow-lg space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                      <span className="font-mono font-bold text-xs text-blue-300">{parcel?.id}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-400/30">
                        {parcel?.status}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-300 flex items-center gap-2 font-mono">
                      <span>{isHindi ? 'खसरा' : 'Khasra'}: <strong className="text-white">{parcel?.khasraNo}</strong></span>
                      <span>•</span>
                      <span>{isHindi ? 'खाता' : 'Khata'}: <strong className="text-white">{parcel?.khataNo}</strong></span>
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {parcel?.village}, {parcel?.tehsil} ({parcel?.district})
                    </div>
                  </div>

                  {/* Right: GPS & Compass HUD Badge */}
                  <div className="bg-slate-900/85 backdrop-blur-md border border-slate-700/80 rounded-xl px-3 py-2 text-white shadow-lg text-right font-mono text-[11px] space-y-0.5">
                    <div className="flex items-center justify-end gap-1.5 text-emerald-400 font-semibold">
                      <Compass className="w-3.5 h-3.5 animate-spin-slow" />
                      <span>{heading}° {t.field.heading}</span>
                    </div>
                    <div className="text-[10px] text-slate-300 flex items-center justify-end gap-1">
                      <MapPin className="w-3 h-3 text-blue-400" />
                      <span>
                        {gpsCoords ? `${gpsCoords.latitude.toFixed(4)}°N, ${gpsCoords.longitude.toFixed(4)}°E` : '26.8421°N, 75.7892°E'}
                      </span>
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {t.field.gpsAccuracy}: ±{gpsCoords?.accuracy || 4.2}m
                    </div>
                  </div>
                </div>

                {/* Center: Cadastral Boundary Wireframe Projection */}
                <div className="relative flex-1 flex items-center justify-center my-4">
                  <div className="relative w-72 h-56 border border-dashed border-blue-400/40 rounded-2xl flex items-center justify-center bg-blue-500/5">
                    {/* Reticle / Crosshair */}
                    <Crosshair className="w-8 h-8 text-blue-400/50 absolute" />

                    {/* SVG Boundary Mock Visualizer */}
                    <svg className="absolute inset-0 w-full h-full p-6" viewBox="0 0 200 150">
                      {/* Provisional Boundary (Dashed Amber) */}
                      {(boundaryOverlayMode === 'provisional' || boundaryOverlayMode === 'both') && (
                        <polygon
                          points="20,25 170,30 185,120 40,135"
                          fill="rgba(245, 158, 11, 0.12)"
                          stroke="#f59e0b"
                          strokeWidth="2"
                          strokeDasharray="4 4"
                        />
                      )}

                      {/* Verified Boundary (Solid Emerald) */}
                      {(boundaryOverlayMode === 'verified' || boundaryOverlayMode === 'both') && (
                        <polygon
                          points="25,30 165,35 178,115 45,128"
                          fill="rgba(16, 185, 129, 0.15)"
                          stroke="#10b981"
                          strokeWidth="2.5"
                        />
                      )}

                      {/* Vertex Markers */}
                      <circle cx="25" cy="30" r="3.5" fill="#10b981" />
                      <circle cx="165" cy="35" r="3.5" fill="#10b981" />
                      <circle cx="178" cy="115" r="3.5" fill="#10b981" />
                      <circle cx="45" cy="128" r="3.5" fill="#10b981" />
                    </svg>

                    {/* Boundary Distinction Legend Badge */}
                    <div className="absolute bottom-2 inset-x-2 flex items-center justify-center gap-3 text-[10px] bg-slate-900/90 px-2 py-1 rounded-lg border border-slate-700/60 text-slate-300 font-mono">
                      <span className="flex items-center gap-1">
                        <span className="w-2.5 h-0.5 bg-amber-400 border-b border-dashed inline-block" />
                        <span>{t.field.provisional}</span>
                      </span>
                      <span>|</span>
                      <span className="flex items-center gap-1">
                        <span className="w-2.5 h-1 bg-emerald-400 inline-block rounded-xs" />
                        <span>{t.field.verified}</span>
                      </span>
                    </div>
                  </div>
                </div>

                {/* HUD Bottom Bar: Area Metrics Strip */}
                <div className="bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-xl p-2.5 text-white shadow-lg pointer-events-auto flex items-center justify-between gap-4 text-xs font-mono">
                  <div className="flex items-center gap-3">
                    <div>
                      <span className="text-[10px] text-slate-400 block">{t.field.recordedRakba}</span>
                      <span className="font-bold text-white">{recordedArea ? `${recordedArea.toFixed(3)} ha` : '—'}</span>
                    </div>
                    <div className="h-6 w-px bg-slate-700" />
                    <div>
                      <span className="text-[10px] text-slate-400 block">{t.field.mappedArea}</span>
                      <span className="font-bold text-blue-300">{mappedArea.toFixed(3)} ha</span>
                    </div>
                  </div>

                  {/* Discrepancy indicator */}
                  <div className="flex items-center gap-2">
                    {areaDiscrepant ? (
                      <span className="flex items-center gap-1 text-amber-400 font-bold bg-amber-500/20 px-2 py-1 rounded border border-amber-500/30">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>Δ {deltaArea.toFixed(3)} ha {t.field.discrepancy}</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-emerald-400 font-bold bg-emerald-500/20 px-2 py-1 rounded border border-emerald-500/30">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{t.field.toleranceOk}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Viewfinder Controls & Capture Bar */}
          <div className="flex items-center justify-between gap-3 bg-white border border-slate-200 rounded-xl p-3 shadow-xs">
            <div className="flex items-center gap-2">
              {cameraActive ? (
                <button
                  onClick={stopCamera}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  <CameraOff className="w-4 h-4 text-slate-600" />
                  <span>{t.field.stopCamera}</span>
                </button>
              ) : (
                <button
                  onClick={startCamera}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-xs cursor-pointer"
                >
                  <Camera className="w-4 h-4" />
                  <span>{t.field.startCamera}</span>
                </button>
              )}

              {/* Boundary Overlay Mode Switcher */}
              <div className="flex items-center bg-slate-100 rounded-lg p-0.5 text-xs font-semibold text-slate-600">
                <button
                  onClick={() => setBoundaryOverlayMode('both')}
                  className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                    boundaryOverlayMode === 'both' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
                  }`}
                >
                  {isHindi ? 'दोनों' : 'Both'}
                </button>
                <button
                  onClick={() => setBoundaryOverlayMode('provisional')}
                  className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                    boundaryOverlayMode === 'provisional' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
                  }`}
                >
                  {isHindi ? 'मानचित्रित' : 'Provisional'}
                </button>
                <button
                  onClick={() => setBoundaryOverlayMode('verified')}
                  className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                    boundaryOverlayMode === 'verified' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
                  }`}
                >
                  {isHindi ? 'सत्यापित' : 'Verified'}
                </button>
              </div>
            </div>

            {/* Capture Snapshot Button */}
            <button
              onClick={captureSnapshot}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-xs cursor-pointer"
            >
              <Camera className="w-4 h-4 text-amber-400" />
              <span>{t.field.captureWatermarked}</span>
            </button>
          </div>
        </div>

        {/* Right / Checklists & Adjudication Column (5 Cols) */}
        <div className="lg:col-span-5 space-y-4">
          {/* Card 1: Ground Verification Checkpoints */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 font-mono flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
                <span>{t.field.checkpointsTitle}</span>
              </h3>
              <span className="text-[10px] text-slate-400">
                {allCheckpointsSet
                  ? t.field.toggleHint
                  : isHindi
                  ? `${pendingCheckpoints} चेकपॉइंट निरीक्षण शेष`
                  : `${pendingCheckpoints} checkpoint(s) not inspected`}
              </span>
            </div>

            <div className="space-y-2">
              {checkpoints.map((chk) => (
                <div
                  key={chk.id}
                  onClick={() => toggleCheckpoint(chk.id)}
                  className={`p-3 rounded-lg border text-xs cursor-pointer transition-all ${
                    chk.status === 'pending'
                      ? 'bg-slate-50 border-slate-300 border-dashed text-slate-700'
                      : chk.status === 'passed'
                      ? 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
                      : chk.status === 'flagged'
                      ? 'bg-amber-50/80 border-amber-300 text-amber-900'
                      : 'bg-rose-50/80 border-rose-300 text-rose-900'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{isHindi ? chk.hindiLabel : chk.label}</p>
                      <p className="text-[10px] opacity-75 mt-0.5 font-mono">
                        {isHindi ? 'स्थिति' : 'Status'}:{' '}
                        <strong>
                          {chk.status === 'pending'
                            ? (isHindi ? 'निरीक्षण नहीं — स्थिति दर्ज करें' : 'Not inspected — set status')
                            : chk.status === 'passed'
                            ? (isHindi ? 'सत्यापित / ठीक' : 'Verified / OK')
                            : chk.status === 'flagged'
                            ? (isHindi ? 'समीक्षा हेतु चिह्नित' : 'Flagged for Review')
                            : (isHindi ? 'विवादित / विफल' : 'Disputed / Failed')}
                        </strong>
                      </p>
                    </div>
                    {chk.status === 'pending' ? (
                      <Info className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                    ) : chk.status === 'passed' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    ) : chk.status === 'flagged' ? (
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Card 2: Ground Observations & Discrepancies */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 font-mono border-b border-slate-100 pb-2">
              {t.field.groundObsTitle}
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-[11px] font-medium text-slate-700 block mb-1">
                  {t.field.observedClassification}
                </label>
                <select
                  value={observedLandUse}
                  onChange={(e) => setObservedLandUse(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-800 font-medium focus:outline-none focus:border-slate-400"
                >
                  {OBSERVED_LAND_USE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {isHindi ? option.hindiLabel : option.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Discrepancy Toggle */}
              <label className="flex items-center gap-2 p-2.5 rounded-lg bg-slate-50 border border-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={discrepancyObserved}
                  onChange={(e) => setDiscrepancyObserved(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 h-4 w-4"
                />
                <span className="text-xs font-medium text-slate-800">
                  {t.field.discrepancyObserved}
                </span>
              </label>

              {discrepancyObserved && (
                <div>
                  <label className="text-[10px] text-slate-500 block mb-1">
                    {t.field.discrepancyDesc}
                  </label>
                  <textarea
                    rows={2}
                    value={discrepancyNotes}
                    onChange={(e) => setDiscrepancyNotes(e.target.value)}
                    placeholder={t.field.discrepancyPlaceholder}
                    className="w-full bg-slate-50 border border-amber-300 rounded-lg p-2 text-xs text-slate-800 focus:outline-none focus:border-amber-500"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Card 3: Captured Photo Preview */}
          {capturedPhoto && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs space-y-2">
              <div className="flex items-center justify-between border-b border-slate-100 pb-1.5 text-xs">
                <span className="font-bold text-slate-700">{t.field.capturedPhotoTitle}</span>
                <span className="text-[10px] font-mono text-slate-500">{capturedTimestamp}</span>
              </div>
              <div className="rounded-lg overflow-hidden border border-slate-200">
                <img src={capturedPhoto} alt={isHindi ? 'फील्ड सत्यापन' : 'Field verification'} className="w-full h-32 object-cover" />
              </div>
            </div>
          )}

          {/* Card 4: Action Footer */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2.5">
            {!allCheckpointsSet && (
              <p className="text-[10px] font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5 text-center">
                {isHindi
                  ? `निरीक्षण साक्ष्य सहेजने हेतु सभी ४ धरातल चेकपॉइंट की स्थिति दर्ज करें (${pendingCheckpoints} शेष)।`
                  : `Set the ground status for all 4 checkpoints before the inspection evidence can be recorded (${pendingCheckpoints} remaining).`}
              </p>
            )}

            <button
              onClick={handleSaveInspection}
              disabled={saving || !allCheckpointsSet}
              className="w-full flex items-center justify-center gap-2 bg-blue-700 hover:bg-blue-600 text-white text-xs font-bold py-2.5 rounded-lg shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? t.field.savingReport : t.field.saveReport}</span>
            </button>

            <button
              onClick={() => setActiveView('human_verification')}
              disabled={!allCheckpointsSet}
              className="w-full flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold py-2.5 rounded-lg shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Stamp className="w-4 h-4 text-emerald-400" />
              <span>{t.field.proceedOfficer}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
