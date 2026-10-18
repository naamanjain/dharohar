import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useTranslation } from '../../i18n';
import {
  Plus, Search, X, CheckCircle2, AlertTriangle, FileText, Ruler, Users, GitBranch,
  UploadCloud, RotateCcw, Undo2, Filter, Pencil, BarChart3, Eye, Sparkles,
  MapPinned, Map as MapIcon, ChevronRight, ShieldCheck, Database, FileWarning, Trash2, Archive, Camera,
  Globe, Layers, Info, Check, AlertCircle
} from 'lucide-react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LandOwner, LandParcel } from '../../types';

type Point = { lat: number; lng: number };

const COLORS = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#dc2626'];
const MAP_CENTER: [number, number] = [26.842, 75.789];
const AREA_TOLERANCE_HA = 0.05;

const EARTH_RADIUS_M = 6371008.8;

// Geodesic area on a spherical Earth (no screen-pixel approximation).
const polygonArea = (pts: Point[]) => {
  if (pts.length < 3) return 0;
  const ring = pts.map((p) => [p.lng * Math.PI / 180, p.lat * Math.PI / 180] as [number, number]);
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    area += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs(area * EARTH_RADIUS_M * EARTH_RADIUS_M / 2) / 10000;
};

const distanceMeters = (a: Point, b: Point) => {
  const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

const polygonPerimeter = (pts: Point[]) => {
  if (pts.length < 2) return 0;
  return pts.reduce((sum, p, i) => sum + distanceMeters(p, pts[(i + 1) % pts.length]), 0);
};

const orientation = (a: Point, b: Point, c: Point) =>
  (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);

const onSegment = (a: Point, b: Point, c: Point) =>
  Math.min(a.lng, b.lng) - 1e-10 <= c.lng && c.lng <= Math.max(a.lng, b.lng) + 1e-10 &&
  Math.min(a.lat, b.lat) - 1e-10 <= c.lat && c.lat <= Math.max(a.lat, b.lat) + 1e-10;

const segmentsIntersect = (a: Point, b: Point, c: Point, d: Point) => {
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (Math.abs(o1) < 1e-10 && onSegment(a, b, c)) ||
    (Math.abs(o2) < 1e-10 && onSegment(a, b, d)) ||
    (Math.abs(o3) < 1e-10 && onSegment(c, d, a)) ||
    (Math.abs(o4) < 1e-10 && onSegment(c, d, b));
};

const hasSelfIntersection = (pts: Point[]) => {
  if (pts.length < 4) return false;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    for (let j = i + 1; j < pts.length; j++) {
      if (j === i || (j + 1) % pts.length === i || (i + 1) % pts.length === j) continue;
      const c = pts[j], d = pts[(j + 1) % pts.length];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
};

const makeOwner = (name: string, share = 100): LandOwner => ({
  id: `parcel-owner-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  name,
  hindiName: name,
  relationType: 's/o',
  relativeName: 'Not recorded',
  relativeHindiName: 'उपलब्ध नहीं',
  shareFraction: share === 100 ? '1/1' : `${share}/100`,
  sharePercentage: share,
  status: 'Active Co-sharer',
});

const initialForm = {
  district: 'Jaipur',
  tehsil: 'Sanganer',
  village: 'Rampur',
  ownersText: '',
  khasraNo: '',
  khataNo: '',
  recordedArea: '',
  landType: 'Agricultural',
  inheritance: '',
  mutation: '',
  documentId: '',
};

const ownerNames = (p: LandParcel) =>
  (p.owners?.length ? p.owners : p.ownerName ? [makeOwner(p.ownerName)] : [])
    .map((o) => o.name);

const ownerTotal = (p: LandParcel) =>
  (p.owners || []).reduce((sum, o) => sum + o.sharePercentage, 0);

const ownerMappedArea = (p: LandParcel, share: number) =>
  p.mappedAreaHectares * (share / 100);

const isSupportedDocument = (file: File) => {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return ['pdf', 'tif', 'tiff', 'jpg', 'jpeg', 'png'].includes(extension || '') ||
    ['application/pdf', 'image/tiff', 'image/jpeg', 'image/png'].includes(file.type);
};

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export const SpatialRegistryView: React.FC = () => {
  const {
    parcels, activeParcels, documents, activeParcel, selectParcel, selectDocument, createParcel, updateParcel,
    setActiveView, addNotification, linkDocumentToParcel, archiveParcel,
  } = useApp();
  const { t, isHindi } = useTranslation();

  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const parcelLayer = useRef<L.LayerGroup | null>(null);
  const draftLayer = useRef<L.LayerGroup | null>(null);
  const modeRef = useRef<'browse' | 'draw'>('browse');

  const [query, setQuery] = useState('');
  const [landType, setLandType] = useState('All');
  const [validationFilter, setValidationFilter] = useState<'all' | 'verified' | 'needs_field' | 'discrepancy' | 'incomplete' | 'ownership_issue'>('all');
  const [issueFilter, setIssueFilter] = useState<'all' | 'discrepancy' | 'incomplete' | 'missing_document'>('all');
  const [verificationFilter, setVerificationFilter] = useState<'all' | 'verified' | 'unverified'>('all');
  const [minArea, setMinArea] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('All');
  const [villageFilter, setVillageFilter] = useState('All');
  const [mode, setMode] = useState<'browse' | 'draw'>('browse');
  const [tab, setTab] = useState<'map' | 'analytics'>('map');
  const [imageryView, setImageryView] = useState<'split' | 'historical' | 'current'>('split');
  const [draft, setDraft] = useState<Point[]>([]);
  const [draftClosed, setDraftClosed] = useState(false);
  const draftClosedRef = useRef(false);
  const [editingBoundaryId, setEditingBoundaryId] = useState<string | null>(null);
  const [maxArea, setMaxArea] = useState('');
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null);
  const [form, setForm] = useState(initialForm);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(initialForm);
  const [newDocument, setNewDocument] = useState<File | null>(null);

  const isDiscrepant = (p: LandParcel) =>
    p.recordedAreaHectares != null &&
    Math.abs(p.mappedAreaHectares - p.recordedAreaHectares) > AREA_TOLERANCE_HA;

  const hasDocument = (p: LandParcel) => Boolean(p.documentName || p.documentUri || p.documentId);
  const isIncomplete = (p: LandParcel) =>
    !ownerNames(p).length || p.khasraNo === '—' || p.khataNo === '—' || !hasDocument(p);
  const isOwnershipIssue = (p: LandParcel) => Math.abs(ownerTotal(p) - 100) > 0.01;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return activeParcels.filter((p) => {
      if (p.status === 'Archived') return false;
      const searchable = [p.id, p.ownerName, p.khasraNo, p.khataNo, p.village, p.tehsil, p.district, p.documentId, p.documentName, ...ownerNames(p)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const matchesQuery = !q || searchable.includes(q);
      const matchesType = landType === 'All' || p.landType.toLowerCase().includes(landType.toLowerCase());
      const matchesOwner = ownerFilter === 'All' || ownerNames(p).includes(ownerFilter);
      const matchesVillage = villageFilter === 'All' || (p.village || '').toLowerCase() === villageFilter.toLowerCase();
      
      const matchesValidationOverlay =
        validationFilter === 'all' ||
        (validationFilter === 'verified' && p.status === 'Verified') ||
        (validationFilter === 'needs_field' && p.status === 'Needs Field Verification') ||
        (validationFilter === 'discrepancy' && isDiscrepant(p)) ||
        (validationFilter === 'incomplete' && isIncomplete(p)) ||
        (validationFilter === 'ownership_issue' && isOwnershipIssue(p));

      const matchesIssue =
        issueFilter === 'all' ||
        (issueFilter === 'discrepancy' && isDiscrepant(p)) ||
        (issueFilter === 'incomplete' && isIncomplete(p)) ||
        (issueFilter === 'missing_document' && !hasDocument(p));
      const matchesVerification =
        verificationFilter === 'all' ||
        (verificationFilter === 'verified' && p.status === 'Verified') ||
        (verificationFilter === 'unverified' && p.status !== 'Verified');
      const matchesArea = (!minArea || p.mappedAreaHectares >= Number(minArea)) && (!maxArea || p.mappedAreaHectares <= Number(maxArea));
      return matchesQuery && matchesType && matchesOwner && matchesVillage && matchesValidationOverlay && matchesIssue && matchesVerification && matchesArea;
    });
  }, [activeParcels, query, landType, ownerFilter, villageFilter, validationFilter, issueFilter, verificationFilter, minArea, maxArea]);

  const ownerSummary = useMemo(() => {
    const map = new Map<string, number>();
    activeParcels.forEach((p) => {
      const owners = p.owners?.length ? p.owners : [makeOwner(p.ownerName)];
      owners.forEach((o) => {
        const shareArea = p.mappedAreaHectares * (o.sharePercentage / 100);
        map.set(o.name, (map.get(o.name) || 0) + shareArea);
      });
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [activeParcels]);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { draftClosedRef.current = draftClosed; }, [draftClosed]);

  const begin = () => {
    setDraft([]);
    setDraftClosed(false);
    setEditingBoundaryId(null);
    setMode('draw');
    setTab('map');
    setEditing(false);
    setNewDocument(null);
    setForm(initialForm);
  };

  // Real Leaflet + OpenStreetMap map. No paid map API key is required for this prototype.
  // A satellite imagery option is provided for visual context; it does not make boundaries official.

  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;

    const map = L.map(mapRef.current, { zoomControl: true }).setView(MAP_CENTER, 16);
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors',
    });
    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri',
    });
    osm.addTo(map);
    L.control.layers({ [isHindi ? 'सड़क मानचित्र (OSM)' : 'Street Map (OSM)']: osm, [isHindi ? 'सैटेलाइट (Esri)' : 'Satellite (Esri)']: satellite }, undefined, { position: 'topright' }).addTo(map);

    parcelLayer.current = L.layerGroup().addTo(map);
    draftLayer.current = L.layerGroup().addTo(map);

    map.on('click', (event: L.LeafletMouseEvent) => {
      if (modeRef.current !== 'draw' || draftClosedRef.current) return;
      setDraft((points) => [...points, { lat: event.latlng.lat, lng: event.latlng.lng }]);
    });

    leafletMap.current = map;
    setTimeout(() => map.invalidateSize(), 50);

    return () => {
      map.remove();
      leafletMap.current = null;
      parcelLayer.current = null;
      draftLayer.current = null;
    };
  }, []);

  useEffect(() => {
    const map = leafletMap.current;
    const layer = parcelLayer.current;
    if (!map || !layer) return;

    layer.clearLayers();

    filtered.forEach((parcel) => {
      const latLngs = parcel.boundary.map((p) => [p.lat, p.lng] as [number, number]);
      const selected = activeParcel?.id === parcel.id;
      const hasAreaIssue = isDiscrepant(parcel);
      const needsField = parcel.status === 'Needs Field Verification';
      const isVerified = parcel.status === 'Verified';
      const matchesSearch = query.trim().length > 0;

      let strokeColor = parcel.colour;
      let weight = selected ? 5 : matchesSearch ? 4 : 2.5;
      let fillOpacity = selected ? 0.45 : matchesSearch ? 0.35 : 0.22;
      let dashArray: string | undefined = undefined;

      if (validationFilter === 'discrepancy' && hasAreaIssue) {
        strokeColor = '#dc2626';
        weight = 4;
        fillOpacity = 0.45;
        dashArray = '6 3';
      } else if (validationFilter === 'needs_field' && needsField) {
        strokeColor = '#d97706';
        weight = 4;
        fillOpacity = 0.45;
      } else if (validationFilter === 'verified' && isVerified) {
        strokeColor = '#16a34a';
        weight = 3.5;
        fillOpacity = 0.40;
      } else if (validationFilter === 'incomplete' && isIncomplete(parcel)) {
        strokeColor = '#ea580c';
        weight = 4;
        dashArray = '4 4';
      } else if (validationFilter === 'ownership_issue' && isOwnershipIssue(parcel)) {
        strokeColor = '#9333ea';
        weight = 4;
      } else if (hasAreaIssue) {
        strokeColor = '#b45309';
      }

      const polygon = L.polygon(latLngs, {
        color: strokeColor,
        weight,
        fillColor: parcel.colour,
        fillOpacity,
        dashArray,
      });

      const names = ownerNames(parcel).join(', ') || (isHindi ? 'अनाम खातेदार' : 'Unassigned');
      polygon.bindTooltip(`${parcel.id}<br/>${names}<br/>${parcel.mappedAreaHectares.toFixed(2)} ${isHindi ? 'हेक्टेयर' : 'ha'}`, {
        sticky: true,
      });
      polygon.on('click', () => selectParcel(parcel.id));
      polygon.addTo(layer);
    });
  }, [filtered, activeParcel, query, validationFilter, selectParcel, isHindi]);

  useEffect(() => {
    const layer = draftLayer.current;
    if (!layer) return;
    layer.clearLayers();

    if (draft.length) {
      draft.forEach((point, index) => {
        const marker = L.marker([point.lat, point.lng], { draggable: true })
          .bindTooltip(`${isHindi ? 'बिंदु' : 'Point'} ${index + 1}`, { direction: 'top' })
          .addTo(layer);
        marker.on('dragend', (event) => {
          const next = event.target.getLatLng();
          setDraft((points) => points.map((p, i) => i === index ? { lat: next.lat, lng: next.lng } : p));
        });
        marker.on('click', () => {
          setSelectedVertex(index);
          marker.bindPopup(`<div style="font-size:12px"><b>${isHindi ? 'सीमा बिंदु' : 'Boundary Vertex'} #${index + 1}</b><br/>${isHindi ? 'स्थिति बदलने हेतु खींचें' : 'Drag to adjust vertex position'}</div>`).openPopup();
        });
      });

      if (draft.length > 1) {
        const line = draftClosed ? [...draft, draft[0]] : draft;
        L.polyline(line.map((p) => [p.lat, p.lng] as [number, number]), {
          color: '#0f172a',
          weight: 3,
        }).addTo(layer);
      }

      if (draft.length > 2) {
        L.polygon(draft.map((p) => [p.lat, p.lng] as [number, number]), {
          color: '#0f172a',
          weight: 2,
          dashArray: '5 5',
          fillOpacity: 0.08,
        }).addTo(layer);
      }
    }
  }, [draft, draftClosed, isHindi]);

  useEffect(() => {
    const map = leafletMap.current;
    if (map) {
      setTimeout(() => {
        map.invalidateSize();
        if (activeParcel && (mode === 'browse' || editingBoundaryId)) {
          const pts = activeParcel.boundary.map((p) => [p.lat, p.lng] as [number, number]);
          if (pts.length >= 3) map.fitBounds(L.latLngBounds(pts).pad(0.2), { animate: false });
        }
      }, 80);
    }
  }, [tab, mode, activeParcel, editingBoundaryId]);

  const parseOwners = (text: string): LandOwner[] => {
    const entries = text.split(',').map((item) => item.trim()).filter(Boolean);
    if (!entries.length) return [];
    const explicit = entries.map((entry) => {
      const match = entry.match(/^(.*?)(?:\s*:\s*(\d+(?:\.\d+)?)%)?$/);
      return { name: (match?.[1] || entry).trim(), share: match?.[2] ? Number(match[2]) : undefined };
    });
    const unspecified = explicit.filter((o) => o.share == null).length;
    const explicitTotal = explicit.reduce((sum, o) => sum + (o.share ?? 0), 0);
    const fallback = unspecified && explicitTotal <= 100
      ? Number(((100 - explicitTotal) / unspecified).toFixed(2))
      : 0;
    let assigned = 0;
    return explicit.map((o, index) => {
      const share = o.share != null ? o.share : (index === explicit.length - 1 ? Math.max(0, Number((100 - assigned).toFixed(2))) : fallback);
      assigned += share;
      return makeOwner(o.name, share);
    });
  };

  const save = async () => {
    if (draft.length < 3 || !draftClosed) {
      addNotification(t.notifications.boundaryIncompleteTitle, draft.length < 3 ? t.notifications.boundaryIncompleteMinPoints : t.notifications.boundaryIncompleteClosePolygon, 'warning');
      return;
    }
    if (hasSelfIntersection(draft)) {
      addNotification(t.notifications.invalidBoundaryTitle, t.notifications.invalidBoundarySelfIntersect, 'error');
      return;
    }

    if (editingBoundaryId) {
      if (!draftClosed) {
        addNotification(t.notifications.boundaryNotClosedTitle, t.notifications.boundaryNotClosedMsg, 'warning');
        return;
      }
      updateParcel(editingBoundaryId, {
        boundary: draft,
        mappedAreaHectares: Number(polygonArea(draft).toFixed(3)),
        status: 'Needs Field Verification',
        verificationNotes: isHindi ? 'सीमा ज्यामिति संशोधित की गई; पुनः क्षेत्र सत्यापन आवश्यक है।' : 'Boundary geometry edited; field verification is required again.',
      });
      setMode('browse');
      setDraft([]);
      setDraftClosed(false);
      setEditingBoundaryId(null);
      addNotification(t.notifications.parcelBoundaryUpdatedTitle, t.notifications.parcelBoundaryUpdatedMsg, 'warning');
      return;
    }

    const selectedDoc = documents.find((d) => d.id === form.documentId);
    const area = Number(polygonArea(draft).toFixed(3));
    if (!Number.isFinite(area) || area <= 0) {
      addNotification(t.notifications.invalidMappedAreaTitle, t.notifications.invalidMappedAreaMsg, 'error');
      return;
    }
    if (form.recordedArea && (!Number.isFinite(Number(form.recordedArea)) || Number(form.recordedArea) < 0)) {
      addNotification(t.notifications.invalidRecordedAreaTitle, t.notifications.invalidRecordedAreaMsg, 'warning');
      return;
    }
    let documentUri: string | undefined;

    if (newDocument) {
      documentUri = await fileToDataUrl(newDocument);
    }

    const owners = parseOwners(form.ownersText);
    if (!owners.length) {
      addNotification(t.notifications.ownerRequiredTitle, t.notifications.ownerRequiredMsg, 'warning');
      return;
    }
    if (!form.khasraNo.trim() || !form.khataNo.trim()) {
      addNotification(t.notifications.recordIdentifiersRequiredTitle, t.notifications.recordIdentifiersRequiredMsg, 'warning');
      return;
    }
    const invalidOwnerShare = owners.some((owner) => !Number.isFinite(owner.sharePercentage) || owner.sharePercentage <= 0 || owner.sharePercentage > 100);
    if (invalidOwnerShare) {
      addNotification(t.notifications.invalidOwnershipShareTitle, t.notifications.invalidOwnershipShareMsg, 'error');
      return;
    }
    if (owners.length && Math.abs(ownerTotal({ owners } as LandParcel) - 100) > 0.005) {
      addNotification(t.notifications.ownershipSharesIncompleteTitle, t.notifications.ownershipSharesIncompleteMsg, 'warning');
      return;
    }
    const parcel = createParcel({
      boundary: draft,
      district: form.district,
      tehsil: form.tehsil,
      village: form.village,
      mappedAreaHectares: area,
      colour: COLORS[parcels.length % COLORS.length],
      ownerName: owners[0]?.name || (isHindi ? 'अनाम खातेदार' : 'Unassigned'),
      owners,
      khasraNo: form.khasraNo || '—',
      khataNo: form.khataNo || '—',
      recordedAreaHectares: form.recordedArea ? Number(form.recordedArea) : undefined,
      landType: form.landType,
      inheritance: form.inheritance || (isHindi ? 'विवरण उपलब्ध नहीं' : 'Not recorded'),
      mutationHistory: form.mutation
        ? [{ date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), type: isHindi ? 'मैनुअल प्रविष्टि' : 'Manual entry', note: form.mutation }]
        : [],
      documentId: form.documentId || undefined,
      documentName: newDocument?.name || selectedDoc?.fileName,
      documentType: newDocument ? (newDocument.type || (isHindi ? 'अपलोड किया गया दस्तावेज़' : 'Uploaded document')) : selectedDoc?.recordType,
      documentUploadedAt: newDocument ? new Date().toLocaleString() : selectedDoc?.uploadedAt,
      documentDisplayId: newDocument ? `LOCAL-DOC-${Date.now().toString().slice(-6)}` : selectedDoc?.id,
      documentUri,
      status: 'Mapped',
      ulpinStatus: 'Pending Government Linkage',
      imageryComparison: {
        historicalYear: 2019,
        currentYear: 2026,
        observedChange: 'Provisional boundary recorded; visual review recommended upon field visit.',
        status: 'Normal',
        notes: 'Demo reference imagery baseline initialized.',
      },
    });

    if (form.documentId) linkDocumentToParcel(form.documentId, parcel.id);
    setMode('browse');
    setDraft([]);
    setDraftClosed(false);
    setEditingBoundaryId(null);
    setForm(initialForm);
    setNewDocument(null);
    selectParcel(parcel.id);
  };

  const startEdit = () => {
    if (!activeParcel) return;
    setEditForm({
      district: activeParcel.district || 'Jaipur',
      tehsil: activeParcel.tehsil || 'Sanganer',
      village: activeParcel.village || 'Rampur',
      ownersText: (activeParcel.owners?.length
        ? activeParcel.owners.map((owner) => `${owner.name} : ${owner.sharePercentage}%`).join(', ')
        : ownerNames(activeParcel).join(', ')),
      khasraNo: activeParcel.khasraNo,
      khataNo: activeParcel.khataNo,
      recordedArea: activeParcel.recordedAreaHectares?.toString() || '',
      landType: activeParcel.landType,
      inheritance: activeParcel.inheritance,
      mutation: (activeParcel.mutationHistory ?? []).map((m) => `${m.date}: ${m.note}`).join('\n'),
      documentId: activeParcel.documentId || '',
    });
    setEditing(true);
  };

  const saveEdit = () => {
    if (!activeParcel) return;
    const selectedDoc = documents.find((d) => d.id === editForm.documentId);
    const owners = parseOwners(editForm.ownersText);
    if (!owners.length) {
      addNotification(t.notifications.ownerRequiredTitle, t.notifications.ownerRequiredMsg, 'warning');
      return;
    }
    if (!editForm.khasraNo.trim() || !editForm.khataNo.trim()) {
      addNotification(t.notifications.recordIdentifiersRequiredTitle, t.notifications.recordIdentifiersRequiredMsg, 'warning');
      return;
    }
    const invalidOwnerShare = owners.some((owner) => !Number.isFinite(owner.sharePercentage) || owner.sharePercentage <= 0 || owner.sharePercentage > 100);
    if (invalidOwnerShare) {
      addNotification(t.notifications.invalidOwnershipShareTitle, t.notifications.invalidOwnershipShareMsg, 'error');
      return;
    }
    if (owners.length && Math.abs(ownerTotal({ owners } as LandParcel) - 100) > 0.005) {
      addNotification(t.notifications.ownershipSharesIncompleteTitle, t.notifications.ownershipSharesIncompleteMsg, 'warning');
      return;
    }
    if (editForm.recordedArea.trim() !== '') {
      const recorded = Number(editForm.recordedArea);
      if (!Number.isFinite(recorded) || recorded < 0) {
        addNotification(t.notifications.invalidRecordedAreaTitle, t.notifications.invalidRecordedAreaMsg, 'warning');
        return;
      }
    }
    updateParcel(activeParcel.id, {
      // district is intentionally absent: it is the parcel's jurisdiction, and the server refuses to
      // move a record between districts through an ordinary attribute patch.
      tehsil: editForm.tehsil,
      village: editForm.village,
      ownerName: owners[0]?.name || (isHindi ? 'अनाम खातेदार' : 'Unassigned Owner'),
      owners,
      khasraNo: editForm.khasraNo || '—',
      khataNo: editForm.khataNo || '—',
      recordedAreaHectares: editForm.recordedArea ? Number(editForm.recordedArea) : undefined,
      landType: editForm.landType,
      inheritance: editForm.inheritance || (isHindi ? 'विवरण उपलब्ध नहीं' : 'Not recorded'),
      mutationHistory: editForm.mutation.trim()
        ? editForm.mutation.split('\n').map((entry) => {
            const parts = entry.split(':');
            return { date: parts.length > 1 ? parts[0].trim() : new Date().toLocaleDateString('en-IN'), type: isHindi ? 'अभिलेख अद्यतन' : 'Record update', note: parts.length > 1 ? parts.slice(1).join(':').trim() : entry.trim() };
          })
        : (activeParcel.mutationHistory ?? []),
      documentId: editForm.documentId || activeParcel.documentId,
      documentName: selectedDoc?.fileName || activeParcel.documentName,
      documentType: selectedDoc?.recordType || activeParcel.documentType,
      documentUploadedAt: selectedDoc?.uploadedAt || activeParcel.documentUploadedAt,
      documentDisplayId: selectedDoc?.id || activeParcel.documentDisplayId,
      status: activeParcel.status,
    });
    if (editForm.documentId) linkDocumentToParcel(editForm.documentId, activeParcel.id);
    setEditing(false);
    addNotification(t.notifications.parcelRecordUpdatedTitle, t.notifications.parcelRecordUpdatedMsg(activeParcel.id), 'success');
  };

  const handleDirectUpload = async (file: File | null, forEdit = false) => {
    if (!file) return;
    if (!isSupportedDocument(file)) {
      addNotification(t.notifications.unsupportedDocTypeTitle, t.notifications.unsupportedDocTypeMsg, 'warning');
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      addNotification(t.notifications.demoStorageLimitTitle, t.notifications.demoStorageLimitMsg, 'warning');
      return;
    }
    let uri: string;
    try {
      uri = await fileToDataUrl(file);
    } catch {
      addNotification(t.notifications.docUploadFailedTitle, t.notifications.docUploadFailedMsg, 'error');
      return;
    }
    if (forEdit && activeParcel) {
      updateParcel(activeParcel.id, { documentName: file.name, documentType: file.type || (isHindi ? 'अपलोड किया गया दस्तावेज़' : 'Uploaded document'), documentUploadedAt: new Date().toLocaleString(), documentDisplayId: `LOCAL-DOC-${Date.now().toString().slice(-6)}`, documentUri: uri });
      addNotification(t.notifications.originalDocLinkedTitle, t.notifications.originalDocLinkedMsg(file.name, activeParcel.id), 'success');
    } else {
      setNewDocument(file);
    }
  };

  const activeDoc = activeParcel?.documentId
    ? documents.find((d) => d.id === activeParcel.documentId)
    : undefined;
  const discrepancy = activeParcel ? isDiscrepant(activeParcel) : false;
  const incomplete = activeParcel ? isIncomplete(activeParcel) : false;
  const mappedTotal = activeParcels.reduce((sum, p) => sum + p.mappedAreaHectares, 0);
  const markForFieldVerification = () => {
    if (!activeParcel) return;
    updateParcel(activeParcel.id, { status: 'Needs Field Verification' });
    addNotification(t.notifications.fieldVerifRequestedTitle, t.notifications.fieldVerifRequestedMsg(activeParcel.id), 'warning');
  };

  const focusFiltered = () => {
    if (!filtered.length || !leafletMap.current) return;
    const bounds = L.latLngBounds(filtered.flatMap((p) => p.boundary.map((q) => [q.lat, q.lng] as [number, number])));
    leafletMap.current.fitBounds(bounds.pad(0.12));
    setTab('map');
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2 text-[10px] text-blue-700 font-mono font-bold">
            <span>{t.spatial.title.toUpperCase()}</span><span>•</span><span>{t.spatial.workspaceTag}</span>
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mt-1">{t.spatial.title}</h2>
          <p className="text-xs text-slate-500 mt-1">{t.spatial.subtitle}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setTab(tab === 'map' ? 'analytics' : 'map')} className="inline-flex items-center gap-2 border border-slate-300 bg-white text-slate-700 px-4 py-2.5 rounded-lg text-xs font-semibold cursor-pointer hover:bg-slate-50">
            {tab === 'map' ? <BarChart3 className="w-4 h-4" /> : <MapPinned className="w-4 h-4" />}
            {tab === 'map' ? t.spatial.landAnalyticsBtn : t.spatial.backToMapBtn}
          </button>
          <button onClick={begin} className="inline-flex items-center gap-2 bg-slate-900 text-white px-4 py-2.5 rounded-lg text-xs font-semibold hover:bg-slate-800 cursor-pointer">
            <Plus className="w-4 h-4" /> {t.spatial.createParcelBtn}
          </button>
        </div>
      </div>

      <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono font-bold text-slate-600">
          <span className="px-2 py-1 rounded bg-white border border-slate-200">{t.spatial.lifecycleDraft}</span><span>→</span>
          <span className="px-2 py-1 rounded bg-white border border-slate-200">{t.spatial.lifecycleMapped}</span><span>→</span>
          <span className="px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-800">{t.spatial.lifecycleNeedsField}</span><span>→</span>
          <span className="px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-800">{t.spatial.lifecycleVerified}</span>
        </div>
        <div className="text-[10px] text-slate-500 mt-1.5">{t.spatial.lifecycleNotice}</div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          [t.spatial.mappedParcelsMetric, activeParcels.length],
          [t.spatial.mappedAreaMetric, `${mappedTotal.toFixed(2)} ${isHindi ? 'हेक्टेयर' : 'ha'}`],
          [t.spatial.needsFieldMetric, activeParcels.filter((p) => p.status === 'Needs Field Verification').length],
          [t.spatial.areaMismatchMetric, activeParcels.filter(isDiscrepant).length],
          [t.spatial.incompleteRecordsMetric, activeParcels.filter(isIncomplete).length],
        ].map(([label, value]) => (
          <button key={String(label)} onClick={() => {
            if (label === t.spatial.areaMismatchMetric) setValidationFilter('discrepancy');
            else if (label === t.spatial.incompleteRecordsMetric) setValidationFilter('incomplete');
            else if (label === t.spatial.needsFieldMetric) setValidationFilter('needs_field');
            else setValidationFilter('all');
            setTab('map');
          }} className="text-left bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-300 cursor-pointer">
            <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono">{label}</div>
            <div className="text-xl font-bold text-slate-900 mt-1">{value}</div>
          </button>
        ))}
      </div>

      {tab === 'analytics' ? (
        <div className="grid lg:grid-cols-[1.1fr_.9fr] gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center gap-2"><Database className="w-4 h-4 text-blue-700" /><div><div className="text-sm font-bold">{t.spatial.askTheRegistry}</div><div className="text-xs text-slate-500 mt-1">{t.spatial.askTheRegistrySubtitle}</div></div></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
              {[
                [t.spatial.queryHarishLand, () => { setQuery(''); setOwnerFilter('Harish Chandra Verma'); setValidationFilter('all'); setIssueFilter('all'); setVerificationFilter('all'); setMinArea(''); setVillageFilter('All'); }],
                [t.spatial.queryAgriAbove2Ha, () => { setLandType('Agricultural'); setMinArea('2'); setQuery(''); setValidationFilter('all'); setIssueFilter('all'); setVerificationFilter('all'); }],
                [t.spatial.queryAreaMismatch, () => { setValidationFilter('discrepancy'); setIssueFilter('discrepancy'); setQuery(''); setMinArea(''); setVerificationFilter('all'); }],
                [t.spatial.queryMissingDocs, () => { setValidationFilter('incomplete'); setIssueFilter('missing_document'); setQuery(''); setMinArea(''); setVerificationFilter('all'); }],
                [t.spatial.queryRampurParcels, () => { setQuery('Rampur'); setValidationFilter('all'); setIssueFilter('all'); setMinArea(''); setVerificationFilter('all'); }],
              ].map(([label, action]) => <button key={String(label)} onClick={action as () => void} className="text-left border border-slate-200 rounded-lg px-3 py-2 text-xs font-semibold hover:bg-slate-50 cursor-pointer">{String(label)}</button>)}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold">{t.spatial.landAnalyticsBtn}</div>
                <div className="text-xs text-slate-500 mt-1">{t.spatial.coSharerApportionment}</div>
              </div>
              <button onClick={focusFiltered} className="text-xs font-semibold text-blue-700 flex items-center gap-1 cursor-pointer">{t.spatial.showFilteredParcels} <ChevronRight className="w-3.5 h-3.5" /></button>
            </div>
            <div className="mt-5 space-y-2">
              {ownerSummary.length ? ownerSummary.map(([owner, area], index) => (
                <button key={owner} onClick={() => { setQuery(owner); setTab('map'); }} className="w-full flex items-center justify-between p-3 rounded-lg bg-slate-50 hover:bg-slate-100 text-left cursor-pointer">
                  <span className="text-xs font-semibold text-slate-800">{index + 1}. {owner}</span>
                  <span className="text-xs font-mono font-bold">{area.toFixed(2)} {isHindi ? 'हेक्टेयर' : 'ha'}</span>
                </button>
              )) : <div className="text-xs text-slate-500">{t.spatial.noOwnerData}</div>}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-sm font-bold">{t.spatial.villageWiseArea}</div>
            <div className="text-xs text-slate-500 mt-1">{t.spatial.villageWiseSubtitle}</div>
            <div className="mt-4 space-y-2">
              {Array.from(activeParcels.reduce((map, p) => map.set(p.village || (isHindi ? 'अज्ञात' : 'Unknown'), (map.get(p.village || (isHindi ? 'अज्ञात' : 'Unknown')) || 0) + p.mappedAreaHectares), new Map<string, number>()).entries())
                .sort((a, b) => b[1] - a[1])
                .map(([village, area]) => <button key={village} onClick={() => { setVillageFilter(village); setTab('map'); }} className="w-full flex items-center justify-between p-3 rounded-lg bg-slate-50 hover:bg-slate-100 text-left cursor-pointer"><span className="text-xs font-semibold">{village}</span><span className="text-xs font-mono font-bold">{area.toFixed(2)} {isHindi ? 'हेक्टेयर' : 'ha'}</span></button>)}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-sm font-bold">{t.spatial.analysisFilters}</div>
            <div className="grid grid-cols-2 gap-2 mt-4">
              <select value={landType} onChange={(e) => setLandType(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2 text-xs">
                <option value="All">{t.spatial.allOption}</option>
                <option value="Agricultural">{t.spatial.landTypeAgri}</option>
                <option value="Chahi">{t.spatial.landTypeChahi}</option>
                <option value="Barani">{t.spatial.landTypeBarani}</option>
                <option value="Gair Mumkin">{t.spatial.landTypeGairMumkin}</option>
              </select>
              <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} className="max-w-[150px] border border-slate-200 rounded-lg px-3 py-2 text-xs">
                <option value="All">{t.spatial.allOption}</option>{Array.from(new Set(activeParcels.flatMap((p) => ownerNames(p)))).sort().map((owner) => <option key={owner} value={owner}>{owner}</option>)}
              </select>
              <select value={villageFilter} onChange={(e) => setVillageFilter(e.target.value)} className="max-w-[130px] border border-slate-200 rounded-lg px-3 py-2 text-xs">
                <option value="All">{t.spatial.allOption}</option>{Array.from(new Set(activeParcels.map((p) => p.village).filter(Boolean) as string[])).sort().map((village) => <option key={village} value={village}>{village}</option>)}
              </select>
              <select value={issueFilter} onChange={(e) => setIssueFilter(e.target.value as typeof issueFilter)} className="border border-slate-200 rounded-lg px-3 py-2 text-xs">
                <option value="all">{t.spatial.issueAll}</option><option value="discrepancy">{t.spatial.issueDiscrepancy}</option><option value="incomplete">{t.spatial.issueIncomplete}</option><option value="missing_document">{t.spatial.issueMissingDoc}</option>
              </select>
              <select value={verificationFilter} onChange={(e) => setVerificationFilter(e.target.value as typeof verificationFilter)} className="border border-slate-200 rounded-lg px-3 py-2 text-xs">
                <option value="all">{t.spatial.verificationAll}</option><option value="verified">{t.spatial.verificationVerified}</option><option value="unverified">{t.spatial.verificationUnverified}</option>
              </select><input type="number" min="0" step="0.1" value={minArea} onChange={(e) => setMinArea(e.target.value)} placeholder={t.spatial.minAreaPlaceholder} className="w-28 border border-slate-200 rounded-lg px-3 py-2 text-xs" /><input type="number" min="0" step="0.1" value={maxArea} onChange={(e) => setMaxArea(e.target.value)} placeholder={t.spatial.maxAreaPlaceholder} className="w-28 border border-slate-200 rounded-lg px-3 py-2 text-xs" /><button onClick={() => { setQuery(''); setLandType('All'); setValidationFilter('all'); setIssueFilter('all'); setVerificationFilter('all'); setMinArea(''); setMaxArea(''); setOwnerFilter('All'); setVillageFilter('All'); }} className="text-xs font-semibold text-slate-500 hover:text-slate-900 px-2 cursor-pointer">{t.spatial.clearFilter}</button>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-4">
              <div className="p-3 rounded-lg border border-slate-200"><div className="text-[10px] text-slate-400">{t.spatial.filteredParcels}</div><div className="text-xl font-bold">{filtered.length}</div></div>
              <div className="p-3 rounded-lg border border-slate-200"><div className="text-[10px] text-slate-400">{t.spatial.filteredArea}</div><div className="text-xl font-bold">{filtered.reduce((s, p) => s + p.mappedAreaHectares, 0).toFixed(2)} {isHindi ? 'हेक्टेयर' : 'ha'}</div></div>
              <div className="p-3 rounded-lg border border-slate-200"><div className="text-[10px] text-slate-400">{t.spatial.withDocuments}</div><div className="text-xl font-bold">{filtered.filter((p) => p.documentName || p.documentUri || p.documentId).length}</div></div>
              <div className="p-3 rounded-lg border border-slate-200"><div className="text-[10px] text-slate-400">{t.spatial.coOwnerSharesChecked}</div><div className="text-xl font-bold">{filtered.filter((p) => Math.abs(ownerTotal(p) - 100) < 0.01).length}</div></div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[1fr_420px] gap-4">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <div className="p-3.5 border-b border-slate-200 bg-slate-50/70 space-y-2.5">
              {/* Top Search & Filter Strip */}
              <div className="flex flex-wrap gap-2 items-center">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t.spatial.searchPlaceholder}
                    className="w-full bg-white border border-slate-200 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
                  />
                </div>
                <select
                  value={landType}
                  onChange={(e) => setLandType(e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 shadow-2xs cursor-pointer focus:outline-none focus:border-blue-500"
                >
                  <option value="All">{t.spatial.allOption}</option>
                  <option value="Agricultural">{t.spatial.landTypeAgri}</option>
                  <option value="Chahi">{t.spatial.landTypeChahi}</option>
                  <option value="Barani">{t.spatial.landTypeBarani}</option>
                  <option value="Gair Mumkin">{t.spatial.landTypeGairMumkin}</option>
                </select>
                <select
                  value={ownerFilter}
                  onChange={(e) => setOwnerFilter(e.target.value)}
                  className="max-w-[140px] bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 shadow-2xs cursor-pointer focus:outline-none focus:border-blue-500"
                >
                  <option value="All">{t.spatial.allOption}</option>
                  {Array.from(new Set(activeParcels.flatMap((p) => ownerNames(p))))
                    .sort()
                    .map((owner) => (
                      <option key={owner} value={owner}>
                        {owner}
                      </option>
                    ))}
                </select>
                <select
                  value={villageFilter}
                  onChange={(e) => setVillageFilter(e.target.value)}
                  className="max-w-[120px] bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 shadow-2xs cursor-pointer focus:outline-none focus:border-blue-500"
                >
                  <option value="All">{t.spatial.allOption}</option>
                  {Array.from(new Set(activeParcels.map((p) => p.village).filter(Boolean) as string[]))
                    .sort()
                    .map((village) => (
                      <option key={village} value={village}>
                        {village}
                      </option>
                    ))}
                </select>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={minArea}
                    onChange={(e) => setMinArea(e.target.value)}
                    placeholder={t.spatial.minAreaPlaceholder}
                    className="w-20 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 shadow-2xs outline-none focus:border-blue-500"
                  />
                  <span className="text-slate-400 text-xs">-</span>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={maxArea}
                    onChange={(e) => setMaxArea(e.target.value)}
                    placeholder={t.spatial.maxAreaPlaceholder}
                    className="w-20 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 shadow-2xs outline-none focus:border-blue-500"
                  />
                </div>
                {(query || landType !== 'All' || ownerFilter !== 'All' || villageFilter !== 'All' || validationFilter !== 'all' || issueFilter !== 'all' || verificationFilter !== 'all' || minArea || maxArea) && (
                  <button
                    onClick={() => {
                      setQuery('');
                      setLandType('All');
                      setValidationFilter('all');
                      setIssueFilter('all');
                      setVerificationFilter('all');
                      setMinArea('');
                      setMaxArea('');
                      setOwnerFilter('All');
                      setVillageFilter('All');
                    }}
                    className="text-xs font-semibold text-rose-600 hover:text-rose-700 px-2 py-1 bg-rose-50 border border-rose-200 rounded-lg transition-colors cursor-pointer"
                  >
                    {t.spatial.clearFilter}
                  </button>
                )}
              </div>

              {/* Phase 3B: Interactive Validation Quick-Filter Chips */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-[10px] font-mono uppercase text-slate-400 font-bold mr-1">
                  {t.spatial.validationFilterTitle}:
                </span>
                {[
                  { id: 'all', label: t.spatial.mapFilterAll, count: activeParcels.length, color: 'slate' },
                  { id: 'verified', label: t.spatial.mapFilterVerified, count: activeParcels.filter(p => p.status === 'Verified').length, color: 'emerald' },
                  { id: 'needs_field', label: t.spatial.mapFilterNeedsField, count: activeParcels.filter(p => p.status === 'Needs Field Verification').length, color: 'amber' },
                  { id: 'discrepancy', label: t.spatial.mapFilterAreaMismatch, count: activeParcels.filter(isDiscrepant).length, color: 'rose' },
                  { id: 'incomplete', label: t.spatial.mapFilterMissingData, count: activeParcels.filter(isIncomplete).length, color: 'orange' },
                  { id: 'ownership_issue', label: t.spatial.mapFilterOwnership, count: activeParcels.filter(isOwnershipIssue).length, color: 'purple' },
                ].map(pill => {
                  const isActive = validationFilter === pill.id;
                  return (
                    <button
                      key={pill.id}
                      onClick={() => setValidationFilter(pill.id as typeof validationFilter)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all cursor-pointer border ${
                        isActive
                          ? pill.color === 'emerald'
                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-2xs'
                            : pill.color === 'amber'
                            ? 'bg-amber-600 text-white border-amber-600 shadow-2xs'
                            : pill.color === 'rose'
                            ? 'bg-rose-600 text-white border-rose-600 shadow-2xs'
                            : pill.color === 'orange'
                            ? 'bg-orange-600 text-white border-orange-600 shadow-2xs'
                            : pill.color === 'purple'
                            ? 'bg-purple-600 text-white border-purple-600 shadow-2xs'
                            : 'bg-slate-900 text-white border-slate-900 shadow-2xs'
                          : 'bg-white hover:bg-slate-100 text-slate-700 border-slate-200 shadow-2xs'
                      }`}
                    >
                      <span>{pill.label}</span>
                      <span className={`text-[10px] font-mono px-1 rounded-full ${
                        isActive ? 'bg-black/20 text-white' : 'bg-slate-100 text-slate-600'
                      }`}>
                        {pill.count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Task 10: Interactive Search Results Strip */}
              {filtered.length > 0 && (
                <div className="pt-2 border-t border-slate-200/80">
                  <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1.5 font-medium">
                    <span className="font-semibold text-slate-700">{t.spatial.searchResultsTitle(filtered.length)}</span>
                    <span className="text-[10px] text-slate-400">{t.spatial.clickToInspect}</span>
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1.5 scrollbar-thin">
                    {filtered.map((p) => {
                      const isSelected = activeParcel?.id === p.id;
                      const hasAreaIssue = isDiscrepant(p);
                      return (
                        <button
                          key={p.id}
                          onClick={() => {
                            selectParcel(p.id);
                            const map = leafletMap.current;
                            if (map && p.boundary?.length >= 3) {
                              const pts = p.boundary.map((pt) => [pt.lat, pt.lng] as [number, number]);
                              map.fitBounds(L.latLngBounds(pts).pad(0.25), { animate: true });
                            }
                          }}
                          className={`shrink-0 text-left p-2.5 rounded-lg border transition-all cursor-pointer min-w-[200px] max-w-[240px] shadow-2xs ${
                            isSelected
                              ? 'bg-blue-50/80 border-blue-500 ring-1 ring-blue-500'
                              : 'bg-white hover:bg-slate-50 border-slate-200'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="font-mono font-bold text-xs text-slate-900 truncate">{p.id}</span>
                            <span
                              className={`text-[9px] font-mono px-1.5 py-0.5 rounded font-semibold shrink-0 ${
                                p.status === 'Verified'
                                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                                  : p.status === 'Needs Field Verification'
                                  ? 'bg-amber-50 text-amber-800 border border-amber-200'
                                  : 'bg-slate-100 text-slate-700 border border-slate-200'
                              }`}
                            >
                              {p.status === 'Verified' ? (isHindi ? 'सत्यापित' : 'Verified') : p.status === 'Needs Field Verification' ? (isHindi ? 'मौका सत्यापन' : 'Needs Field') : p.status}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-700 font-semibold truncate mt-1">
                            {ownerNames(p).join(', ') || (isHindi ? 'अनाम खातेदार' : 'Unassigned')}
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-slate-500 mt-1 font-mono">
                            <span>Kh. {p.khasraNo} • {p.village}</span>
                            <span className={hasAreaIssue ? 'text-amber-700 font-bold' : 'font-semibold'}>
                              {p.mappedAreaHectares.toFixed(2)} ha
                            </span>
                          </div>
                          {hasAreaIssue && (
                            <div className="mt-1 flex items-center gap-1 text-[9px] text-amber-700 font-bold bg-amber-50 px-1 py-0.5 rounded">
                              <AlertTriangle className="w-3 h-3 shrink-0" />
                              <span>{isHindi ? `रकबा अंतर: ${(Math.abs(p.mappedAreaHectares - (p.recordedAreaHectares ?? 0))).toFixed(2)} हे.` : `Area Delta: ${Math.abs(p.mappedAreaHectares - (p.recordedAreaHectares ?? 0)).toFixed(2)} ha`}</span>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Drawing Toolbar Sub-bar when in draw mode */}
              {mode === 'draw' && (
                <div className="flex items-center justify-between bg-blue-50/80 border border-blue-200/80 rounded-lg px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
                    <span className="font-bold text-blue-950 font-mono">
                      {editingBoundaryId ? t.spatial.editParcelBoundary : t.spatial.createParcelRecord}
                    </span>
                    <span className="text-slate-300">|</span>
                    <span className="text-[11px] text-blue-800 font-medium">
                      {t.spatial.drawingHudPoints(
                        draft.length,
                        draft.length >= 3 ? polygonArea(draft).toFixed(3) : '0.000',
                        draftClosed && draft.length >= 3 ? String(Math.round(polygonPerimeter(draft))) : '—'
                      )}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setDraft((d) => d.slice(0, -1))}
                      disabled={!draft.length}
                      className="p-1.5 bg-white border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors shadow-2xs cursor-pointer"
                      title={t.spatial.undoPoint}
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        setDraft([]);
                        setDraftClosed(false);
                        setSelectedVertex(null);
                      }}
                      className="p-1.5 bg-white border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 transition-colors shadow-2xs cursor-pointer"
                      title={t.spatial.clearBoundary}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        if (selectedVertex != null) {
                          setDraft((points) => points.filter((_, i) => i !== selectedVertex));
                          setSelectedVertex(null);
                          setDraftClosed(false);
                        }
                      }}
                      disabled={selectedVertex == null}
                      className="p-1.5 bg-white border border-slate-200 rounded-lg text-rose-700 hover:bg-rose-50 disabled:opacity-40 transition-colors shadow-2xs cursor-pointer"
                      title={t.spatial.deleteVertex}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        if (draft.length < 3) return;
                        if (!draftClosed && hasSelfIntersection(draft)) {
                          addNotification(t.notifications.invalidBoundaryTitle, t.notifications.invalidBoundarySelfIntersect, 'error');
                          return;
                        }
                        setDraftClosed((v) => !v);
                        setSelectedVertex(null);
                      }}
                      disabled={draft.length < 3}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all shadow-2xs cursor-pointer ${
                        draftClosed
                          ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                          : 'bg-white border border-blue-300 text-blue-900 hover:bg-blue-50'
                      }`}
                    >
                      {draftClosed ? t.spatial.reopenBoundary : t.spatial.closePolygon}
                    </button>
                    <button
                      onClick={() => {
                        setMode('browse');
                        setDraft([]);
                        setDraftClosed(false);
                        setEditingBoundaryId(null);
                      }}
                      className="p-1.5 bg-white border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors shadow-2xs cursor-pointer"
                      title={t.spatial.cancelDrawing}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              <div ref={mapRef} className={`h-[580px] w-full ${mode === 'draw' ? 'cursor-crosshair' : ''}`} />
              <div className="absolute left-4 bottom-4 z-[500] bg-white/95 border border-slate-200 rounded-lg px-3 py-2 text-[10px] shadow-sm">
                <div className="font-bold text-slate-700">{t.spatial.liveMapBadge}</div>
                <div className="text-slate-500 mt-0.5">{t.spatial.liveMapBasemapNotice}</div>
              </div>
              {mode === 'draw' && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[500] bg-slate-900 text-white px-4 py-2 rounded-full text-xs font-semibold shadow-lg">
                  {t.spatial.drawingHudPoints(draft.length, draft.length >= 3 ? polygonArea(draft).toFixed(3) : '0.000', draftClosed && draft.length >= 3 ? String(Math.round(polygonPerimeter(draft))) : '—')}
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Parcel-First Inspector & Actions */}
          <div className="space-y-4">
            {mode === 'draw' ? (
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="text-sm font-bold">{editingBoundaryId ? t.spatial.editParcelBoundary : t.spatial.createParcelRecord}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{t.spatial.drawingHudPoints(draft.length, draft.length >= 3 ? polygonArea(draft).toFixed(3) : '0.000', draftClosed && draft.length >= 3 ? String(Math.round(polygonPerimeter(draft))) : '—')}</div>
                  </div>
                  <button onClick={() => { setMode('browse'); setDraft([]); setDraftClosed(false); setEditingBoundaryId(null); }} className="text-slate-400 cursor-pointer"><X className="w-4 h-4" /></button>
                </div>

                {editingBoundaryId ? (
                  <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                    {t.spatial.boundaryEditingNotice}
                  </div>
                ) : null}
                <div className="space-y-2 mt-4">
                  <div className="grid grid-cols-3 gap-2">
                    <input value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} placeholder={t.spatial.districtPlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                    <input value={form.tehsil} onChange={(e) => setForm({ ...form, tehsil: e.target.value })} placeholder={t.spatial.tehsilPlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                    <input value={form.village} onChange={(e) => setForm({ ...form, village: e.target.value })} placeholder={t.spatial.villagePlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                  </div>
                  <input value={form.ownersText} onChange={(e) => setForm({ ...form, ownersText: e.target.value })} placeholder={t.spatial.ownersInputPlaceholder} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                  <div className="text-[10px] text-slate-400">{t.spatial.ownersInputHelp}</div>
                  <div className={`text-[10px] font-semibold mt-1 ${(() => { const total = parseOwners(form.ownersText).reduce((s, o) => s + o.sharePercentage, 0); return form.ownersText && Math.abs(total - 100) > 0.005 ? "text-rose-600" : "text-emerald-700"; })()}`}>
                    {t.spatial.ownershipTotalLabel} {form.ownersText ? parseOwners(form.ownersText).reduce((s, o) => s + o.sharePercentage, 0).toFixed(2) : "0.00"}% {form.ownersText && Math.abs(parseOwners(form.ownersText).reduce((s, o) => s + o.sharePercentage, 0) - 100) > 0.005 ? (isHindi ? "• 100% होना आवश्यक" : "• must equal 100%") : ""}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={form.khasraNo} onChange={(e) => setForm({ ...form, khasraNo: e.target.value })} placeholder={t.spatial.khasraPlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                    <input value={form.khataNo} onChange={(e) => setForm({ ...form, khataNo: e.target.value })} placeholder={t.spatial.khataPlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input type="number" step="0.01" value={form.recordedArea} onChange={(e) => setForm({ ...form, recordedArea: e.target.value })} placeholder={t.spatial.recordedAreaPlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                    <select value={form.landType} onChange={(e) => setForm({ ...form, landType: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2 text-xs">
                      <option value="Agricultural">{t.spatial.landTypeAgri}</option>
                      <option value="Chahi">{t.spatial.landTypeChahi}</option>
                      <option value="Barani">{t.spatial.landTypeBarani}</option>
                      <option value="Gair Mumkin">{t.spatial.landTypeGairMumkin}</option>
                    </select>
                  </div>
                  <textarea value={form.inheritance} onChange={(e) => setForm({ ...form, inheritance: e.target.value })} placeholder={t.spatial.inheritancePlaceholder} rows={2} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs resize-none" />
                  <textarea value={form.mutation} onChange={(e) => setForm({ ...form, mutation: e.target.value })} placeholder={t.spatial.mutationPlaceholder} rows={2} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs resize-none" />

                  <label className="block border border-dashed border-slate-300 rounded-lg p-3 cursor-pointer hover:bg-slate-50">
                    <div className="flex items-center gap-2"><UploadCloud className="w-4 h-4 text-slate-500" /><div><div className="text-xs font-semibold">{t.spatial.uploadDocLabel}</div><div className="text-[10px] text-slate-500">{newDocument ? newDocument.name : t.spatial.uploadDocHelp}</div></div></div>
                    <input type="file" accept=".pdf,image/*" className="hidden" onChange={(e) => setNewDocument(e.target.files?.[0] || null)} />
                  </label>

                  <select value={form.documentId} onChange={(e) => setForm({ ...form, documentId: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs">
                    <option value="">{t.spatial.attachExistingDocOption}</option>
                    {documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.fileName} • {doc.documentCode}</option>)}
                  </select>

                  <button onClick={save} className="w-full bg-blue-700 hover:bg-blue-800 text-white rounded-lg py-2.5 text-xs font-bold cursor-pointer">{editingBoundaryId ? t.spatial.saveBoundaryRecalcBtn : t.spatial.saveParcelRecordBtn}</button>
                  {!editingBoundaryId && <div className="text-[10px] text-slate-400">{t.spatial.noOcrNotice}</div>}
                </div>
              </div>
            ) : activeParcel ? (
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-4 max-h-[720px] overflow-y-auto">
                {editing ? (
                  <>
                    <div className="flex justify-between items-center"><div><div className="text-[10px] font-mono text-blue-700 font-bold">{activeParcel.id}</div><div className="text-sm font-bold mt-0.5">{t.spatial.editRecordBtn}</div></div><button onClick={() => setEditing(false)} className="text-slate-400 cursor-pointer"><X className="w-4 h-4" /></button></div>
                    <div className="space-y-2 mt-4">
                      <div className="grid grid-cols-3 gap-2">
                        <input value={editForm.district} readOnly title={t.spatial.districtLockedHint} className="border border-slate-200 rounded-lg px-3 py-2 text-xs bg-slate-50 text-slate-500 cursor-not-allowed" />
                        <input value={editForm.tehsil} onChange={(e) => setEditForm({ ...editForm, tehsil: e.target.value })} placeholder={t.spatial.tehsilPlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                        <input value={editForm.village} onChange={(e) => setEditForm({ ...editForm, village: e.target.value })} placeholder={t.spatial.villagePlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                      </div>
                      <input value={editForm.ownersText} onChange={(e) => setEditForm({ ...editForm, ownersText: e.target.value })} placeholder={t.spatial.ownersInputPlaceholder} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                      <div className="text-[10px] text-slate-400">{t.spatial.ownersInputHelp}</div>
                      <div className="grid grid-cols-2 gap-2"><input value={editForm.khasraNo} onChange={(e) => setEditForm({ ...editForm, khasraNo: e.target.value })} placeholder={t.spatial.khasraPlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" /><input value={editForm.khataNo} onChange={(e) => setEditForm({ ...editForm, khataNo: e.target.value })} placeholder={t.spatial.khataPlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" /></div>
                      <div className="grid grid-cols-2 gap-2">
                        <input type="number" step="0.01" value={editForm.recordedArea} onChange={(e) => setEditForm({ ...editForm, recordedArea: e.target.value })} placeholder={t.spatial.recordedAreaPlaceholder} className="border border-slate-200 rounded-lg px-3 py-2 text-xs" />
                        <select value={editForm.landType} onChange={(e) => setEditForm({ ...editForm, landType: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2 text-xs">
                          <option value="Agricultural">{t.spatial.landTypeAgri}</option>
                          <option value="Chahi">{t.spatial.landTypeChahi}</option>
                          <option value="Barani">{t.spatial.landTypeBarani}</option>
                          <option value="Gair Mumkin">{t.spatial.landTypeGairMumkin}</option>
                        </select>
                      </div>
                      <textarea value={editForm.inheritance} onChange={(e) => setEditForm({ ...editForm, inheritance: e.target.value })} placeholder={t.spatial.inheritancePlaceholder} rows={2} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs resize-none" />
                      <textarea value={editForm.mutation} onChange={(e) => setEditForm({ ...editForm, mutation: e.target.value })} placeholder={t.spatial.mutationPlaceholder} rows={2} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs resize-none" />
                      <label className="block border border-dashed border-slate-300 rounded-lg p-3 cursor-pointer hover:bg-slate-50">
                        <div className="flex items-center gap-2"><UploadCloud className="w-4 h-4 text-slate-500" /><div><div className="text-xs font-semibold">{t.spatial.uploadDocLabel}</div><div className="text-[10px] text-slate-500">{activeParcel.documentName || t.common.view}</div></div></div>
                        <input type="file" accept=".pdf,image/*" className="hidden" onChange={(e) => handleDirectUpload(e.target.files?.[0] || null, true)} />
                      </label>
                      <select value={editForm.documentId} onChange={(e) => setEditForm({ ...editForm, documentId: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs"><option value="">{t.spatial.attachExistingDocOption}</option>{documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.fileName} • {doc.documentCode}</option>)}</select>
                      <button onClick={saveEdit} className="w-full bg-slate-900 hover:bg-slate-800 text-white rounded-lg py-2.5 text-xs font-bold cursor-pointer">{t.common.save}</button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Top Identity & Action Header */}
                    <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider font-mono text-blue-700 font-bold">{t.spatial.parcelIdLabel}</div>
                        <div className="text-xl font-black font-mono text-slate-900">{activeParcel.id}</div>
                        <div className="text-xs text-slate-500 mt-0.5 font-medium">
                          {activeParcel.village || t.spatial.villageNotRecorded} • {activeParcel.tehsil || 'Tehsil'} • {activeParcel.district || 'District'}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={startEdit} className="p-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 cursor-pointer" title={t.spatial.editRecordBtn}><Pencil className="w-3.5 h-3.5" /></button>
                        <button onClick={() => { if (window.confirm(t.spatial.archiveConfirm(activeParcel.id))) archiveParcel(activeParcel.id); }} className="p-2 border border-amber-200 rounded-lg text-amber-700 hover:bg-amber-50 cursor-pointer" title={t.spatial.archiveTooltip}><Archive className="w-3.5 h-3.5" /></button>
                        <button onClick={() => { setDraft(activeParcel.boundary); setDraftClosed(true); setEditingBoundaryId(activeParcel.id); setEditing(false); setMode('draw'); setTab('map'); }} className="p-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 cursor-pointer" title={t.spatial.editBoundaryBtn}><MapPinned className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>

                    {/* Phase 3B: ULPIN-Ready Cadastral Identity Card */}
                    <div className="bg-gradient-to-br from-slate-900 to-blue-950 text-white rounded-xl p-3.5 shadow-xs border border-blue-900/50 space-y-2.5">
                      <div className="flex items-center justify-between border-b border-white/10 pb-2">
                        <div className="flex items-center gap-1.5">
                          <Globe className="w-4 h-4 text-blue-400" />
                          <span className="text-xs font-bold text-white tracking-wide">{t.spatial.ulpinSectionTitle}</span>
                        </div>
                        <span className="text-[9px] font-mono font-bold uppercase tracking-wider bg-blue-500/20 text-blue-300 border border-blue-400/30 px-2 py-0.5 rounded-full">
                          {t.spatial.ulpinArchBadge}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="bg-white/5 border border-white/10 rounded-lg p-2.5">
                          <span className="text-[10px] text-slate-400 block font-mono uppercase">{t.spatial.ulpinInternalIdLabel}</span>
                          <span className="font-mono font-bold text-white text-xs mt-0.5 block truncate">{activeParcel.id}</span>
                          <span className="text-[9px] text-emerald-400 flex items-center gap-1 mt-1 font-mono">
                            <Check className="w-3 h-3 shrink-0" /> {isHindi ? 'मान्य PostGIS बहुभुज' : 'Valid PostGIS Polygon'} ({activeParcel.boundary?.length || 0} pts)
                          </span>
                        </div>

                        <div className="bg-white/5 border border-white/10 rounded-lg p-2.5">
                          <span className="text-[10px] text-slate-400 block font-mono uppercase">{t.spatial.ulpinGovtIdLabel}</span>
                          <span className="font-mono font-semibold text-amber-300 text-xs mt-0.5 block truncate">
                            {activeParcel.ulpin || t.spatial.ulpinNotLinked}
                          </span>
                          <span className="text-[9px] text-slate-400 block mt-1 font-mono">
                            {t.spatial.ulpinStatusLabel}: <span className="text-amber-300">{activeParcel.ulpinStatus || t.spatial.ulpinNotLinked}</span>
                          </span>
                        </div>
                      </div>

                      <div className="text-[10px] text-slate-300/90 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
                        <Info className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                        <span>{t.spatial.ulpinArchitectureNotice}</span>
                      </div>
                    </div>

                    {/* Compact Lifecycle Timeline Bar */}
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 space-y-1.5">
                      <div className="text-[10px] font-mono font-bold uppercase text-slate-500">{t.spatial.lifecycleTimelineTitle}</div>
                      <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold">
                        <span className={`px-2 py-0.5 rounded border ${activeParcel.status === 'Draft' ? 'bg-blue-100 border-blue-300 text-blue-900' : 'bg-white border-slate-200 text-slate-600'}`}>
                          {t.spatial.lifecycleDraft}
                        </span>
                        <span className="text-slate-400">→</span>
                        <span className={`px-2 py-0.5 rounded border ${activeParcel.status === 'Mapped' ? 'bg-blue-100 border-blue-300 text-blue-900' : 'bg-white border-slate-200 text-slate-600'}`}>
                          {t.spatial.lifecycleMapped}
                        </span>
                        <span className="text-slate-400">→</span>
                        <span className={`px-2 py-0.5 rounded border ${activeParcel.status === 'Needs Field Verification' ? 'bg-amber-100 border-amber-300 text-amber-900' : 'bg-white border-slate-200 text-slate-600'}`}>
                          {t.spatial.lifecycleNeedsField}
                        </span>
                        <span className="text-slate-400">→</span>
                        <span className={`px-2 py-0.5 rounded border ${activeParcel.status === 'Verified' ? 'bg-emerald-100 border-emerald-300 text-emerald-900' : 'bg-white border-slate-200 text-slate-600'}`}>
                          {t.spatial.lifecycleVerified}
                        </span>
                      </div>
                      {activeParcel.status === 'Verified' && activeParcel.verifiedBy && (
                        <div className="text-[10px] text-emerald-700 font-mono">
                          {t.spatial.fieldVerificationOfficerVerified(activeParcel.verifiedBy, activeParcel.verifiedAt || (isHindi ? 'अभिलेखित नहीं' : 'not recorded'))}
                        </div>
                      )}
                    </div>

                    {/* Cadastral Attributes Grid */}
                    <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
                      <div className="text-[10px] font-mono font-bold uppercase text-slate-500">{isHindi ? 'कैडस्ट्राल पहचान प्रविष्टियां' : 'Cadastral Identifiers'}</div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        <div className="bg-slate-50 p-2 rounded border border-slate-200/80">
                          <span className="text-[10px] text-slate-400 block">{t.spatial.khasraLabel}</span>
                          <span className="font-mono font-bold text-slate-900">{activeParcel.khasraNo}</span>
                        </div>
                        <div className="bg-slate-50 p-2 rounded border border-slate-200/80">
                          <span className="text-[10px] text-slate-400 block">{t.spatial.khataLabel}</span>
                          <span className="font-mono font-bold text-slate-900">{activeParcel.khataNo}</span>
                        </div>
                        <div className="bg-slate-50 p-2 rounded border border-slate-200/80">
                          <span className="text-[10px] text-slate-400 block">{t.spatial.khewatLabel}</span>
                          <span className="font-mono font-bold text-slate-900">{activeParcel.khewatNo || activeDoc?.data?.khewatNo?.value || (isHindi ? 'अभिलेखित नहीं' : 'Not recorded')}</span>
                        </div>
                        <div className="bg-slate-50 p-2 rounded border border-slate-200/80">
                          <span className="text-[10px] text-slate-400 block">{t.spatial.landTypeLabel}</span>
                          <span className="font-semibold text-slate-900 truncate block">{activeParcel.landType}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                        <div className="bg-slate-50 p-2 rounded border border-slate-200/80">
                          <span className="text-[10px] text-slate-400 block">{t.spatial.patwarLabel}</span>
                          <span className="font-semibold text-slate-800 text-[11px]">{activeDoc?.data?.patwarCircle?.value || (isHindi ? 'अभिलेखित नहीं' : 'Not recorded')}</span>
                        </div>
                        <div className="bg-slate-50 p-2 rounded border border-slate-200/80">
                          <span className="text-[10px] text-slate-400 block">{t.spatial.villageLabel}</span>
                          <span className="font-semibold text-slate-800 text-[11px]">{activeParcel.village || (isHindi ? 'अभिलेखित नहीं' : 'Not recorded')}</span>
                        </div>
                      </div>
                    </div>

                    {/* Area Comparison & Area Discrepancy Callout */}
                    <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between text-[10px] font-mono font-bold uppercase text-slate-500">
                        <span>{isHindi ? 'रकबा मिलान (क्षेत्रफल विश्लेषण)' : 'Area Reconciliation'}</span>
                        {discrepancy ? (
                          <span className="text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 font-bold">
                            {isHindi ? 'विसंगति' : 'Discrepancy'}
                          </span>
                        ) : (
                          <span className="text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200 font-bold">
                            {isHindi ? 'सटीक' : 'Consistent'}
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="bg-slate-50 p-2.5 rounded border border-slate-200/80">
                          <span className="text-[10px] text-slate-400 block">{t.spatial.mappedAreaLabel}</span>
                          <span className="font-mono font-bold text-slate-900 text-sm">
                            {activeParcel.mappedAreaHectares.toFixed(3)} {isHindi ? 'हे.' : 'ha'}
                          </span>
                        </div>
                        <div className="bg-slate-50 p-2.5 rounded border border-slate-200/80">
                          <span className="text-[10px] text-slate-400 block">{t.spatial.recordedAreaLabel}</span>
                          <span className="font-mono font-bold text-slate-900 text-sm">
                            {activeParcel.recordedAreaHectares != null
                              ? `${activeParcel.recordedAreaHectares.toFixed(3)} ${isHindi ? 'हे.' : 'ha'}`
                              : t.spatial.missingLabel}
                          </span>
                        </div>
                      </div>

                      {/* Prominent Area Mismatch Banner with Direct Action */}
                      {discrepancy && (() => {
                        const diff = Math.abs(activeParcel.mappedAreaHectares - (activeParcel.recordedAreaHectares || 0));
                        const pct = activeParcel.recordedAreaHectares && activeParcel.recordedAreaHectares > 0 ? (diff / activeParcel.recordedAreaHectares) * 100 : 0;
                        return (
                          <div className="p-3 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-950 space-y-2">
                            <div className="flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                              <div>
                                <div className="font-bold text-xs">{t.spatial.areaMismatchBanner}</div>
                                <div className="text-[11px] text-amber-800 mt-0.5">
                                  {t.spatial.areaMismatchDetail(
                                    activeParcel.recordedAreaHectares?.toFixed(3) || '0.000',
                                    activeParcel.mappedAreaHectares.toFixed(3),
                                    diff.toFixed(3),
                                    `${pct.toFixed(1)}%`
                                  )}
                                </div>
                              </div>
                            </div>
                            <button
                              onClick={() => {
                                selectParcel(activeParcel.id);
                                setActiveView('field_verification');
                              }}
                              className="w-full flex items-center justify-center gap-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded-lg py-1.5 text-xs font-bold transition-colors cursor-pointer shadow-2xs"
                            >
                              <Camera className="w-3.5 h-3.5" />
                              <span>{t.spatial.proceedFieldVerif}</span>
                            </button>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Phase 3B: Historical vs Current Reference Imagery Comparison */}
                    <div className="bg-white border border-slate-200 rounded-xl p-3.5 space-y-3 shadow-xs">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                        <div className="flex items-center gap-1.5">
                          <Layers className="w-4 h-4 text-indigo-700" />
                          <span className="text-xs font-bold text-slate-900">{t.spatial.imageryComparisonTitle}</span>
                        </div>
                        <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg text-[10px] font-semibold">
                          <button
                            onClick={() => setImageryView('split')}
                            className={`px-2 py-0.5 rounded transition-all cursor-pointer ${imageryView === 'split' ? 'bg-white shadow-2xs text-slate-900 font-bold' : 'text-slate-600 hover:text-slate-900'}`}
                          >
                            {isHindi ? 'तुलना (स्प्लिट)' : 'Comparison'}
                          </button>
                          <button
                            onClick={() => setImageryView('historical')}
                            className={`px-2 py-0.5 rounded transition-all cursor-pointer ${imageryView === 'historical' ? 'bg-white shadow-2xs text-slate-900 font-bold' : 'text-slate-600 hover:text-slate-900'}`}
                          >
                            {isHindi ? '२०१९' : '2019'}
                          </button>
                          <button
                            onClick={() => setImageryView('current')}
                            className={`px-2 py-0.5 rounded transition-all cursor-pointer ${imageryView === 'current' ? 'bg-white shadow-2xs text-slate-900 font-bold' : 'text-slate-600 hover:text-slate-900'}`}
                          >
                            {isHindi ? '२०२६' : '2026'}
                          </button>
                        </div>
                      </div>

                      {/* Disclaimer */}
                      <div className="text-[10px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-2 leading-relaxed">
                        <span className="font-bold text-slate-700 font-mono">[{isHindi ? 'डेमो संदर्भ छवि' : 'Demo / Reference Imagery'}]:</span> {t.spatial.imageryDisclaimer}
                      </div>

                      {/* Interactive Visual Panels */}
                      <div className={`grid ${imageryView === 'split' ? 'grid-cols-2' : 'grid-cols-1'} gap-2.5`}>
                        {(imageryView === 'split' || imageryView === 'historical') && (
                          <div className="relative rounded-lg overflow-hidden border border-slate-300 bg-gradient-to-br from-amber-900/30 via-emerald-950/40 to-slate-900 aspect-4/3 flex flex-col justify-between p-2.5 shadow-inner">
                            <div className="absolute inset-0 opacity-20 bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:12px_12px]" />
                            <svg className="absolute inset-0 w-full h-full p-3 pointer-events-none opacity-80" viewBox="0 0 100 100" preserveAspectRatio="none">
                              <polygon points="20,25 78,18 85,75 25,82" fill="rgba(37,99,235,0.25)" stroke="#38bdf8" strokeWidth="2.5" strokeDasharray="4 3" />
                            </svg>
                            <div className="relative flex items-center justify-between z-10">
                              <span className="bg-slate-900/90 text-white font-mono text-[9px] font-bold px-1.5 py-0.5 rounded border border-white/20">
                                {t.spatial.historicalRef} ({activeParcel.imageryComparison?.historicalYear || 2019})
                              </span>
                              <span className="text-[9px] font-mono text-slate-300 bg-black/60 px-1 rounded">OSM/Ref-Tile</span>
                            </div>
                            <div className="relative z-10 text-[10px] text-white/90 bg-slate-900/80 p-1.5 rounded backdrop-blur-xs border border-white/10">
                              <span className="text-[9px] text-amber-300 block font-mono font-semibold">{isHindi ? 'आधारभूत कृषि सीमा' : 'Baseline Agricultural Footprint'}</span>
                              <span className="text-[9px] font-mono text-slate-300">{activeParcel.khasraNo} • {activeParcel.mappedAreaHectares.toFixed(2)} ha</span>
                            </div>
                          </div>
                        )}

                        {(imageryView === 'split' || imageryView === 'current') && (
                          <div className="relative rounded-lg overflow-hidden border border-slate-300 bg-gradient-to-br from-emerald-900/40 via-blue-950/50 to-slate-900 aspect-4/3 flex flex-col justify-between p-2.5 shadow-inner">
                            <div className="absolute inset-0 opacity-25 bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:12px_12px]" />
                            <svg className="absolute inset-0 w-full h-full p-3 pointer-events-none opacity-85" viewBox="0 0 100 100" preserveAspectRatio="none">
                              <polygon points="20,25 78,18 85,75 25,82" fill="rgba(16,185,129,0.28)" stroke="#4ade80" strokeWidth="2.5" />
                              {(activeParcel.imageryComparison?.status === 'Review Recommended' || discrepancy) && (
                                <circle cx="75" cy="28" r="7" fill="rgba(245,158,11,0.4)" stroke="#f59e0b" strokeWidth="2" />
                              )}
                            </svg>
                            <div className="relative flex items-center justify-between z-10">
                              <span className="bg-emerald-900/90 text-emerald-100 font-mono text-[9px] font-bold px-1.5 py-0.5 rounded border border-emerald-400/30">
                                {t.spatial.currentRef} ({activeParcel.imageryComparison?.currentYear || 2026})
                              </span>
                              <span className="text-[9px] font-mono text-emerald-300 bg-black/60 px-1 rounded">Esri/OSM-Ref</span>
                            </div>
                            <div className="relative z-10 text-[10px] text-white/90 bg-slate-900/80 p-1.5 rounded backdrop-blur-xs border border-white/10">
                              <span className="text-[9px] text-emerald-300 block font-mono font-semibold">{isHindi ? 'वर्तमान भौतिक स्वरूप' : 'Current Physical Appearance'}</span>
                              <span className="text-[9px] font-mono text-slate-300">{activeParcel.khasraNo} • {activeParcel.mappedAreaHectares.toFixed(2)} ha</span>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Comparison Observation Status */}
                      <div className={`p-2.5 rounded-lg border text-xs space-y-1 ${
                        (activeParcel.imageryComparison?.status === 'Review Recommended' || discrepancy)
                          ? 'bg-amber-50 border-amber-200 text-amber-950'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-950'
                      }`}>
                        <div className="flex items-center justify-between font-mono font-bold text-[10px]">
                          <span className="uppercase text-slate-500">{t.spatial.imageryStatusLabel}:</span>
                          <span className={`px-1.5 py-0.5 rounded border ${
                            (activeParcel.imageryComparison?.status === 'Review Recommended' || discrepancy)
                              ? 'bg-amber-100 border-amber-300 text-amber-900'
                              : 'bg-emerald-100 border-emerald-300 text-emerald-900'
                          }`}>
                            {activeParcel.imageryComparison?.status === 'Review Recommended' || discrepancy
                              ? t.spatial.reviewRecommended
                              : t.spatial.normalStatus}
                          </span>
                        </div>
                        <div className="text-[11px] leading-relaxed pt-0.5">
                          <span className="font-semibold text-slate-700">{t.spatial.observedChangeLabel}: </span>
                          <span>
                              {activeParcel.imageryComparison?.observedChange || (discrepancy
                              ? (isHindi ? `रकबा में ${Math.abs(activeParcel.mappedAreaHectares - (activeParcel.recordedAreaHectares ?? 0)).toFixed(2)} हे. का अंतर अवलोकित; मौका सत्यापन अनुशंसित।` : `Area delta of ${Math.abs(activeParcel.mappedAreaHectares - (activeParcel.recordedAreaHectares ?? 0)).toFixed(2)} ha observed; field verification recommended.`)
                              : (isHindi ? 'कोई नवीनतम उपग्रह तुलना दर्ज नहीं; सीमाएँ अस्थायी। ' : 'No recent satellite comparison recorded; boundary remains provisional.'))}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Ownership & Co-Sharers with 100% Validation check */}
                    <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2.5">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                          <Users className="w-4 h-4 text-emerald-700" />
                          <span>{t.spatial.ownershipAndShares}</span>
                        </div>
                        {(() => {
                          const total = ownerTotal(activeParcel);
                          const isValid = Math.abs(total - 100) < 0.01;
                          return (
                            <span
                              className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold border ${
                                isValid
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : 'bg-rose-50 text-rose-800 border border-rose-200'
                              }`}
                            >
                              {isValid ? t.spatial.ownershipValidStatus : t.spatial.ownershipMismatchStatus(total.toFixed(1))}
                            </span>
                          );
                        })()}
                      </div>

                      <div className="space-y-1.5 text-xs">
                        {activeParcel.owners?.length ? (
                          activeParcel.owners.map((o, idx) => (
                            <div key={o.id || idx} className="p-2 rounded bg-slate-50 border border-slate-200/80 flex items-center justify-between gap-2">
                              <div>
                                <div className="font-bold text-slate-900">{idx + 1}. {o.name}</div>
                                <div className="text-[10px] text-slate-500 font-serif">
                                  {o.relationType} {o.relativeName}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="font-mono font-bold text-emerald-800 text-xs">
                                  {o.shareFraction} ({o.sharePercentage.toFixed(1)}%)
                                </div>
                                <div className="text-[10px] text-slate-500 font-mono">
                                  {ownerMappedArea(activeParcel, o.sharePercentage).toFixed(3)} {isHindi ? 'हे.' : 'ha'}
                                </div>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="text-slate-500 text-xs">{t.spatial.noCoSharerData}</div>
                        )}
                      </div>
                    </div>

                    {/* Phase 3B: Record Integrity Audit Checklist */}
                    <div className="bg-white border border-slate-200 rounded-xl p-3.5 space-y-3 shadow-xs">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                        <div className="flex items-center gap-1.5">
                          <ShieldCheck className="w-4 h-4 text-emerald-700" />
                          <span className="text-xs font-bold text-slate-900">{t.spatial.recordIntegrityTitle}</span>
                        </div>
                        {(() => {
                          const checks = [
                            activeParcel.boundary?.length >= 3,
                            activeParcel.mappedAreaHectares > 0,
                            hasDocument(activeParcel),
                            activeParcel.khasraNo !== '—' && Boolean(activeParcel.village),
                            Math.abs(ownerTotal(activeParcel) - 100) < 0.01,
                            !discrepancy,
                            activeParcel.status === 'Verified' || Boolean(activeParcel.inspectionHistory?.length),
                            activeParcel.status === 'Verified' || Boolean(activeParcel.verifiedBy),
                            Boolean(activeParcel.createdAt),
                          ];
                          const passed = checks.filter(Boolean).length;
                          const pct = Math.round((passed / checks.length) * 100);
                          return (
                            <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                              passed === checks.length ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-blue-50 text-blue-800 border-blue-200'
                            }`}>
                              {passed}/{checks.length} ({pct}%)
                            </span>
                          );
                        })()}
                      </div>

                      <div className="space-y-1.5 text-xs">
                        {[
                          { label: t.spatial.integrityGeometry, pass: activeParcel.boundary?.length >= 3 },
                          { label: t.spatial.integritySpatialArea, pass: activeParcel.mappedAreaHectares > 0 },
                          { label: t.spatial.integrityDocLinked, pass: hasDocument(activeParcel) },
                          { label: t.spatial.integrityRequiredFields, pass: activeParcel.khasraNo !== '—' && Boolean(activeParcel.village) },
                          { label: t.spatial.integrityOwnershipShares, pass: Math.abs(ownerTotal(activeParcel) - 100) < 0.01 },
                          { label: t.spatial.integrityAreaConsistent, pass: !discrepancy },
                          { label: t.spatial.integrityFieldVerif, pass: activeParcel.status === 'Verified' || Boolean(activeParcel.inspectionHistory?.length) },
                          { label: t.spatial.integrityOfficerSeal, pass: activeParcel.status === 'Verified' || Boolean(activeParcel.verifiedBy) },
                          { label: t.spatial.integrityAuditTrail, pass: Boolean(activeParcel.createdAt) },
                        ].map((item, idx) => (
                          <div key={idx} className="flex items-center justify-between p-2 rounded bg-slate-50 border border-slate-200/70 text-[11px]">
                            <div className="flex items-center gap-2 pr-2">
                              {item.pass ? (
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                              ) : (
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                              )}
                              <span className={item.pass ? 'text-slate-800 font-medium' : 'text-slate-600'}>{item.label}</span>
                            </div>
                            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded font-bold shrink-0 border ${
                              item.pass ? 'bg-emerald-100/80 text-emerald-800 border-emerald-200' : 'bg-amber-100/80 text-amber-900 border-amber-200'
                            }`}>
                              {item.pass ? t.spatial.integrityPass : t.spatial.integrityWarning}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Linked Document Evidence */}
                    <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                          <FileText className="w-4 h-4 text-blue-700" />
                          <span>{t.spatial.originalDocumentTitle}</span>
                        </div>
                        {hasDocument(activeParcel) ? (
                          <span className="text-[10px] font-mono text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 font-semibold">
                            {activeDoc ? t.spatial.canonicalLinked : t.spatial.prototypeLocalStorage}
                          </span>
                        ) : (
                          <span className="text-[10px] font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                            {t.spatial.notAttached}
                          </span>
                        )}
                      </div>

                      <div className="text-xs space-y-1 bg-slate-50 p-2.5 rounded border border-slate-200/80">
                        <div className="font-mono font-bold text-slate-900 truncate">
                          {activeParcel.documentName || activeDoc?.fileName || (isHindi ? 'कोई दस्तावेज़ संलग्न नहीं' : 'No document attached')}
                        </div>
                        {(activeParcel.documentType || activeDoc?.recordType) && (
                          <div className="text-[11px] text-slate-600">
                            {t.spatial.docTypeLabel(activeParcel.documentType || activeDoc?.recordType || '')}
                          </div>
                        )}
                        {(activeParcel.documentUploadedAt || activeDoc?.uploadedAt) && (
                          <div className="text-[10px] text-slate-500">
                            {t.spatial.docUploadedLabel(activeParcel.documentUploadedAt || activeDoc?.uploadedAt || '')}
                          </div>
                        )}
                        {activeParcel.documentUri && (
                          <div className="flex gap-3 pt-1">
                            <button onClick={() => window.open(activeParcel.documentUri, '_blank')} className="text-blue-700 font-semibold cursor-pointer text-xs">{t.spatial.previewBtn}</button>
                            <a href={activeParcel.documentUri} download={activeParcel.documentName || 'land-document'} className="text-blue-700 font-semibold text-xs">{t.spatial.downloadBtn}</a>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Append-Only Audit & Lifecycle Events */}
                    <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                          <GitBranch className="w-4 h-4 text-purple-700" />
                          <span>{t.spatial.auditTimelineTitle}</span>
                        </div>
                        <span className="text-[9px] font-mono text-purple-800 bg-purple-50 px-1.5 py-0.5 rounded border border-purple-200 font-bold">
                          {isHindi ? 'अपरिवर्तनीय लॉग' : 'Append-Only'}
                        </span>
                      </div>
                      <div className="space-y-1.5 text-xs">
                        {/* Event 1: Registration */}
                        <div className="p-2 rounded bg-slate-50 border border-slate-200/80 flex items-start gap-2">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-semibold text-slate-800">{isHindi ? 'स्थानिक पार्सल सृजन' : 'Spatial Parcel Created'}</span>
                            <span className="text-[10px] text-slate-500 block font-mono">
                              {activeParcel.createdAt ? new Date(activeParcel.createdAt).toLocaleDateString() : (isHindi ? 'दिनांक अभिलेखित नहीं' : 'date not recorded')} • {activeParcel.id} ({activeParcel.mappedAreaHectares.toFixed(2)} ha)
                            </span>
                          </div>
                        </div>

                        {/* Event 2: Document Linkage */}
                        {hasDocument(activeParcel) && (
                          <div className="p-2 rounded bg-slate-50 border border-slate-200/80 flex items-start gap-2">
                            <FileText className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />
                            <div>
                              <span className="font-semibold text-slate-800">{isHindi ? 'भू-अभिलेख दस्तावेज़ संलग्न' : 'Land Record Document Linked'}</span>
                              <span className="text-[10px] text-slate-500 block font-mono">
                                {activeParcel.documentName || activeDoc?.fileName}
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Event 3: Field Inspection (if any) */}
                        {activeParcel.inspectionHistory && activeParcel.inspectionHistory.length > 0 ? (
                          activeParcel.inspectionHistory.map((insp) => (
                            <div key={insp.id} className="p-2 rounded bg-amber-50/60 border border-amber-200/80 flex items-start gap-2">
                              <Camera className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
                              <div>
                                <span className="font-semibold text-slate-900">{isHindi ? 'मौका निरीक्षण संपन्न' : 'Field Inspection Recorded'}</span>
                                <span className="text-[10px] text-slate-600 block font-mono">
                                  {new Date(insp.inspectedAt).toLocaleDateString()} • {insp.inspectedBy} ({insp.inspectorRole})
                                </span>
                              </div>
                            </div>
                          ))
                        ) : activeParcel.status === 'Needs Field Verification' ? (
                          <div className="p-2 rounded bg-amber-50/40 border border-amber-200/70 flex items-start gap-2">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                            <div>
                              <span className="font-semibold text-slate-800">{isHindi ? 'क्षेत्रीय सत्यापन प्रतीक्षित' : 'Field Verification Pending'}</span>
                              <span className="text-[10px] text-amber-800 block font-mono">
                                {discrepancy
                                  ? (isHindi ? `रकबा विसंगति (${Math.abs(activeParcel.mappedAreaHectares - (activeParcel.recordedAreaHectares ?? 0)).toFixed(2)} हे.) के कारण भौतिक जांच प्रतीक्षित` : `Area difference (${Math.abs(activeParcel.mappedAreaHectares - (activeParcel.recordedAreaHectares ?? 0)).toFixed(2)} ha) triggers field inspection requirement`)
                                  : (isHindi ? 'भौतिक जांच निर्देशित; कोई दर्ज रकबा विसंगति नहीं।' : 'Field inspection ordered; no recorded area discrepancy.')}
                              </span>
                            </div>
                          </div>
                        ) : null}

                        {/* Event 4: Officer Seal (if verified) */}
                        {activeParcel.status === 'Verified' && activeParcel.verifiedBy && (
                          <div className="p-2 rounded bg-emerald-50/80 border border-emerald-300 flex items-start gap-2">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-700 shrink-0 mt-0.5" />
                            <div>
                              <span className="font-semibold text-emerald-950">{isHindi ? 'राजस्व अधिकारी द्वारा सत्यापित' : 'Officer Verified & Digitally Sealed'}</span>
                              <span className="text-[10px] text-emerald-800 block font-mono">
                                {activeParcel.verifiedAt || (isHindi ? 'सील दिनांक अभिलेखित नहीं' : 'seal date not recorded')} • {activeParcel.verifiedBy}
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Event 5: Mutation History */}
                        {(activeParcel.mutationHistory?.length ?? 0) > 0 && activeParcel.mutationHistory.map((m, i) => (
                          <div key={i} className="p-2 rounded bg-slate-50 border border-slate-200/80 flex items-start gap-2">
                            <Ruler className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />
                            <div>
                              <span className="font-semibold text-slate-800">{m.type}</span>
                              <span className="text-[10px] text-slate-500 block font-mono">{m.date} — {m.note}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Primary Contextual Action Buttons */}
                    <div className="space-y-2 pt-2 border-t border-slate-100">
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => {
                            if (activeDoc) selectDocument(activeDoc.id);
                            setActiveView('verified_record');
                          }}
                          className="flex items-center justify-center gap-1.5 border border-slate-300 hover:bg-slate-50 text-slate-800 rounded-lg py-2 text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5 text-slate-600" />
                          <span>{t.spatial.viewOfficialRecordBtn}</span>
                        </button>

                        <button
                          onClick={() => {
                            if (activeDoc) selectDocument(activeDoc.id);
                            setActiveView('extraction_results');
                          }}
                          className="flex items-center justify-center gap-1.5 border border-slate-300 hover:bg-slate-50 text-slate-800 rounded-lg py-2 text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                          <span>{t.spatial.viewDocOcrBtn}</span>
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => {
                            if (activeDoc) selectDocument(activeDoc.id);
                            setActiveView('record_validation');
                          }}
                          className="flex items-center justify-center gap-1.5 border border-amber-300 bg-amber-50/70 hover:bg-amber-100 text-amber-950 rounded-lg py-2 text-xs font-bold shadow-2xs transition-colors cursor-pointer"
                        >
                          <ShieldCheck className="w-3.5 h-3.5 text-amber-700" />
                          <span>{t.spatial.validateRecordBtn}</span>
                        </button>

                        <button
                          onClick={() => {
                            selectParcel(activeParcel.id);
                            setActiveView('field_verification');
                          }}
                          className="flex items-center justify-center gap-1.5 border border-blue-300 bg-blue-50/70 hover:bg-blue-100 text-blue-950 rounded-lg py-2 text-xs font-bold shadow-2xs transition-colors cursor-pointer"
                        >
                          <Camera className="w-3.5 h-3.5 text-blue-700" />
                          <span>{t.spatial.fieldVerifActionBtn}</span>
                        </button>
                      </div>

                      <button
                        onClick={() => {
                          if (activeDoc) selectDocument(activeDoc.id);
                          setActiveView('human_verification');
                        }}
                        className="w-full flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg py-2.5 text-xs font-bold shadow-xs transition-all cursor-pointer"
                      >
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span>{t.spatial.verifySealActionBtn}</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl p-5 text-sm text-slate-500">{t.spatial.selectParcelOnMap}</div>
            )}

            <div className="bg-slate-900 text-white rounded-xl p-4">
              <div className="text-[10px] uppercase font-mono text-slate-400">{t.spatial.systemPrincipleTitle}</div>
              <div className="text-sm font-semibold mt-1">{t.spatial.systemPrincipleSubtitle}</div>
              <div className="text-[11px] text-slate-400 mt-2">{t.spatial.systemPrincipleDesc}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


